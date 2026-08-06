use crate::crypto::{
    decrypt_json, decrypt_with_passphrase, encrypt_json, encrypt_with_passphrase, key_file_path,
    portico_directory,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const TOKEN_ACCOUNT: &str = "sync:token";
const EMAIL_ACCOUNT: &str = "sync:email";
const MAX_KEY_FILES: usize = 128;
const MAX_KEY_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_KEY_TOTAL_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub authenticated: bool,
    pub email: Option<String>,
    pub key_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAuthResult {
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFileInfo {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySyncResult {
    pub files: Vec<KeyFileInfo>,
    pub updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyBundle {
    version: u32,
    created_at: u64,
    files: Vec<KeyBundleFile>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyBundleFile {
    name: String,
    content: String,
}

fn token() -> Option<String> {
    super::read_secret(TOKEN_ACCOUNT).filter(|value| !value.trim().is_empty())
}

fn email() -> Option<String> {
    super::read_secret(EMAIL_ACCOUNT).filter(|value| !value.trim().is_empty())
}

fn normalize_endpoint(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err("请先配置云端同步服务地址".to_string());
    }
    if !value.starts_with("https://") && !value.starts_with("http://") {
        return Err("云端同步服务地址必须以 http:// 或 https:// 开头".to_string());
    }
    if value.starts_with("http://")
        && !value.starts_with("http://127.0.0.1")
        && !value.starts_with("http://localhost")
    {
        return Err("云端同步必须使用 HTTPS；HTTP 仅允许本机开发地址".to_string());
    }
    Ok(value.to_string())
}

fn response_error(response: reqwest::blocking::Response) -> String {
    let status = response.status();
    let text = response.text().unwrap_or_default();
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| text.trim().to_string());
    if message.is_empty() {
        format!("同步服务请求失败（HTTP {}）", status.as_u16())
    } else {
        format!("同步服务请求失败（HTTP {}）：{message}", status.as_u16())
    }
}

fn request_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("Portico SSH cloud sync")
        .build()
        .map_err(|error| format!("初始化同步网络连接失败: {error}"))
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn validate_key_passphrase(passphrase: &str) -> Result<(), String> {
    let length = passphrase.chars().count();
    if !(8..=256).contains(&length) {
        return Err("密钥同步口令长度必须为 8-256 位".to_string());
    }
    Ok(())
}

fn is_key_file_name(name: &str) -> bool {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':'])
        || name.chars().any(char::is_control)
    {
        return false;
    }
    let path = Path::new(name);
    path.components().count() == 1
        && path.file_name().and_then(|value| value.to_str()) == Some(name)
        && path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("key"))
}

fn list_local_key_files_sync() -> Result<Vec<KeyFileInfo>, String> {
    let directory = portico_directory()?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in
        fs::read_dir(&directory).map_err(|error| format!("读取本地密钥目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取本地密钥条目失败: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取本地密钥类型失败: {error}"))?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "本地密钥文件名必须是有效的 Unicode".to_string())?;
        if !is_key_file_name(&name) {
            continue;
        }
        let size = entry
            .metadata()
            .map_err(|error| format!("读取密钥文件 {name} 信息失败: {error}"))?
            .len();
        files.push(KeyFileInfo { name, size });
    }
    files.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(files)
}

fn build_key_bundle() -> Result<(KeyBundle, Vec<KeyFileInfo>), String> {
    let files = list_local_key_files_sync()?;
    if files.is_empty() {
        return Err("~/.porticossh 中没有可同步的 *.key 文件".to_string());
    }
    if files.len() > MAX_KEY_FILES {
        return Err(format!("密钥文件数量不能超过 {MAX_KEY_FILES} 个"));
    }
    let directory = portico_directory()?;
    let mut total_bytes = 0_u64;
    let mut bundle_files = Vec::with_capacity(files.len());
    for file in &files {
        if file.size > MAX_KEY_FILE_BYTES {
            return Err(format!("密钥文件 {} 超过 2 MiB 限制", file.name));
        }
        total_bytes = total_bytes.saturating_add(file.size);
        if total_bytes > MAX_KEY_TOTAL_BYTES {
            return Err("密钥文件总大小超过 8 MiB 限制".to_string());
        }
        let bytes = fs::read(directory.join(&file.name))
            .map_err(|error| format!("读取密钥文件 {} 失败: {error}", file.name))?;
        bundle_files.push(KeyBundleFile {
            name: file.name.clone(),
            content: BASE64_STANDARD.encode(bytes),
        });
    }
    Ok((
        KeyBundle {
            version: 1,
            created_at: unix_timestamp(),
            files: bundle_files,
        },
        files,
    ))
}

