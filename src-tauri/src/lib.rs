mod system_icons;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ssh2::{CheckResult, KnownHostFileKind, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    env,
    fs::{self, File},
    hash::{Hash, Hasher},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{mpsc, Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerProfile {
    id: String,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
    jump_host: Option<JumpHostProfile>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JumpHostProfile {
    enabled: bool,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFile {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    permissions: String,
    modified: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VscodeEditSession {
    local_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RemoteFileRevision {
    size: u64,
    modified: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VscodeSyncEvent {
    session_id: String,
    server_id: String,
    remote_path: String,
    local_path: String,
    status: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessInfo {
    pid: u32,
    user: String,
    command: String,
    memory_percent: f32,
    cpu_percent: f32,
    elapsed_seconds: u64,
    arguments: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkConnection {
    protocol: String,
    state: String,
    local_address: String,
    local_port: Option<u16>,
    remote_address: String,
    remote_port: Option<u16>,
    pid: Option<u32>,
    process: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkInterface {
    name: String,
    family: String,
    address: String,
    prefix_length: Option<u8>,
    state: String,
    mac: String,
    mtu: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiToolSettings {
    #[serde(default = "default_true")]
    execute_command: bool,
    #[serde(default = "default_true")]
    background_task: bool,
    #[serde(default)]
    pty_interaction: bool,
    #[serde(default = "default_true")]
    read_file: bool,
    #[serde(default)]
    write_file: bool,
    #[serde(default)]
    sftp_upload: bool,
    #[serde(default = "default_true")]
    sftp_download: bool,
    #[serde(default = "default_true")]
    list_directory: bool,
    #[serde(default = "default_true")]
    get_system_metrics: bool,
    #[serde(default = "default_true")]
    process_manager: bool,
    #[serde(default = "default_true")]
    network_checker: bool,
    #[serde(default = "default_true")]
    docker_manager: bool,
    #[serde(default = "default_true")]
    systemd_control: bool,
    #[serde(default = "default_true")]
    risk_checker: bool,
    #[serde(default = "default_true")]
    snippet_library: bool,
    #[serde(default = "default_true")]
    log_analyzer: bool,
    #[serde(default = "default_tool_rounds")]
    max_tool_rounds: u32,
    #[serde(default = "default_tool_output_chars")]
    max_output_chars: usize,
    #[serde(default = "default_command_timeout_seconds")]
    command_timeout_seconds: u32,
    #[serde(default)]
    allow_mutating_tools: bool,
}

impl Default for AiToolSettings {
    fn default() -> Self {
        Self {
            execute_command: true,
            background_task: true,
            pty_interaction: false,
            read_file: true,
            write_file: false,
            sftp_upload: false,
            sftp_download: true,
            list_directory: true,
            get_system_metrics: true,
            process_manager: true,
            network_checker: true,
            docker_manager: true,
            systemd_control: true,
            risk_checker: true,
            snippet_library: true,
            log_analyzer: true,
            max_tool_rounds: default_tool_rounds(),
            max_output_chars: default_tool_output_chars(),
            command_timeout_seconds: default_command_timeout_seconds(),
            allow_mutating_tools: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum AiApiMode {
    #[default]
    ChatCompletions,
    Responses,
}

impl AiApiMode {
    fn endpoint_path(self) -> &'static str {
        match self {
            Self::ChatCompletions => "chat/completions",
            Self::Responses => "responses",
        }
    }

    fn is_responses(self) -> bool {
        self == Self::Responses
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiConfig {
    #[serde(default)]
    api_mode: AiApiMode,
    endpoint: String,
    api_key: String,
    model: String,
    #[serde(default = "default_context_window")]
    context_window: u32,
    #[serde(default = "default_max_output_tokens")]
    max_output_tokens: u32,
    #[serde(default = "default_auto_compress")]
    auto_compress: bool,
    #[serde(default = "default_temperature")]
    temperature: f32,
    system_prompt: String,
    #[serde(default)]
    tools: AiToolSettings,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiAttachmentReference {
    kind: String,
    name: String,
    remote_path: String,
    mime_type: String,
    size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AiInputMessage {
    role: String,
    content: String,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    attachments: Vec<AiAttachmentReference>,
}

fn ai_input_message_content(message: &AiInputMessage) -> String {
    if message.attachments.is_empty() {
        return message.content.clone();
    }
    let references = message
        .attachments
        .iter()
        .map(|attachment| {
            let label = if attachment.kind == "text" {
                "大文本"
            } else {
                "图片"
            };
            format!(
                "- {label} `{}`（{}，{} 字节）：`{}`",
                attachment.name, attachment.mime_type, attachment.size, attachment.remote_path
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    if message.content.is_empty() {
        format!("[服务器临时文件引用]\n{references}")
    } else {
        format!("{}\n\n[服务器临时文件引用]\n{references}", message.content)
    }
}

fn ai_input_message_cost(message: &AiInputMessage) -> usize {
    estimate_tokens(&ai_input_message_content(message)) + 4
}

fn ai_input_message_transcript(message: &AiInputMessage) -> String {
    format!("{}: {}", message.role, ai_input_message_content(message))
}

fn ai_input_message_to_api(message: &AiInputMessage) -> Value {
    json!({ "role": message.role, "content": ai_input_message_content(message) })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiToolResult {
    id: String,
    tool: String,
    command: String,
    output: String,
    exit_code: i32,
    status: String,
    started_at: u64,
    updated_at: u64,
    completed_at: Option<u64>,
}

fn ai_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn ai_unique_id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}

fn completed_ai_tool_result(
    id: String,
    tool: String,
    command: String,
    output: String,
    exit_code: i32,
    started_at: u64,
) -> AiToolResult {
    let completed_at = ai_timestamp_ms();
    AiToolResult {
        id,
        tool,
        command,
        output,
        exit_code,
        status: if exit_code == 0 {
            "completed".to_string()
        } else {
            "error".to_string()
        },
        started_at,
        updated_at: completed_at,
        completed_at: Some(completed_at),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiApproval {
    tool: String,
    command: String,
    arguments: Value,
    reason: String,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiTokenUsage {
    available: bool,
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    cached_tokens: u64,
    reasoning_tokens: u64,
    context_tokens: u64,
    requests: u32,
}

impl AiTokenUsage {
    fn from_payload(payload: &Value) -> Option<Self> {
        let usage = payload.get("usage")?;
        let field = |names: &[&str]| {
            names
                .iter()
                .find_map(|name| usage.get(*name).and_then(Value::as_u64))
        };
        let pointer = |paths: &[&str]| {
            paths
                .iter()
                .find_map(|path| usage.pointer(path).and_then(Value::as_u64))
        };
        let input = field(&["prompt_tokens", "input_tokens"]);
        let output = field(&["completion_tokens", "output_tokens"]);
        let total = field(&["total_tokens"]);
        let cached = pointer(&[
            "/prompt_tokens_details/cached_tokens",
            "/input_tokens_details/cached_tokens",
            "/prompt_cache_hit_tokens",
            "/cache_read_input_tokens",
            "/cached_tokens",
        ]);
        let reasoning = pointer(&[
            "/completion_tokens_details/reasoning_tokens",
            "/output_tokens_details/reasoning_tokens",
            "/reasoning_tokens",
        ]);
        if input.is_none()
            && output.is_none()
            && total.is_none()
            && cached.is_none()
            && reasoning.is_none()
        {
            return None;
        }
        let input_tokens = input.unwrap_or_default();
        let output_tokens = output.unwrap_or_default();
        let total_tokens = total.unwrap_or(input_tokens.saturating_add(output_tokens));
        Some(Self {
            available: true,
            input_tokens,
            output_tokens,
            total_tokens,
            cached_tokens: cached.unwrap_or_default(),
            reasoning_tokens: reasoning.unwrap_or_default(),
            context_tokens: total_tokens,
            requests: 1,
        })
    }

    fn record(&mut self, usage: Self) {
        if !usage.available {
            return;
        }
        self.available = true;
        self.input_tokens = self.input_tokens.saturating_add(usage.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(usage.output_tokens);
        self.total_tokens = self.total_tokens.saturating_add(usage.total_tokens);
        self.cached_tokens = self.cached_tokens.saturating_add(usage.cached_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(usage.reasoning_tokens);
        self.context_tokens = usage.context_tokens;
        self.requests = self.requests.saturating_add(usage.requests);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiResponse {
    content: String,
    reasoning: Option<String>,
    reasoning_content: Option<String>,
    approval: Option<AiApproval>,
    tool_calls: Vec<AiToolResult>,
    usage: AiTokenUsage,
    compaction_summary: Option<String>,
    compaction_messages_removed: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStreamDelta {
    event_type: String,
    content: Option<String>,
    reasoning: Option<String>,
    tool_call: Option<AiToolStreamUpdate>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiToolStreamUpdate {
    id: String,
    phase: String,
    status: String,
    tool: String,
    command: String,
    output: Option<String>,
    exit_code: Option<i32>,
    started_at: Option<u64>,
    updated_at: u64,
    completed_at: Option<u64>,
}

#[derive(Debug)]
struct AiStreamToolCall {
    output_index: usize,
    id: String,
    name: String,
    arguments: String,
}

impl Default for AiStreamToolCall {
    fn default() -> Self {
        Self {
            output_index: 0,
            id: ai_unique_id("ai-action"),
            name: String::new(),
            arguments: String::new(),
        }
    }
}

#[derive(Debug, Default)]
struct AiStreamCompletion {
    content: String,
    reasoning: String,
    tool_calls: Vec<AiStreamToolCall>,
    response_output: Vec<Value>,
    usage: AiTokenUsage,
    response_id: Option<String>,
}

impl AiStreamCompletion {
    fn tool_call_mut(&mut self, output_index: usize) -> &mut AiStreamToolCall {
        if let Some(position) = self
            .tool_calls
            .iter()
            .position(|tool_call| tool_call.output_index == output_index)
        {
            return &mut self.tool_calls[position];
        }
        self.tool_calls.push(AiStreamToolCall {
            output_index,
            ..AiStreamToolCall::default()
        });
        self.tool_calls
            .last_mut()
            .expect("tool call was just inserted")
    }

    fn apply_response_output_item(&mut self, output_index: usize, item: &Value) {
        while self.response_output.len() <= output_index {
            self.response_output.push(Value::Null);
        }
        self.response_output[output_index] = item.clone();
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return;
        }
        let target = self.tool_call_mut(output_index);
        if let Some(id) = item
            .get("call_id")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            target.id = id.to_string();
        }
        if let Some(name) = item
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            target.name = name.to_string();
        }
        if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
            target.arguments = arguments.to_string();
        }
    }

    fn response_output_items(&self) -> Vec<Value> {
        self.response_output
            .iter()
            .filter(|item| !item.is_null())
            .cloned()
            .collect()
    }

    fn message(&self) -> Value {
        let content = if self.content.is_empty() {
            Value::Null
        } else {
            json!(self.content)
        };
        let mut message = json!({ "role": "assistant", "content": content });
        if !self.tool_calls.is_empty() {
            message["tool_calls"] = Value::Array(
                self.tool_calls
                    .iter()
                    .map(|tool_call| {
                        json!({
                            "id": tool_call.id,
                            "type": "function",
                            "function": {
                                "name": tool_call.name,
                                "arguments": tool_call.arguments
                            }
                        })
                    })
                    .collect(),
            );
        }
        message
    }
}

enum TerminalRequest {
    Input(Vec<u8>),
    Resize(u32, u32),
    Stop,
}

#[derive(Default)]
struct TerminalManager {
    terminals: Mutex<HashMap<String, mpsc::Sender<TerminalRequest>>>,
}

#[derive(Clone, Default)]
struct EditorManager {
    active: Arc<Mutex<HashMap<String, ActiveEditor>>>,
}

#[derive(Clone)]
struct ActiveEditor {
    local_path: PathBuf,
    session_ids: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TransferControlState {
    Running,
    Paused,
    Cancelled,
}

#[derive(Clone)]
struct TransferControl {
    state: Arc<(Mutex<TransferControlState>, Condvar)>,
}

impl TransferControl {
    fn new() -> Self {
        Self {
            state: Arc::new((Mutex::new(TransferControlState::Running), Condvar::new())),
        }
    }

    fn wait_until_running(&self) -> Result<(), String> {
        let (lock, wake) = &*self.state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            match *state {
                TransferControlState::Running => return Ok(()),
                TransferControlState::Cancelled => return Err("传输已取消".to_string()),
                TransferControlState::Paused => {
                    state = wake
                        .wait(state)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
            }
        }
    }

    fn pause(&self) {
        let (lock, _) = &*self.state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *state == TransferControlState::Running {
            *state = TransferControlState::Paused;
        }
    }

    fn resume(&self) {
        let (lock, wake) = &*self.state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *state == TransferControlState::Paused {
            *state = TransferControlState::Running;
            wake.notify_all();
        }
    }

    fn cancel(&self) {
        let (lock, wake) = &*self.state;
        let mut state = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *state = TransferControlState::Cancelled;
        wake.notify_all();
    }
}

#[derive(Default)]
struct TransferManager {
    active: Mutex<HashMap<String, Arc<TransferControl>>>,
}

impl TransferManager {
    fn register(&self, transfer_id: &str) -> Result<Arc<TransferControl>, String> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active.contains_key(transfer_id) {
            return Err("传输任务已存在".to_string());
        }
        let control = Arc::new(TransferControl::new());
        active.insert(transfer_id.to_string(), Arc::clone(&control));
        Ok(control)
    }

    fn get(&self, transfer_id: &str) -> Result<Arc<TransferControl>, String> {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(transfer_id)
            .cloned()
            .ok_or_else(|| "找不到传输任务".to_string())
    }

    fn remove(&self, transfer_id: &str) {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(transfer_id);
    }
}

const KEYRING_SERVICE: &str = "com.portico.ssh";
const SSH_KEEPALIVE_INTERVAL_SECS: u32 = 30;
const SSH_KEEPALIVE_RETRY_SECS: u64 = 1;
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

fn poll_ssh_keepalive(session: &Session, deadline: &mut Instant) -> Result<(), String> {
    let now = Instant::now();
    if now < *deadline {
        return Ok(());
    }

    match session.keepalive_send() {
        Ok(next) => {
            *deadline = now + Duration::from_secs(u64::from(next.max(1)));
            Ok(())
        }
        // libssh2 reports EAGAIN (-37) while a non-blocking socket is not ready.
        Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {
            *deadline = now + Duration::from_secs(SSH_KEEPALIVE_RETRY_SECS);
            Ok(())
        }
        Err(error) => Err(format!("SSH 心跳失败: {error}")),
    }
}

fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|error| format!("系统凭据库不可用: {error}"))
}

fn read_secret(account: &str) -> Option<String> {
    keyring_entry(account).ok()?.get_password().ok()
}

fn hydrate_server_secrets(server: &ServerProfile) -> ServerProfile {
    let mut hydrated = server.clone();
    if hydrated.password.as_deref().unwrap_or_default().is_empty() {
        hydrated.password = read_secret(&format!("server:{}:password", server.id));
    }
    if hydrated
        .passphrase
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        hydrated.passphrase = read_secret(&format!("server:{}:passphrase", server.id));
    }
    if let Some(jump) = hydrated.jump_host.as_mut() {
        if jump.password.as_deref().unwrap_or_default().is_empty() {
            jump.password = read_secret(&format!("server:{}:jump:password", server.id));
        }
        if jump.passphrase.as_deref().unwrap_or_default().is_empty() {
            jump.passphrase = read_secret(&format!("server:{}:jump:passphrase", server.id));
        }
    }
    hydrated
}

fn resolve_address(server: &ServerProfile) -> Result<SocketAddr, String> {
    (server.host.as_str(), server.port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析主机: {error}"))?
        .next()
        .ok_or_else(|| "主机没有可用地址".to_string())
}

fn known_hosts_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "无法定位用户主目录，不能验证 SSH 主机密钥".to_string())?;
    Ok(PathBuf::from(home).join(".ssh").join("known_hosts"))
}

fn verify_known_host(session: &Session, server: &ServerProfile) -> Result<(), String> {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .map_err(|_| "known_hosts 状态锁已损坏".to_string())?;
    let path = known_hosts_path()?;
    let mut known_hosts = session
        .known_hosts()
        .map_err(|error| format!("初始化 known_hosts 失败: {error}"))?;
    if path.exists() {
        known_hosts
            .read_file(&path, KnownHostFileKind::OpenSSH)
            .map_err(|error| format!("读取 known_hosts 失败: {error}"))?;
    }
    let (key, key_type) = session
        .host_key()
        .ok_or_else(|| "服务器没有提供可验证的主机密钥".to_string())?;
    match known_hosts.check_port(&server.host, server.port, key) {
        CheckResult::Match => Ok(()),
        CheckResult::Mismatch => Err(format!(
            "SSH 主机密钥不匹配：{}:{}。连接已阻止，请检查 known_hosts。",
            server.host, server.port
        )),
        CheckResult::Failure => Err("SSH 主机密钥校验失败".to_string()),
        CheckResult::NotFound => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("创建 .ssh 目录失败: {error}"))?;
            }
            let host = if server.port == 22 {
                server.host.clone()
            } else {
                format!("[{}]:{}", server.host, server.port)
            };
            known_hosts
                .add(&host, key, "Portico SSH TOFU", key_type.into())
                .map_err(|error| format!("记录 SSH 主机密钥失败: {error}"))?;
            known_hosts
                .write_file(&path, KnownHostFileKind::OpenSSH)
                .map_err(|error| format!("写入 known_hosts 失败: {error}"))?;
            Ok(())
        }
    }
}

fn authenticate_session(session: &mut Session, server: &ServerProfile) -> Result<(), String> {
    match server.auth_type.as_str() {
        "key" => {
            let key_path = server
                .private_key_path
                .as_deref()
                .filter(|path| !path.is_empty())
                .ok_or_else(|| "未配置私钥路径".to_string())?;
            session
                .userauth_pubkey_file(
                    &server.username,
                    None,
                    Path::new(key_path),
                    server
                        .passphrase
                        .as_deref()
                        .filter(|value| !value.is_empty()),
                )
                .map_err(|error| format!("私钥认证失败: {error}"))?;
        }
        _ => {
            let password = server
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "系统凭据库中没有该服务器的密码".to_string())?;
            session
                .userauth_password(&server.username, password)
                .map_err(|error| format!("密码认证失败: {error}"))?;
        }
    }
    if !session.authenticated() {
        return Err("服务器拒绝了身份验证".to_string());
    }
    Ok(())
}

fn connect_ssh_direct(server: &ServerProfile) -> Result<Session, String> {
    let address = resolve_address(&server)?;
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(12))
        .map_err(|error| format!("TCP 连接失败: {error}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(30))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(30))).ok();

    let mut session = Session::new().map_err(|error| format!("SSH 会话初始化失败: {error}"))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| format!("SSH 握手失败: {error}"))?;
    verify_known_host(&session, &server)?;
    authenticate_session(&mut session, server)?;
    Ok(session)
}

fn jump_as_server(jump: &JumpHostProfile, id: &str) -> ServerProfile {
    ServerProfile {
        id: format!("{id}:jump"),
        host: jump.host.clone(),
        port: jump.port,
        username: jump.username.clone(),
        auth_type: jump.auth_type.clone(),
        password: jump.password.clone(),
        private_key_path: jump.private_key_path.clone(),
        passphrase: jump.passphrase.clone(),
        jump_host: None,
    }
}

fn relay_jump_channel(mut tcp: TcpStream, mut channel: ssh2::Channel, jump_session: Session) {
    if tcp.set_nonblocking(true).is_err() {
        return;
    }
    let mut tcp_to_ssh = Vec::new();
    let mut ssh_to_tcp = Vec::new();
    let mut buffer = [0_u8; 32 * 1024];
    let mut keepalive_deadline =
        Instant::now() + Duration::from_secs(u64::from(SSH_KEEPALIVE_INTERVAL_SECS));

    loop {
        if poll_ssh_keepalive(&jump_session, &mut keepalive_deadline).is_err() {
            return;
        }
        let mut progressed = false;
        if tcp_to_ssh.is_empty() {
            match tcp.read(&mut buffer) {
                Ok(0) => {
                    let _ = channel.send_eof();
                    let _ = channel.close();
                    return;
                }
                Ok(size) => {
                    tcp_to_ssh.extend_from_slice(&buffer[..size]);
                    progressed = true;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return,
            }
        }
        if !tcp_to_ssh.is_empty() {
            match channel.write(&tcp_to_ssh) {
                Ok(size) => {
                    tcp_to_ssh.drain(..size);
                    progressed = true;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return,
            }
        }
        if ssh_to_tcp.is_empty() {
            match channel.read(&mut buffer) {
                Ok(0) => {
                    let _ = tcp.shutdown(std::net::Shutdown::Write);
                    return;
                }
                Ok(size) => {
                    ssh_to_tcp.extend_from_slice(&buffer[..size]);
                    progressed = true;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return,
            }
        }
        if !ssh_to_tcp.is_empty() {
            match tcp.write(&ssh_to_tcp) {
                Ok(size) => {
                    ssh_to_tcp.drain(..size);
                    progressed = true;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => return,
            }
        }
        if !progressed {
            thread::sleep(Duration::from_millis(2));
        }
    }
}

fn connect_ssh(server: &ServerProfile) -> Result<Session, String> {
    let server = hydrate_server_secrets(server);
    let Some(jump) = server.jump_host.as_ref().filter(|jump| jump.enabled) else {
        return connect_ssh_direct(&server);
    };
    if jump.host.trim().is_empty() {
        return Err("跳板机地址不能为空".to_string());
    }
    let jump_server = jump_as_server(jump, &server.id);
    let jump_session = connect_ssh_direct(&jump_server)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("创建本地跳板通道失败: {error}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|error| format!("读取本地跳板地址失败: {error}"))?;
    let local_client = TcpStream::connect_timeout(&local_addr, Duration::from_secs(3))
        .map_err(|error| format!("初始化本地跳板通道失败: {error}"))?;
    let (local_proxy, _) = listener
        .accept()
        .map_err(|error| format!("接收本地跳板通道失败: {error}"))?;
    let channel = jump_session
        .channel_direct_tcpip(&server.host, server.port, None)
        .map_err(|error| format!("打开跳板机转发通道失败: {error}"))?;
    jump_session.set_keepalive(true, SSH_KEEPALIVE_INTERVAL_SECS);
    jump_session.set_blocking(false);
    local_client
        .set_read_timeout(Some(Duration::from_secs(30)))
        .ok();
    local_client
        .set_write_timeout(Some(Duration::from_secs(30)))
        .ok();
    local_proxy
        .set_read_timeout(Some(Duration::from_secs(30)))
        .ok();
    local_proxy
        .set_write_timeout(Some(Duration::from_secs(30)))
        .ok();
    thread::Builder::new()
        .name("portico-jump-relay".to_string())
        .spawn(move || relay_jump_channel(local_proxy, channel, jump_session))
        .map_err(|error| format!("启动跳板回程线程失败: {error}"))?;

    let mut target_session =
        Session::new().map_err(|error| format!("SSH 会话初始化失败: {error}"))?;
    target_session.set_tcp_stream(local_client);
    target_session
        .handshake()
        .map_err(|error| format!("内网目标 SSH 握手失败: {error}"))?;
    verify_known_host(&target_session, &server)?;
    authenticate_session(&mut target_session, &server)?;
    Ok(target_session)
}

#[tauri::command]
fn store_server_secret(
    server_id: String,
    password: Option<String>,
    passphrase: Option<String>,
    jump_password: Option<String>,
    jump_passphrase: Option<String>,
) -> Result<(), String> {
    if let Some(password) = password.filter(|value| !value.is_empty()) {
        keyring_entry(&format!("server:{server_id}:password"))?
            .set_password(&password)
            .map_err(|error| format!("保存服务器密码失败: {error}"))?;
    }
    if let Some(passphrase) = passphrase.filter(|value| !value.is_empty()) {
        keyring_entry(&format!("server:{server_id}:passphrase"))?
            .set_password(&passphrase)
            .map_err(|error| format!("保存私钥口令失败: {error}"))?;
    }
    if let Some(password) = jump_password.filter(|value| !value.is_empty()) {
        keyring_entry(&format!("server:{server_id}:jump:password"))?
            .set_password(&password)
            .map_err(|error| format!("保存跳板机密码失败: {error}"))?;
    }
    if let Some(passphrase) = jump_passphrase.filter(|value| !value.is_empty()) {
        keyring_entry(&format!("server:{server_id}:jump:passphrase"))?
            .set_password(&passphrase)
            .map_err(|error| format!("保存跳板机口令失败: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_server_secret(server_id: String) -> Result<(), String> {
    for suffix in ["password", "passphrase", "jump:password", "jump:passphrase"] {
        if let Ok(entry) = keyring_entry(&format!("server:{server_id}:{suffix}")) {
            entry.delete_credential().ok();
        }
    }
    Ok(())
}

#[tauri::command]
fn store_ai_key(api_key: String) -> Result<(), String> {
    keyring_entry("ai:api-key")?
        .set_password(&api_key)
        .map_err(|error| format!("保存 AI API Key 失败: {error}"))
}

fn delete_ai_key_from_keyring(account: &str) -> Result<(), String> {
    match keyring_entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除 AI API Key 失败: {error}")),
    }
}

#[tauri::command]
fn delete_ai_key() -> Result<(), String> {
    delete_ai_key_from_keyring("ai:api-key")
}

fn mode_string(mode: Option<u32>, is_dir: bool) -> String {
    let mode = mode.unwrap_or(0);
    let mut value = String::with_capacity(10);
    value.push(if is_dir { 'd' } else { '-' });
    for shift in [6, 3, 0] {
        value.push(if mode & (0o4 << shift) != 0 { 'r' } else { '-' });
        value.push(if mode & (0o2 << shift) != 0 { 'w' } else { '-' });
        value.push(if mode & (0o1 << shift) != 0 { 'x' } else { '-' });
    }
    value
}

fn run_command_sync(server: &ServerProfile, command: &str) -> Result<CommandResult, String> {
    let session = connect_ssh(server)?;
    let mut channel = session
        .channel_session()
        .map_err(|error| format!("无法创建命令通道: {error}"))?;
    channel
        .exec(command)
        .map_err(|error| format!("命令启动失败: {error}"))?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    channel
        .read_to_string(&mut stdout)
        .map_err(|error| format!("读取标准输出失败: {error}"))?;
    channel
        .stderr()
        .read_to_string(&mut stderr)
        .map_err(|error| format!("读取错误输出失败: {error}"))?;
    channel.wait_close().ok();
    let exit_code = channel.exit_status().unwrap_or(-1);
    Ok(CommandResult {
        stdout,
        stderr,
        exit_code,
    })
}

fn successful_output(result: CommandResult, label: &str) -> Result<String, String> {
    if result.exit_code == 0 {
        return Ok(result.stdout);
    }
    let detail = result.stderr.trim();
    Err(if detail.is_empty() {
        format!("{label}失败，退出码 {}", result.exit_code)
    } else {
        format!("{label}失败: {detail}")
    })
}

fn parse_processes(output: &str) -> Vec<ProcessInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let user = fields.next()?.to_string();
            let command = fields.next()?.to_string();
            let memory_percent = fields.next()?.parse().unwrap_or(0.0);
            let cpu_percent = fields.next()?.parse().unwrap_or(0.0);
            let elapsed_seconds = fields.next()?.parse().unwrap_or(0);
            let arguments = fields.collect::<Vec<_>>().join(" ");
            Some(ProcessInfo {
                pid,
                user,
                command: command.clone(),
                memory_percent,
                cpu_percent,
                elapsed_seconds,
                arguments: if arguments.is_empty() {
                    command
                } else {
                    arguments
                },
            })
        })
        .collect()
}

fn split_socket_endpoint(value: &str) -> (String, Option<u16>) {
    if let Some(stripped) = value.strip_prefix('[') {
        if let Some((address, port)) = stripped.rsplit_once("]:") {
            return (address.to_string(), port.parse().ok());
        }
    }
    value
        .rsplit_once(':')
        .map(|(address, port)| (address.to_string(), port.parse().ok()))
        .unwrap_or_else(|| (value.to_string(), None))
}

fn parse_socket_owner(details: &str) -> (Option<u32>, Option<String>) {
    let pid = details
        .split("pid=")
        .nth(1)
        .and_then(|value| {
            value
                .split(|character: char| !character.is_ascii_digit())
                .next()
        })
        .and_then(|value| value.parse().ok());
    let process = details
        .split('"')
        .nth(1)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    (pid, process)
}

fn parse_network_connections(output: &str) -> Vec<NetworkConnection> {
    output
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            if fields.len() < 6 {
                return None;
            }
            let (local_address, local_port) = split_socket_endpoint(fields[4]);
            let (remote_address, remote_port) = split_socket_endpoint(fields[5]);
            let (pid, process) = parse_socket_owner(&fields[6..].join(" "));
            Some(NetworkConnection {
                protocol: fields[0].to_uppercase(),
                state: fields[1].to_uppercase(),
                local_address,
                local_port,
                remote_address,
                remote_port,
                pid,
                process,
            })
        })
        .collect()
}

fn parse_network_interfaces(output: &str) -> Vec<NetworkInterface> {
    let (links_output, addresses_output) = output.split_once("--ADDR--").unwrap_or((output, ""));
    let links = links_output
        .lines()
        .filter_map(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            let raw_name = fields.get(1)?.trim_end_matches(':');
            let name = raw_name.split('@').next()?.to_string();
            let value_after = |key: &str| {
                fields
                    .iter()
                    .position(|field| *field == key)
                    .and_then(|index| fields.get(index + 1))
                    .copied()
            };
            let state = value_after("state").unwrap_or("UNKNOWN").to_string();
            let mtu = value_after("mtu")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            let mac = fields
                .iter()
                .position(|field| field.starts_with("link/"))
                .and_then(|index| fields.get(index + 1))
                .copied()
                .unwrap_or("-")
                .to_string();
            Some((name, state, mac, mtu))
        })
        .collect::<Vec<_>>();

    let mut addresses: HashMap<String, Vec<(String, String, Option<u8>)>> = HashMap::new();
    for line in addresses_output.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 4 || !matches!(fields[2], "inet" | "inet6") {
            continue;
        }
        let name = fields[1].split('@').next().unwrap_or(fields[1]).to_string();
        let (address, prefix_length) = fields[3]
            .rsplit_once('/')
            .map(|(address, prefix)| (address.to_string(), prefix.parse().ok()))
            .unwrap_or_else(|| (fields[3].to_string(), None));
        addresses
            .entry(name)
            .or_default()
            .push((fields[2].to_uppercase(), address, prefix_length));
    }

    let mut result = Vec::new();
    for (name, state, mac, mtu) in links {
        match addresses.remove(&name) {
            Some(items) if !items.is_empty() => {
                result.extend(items.into_iter().map(|(family, address, prefix_length)| {
                    NetworkInterface {
                        name: name.clone(),
                        family,
                        address,
                        prefix_length,
                        state: state.clone(),
                        mac: mac.clone(),
                        mtu,
                    }
                }));
            }
            _ => result.push(NetworkInterface {
                name,
                family: "-".to_string(),
                address: "-".to_string(),
                prefix_length: None,
                state,
                mac,
                mtu,
            }),
        }
    }
    result
}

#[tauri::command]
async fn list_processes(server: ServerProfile) -> Result<Vec<ProcessInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_command_sync(
            &server,
            "LC_ALL=C ps -eo pid=,user=,comm=,%mem=,%cpu=,etimes=,args= --sort=-%cpu",
        )?;
        Ok(parse_processes(&successful_output(result, "读取进程列表")?))
    })
    .await
    .map_err(|error| format!("进程查询任务失败: {error}"))?
}

#[tauri::command]
async fn signal_process(server: ServerProfile, pid: u32, signal: String) -> Result<(), String> {
    if pid <= 1 {
        return Err("禁止结束 PID 0 或 1".to_string());
    }
    let signal = match signal.as_str() {
        "TERM" => "TERM",
        "KILL" => "KILL",
        _ => return Err("仅支持 TERM 或 KILL 信号".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_command_sync(&server, &format!("kill -{signal} {pid}"))?;
        successful_output(result, "发送进程信号").map(|_| ())
    })
    .await
    .map_err(|error| format!("进程信号任务失败: {error}"))?
}

#[tauri::command]
async fn list_network_connections(server: ServerProfile) -> Result<Vec<NetworkConnection>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_command_sync(&server, "LC_ALL=C ss -H -tunap")?;
        Ok(parse_network_connections(&successful_output(
            result,
            "读取网络连接",
        )?))
    })
    .await
    .map_err(|error| format!("网络查询任务失败: {error}"))?
}

#[tauri::command]
async fn list_network_interfaces(server: ServerProfile) -> Result<Vec<NetworkInterface>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_command_sync(
            &server,
            "LC_ALL=C ip -o link show; printf '\\n--ADDR--\\n'; LC_ALL=C ip -o addr show",
        )?;
        Ok(parse_network_interfaces(&successful_output(
            result,
            "读取网卡信息",
        )?))
    })
    .await
    .map_err(|error| format!("网卡查询任务失败: {error}"))?
}

#[tauri::command]
async fn start_terminal(
    app: tauri::AppHandle,
    manager: State<'_, TerminalManager>,
    session_id: String,
    server: ServerProfile,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    if manager
        .terminals
        .lock()
        .map_err(|_| "终端状态锁已损坏")?
        .contains_key(&session_id)
    {
        return Ok(());
    }

    let session = tauri::async_runtime::spawn_blocking(move || connect_ssh(&server))
        .await
        .map_err(|error| format!("连接任务失败: {error}"))??;
    let (sender, receiver) = mpsc::channel::<TerminalRequest>();
    manager
        .terminals
        .lock()
        .map_err(|_| "终端状态锁已损坏")?
        .insert(session_id.clone(), sender);

    thread::spawn(move || {
        let event_name = format!("terminal-output-{session_id}");
        let result = (|| -> Result<(), String> {
            let mut channel = session
                .channel_session()
                .map_err(|error| format!("无法创建终端通道: {error}"))?;
            channel
                .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
                .map_err(|error| format!("PTY 请求失败: {error}"))?;
            channel
                .shell()
                .map_err(|error| format!("Shell 启动失败: {error}"))?;
            session.set_keepalive(true, SSH_KEEPALIVE_INTERVAL_SECS);
            session.set_blocking(false);
            let mut buffer = [0_u8; 16 * 1024];
            let mut keepalive_deadline =
                Instant::now() + Duration::from_secs(u64::from(SSH_KEEPALIVE_INTERVAL_SECS));

            loop {
                poll_ssh_keepalive(&session, &mut keepalive_deadline)?;
                while let Ok(request) = receiver.try_recv() {
                    match request {
                        TerminalRequest::Input(bytes) => {
                            channel
                                .write_all(&bytes)
                                .map_err(|error| format!("终端写入失败: {error}"))?;
                            channel.flush().ok();
                        }
                        TerminalRequest::Resize(next_cols, next_rows) => {
                            channel
                                .request_pty_size(next_cols, next_rows, None, None)
                                .map_err(|error| format!("终端尺寸更新失败: {error}"))?;
                        }
                        TerminalRequest::Stop => {
                            channel.close().ok();
                            return Ok(());
                        }
                    }
                }

                match channel.read(&mut buffer) {
                    Ok(0) if channel.eof() => return Ok(()),
                    Ok(0) => thread::sleep(Duration::from_millis(8)),
                    Ok(read) => {
                        let output = String::from_utf8_lossy(&buffer[..read]).into_owned();
                        app.emit(&event_name, output).ok();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(8));
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
        })();

        if let Err(error) = result {
            app.emit(&event_name, format!("\r\n\x1b[31m{error}\x1b[0m\r\n"))
                .ok();
        }
    });
    Ok(())
}

#[tauri::command]
fn terminal_input(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let terminals = manager.terminals.lock().map_err(|_| "终端状态锁已损坏")?;
    terminals
        .get(&session_id)
        .ok_or_else(|| "终端会话不存在".to_string())?
        .send(TerminalRequest::Input(data.into_bytes()))
        .map_err(|_| "终端会话已经关闭".to_string())
}

#[tauri::command]
fn terminal_resize(
    manager: State<'_, TerminalManager>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let terminals = manager.terminals.lock().map_err(|_| "终端状态锁已损坏")?;
    if let Some(sender) = terminals.get(&session_id) {
        sender
            .send(TerminalRequest::Resize(cols, rows))
            .map_err(|_| "终端会话已经关闭".to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn stop_terminal(manager: State<'_, TerminalManager>, session_id: String) -> Result<(), String> {
    if let Some(sender) = manager
        .terminals
        .lock()
        .map_err(|_| "终端状态锁已损坏")?
        .remove(&session_id)
    {
        sender.send(TerminalRequest::Stop).ok();
    }
    Ok(())
}

#[tauri::command]
async fn list_directory(server: ServerProfile, path: String) -> Result<Vec<RemoteFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&server)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("SFTP 初始化失败: {error}"))?;
        let mut entries = sftp
            .readdir(Path::new(&path))
            .map_err(|error| format!("读取目录失败: {error}"))?
            .into_iter()
            .filter_map(|(entry_path, stat)| {
                let name = entry_path.file_name()?.to_string_lossy().into_owned();
                if name == "." || name == ".." {
                    return None;
                }
                let is_dir = stat.perm.unwrap_or(0) & 0o170000 == 0o040000;
                Some(RemoteFile {
                    path: entry_path.to_string_lossy().replace('\\', "/"),
                    name,
                    is_dir,
                    size: stat.size.unwrap_or(0),
                    permissions: mode_string(stat.perm, is_dir),
                    modified: stat.mtime,
                })
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            right
                .is_dir
                .cmp(&left.is_dir)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
    })
    .await
    .map_err(|error| format!("SFTP 任务失败: {error}"))?
}

const TRANSFER_CHUNK_SIZE: usize = 64 * 1024;
const TRANSFER_PROGRESS_EVENT: &str = "transfer-progress";
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgressEvent {
    transfer_id: String,
    transferred_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
}

struct TransferProgressReporter {
    app: AppHandle,
    transfer_id: String,
    total_bytes: Option<u64>,
    last_emitted_at: Instant,
    last_emitted_bytes: u64,
}

impl TransferProgressReporter {
    fn new(app: AppHandle, transfer_id: String, total_bytes: Option<u64>) -> Self {
        let mut reporter = Self {
            app,
            transfer_id,
            total_bytes,
            last_emitted_at: Instant::now(),
            last_emitted_bytes: 0,
        };
        reporter.report(0, true);
        reporter
    }

    fn report(&mut self, transferred_bytes: u64, force: bool) {
        let transferred_bytes = self
            .total_bytes
            .map(|total_bytes| transferred_bytes.min(total_bytes))
            .unwrap_or(transferred_bytes);
        if !force
            && (transferred_bytes == self.last_emitted_bytes
                || self.last_emitted_at.elapsed() < TRANSFER_PROGRESS_INTERVAL)
        {
            return;
        }
        self.app
            .emit(
                TRANSFER_PROGRESS_EVENT,
                TransferProgressEvent {
                    transfer_id: self.transfer_id.clone(),
                    transferred_bytes,
                    total_bytes: self.total_bytes,
                },
            )
            .ok();
        self.last_emitted_at = Instant::now();
        self.last_emitted_bytes = transferred_bytes;
    }
}

struct TransferProgressWriter<W> {
    inner: W,
    reporter: Option<TransferProgressReporter>,
    transferred_bytes: u64,
}

impl<W> TransferProgressWriter<W> {
    fn new(inner: W, reporter: Option<TransferProgressReporter>) -> Self {
        Self {
            inner,
            reporter,
            transferred_bytes: 0,
        }
    }
}

impl<W: Write> Write for TransferProgressWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.transferred_bytes = self.transferred_bytes.saturating_add(written as u64);
        if let Some(reporter) = self.reporter.as_mut() {
            reporter.report(self.transferred_bytes, false);
        }
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()?;
        if let Some(reporter) = self.reporter.as_mut() {
            reporter.report(self.transferred_bytes, true);
        }
        Ok(())
    }
}

fn transfer_suffix(transfer_id: Option<&str>) -> String {
    let candidate = transfer_id
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_string()
        });
    let suffix = candidate
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(64)
        .collect::<String>();
    if suffix.is_empty() {
        "transfer".to_string()
    } else {
        suffix
    }
}

fn remote_transfer_temp_path(remote_path: &str, suffix: &str) -> Result<String, String> {
    let (parent, name) = remote_parent_and_name(remote_path)?;
    Ok(format!("{parent}/.{name}.portico-partial-{suffix}"))
}

fn local_transfer_temp_path(local_path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}.portico-partial-{suffix}", local_path.display()))
}

fn replace_local_file(temp_path: &Path, destination: &Path, suffix: &str) -> Result<(), String> {
    let backup_path = PathBuf::from(format!("{}.portico-backup-{suffix}", destination.display()));
    let had_existing = destination.exists();
    if had_existing {
        fs::rename(destination, &backup_path)
            .map_err(|error| format!("备份原有下载文件失败: {error}"))?;
    }

    match fs::rename(temp_path, destination) {
        Ok(()) => {
            if had_existing {
                fs::remove_file(&backup_path).ok();
            }
            Ok(())
        }
        Err(error) => {
            if had_existing {
                fs::rename(&backup_path, destination).ok();
            }
            Err(format!("替换下载文件失败: {error}"))
        }
    }
}

fn copy_transfer_bytes<R: Read, W: Write>(
    source: &mut R,
    target: &mut W,
    control: Option<&TransferControl>,
    read_error: &str,
    write_error: &str,
) -> Result<(), String> {
    let mut buffer = [0u8; TRANSFER_CHUNK_SIZE];
    loop {
        if let Some(control) = control {
            control.wait_until_running()?;
        }
        let read = source
            .read(&mut buffer)
            .map_err(|error| format!("{read_error}: {error}"))?;
        if read == 0 {
            break;
        }

        let mut written = 0;
        while written < read {
            if let Some(control) = control {
                control.wait_until_running()?;
            }
            let count = target
                .write(&buffer[written..read])
                .map_err(|error| format!("{write_error}: {error}"))?;
            if count == 0 {
                return Err(format!("{write_error}: 写入 0 字节"));
            }
            written += count;
        }
    }
    target
        .flush()
        .map_err(|error| format!("{write_error}: {error}"))?;
    Ok(())
}

async fn upload_file_impl(
    server: ServerProfile,
    local_path: String,
    remote_path: String,
    control: Option<Arc<TransferControl>>,
    transfer_id: Option<String>,
    progress_app: Option<AppHandle>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let suffix = transfer_suffix(transfer_id.as_deref());
        let temp_path = remote_transfer_temp_path(&remote_path, &suffix)?;
        let session = connect_ssh(&server)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("SFTP 初始化失败: {error}"))?;
        let result = (|| -> Result<(), String> {
            let mut source =
                File::open(&local_path).map_err(|error| format!("打开本地文件失败: {error}"))?;
            let total_bytes = source
                .metadata()
                .map_err(|error| format!("读取本地文件大小失败: {error}"))?
                .len();
            let target = sftp
                .create(Path::new(&temp_path))
                .map_err(|error| format!("创建远程临时文件失败: {error}"))?;
            let reporter = match (progress_app.clone(), transfer_id.clone()) {
                (Some(app), Some(transfer_id)) => Some(TransferProgressReporter::new(
                    app,
                    transfer_id,
                    Some(total_bytes),
                )),
                _ => None,
            };
            let mut target = TransferProgressWriter::new(target, reporter);
            copy_transfer_bytes(
                &mut source,
                &mut target,
                control.as_deref(),
                "读取本地文件失败",
                "上传失败",
            )?;
            if let Some(control) = control.as_deref() {
                control.wait_until_running()?;
            }
            drop(target);
            sftp.rename(
                Path::new(&temp_path),
                Path::new(&remote_path),
                Some(RenameFlags::OVERWRITE),
            )
            .map_err(|error| format!("提交远程文件失败: {error}"))
        })();
        if result.is_err() {
            sftp.unlink(Path::new(&temp_path)).ok();
        }
        result
    })
    .await
    .map_err(|error| format!("上传任务失败: {error}"))?
}

async fn download_file_impl(
    server: ServerProfile,
    remote_path: String,
    local_path: String,
    control: Option<Arc<TransferControl>>,
    transfer_id: Option<String>,
    progress_app: Option<AppHandle>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let suffix = transfer_suffix(transfer_id.as_deref());
        let destination = PathBuf::from(&local_path);
        let temp_path = local_transfer_temp_path(&destination, &suffix);
        let session = connect_ssh(&server)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("SFTP 初始化失败: {error}"))?;
        let result = (|| -> Result<(), String> {
            let total_bytes = sftp
                .stat(Path::new(&remote_path))
                .ok()
                .and_then(|attributes| attributes.size);
            let mut source = sftp
                .open(Path::new(&remote_path))
                .map_err(|error| format!("打开远程文件失败: {error}"))?;
            let target = File::create(&temp_path)
                .map_err(|error| format!("创建本地临时文件失败: {error}"))?;
            let reporter = match (progress_app.clone(), transfer_id.clone()) {
                (Some(app), Some(transfer_id)) => {
                    Some(TransferProgressReporter::new(app, transfer_id, total_bytes))
                }
                _ => None,
            };
            let mut target = TransferProgressWriter::new(target, reporter);
            copy_transfer_bytes(
                &mut source,
                &mut target,
                control.as_deref(),
                "下载失败",
                "下载失败",
            )?;
            if let Some(control) = control.as_deref() {
                control.wait_until_running()?;
            }
            drop(target);
            replace_local_file(&temp_path, &destination, &suffix)
        })();
        if result.is_err() {
            fs::remove_file(&temp_path).ok();
        }
        result
    })
    .await
    .map_err(|error| format!("下载任务失败: {error}"))?
}

