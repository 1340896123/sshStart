use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFileIconRequest {
    key: String,
    file_name: String,
    is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFileIcon {
    key: String,
    data_url: String,
}

#[tauri::command]
pub fn get_system_file_icons(requests: Vec<SystemFileIconRequest>) -> Vec<SystemFileIcon> {
    requests
        .into_iter()
        .filter_map(|request| {
            platform::icon_data_url(&request.file_name, request.is_dir).map(|data_url| {
                SystemFileIcon {
                    key: request.key,
                    data_url,
                }
            })
        })
        .collect()
}

#[cfg(not(target_os = "windows"))]
mod platform {
    pub(super) fn icon_data_url(_file_name: &str, _is_dir: bool) -> Option<String> {
        None
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::{ffi::c_void, mem::size_of, ptr::null_mut, slice};
    use windows_sys::Win32::{
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
            BI_RGB, DIB_RGB_COLORS,
        },
        Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL},
        UI::{
            Shell::{
                SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES,
            },
            WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON},
        },
    };

    const ICON_SIZE: usize = 32;
    const PIXEL_STRIDE: usize = ICON_SIZE * 4;
    const PIXEL_BYTES: usize = ICON_SIZE * PIXEL_STRIDE;

    pub(super) fn icon_data_url(file_name: &str, is_dir: bool) -> Option<String> {
        let icon = shell_icon(file_name, is_dir).ok()?;
        let pixels = unsafe { icon_pixels(icon.0).ok()? };
        let ico = encode_ico(&pixels);
        Some(format!("data:image/x-icon;base64,{}", STANDARD.encode(ico)))
    }

    struct IconHandle(HICON);

    impl Drop for IconHandle {
        fn drop(&mut self) {
            unsafe {
                DestroyIcon(self.0);
            }
        }
    }

    fn shell_icon(file_name: &str, is_dir: bool) -> Result<IconHandle, String> {
        let query_name = if is_dir { "folder" } else { file_name };
        let wide = query_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let attributes = if is_dir {
            FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_ATTRIBUTE_NORMAL
        };
        let mut info = unsafe { std::mem::zeroed::<SHFILEINFOW>() };
        let result = unsafe {
            SHGetFileInfoW(
                wide.as_ptr(),
                attributes,
                &mut info,
                size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
            )
        };
        if result == 0 || info.hIcon.is_null() {
            return Err("Windows Shell did not return an icon".to_string());
        }
        Ok(IconHandle(info.hIcon))
    }

    unsafe fn icon_pixels(icon: HICON) -> Result<Vec<u8>, String> {
        let black = render_icon(icon, 0)?;
        let white = render_icon(icon, 255)?;
        let mut pixels = vec![0u8; PIXEL_BYTES];

        for index in 0..(ICON_SIZE * ICON_SIZE) {
            let offset = index * 4;
            let background_share = (0..3)
                .map(|channel| {
                    white[offset + channel].saturating_sub(black[offset + channel]) as u16
                })
                .sum::<u16>()
                / 3;
            let alpha = 255u16.saturating_sub(background_share);
            if alpha <= 1 {
                continue;
            }
            for channel in 0..3 {
                pixels[offset + channel] =
                    ((black[offset + channel] as u16 * 255 + alpha / 2) / alpha).min(255) as u8;
            }
            pixels[offset + 3] = alpha as u8;
        }

        Ok(pixels)
    }

    unsafe fn render_icon(icon: HICON, background: u8) -> Result<Vec<u8>, String> {
        let mut bitmap_info = std::mem::zeroed::<BITMAPINFO>();
        bitmap_info.bmiHeader.biSize =
            size_of::<windows_sys::Win32::Graphics::Gdi::BITMAPINFOHEADER>() as u32;
        bitmap_info.bmiHeader.biWidth = ICON_SIZE as i32;
        bitmap_info.bmiHeader.biHeight = -(ICON_SIZE as i32);
        bitmap_info.bmiHeader.biPlanes = 1;
        bitmap_info.bmiHeader.biBitCount = 32;
        bitmap_info.bmiHeader.biCompression = BI_RGB;
        bitmap_info.bmiHeader.biSizeImage = PIXEL_BYTES as u32;

        let mut bits: *mut c_void = null_mut();
        let bitmap = CreateDIBSection(
            null_mut(),
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut bits,
            null_mut(),
            0,
        );
        if bitmap.is_null() || bits.is_null() {
            return Err("CreateDIBSection failed".to_string());
        }

        let dc = CreateCompatibleDC(null_mut());
        if dc.is_null() {
            DeleteObject(bitmap);
            return Err("CreateCompatibleDC failed".to_string());
        }

        let previous = SelectObject(dc, bitmap);
        if previous.is_null() {
            DeleteDC(dc);
            DeleteObject(bitmap);
            return Err("SelectObject failed".to_string());
        }

        let buffer = slice::from_raw_parts_mut(bits.cast::<u8>(), PIXEL_BYTES);
        for pixel in buffer.chunks_exact_mut(4) {
            pixel.copy_from_slice(&[background, background, background, 255]);
        }
        let drawn = DrawIconEx(
            dc,
            0,
            0,
            icon,
            ICON_SIZE as i32,
            ICON_SIZE as i32,
            0,
            null_mut(),
            DI_NORMAL,
        );
        let output = (drawn != 0).then(|| buffer.to_vec());

        SelectObject(dc, previous);
        DeleteDC(dc);
        DeleteObject(bitmap);

        output.ok_or_else(|| "DrawIconEx failed".to_string())
    }

    fn encode_ico(pixels: &[u8]) -> Vec<u8> {
        let mask_stride = ((ICON_SIZE + 31) / 32) * 4;
        let mut mask = vec![0u8; mask_stride * ICON_SIZE];
        for output_row in 0..ICON_SIZE {
            let source_row = ICON_SIZE - 1 - output_row;
            for x in 0..ICON_SIZE {
                if pixels[(source_row * ICON_SIZE + x) * 4 + 3] == 0 {
                    mask[output_row * mask_stride + x / 8] |= 0x80 >> (x % 8);
                }
            }
        }

        let image_size = 40 + PIXEL_BYTES + mask.len();
        let mut ico = Vec::with_capacity(22 + image_size);
        push_u16(&mut ico, 0);
        push_u16(&mut ico, 1);
        push_u16(&mut ico, 1);
        ico.extend_from_slice(&[ICON_SIZE as u8, ICON_SIZE as u8, 0, 0]);
        push_u16(&mut ico, 1);
        push_u16(&mut ico, 32);
        push_u32(&mut ico, image_size as u32);
        push_u32(&mut ico, 22);

        push_u32(&mut ico, 40);
        push_i32(&mut ico, ICON_SIZE as i32);
        push_i32(&mut ico, (ICON_SIZE * 2) as i32);
        push_u16(&mut ico, 1);
        push_u16(&mut ico, 32);
        push_u32(&mut ico, BI_RGB);
        push_u32(&mut ico, PIXEL_BYTES as u32);
        ico.extend_from_slice(&[0; 16]);
        for row in (0..ICON_SIZE).rev() {
            ico.extend_from_slice(&pixels[row * PIXEL_STRIDE..(row + 1) * PIXEL_STRIDE]);
        }
        ico.extend_from_slice(&mask);
        ico
    }

    fn push_u16(output: &mut Vec<u8>, value: u16) {
        output.extend_from_slice(&value.to_le_bytes());
    }

    fn push_u32(output: &mut Vec<u8>, value: u32) {
        output.extend_from_slice(&value.to_le_bytes());
    }

    fn push_i32(output: &mut Vec<u8>, value: i32) {
        output.extend_from_slice(&value.to_le_bytes());
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[test]
    fn returns_a_windows_shell_icon_as_a_valid_ico_data_url() {
        let data_url = super::platform::icon_data_url("probe.txt", false)
            .expect("Windows Shell should resolve the registered .txt icon");
        let encoded = data_url
            .strip_prefix("data:image/x-icon;base64,")
            .expect("unexpected icon data URL MIME type");
        let bytes = STANDARD.decode(encoded).expect("icon should be base64");

        assert_eq!(&bytes[0..6], &[0, 0, 1, 0, 1, 0]);
        assert_eq!(&bytes[6..8], &[32, 32]);
        assert_eq!(u32::from_le_bytes(bytes[22..26].try_into().unwrap()), 40);
        assert_eq!(i32::from_le_bytes(bytes[30..34].try_into().unwrap()), 64);
    }
}