fn decode_key_bundle(raw: &[u8]) -> Result<(KeyBundle, Vec<(String, Vec<u8>)>), String> {
    let bundle: KeyBundle =
        serde_json::from_slice(raw).map_err(|error| format!("解析密钥备份内容失败: {error}"))?;
    if bundle.version != 1 {
        return Err("不支持的密钥备份内容版本".to_string());
    }
    if bundle.files.is_empty() || bundle.files.len() > MAX_KEY_FILES {
        return Err("密钥备份中的文件数量无效".to_string());
    }
    let mut names = HashSet::new();
    let mut total_bytes = 0_u64;
    let mut decoded = Vec::with_capacity(bundle.files.len());
    for file in &bundle.files {
        if !is_key_file_name(&file.name) || !names.insert(file.name.to_lowercase()) {
            return Err("密钥备份包含无效或重复的文件名".to_string());
        }
        let bytes = BASE64_STANDARD
            .decode(&file.content)
            .map_err(|error| format!("解析密钥文件 {} 失败: {error}", file.name))?;
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if size > MAX_KEY_FILE_BYTES {
            return Err(format!("密钥文件 {} 超过 2 MiB 限制", file.name));
        }
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > MAX_KEY_TOTAL_BYTES {
            return Err("密钥备份总大小超过 8 MiB 限制".to_string());
        }
        decoded.push((file.name.clone(), bytes));
    }
    Ok((bundle, decoded))
}

fn restore_key_bundle(
    bundle: &KeyBundle,
    files: Vec<(String, Vec<u8>)>,
    overwrite: bool,
) -> Result<KeySyncResult, String> {
    let directory = portico_directory()?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建本地密钥目录失败: {error}"))?;
    let mut conflicts = Vec::new();
    for (name, _) in &files {
        let destination = directory.join(name);
        match fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!("拒绝覆盖符号链接密钥文件：{name}"));
            }
            Ok(_) => conflicts.push(name.clone()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("检查本地密钥文件 {name} 失败: {error}")),
        }
    }
    if !overwrite && !conflicts.is_empty() {
        return Err(format!("以下本地密钥已存在：{}", conflicts.join("、")));
    }

    let mut staged = Vec::with_capacity(files.len());
    for (index, (name, bytes)) in files.iter().enumerate() {
        let temporary = directory.join(format!(
            ".portico-key-restore-{}-{index}.tmp",
            uuid::Uuid::new_v4()
        ));
        if let Err(error) = fs::write(&temporary, bytes) {
            for (path, _) in &staged {
                let _ = fs::remove_file(path);
            }
            return Err(format!("暂存密钥文件 {name} 失败: {error}"));
        }
        staged.push((temporary, directory.join(name)));
    }
    for (index, (temporary, destination)) in staged.iter().enumerate() {
        if let Err(error) = fs::copy(temporary, destination) {
            for (path, _) in staged.iter().skip(index) {
                let _ = fs::remove_file(path);
            }
            return Err(format!(
                "恢复密钥文件 {} 失败: {error}",
                destination.display()
            ));
        }
        let _ = fs::remove_file(temporary);
    }

    Ok(KeySyncResult {
        files: files
            .into_iter()
            .map(|(name, bytes)| KeyFileInfo {
                name,
                size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            })
            .collect(),
        updated_at: bundle.created_at,
    })
}