#[tauri::command]
async fn upload_file(
    server: ServerProfile,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    upload_file_impl(server, local_path, remote_path, None, None, None).await
}

const MAX_AI_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiUploadedAttachment {
    remote_path: String,
    size: u64,
}

fn sanitize_ai_attachment_component(value: &str, fallback: &str, max_chars: usize) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(max_chars)
        .collect::<String>();
    let sanitized = sanitized.trim_matches(['.', '_']).to_string();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn sanitize_ai_attachment_name(name: &str) -> String {
    let basename = name
        .rsplit(|character| matches!(character, '/' | '\\'))
        .next()
        .unwrap_or(name);
    sanitize_ai_attachment_component(basename, "attachment.bin", 96)
}

fn ai_attachment_temp_directory(username: &str) -> String {
    format!(
        "/tmp/portico-ai-{}",
        sanitize_ai_attachment_component(username, "user", 48)
    )
}

fn ensure_ai_attachment_temp_directory(sftp: &Sftp, directory: &str) -> Result<(), String> {
    let path = Path::new(directory);
    if sftp.stat(path).is_ok() {
        return Ok(());
    }
    if let Err(error) = sftp.mkdir(path, 0o700) {
        if sftp.stat(path).is_err() {
            return Err(format!("创建远程附件临时目录失败: {error}"));
        }
    }
    Ok(())
}

