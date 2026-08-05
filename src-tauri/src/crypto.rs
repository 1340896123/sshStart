use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use serde_json::Value;
use std::{env, fs, path::PathBuf};

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const KEY_FILE: &str = "sync.key";

fn key_path() -> Result<PathBuf, String> {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .ok_or_else(|| "无法定位用户主目录，不能初始化同步密钥".to_string())?;
    Ok(PathBuf::from(home).join(".porticossh").join(KEY_FILE))
}

fn load_key() -> Result<[u8; KEY_BYTES], String> {
    let path = key_path()?;
    if let Ok(encoded) = fs::read_to_string(&path) {
        let decoded = BASE64_STANDARD
            .decode(encoded.trim())
            .map_err(|error| format!("读取同步密钥失败: {error}"))?;
        if decoded.len() != KEY_BYTES {
            return Err("同步密钥长度无效".to_string());
        }
        let mut key = [0_u8; KEY_BYTES];
        key.copy_from_slice(&decoded);
        return Ok(key);
    }

    let parent = path
        .parent()
        .ok_or_else(|| "同步密钥目录无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建同步密钥目录失败: {error}"))?;
    let mut key = [0_u8; KEY_BYTES];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "生成同步密钥失败".to_string())?;
    let encoded = BASE64_STANDARD.encode(key);
    fs::write(&path, encoded).map_err(|error| format!("保存同步密钥失败: {error}"))?;
    Ok(key)
}

pub fn ensure_key() -> Result<(), String> {
    load_key().map(|_| ())
}

pub fn key_file_path() -> Result<String, String> {
    Ok(key_path()?.to_string_lossy().to_string())
}

pub fn encrypt_json(value: &Value) -> Result<String, String> {
    let plaintext =
        serde_json::to_vec(value).map_err(|error| format!("序列化加密数据失败: {error}"))?;
    let key = load_key()?;
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

pub fn decrypt_json(raw: &str) -> Result<Value, String> {
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
    let key = load_key()?;
    let unbound = aead::UnboundKey::new(&aead::AES_256_GCM, &key)
        .map_err(|_| "初始化解密密钥失败".to_string())?;
    let opening_key = aead::LessSafeKey::new(unbound);
    let mut plaintext = ciphertext;
    let mut nonce_array = [0_u8; NONCE_BYTES];
    nonce_array.copy_from_slice(&nonce_bytes);
    let nonce = aead::Nonce::assume_unique_for_key(nonce_array);
    let bytes = opening_key
        .open_in_place(nonce, aead::Aad::empty(), &mut plaintext)
        .map_err(|_| "解密数据失败，请确认同步密钥未被替换".to_string())?;
    serde_json::from_slice(bytes).map_err(|error| format!("解析解密数据失败: {error}"))
}