fn auth_request(
    endpoint: String,
    path: &str,
    email: String,
    password: String,
) -> Result<SyncAuthResult, String> {
    let client = request_client()?;
    let response = client
        .post(format!("{endpoint}{path}"))
        .json(&json!({ "email": email, "password": password }))
        .send()
        .map_err(|error| format!("连接同步服务失败: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response));
    }
    let payload = response
        .json::<Value>()
        .map_err(|error| format!("解析同步服务响应失败: {error}"))?;
    let access_token = payload
        .get("token")
        .or_else(|| payload.get("accessToken"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "同步服务没有返回登录令牌".to_string())?;
    super::keyring_entry(TOKEN_ACCOUNT)?
        .set_password(access_token)
        .map_err(|error| format!("保存同步登录状态失败: {error}"))?;
    super::keyring_entry(EMAIL_ACCOUNT)?
        .set_password(&email)
        .map_err(|error| format!("保存同步账号失败: {error}"))?;
    Ok(SyncAuthResult { email })
}

#[tauri::command]
pub async fn sync_register(
    endpoint: String,
    email: String,
    password: String,
) -> Result<SyncAuthResult, String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    let email = email.trim().to_string();
    if email.is_empty() || !email.contains('@') {
        return Err("请输入有效的邮箱地址".to_string());
    }
    if password.chars().count() < 8 {
        return Err("密码至少需要 8 位".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        auth_request(endpoint, "/auth/register", email, password)
    })
    .await
    .map_err(|error| format!("注册任务失败: {error}"))?
}

#[tauri::command]
pub async fn sync_login(
    endpoint: String,
    email: String,
    password: String,
) -> Result<SyncAuthResult, String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    let email = email.trim().to_string();
    if email.is_empty() || password.is_empty() {
        return Err("请输入邮箱和密码".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        auth_request(endpoint, "/auth/login", email, password)
    })
    .await
    .map_err(|error| format!("登录任务失败: {error}"))?
}

#[tauri::command]
pub fn sync_status() -> Result<SyncStatus, String> {
    Ok(SyncStatus {
        authenticated: token().is_some(),
        email: email(),
        key_path: key_file_path()?,
    })
}

#[tauri::command]
pub fn sync_logout() -> Result<(), String> {
    for account in [TOKEN_ACCOUNT, EMAIL_ACCOUNT] {
        match super::keyring_entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(format!("退出同步账号失败: {error}")),
        }
    }
    Ok(())
}

fn hydrate_snapshot(mut snapshot: Value) -> Value {
    if let Some(servers) = snapshot.get_mut("servers").and_then(Value::as_array_mut) {
        for server in servers {
            let Some(object) = server.as_object_mut() else {
                continue;
            };
            let Some(id) = object.get("id").and_then(Value::as_str).map(str::to_string) else {
                continue;
            };
            if let Some(value) = super::read_secret(&format!("server:{id}:password")) {
                object.insert("password".to_string(), Value::String(value));
            }
            if let Some(value) = super::read_secret(&format!("server:{id}:passphrase")) {
                object.insert("passphrase".to_string(), Value::String(value));
            }
            if let Some(jump_host) = object.get_mut("jumpHost").and_then(Value::as_object_mut) {
                if let Some(value) = super::read_secret(&format!("server:{id}:jump:password")) {
                    jump_host.insert("password".to_string(), Value::String(value));
                }
                if let Some(value) = super::read_secret(&format!("server:{id}:jump:passphrase")) {
                    jump_host.insert("passphrase".to_string(), Value::String(value));
                }
            }
        }
    }
    if let Some(config) = snapshot.get_mut("aiConfig").and_then(Value::as_object_mut) {
        if let Some(value) = super::read_secret("ai:api-key") {
            config.insert("apiKey".to_string(), Value::String(value));
        }
    }
    snapshot
}