#[tauri::command]
async fn upload_ai_attachment(
    server: ServerProfile,
    attachment_id: String,
    name: String,
    content_base64: String,
) -> Result<AiUploadedAttachment, String> {
    let max_encoded_length = MAX_AI_ATTACHMENT_BYTES * 4 / 3 + 8;
    if content_base64.len() > max_encoded_length {
        return Err(format!(
            "附件不能超过 {} MiB",
            MAX_AI_ATTACHMENT_BYTES / 1024 / 1024
        ));
    }
    let content = BASE64_STANDARD
        .decode(content_base64)
        .map_err(|error| format!("附件数据不是有效的 Base64: {error}"))?;
    if content.len() > MAX_AI_ATTACHMENT_BYTES {
        return Err(format!(
            "附件不能超过 {} MiB",
            MAX_AI_ATTACHMENT_BYTES / 1024 / 1024
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&server)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("SFTP 初始化失败: {error}"))?;
        let directory = ai_attachment_temp_directory(&server.username);
        ensure_ai_attachment_temp_directory(&sftp, &directory)?;
        let suffix = transfer_suffix(Some(&attachment_id));
        let remote_path = format!(
            "{directory}/{suffix}-{}",
            sanitize_ai_attachment_name(&name)
        );
        let result = (|| -> Result<(), String> {
            let mut target = sftp
                .open_mode(
                    Path::new(&remote_path),
                    OpenFlags::WRITE | OpenFlags::EXCLUSIVE,
                    0o600,
                    OpenType::File,
                )
                .map_err(|error| format!("创建远程附件失败: {error}"))?;
            target
                .write_all(&content)
                .map_err(|error| format!("上传附件失败: {error}"))?;
            target
                .flush()
                .map_err(|error| format!("提交远程附件失败: {error}"))
        })();
        if result.is_err() {
            sftp.unlink(Path::new(&remote_path)).ok();
        }
        result?;
        Ok(AiUploadedAttachment {
            remote_path,
            size: content.len() as u64,
        })
    })
    .await
    .map_err(|error| format!("附件上传任务失败: {error}"))?
}

#[tauri::command]
async fn download_file(
    server: ServerProfile,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    download_file_impl(server, remote_path, local_path, None, None, None).await
}

#[tauri::command]
async fn start_upload_file(
    server: ServerProfile,
    local_path: String,
    remote_path: String,
    transfer_id: String,
    state: State<'_, TransferManager>,
    app: AppHandle,
) -> Result<(), String> {
    let control = state.register(&transfer_id)?;
    let result = upload_file_impl(
        server,
        local_path,
        remote_path,
        Some(control),
        Some(transfer_id.clone()),
        Some(app),
    )
    .await;
    state.remove(&transfer_id);
    result
}

#[tauri::command]
async fn start_download_file(
    server: ServerProfile,
    remote_path: String,
    local_path: String,
    transfer_id: String,
    state: State<'_, TransferManager>,
    app: AppHandle,
) -> Result<(), String> {
    let control = state.register(&transfer_id)?;
    let result = download_file_impl(
        server,
        remote_path,
        local_path,
        Some(control),
        Some(transfer_id.clone()),
        Some(app),
    )
    .await;
    state.remove(&transfer_id);
    result
}

#[tauri::command]
fn pause_transfer(transfer_id: String, state: State<'_, TransferManager>) -> Result<(), String> {
    state.get(&transfer_id)?.pause();
    Ok(())
}

#[tauri::command]
fn resume_transfer(transfer_id: String, state: State<'_, TransferManager>) -> Result<(), String> {
    state.get(&transfer_id)?.resume();
    Ok(())
}

#[tauri::command]
fn cancel_transfer(transfer_id: String, state: State<'_, TransferManager>) -> Result<(), String> {
    state.get(&transfer_id)?.cancel();
    Ok(())
}

const MAX_VSCODE_FILE_SIZE: u64 = 20 * 1024 * 1024;

fn common_text_file_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    let exact_names = [
        ".babelrc",
        ".bashrc",
        ".browserslistrc",
        ".dockerignore",
        ".editorconfig",
        ".gitattributes",
        ".gitignore",
        ".npmignore",
        ".npmrc",
        ".prettierrc",
        ".profile",
        ".stylelintrc",
        ".vimrc",
        ".wgetrc",
        ".zshrc",
        "cmakelists.txt",
        "dockerfile",
        "fstab",
        "gemfile",
        "hosts",
        "justfile",
        "license",
        "makefile",
        "procfile",
        "rakefile",
        "readme",
    ];
    if exact_names.iter().any(|item| *item == lower)
        || lower == ".env"
        || lower.starts_with(".env.")
    {
        return true;
    }
    let Some(extension) = Path::new(&lower)
        .extension()
        .and_then(|value| value.to_str())
    else {
        return false;
    };
    matches!(
        extension,
        "astro"
            | "bash"
            | "bat"
            | "c"
            | "cc"
            | "cfg"
            | "cjs"
            | "cmake"
            | "cmd"
            | "conf"
            | "cpp"
            | "css"
            | "csv"
            | "dockerignore"
            | "editorconfig"
            | "env"
            | "fish"
            | "gitattributes"
            | "gitignore"
            | "go"
            | "gql"
            | "graphql"
            | "h"
            | "hpp"
            | "htm"
            | "html"
            | "ini"
            | "java"
            | "js"
            | "json"
            | "jsonc"
            | "jsx"
            | "kt"
            | "kts"
            | "less"
            | "log"
            | "lua"
            | "markdown"
            | "md"
            | "mjs"
            | "path"
            | "php"
            | "properties"
            | "ps1"
            | "py"
            | "rb"
            | "rs"
            | "sass"
            | "scss"
            | "service"
            | "sh"
            | "socket"
            | "sql"
            | "svelte"
            | "swift"
            | "target"
            | "timer"
            | "toml"
            | "ts"
            | "tsx"
            | "txt"
            | "vue"
            | "xml"
            | "yaml"
            | "yml"
            | "zsh"
    )
}

fn local_editor_name(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let trimmed =
        sanitized.trim_end_matches(|character: char| character == ' ' || character == '.');
    if trimmed.is_empty() {
        "remote-file.txt".to_string()
    } else {
        trimmed.to_string()
    }
}

fn editor_local_path(server_id: &str, remote_path: &str) -> PathBuf {
    let mut server_hash = DefaultHasher::new();
    server_id.hash(&mut server_hash);
    let mut path_hash = DefaultHasher::new();
    remote_path.hash(&mut path_hash);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = remote_path
        .rsplit('/')
        .next()
        .map(local_editor_name)
        .unwrap_or_else(|| "remote-file.txt".to_string());
    env::temp_dir()
        .join("portico-ssh-vscode")
        .join(format!("{:016x}", server_hash.finish()))
        .join(format!("{:016x}", path_hash.finish()))
        .join(timestamp.to_string())
        .join(file_name)
}

fn editor_file_revision(path: &Path) -> Result<(u64, SystemTime), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取本地编辑副本失败: {error}"))?;
    let modified = metadata
        .modified()
        .map_err(|error| format!("读取本地修改时间失败: {error}"))?;
    Ok((metadata.len(), modified))
}

fn remote_file_revision(
    sftp: &ssh2::Sftp,
    remote_path: &str,
) -> Result<RemoteFileRevision, String> {
    let stat = sftp
        .stat(Path::new(remote_path))
        .map_err(|error| format!("读取远程文件版本失败: {error}"))?;
    Ok(RemoteFileRevision {
        size: stat.size.unwrap_or(0),
        modified: stat.mtime,
    })
}

fn ensure_remote_revision(
    expected: RemoteFileRevision,
    current: RemoteFileRevision,
) -> Result<(), String> {
    if current == expected {
        Ok(())
    } else {
        Err("远程文件已在编辑期间发生变化，请重新打开后再保存".to_string())
    }
}

fn download_editor_file(
    server: &ServerProfile,
    remote_path: &str,
    local_path: &Path,
) -> Result<RemoteFileRevision, String> {
    let session = connect_ssh(server)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("SFTP 初始化失败: {error}"))?;
    let initial_revision = remote_file_revision(&sftp, remote_path)?;
    if initial_revision.size > MAX_VSCODE_FILE_SIZE {
        return Err(format!(
            "文件超过 VS Code 编辑上限（{} MB）",
            MAX_VSCODE_FILE_SIZE / 1024 / 1024
        ));
    }
    let mut source = sftp
        .open(Path::new(remote_path))
        .map_err(|error| format!("打开远程文件失败: {error}"))?;
    let mut target =
        File::create(local_path).map_err(|error| format!("创建本地编辑副本失败: {error}"))?;
    std::io::copy(&mut source, &mut target)
        .map_err(|error| format!("下载编辑副本失败: {error}"))?;
    target
        .flush()
        .map_err(|error| format!("写入本地编辑副本失败: {error}"))?;
    let downloaded_revision = remote_file_revision(&sftp, remote_path)?;
    ensure_remote_revision(initial_revision, downloaded_revision)?;
    Ok(downloaded_revision)
}

fn editor_remote_temp_path(remote_path: &str) -> Result<String, String> {
    let (parent, name) = remote_parent_and_name(remote_path)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(format!("{parent}/.{name}.portico-vscode-{nonce}"))
}

fn upload_editor_file(
    server: &ServerProfile,
    remote_path: &str,
    local_path: &Path,
    expected_revision: RemoteFileRevision,
) -> Result<RemoteFileRevision, String> {
    let session = connect_ssh(server)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("SFTP 初始化失败: {error}"))?;
    ensure_remote_revision(expected_revision, remote_file_revision(&sftp, remote_path)?)?;
    let temp_path = editor_remote_temp_path(remote_path)?;
    let result = (|| -> Result<RemoteFileRevision, String> {
        let mut source =
            File::open(local_path).map_err(|error| format!("打开本地编辑副本失败: {error}"))?;
        let mut target = sftp
            .create(Path::new(&temp_path))
            .map_err(|error| format!("创建远程编辑临时文件失败: {error}"))?;
        std::io::copy(&mut source, &mut target)
            .map_err(|error| format!("同步文件失败: {error}"))?;
        target
            .flush()
            .map_err(|error| format!("提交远程编辑临时文件失败: {error}"))?;

        let latest_revision = remote_file_revision(&sftp, remote_path)?;
        ensure_remote_revision(expected_revision, latest_revision)?;
        drop(target);
        sftp.rename(
            Path::new(&temp_path),
            Path::new(remote_path),
            Some(RenameFlags::OVERWRITE),
        )
        .map_err(|error| format!("提交远程文件失败: {error}"))?;
        remote_file_revision(&sftp, remote_path)
    })();
    if result.is_err() {
        sftp.unlink(Path::new(&temp_path)).ok();
    }
    result
}

fn vscode_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut add = |path: PathBuf| {
        if !candidates.iter().any(|existing| existing == &path) {
            candidates.push(path);
        }
    };
    if cfg!(windows) {
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            add(PathBuf::from(local_app_data).join("Programs/Microsoft VS Code/Code.exe"));
        }
        if let Some(program_files) = env::var_os("PROGRAMFILES") {
            add(PathBuf::from(program_files).join("Microsoft VS Code/Code.exe"));
        }
        if let Some(program_files_x86) = env::var_os("PROGRAMFILES(X86)") {
            add(PathBuf::from(program_files_x86).join("Microsoft VS Code/Code.exe"));
        }
        if let Ok(output) = Command::new("where.exe").arg("code.cmd").output() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let cli_path = PathBuf::from(line.trim());
                if let Some(root) = cli_path.parent().and_then(Path::parent) {
                    add(root.join("Code.exe"));
                }
            }
        }
    } else {
        add(PathBuf::from(
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        ));
        add(PathBuf::from("code"));
    }
    candidates
}

fn launch_vscode(local_path: &Path, wait: bool) -> Result<Child, String> {
    let mut last_error = String::new();
    for candidate in vscode_candidates() {
        if candidate.is_absolute() && !candidate.is_file() {
            continue;
        }
        let mut command = Command::new(&candidate);
        command.arg("--reuse-window");
        if wait {
            command.arg("--wait");
        }
        match command.arg(local_path).spawn() {
            Ok(child) => return Ok(child),
            Err(error) => last_error = error.to_string(),
        }
    }
    if last_error.is_empty() {
        Err("未找到 VS Code，请先安装并加入系统 PATH".to_string())
    } else {
        Err(format!("启动 VS Code 失败：{last_error}"))
    }
}

fn emit_vscode_status(
    app: &tauri::AppHandle,
    session_id: &str,
    server_id: &str,
    remote_path: &str,
    local_path: &Path,
    status: &str,
    message: impl Into<String>,
) {
    app.emit(
        "vscode-file-sync",
        VscodeSyncEvent {
            session_id: session_id.to_string(),
            server_id: server_id.to_string(),
            remote_path: remote_path.to_string(),
            local_path: local_path.to_string_lossy().into_owned(),
            status: status.to_string(),
            message: message.into(),
        },
    )
    .ok();
}

fn emit_vscode_status_to_sessions(
    app: &tauri::AppHandle,
    session_ids: &Arc<Mutex<HashSet<String>>>,
    server_id: &str,
    remote_path: &str,
    local_path: &Path,
    status: &str,
    message: impl Into<String> + Clone,
) {
    let recipients = session_ids
        .lock()
        .map(|sessions| sessions.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for session_id in recipients {
        emit_vscode_status(
            app,
            &session_id,
            server_id,
            remote_path,
            local_path,
            status,
            message.clone(),
        );
    }
}

fn watch_editor_file(
    app: tauri::AppHandle,
    active: Arc<Mutex<HashMap<String, ActiveEditor>>>,
    key: String,
    session_ids: Arc<Mutex<HashSet<String>>>,
    server: ServerProfile,
    remote_path: String,
    local_path: PathBuf,
    mut process: Child,
    initial_revision: (u64, SystemTime),
    initial_remote_revision: RemoteFileRevision,
) {
    let server_id = server.id.clone();
    let mut last_synced = initial_revision;
    let mut last_remote_revision = initial_remote_revision;
    let mut sync_ok = true;
    let mut sync_blocked = false;
    loop {
        thread::sleep(Duration::from_millis(450));
        let process_exited = match process.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                emit_vscode_status_to_sessions(
                    &app,
                    &session_ids,
                    &server_id,
                    &remote_path,
                    &local_path,
                    "error",
                    format!("VS Code 状态读取失败：{error}"),
                );
                sync_ok = false;
                true
            }
        };
        let current_revision = match editor_file_revision(&local_path) {
            Ok(revision) => revision,
            Err(error) => {
                emit_vscode_status_to_sessions(
                    &app,
                    &session_ids,
                    &server_id,
                    &remote_path,
                    &local_path,
                    "error",
                    error,
                );
                break;
            }
        };
        if current_revision != last_synced && !sync_blocked {
            thread::sleep(Duration::from_millis(260));
            let stable_revision = match editor_file_revision(&local_path) {
                Ok(revision) => revision,
                Err(error) => {
                    emit_vscode_status_to_sessions(
                        &app,
                        &session_ids,
                        &server_id,
                        &remote_path,
                        &local_path,
                        "error",
                        error,
                    );
                    break;
                }
            };
            emit_vscode_status_to_sessions(
                &app,
                &session_ids,
                &server_id,
                &remote_path,
                &local_path,
                "syncing",
                "正在同步保存到远程服务器",
            );
            match upload_editor_file(&server, &remote_path, &local_path, last_remote_revision) {
                Ok(remote_revision) => {
                    last_remote_revision = remote_revision;
                    last_synced = stable_revision;
                    sync_ok = true;
                    emit_vscode_status_to_sessions(
                        &app,
                        &session_ids,
                        &server_id,
                        &remote_path,
                        &local_path,
                        "saved",
                        "已保存到远程服务器",
                    );
                }
                Err(error) => {
                    sync_ok = false;
                    let conflict = error.contains("编辑期间发生变化");
                    emit_vscode_status_to_sessions(
                        &app,
                        &session_ids,
                        &server_id,
                        &remote_path,
                        &local_path,
                        "error",
                        format!("同步失败：{error}"),
                    );
                    if conflict {
                        sync_blocked = true;
                    }
                    if !process_exited {
                        thread::sleep(Duration::from_secs(2));
                    }
                }
            }
        }
        if process_exited {
            if sync_ok && current_revision == last_synced {
                emit_vscode_status_to_sessions(
                    &app,
                    &session_ids,
                    &server_id,
                    &remote_path,
                    &local_path,
                    "closed",
                    "VS Code 已关闭，最后修改已同步",
                );
                fs::remove_file(&local_path).ok();
                if let Some(parent) = local_path.parent() {
                    fs::remove_dir_all(parent).ok();
                }
            } else {
                emit_vscode_status_to_sessions(
                    &app,
                    &session_ids,
                    &server_id,
                    &remote_path,
                    &local_path,
                    "error",
                    format!("同步未完成，本地副本保留在 {}", local_path.display()),
                );
            }
            break;
        }
    }
    active.lock().ok().map(|mut editors| editors.remove(&key));
}

