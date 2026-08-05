use crate::crypto::{decrypt_json, encrypt_json, key_file_path};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

const TOKEN_ACCOUNT: &str = "sync:token";
const EMAIL_ACCOUNT: &str = "sync:email";

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
