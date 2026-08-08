use crate::crypto::{decrypt_json, encrypt_json, ensure_key};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

const SERVERS_KEY: &str = "servers";
const DELETED_SERVER_IDS_KEY: &str = "deleted_server_ids";
const SERVER_GROUPS_KEY: &str = "server_groups";
const AI_CONFIG_KEY: &str = "ai_config";
const AI_CONVERSATIONS_KEY: &str = "ai_conversations";
const COLLAPSED_GROUPS_KEY: &str = "collapsed_groups";
const SYNC_METADATA_KEY: &str = "sync_metadata";

pub struct AppDatabase {
    connection: Mutex<Connection>,
}

impl AppDatabase {
    pub fn initialize(app: &AppHandle) -> Result<Self, String> {
        ensure_key()?;
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("获取应用数据目录失败: {error}"))?;
        fs::create_dir_all(&app_data_dir)
            .map_err(|error| format!("创建应用数据目录失败: {error}"))?;
        let database_path = app_data_dir.join("portico.sqlite3");
        let connection = Connection::open(&database_path)
            .map_err(|error| format!("打开 SQLite 数据库失败: {error}"))?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS app_state (
                   key TEXT PRIMARY KEY NOT NULL,
                   value TEXT NOT NULL
                 );",
            )
            .map_err(|error| format!("初始化 SQLite 数据库失败: {error}"))?;
        let legacy_values = {
            let mut statement = connection
                .prepare("SELECT key, value FROM app_state")
                .map_err(|error| format!("读取旧版 SQLite 状态失败: {error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| format!("扫描旧版 SQLite 状态失败: {error}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("读取旧版 SQLite 状态失败: {error}"))?
        };
        for (key, raw) in legacy_values {
            if decrypt_json(&raw).is_ok() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let encrypted = encrypt_json(&value)?;
            connection
                .execute(
                    "UPDATE app_state SET value = ?1 WHERE key = ?2",
                    params![encrypted, key],
                )
                .map_err(|error| format!("迁移 SQLite 状态失败: {error}"))?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn read_value(&self, key: &str) -> Result<Option<Value>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 状态锁已损坏".to_string())?;
        let raw = connection
            .query_row(
                "SELECT value FROM app_state WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("读取 SQLite 状态失败: {error}"))?;
        raw.map(|value| match decrypt_json(&value) {
            Ok(value) => Ok(value),
            Err(_) => serde_json::from_str(&value)
                .map_err(|error| format!("解析 SQLite 状态失败: {error}")),
        })
        .transpose()
    }

    fn write_value(&self, key: &str, value: &Value) -> Result<(), String> {
        let serialized = encrypt_json(value)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| "SQLite 状态锁已损坏".to_string())?;
        connection
            .execute(
                "INSERT INTO app_state (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, serialized],
            )
            .map_err(|error| format!("写入 SQLite 状态失败: {error}"))?;
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStorageState {
    servers: Vec<Value>,
    deleted_server_ids: Vec<String>,
    saved_groups: Vec<String>,
    ai_config: Option<Value>,
    ai_conversations: Vec<Value>,
    collapsed_groups: Vec<String>,
    sync_meta: Option<Value>,
}

fn read_array(database: &AppDatabase, key: &str) -> Result<Vec<Value>, String> {
    match database.read_value(key)? {
        None => Ok(Vec::new()),
        Some(Value::Array(values)) => Ok(values),
        Some(_) => Err(format!("SQLite 状态 {key} 不是数组")),
    }
}

fn read_string_array(database: &AppDatabase, key: &str) -> Result<Vec<String>, String> {
    read_array(database, key)?
        .into_iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("SQLite 状态 {key} 包含非字符串值"))
        })
        .collect()
}

fn strip_secret_fields(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    object.remove("password");
    object.remove("passphrase");
    if let Some(Value::Object(jump_host)) = object.get_mut("jumpHost") {
        jump_host.remove("password");
        jump_host.remove("passphrase");
    }
}

fn strip_ai_secret(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.remove("apiKey");
    }
}

#[tauri::command]
pub fn load_app_state(database: State<'_, AppDatabase>) -> Result<AppStorageState, String> {
    Ok(AppStorageState {
        servers: read_array(&database, SERVERS_KEY)?,
        deleted_server_ids: read_string_array(&database, DELETED_SERVER_IDS_KEY)?,
        saved_groups: read_string_array(&database, SERVER_GROUPS_KEY)?,
        ai_config: database.read_value(AI_CONFIG_KEY)?,
        ai_conversations: read_array(&database, AI_CONVERSATIONS_KEY)?,
        collapsed_groups: read_string_array(&database, COLLAPSED_GROUPS_KEY)?,
        sync_meta: database.read_value(SYNC_METADATA_KEY)?,
    })
}

#[tauri::command]
pub fn save_servers(
    database: State<'_, AppDatabase>,
    mut servers: Vec<Value>,
) -> Result<(), String> {
    servers.iter_mut().for_each(strip_secret_fields);
    database.write_value(SERVERS_KEY, &Value::Array(servers))
}

#[tauri::command]
pub fn save_deleted_server_ids(
    database: State<'_, AppDatabase>,
    server_ids: Vec<String>,
) -> Result<(), String> {
    database.write_value(
        DELETED_SERVER_IDS_KEY,
        &Value::Array(server_ids.into_iter().map(Value::String).collect()),
    )
}

#[tauri::command]
pub fn save_server_groups(
    database: State<'_, AppDatabase>,
    groups: Vec<String>,
) -> Result<(), String> {
    database.write_value(
        SERVER_GROUPS_KEY,
        &Value::Array(groups.into_iter().map(Value::String).collect()),
    )
}

#[tauri::command]
pub fn save_ai_config(database: State<'_, AppDatabase>, mut config: Value) -> Result<(), String> {
    strip_ai_secret(&mut config);
    database.write_value(AI_CONFIG_KEY, &config)
}

#[tauri::command]
pub fn save_ai_conversations(
    database: State<'_, AppDatabase>,
    conversations: Vec<Value>,
) -> Result<(), String> {
    database.write_value(AI_CONVERSATIONS_KEY, &Value::Array(conversations))
}

#[tauri::command]
pub fn save_collapsed_groups(
    database: State<'_, AppDatabase>,
    groups: Vec<String>,
) -> Result<(), String> {
    database.write_value(
        COLLAPSED_GROUPS_KEY,
        &Value::Array(groups.into_iter().map(Value::String).collect()),
    )
}

#[tauri::command]
pub fn save_sync_metadata(
    database: State<'_, AppDatabase>,
    sync_meta: Value,
) -> Result<(), String> {
    database.write_value(SYNC_METADATA_KEY, &sync_meta)
}