fn open_editor_session(
    app: tauri::AppHandle,
    active: Arc<Mutex<HashMap<String, ActiveEditor>>>,
    session_id: String,
    server: ServerProfile,
    remote_path: String,
) -> Result<VscodeEditSession, String> {
    let file_name = remote_path.rsplit('/').next().unwrap_or_default();
    if !common_text_file_name(file_name) {
        return Err("只有常用文本文件支持 VS Code 编辑".to_string());
    }
    let key = format!("{}:{remote_path}", server.id);
    if let Some(editor) = active
        .lock()
        .map_err(|_| "编辑器状态锁已损坏")?
        .get(&key)
        .cloned()
    {
        launch_vscode(&editor.local_path, false)?;
        editor
            .session_ids
            .lock()
            .map_err(|_| "编辑器会话状态锁已损坏")?
            .insert(session_id.clone());
        emit_vscode_status(
            &app,
            &session_id,
            &server.id,
            &remote_path,
            &editor.local_path,
            "watching",
            "已在 VS Code 中打开",
        );
        return Ok(VscodeEditSession {
            local_path: editor.local_path.to_string_lossy().into_owned(),
        });
    }
    let local_path = editor_local_path(&server.id, &remote_path);
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建本地编辑目录失败: {error}"))?;
    }
    let session_ids = Arc::new(Mutex::new(HashSet::from([session_id.clone()])));
    active.lock().map_err(|_| "编辑器状态锁已损坏")?.insert(
        key.clone(),
        ActiveEditor {
            local_path: local_path.clone(),
            session_ids: Arc::clone(&session_ids),
        },
    );
    let result = (|| {
        let initial_remote_revision = download_editor_file(&server, &remote_path, &local_path)?;
        let initial_revision = editor_file_revision(&local_path)?;
        let process = launch_vscode(&local_path, true)?;
        emit_vscode_status(
            &app,
            &session_id,
            &server.id,
            &remote_path,
            &local_path,
            "watching",
            "VS Code 已打开，保存时自动同步",
        );
        let watcher_app = app.clone();
        let watcher_active = active.clone();
        let watcher_key = key.clone();
        let watcher_session_ids = Arc::clone(&session_ids);
        let watcher_server = server.clone();
        let watcher_remote_path = remote_path.clone();
        let watcher_local_path = local_path.clone();
        thread::spawn(move || {
            watch_editor_file(
                watcher_app,
                watcher_active,
                watcher_key,
                watcher_session_ids,
                watcher_server,
                watcher_remote_path,
                watcher_local_path,
                process,
                initial_revision,
                initial_remote_revision,
            )
        });
        Ok(VscodeEditSession {
            local_path: local_path.to_string_lossy().into_owned(),
        })
    })();
    if result.is_err() {
        active.lock().ok().map(|mut editors| editors.remove(&key));
        fs::remove_file(&local_path).ok();
    }
    result
}

#[tauri::command]
async fn open_remote_file_in_vscode(
    app: tauri::AppHandle,
    editor_manager: State<'_, EditorManager>,
    session_id: String,
    server: ServerProfile,
    remote_path: String,
) -> Result<VscodeEditSession, String> {
    let active = editor_manager.active.clone();
    tauri::async_runtime::spawn_blocking(move || {
        open_editor_session(app, active, session_id, server, remote_path)
    })
    .await
    .map_err(|error| format!("VS Code 编辑任务失败: {error}"))?
}

#[tauri::command]
async fn create_directory(server: ServerProfile, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&server)?;
        session
            .sftp()
            .map_err(|error| format!("SFTP 初始化失败: {error}"))?
            .mkdir(Path::new(&path), 0o755)
            .map_err(|error| format!("创建目录失败: {error}"))
    })
    .await
    .map_err(|error| format!("创建目录任务失败: {error}"))?
}

#[tauri::command]
async fn delete_remote_path(
    server: ServerProfile,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&server)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("SFTP 初始化失败: {error}"))?;
        if is_dir {
            sftp.rmdir(Path::new(&path))
                .map_err(|error| format!("删除目录失败（目录必须为空）: {error}"))
        } else {
            sftp.unlink(Path::new(&path))
                .map_err(|error| format!("删除文件失败: {error}"))
        }
    })
    .await
    .map_err(|error| format!("删除任务失败: {error}"))?
}

#[tauri::command]
async fn rename_remote_path(
    server: ServerProfile,
    source_path: String,
    target_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&server)?;
        session
            .sftp()
            .map_err(|error| format!("SFTP 初始化失败: {error}"))?
            .rename(Path::new(&source_path), Path::new(&target_path), None)
            .map_err(|error| format!("重命名失败: {error}"))
    })
    .await
    .map_err(|error| format!("重命名任务失败: {error}"))?
}

fn remote_parent_and_name(path: &str) -> Result<(&str, &str), String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("根目录不能执行此操作".to_string());
    }
    let separator = trimmed
        .rfind('/')
        .ok_or_else(|| "远程路径必须是绝对路径".to_string())?;
    let parent = if separator == 0 {
        "/"
    } else {
        &trimmed[..separator]
    };
    let name = &trimmed[separator + 1..];
    if name.is_empty() || name == "." || name == ".." {
        return Err("远程路径无效".to_string());
    }
    Ok((parent, name))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[tauri::command]
async fn compress_remote_path(
    server: ServerProfile,
    source_path: String,
    archive_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (source_parent, source_name) = remote_parent_and_name(&source_path)?;
        let (archive_parent, archive_name) = remote_parent_and_name(&archive_path)?;
        if source_parent != archive_parent {
            return Err("压缩文件必须保存在源文件所在目录".to_string());
        }
        if source_name == archive_name {
            return Err("压缩文件不能覆盖源文件".to_string());
        }

        let command = format!(
            "cd -- {} && tar -czf {} -- {}",
            shell_quote(source_parent),
            shell_quote(archive_name),
            shell_quote(source_name),
        );
        let result = run_command_sync(&server, &command)?;
        if result.exit_code == 0 {
            Ok(())
        } else {
            let detail = result.stderr.trim();
            Err(if detail.is_empty() {
                format!("压缩失败，远程 tar 退出码为 {}", result.exit_code)
            } else {
                format!("压缩失败: {detail}")
            })
        }
    })
    .await
    .map_err(|error| format!("压缩任务失败: {error}"))?
}

#[tauri::command]
async fn run_ssh_command(server: ServerProfile, command: String) -> Result<CommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_command_sync(&server, &command))
        .await
        .map_err(|error| format!("命令任务失败: {error}"))?
}

fn risk_reasons(command: &str) -> Vec<String> {
    let normalized = command
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let mut reasons = Vec::new();
    let root_delete = normalized.split([';', '&', '|']).any(|part| {
        let part = part.trim().strip_prefix("sudo ").unwrap_or(part.trim());
        ["rm -rf /", "rm -fr /"].iter().any(|prefix| {
            part == *prefix
                || part.starts_with(&format!("{prefix} "))
                || part.starts_with(&format!("{prefix}*"))
        })
    });
    if root_delete {
        reasons.push("递归删除根目录或根目录下的内容".to_string());
    }
    for (pattern, reason) in [
        ("--no-preserve-root", "绕过 rm 的根目录保护"),
        ("mkfs", "格式化文件系统"),
        ("dd if=", "直接写入块设备"),
        (":(){", "Fork bomb"),
        ("shutdown", "关闭系统"),
        ("reboot", "重启系统"),
        ("init 0", "切换到关机运行级别"),
        ("chmod -r 777 /", "递归放开根目录权限"),
        ("iptables", "修改防火墙规则"),
        ("nft ", "修改 nftables 防火墙规则"),
        ("ufw ", "修改 UFW 防火墙规则"),
        ("firewall-cmd", "修改 firewalld 防火墙规则"),
        ("docker system prune", "清理 Docker 资源"),
        ("docker rm", "删除 Docker 容器"),
        ("kill -9", "强制终止进程"),
        ("kill -kill", "强制终止进程"),
        ("systemctl stop", "停止系统服务"),
        ("systemctl restart", "重启系统服务"),
        ("systemctl disable", "禁用系统服务"),
    ] {
        if normalized.contains(pattern) {
            reasons.push(reason.to_string());
        }
    }
    reasons.sort();
    reasons.dedup();
    reasons
}

fn is_high_risk_command(command: &str) -> bool {
    !risk_reasons(command).is_empty()
}

fn extract_reasoning_summary(content: &str) -> (String, Option<String>) {
    let open = "<reasoning_summary>";
    let close = "</reasoning_summary>";
    let Some(start) = content.find(open) else {
        return (content.trim().to_string(), None);
    };
    let Some(relative_end) = content[start + open.len()..].find(close) else {
        return (content.trim().to_string(), None);
    };
    let end = start + open.len() + relative_end;
    let reasoning = content[start + open.len()..end].trim().to_string();
    let mut cleaned = String::new();
    cleaned.push_str(&content[..start]);
    cleaned.push_str(&content[end + close.len()..]);
    (cleaned.trim().to_string(), Some(reasoning))
}

fn response_output_text(payload: &Value) -> Option<String> {
    if let Some(output_text) = payload
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(output_text.to_string());
    }
    let parts = payload
        .get("output")
        .and_then(Value::as_array)?
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter_map(|part| {
            part.get("text")
                .or_else(|| part.get("refusal"))
                .and_then(Value::as_str)
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join(""))
}

fn apply_response_object(response: &Value, completion: &mut AiStreamCompletion) -> AiStreamDelta {
    if let Some(response_id) = response
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        completion.response_id = Some(response_id.to_string());
    }
    if let Some(usage) = AiTokenUsage::from_payload(response) {
        completion.usage = usage;
    }
    if let Some(output) = response.get("output").and_then(Value::as_array) {
        for (output_index, item) in output.iter().enumerate() {
            completion.apply_response_output_item(output_index, item);
        }
    }
    let content = if completion.content.is_empty() {
        response_output_text(response)
    } else {
        None
    };
    if let Some(value) = &content {
        completion.content.push_str(value);
    }
    AiStreamDelta {
        event_type: "message_delta".to_string(),
        content,
        ..AiStreamDelta::default()
    }
}

fn apply_ai_stream_payload(
    data: &str,
    completion: &mut AiStreamCompletion,
) -> Result<AiStreamDelta, String> {
    if data == "[DONE]" {
        return Ok(AiStreamDelta::default());
    }
    let payload: Value =
        serde_json::from_str(data).map_err(|error| format!("AI 流式响应解析失败: {error}"))?;
    if payload.get("type").and_then(Value::as_str) == Some("error") {
        let detail = payload
            .get("message")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("未知流式接口错误");
        return Err(format!("AI 接口返回错误: {detail}"));
    }
    if let Some(detail) = payload
        .pointer("/error/message")
        .or_else(|| payload.pointer("/response/error/message"))
        .and_then(Value::as_str)
    {
        return Err(format!("AI 接口返回错误: {detail}"));
    }
    if let Some(usage) = AiTokenUsage::from_payload(&payload)
        .or_else(|| payload.get("response").and_then(AiTokenUsage::from_payload))
    {
        completion.usage = usage;
    }
    if let Some(response_id) = payload
        .get("response_id")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/response/id").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
    {
        completion.response_id = Some(response_id.to_string());
    }

    match payload.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta" | "response.refusal.delta") => {
            let content = payload
                .get("delta")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            if let Some(value) = &content {
                completion.content.push_str(value);
            }
            return Ok(AiStreamDelta {
                event_type: "message_delta".to_string(),
                content,
                ..AiStreamDelta::default()
            });
        }
        Some("response.reasoning_summary_text.delta") => {
            let reasoning = payload
                .get("delta")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            if let Some(value) = &reasoning {
                completion.reasoning.push_str(value);
            }
            return Ok(AiStreamDelta {
                event_type: "message_delta".to_string(),
                reasoning,
                ..AiStreamDelta::default()
            });
        }
        Some("response.output_item.added" | "response.output_item.done") => {
            if let (Some(output_index), Some(item)) = (
                payload
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
                payload.get("item"),
            ) {
                completion.apply_response_output_item(output_index, item);
            }
            return Ok(AiStreamDelta::default());
        }
        Some("response.function_call_arguments.delta") => {
            if let Some(output_index) = payload
                .get("output_index")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
            {
                if let Some(arguments) = payload.get("delta").and_then(Value::as_str) {
                    completion
                        .tool_call_mut(output_index)
                        .arguments
                        .push_str(arguments);
                }
            }
            return Ok(AiStreamDelta::default());
        }
        Some("response.function_call_arguments.done") => {
            if let Some(output_index) = payload
                .get("output_index")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
            {
                if let Some(arguments) = payload.get("arguments").and_then(Value::as_str) {
                    completion.tool_call_mut(output_index).arguments = arguments.to_string();
                }
            }
            return Ok(AiStreamDelta::default());
        }
        Some("response.completed") => {
            return Ok(payload
                .get("response")
                .map(|response| apply_response_object(response, completion))
                .unwrap_or_default());
        }
        Some("response.incomplete") => {
            let reason = payload
                .pointer("/response/incomplete_details/reason")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("unknown");
            return Err(format!("AI 响应未完成: {reason}"));
        }
        Some(event_type) if event_type.starts_with("response.") || event_type == "error" => {
            return Ok(AiStreamDelta::default());
        }
        _ => {}
    }
    if payload.get("object").and_then(Value::as_str) == Some("response") {
        return Ok(apply_response_object(&payload, completion));
    }

    let Some(delta) = payload
        .pointer("/choices/0/delta")
        .or_else(|| payload.pointer("/choices/0/message"))
    else {
        return Ok(AiStreamDelta::default());
    };
    let content = ["content", "refusal"]
        .iter()
        .find_map(|key| delta.get(key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let reasoning = ["reasoning_content", "reasoning", "thinking"]
        .iter()
        .find_map(|key| delta.get(key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if let Some(value) = &content {
        completion.content.push_str(value);
    }
    if let Some(value) = &reasoning {
        completion.reasoning.push_str(value);
    }
    if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
        for (position, tool_call) in tool_calls.iter().enumerate() {
            let index = tool_call
                .get("index")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(position);
            let target = completion.tool_call_mut(index);
            if let Some(id) = tool_call
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                target.id = id.to_string();
            }
            if let Some(name) = tool_call.pointer("/function/name").and_then(Value::as_str) {
                target.name.push_str(name);
            }
            if let Some(arguments) = tool_call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
            {
                target.arguments.push_str(arguments);
            }
        }
    }

    Ok(AiStreamDelta {
        event_type: "message_delta".to_string(),
        content,
        reasoning,
        ..AiStreamDelta::default()
    })
}

fn ai_tool_stream_delta(
    call_id: &str,
    phase: &str,
    tool: &str,
    command: &str,
    output: Option<&str>,
    exit_code: Option<i32>,
) -> AiStreamDelta {
    let updated_at = ai_timestamp_ms();
    let status = match phase {
        "started" => "started",
        "running" => "running",
        "error" => "error",
        "finished" if exit_code.unwrap_or_default() != 0 => "error",
        "finished" => "completed",
        _ => "running",
    };
    AiStreamDelta {
        event_type: "action_update".to_string(),
        tool_call: Some(AiToolStreamUpdate {
            id: call_id.to_string(),
            phase: phase.to_string(),
            status: status.to_string(),
            tool: tool.to_string(),
            command: command.to_string(),
            output: output.map(str::to_string),
            exit_code,
            started_at: (status == "started").then_some(updated_at),
            updated_at,
            completed_at: matches!(status, "completed" | "error").then_some(updated_at),
        }),
        ..AiStreamDelta::default()
    }
}

fn emit_ai_tool_stream_update(
    app: &tauri::AppHandle,
    event_name: &str,
    call_id: &str,
    phase: &str,
    tool: &str,
    command: &str,
    output: Option<&str>,
    exit_code: Option<i32>,
) {
    app.emit(
        event_name,
        ai_tool_stream_delta(call_id, phase, tool, command, output, exit_code),
    )
    .ok();
}

fn process_ai_stream_line(
    line: &[u8],
    completion: &mut AiStreamCompletion,
    app: &tauri::AppHandle,
    event_name: &str,
) -> Result<bool, String> {
    let line = std::str::from_utf8(line)
        .map_err(|error| format!("AI 流式响应不是有效 UTF-8: {error}"))?
        .trim_end_matches(['\r', '\n']);
    let Some(data) = line.strip_prefix("data:") else {
        return Ok(false);
    };
    let delta = apply_ai_stream_payload(data.trim_start(), completion)?;
    if delta.content.is_some() || delta.reasoning.is_some() {
        app.emit(event_name, delta).ok();
    }
    Ok(true)
}

async fn read_ai_stream(
    mut response: reqwest::Response,
    app: &tauri::AppHandle,
    event_name: &str,
) -> Result<AiStreamCompletion, String> {
    let mut completion = AiStreamCompletion::default();
    let mut buffer = Vec::new();
    let mut plain_body = Vec::new();
    let mut saw_sse = false;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("AI 流式响应读取失败: {error}"))?
    {
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let line = buffer.drain(..=end).collect::<Vec<_>>();
            if process_ai_stream_line(&line, &mut completion, app, event_name)? {
                saw_sse = true;
            } else if !line.iter().all(u8::is_ascii_whitespace) && !line.starts_with(b":") {
                plain_body.extend_from_slice(&line);
            }
        }
    }
    if !buffer.is_empty() {
        if process_ai_stream_line(&buffer, &mut completion, app, event_name)? {
            saw_sse = true;
        } else {
            plain_body.extend_from_slice(&buffer);
        }
    }
    if !saw_sse {
        let data = std::str::from_utf8(&plain_body)
            .map_err(|error| format!("AI 响应不是有效 UTF-8: {error}"))?;
        let delta = apply_ai_stream_payload(data.trim(), &mut completion)?;
        if delta.content.is_some() || delta.reasoning.is_some() {
            app.emit(event_name, delta).ok();
        }
    }
    Ok(completion)
}

fn default_true() -> bool {
    true
}

fn default_tool_rounds() -> u32 {
    6
}

fn default_tool_output_chars() -> usize {
    12_000
}

fn default_command_timeout_seconds() -> u32 {
    30
}

fn default_context_window() -> u32 {
    128_000
}

fn default_max_output_tokens() -> u32 {
    4_096
}

fn default_auto_compress() -> bool {
    true
}

fn default_temperature() -> f32 {
    0.2
}

fn ai_endpoint(endpoint: &str, path: &str) -> String {
    let base = endpoint.trim().trim_end_matches('/');
    let base = ["/chat/completions", "/responses"]
        .into_iter()
        .find_map(|suffix| base.strip_suffix(suffix))
        .unwrap_or(base);
    format!("{base}/{path}")
}

fn is_openai_api_endpoint(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| host.eq_ignore_ascii_case("api.openai.com"))
}

fn set_chat_completion_token_limit(body: &mut Value, endpoint: &str, limit: usize) {
    let field = if is_openai_api_endpoint(endpoint) {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    body[field] = json!(limit);
}

fn ai_prompt_cache_key(model: &str, system_prompt: &str, tools: &[Value]) -> String {
    let mut hasher = DefaultHasher::new();
    model.hash(&mut hasher);
    system_prompt.hash(&mut hasher);
    for tool in tools {
        tool.to_string().hash(&mut hasher);
    }
    format!("portico-ssh-{:016x}", hasher.finish())
}

fn apply_chat_completion_tools(body: &mut Value, tools: &[Value]) {
    if tools.is_empty() {
        return;
    }
    body["tools"] = Value::Array(tools.to_vec());
    body["tool_choice"] = json!("auto");
}

fn responses_tool_definitions(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            let function = tool.get("function")?;
            Some(json!({
                "type": "function",
                "name": function.get("name")?.clone(),
                "description": function.get("description").cloned().unwrap_or(Value::Null),
                "parameters": function.get("parameters").cloned().unwrap_or_else(|| json!({})),
                "strict": false
            }))
        })
        .collect()
}

fn responses_stream_body(
    model: &str,
    instructions: &str,
    input: &[Value],
    temperature: f32,
    max_output_tokens: usize,
    tools: &[Value],
) -> Value {
    let mut body = json!({
        "model": model,
        "instructions": instructions,
        "input": input,
        "temperature": temperature,
        "max_output_tokens": max_output_tokens,
        "stream": true,
        "store": false
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.to_vec());
        body["tool_choice"] = json!("auto");
    }
    body
}

fn append_ai_tool_output(
    api_messages: &mut Vec<Value>,
    response_inputs: &mut Vec<Value>,
    api_mode: AiApiMode,
    call_id: &str,
    output: String,
) {
    api_messages.push(json!({
        "role": "tool",
        "tool_call_id": call_id,
        "content": output.clone()
    }));
    if api_mode.is_responses() {
        response_inputs.push(json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": output
        }));
    }
}

fn estimate_tokens(value: &str) -> usize {
    let (ascii, non_ascii) =
        value
            .chars()
            .fold((0usize, 0usize), |(ascii, non_ascii), character| {
                if character.is_ascii() {
                    (ascii + 1, non_ascii)
                } else {
                    (ascii, non_ascii + 1)
                }
            });
    ascii.div_ceil(4) + non_ascii
}

fn input_token_budget(context_window: u32) -> usize {
    let context_window = context_window as usize;
    context_window.saturating_sub((context_window / 4).max(256))
}

fn response_input_cost(item: &Value) -> usize {
    estimate_tokens(&item.to_string()) + 4
}

fn response_request_fixed_cost(instructions: &str, tools: &[Value]) -> usize {
    estimate_tokens(instructions) + tools.iter().map(response_input_cost).sum::<usize>() + 8
}

fn response_request_cost(input: &[Value], instructions: &str, tools: &[Value]) -> usize {
    response_request_fixed_cost(instructions, tools)
        + input.iter().map(response_input_cost).sum::<usize>()
}

fn trim_response_inputs_for_context(
    input: &mut Vec<Value>,
    context_window: u32,
    instructions: &str,
    tools: &[Value],
) -> Result<(), String> {
    let mut remaining = input_token_budget(context_window)
        .checked_sub(response_request_fixed_cost(instructions, tools))
        .ok_or_else(|| {
            "系统提示词或工具定义超过可用上下文，请缩短配置或增大上下文大小".to_string()
        })?;
    let mut groups: Vec<Vec<Value>> = Vec::new();

    for item in input.iter().cloned() {
        let starts_turn = item.get("role").and_then(Value::as_str) == Some("user");
        if groups.is_empty() || starts_turn && groups.last().is_some_and(|group| !group.is_empty())
        {
            groups.push(Vec::new());
        }
        groups.last_mut().expect("input group exists").push(item);
    }

    let mut retained = Vec::new();
    for group in groups.into_iter().rev() {
        let cost = group.iter().map(response_input_cost).sum::<usize>();
        if cost > remaining {
            if retained.is_empty() {
                return Err(
                    "Responses 最近一轮超过可用上下文，请缩短内容或增大上下文大小".to_string(),
                );
            }
            break;
        }
        remaining -= cost;
        retained.push(group);
    }

    retained.reverse();
    input.clear();
    input.extend(retained.into_iter().flatten());
    Ok(())
}