fn store_snapshot_secrets(snapshot: &Value) -> Result<(), String> {
    let set_or_delete = |account: String, value: Option<&str>| -> Result<(), String> {
        let entry = super::keyring_entry(&account)?;
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            entry
                .set_password(value)
                .map_err(|error| format!("保存同步凭据失败: {error}"))?;
        } else {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(error) => return Err(format!("删除同步凭据失败: {error}")),
            }
        }
        Ok(())
    };
    if let Some(servers) = snapshot.get("servers").and_then(Value::as_array) {
        for server in servers {
            let Some(object) = server.as_object() else {
                continue;
            };
            let Some(id) = object.get("id").and_then(Value::as_str) else {
                continue;
            };
            let jump_host = object.get("jumpHost").and_then(Value::as_object);
            set_or_delete(
                format!("server:{id}:password"),
                object.get("password").and_then(Value::as_str),
            )?;
            set_or_delete(
                format!("server:{id}:passphrase"),
                object.get("passphrase").and_then(Value::as_str),
            )?;
            set_or_delete(
                format!("server:{id}:jump:password"),
                jump_host
                    .and_then(|jump| jump.get("password"))
                    .and_then(Value::as_str),
            )?;
            set_or_delete(
                format!("server:{id}:jump:passphrase"),
                jump_host
                    .and_then(|jump| jump.get("passphrase"))
                    .and_then(Value::as_str),
            )?;
        }
    }
    let api_key = snapshot
        .get("aiConfig")
        .and_then(Value::as_object)
        .and_then(|config| config.get("apiKey"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    set_or_delete("ai:api-key".to_string(), api_key)?;
    Ok(())
}

fn strip_snapshot_secrets(mut snapshot: Value) -> Value {
    if let Some(servers) = snapshot.get_mut("servers").and_then(Value::as_array_mut) {
        for server in servers {
            if let Some(object) = server.as_object_mut() {
                object.remove("password");
                object.remove("passphrase");
                if let Some(jump) = object.get_mut("jumpHost").and_then(Value::as_object_mut) {
                    jump.remove("password");
                    jump.remove("passphrase");
                }
            }
        }
    }
    if let Some(config) = snapshot.get_mut("aiConfig").and_then(Value::as_object_mut) {
        config.remove("apiKey");
    }
    snapshot
}

fn push_sync(endpoint: String, snapshot: Value) -> Result<(), String> {
    let token = token().ok_or_else(|| "请先登录同步账号".to_string())?;
    let client = request_client()?;
    let encrypted = encrypt_json(&hydrate_snapshot(snapshot))?;
    let response = client
        .put(format!("{endpoint}/sync/data"))
        .bearer_auth(token)
        .json(&json!({
            "ciphertext": encrypted,
            "updatedAt": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
        }))
        .send()
        .map_err(|error| format!("上传同步数据失败: {error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(response_error(response))
    }
}

fn pull_sync(endpoint: String) -> Result<Value, String> {
    let token = token().ok_or_else(|| "请先登录同步账号".to_string())?;
    let client = request_client()?;
    let response = client
        .get(format!("{endpoint}/sync/data"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("下载同步数据失败: {error}"))?;
    if response.status().as_u16() == 404 {
        return Ok(Value::Null);
    }
    if !response.status().is_success() {
        return Err(response_error(response));
    }
    let payload = response
        .json::<Value>()
        .map_err(|error| format!("解析同步数据响应失败: {error}"))?;
    let ciphertext = payload
        .get("ciphertext")
        .or_else(|| payload.get("data"))
        .and_then(Value::as_str)
        .ok_or_else(|| "同步服务没有返回密文".to_string())?;
    let snapshot = decrypt_json(ciphertext)?;
    store_snapshot_secrets(&snapshot)?;
    Ok(strip_snapshot_secrets(snapshot))
}

#[tauri::command]
pub async fn sync_push(endpoint: String, snapshot: Value) -> Result<(), String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    tauri::async_runtime::spawn_blocking(move || push_sync(endpoint, snapshot))
        .await
        .map_err(|error| format!("上传同步任务失败: {error}"))?
}

#[tauri::command]
pub async fn sync_pull(endpoint: String) -> Result<Option<Value>, String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    tauri::async_runtime::spawn_blocking(move || pull_sync(endpoint))
        .await
        .map_err(|error| format!("下载同步任务失败: {error}"))?
        .map(|snapshot| {
            if snapshot.is_null() {
                None
            } else {
                Some(snapshot)
            }
        })
}

#[tauri::command]
pub fn sync_list_key_files() -> Result<Vec<KeyFileInfo>, String> {
    list_local_key_files_sync()
}

fn upload_keys(endpoint: String, passphrase: String) -> Result<KeySyncResult, String> {
    let token = token().ok_or_else(|| "请先登录同步账号".to_string())?;
    let (bundle, files) = build_key_bundle()?;
    let plaintext =
        serde_json::to_vec(&bundle).map_err(|error| format!("序列化密钥备份失败: {error}"))?;
    let ciphertext = encrypt_with_passphrase(&plaintext, &passphrase)?;
    let client = request_client()?;
    let response = client
        .put(format!("{endpoint}/sync/keys"))
        .bearer_auth(token)
        .json(&json!({
            "ciphertext": ciphertext,
            "updatedAt": bundle.created_at,
        }))
        .send()
        .map_err(|error| format!("上传密钥备份失败: {error}"))?;
    if !response.status().is_success() {
        return Err(response_error(response));
    }
    Ok(KeySyncResult {
        files,
        updated_at: bundle.created_at,
    })
}

#[tauri::command]
pub async fn sync_upload_keys(
    endpoint: String,
    passphrase: String,
) -> Result<KeySyncResult, String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    validate_key_passphrase(&passphrase)?;
    tauri::async_runtime::spawn_blocking(move || upload_keys(endpoint, passphrase))
        .await
        .map_err(|error| format!("上传密钥备份任务失败: {error}"))?
}

