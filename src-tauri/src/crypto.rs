use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use ring::{
    aead, pbkdf2,
    rand::{SecureRandom, SystemRandom},
};
use serde_json::Value;
use std::{env, fs, num::NonZeroU32, path::PathBuf};

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const SALT_BYTES: usize = 16;
const PASSPHRASE_ITERATIONS: u32 = 600_000;
const PASSPHRASE_MIN_ITERATIONS: u32 = 100_000;
const PASSPHRASE_MAX_ITERATIONS: u32 = 2_000_000;
const KEY_BACKUP_AAD: &[u8] = b"portico-key-backup-v1";
const KEY_FILE: &str = "sync.key";
const CLOUD_KEY_FILE: &str = "cloud.key";

pub fn portico_directory() -> Result<PathBuf, String> {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .ok_or_else(|| "无法定位用户主目录，不能初始化同步密钥".to_string())?;
    Ok(PathBuf::from(home).join(".porticossh"))
}

fn key_path() -> Result<PathBuf, String> {
    Ok(portico_directory()?.join(KEY_FILE))
}

fn cloud_key_path() -> Result<PathBuf, String> {
    Ok(portico_directory()?.join(CLOUD_KEY_FILE))
}

fn decode_key_file(path: &std::path::Path, label: &str) -> Result<Option<[u8; KEY_BYTES]>, String> {
    let encoded = match fs::read_to_string(path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取{label}失败: {error}")),
    };
    let decoded = BASE64_STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("读取{label}失败: {error}"))?;
    if decoded.len() != KEY_BYTES {
        return Err(format!("{label}长度无效"));
    }
    let mut key = [0_u8; KEY_BYTES];
    key.copy_from_slice(&decoded);
    Ok(Some(key))
}

fn write_key_file(
    path: &std::path::Path,
    key: &[u8; KEY_BYTES],
    label: &str,
) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| format!("{label}目录无效"))?;
    fs::create_dir_all(parent).map_err(|error| format!("创建{label}目录失败: {error}"))?;
    fs::write(path, BASE64_STANDARD.encode(key))
        .map_err(|error| format!("保存{label}失败: {error}"))
}

fn load_key() -> Result<[u8; KEY_BYTES], String> {
    let path = key_path()?;
    if let Some(key) = decode_key_file(&path, "本地存储密钥")? {
        return Ok(key);
    }
    let mut key = [0_u8; KEY_BYTES];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "生成同步密钥失败".to_string())?;
    write_key_file(&path, &key, "本地存储密钥")?;
    Ok(key)
}

fn load_cloud_key() -> Result<[u8; KEY_BYTES], String> {
    let path = cloud_key_path()?;
    if let Some(key) = decode_key_file(&path, "云端同步密钥")? {
        return Ok(key);
    }
    let key = load_key()?;
    write_key_file(&path, &key, "云端同步密钥")?;
    Ok(key)
}

pub fn ensure_key() -> Result<(), String> {
    load_key().map(|_| ())
}

pub fn ensure_cloud_key() -> Result<(), String> {
    load_cloud_key().map(|_| ())
}

pub fn cloud_key_file_path() -> Result<String, String> {
    Ok(cloud_key_path()?.to_string_lossy().to_string())
}

fn encrypt_json_with_key(value: &Value, key: [u8; KEY_BYTES]) -> Result<String, String> {
    let plaintext =
        serde_json::to_vec(value).map_err(|error| format!("序列化加密数据失败: {error}"))?;
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| "初始化加密密钥失败".to_string())?;
    let sealing_key = aead::LessSafeKey::new(unbound);
    let mut nonce_bytes = [0_u8; NONCE_BYTES];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| "生成加密随机数失败".to_string())?;
    let nonce = aead::Nonce::assume_unique_for_key(nonce_bytes);
    let mut ciphertext = plaintext;
    sealing_key
        .seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut ciphertext)
        .map_err(|_| "加密数据失败".to_string())?;
    Ok(serde_json::json!({
        "version": 1,
        "algorithm": "AES-256-GCM",
        "nonce": BASE64_STANDARD.encode(nonce_bytes),
        "ciphertext": BASE64_STANDARD.encode(ciphertext),
    })
    .to_string())
}

pub fn encrypt_json(value: &Value) -> Result<String, String> {
    encrypt_json_with_key(value, load_key()?)
}

pub fn encrypt_cloud_json(value: &Value) -> Result<String, String> {
    encrypt_json_with_key(value, load_cloud_key()?)
}