fn response_tool_output_budget(
    input: &[Value],
    context_window: u32,
    instructions: &str,
    tools: &[Value],
    tool_call_id: &str,
    future_tool_call_ids: &[String],
) -> Result<usize, String> {
    let latest_turn_start = input
        .iter()
        .rposition(|item| item.get("role").and_then(Value::as_str) == Some("user"))
        .unwrap_or(0);
    let current_turn_cost = input
        .iter()
        .skip(latest_turn_start)
        .map(response_input_cost)
        .sum::<usize>();
    let tool_envelope_cost = |call_id: &str| {
        response_input_cost(&json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": "exit_code=-2147483648\n"
        }))
    };
    let fixed_cost = response_request_fixed_cost(instructions, tools)
        + current_turn_cost
        + tool_envelope_cost(tool_call_id)
        + future_tool_call_ids
            .iter()
            .map(|call_id| tool_envelope_cost(call_id))
            .sum::<usize>();
    let available = input_token_budget(context_window)
        .checked_sub(fixed_cost)
        .ok_or_else(|| "Responses 工具调用超过可用上下文，请增大上下文大小".to_string())?;
    Ok(available / (future_tool_call_ids.len() + 1))
}

fn compaction_split_index(
    messages: &[AiInputMessage],
    context_window: u32,
    max_output_tokens: u32,
) -> Option<usize> {
    if messages.len() < 2 {
        return None;
    }
    let total_cost = messages.iter().map(ai_input_message_cost).sum::<usize>();
    let effective_window =
        (context_window as usize).saturating_sub((max_output_tokens as usize).min(20_000));
    let reserve = (effective_window / 4).clamp(256, 13_000);
    let trigger = effective_window.saturating_sub(reserve);
    if trigger == 0 || total_cost <= trigger {
        return None;
    }

    // Keep the newest turns live and summarize complete older turns.
    let keep_budget = trigger.saturating_mul(45) / 100;
    let mut recent_cost = 0usize;
    let mut fallback = None;
    for index in (1..messages.len()).rev() {
        let cost = ai_input_message_cost(&messages[index]);
        recent_cost = recent_cost.saturating_add(cost);
        if messages[index].role == "user" {
            fallback.get_or_insert(index);
            if recent_cost >= keep_budget {
                return Some(index);
            }
        }
    }
    fallback
}

fn parse_compaction_response(payload: &Value) -> Result<(String, AiTokenUsage), String> {
    let summary = payload
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| response_output_text(payload))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "上下文压缩接口未返回摘要".to_string())?;
    let usage = AiTokenUsage::from_payload(payload).unwrap_or_default();
    Ok((summary, usage))
}

async fn compact_messages_with_model(
    client: &reqwest::Client,
    endpoint: &str,
    api_mode: AiApiMode,
    api_key: &str,
    model: &str,
    messages: &[AiInputMessage],
    context_window: u32,
    max_output_tokens: u32,
) -> Result<Option<(AiInputMessage, usize, AiTokenUsage)>, String> {
    let Some(split_index) = compaction_split_index(messages, context_window, max_output_tokens)
    else {
        return Ok(None);
    };
    let transcript = messages[..split_index]
        .iter()
        .map(ai_input_message_transcript)
        .collect::<Vec<_>>()
        .join("\n\n");
    let transcript_budget = input_token_budget(context_window).min(12_000);
    let transcript = truncate_to_token_budget(&transcript, transcript_budget);
    let summary_prompt = "你负责压缩一段 SSH 运维助手对话，以便会话继续工作。只输出 plain text 交接摘要，不要调用工具、不要回答原问题、不要披露隐藏思维链。按时间顺序保留：用户目标、已确认事实、关键命令及结果、文件路径和函数、已作决策、约束/风险、错误与修复、已完成事项和待办事项。若信息不确定，明确标注不确定。摘要要短而具体，不能遗漏后续工作所需的技术细节。";
    let output_limit = max_output_tokens.clamp(256, 2_048) as usize;
    let mut body = if api_mode.is_responses() {
        json!({
            "model": model,
            "instructions": summary_prompt,
            "input": transcript,
            "temperature": 0.1,
            "max_output_tokens": output_limit,
            "stream": false,
            "store": false
        })
    } else {
        json!({
            "model": model,
            "messages": [
                { "role": "system", "content": summary_prompt },
                { "role": "user", "content": transcript }
            ],
            "temperature": 0.1,
            "stream": false
        })
    };
    if !api_mode.is_responses() {
        set_chat_completion_token_limit(&mut body, endpoint, output_limit);
    }
    if is_openai_api_endpoint(endpoint) {
        body["prompt_cache_key"] = json!(ai_prompt_cache_key(model, summary_prompt, &[]));
    }
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("上下文压缩请求失败: {error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("上下文压缩响应解析失败: {error}"))?;
    if !status.is_success() {
        let detail = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("未知接口错误");
        return Err(format!("上下文压缩接口返回 {status}: {detail}"));
    }
    let (summary, usage) = parse_compaction_response(&payload)?;
    Ok(Some((
        AiInputMessage {
            role: "system".to_string(),
            content: format!("[自动压缩摘要]\n会话已继续。以下摘要替代较早的对话记录；最近几轮消息仍保留。\n\n{summary}"),
            reasoning_content: None,
            attachments: Vec::new(),
        },
        split_index,
        usage,
    )))
}

fn trim_messages_for_context(
    messages: Vec<AiInputMessage>,
    context_window: u32,
    system_prompt: &str,
) -> Result<Vec<AiInputMessage>, String> {
    let system_cost = estimate_tokens(system_prompt) + 8;
    let mut remaining = input_token_budget(context_window)
        .checked_sub(system_cost)
        .ok_or_else(|| "系统提示词超过可用上下文，请缩短提示词或增大上下文大小".to_string())?;
    let mut retained = Vec::new();

    for message in messages.into_iter().rev() {
        let cost = ai_input_message_cost(&message);
        if cost > remaining {
            if retained.is_empty() {
                return Err("最新消息超过可用上下文，请缩短内容或增大上下文大小".to_string());
            }
            break;
        }
        remaining -= cost;
        retained.push(message);
    }
    retained.reverse();
    Ok(retained)
}

fn api_message_cost(message: &Value) -> usize {
    let mut cost = 4;
    if let Some(role) = message.get("role").and_then(Value::as_str) {
        cost += estimate_tokens(role);
    }
    if let Some(content) = message.get("content") {
        if let Some(value) = content.as_str() {
            cost += estimate_tokens(value);
        } else if let Some(parts) = content.as_array() {
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    cost += estimate_tokens(text);
                } else if part.get("type").and_then(Value::as_str) == Some("image_url") {
                    cost += 256;
                }
            }
        }
    }
    if let Some(tool_call_id) = message.get("tool_call_id").and_then(Value::as_str) {
        cost += estimate_tokens(tool_call_id);
    }
    if let Some(tool_calls) = message.get("tool_calls") {
        cost += estimate_tokens(&tool_calls.to_string());
    }
    cost
}

fn trim_api_messages_for_context(
    messages: &mut Vec<Value>,
    context_window: u32,
) -> Result<(), String> {
    let Some(system) = messages.first().cloned() else {
        return Ok(());
    };
    let system_cost = api_message_cost(&system);
    let mut remaining = input_token_budget(context_window)
        .checked_sub(system_cost)
        .ok_or_else(|| "系统提示词超过可用上下文，请缩短提示词或增大上下文大小".to_string())?;
    let mut groups: Vec<Vec<Value>> = Vec::new();

    for message in messages.iter().skip(1).cloned() {
        let starts_turn = message.get("role").and_then(Value::as_str) == Some("user");
        if groups.is_empty() || starts_turn && groups.last().is_some_and(|group| !group.is_empty())
        {
            groups.push(Vec::new());
        }
        groups
            .last_mut()
            .expect("message group exists")
            .push(message);
    }

    let mut retained = Vec::new();
    for group in groups.into_iter().rev() {
        let cost = group.iter().map(api_message_cost).sum::<usize>();
        if cost > remaining {
            if retained.is_empty() {
                return Err("最近一轮消息超过可用上下文，请缩短内容或增大上下文大小".to_string());
            }
            break;
        }
        remaining -= cost;
        retained.push(group);
    }

    retained.reverse();
    messages.clear();
    messages.push(system);
    messages.extend(retained.into_iter().flatten());
    Ok(())
}

fn truncate_to_token_budget(value: &str, budget: usize) -> String {
    if estimate_tokens(value) <= budget {
        return value.to_string();
    }
    if budget == 0 {
        return String::new();
    }

    let suffix = "\n...[tool output truncated]";
    let suffix = if estimate_tokens(suffix) <= budget {
        suffix
    } else {
        "..."
    };
    let content_budget = budget.saturating_sub(estimate_tokens(suffix));
    let mut result = String::new();
    let (mut ascii, mut non_ascii) = (0usize, 0usize);
    for character in value.chars() {
        let (next_ascii, next_non_ascii) = if character.is_ascii() {
            (ascii + 1, non_ascii)
        } else {
            (ascii, non_ascii + 1)
        };
        if next_ascii.div_ceil(4) + next_non_ascii > content_budget {
            break;
        }
        ascii = next_ascii;
        non_ascii = next_non_ascii;
        result.push(character);
    }
    result.push_str(suffix);
    result
}

fn tool_output_budget(
    messages: &[Value],
    context_window: u32,
    tool_call_id: &str,
    future_tool_call_ids: &[String],
) -> Result<usize, String> {
    let latest_turn_start = messages
        .iter()
        .rposition(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .unwrap_or(1);
    let system_cost = messages.first().map(api_message_cost).unwrap_or_default();
    let current_turn_cost = messages
        .iter()
        .skip(latest_turn_start)
        .map(api_message_cost)
        .sum::<usize>();
    let tool_envelope_cost = |id: &str| {
        4 + estimate_tokens("tool")
            + estimate_tokens(id)
            + estimate_tokens("exit_code=-2147483648\n")
    };
    let fixed_cost = system_cost
        + current_turn_cost
        + tool_envelope_cost(tool_call_id)
        + future_tool_call_ids
            .iter()
            .map(|id| tool_envelope_cost(id))
            .sum::<usize>();
    let available = input_token_budget(context_window)
        .checked_sub(fixed_cost)
        .ok_or_else(|| "AI 工具调用超过可用上下文，请增大上下文大小".to_string())?;
    Ok(available / (future_tool_call_ids.len() + 1))
}

#[tauri::command]
async fn list_ai_models(config: AiConfig) -> Result<Vec<String>, String> {
    let api_key = if config.api_key.trim().is_empty() {
        read_secret("ai:api-key").unwrap_or_default()
    } else {
        config.api_key.clone()
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("AI 客户端初始化失败: {error}"))?;
    let mut request = client.get(ai_endpoint(&config.endpoint, "models"));
    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("模型列表请求失败: {error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("模型列表解析失败: {error}"))?;
    if !status.is_success() {
        let detail = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("未知接口错误");
        return Err(format!("模型接口返回 {status}: {detail}"));
    }
    let mut models = payload
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("id").and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<_>>();
    models.sort_unstable();
    models.dedup();
    if models.is_empty() {
        return Err("接口未返回可用模型".to_string());
    }
    Ok(models)
}

fn ai_tool_enabled(settings: &AiToolSettings, name: &str) -> bool {
    match name {
        "execute_command" | "run_ssh_command" => settings.execute_command,
        "background_task" => settings.background_task,
        "pty_interaction" => settings.pty_interaction,
        "read_file" => settings.read_file,
        "write_file" => settings.write_file,
        "sftp_upload" => settings.sftp_upload,
        "sftp_download" => settings.sftp_download,
        "list_directory" => settings.list_directory,
        "get_system_metrics" => settings.get_system_metrics,
        "process_manager" => settings.process_manager,
        "network_checker" => settings.network_checker,
        "docker_manager" => settings.docker_manager,
        "systemd_control" => settings.systemd_control,
        "risk_checker" => settings.risk_checker,
        "snippet_library" => settings.snippet_library,
        "log_analyzer" => settings.log_analyzer,
        _ => false,
    }
}

fn ai_function_tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required.iter().map(|value| Value::String((*value).to_string())).collect::<Vec<_>>(),
                "additionalProperties": false
            }
        }
    })
}

fn ai_tool_definitions(settings: &AiToolSettings) -> Vec<Value> {
    let mut tools = Vec::new();
    let mut add = |name: &str, description: &str, properties: Value, required: &[&str]| {
        if ai_tool_enabled(settings, name) {
            tools.push(ai_function_tool(name, description, properties, required));
        }
    };

    add(
        "execute_command",
        "在当前 SSH 服务器执行命令，返回 stdout、stderr 和退出码。执行前必须考虑风险。",
        json!({ "command": { "type": "string", "description": "完整的远端 Shell 命令" } }),
        &["command"],
    );
    add(
        "background_task",
        "管理当前 SSH 服务器上的后台任务，可启动、查看状态、读取日志或停止任务。",
        json!({
            "action": { "type": "string", "enum": ["start", "status", "logs", "stop"], "description": "后台作业动作" },
            "command": { "type": "string", "description": "start 时要在后台运行的命令" },
            "pid": { "type": "integer", "description": "status、logs 或 stop 时的 PID" },
            "lines": { "type": "integer", "description": "logs 返回的行数" }
        }),
        &["action"],
    );
    add(
        "pty_interaction",
        "向需要一次输入的命令传入响应。密码、确认提示和变更型命令必须先请求人工确认。",
        json!({
            "command": { "type": "string", "description": "需要交互的命令" },
            "input": { "type": "string", "description": "写入标准输入的内容，不包含回车" }
        }),
        &["command", "input"],
    );
    add(
        "read_file",
        "读取远端文本文件的前 800 行，适合配置和日志诊断。",
        json!({ "path": { "type": "string", "description": "远端文件路径" } }),
        &["path"],
    );
    add(
        "write_file",
        "覆写远端文本文件。仅在设置中显式允许变更型工具后可用。",
        json!({
            "path": { "type": "string", "description": "远端文件路径" },
            "content": { "type": "string", "description": "要写入的完整文本" }
        }),
        &["path", "content"],
    );
    add(
        "sftp_upload",
        "通过 SFTP 将本机文件上传到当前服务器。仅在设置中显式允许变更型工具后可用。",
        json!({
            "localPath": { "type": "string", "description": "本机文件路径" },
            "remotePath": { "type": "string", "description": "远端目标路径" }
        }),
        &["localPath", "remotePath"],
    );
    add(
        "sftp_download",
        "通过 SFTP 将远端文件下载到本机。",
        json!({
            "remotePath": { "type": "string", "description": "远端文件路径" },
            "localPath": { "type": "string", "description": "本机目标路径" }
        }),
        &["remotePath", "localPath"],
    );
    add(
        "list_directory",
        "结构化列出远端目录及其文件元数据。",
        json!({ "path": { "type": "string", "description": "远端目录路径，默认为 /" } }),
        &[],
    );
    add(
        "get_system_metrics",
        "读取 CPU、内存、磁盘、网络吞吐和 NVIDIA GPU 状态。",
        json!({}),
        &[],
    );
    add(
        "process_manager",
        "列出高占用进程，或在人工允许后发送 TERM/KILL 信号。",
        json!({
            "action": { "type": "string", "enum": ["list", "terminate"], "description": "list 或 terminate" },
            "pid": { "type": "integer", "description": "terminate 时的 PID" },
            "signal": { "type": "string", "enum": ["TERM", "KILL"], "description": "terminate 时的信号" }
        }),
        &["action"],
    );
    add(
        "network_checker",
        "检查网络连接、网卡、主机连通性和 TCP 端口。",
        json!({
            "mode": { "type": "string", "enum": ["connections", "interfaces", "ping", "port"], "description": "检查模式" },
            "host": { "type": "string", "description": "ping 或 port 的主机" },
            "port": { "type": "integer", "description": "port 模式的 TCP 端口" }
        }),
        &["mode"],
    );
    add(
        "docker_manager",
        "查看 Docker 容器、镜像和日志；生命周期变更需要人工允许。",
        json!({
            "action": { "type": "string", "enum": ["ps", "images", "logs", "pull", "start", "stop", "restart", "rm"], "description": "Docker 动作" },
            "target": { "type": "string", "description": "容器、镜像或镜像名" },
            "lines": { "type": "integer", "description": "logs 返回的行数" }
        }),
        &["action"],
    );
    add(
        "systemd_control",
        "查看 systemd 服务状态和日志；启动、停止、重启等动作需要人工允许。",
        json!({
            "action": { "type": "string", "enum": ["status", "logs", "start", "stop", "restart", "enable", "disable"], "description": "服务动作" },
            "service": { "type": "string", "description": "systemd 服务名" },
            "lines": { "type": "integer", "description": "logs 返回的行数" }
        }),
        &["action", "service"],
    );
    add(
        "risk_checker",
        "在执行前检查命令是否包含删除、格式化、防火墙、重启或其他高危动作。",
        json!({ "command": { "type": "string", "description": "要评估的命令" } }),
        &["command"],
    );
    add(
        "snippet_library",
        "返回常用的只读运维命令片段；传入 name 可获取单个片段。",
        json!({ "name": { "type": "string", "description": "片段名称，可选" } }),
        &[],
    );
    add(
        "log_analyzer",
        "抓取应用日志或 systemd 错误日志，供模型进行因果分析。",
        json!({
            "path": { "type": "string", "description": "可选的日志文件路径，默认为 journalctl 错误日志" },
            "lines": { "type": "integer", "description": "最多读取的行数，默认 120" }
        }),
        &[],
    );
    tools
}

fn required_ai_arg<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("工具参数缺少 {key}"))
}

fn optional_ai_arg(arguments: &Value, key: &str, fallback: &str) -> String {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn ai_action<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, String> {
    required_ai_arg(arguments, key)
}

fn bounded_ai_command(command: &str, timeout_seconds: u32) -> String {
    let timeout_seconds = timeout_seconds.max(5);
    let quoted = shell_quote(command);
    format!(
        "if command -v timeout >/dev/null 2>&1; then timeout --signal=TERM {timeout_seconds}s sh -lc {quoted}; else sh -lc {quoted}; fi"
    )
}

async fn run_ai_command(
    server: &ServerProfile,
    command: String,
    settings: &AiToolSettings,
) -> Result<CommandResult, String> {
    let server = server.clone();
    let command = bounded_ai_command(&command, settings.command_timeout_seconds);
    tauri::async_runtime::spawn_blocking(move || run_command_sync(&server, &command))
        .await
        .map_err(|error| format!("AI 工具任务失败: {error}"))?
}

fn json_command_result<T: Serialize>(value: &T) -> CommandResult {
    match serde_json::to_string_pretty(value) {
        Ok(stdout) => CommandResult {
            stdout,
            stderr: String::new(),
            exit_code: 0,
        },
        Err(error) => CommandResult {
            stdout: String::new(),
            stderr: format!("结构化结果序列化失败: {error}"),
            exit_code: 1,
        },
    }
}

fn ai_blocked_result(message: impl Into<String>) -> CommandResult {
    CommandResult {
        stdout: String::new(),
        stderr: message.into(),
        exit_code: 126,
    }
}

fn docker_command(arguments: &Value) -> Result<String, String> {
    let action = ai_action(arguments, "action")?;
    let target = optional_ai_arg(arguments, "target", "");
    let lines = arguments
        .get("lines")
        .and_then(Value::as_u64)
        .unwrap_or(120)
        .clamp(1, 1_000);
    match action {
        "ps" => Ok("docker ps --format '{{json .}}'".to_string()),
        "images" => Ok("docker images --format '{{json .}}'".to_string()),
        "logs" if !target.is_empty() => Ok(format!(
            "docker logs --tail {lines} {}",
            shell_quote(&target)
        )),
        "pull" | "start" | "stop" | "restart" | "rm" if !target.is_empty() => {
            Ok(format!("docker {action} {}", shell_quote(&target)))
        }
        "logs" | "pull" | "start" | "stop" | "restart" | "rm" => {
            Err("该 Docker 动作需要 target".to_string())
        }
        _ => Err("不支持的 Docker 动作".to_string()),
    }
}

fn systemd_command(arguments: &Value) -> Result<String, String> {
    let action = ai_action(arguments, "action")?;
    let service = required_ai_arg(arguments, "service")?;
    let lines = arguments
        .get("lines")
        .and_then(Value::as_u64)
        .unwrap_or(120)
        .clamp(1, 1_000);
    if !service.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '@' | '.' | '_' | '-' | ':')
    }) {
        return Err("服务名包含不允许的字符".to_string());
    }
    match action {
        "status" => Ok(format!(
            "systemctl status --no-pager {}",
            shell_quote(service)
        )),
        "logs" => Ok(format!(
            "journalctl -u {} -n {lines} --no-pager",
            shell_quote(service)
        )),
        "start" | "stop" | "restart" | "enable" | "disable" => {
            Ok(format!("systemctl {action} {}", shell_quote(service)))
        }
        _ => Err("不支持的 systemd 动作".to_string()),
    }
}

fn process_command(arguments: &Value) -> Result<String, String> {
    match ai_action(arguments, "action")? {
        "list" => Ok(
            "LC_ALL=C ps -eo pid=,user=,comm=,%mem=,%cpu=,etimes=,args= --sort=-%cpu".to_string(),
        ),
        "terminate" => {
            let pid = arguments
                .get("pid")
                .and_then(Value::as_u64)
                .ok_or_else(|| "terminate 需要 pid".to_string())?;
            let signal = arguments
                .get("signal")
                .and_then(Value::as_str)
                .unwrap_or("TERM");
            if !matches!(signal, "TERM" | "KILL") || pid <= 1 {
                return Err("仅支持对大于 1 的 PID 发送 TERM 或 KILL".to_string());
            }
            Ok(format!("kill -{signal} {pid}"))
        }
        _ => Err("不支持的进程动作".to_string()),
    }
}

