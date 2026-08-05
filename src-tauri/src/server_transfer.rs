use std::fs;
use std::path::Path;

const MAX_IMPORT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_EXPORT_BYTES: usize = 10 * 1024 * 1024;

#[tauri::command]
pub(crate) fn read_server_import_file(path: String) -> Result<String, String> {
    let path = Path::new(path.trim());
    if path.as_os_str().is_empty() {
        return Err("未选择导入文件".to_string());
    }
    let metadata = fs::metadata(path).map_err(|error| format!("读取导入文件信息失败: {error}"))?;
    if !metadata.is_file() {
        return Err("导入路径不是文件".to_string());
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err("导入文件不能超过 10 MB".to_string());
    }
    fs::read_to_string(path).map_err(|error| format!("读取导入文件失败: {error}"))
}

#[tauri::command]
pub(crate) fn write_server_export_file(path: String, content: String) -> Result<(), String> {
    let path = Path::new(path.trim());
    if path.as_os_str().is_empty() {
        return Err("未选择导出位置".to_string());
    }
    if content.len() > MAX_EXPORT_BYTES {
        return Err("导出内容不能超过 10 MB".to_string());
    }
    fs::write(path, content).map_err(|error| format!("写入导出文件失败: {error}"))
}