fn download_keys(
    endpoint: String,
    passphrase: String,
    overwrite: bool,
) -> Result<KeySyncResult, String> {
    let token = token().ok_or_else(|| "请先登录同步账号".to_string())?;
    let client = request_client()?;
    let response = client
        .get(format!("{endpoint}/sync/keys"))
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("下载密钥备份失败: {error}"))?;
    if response.status().as_u16() == 404 {
        return Err("当前账号还没有上传密钥备份".to_string());
    }
    if !response.status().is_success() {
        return Err(response_error(response));
    }
    let payload = response
        .json::<Value>()
        .map_err(|error| format!("解析密钥备份响应失败: {error}"))?;
    let ciphertext = payload
        .get("ciphertext")
        .and_then(Value::as_str)
        .ok_or_else(|| "同步服务没有返回密钥备份密文".to_string())?;
    let server_updated_at = payload.get("updatedAt").and_then(Value::as_u64);
    let plaintext = decrypt_with_passphrase(ciphertext, &passphrase)?;
    let (bundle, files) = decode_key_bundle(&plaintext)?;
    let mut result = restore_key_bundle(&bundle, files, overwrite)?;
    if let Some(updated_at) = server_updated_at {
        result.updated_at = updated_at;
    }
    Ok(result)
}

#[tauri::command]
pub async fn sync_download_keys(
    endpoint: String,
    passphrase: String,
    overwrite: bool,
) -> Result<KeySyncResult, String> {
    let endpoint = normalize_endpoint(&endpoint)?;
    validate_key_passphrase(&passphrase)?;
    tauri::async_runtime::spawn_blocking(move || download_keys(endpoint, passphrase, overwrite))
        .await
        .map_err(|error| format!("下载密钥备份任务失败: {error}"))?
}

#[cfg(test)]
mod tests {
    #[test]
    fn key_backup_names_stay_inside_portico_directory() {
        assert!(super::is_key_file_name("sync.key"));
        assert!(super::is_key_file_name("production-ed25519.key"));
        for invalid in [
            "../escape.key",
            "nested/private.key",
            "nested\\private.key",
            "C:\\outside.key",
            "private.key:stream",
            "private.key\n",
        ] {
            assert!(!super::is_key_file_name(invalid), "accepted {invalid:?}");
        }
    }
}