fn ai_tool_is_mutating(name: &str, arguments: &Value) -> bool {
    match name {
        "execute_command" | "run_ssh_command" | "write_file" | "sftp_upload" | "sftp_download"
        | "pty_interaction" => true,
        "background_task" => matches!(
            arguments
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("start"),
            "start" | "stop"
        ),
        "process_manager" => arguments.get("action").and_then(Value::as_str) == Some("terminate"),
        "docker_manager" => matches!(
            arguments.get("action").and_then(Value::as_str),
            Some("pull" | "start" | "stop" | "restart" | "rm")
        ),
        "systemd_control" => matches!(
            arguments.get("action").and_then(Value::as_str),
            Some("start" | "stop" | "restart" | "enable" | "disable")
        ),
        _ => false,
    }
}

fn ai_tool_mutation_is_authorized(
    settings: &AiToolSettings,
    name: &str,
    arguments: &Value,
) -> bool {
    !ai_tool_is_mutating(name, arguments) || settings.allow_mutating_tools
}

fn ai_tool_command_for_risk(name: &str, arguments: &Value) -> Option<String> {
    match name {
        "execute_command" | "run_ssh_command" | "pty_interaction" => arguments
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_string),
        "background_task" => match arguments
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("start")
        {
            "start" => arguments
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_string),
            "stop" => arguments
                .get("pid")
                .and_then(Value::as_u64)
                .map(|pid| format!("kill -TERM {pid}")),
            _ => None,
        },
        "process_manager" => process_command(arguments).ok(),
        "docker_manager" => docker_command(arguments).ok(),
        "systemd_control" => systemd_command(arguments).ok(),
        "write_file" => required_ai_arg(arguments, "path")
            .ok()
            .map(|path| format!("write_file {path}")),
        _ => None,
    }
}

fn protected_write_path(path: &str) -> bool {
    ["/etc", "/boot", "/usr", "/bin", "/sbin", "/lib", "/var/lib"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

fn snippet_library(name: Option<&str>) -> CommandResult {
    let snippets = vec![
        json!({ "name": "disk", "description": "磁盘空间", "command": "df -hT" }),
        json!({ "name": "memory", "description": "内存和交换分区", "command": "free -h" }),
        json!({ "name": "load", "description": "系统负载", "command": "uptime" }),
        json!({ "name": "failed-services", "description": "失败的 systemd 服务", "command": "systemctl --failed --no-pager" }),
        json!({ "name": "recent-errors", "description": "最近的错误日志", "command": "journalctl -p err -n 120 --no-pager" }),
        json!({ "name": "listening", "description": "监听端口", "command": "ss -tlpn" }),
    ];
    let selected = name
        .map(|value| {
            snippets
                .iter()
                .filter(|item| item.get("name").and_then(Value::as_str) == Some(value))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or(snippets);
    json_command_result(&selected)
}

struct AiToolExecution {
    display_command: String,
    result: CommandResult,
}

async fn execute_ai_tool(
    name: &str,
    arguments: &Value,
    server: &ServerProfile,
    settings: &AiToolSettings,
) -> Result<AiToolExecution, String> {
    let execution = match name {
        "execute_command" | "run_ssh_command" => {
            let command = required_ai_arg(arguments, "command")?.to_string();
            let result = run_ai_command(server, command.clone(), settings).await?;
            AiToolExecution {
                display_command: command,
                result,
            }
        }
        "background_task" => {
            let action = optional_ai_arg(arguments, "action", "start");
            let (display_command, remote_command) = match action.as_str() {
                "start" => {
                    let command = required_ai_arg(arguments, "command")?;
                    let remote_command = format!(
                        "log=/tmp/portico-ai-task-$$.log; nohup sh -lc {} >\"$log\" 2>&1 & pid=$!; mv \"$log\" /tmp/portico-ai-task-$pid.log; printf '{{\"pid\":%s,\"log\":\"/tmp/portico-ai-task-%s.log\"}}\\n' \"$pid\" \"$pid\"",
                        shell_quote(command)
                    );
                    (format!("background_task start {command}"), remote_command)
                }
                "status" => {
                    let pid = arguments
                        .get("pid")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| "status 需要 pid".to_string())?;
                    (
                        format!("background_task status {pid}"),
                        format!("ps -p {pid} -o pid=,stat=,etime=,cmd="),
                    )
                }
                "logs" => {
                    let pid = arguments
                        .get("pid")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| "logs 需要 pid".to_string())?;
                    let lines = arguments
                        .get("lines")
                        .and_then(Value::as_u64)
                        .unwrap_or(120)
                        .clamp(1, 1_000);
                    (
                        format!("background_task logs {pid}"),
                        format!("tail -n {lines} -- /tmp/portico-ai-task-{pid}.log"),
                    )
                }
                "stop" => {
                    let pid = arguments
                        .get("pid")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| "stop 需要 pid".to_string())?;
                    (
                        format!("background_task stop {pid}"),
                        format!("kill -TERM {pid}"),
                    )
                }
                _ => return Err("不支持的后台作业动作".to_string()),
            };
            let result = run_ai_command(server, remote_command, settings).await?;
            AiToolExecution {
                display_command,
                result,
            }
        }
        "pty_interaction" => {
            let command = required_ai_arg(arguments, "command")?;
            let input = required_ai_arg(arguments, "input")?;
            let remote_command = format!(
                "printf '%s' {} | sh -lc {}",
                shell_quote(input),
                shell_quote(command)
            );
            let result = run_ai_command(server, remote_command, settings).await?;
            AiToolExecution {
                display_command: format!("pty_interaction {command}"),
                result,
            }
        }
        "read_file" => {
            let path = required_ai_arg(arguments, "path")?;
            let command = format!("sed -n '1,800p' -- {}", shell_quote(path));
            let result = run_ai_command(server, command, settings).await?;
            AiToolExecution {
                display_command: format!("read_file {path}"),
                result,
            }
        }
        "write_file" => {
            let path = required_ai_arg(arguments, "path")?;
            let content = required_ai_arg(arguments, "content")?;
            let command = format!(
                "umask 077; printf '%s' {} > {}",
                shell_quote(content),
                shell_quote(path)
            );
            let result = run_ai_command(server, command, settings).await?;
            AiToolExecution {
                display_command: format!("write_file {path}"),
                result,
            }
        }
        "sftp_upload" => {
            let local_path = required_ai_arg(arguments, "localPath")?.to_string();
            let remote_path = required_ai_arg(arguments, "remotePath")?.to_string();
            let result =
                match upload_file(server.clone(), local_path.clone(), remote_path.clone()).await {
                    Ok(()) => CommandResult {
                        stdout: "SFTP upload completed".to_string(),
                        stderr: String::new(),
                        exit_code: 0,
                    },
                    Err(error) => ai_blocked_result(error),
                };
            AiToolExecution {
                display_command: format!("sftp_upload {local_path} -> {remote_path}"),
                result,
            }
        }
        "sftp_download" => {
            let remote_path = required_ai_arg(arguments, "remotePath")?.to_string();
            let local_path = required_ai_arg(arguments, "localPath")?.to_string();
            let result = match download_file(
                server.clone(),
                remote_path.clone(),
                local_path.clone(),
            )
            .await
            {
                Ok(()) => CommandResult {
                    stdout: "SFTP download completed".to_string(),
                    stderr: String::new(),
                    exit_code: 0,
                },
                Err(error) => ai_blocked_result(error),
            };
            AiToolExecution {
                display_command: format!("sftp_download {remote_path} -> {local_path}"),
                result,
            }
        }
        "list_directory" => {
            let path = optional_ai_arg(arguments, "path", "/");
            let result = match list_directory(server.clone(), path.clone()).await {
                Ok(entries) => json_command_result(&entries),
                Err(error) => ai_blocked_result(error),
            };
            AiToolExecution {
                display_command: format!("list_directory {path}"),
                result,
            }
        }
        "get_system_metrics" => {
            let command = "LC_ALL=C sh -lc 'printf -- \"[load]\n\"; uptime; printf -- \"[memory]\n\"; free -h; printf -- \"[disk]\n\"; df -hT; printf -- \"[network]\n\"; cat /proc/net/dev; printf -- \"[gpu]\n\"; if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader; else printf -- \"unavailable\\n\"; fi'";
            let result = run_ai_command(server, command.to_string(), settings).await?;
            AiToolExecution {
                display_command: "get_system_metrics".to_string(),
                result,
            }
        }
        "process_manager" => {
            let action = ai_action(arguments, "action")?;
            let result = if action == "list" {
                match list_processes(server.clone()).await {
                    Ok(processes) => json_command_result(&processes),
                    Err(error) => ai_blocked_result(error),
                }
            } else {
                let pid = arguments
                    .get("pid")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as u32;
                let signal = arguments
                    .get("signal")
                    .and_then(Value::as_str)
                    .unwrap_or("TERM")
                    .to_string();
                match signal_process(server.clone(), pid, signal).await {
                    Ok(()) => CommandResult {
                        stdout: "process signal sent".to_string(),
                        stderr: String::new(),
                        exit_code: 0,
                    },
                    Err(error) => ai_blocked_result(error),
                }
            };
            AiToolExecution {
                display_command: process_command(arguments)?,
                result,
            }
        }
        "network_checker" => {
            let mode = ai_action(arguments, "mode")?;
            let (display_command, result) = match mode {
                "connections" => (
                    "network_checker connections".to_string(),
                    match list_network_connections(server.clone()).await {
                        Ok(value) => json_command_result(&value),
                        Err(error) => ai_blocked_result(error),
                    },
                ),
                "interfaces" => (
                    "network_checker interfaces".to_string(),
                    match list_network_interfaces(server.clone()).await {
                        Ok(value) => json_command_result(&value),
                        Err(error) => ai_blocked_result(error),
                    },
                ),
                "ping" => {
                    let host = required_ai_arg(arguments, "host")?;
                    (
                        format!("ping {host}"),
                        run_ai_command(
                            server,
                            format!("ping -c 3 -W 2 -- {}", shell_quote(host)),
                            settings,
                        )
                        .await?,
                    )
                }
                "port" => {
                    let host = required_ai_arg(arguments, "host")?;
                    let port = arguments
                        .get("port")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| "port 模式需要 port".to_string())?;
                    if !(1..=65_535).contains(&port) {
                        return Err("port 必须在 1–65535 之间".to_string());
                    }
                    let command = format!("if command -v nc >/dev/null 2>&1; then nc -vz -w 3 {} {port}; else curl -fsS --connect-timeout 3 telnet://{}:{port}; fi", shell_quote(host), shell_quote(host));
                    (
                        format!("network_checker port {host}:{port}"),
                        run_ai_command(server, command, settings).await?,
                    )
                }
                _ => return Err("不支持的网络检查模式".to_string()),
            };
            AiToolExecution {
                display_command,
                result,
            }
        }
        "docker_manager" => {
            let command = docker_command(arguments)?;
            let result = run_ai_command(server, command, settings).await?;
            AiToolExecution {
                display_command: format!("docker_manager {}", ai_action(arguments, "action")?),
                result,
            }
        }
        "systemd_control" => {
            let command = systemd_command(arguments)?;
            let result = run_ai_command(server, command, settings).await?;
            AiToolExecution {
                display_command: format!(
                    "systemd_control {} {}",
                    ai_action(arguments, "action")?,
                    required_ai_arg(arguments, "service")?
                ),
                result,
            }
        }
        "risk_checker" => {
            let command = required_ai_arg(arguments, "command")?;
            let reasons = risk_reasons(command);
            let result = json_command_result(
                &json!({ "blocked": is_high_risk_command(command), "reasons": reasons }),
            );
            AiToolExecution {
                display_command: format!("risk_checker {command}"),
                result,
            }
        }
        "snippet_library" => {
            let name = arguments.get("name").and_then(Value::as_str);
            AiToolExecution {
                display_command: "snippet_library".to_string(),
                result: snippet_library(name),
            }
        }
        "log_analyzer" => {
            let lines = arguments
                .get("lines")
                .and_then(Value::as_u64)
                .unwrap_or(120)
                .clamp(1, 500);
            let path = optional_ai_arg(arguments, "path", "");
            let command = if path.is_empty() {
                format!("journalctl -p err -n {lines} --no-pager 2>/dev/null || tail -n {lines} /var/log/syslog /var/log/messages 2>/dev/null")
            } else {
                format!("tail -n {lines} -- {}", shell_quote(&path))
            };
            let result = run_ai_command(server, command, settings).await?;
            AiToolExecution {
                display_command: if path.is_empty() {
                    "log_analyzer journal".to_string()
                } else {
                    format!("log_analyzer {path}")
                },
                result,
            }
        }
        _ => return Err(format!("未知 AI 工具 {name}")),
    };
    Ok(execution)
}

#[tauri::command]
async fn approve_ai_tool(
    server: ServerProfile,
    tool: String,
    arguments: Value,
    settings: AiToolSettings,
    action_id: String,
) -> Result<AiToolResult, String> {
    if !ai_tool_enabled(&settings, &tool) {
        return Err(format!("AI 工具 {tool} 未在设置中启用"));
    }
    if !ai_tool_mutation_is_authorized(&settings, &tool, &arguments) {
        return Err("变更型工具未获设置授权，请在 AI 设置中打开“允许变更型工具”。".to_string());
    }
    if tool == "write_file"
        && required_ai_arg(&arguments, "path")
            .map(protected_write_path)
            .unwrap_or(false)
    {
        return Err("已阻止写入受保护系统路径".to_string());
    }
    let started_at = ai_timestamp_ms();
    let execution = execute_ai_tool(&tool, &arguments, &server, &settings).await?;
    let output = truncate_to_token_budget(
        &format!("{}{}", execution.result.stdout, execution.result.stderr),
        settings.max_output_chars / 4,
    );
    Ok(completed_ai_tool_result(
        action_id,
        tool,
        execution.display_command,
        output,
        execution.result.exit_code,
        started_at,
    ))
}

struct AiSessionLogger {
    stream_id: String,
    path: Option<PathBuf>,
    file: Option<File>,
}

impl AiSessionLogger {
    fn start_ai_log(app: &AppHandle, stream_id: &str) -> Self {
        let directory = app.path().app_log_dir().unwrap_or_else(|error| {
            eprintln!("AI 日志目录解析失败: {error}; 回退到临时目录");
            env::temp_dir().join("portico-ssh").join("logs")
        });
        let path = directory.join(format!("ai-{}-{}.jsonl", ai_timestamp_ms(), Uuid::new_v4()));
        let file = fs::create_dir_all(&directory)
            .and_then(|_| File::create(&path))
            .map_err(|error| {
                eprintln!("AI 日志文件创建失败 {}: {error}", path.display());
                error
            })
            .ok();
        let mut logger = Self {
            stream_id: stream_id.to_string(),
            path: file.as_ref().map(|_| path),
            file,
        };
        if let Some(path) = logger.log_path_string() {
            eprintln!("AI 调试日志: {path}");
            logger.write_event("log.opened", None, json!({ "path": path }));
        }
        logger
    }

    fn log_path_string(&self) -> Option<String> {
        self.path.as_ref().map(|path| path.display().to_string())
    }

    fn write_event(&mut self, event: &str, round: Option<usize>, data: Value) {
        let entry = json!({
            "timestamp": ai_timestamp_ms(),
            "streamId": self.stream_id,
            "event": event,
            "round": round,
            "data": data,
        });
        let Some(file) = self.file.as_mut() else {
            return;
        };
        if let Err(error) = writeln!(file, "{entry}").and_then(|_| file.flush()) {
            eprintln!("AI 日志写入失败: {error}");
            self.file = None;
        }
    }
}