fn decrypt_json_with_key(
    raw: &str,
    key: [u8; KEY_BYTES],
    error_message: &str,
) -> Result<Value, String> {
    let envelope: Value =
        serde_json::from_str(raw).map_err(|error| format!("解析加密数据失败: {error}"))?;
    let object = envelope
        .as_object()
        .ok_or_else(|| "加密数据格式无效".to_string())?;
    let nonce_bytes = BASE64_STANDARD
        .decode(
            object
                .get("nonce")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map_err(|error| format!("解析加密随机数失败: {error}"))?;
    if nonce_bytes.len() != NONCE_BYTES {
        return Err("加密随机数长度无效".to_string());
    }
    let ciphertext = BASE64_STANDARD
        .decode(
            object
                .get("ciphertext")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map_err(|error| format!("解析密文失败: {error}"))?;
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| "初始化解密密钥失败".to_string())?;
    let opening_key = aead::LessSafeKey::new(unbound);
    let mut plaintext = ciphertext;
    let mut nonce_array = [0_u8; NONCE_BYTES];
    nonce_array.copy_from_slice(&nonce_bytes);
    let nonce = aead::Nonce::assume_unique_for_key(nonce_array);
    let bytes = opening_key
        .open_in_place(nonce, aead::Aad::empty(), &mut plaintext)
        .map_err(|_| error_message.to_string())?;
    serde_json::from_slice(bytes).map_err(|error| format!("解析解密数据失败: {error}"))
}

pub fn decrypt_json(raw: &str) -> Result<Value, String> {
    decrypt_json_with_key(raw, load_key()?, "解密数据失败，请确认本地存储密钥未被替换")
}

pub fn decrypt_cloud_json(raw: &str) -> Result<Value, String> {
    decrypt_json_with_key(
        raw,
        load_cloud_key()?,
        "无法解密云端数据，请先在云端同步设置中下载并恢复密钥",
    )
}

pub fn encrypt_with_passphrase(plaintext: &[u8], passphrase: &str) -> Result<String, String> {
    if passphrase.is_empty() {
        return Err("加密口令不能为空".to_string());
    }
    let random = SystemRandom::new();
    let mut salt = [0_u8; SALT_BYTES];
    random
        .fill(&mut salt)
        .map_err(|_| "生成口令盐值失败".to_string())?;
    let mut key = [0_u8; KEY_BYTES];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(PASSPHRASE_ITERATIONS).expect("PBKDF2 iterations must be non-zero"),
        &salt,
        passphrase.as_bytes(),
        &mut key,
    );
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| "初始化密钥备份加密失败".to_string())?;
    let sealing_key = aead::LessSafeKey::new(unbound);
    let mut nonce_bytes = [0_u8; NONCE_BYTES];
    random
        .fill(&mut nonce_bytes)
        .map_err(|_| "生成密钥备份随机数失败".to_string())?;
    let nonce = aead::Nonce::assume_unique_for_key(nonce_bytes);
    let mut ciphertext = plaintext.to_vec();
    sealing_key
        .seal_in_place_append_tag(nonce, aead::Aad::from(KEY_BACKUP_AAD), &mut ciphertext)
        .map_err(|_| "加密密钥备份失败".to_string())?;
    key.fill(0);
    Ok(serde_json::json!({
        "version": 1,
        "algorithm": "AES-256-GCM",
        "kdf": "PBKDF2-HMAC-SHA256",
        "iterations": PASSPHRASE_ITERATIONS,
        "salt": BASE64_STANDARD.encode(salt),
        "nonce": BASE64_STANDARD.encode(nonce_bytes),
        "ciphertext": BASE64_STANDARD.encode(ciphertext),
    })
    .to_string())
}

pub fn decrypt_with_passphrase(raw: &str, passphrase: &str) -> Result<Vec<u8>, String> {
    if passphrase.is_empty() {
        return Err("解密口令不能为空".to_string());
    }
    let envelope: Value =
        serde_json::from_str(raw).map_err(|error| format!("解析密钥备份失败: {error}"))?;
    let object = envelope
        .as_object()
        .ok_or_else(|| "密钥备份格式无效".to_string())?;
    if object.get("version").and_then(Value::as_u64) != Some(1)
        || object.get("algorithm").and_then(Value::as_str) != Some("AES-256-GCM")
        || object.get("kdf").and_then(Value::as_str) != Some("PBKDF2-HMAC-SHA256")
    {
        return Err("不支持的密钥备份格式".to_string());
    }
    let iterations = object
        .get("iterations")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| {
            (*value >= PASSPHRASE_MIN_ITERATIONS) && (*value <= PASSPHRASE_MAX_ITERATIONS)
        })
        .ok_or_else(|| "密钥备份的口令派生参数无效".to_string())?;
    let salt = BASE64_STANDARD
        .decode(
            object
                .get("salt")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map_err(|error| format!("解析密钥备份盐值失败: {error}"))?;
    if salt.len() != SALT_BYTES {
        return Err("密钥备份盐值长度无效".to_string());
    }
    let nonce_bytes = BASE64_STANDARD
        .decode(
            object
                .get("nonce")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map_err(|error| format!("解析密钥备份随机数失败: {error}"))?;
    if nonce_bytes.len() != NONCE_BYTES {
        return Err("密钥备份随机数长度无效".to_string());
    }
    let mut ciphertext = BASE64_STANDARD
        .decode(
            object
                .get("ciphertext")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .map_err(|error| format!("解析密钥备份密文失败: {error}"))?;
    let mut key = [0_u8; KEY_BYTES];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(iterations).expect("validated PBKDF2 iterations must be non-zero"),
        &salt,
        passphrase.as_bytes(),
        &mut key,
    );
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| "初始化密钥备份解密失败".to_string())?;
    let opening_key = aead::LessSafeKey::new(unbound);
    let mut nonce_array = [0_u8; NONCE_BYTES];
    nonce_array.copy_from_slice(&nonce_bytes);
    let plaintext = opening_key
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce_array),
            aead::Aad::from(KEY_BACKUP_AAD),
            &mut ciphertext,
        )
        .map_err(|_| "解密密钥备份失败，请确认口令正确且备份未损坏".to_string())?
        .to_vec();
    key.fill(0);
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    #[test]
    fn passphrase_encryption_round_trips_binary_data() {
        let plaintext = b"portico\0private-key\xff";
        let encrypted = super::encrypt_with_passphrase(plaintext, "correct horse battery staple")
            .expect("encryption should succeed");
        assert!(!encrypted.contains("private-key"));
        assert_eq!(
            super::decrypt_with_passphrase(&encrypted, "correct horse battery staple")
                .expect("decryption should succeed"),
            plaintext
        );
    }

    #[test]
    fn passphrase_encryption_rejects_wrong_passphrase() {
        let encrypted = super::encrypt_with_passphrase(b"secret", "right-passphrase")
            .expect("encryption should succeed");
        assert!(super::decrypt_with_passphrase(&encrypted, "wrong-passphrase").is_err());
    }
}