#[tauri::command]
async fn ai_chat(
    app: tauri::AppHandle,
    config: AiConfig,
    server: ServerProfile,
    messages: Vec<AiInputMessage>,
    allow_execute: bool,
    stream_id: String,
) -> Result<AiResponse, String> {
    if config.context_window < 1_024 {
        return Err("上下文大小需不小于 1,024".to_string());
    }
    if config.max_output_tokens < 256 {
        return Err("输出长度需不小于 256".to_string());
    }
    if !config.temperature.is_finite() || !(0.0..=2.0).contains(&config.temperature) {
        return Err("温度需在 0–2 之间".to_string());
    }
    let api_key = if config.api_key.trim().is_empty() {
        read_secret("ai:api-key")
            .ok_or_else(|| "未配置 AI API Key，请先打开助手设置".to_string())?
    } else {
        config.api_key.clone()
    };
    let endpoint = ai_endpoint(&config.endpoint, config.api_mode.endpoint_path());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| format!("AI 客户端初始化失败: {error}"))?;
    let system = format!(
        "{}\n当前 SSH 目标为 {}@{}:{}。用户消息中的附件以服务器临时文件路径引用，通常位于 /tmp/portico-ai-*；大文本可用 read_file 读取，图片必须通过可用的服务器工具检查，未实际读取时不要声称看过附件。已启用的工具由本地设置决定；变更型工具允许状态为{}。先调用 risk_checker 检查高风险动作，命中后必须等待客户端人工确认。最终回答开头必须使用 <reasoning_summary>...</reasoning_summary> 给出简明的判断依据与执行计划；不要披露隐藏思维链。",
        config.system_prompt,
        server.username,
        server.host,
        server.port,
        if config.tools.allow_mutating_tools { "是" } else { "否" },
    );
    let stream_event_name = format!("ai-stream:{stream_id}");
    let debug_event_name = format!("ai-debug:{stream_id}");
    let mut ai_logger = AiSessionLogger::start_ai_log(&app, &stream_id);
    ai_logger.write_event(
        "chat.started",
        None,
        json!({
            "apiMode": if config.api_mode.is_responses() { "responses" } else { "chat-completions" },
            "endpoint": &endpoint,
            "model": &config.model,
            "server": {
                "id": &server.id,
                "host": &server.host,
                "port": server.port,
                "username": &server.username,
            },
            "allowExecute": allow_execute,
            "messages": &messages,
        }),
    );
    let mut usage = AiTokenUsage::default();
    let mut conversation_messages = messages;
    let mut compaction_summary = None;
    let mut compaction_messages_removed = None;
    if config.auto_compress {
        match compact_messages_with_model(
            &client,
            &endpoint,
            config.api_mode,
            &api_key,
            &config.model,
            &conversation_messages,
            config.context_window,
            config.max_output_tokens,
        )
        .await
        {
            Ok(Some((summary, split_index, compaction_usage))) => {
                ai_logger.write_event(
                    "context.compacted",
                    None,
                    json!({
                        "messagesRemoved": split_index,
                        "summary": &summary.content,
                        "usage": compaction_usage,
                    }),
                );
                usage.record(compaction_usage);
                compaction_summary = Some(summary.content.clone());
                compaction_messages_removed = Some(split_index);
                let mut compacted = vec![summary];
                compacted.extend(conversation_messages.drain(split_index..));
                conversation_messages = compacted;
            }
            Ok(None) => {}
            Err(error) => {
                ai_logger.write_event("context.compaction_error", None, json!({ "error": &error }));
                eprintln!("{error}; 回退到普通上下文裁剪");
            }
        }
    }
    let mut api_messages = vec![json!({ "role": "system", "content": system })];
    api_messages.extend(
        trim_messages_for_context(conversation_messages, config.context_window, &system)?
            .into_iter()
            .map(|message| ai_input_message_to_api(&message)),
    );
    let tools = if allow_execute {
        ai_tool_definitions(&config.tools)
    } else {
        Vec::new()
    };
    let request_tools = if config.api_mode.is_responses() {
        responses_tool_definitions(&tools)
    } else {
        tools.clone()
    };
    let prompt_cache_key = is_openai_api_endpoint(&endpoint)
        .then(|| ai_prompt_cache_key(&config.model, &system, &request_tools));
    let mut executed_tools = Vec::new();
    let mut response_inputs = if config.api_mode.is_responses() {
        api_messages.iter().skip(1).cloned().collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    for round_index in 0..config.tools.max_tool_rounds.max(1) {
        let round = round_index as usize + 1;
        let input_cost = if config.api_mode.is_responses() {
            trim_response_inputs_for_context(
                &mut response_inputs,
                config.context_window,
                &system,
                &request_tools,
            )?;
            response_request_cost(&response_inputs, &system, &request_tools)
        } else {
            trim_api_messages_for_context(&mut api_messages, config.context_window)?;
            api_messages.iter().map(api_message_cost).sum::<usize>()
        };
        let output_budget = (config.context_window as usize)
            .saturating_sub(input_cost)
            .saturating_sub(64)
            .min(config.max_output_tokens as usize);
        if output_budget == 0 {
            ai_logger.write_event(
                "round.rejected",
                Some(round),
                json!({
                    "reason": "no_output_budget",
                    "inputCost": input_cost,
                    "contextWindow": config.context_window,
                }),
            );
            return Err("当前上下文没有可用的输出空间，请缩短对话或增大上下文大小".to_string());
        }
        let mut body = if config.api_mode.is_responses() {
            responses_stream_body(
                &config.model,
                &system,
                &response_inputs,
                config.temperature,
                output_budget,
                &request_tools,
            )
        } else {
            let mut body = json!({
                "model": config.model,
                "messages": api_messages,
                "temperature": config.temperature,
                "stream": true,
                "stream_options": { "include_usage": true }
            });
            set_chat_completion_token_limit(&mut body, &endpoint, output_budget);
            apply_chat_completion_tools(&mut body, &request_tools);
            body
        };
        if let Some(prompt_cache_key) = &prompt_cache_key {
            body["prompt_cache_key"] = json!(prompt_cache_key);
        }

        let debug_request = json!({
            "timestamp": ai_timestamp_ms(),
            "round": round,
            "method": "POST",
            "endpoint": &endpoint,
            "logPath": ai_logger.log_path_string(),
            "body": &body,
        });
        ai_logger.write_event("round.request", Some(round), debug_request.clone());
        if let Err(error) = app.emit(&debug_event_name, debug_request) {
            ai_logger.write_event(
                "round.debug_emit_error",
                Some(round),
                json!({ "error": error.to_string() }),
            );
        }

        let response = match client
            .post(&endpoint)
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                ai_logger.write_event(
                    "round.request_error",
                    Some(round),
                    json!({ "error": error.to_string() }),
                );
                return Err(format!("AI 请求失败: {error}"));
            }
        };
        let status = response.status();
        if !status.is_success() {
            let response_body = response.text().await.unwrap_or_default();
            ai_logger.write_event(
                "round.http_error",
                Some(round),
                json!({
                    "status": status.as_u16(),
                    "body": &response_body,
                }),
            );
            let payload = serde_json::from_str::<Value>(&response_body).ok();
            let detail = payload
                .as_ref()
                .and_then(|value| value.pointer("/error/message"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| {
                    if response_body.is_empty() {
                        "未知接口错误"
                    } else {
                        response_body.as_str()
                    }
                });
            return Err(format!("AI 接口返回 {status}: {detail}"));
        }

        let completion = match read_ai_stream(response, &app, &stream_event_name).await {
            Ok(completion) => completion,
            Err(error) => {
                ai_logger.write_event(
                    "round.stream_error",
                    Some(round),
                    json!({ "error": &error }),
                );
                return Err(error);
            }
        };
        usage.record(completion.usage);
        let message = completion.message();
        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        ai_logger.write_event(
            "round.response",
            Some(round),
            json!({
                "responseId": &completion.response_id,
                "content": &completion.content,
                "reasoning": &completion.reasoning,
                "message": &message,
                "responseOutput": &completion.response_output,
                "toolCallCount": tool_calls.len(),
                "usage": completion.usage,
            }),
        );
        if config.api_mode.is_responses() && !tool_calls.is_empty() {
            let output_items = completion.response_output_items();
            if output_items.is_empty() {
                let response_id = completion.response_id.as_deref().unwrap_or("unknown");
                ai_logger.write_event(
                    "round.invalid_tool_response",
                    Some(round),
                    json!({
                        "responseId": response_id,
                        "reason": "missing_response_output_items",
                    }),
                );
                return Err(format!(
                    "Responses 工具调用响应 {response_id} 缺少可重放的 output items"
                ));
            }
            response_inputs.extend(output_items);
        }
        if tool_calls.is_empty() {
            let (content, summary) = extract_reasoning_summary(&completion.content);
            let provider_reasoning =
                (!completion.reasoning.is_empty()).then_some(completion.reasoning);
            ai_logger.write_event(
                "chat.completed",
                Some(round),
                json!({
                    "content": &content,
                    "reasoningSummary": &summary,
                    "providerReasoning": &provider_reasoning,
                    "toolCalls": &executed_tools,
                    "usage": usage,
                }),
            );
            return Ok(AiResponse {
                content,
                reasoning: summary.or_else(|| provider_reasoning.clone()),
                reasoning_content: provider_reasoning,
                approval: None,
                tool_calls: executed_tools,
                usage,
                compaction_summary: compaction_summary.clone(),
                compaction_messages_removed,
            });
        }

        api_messages.push(message.clone());
        let tool_call_ids = tool_calls
            .iter()
            .map(|tool_call| {
                tool_call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("tool-call")
                    .to_string()
            })
            .collect::<Vec<_>>();
        for (index, tool_call) in tool_calls.into_iter().enumerate() {
            let id = tool_call
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("tool-call");
            let output_budget = if config.api_mode.is_responses() {
                response_tool_output_budget(
                    &response_inputs,
                    config.context_window,
                    &system,
                    &request_tools,
                    id,
                    &tool_call_ids[index + 1..],
                )?
            } else {
                tool_output_budget(
                    &api_messages,
                    config.context_window,
                    id,
                    &tool_call_ids[index + 1..],
                )?
            };
            ai_logger.write_event(
                "tool.requested",
                Some(round),
                json!({
                    "index": index + 1,
                    "outputBudget": output_budget,
                    "raw": &tool_call,
                }),
            );
            let arguments = tool_call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let parsed: Value = match serde_json::from_str(arguments) {
                Ok(parsed) => parsed,
                Err(error) => {
                    ai_logger.write_event(
                        "tool.arguments_error",
                        Some(round),
                        json!({
                            "arguments": arguments,
                            "error": error.to_string(),
                        }),
                    );
                    return Err(format!("工具参数解析失败: {error}"));
                }
            };
            let tool_name = tool_call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or("execute_command")
                .to_string();
            if !ai_tool_enabled(&config.tools, &tool_name) {
                ai_logger.write_event(
                    "tool.disabled",
                    Some(round),
                    json!({
                        "tool": &tool_name,
                        "arguments": &parsed,
                    }),
                );
                return Err(format!("AI 工具 {tool_name} 未在设置中启用"));
            }
            let pending_command =
                ai_tool_command_for_risk(&tool_name, &parsed).unwrap_or_else(|| tool_name.clone());
            let started_at = ai_timestamp_ms();
            ai_logger.write_event(
                "tool.started",
                Some(round),
                json!({
                    "id": id,
                    "tool": &tool_name,
                    "arguments": &parsed,
                    "command": &pending_command,
                    "outputBudget": output_budget,
                }),
            );
            emit_ai_tool_stream_update(
                &app,
                &stream_event_name,
                id,
                "started",
                &tool_name,
                &pending_command,
                None,
                None,
            );

            if !ai_tool_mutation_is_authorized(&config.tools, &tool_name, &parsed) {
                let result = ai_blocked_result(
                    "BLOCKED: 变更型工具未获设置授权，请在 AI 设置中打开“允许变更型工具”。",
                );
                let output = truncate_to_token_budget(
                    &format!("{}{}", result.stdout, result.stderr),
                    output_budget,
                );
                let tool_result = completed_ai_tool_result(
                    id.to_string(),
                    tool_name.clone(),
                    format!("{tool_name} (blocked)"),
                    output.clone(),
                    result.exit_code,
                    started_at,
                );
                emit_ai_tool_stream_update(
                    &app,
                    &stream_event_name,
                    id,
                    "error",
                    &tool_result.tool,
                    &tool_result.command,
                    Some(&tool_result.output),
                    Some(tool_result.exit_code),
                );
                ai_logger.write_event(
                    "tool.blocked",
                    Some(round),
                    json!({
                        "reason": "mutation_not_authorized",
                        "result": &tool_result,
                    }),
                );
                executed_tools.push(tool_result);
                append_ai_tool_output(
                    &mut api_messages,
                    &mut response_inputs,
                    config.api_mode,
                    id,
                    format!("exit_code={}\n{}", result.exit_code, output),
                );
                continue;
            }

            if tool_name != "risk_checker" {
                if let Some(command) = ai_tool_command_for_risk(&tool_name, &parsed) {
                    let reasons = risk_reasons(&command);
                    if !reasons.is_empty() {
                        let reason = reasons.join("、");
                        let result =
                            ai_blocked_result(format!("BLOCKED: {reason}。等待人工确认。"));
                        let output = truncate_to_token_budget(
                            &format!("{}{}", result.stdout, result.stderr),
                            output_budget,
                        );
                        let tool_result = completed_ai_tool_result(
                            id.to_string(),
                            tool_name.clone(),
                            command.clone(),
                            output,
                            result.exit_code,
                            started_at,
                        );
                        emit_ai_tool_stream_update(
                            &app,
                            &stream_event_name,
                            id,
                            "error",
                            &tool_result.tool,
                            &tool_result.command,
                            Some(&tool_result.output),
                            Some(tool_result.exit_code),
                        );
                        ai_logger.write_event(
                            "tool.approval_required",
                            Some(round),
                            json!({
                                "reason": &reason,
                                "arguments": &parsed,
                                "result": &tool_result,
                            }),
                        );
                        executed_tools.push(tool_result);
                        return Ok(AiResponse {
                            content: "已暂停高风险操作，等待人工确认后再执行。".to_string(),
                            reasoning: Some(format!("风险检查命中：{reason}")),
                            reasoning_content: (!completion.reasoning.is_empty())
                                .then(|| completion.reasoning.clone()),
                            approval: Some(AiApproval {
                                tool: tool_name,
                                command,
                                arguments: parsed,
                                reason,
                            }),
                            tool_calls: executed_tools,
                            usage,
                            compaction_summary: compaction_summary.clone(),
                            compaction_messages_removed,
                        });
                    }
                }
                if tool_name == "write_file" {
                    if let Ok(path) = required_ai_arg(&parsed, "path") {
                        if protected_write_path(path) {
                            let result = ai_blocked_result("BLOCKED: 已阻止写入受保护系统路径");
                            let output = truncate_to_token_budget(
                                &format!("{}{}", result.stdout, result.stderr),
                                output_budget,
                            );
                            let tool_result = completed_ai_tool_result(
                                id.to_string(),
                                tool_name.clone(),
                                pending_command.clone(),
                                output,
                                result.exit_code,
                                started_at,
                            );
                            emit_ai_tool_stream_update(
                                &app,
                                &stream_event_name,
                                id,
                                "error",
                                &tool_result.tool,
                                &tool_result.command,
                                Some(&tool_result.output),
                                Some(tool_result.exit_code),
                            );
                            ai_logger.write_event(
                                "tool.blocked",
                                Some(round),
                                json!({
                                    "reason": "protected_write_path",
                                    "arguments": &parsed,
                                    "result": &tool_result,
                                }),
                            );
                            executed_tools.push(tool_result);
                            return Ok(AiResponse {
                                content: "已阻止写入受保护系统路径。".to_string(),
                                reasoning: Some("/etc、/boot、/usr、/lib 和 /var/lib 等路径需要通过人工终端操作。".to_string()),
                                reasoning_content: (!completion.reasoning.is_empty())
                                    .then(|| completion.reasoning.clone()),
                                approval: None,
                                tool_calls: executed_tools,
                                usage,
                                compaction_summary: compaction_summary.clone(),
                                compaction_messages_removed,
                            });
                        }
                    }
                }
            }

            emit_ai_tool_stream_update(
                &app,
                &stream_event_name,
                id,
                "running",
                &tool_name,
                &pending_command,
                None,
                None,
            );
            ai_logger.write_event(
                "tool.running",
                Some(round),
                json!({
                    "id": id,
                    "tool": &tool_name,
                    "command": &pending_command,
                }),
            );
            let execution = match execute_ai_tool(&tool_name, &parsed, &server, &config.tools).await
            {
                Ok(execution) => execution,
                Err(error) => {
                    emit_ai_tool_stream_update(
                        &app,
                        &stream_event_name,
                        id,
                        "error",
                        &tool_name,
                        &pending_command,
                        Some(&error),
                        Some(1),
                    );
                    ai_logger.write_event(
                        "tool.execution_error",
                        Some(round),
                        json!({
                            "id": id,
                            "tool": &tool_name,
                            "command": &pending_command,
                            "error": &error,
                        }),
                    );
                    return Err(error);
                }
            };
            let result = execution.result;
            let output = truncate_to_token_budget(
                &format!("{}{}", result.stdout, result.stderr),
                output_budget.min(config.tools.max_output_chars / 4),
            );
            let tool_result = completed_ai_tool_result(
                id.to_string(),
                tool_name,
                execution.display_command,
                output,
                result.exit_code,
                started_at,
            );
            emit_ai_tool_stream_update(
                &app,
                &stream_event_name,
                id,
                "finished",
                &tool_result.tool,
                &tool_result.command,
                Some(&tool_result.output),
                Some(tool_result.exit_code),
            );
            ai_logger.write_event(
                "tool.completed",
                Some(round),
                json!({ "result": &tool_result }),
            );
            append_ai_tool_output(
                &mut api_messages,
                &mut response_inputs,
                config.api_mode,
                id,
                format!(
                    "exit_code={}\n{}",
                    tool_result.exit_code, tool_result.output
                ),
            );
            executed_tools.push(tool_result);
        }
    }

    ai_logger.write_event(
        "chat.tool_round_limit",
        None,
        json!({ "maxToolRounds": config.tools.max_tool_rounds.max(1) }),
    );
    Err("AI 工具调用次数超过上限".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TerminalManager::default())
        .manage(EditorManager::default())
        .manage(TransferManager::default())
        .invoke_handler(tauri::generate_handler![
            store_server_secret,
            delete_server_secret,
            store_ai_key,
            delete_ai_key,
            start_terminal,
            terminal_input,
            terminal_resize,
            stop_terminal,
            list_processes,
            signal_process,
            list_network_connections,
            list_network_interfaces,
            list_directory,
            upload_file,
            upload_ai_attachment,
            download_file,
            start_upload_file,
            start_download_file,
            pause_transfer,
            resume_transfer,
            cancel_transfer,
            open_remote_file_in_vscode,
            system_icons::get_system_file_icons,
            create_directory,
            delete_remote_path,
            rename_remote_path,
            compress_remote_path,
            run_ssh_command,
            list_ai_models,
            approve_ai_tool,
            ai_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running Portico SSH");
}

#[cfg(test)]
mod tests {
    use super::{
        ai_endpoint, ai_tool_definitions, ai_tool_is_mutating, ai_tool_mutation_is_authorized,
        api_message_cost, apply_ai_stream_payload, bounded_ai_command, copy_transfer_bytes,
        ensure_remote_revision, estimate_tokens, extract_reasoning_summary, input_token_budget,
        is_high_risk_command, local_transfer_temp_path, mode_string, parse_network_connections,
        parse_network_interfaces, parse_processes, remote_parent_and_name,
        remote_transfer_temp_path, replace_local_file, risk_reasons, shell_quote,
        tool_output_budget, trim_api_messages_for_context, trim_messages_for_context,
        truncate_to_token_budget, AiInputMessage, AiStreamCompletion, AiToolSettings,
        RemoteFileRevision, TransferControl,
    };
    use serde_json::{json, Value};

    #[test]
    fn formats_unix_permissions() {
        assert_eq!(mode_string(Some(0o100755), false), "-rwxr-xr-x");
        assert_eq!(mode_string(Some(0o040750), true), "drwxr-x---");
    }

    #[test]
    fn transfer_control_resumes_and_cancels() {
        let control = TransferControl::new();
        control.pause();
        control.resume();
        assert!(control.wait_until_running().is_ok());

        control.cancel();
        assert_eq!(control.wait_until_running().unwrap_err(), "传输已取消");
    }

    #[test]
    fn transfer_copy_stops_at_a_cancelled_chunk_boundary() {
        let control = TransferControl::new();
        control.cancel();
        let mut source: &[u8] = b"payload";
        let mut target = Vec::new();
        let result = copy_transfer_bytes(
            &mut source,
            &mut target,
            Some(&control),
            "读取失败",
            "写入失败",
        );
        assert_eq!(result.unwrap_err(), "传输已取消");
        assert!(target.is_empty());
    }

    #[test]
    fn commits_transfers_from_sibling_temporary_files() {
        assert_eq!(
            remote_transfer_temp_path("/srv/app.txt", "run-1").unwrap(),
            "/srv/.app.txt.portico-partial-run-1"
        );

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("portico-transfer-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let destination = root.join("download.txt");
        std::fs::write(&destination, b"old").unwrap();
        let temp_path = local_transfer_temp_path(&destination, "run-1");
        std::fs::write(&temp_path, b"complete").unwrap();

        replace_local_file(&temp_path, &destination, "run-1").unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), b"complete");
        assert!(!temp_path.exists());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_remote_editor_revision_conflicts() {
        let expected = RemoteFileRevision {
            size: 12,
            modified: Some(100),
        };
        assert!(ensure_remote_revision(expected, expected).is_ok());
        let error = ensure_remote_revision(
            expected,
            RemoteFileRevision {
                size: 13,
                modified: Some(101),
            },
        )
        .unwrap_err();
        assert!(error.contains("编辑期间发生变化"));
    }

    #[test]
    fn stores_and_reads_namespaced_server_secrets() {
        let id = "keyring-regression-probe".to_string();
        super::store_server_secret(
            id.clone(),
            Some("target-probe".to_string()),
            Some("target-passphrase-probe".to_string()),
            Some("jump-probe".to_string()),
            Some("jump-passphrase-probe".to_string()),
        )
        .expect("keyring probe write failed");
        let target = super::keyring_entry(&format!("server:{id}:password"))
            .expect("keyring target entry failed")
            .get_password()
            .expect("keyring target read failed");
        let jump = super::keyring_entry(&format!("server:{id}:jump:password"))
            .expect("keyring jump entry failed")
            .get_password()
            .expect("keyring jump read failed");
        assert_eq!(target, "target-probe");
        assert_eq!(jump, "jump-probe");
        super::delete_server_secret(id).expect("keyring probe cleanup failed");
    }

    #[test]
    fn removes_saved_ai_key_from_keyring() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let account = format!("ai:key-removal-regression-probe-{nonce}");
        let entry = super::keyring_entry(&account).expect("keyring entry failed");
        entry
            .set_password("ai-key-removal-probe")
            .expect("keyring probe write failed");

        super::delete_ai_key_from_keyring(&account).expect("keyring probe cleanup failed");

        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
    }

    #[test]
    #[ignore = "requires PORTICO_TEST_* SSH credentials and network access"]
    fn connects_through_configured_jump_host() {
        let required = |name: &str| std::env::var(name).expect("missing jump-host test variable");
        let port = |name: &str| required(name).parse::<u16>().expect("invalid test port");
        let server = super::ServerProfile {
            id: "jump-host-integration-test".to_string(),
            host: required("PORTICO_TEST_TARGET_HOST"),
            port: port("PORTICO_TEST_TARGET_PORT"),
            username: required("PORTICO_TEST_TARGET_USERNAME"),
            auth_type: "password".to_string(),
            password: Some(required("PORTICO_TEST_TARGET_PASSWORD")),
            private_key_path: None,
            passphrase: None,
            jump_host: Some(super::JumpHostProfile {
                enabled: true,
                host: required("PORTICO_TEST_JUMP_HOST"),
                port: port("PORTICO_TEST_JUMP_PORT"),
                username: required("PORTICO_TEST_JUMP_USERNAME"),
                auth_type: "password".to_string(),
                password: Some(required("PORTICO_TEST_JUMP_PASSWORD")),
                private_key_path: None,
                passphrase: None,
            }),
        };
        let result = super::run_command_sync(&server, "printf portico-jump-ok")
            .expect("jump-host SSH command failed");
        assert_eq!(result.stdout, "portico-jump-ok");
        assert_eq!(result.exit_code, 0);
    }

    #[test]
    fn quotes_remote_paths_for_compression() {
        assert_eq!(shell_quote("release's files"), "'release'\"'\"'s files'");
        assert_eq!(
            remote_parent_and_name("/srv/releases/app").unwrap(),
            ("/srv/releases", "app")
        );
        assert!(remote_parent_and_name("/").is_err());
    }

    #[test]
    fn blocks_high_risk_ai_commands() {
        assert!(is_high_risk_command("sudo rm -rf /"));
        assert!(is_high_risk_command("sudo rm    -rf /"));
        assert!(is_high_risk_command("sudo\trm\t-rf\t/"));
        assert!(is_high_risk_command("shutdown -h now"));
        assert!(is_high_risk_command("systemctl restart nginx"));
        assert!(risk_reasons("iptables -F")
            .iter()
            .any(|reason| reason.contains("防火墙")));
        assert!(!is_high_risk_command("rm -rf /tmp/old-release"));
    }

    #[test]
    fn preserves_configured_ai_command_timeout_without_upper_cap() {
        assert!(bounded_ai_command("true", 600).contains(" 600s "));
        assert!(bounded_ai_command("true", 1).contains(" 5s "));
    }

    #[test]
    fn exposes_enabled_structured_ai_tools() {
        let settings = AiToolSettings::default();
        let definitions = ai_tool_definitions(&settings);
        let names = definitions
            .iter()
            .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(names.contains(&"execute_command"));
        assert!(names.contains(&"get_system_metrics"));
        assert!(names.contains(&"risk_checker"));
        assert!(!names.contains(&"write_file"));
        assert!(!names.contains(&"pty_interaction"));
    }

    #[test]
    fn blocks_mutation_capable_ai_tools_by_default() {
        let settings = AiToolSettings::default();
        assert!(!settings.allow_mutating_tools);

        let mutation_capable_calls = vec![
            ("execute_command", json!({ "command": "df -h" })),
            ("run_ssh_command", json!({ "command": "uname -a" })),
            (
                "background_task",
                json!({ "action": "start", "command": "sleep 60" }),
            ),
            ("background_task", json!({ "command": "sleep 60" })),
            ("background_task", json!({ "action": "stop", "pid": 42 })),
            (
                "pty_interaction",
                json!({ "command": "passwd", "input": "secret" }),
            ),
            (
                "sftp_download",
                json!({ "remotePath": "/srv/report", "localPath": "C:/tmp/report" }),
            ),
        ];
        for (tool_name, arguments) in mutation_capable_calls {
            assert!(ai_tool_is_mutating(tool_name, &arguments));
            assert!(!ai_tool_mutation_is_authorized(
                &settings, tool_name, &arguments
            ));
        }

        let read_file = json!({ "path": "/etc/hostname" });
        assert!(ai_tool_mutation_is_authorized(
            &settings,
            "read_file",
            &read_file
        ));
    }

    #[test]
    fn extracts_reasoning_summary_from_visible_response() {
        let (content, reasoning) = extract_reasoning_summary(
            "<reasoning_summary>Check disk pressure first.</reasoning_summary>Disk usage is normal.",
        );
        assert_eq!(content, "Disk usage is normal.");
        assert_eq!(reasoning.as_deref(), Some("Check disk pressure first."));
    }

    #[test]
    fn accumulates_streamed_content_reasoning_and_tool_arguments() {
        let mut completion = AiStreamCompletion::default();
        let delta = apply_ai_stream_payload(
            r#"{"choices":[{"delta":{"content":"状态正常","reasoning_content":"已检查"}}]}"#,
            &mut completion,
        )
        .unwrap();
        assert_eq!(delta.content.as_deref(), Some("状态正常"));
        assert_eq!(delta.reasoning.as_deref(), Some("已检查"));

        apply_ai_stream_payload(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"run_ssh_command","arguments":"{\"command\":"}}]}}]}"#,
            &mut completion,
        )
        .unwrap();
        apply_ai_stream_payload(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"df -h\"}"}}]}}]}"#,
            &mut completion,
        )
        .unwrap();

        let message = completion.message();
        assert_eq!(message["content"], "状态正常");
        assert!(message.get("reasoning_content").is_none());
        let first_id = message["tool_calls"][0]["id"].as_str().unwrap();
        assert_eq!(first_id, "call-1");
        assert_eq!(
            message["tool_calls"][0]["function"]["arguments"],
            r#"{"command":"df -h"}"#
        );

        let mut next_completion = AiStreamCompletion::default();
        apply_ai_stream_payload(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"run_ssh_command","arguments":"{}"}}]}}]}"#,
            &mut next_completion,
        )
        .unwrap();
        let next_message = next_completion.message();
        assert_eq!(next_message["tool_calls"][0]["id"], first_id);
    }

    #[test]
    fn parses_responses_stream_text_tool_calls_and_usage() {
        let mut completion = AiStreamCompletion::default();
        apply_ai_stream_payload(
            r#"{"type":"response.output_item.added","response_id":"resp-1","output_index":1,"item":{"type":"function_call","id":"fc-1","call_id":"call-1","name":"execute_command","arguments":""}}"#,
            &mut completion,
        )
        .unwrap();
        apply_ai_stream_payload(
            r#"{"type":"response.function_call_arguments.delta","response_id":"resp-1","output_index":1,"item_id":"fc-1","delta":"{\"command\":\"uptime\"}"}"#,
            &mut completion,
        )
        .unwrap();
        let delta = apply_ai_stream_payload(
            r#"{"type":"response.output_text.delta","response_id":"resp-1","output_index":2,"content_index":0,"item_id":"msg-1","delta":"检查完成"}"#,
            &mut completion,
        )
        .unwrap();
        apply_ai_stream_payload(
            r#"{"type":"response.completed","response":{"id":"resp-1","object":"response","output":[{"type":"reasoning","id":"rs-1","summary":[]},{"type":"function_call","id":"fc-1","call_id":"call-1","name":"execute_command","arguments":"{\"command\":\"uptime\"}"}],"usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150,"input_tokens_details":{"cached_tokens":80},"output_tokens_details":{"reasoning_tokens":10}}}}"#,
            &mut completion,
        )
        .unwrap();

        assert_eq!(delta.content.as_deref(), Some("检查完成"));
        assert_eq!(completion.response_id.as_deref(), Some("resp-1"));
        assert_eq!(completion.content, "检查完成");
        assert_eq!(completion.usage.input_tokens, 120);
        assert_eq!(completion.usage.cached_tokens, 80);
        assert_eq!(completion.usage.reasoning_tokens, 10);
        let output_items = completion.response_output_items();
        assert_eq!(output_items.len(), 2);
        assert_eq!(output_items[0]["type"], "reasoning");
        assert_eq!(output_items[1]["call_id"], "call-1");
        let message = completion.message();
        assert_eq!(message["tool_calls"].as_array().unwrap().len(), 1);
        assert_eq!(message["tool_calls"][0]["id"], "call-1");
        assert_eq!(
            message["tool_calls"][0]["function"]["name"],
            "execute_command"
        );
        assert_eq!(
            message["tool_calls"][0]["function"]["arguments"],
            r#"{"command":"uptime"}"#
        );
    }

    #[test]
    fn parses_responses_stream_error_events() {
        let error = apply_ai_stream_payload(
            r#"{"type":"error","code":"server_error","message":"temporary failure","param":null,"sequence_number":3}"#,
            &mut AiStreamCompletion::default(),
        )
        .unwrap_err();
        assert_eq!(error, "AI 接口返回错误: temporary failure");
    }

    #[test]
    fn rejects_incomplete_responses() {
        let error = apply_ai_stream_payload(
            r#"{"type":"response.incomplete","response":{"id":"resp-incomplete","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}"#,
            &mut AiStreamCompletion::default(),
        )
        .unwrap_err();
        assert_eq!(error, "AI 响应未完成: max_output_tokens");
    }

    #[test]
    fn parses_streamed_refusal_as_visible_content() {
        let mut completion = AiStreamCompletion::default();
        let delta = apply_ai_stream_payload(
            r#"{"choices":[{"delta":{"refusal":"无法协助该请求。"}}]}"#,
            &mut completion,
        )
        .unwrap();
        assert_eq!(delta.content.as_deref(), Some("无法协助该请求。"));
        assert_eq!(completion.content, "无法协助该请求。");
    }

    #[test]
    fn serializes_started_and_finished_tool_stream_updates() {
        let started = serde_json::to_value(super::ai_tool_stream_delta(
            "call-1",
            "started",
            "execute_command",
            "df -h",
            None,
            None,
        ))
        .unwrap();
        let finished = serde_json::to_value(super::ai_tool_stream_delta(
            "call-1",
            "finished",
            "execute_command",
            "df -h",
            Some("disk output"),
            Some(0),
        ))
        .unwrap();

        assert_eq!(started["toolCall"]["id"], "call-1");
        assert_eq!(started["toolCall"]["phase"], "started");
        assert!(started["toolCall"]["output"].is_null());
        assert_eq!(finished["toolCall"]["phase"], "finished");
        assert_eq!(finished["toolCall"]["output"], "disk output");
        assert_eq!(finished["toolCall"]["exitCode"], 0);
    }

    #[test]
    fn serializes_tool_stream_lifecycle_metadata() {
        let started = serde_json::to_value(super::ai_tool_stream_delta(
            "call-lifecycle",
            "started",
            "execute_command",
            "uptime",
            None,
            None,
        ))
        .unwrap();
        let running = serde_json::to_value(super::ai_tool_stream_delta(
            "call-lifecycle",
            "running",
            "execute_command",
            "uptime",
            None,
            None,
        ))
        .unwrap();
        let failed = serde_json::to_value(super::ai_tool_stream_delta(
            "call-lifecycle",
            "error",
            "execute_command",
            "uptime",
            Some("connection lost"),
            Some(1),
        ))
        .unwrap();

        assert_eq!(started["toolCall"]["id"], "call-lifecycle");
        assert_eq!(started["toolCall"]["status"], "started");
        assert!(started["toolCall"]["startedAt"].as_u64().is_some());
        assert_eq!(running["toolCall"]["status"], "running");
        assert!(running["toolCall"]["updatedAt"].as_u64().is_some());
        assert_eq!(failed["toolCall"]["status"], "error");
        assert!(failed["toolCall"]["completedAt"].as_u64().is_some());
    }

    #[test]
    fn serializes_ai_stream_event_types() {
        let mut completion = AiStreamCompletion::default();
        let message_delta = apply_ai_stream_payload(
            r#"{"choices":[{"delta":{"content":"hello"}}]}"#,
            &mut completion,
        )
        .unwrap();
        let message_delta = serde_json::to_value(message_delta).unwrap();
        let action_update = serde_json::to_value(super::ai_tool_stream_delta(
            "call-type",
            "running",
            "execute_command",
            "uptime",
            None,
            None,
        ))
        .unwrap();

        assert_eq!(message_delta["eventType"], "message_delta");
        assert_eq!(action_update["eventType"], "action_update");
    }

    #[test]
    fn captures_streamed_usage_cache_and_reasoning_tokens() {
        let mut completion = AiStreamCompletion::default();
        apply_ai_stream_payload(
            r#"{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":240,"total_tokens":1440,"prompt_tokens_details":{"cached_tokens":900},"completion_tokens_details":{"reasoning_tokens":80}}}"#,
            &mut completion,
        )
        .unwrap();

        assert!(completion.usage.available);
        assert_eq!(completion.usage.input_tokens, 1_200);
        assert_eq!(completion.usage.output_tokens, 240);
        assert_eq!(completion.usage.total_tokens, 1_440);
        assert_eq!(completion.usage.cached_tokens, 900);
        assert_eq!(completion.usage.reasoning_tokens, 80);
        assert_eq!(completion.usage.context_tokens, 1_440);

        let mut aggregate = super::AiTokenUsage::default();
        aggregate.record(completion.usage);
        aggregate.record(super::AiTokenUsage {
            available: true,
            input_tokens: 200,
            output_tokens: 40,
            total_tokens: 240,
            cached_tokens: 100,
            reasoning_tokens: 10,
            context_tokens: 240,
            requests: 1,
        });
        assert_eq!(aggregate.total_tokens, 1_680);
        assert_eq!(aggregate.cached_tokens, 1_000);
        assert_eq!(aggregate.context_tokens, 240);
        assert_eq!(aggregate.requests, 2);
    }

    #[test]
    fn compaction_triggers_near_the_effective_window_and_keeps_recent_turns() {
        let messages = vec![
            AiInputMessage {
                role: "user".into(),
                content: "old goal ".repeat(160),
                reasoning_content: None,
                attachments: Vec::new(),
            },
            AiInputMessage {
                role: "assistant".into(),
                content: "old result ".repeat(160),
                reasoning_content: None,
                attachments: Vec::new(),
            },
            AiInputMessage {
                role: "user".into(),
                content: "recent request ".repeat(160),
                reasoning_content: None,
                attachments: Vec::new(),
            },
            AiInputMessage {
                role: "assistant".into(),
                content: "recent answer ".repeat(160),
                reasoning_content: None,
                attachments: Vec::new(),
            },
        ];
        let split = super::compaction_split_index(&messages, 2_048, 256)
            .expect("compaction should trigger");
        assert!(split >= 2 && split < messages.len());
        assert!(super::compaction_split_index(&messages, 128_000, 4_096).is_none());
    }

    #[test]
    fn compaction_skips_short_histories_and_requires_a_real_turn_boundary() {
        let short_history = vec![
            AiInputMessage {
                role: "user".into(),
                content: "hello".into(),
                reasoning_content: None,
                attachments: Vec::new(),
            },
            AiInputMessage {
                role: "assistant".into(),
                content: "hello back".into(),
                reasoning_content: None,
                attachments: Vec::new(),
            },
        ];
        assert!(super::compaction_split_index(&short_history, 8_192, 4_096).is_none());

        let oversized_single_turn = vec![
            AiInputMessage {
                role: "user".into(),
                content: "request ".repeat(2_000),
                reasoning_content: None,
                attachments: Vec::new(),
            },
            AiInputMessage {
                role: "assistant".into(),
                content: "response ".repeat(2_000),
                reasoning_content: None,
                attachments: Vec::new(),
            },
        ];
        assert!(super::compaction_split_index(&oversized_single_turn, 8_192, 4_096).is_none());
    }

    #[test]
    fn parses_compaction_summary_and_usage() {
        let payload = json!({
            "choices": [{ "message": { "content": "  retained facts  " } }],
            "usage": {
                "prompt_tokens": 320,
                "completion_tokens": 48,
                "total_tokens": 368
            }
        });
        let (summary, usage) = super::parse_compaction_response(&payload).unwrap();
        assert_eq!(summary, "retained facts");
        assert!(usage.available);
        assert_eq!(usage.input_tokens, 320);
        assert_eq!(usage.output_tokens, 48);
        assert_eq!(usage.total_tokens, 368);
        assert_eq!(usage.requests, 1);
    }

    #[test]
    fn parses_responses_compaction_summary_and_usage() {
        let payload = json!({
            "id": "resp-summary",
            "object": "response",
            "output": [{
                "type": "message",
                "content": [{ "type": "output_text", "text": "  retained response facts  " }]
            }],
            "usage": {
                "input_tokens": 280,
                "output_tokens": 40,
                "total_tokens": 320
            }
        });
        let (summary, usage) = super::parse_compaction_response(&payload).unwrap();
        assert_eq!(summary, "retained response facts");
        assert_eq!(usage.input_tokens, 280);
        assert_eq!(usage.output_tokens, 40);
        assert_eq!(usage.total_tokens, 320);
    }

    #[test]
    fn builds_ai_endpoints_from_base_or_chat_url() {
        assert_eq!(
            ai_endpoint("https://api.example.com/v1", "models"),
            "https://api.example.com/v1/models"
        );
        assert_eq!(
            ai_endpoint("https://api.example.com/v1/chat/completions", "models"),
            "https://api.example.com/v1/models"
        );
    }

    #[test]
    fn builds_responses_endpoints_and_tool_definitions() {
        assert_eq!(
            ai_endpoint("https://api.example.com/v1", "responses"),
            "https://api.example.com/v1/responses"
        );
        assert_eq!(
            ai_endpoint("https://api.example.com/v1/responses", "models"),
            "https://api.example.com/v1/models"
        );

        let chat_tools = ai_tool_definitions(&AiToolSettings::default());
        let response_tools = super::responses_tool_definitions(&chat_tools);
        assert!(!response_tools.is_empty());
        assert_eq!(response_tools[0]["type"], "function");
        assert!(response_tools[0].get("function").is_none());
        assert!(response_tools[0]["name"].as_str().is_some());
        assert_eq!(response_tools[0]["strict"], false);
        assert_eq!(
            response_tools[0]["parameters"]["additionalProperties"],
            false
        );

        let input = vec![json!({ "role": "user", "content": "status" })];
        let body = super::responses_stream_body(
            "model",
            "instructions",
            &input,
            0.2,
            512,
            &response_tools,
        );
        assert_eq!(body["store"], false);
        assert!(body.get("previous_response_id").is_none());
        assert_eq!(body["input"], json!(input));
    }

    #[test]
    fn trims_stateless_response_inputs_by_complete_turn() {
        let mut input = vec![
            json!({ "role": "user", "content": "old ".repeat(1_200) }),
            json!({ "role": "assistant", "content": "old response" }),
            json!({ "role": "user", "content": "latest request" }),
            json!({ "type": "reasoning", "id": "rs-latest", "summary": [] }),
            json!({ "type": "function_call", "call_id": "call-latest", "name": "execute_command", "arguments": "{}" }),
            json!({ "type": "function_call_output", "call_id": "call-latest", "output": "ok" }),
        ];

        super::trim_response_inputs_for_context(&mut input, 1_024, "system", &[]).unwrap();

        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"], "latest request");
        assert!(input.iter().any(|item| item["type"] == "reasoning"));
        assert!(input
            .iter()
            .any(|item| item["type"] == "function_call_output"));
        assert!(!input.iter().any(|item| item["content"] == "old response"));
    }

    #[test]
    fn serializes_remote_attachment_references_as_text() {
        let message = AiInputMessage {
            role: "user".into(),
            content: "检查这张图".into(),
            reasoning_content: None,
            attachments: vec![super::AiAttachmentReference {
                kind: "image".into(),
                name: "clipboard.png".into(),
                remote_path: "/tmp/portico-ai-root/pasted-clipboard.png".into(),
                mime_type: "image/png".into(),
                size: 128,
            }],
        };
        let payload = super::ai_input_message_to_api(&message);
        assert_eq!(payload["role"], "user");
        assert!(payload["content"].as_str().unwrap().contains("检查这张图"));
        assert!(payload["content"]
            .as_str()
            .unwrap()
            .contains("/tmp/portico-ai-root/pasted-clipboard.png"));
    }

    #[test]
    fn serializes_reasoning_content_for_assistant_history() {
        let message = AiInputMessage {
            role: "assistant".into(),
            content: "磁盘使用率正常。".into(),
            reasoning_content: Some("已检查磁盘使用率。".into()),
            attachments: Vec::new(),
        };
        let payload = super::ai_input_message_to_api(&message);
        assert_eq!(payload["content"], "磁盘使用率正常。");
        assert!(payload.get("reasoning_content").is_none());
    }

    #[test]
    fn builds_official_openai_token_and_cache_fields() {
        let openai_endpoint = "https://api.openai.com/v1/chat/completions";
        let mut openai_body = json!({});
        super::set_chat_completion_token_limit(&mut openai_body, openai_endpoint, 4096);
        assert_eq!(openai_body["max_completion_tokens"], 4096);
        assert!(openai_body.get("max_tokens").is_none());

        let tools = vec![json!({ "type": "function" })];
        let first_key = super::ai_prompt_cache_key("gpt-test", "stable system prompt", &tools);
        let second_key = super::ai_prompt_cache_key("gpt-test", "stable system prompt", &tools);
        assert_eq!(first_key, second_key);
        assert!(first_key.len() <= 64);

        let mut compatible_body = json!({});
        super::set_chat_completion_token_limit(
            &mut compatible_body,
            "https://api.example.com/v1/chat/completions",
            4096,
        );
        assert_eq!(compatible_body["max_tokens"], 4096);
        assert!(compatible_body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn omits_tool_choice_when_no_tools_are_available() {
        let mut body = json!({});
        super::apply_chat_completion_tools(&mut body, &[]);
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());

        let tools = vec![json!({ "type": "function" })];
        super::apply_chat_completion_tools(&mut body, &tools);
        assert_eq!(body["tools"], Value::Array(tools));
        assert_eq!(body["tool_choice"], "auto");
    }

    #[test]
    fn sanitizes_remote_attachment_names_and_user_directories() {
        assert_eq!(
            super::sanitize_ai_attachment_name("../../日志?.txt"),
            "日志_.txt"
        );
        assert_eq!(
            super::ai_attachment_temp_directory("ops/user"),
            "/tmp/portico-ai-ops_user"
        );
    }

    #[test]
    fn estimates_and_trims_ai_context_from_the_oldest_message() {
        assert_eq!(estimate_tokens("abcd你好"), 3);
        let messages = vec![
            AiInputMessage {
                role: "user".into(),
                content: "a".repeat(4_000),
                reasoning_content: None,
                attachments: Vec::new(),
            },
            AiInputMessage {
                role: "assistant".into(),
                content: "recent".into(),
                reasoning_content: None,
                attachments: Vec::new(),
            },
        ];
        let retained = trim_messages_for_context(messages, 1_024, "system").unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].content, "recent");
    }

    #[test]
    fn rejects_a_latest_message_that_exceeds_the_input_budget() {
        let messages = vec![AiInputMessage {
            role: "user".into(),
            content: "a".repeat(4_000),
            reasoning_content: None,
            attachments: Vec::new(),
        }];
        let error = trim_messages_for_context(messages, 1_024, "system").unwrap_err();
        assert!(error.contains("最新消息超过可用上下文"));
    }

    #[test]
    fn bounds_tool_output_and_keeps_the_latest_tool_turn() {
        let mut messages = vec![
            json!({ "role": "system", "content": "system" }),
            json!({ "role": "user", "content": "old" }),
            json!({ "role": "assistant", "content": "old response" }),
            json!({ "role": "user", "content": "inspect logs" }),
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{ "id": "call-1", "type": "function" }]
            }),
        ];
        let budget = tool_output_budget(&messages, 1_024, "call-1", &[]).unwrap();
        let output = truncate_to_token_budget(&"x".repeat(8_000), budget);
        messages.push(json!({
            "role": "tool",
            "tool_call_id": "call-1",
            "content": format!("exit_code=0\n{output}")
        }));
        trim_api_messages_for_context(&mut messages, 1_024).unwrap();

        assert!(messages.iter().map(api_message_cost).sum::<usize>() <= input_token_budget(1_024));
        assert_eq!(messages[1]["content"], "inspect logs");
        assert!(output.ends_with("...[tool output truncated]"));
    }

    #[test]
    fn parses_process_rows() {
        let rows = parse_processes(
            " 4123 root java 4.7 3.0 117659 java -agentlib:jdwp=transport=dt_socket\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 4123);
        assert_eq!(rows[0].arguments, "java -agentlib:jdwp=transport=dt_socket");
    }

    #[test]
    fn parses_ipv4_and_ipv6_socket_rows() {
        let rows = parse_network_connections(
            "tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=3091128,fd=3))\n\
             tcp ESTAB 0 0 [2001:db8::2]:22 [2001:db8::3]:51002 users:((\"sshd\",pid=889,fd=4))\n",
        );
        assert_eq!(rows[0].local_port, Some(22));
        assert_eq!(rows[0].process.as_deref(), Some("sshd"));
        assert_eq!(rows[1].local_address, "2001:db8::2");
        assert_eq!(rows[1].remote_port, Some(51002));
    }

    #[test]
    fn merges_link_and_address_information() {
        let rows = parse_network_interfaces(
            "2: eth0@if3: <BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state UP mode DEFAULT link/ether 02:42:ac:11:00:02 brd ff:ff:ff:ff:ff:ff\n\
             --ADDR--\n\
             2: eth0 inet 172.17.0.2/16 brd 172.17.255.255 scope global eth0\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "eth0");
        assert_eq!(rows[0].address, "172.17.0.2");
        assert_eq!(rows[0].prefix_length, Some(16));
    }

    #[test]
    fn recognizes_common_vscode_text_files() {
        for name in [
            "Dockerfile",
            ".env.production",
            ".gitignore",
            ".npmrc",
            "app.tsx",
            "config.yaml",
            "service.conf",
            "README",
        ] {
            assert!(
                super::common_text_file_name(name),
                "expected {name} to be editable"
            );
        }
        for name in [
            "release.tar.gz",
            "photo.png",
            "database.sqlite",
            "program.exe",
        ] {
            assert!(
                !super::common_text_file_name(name),
                "expected {name} to remain a download"
            );
        }
    }

    #[test]
    fn sanitizes_remote_names_for_the_local_editor_copy() {
        assert_eq!(
            super::local_editor_name("nginx:prod?.conf"),
            "nginx_prod_.conf"
        );
        assert_eq!(super::local_editor_name("..."), "remote-file.txt");
        assert_eq!(super::local_editor_name(".env"), ".env");
    }
}
