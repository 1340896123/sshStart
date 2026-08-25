mod ai;
mod cloud_sync;
mod crypto;
mod server_transfer;
mod storage;
mod system_icons;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use ssh2::{CheckResult, KnownHostFileKind, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use std::{
    collections::HashMap,
    env,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Condvar, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalUploadFile {
    local_path: String,
    relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalUploadManifest {
    files: Vec<LocalUploadFile>,
    directories: Vec<String>,
    skipped_entries: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct RemoteFileRevision {
    size: u64,
    modified: Option<u64>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskUsage {
    filesystem: String,
    mount_point: String,
    total_bytes: u64,
    used_bytes: u64,
    available_bytes: u64,
    used_percent: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInformation {
    hostname: String,
    operating_system: String,
    kernel: String,
    architecture: String,
    cpu_model: String,
    cpu_cores: u32,
    cpu_usage_percent: f32,
    load_average: Vec<f32>,
    uptime_seconds: u64,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    memory_available_bytes: u64,
    swap_total_bytes: u64,
    swap_used_bytes: u64,
    disks: Vec<DiskUsage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContainerInfo {
    id: String,
    name: String,
    image: String,
    state: String,
    status: String,
    ports: String,
    created_at: String,
    cpu_percent: f32,
    memory_usage_bytes: u64,
    memory_limit_bytes: u64,
    memory_percent: f32,
    network_input_bytes: u64,
    network_output_bytes: u64,
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
static DIAGNOSTIC_LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn diagnostic_log_path() -> PathBuf {
    let root = if cfg!(windows) {
        env::var_os("LOCALAPPDATA")
            .or_else(|| env::var_os("APPDATA"))
            .or_else(|| env::var_os("USERPROFILE"))
    } else {
        env::var_os("XDG_STATE_HOME").or_else(|| env::var_os("HOME"))
    }
    .map(PathBuf::from)
    .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    root.join("Portico SSH").join("logs").join("portico.log")
}

fn append_diagnostic_record(
    source: &str,
    level: &str,
    event: &str,
    fields: serde_json::Value,
) -> Result<PathBuf, String> {
    let path = diagnostic_log_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建诊断日志目录失败: {error}"))?;
    }

    let _guard = DIAGNOSTIC_LOG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| format!("打开诊断日志失败: {error}"))?;
    if file.metadata().map(|metadata| metadata.len()).unwrap_or(0) > 32 * 1024 * 1024 {
        let rotated = path.with_extension("log.1");
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(&path, &rotated);
        file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| format!("创建轮转诊断日志失败: {error}"))?;
    }

    let record = serde_json::json!({
        "timestampUnixMs": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        "source": source,
        "level": level,
        "event": event,
        "processId": std::process::id(),
        "threadId": format!("{:?}", thread::current().id()),
        "fields": fields,
    });
    let line =
        serde_json::to_string(&record).map_err(|error| format!("序列化诊断日志失败: {error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("写入诊断日志失败: {error}"))?;
    file.flush()
        .map_err(|error| format!("刷新诊断日志失败: {error}"))?;
    Ok(path)
}

fn log_backend_event(level: &str, event: &str, fields: serde_json::Value) {
    if let Err(error) = append_diagnostic_record("backend", level, event, fields) {
        eprintln!("Portico diagnostic log failure: {error}");
    }
}

fn server_log_fields(server: &ServerProfile) -> serde_json::Value {
    serde_json::json!({
        "serverId": server.id,
        "host": server.host,
        "port": server.port,
        "username": server.username,
        "authType": server.auth_type,
        "passwordConfigured": server.password.as_ref().is_some_and(|value| !value.is_empty()),
        "privateKeyConfigured": server.private_key_path.as_ref().is_some_and(|value| !value.is_empty()),
        "passphraseConfigured": server.passphrase.as_ref().is_some_and(|value| !value.is_empty()),
        "jumpHostEnabled": server.jump_host.as_ref().is_some_and(|jump| jump.enabled),
    })
}

fn install_diagnostic_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
            .unwrap_or("unknown panic payload");
        let location = info.location().map(|location| {
            serde_json::json!({
                "file": location.file(),
                "line": location.line(),
                "column": location.column(),
            })
        });
        log_backend_event(
            "fatal",
            "rust.panic",
            serde_json::json!({ "payload": payload, "location": location }),
        );
        previous(info);
    }));
}

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerSecretBundle {
    password: Option<String>,
    passphrase: Option<String>,
    jump_password: Option<String>,
    jump_passphrase: Option<String>,
}

#[tauri::command]
fn load_server_secrets(server_id: String) -> Result<ServerSecretBundle, String> {
    let server_id = server_id.trim();
    if server_id.is_empty() {
        return Err("服务器标识不能为空".to_string());
    }
    Ok(ServerSecretBundle {
        password: read_secret(&format!("server:{server_id}:password")),
        passphrase: read_secret(&format!("server:{server_id}:passphrase")),
        jump_password: read_secret(&format!("server:{server_id}:jump:password")),
        jump_passphrase: read_secret(&format!("server:{server_id}:jump:passphrase")),
    })
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
fn copy_server_secret(source_server_id: String, target_server_id: String) -> Result<(), String> {
    for suffix in ["password", "passphrase", "jump:password", "jump:passphrase"] {
        let source_account = format!("server:{source_server_id}:{suffix}");
        let Some(secret) = read_secret(&source_account) else {
            continue;
        };
        keyring_entry(&format!("server:{target_server_id}:{suffix}"))?
            .set_password(&secret)
            .map_err(|error| format!("复制服务器凭据失败: {error}"))?;
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

#[tauri::command]
fn load_ai_key() -> Result<Option<String>, String> {
    match keyring_entry("ai:api-key")?.get_password() {
        Ok(api_key) => Ok(Some(api_key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取 AI API Key 失败: {error}")),
    }
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

fn section<'a>(output: &'a str, name: &str) -> &'a str {
    let marker = format!("--{name}--");
    let Some((_, remainder)) = output.split_once(&marker) else {
        return "";
    };
    remainder.split("\n--").next().unwrap_or(remainder).trim()
}

fn parse_key_value_lines(output: &str) -> HashMap<String, String> {
    output
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_string(), value.trim_matches('"').to_string()))
        .collect()
}

fn parse_system_information(output: &str) -> Result<SystemInformation, String> {
    let identity = parse_key_value_lines(section(output, "IDENTITY"));
    let cpu = parse_key_value_lines(section(output, "CPU"));
    let memory = parse_key_value_lines(section(output, "MEMORY"));
    let load_average = section(output, "LOAD")
        .split_whitespace()
        .take(3)
        .filter_map(|value| value.parse().ok())
        .collect::<Vec<_>>();
    let disks = section(output, "DISKS")
        .lines()
        .filter_map(|line| {
            let fields = line.split('\t').collect::<Vec<_>>();
            if fields.len() < 6 {
                return None;
            }
            Some(DiskUsage {
                filesystem: fields[0].to_string(),
                total_bytes: fields[1].parse().ok()?,
                used_bytes: fields[2].parse().ok()?,
                available_bytes: fields[3].parse().ok()?,
                used_percent: fields[4].trim_end_matches('%').parse().unwrap_or(0.0),
                mount_point: fields[5..].join(" "),
            })
        })
        .collect();
    let memory_total_bytes = memory
        .get("MemTotal")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        .saturating_mul(1024);
    let memory_available_bytes = memory
        .get("MemAvailable")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        .saturating_mul(1024);
    let swap_total_bytes = memory
        .get("SwapTotal")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        .saturating_mul(1024);
    let swap_free_bytes = memory
        .get("SwapFree")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        .saturating_mul(1024);
    let operating_system = identity
        .get("PRETTY_NAME")
        .cloned()
        .or_else(|| identity.get("NAME").cloned())
        .unwrap_or_else(|| "Linux".to_string());
    let hostname = identity
        .get("HOSTNAME")
        .cloned()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "系统信息缺少主机名".to_string())?;

    Ok(SystemInformation {
        hostname,
        operating_system,
        kernel: identity.get("KERNEL").cloned().unwrap_or_default(),
        architecture: identity.get("ARCH").cloned().unwrap_or_default(),
        cpu_model: cpu.get("MODEL").cloned().unwrap_or_else(|| "Unknown CPU".to_string()),
        cpu_cores: cpu.get("CORES").and_then(|value| value.parse().ok()).unwrap_or(0),
        cpu_usage_percent: cpu.get("USAGE").and_then(|value| value.parse().ok()).unwrap_or(0.0),
        load_average,
        uptime_seconds: section(output, "UPTIME")
            .split_whitespace()
            .next()
            .and_then(|value| value.split('.').next())
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        memory_total_bytes,
        memory_used_bytes: memory_total_bytes.saturating_sub(memory_available_bytes),
        memory_available_bytes,
        swap_total_bytes,
        swap_used_bytes: swap_total_bytes.saturating_sub(swap_free_bytes),
        disks,
    })
}

fn parse_size_bytes(value: &str) -> u64 {
    let value = value.trim();
    let split_at = value
        .find(|character: char| !character.is_ascii_digit() && character != '.')
        .unwrap_or(value.len());
    let amount = value[..split_at].parse::<f64>().unwrap_or(0.0);
    let unit = value[split_at..].trim().to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "b" | "" => 1.0,
        "kb" => 1000.0,
        "mb" => 1000.0_f64.powi(2),
        "gb" => 1000.0_f64.powi(3),
        "tb" => 1000.0_f64.powi(4),
        "kib" => 1024.0,
        "mib" => 1024.0_f64.powi(2),
        "gib" => 1024.0_f64.powi(3),
        "tib" => 1024.0_f64.powi(4),
        _ => 1.0,
    };
    (amount * multiplier).round() as u64
}

fn parse_io_pair(value: &str) -> (u64, u64) {
    value
        .split_once('/')
        .map(|(input, output)| (parse_size_bytes(input), parse_size_bytes(output)))
        .unwrap_or((0, 0))
}

fn parse_containers(output: &str) -> Vec<ContainerInfo> {
    output
        .lines()
        .filter_map(|line| {
            let fields = line.split('\t').collect::<Vec<_>>();
            if fields.len() < 11 {
                return None;
            }
            let (memory_usage_bytes, memory_limit_bytes) = parse_io_pair(fields[7]);
            let (network_input_bytes, network_output_bytes) = parse_io_pair(fields[9]);
            Some(ContainerInfo {
                id: fields[0].to_string(),
                name: fields[1].to_string(),
                image: fields[2].to_string(),
                state: fields[3].to_string(),
                status: fields[4].to_string(),
                ports: fields[5].to_string(),
                created_at: fields[6].to_string(),
                cpu_percent: fields[8].trim_end_matches('%').parse().unwrap_or(0.0),
                memory_usage_bytes,
                memory_limit_bytes,
                memory_percent: fields[10].trim_end_matches('%').parse().unwrap_or(0.0),
                network_input_bytes,
                network_output_bytes,
            })
        })
        .collect()
}

fn validate_container_id(container_id: &str) -> Result<&str, String> {
    if (12..=64).contains(&container_id.len())
        && container_id.chars().all(|character| character.is_ascii_hexdigit())
    {
        Ok(container_id)
    } else {
        Err("容器 ID 格式无效".to_string())
    }
}

// 远程脚本通过 base64 传输后由 Python 执行，避免在 SSH 命令字符串里嵌套引号
// 导致的转义问题。脚本输出与原有解析器兼容的文本格式。
const PYTHON_BOOTSTRAP: &str =
    "import base64,sys;exec(compile(base64.b64decode(sys.argv[1]),\"portico\",\"exec\"))";

const SYSTEM_INFO_SCRIPT: &str = r#"import os
import socket
import time


def put(key, value):
    print("%s=%s" % (key, value))


def read_text(path):
    try:
        with open(path, "r", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def uname_field(name):
    try:
        return getattr(os.uname(), name)
    except Exception:
        return ""


def hostname():
    value = read_text("/proc/sys/kernel/hostname").strip()
    if value:
        return value
    try:
        return socket.gethostname()
    except OSError:
        return uname_field("nodename")


def cpu_ticks():
    content = read_text("/proc/stat")
    line = content.splitlines()[0] if content else ""
    fields = line.split()[1:] if line else []
    values = [int(value) for value in fields[:8]]
    while len(values) < 8:
        values.append(0)
    return values


print("--IDENTITY--")
put("HOSTNAME", hostname())
put("KERNEL", read_text("/proc/sys/kernel/osrelease").strip() or uname_field("release"))
put("ARCH", uname_field("machine"))
os_release = {}
for line in read_text("/etc/os-release").splitlines():
    if "=" in line:
        key, _, value = line.partition("=")
        os_release[key] = value.strip().strip('"').strip("'")
if os_release.get("PRETTY_NAME"):
    put("PRETTY_NAME", os_release["PRETTY_NAME"])
elif os_release.get("NAME"):
    put("NAME", os_release["NAME"])

print("--CPU--")
model = ""
for line in read_text("/proc/cpuinfo").splitlines():
    stripped = line.strip()
    if stripped.startswith("model name") or stripped.startswith("Hardware"):
        model = stripped.split(":", 1)[1].strip()
        break
put("MODEL", model or "Unknown CPU")
put("CORES", os.cpu_count() or 0)

first = cpu_ticks()
time.sleep(0.2)
second = cpu_ticks()
total_delta = sum(second) - sum(first)
idle_delta = (second[3] + second[4]) - (first[3] + first[4])
usage = (total_delta - idle_delta) * 100.0 / total_delta if total_delta > 0 else 0.0
put("USAGE", "%.1f" % usage)

print("--LOAD--")
print(read_text("/proc/loadavg").strip() or "0.00 0.00 0.00")

print("--UPTIME--")
print(read_text("/proc/uptime").strip() or "0 0")

print("--MEMORY--")
for line in read_text("/proc/meminfo").splitlines():
    if line.startswith(("MemTotal:", "MemAvailable:", "SwapTotal:", "SwapFree:")):
        key, _, value = line.partition(":")
        print("%s=%s" % (key, value.strip().split()[0]))

print("--DISKS--")
skip_filesystems = {
    "tmpfs", "devtmpfs", "proc", "sysfs", "cgroup", "cgroup2", "overlay",
    "squashfs", "iso9660", "devpts", "mqueue", "securityfs", "debugfs",
    "tracefs", "pstore", "bpf", "hugetlbfs", "ramfs", "fusectl", "configfs",
}
seen_mounts = set()
for line in read_text("/proc/mounts").splitlines():
    fields = line.split()
    if len(fields) < 3:
        continue
    device, mount_point, filesystem = fields[0], fields[1], fields[2]
    if filesystem in skip_filesystems or mount_point in seen_mounts:
        continue
    try:
        stats = os.statvfs(mount_point)
    except OSError:
        continue
    total = stats.f_blocks * stats.f_frsize
    if total <= 0:
        continue
    used = (stats.f_blocks - stats.f_bfree) * stats.f_frsize
    available = stats.f_bavail * stats.f_frsize
    percent = used * 100.0 / total
    print("%s\t%d\t%d\t%d\t%.0f%%\t%s" % (
        device.replace("\\040", " "),
        total,
        used,
        available,
        percent,
        mount_point.replace("\\040", " "),
    ))
    seen_mounts.add(mount_point)
"#;

const DOCKER_LIST_SCRIPT: &str = r#"import subprocess
import sys


def run_docker(arguments):
    try:
        return subprocess.run(
            ["docker"] + arguments,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError:
        return None


ps_format = "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}"
listing = run_docker(["ps", "-a", "--no-trunc", "--format", ps_format])
if listing is None:
    sys.stderr.write("未安装 Docker 或 docker 不在 PATH 中\n")
    sys.exit(127)
if listing.returncode != 0:
    sys.stderr.write(listing.stderr or "docker ps 执行失败\n")
    sys.exit(listing.returncode)

stats_format = "{{.ID}}\t{{.MemUsage}}\t{{.CPUPerc}}\t{{.NetIO}}\t{{.MemPerc}}"
sampling = run_docker(["stats", "--no-stream", "--no-trunc", "--format", stats_format])
metrics = {}
if sampling is not None and sampling.returncode == 0:
    for line in sampling.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) >= 5 and fields[0]:
            metrics[fields[0]] = fields[1:5]

for line in listing.stdout.splitlines():
    if not line:
        continue
    fields = line.split("\t")
    if not fields or not fields[0]:
        continue
    extra = metrics.get(fields[0])
    if extra:
        print(line + "\t" + "\t".join(extra))
    else:
        print(line + "\t0B / 0B\t0%\t0B / 0B\t0%")
"#;

fn run_remote_script(server: &ServerProfile, script: &str, label: &str) -> Result<String, String> {
    let encoded = BASE64_STANDARD.encode(script.as_bytes());
    let command = format!(
        "python3 -c '{PYTHON_BOOTSTRAP}' '{encoded}' || python -c '{PYTHON_BOOTSTRAP}' '{encoded}'"
    );
    let result = run_command_sync(server, &command)?;
    successful_output(result, label)
}

#[tauri::command]
async fn get_system_information(server: ServerProfile) -> Result<SystemInformation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_remote_script(&server, SYSTEM_INFO_SCRIPT, "读取系统信息")?;
        parse_system_information(&output)
    })
    .await
    .map_err(|error| format!("系统信息查询任务失败: {error}"))?
}

#[tauri::command]
async fn list_containers(server: ServerProfile) -> Result<Vec<ContainerInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_remote_script(&server, DOCKER_LIST_SCRIPT, "读取容器列表")?;
        Ok(parse_containers(&output))
    })
    .await
    .map_err(|error| format!("容器查询任务失败: {error}"))?
}

#[tauri::command]
async fn control_container(
    server: ServerProfile,
    container_id: String,
    action: String,
) -> Result<(), String> {
    validate_container_id(&container_id)?;
    let docker_action = match action.as_str() {
        "start" => "start",
        "stop" => "stop",
        "restart" => "restart",
        "remove" => "rm",
        _ => return Err("不支持的容器动作".to_string()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_command_sync(&server, &format!("docker {docker_action} {container_id}"))?;
        successful_output(result, "执行容器动作").map(|_| ())
    })
    .await
    .map_err(|error| format!("容器动作任务失败: {error}"))?
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
fn get_diagnostic_log_path() -> String {
    diagnostic_log_path().to_string_lossy().into_owned()
}

#[tauri::command]
fn write_diagnostic_log(entry: String) -> Result<String, String> {
    let parsed = serde_json::from_str::<serde_json::Value>(&entry)
        .unwrap_or_else(|_| serde_json::json!({ "message": entry }));
    let level = parsed
        .get("level")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("info")
        .to_string();
    let event = parsed
        .get("event")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("frontend.event")
        .to_string();
    append_diagnostic_record("frontend", &level, &event, parsed)
        .map(|path| path.to_string_lossy().into_owned())
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
    let server_fields = server_log_fields(&server);
    log_backend_event(
        "info",
        "terminal.start.requested",
        serde_json::json!({
            "sessionId": session_id,
            "cols": cols,
            "rows": rows,
            "server": server_fields,
        }),
    );
    if manager
        .terminals
        .lock()
        .map_err(|_| "终端状态锁已损坏")?
        .contains_key(&session_id)
    {
        log_backend_event(
            "warn",
            "terminal.start.duplicate",
            serde_json::json!({ "sessionId": session_id }),
        );
        return Ok(());
    }

    let session = match tauri::async_runtime::spawn_blocking(move || connect_ssh(&server)).await {
        Ok(Ok(session)) => {
            log_backend_event(
                "info",
                "terminal.ssh.connected",
                serde_json::json!({ "sessionId": session_id, "server": server_fields }),
            );
            session
        }
        Ok(Err(error)) => {
            log_backend_event(
                "error",
                "terminal.ssh.connect_failed",
                serde_json::json!({
                    "sessionId": session_id,
                    "server": server_fields,
                    "error": error,
                }),
            );
            return Err(error);
        }
        Err(error) => {
            let message = format!("连接任务失败: {error}");
            log_backend_event(
                "error",
                "terminal.ssh.connect_task_failed",
                serde_json::json!({
                    "sessionId": session_id,
                    "server": server_fields,
                    "error": message,
                }),
            );
            return Err(message);
        }
    };
    let (sender, receiver) = mpsc::channel::<TerminalRequest>();
    manager
        .terminals
        .lock()
        .map_err(|_| "终端状态锁已损坏")?
        .insert(session_id.clone(), sender);
    log_backend_event(
        "info",
        "terminal.worker.registered",
        serde_json::json!({ "sessionId": session_id }),
    );

    let worker_session_id = session_id.clone();
    let event_session_id = session_id.clone();
    thread::spawn(move || {
        let event_name = format!("terminal-output-{event_session_id}");
        let started_at = Instant::now();
        let mut input_count = 0_u64;
        let mut input_bytes = 0_u64;
        let mut resize_count = 0_u64;
        let mut output_chunks = 0_u64;
        let mut output_bytes = 0_u64;
        log_backend_event(
            "info",
            "terminal.worker.started",
            serde_json::json!({ "sessionId": worker_session_id, "eventName": event_name }),
        );
        let result = (|| -> Result<(), String> {
            let mut channel = session
                .channel_session()
                .map_err(|error| format!("无法创建终端通道: {error}"))?;
            log_backend_event(
                "info",
                "terminal.channel.created",
                serde_json::json!({ "sessionId": worker_session_id }),
            );
            channel
                .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
                .map_err(|error| format!("PTY 请求失败: {error}"))?;
            log_backend_event(
                "info",
                "terminal.pty.requested",
                serde_json::json!({ "sessionId": worker_session_id, "cols": cols, "rows": rows }),
            );
            channel
                .shell()
                .map_err(|error| format!("Shell 启动失败: {error}"))?;
            log_backend_event(
                "info",
                "terminal.shell.started",
                serde_json::json!({ "sessionId": worker_session_id }),
            );
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
                            input_count += 1;
                            input_bytes += bytes.len() as u64;
                            if input_count <= 5 || input_count % 100 == 0 {
                                log_backend_event(
                                    "debug",
                                    "terminal.input.received",
                                    serde_json::json!({
                                        "sessionId": worker_session_id,
                                        "count": input_count,
                                        "bytes": bytes.len(),
                                        "totalBytes": input_bytes,
                                    }),
                                );
                            }
                            channel
                                .write_all(&bytes)
                                .map_err(|error| format!("终端写入失败: {error}"))?;
                            channel.flush().ok();
                        }
                        TerminalRequest::Resize(next_cols, next_rows) => {
                            resize_count += 1;
                            log_backend_event(
                                "debug",
                                "terminal.resize.received",
                                serde_json::json!({
                                    "sessionId": worker_session_id,
                                    "count": resize_count,
                                    "cols": next_cols,
                                    "rows": next_rows,
                                }),
                            );
                            channel
                                .request_pty_size(next_cols, next_rows, None, None)
                                .map_err(|error| format!("终端尺寸更新失败: {error}"))?;
                        }
                        TerminalRequest::Stop => {
                            log_backend_event(
                                "info",
                                "terminal.stop.received",
                                serde_json::json!({ "sessionId": worker_session_id }),
                            );
                            channel.close().ok();
                            return Ok(());
                        }
                    }
                }

                match channel.read(&mut buffer) {
                    Ok(0) if channel.eof() => {
                        log_backend_event(
                            "info",
                            "terminal.channel.eof",
                            serde_json::json!({ "sessionId": worker_session_id }),
                        );
                        return Ok(());
                    }
                    Ok(0) => thread::sleep(Duration::from_millis(8)),
                    Ok(read) => {
                        output_chunks += 1;
                        output_bytes += read as u64;
                        let output = String::from_utf8_lossy(&buffer[..read]).into_owned();
                        if let Err(error) = app.emit(&event_name, output) {
                            log_backend_event(
                                "error",
                                "terminal.output.emit_failed",
                                serde_json::json!({
                                    "sessionId": worker_session_id,
                                    "error": error.to_string(),
                                    "chunks": output_chunks,
                                    "bytes": output_bytes,
                                }),
                            );
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(8));
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
        })();

        match result {
            Ok(()) => log_backend_event(
                "info",
                "terminal.worker.completed",
                serde_json::json!({
                    "sessionId": worker_session_id,
                    "elapsedMs": started_at.elapsed().as_millis(),
                    "inputCount": input_count,
                    "inputBytes": input_bytes,
                    "resizeCount": resize_count,
                    "outputChunks": output_chunks,
                    "outputBytes": output_bytes,
                }),
            ),
            Err(error) => {
                log_backend_event(
                    "error",
                    "terminal.worker.failed",
                    serde_json::json!({
                        "sessionId": worker_session_id,
                        "elapsedMs": started_at.elapsed().as_millis(),
                        "inputCount": input_count,
                        "inputBytes": input_bytes,
                        "resizeCount": resize_count,
                        "outputChunks": output_chunks,
                        "outputBytes": output_bytes,
                        "error": error,
                    }),
                );
                if let Err(emit_error) =
                    app.emit(&event_name, format!("\r\n\x1b[31m{error}\x1b[0m\r\n"))
                {
                    log_backend_event(
                        "error",
                        "terminal.worker.error_emit_failed",
                        serde_json::json!({
                            "sessionId": worker_session_id,
                            "error": emit_error.to_string(),
                        }),
                    );
                }
            }
        }
    });
    log_backend_event(
        "info",
        "terminal.start.completed",
        serde_json::json!({ "sessionId": session_id }),
    );
    Ok(())
}

#[tauri::command]
fn terminal_input(
    manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let data_length = data.len();
    let terminals = manager.terminals.lock().map_err(|_| "终端状态锁已损坏")?;
    let result = terminals
        .get(&session_id)
        .ok_or_else(|| "终端会话不存在".to_string())?
        .send(TerminalRequest::Input(data.into_bytes()))
        .map_err(|_| "终端会话已经关闭".to_string());
    if data_length > 1 || result.is_err() {
        log_backend_event(
            if result.is_err() { "warn" } else { "debug" },
            "terminal.input.forwarded",
            serde_json::json!({
                "sessionId": session_id,
                "bytes": data_length,
                "success": result.is_ok(),
                "error": result.as_ref().err(),
            }),
        );
    }
    result
}

#[tauri::command]
fn terminal_resize(
    manager: State<'_, TerminalManager>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let terminals = manager.terminals.lock().map_err(|_| "终端状态锁已损坏")?;
    let result = if let Some(sender) = terminals.get(&session_id) {
        sender
            .send(TerminalRequest::Resize(cols, rows))
            .map_err(|_| "终端会话已经关闭".to_string())
    } else {
        Ok(())
    };
    if result.is_err() {
        log_backend_event(
            "warn",
            "terminal.resize.failed",
            serde_json::json!({
                "sessionId": session_id,
                "cols": cols,
                "rows": rows,
                "error": result.as_ref().err(),
            }),
        );
    }
    result
}

#[tauri::command]
fn stop_terminal(manager: State<'_, TerminalManager>, session_id: String) -> Result<(), String> {
    let sender = manager
        .terminals
        .lock()
        .map_err(|_| "终端状态锁已损坏")?
        .remove(&session_id);
    let removed = sender.is_some();
    let send_result = sender.map(|sender| sender.send(TerminalRequest::Stop));
    log_backend_event(
        "info",
        "terminal.stop.requested",
        serde_json::json!({
            "sessionId": session_id,
            "removed": removed,
            "sent": send_result.as_ref().is_some_and(Result::is_ok),
        }),
    );
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

const MAX_LOCAL_UPLOAD_FILES: usize = 5_000;
const MAX_LOCAL_UPLOAD_DIRECTORIES: usize = 10_000;

fn local_upload_name(path: &Path) -> Result<String, String> {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("无法确定拖入项的名称：{}", path.display()))?;
    Ok(name)
}

fn local_upload_child_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn is_local_upload_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

fn reserve_local_upload_path(
    occupied: &mut HashMap<String, bool>,
    relative_path: &str,
    is_dir: bool,
) -> Result<(), String> {
    if let Some(existing_is_dir) = occupied.insert(relative_path.to_string(), is_dir) {
        let existing_kind = if existing_is_dir {
            "文件夹"
        } else {
            "文件"
        };
        let next_kind = if is_dir { "文件夹" } else { "文件" };
        return Err(format!(
            "拖入内容存在目标路径冲突：{relative_path}（{existing_kind} 与 {next_kind}）"
        ));
    }
    Ok(())
}

fn collect_local_upload_manifest_sync(paths: Vec<String>) -> Result<LocalUploadManifest, String> {
    if paths.is_empty() {
        return Err("没有可上传的本地文件或文件夹".to_string());
    }

    let mut roots = paths
        .into_iter()
        .map(|value| {
            let path = PathBuf::from(value);
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("无法读取拖入项 {}：{error}", path.display()))?;
            if is_local_upload_link(&metadata) {
                return Err(format!("不支持上传符号链接：{}", path.display()));
            }
            if !metadata.is_file() && !metadata.is_dir() {
                return Err(format!("只支持普通文件和文件夹：{}", path.display()));
            }
            let canonical = fs::canonicalize(&path)
                .map_err(|error| format!("无法解析拖入项 {}：{error}", path.display()))?;
            Ok((path, canonical, metadata.is_dir()))
        })
        .collect::<Result<Vec<_>, String>>()?;
    roots.sort_by(|left, right| {
        left.1
            .components()
            .count()
            .cmp(&right.1.components().count())
            .then_with(|| right.2.cmp(&left.2))
            .then_with(|| left.1.cmp(&right.1))
    });

    let mut accepted_directories = Vec::<PathBuf>::new();
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut occupied = HashMap::<String, bool>::new();
    let mut skipped_entries = 0usize;

    for (root, canonical, is_dir) in roots {
        if accepted_directories
            .iter()
            .any(|directory| canonical.starts_with(directory))
        {
            skipped_entries = skipped_entries.saturating_add(1);
            continue;
        }

        let root_name = local_upload_name(&root)?;
        if is_dir {
            if directories.len() >= MAX_LOCAL_UPLOAD_DIRECTORIES {
                return Err(format!(
                    "拖入目录超过 {MAX_LOCAL_UPLOAD_DIRECTORIES} 个文件夹限制"
                ));
            }
            accepted_directories.push(canonical);
            reserve_local_upload_path(&mut occupied, &root_name, true)?;
            directories.push(root_name.clone());
            let mut pending = vec![(root, root_name)];
            while let Some((directory, relative_directory)) = pending.pop() {
                let mut entries = fs::read_dir(&directory)
                    .map_err(|error| format!("无法读取本地目录 {}：{error}", directory.display()))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| {
                        format!("无法读取本地目录 {}：{error}", directory.display())
                    })?;
                entries.sort_by(|left, right| {
                    left.file_name()
                        .to_string_lossy()
                        .to_lowercase()
                        .cmp(&right.file_name().to_string_lossy().to_lowercase())
                });
                for entry in entries.into_iter().rev() {
                    let file_type = entry.file_type().map_err(|error| {
                        format!("无法读取本地项 {}：{error}", entry.path().display())
                    })?;
                    let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
                        format!("无法读取本地项 {}：{error}", entry.path().display())
                    })?;
                    if file_type.is_symlink() || is_local_upload_link(&metadata) {
                        skipped_entries = skipped_entries.saturating_add(1);
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let relative_path = local_upload_child_path(&relative_directory, &name);
                    if file_type.is_dir() {
                        if directories.len() >= MAX_LOCAL_UPLOAD_DIRECTORIES {
                            return Err(format!(
                                "拖入目录超过 {MAX_LOCAL_UPLOAD_DIRECTORIES} 个文件夹限制"
                            ));
                        }
                        reserve_local_upload_path(&mut occupied, &relative_path, true)?;
                        directories.push(relative_path.clone());
                        pending.push((entry.path(), relative_path));
                    } else if file_type.is_file() {
                        if files.len() >= MAX_LOCAL_UPLOAD_FILES {
                            return Err(format!(
                                "拖入内容超过 {MAX_LOCAL_UPLOAD_FILES} 个文件限制，请分批上传"
                            ));
                        }
                        reserve_local_upload_path(&mut occupied, &relative_path, false)?;
                        files.push(LocalUploadFile {
                            local_path: entry.path().to_string_lossy().into_owned(),
                            relative_path,
                        });
                    } else {
                        skipped_entries = skipped_entries.saturating_add(1);
                    }
                }
            }
        } else {
            if files.len() >= MAX_LOCAL_UPLOAD_FILES {
                return Err(format!(
                    "拖入内容超过 {MAX_LOCAL_UPLOAD_FILES} 个文件限制，请分批上传"
                ));
            }
            reserve_local_upload_path(&mut occupied, &root_name, false)?;
            files.push(LocalUploadFile {
                local_path: root.to_string_lossy().into_owned(),
                relative_path: root_name,
            });
        }
    }

    directories.sort_by(|left, right| {
        left.matches('/')
            .count()
            .cmp(&right.matches('/').count())
            .then_with(|| left.to_lowercase().cmp(&right.to_lowercase()))
    });
    files.sort_by(|left, right| {
        left.relative_path
            .to_lowercase()
            .cmp(&right.relative_path.to_lowercase())
    });
    Ok(LocalUploadManifest {
        files,
        directories,
        skipped_entries,
    })
}

#[tauri::command]
async fn collect_local_upload_manifest(paths: Vec<String>) -> Result<LocalUploadManifest, String> {
    tauri::async_runtime::spawn_blocking(move || collect_local_upload_manifest_sync(paths))
        .await
        .map_err(|error| format!("读取本地上传内容失败: {error}"))?
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
            rename_overwrite(&sftp, Path::new(&temp_path), Path::new(&remote_path))
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

const MAX_EDITOR_FILE_SIZE: u64 = 20 * 1024 * 1024;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFileContent {
    content: String,
    revision: RemoteFileRevision,
}

#[tauri::command]
async fn read_remote_file(
    server: ServerProfile,
    remote_path: String,
) -> Result<RemoteFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&server)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("SFTP 初始化失败: {error}"))?;
        let initial_revision = remote_file_revision(&sftp, &remote_path)?;
        if initial_revision.size > MAX_EDITOR_FILE_SIZE {
            return Err(format!(
                "文件超过编辑上限（{} MB）",
                MAX_EDITOR_FILE_SIZE / 1024 / 1024
            ));
        }
        let mut source = sftp
            .open(Path::new(&remote_path))
            .map_err(|error| format!("打开远程文件失败: {error}"))?;
        let mut bytes = Vec::new();
        source
            .read_to_end(&mut bytes)
            .map_err(|error| format!("读取远程文件失败: {error}"))?;
        if bytes.len() as u64 > MAX_EDITOR_FILE_SIZE {
            return Err(format!(
                "文件超过编辑上限（{} MB）",
                MAX_EDITOR_FILE_SIZE / 1024 / 1024
            ));
        }
        let downloaded_revision = remote_file_revision(&sftp, &remote_path)?;
        ensure_remote_revision(initial_revision, downloaded_revision)?;
        Ok(RemoteFileContent {
            content: String::from_utf8_lossy(&bytes).into_owned(),
            revision: downloaded_revision,
        })
    })
    .await
    .map_err(|error| format!("读取远程文件任务失败: {error}"))?
}

fn editor_remote_temp_path(remote_path: &str) -> Result<String, String> {
    let (parent, name) = remote_parent_and_name(remote_path)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(format!("{parent}/.{name}.portico-edit-{nonce}"))
}

fn rename_overwrite(sftp: &ssh2::Sftp, temp_path: &Path, remote_path: &Path) -> Result<(), String> {
    if sftp.rename(temp_path, remote_path, Some(RenameFlags::OVERWRITE)).is_ok() {
        return Ok(());
    }
    // 部分 SFTP 服务器不支持覆盖式（POSIX）rename，先删除目标再普通 rename。
    sftp.unlink(remote_path)
        .map_err(|error| format!("提交远程文件失败（无法覆盖已有文件）: {error}"))?;
    sftp.rename(temp_path, remote_path, None)
        .map_err(|error| format!("提交远程文件失败: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn write_remote_file(
    server: ServerProfile,
    remote_path: String,
    content: String,
) -> Result<RemoteFileRevision, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&server)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("SFTP 初始化失败: {error}"))?;
        let temp_path = editor_remote_temp_path(&remote_path)?;
        let original_permissions = sftp.stat(Path::new(&remote_path)).ok().and_then(|stat| stat.perm);
        let result = (|| -> Result<RemoteFileRevision, String> {
            let mut target = sftp
                .create(Path::new(&temp_path))
                .map_err(|error| format!("创建远程临时文件失败: {error}"))?;
            target
                .write_all(content.as_bytes())
                .map_err(|error| format!("写入远程文件失败: {error}"))?;
            target
                .flush()
                .map_err(|error| format!("提交远程文件失败: {error}"))?;
            drop(target);
            rename_overwrite(&sftp, Path::new(&temp_path), Path::new(&remote_path))?;
            // 临时文件以默认权限创建，提交后恢复原文件的权限（如执行位），失败不影响保存结果。
            if let Some(perm) = original_permissions {
                sftp.setstat(
                    Path::new(&remote_path),
                    ssh2::FileStat {
                        size: None,
                        uid: None,
                        gid: None,
                        perm: Some(perm),
                        atime: None,
                        mtime: None,
                    },
                )
                .ok();
            }
            remote_file_revision(&sftp, &remote_path)
        })();
        if result.is_err() {
            sftp.unlink(Path::new(&temp_path)).ok();
        }
        result
    })
    .await
    .map_err(|error| format!("保存远程文件任务失败: {error}"))?
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
async fn create_directories(server: ServerProfile, mut paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths.sort_by(|left, right| {
            left.matches('/')
                .count()
                .cmp(&right.matches('/').count())
                .then_with(|| left.cmp(right))
        });
        paths.dedup();
        let session = connect_ssh(&server)?;
        let sftp = session
            .sftp()
            .map_err(|error| format!("SFTP 初始化失败: {error}"))?;
        for path in paths {
            if path == "/" {
                continue;
            }
            if !path.starts_with('/') {
                return Err(format!("远程目录必须是绝对路径：{path}"));
            }
            let remote_path = Path::new(&path);
            if let Ok(stat) = sftp.stat(remote_path) {
                if stat.perm.unwrap_or(0) & 0o170000 != 0o040000 {
                    return Err(format!("远程路径已被文件占用：{path}"));
                }
                continue;
            }
            if let Err(error) = sftp.mkdir(remote_path, 0o755) {
                let created_by_other = sftp
                    .stat(remote_path)
                    .is_ok_and(|stat| stat.perm.unwrap_or(0) & 0o170000 == 0o040000);
                if !created_by_other {
                    return Err(format!("创建远程目录 {path} 失败: {error}"));
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("批量创建目录任务失败: {error}"))?
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_diagnostic_panic_hook();
    log_backend_event(
        "info",
        "runtime.starting",
        serde_json::json!({
            "logPath": diagnostic_log_path().to_string_lossy(),
            "debugBuild": cfg!(debug_assertions),
        }),
    );
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let database =
                storage::AppDatabase::initialize(app.handle()).map_err(std::io::Error::other)?;
            app.manage(database);
            Ok(())
        })
        .manage(TerminalManager::default())
        .manage(TransferManager::default())
        .manage(ai::AiRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            store_server_secret,
            load_server_secrets,
            copy_server_secret,
            delete_server_secret,
            store_ai_key,
            load_ai_key,
            delete_ai_key,
            cloud_sync::sync_register,
            cloud_sync::sync_login,
            cloud_sync::sync_status,
            cloud_sync::sync_logout,
            cloud_sync::sync_push,
            cloud_sync::sync_pull,
            cloud_sync::sync_clear_cloud_data,
            cloud_sync::sync_list_key_files,
            cloud_sync::sync_upload_keys,
            cloud_sync::sync_download_keys,
            storage::load_app_state,
            storage::save_servers,
            storage::save_deleted_server_ids,
            storage::save_server_groups,
            storage::save_ai_config,
            storage::save_ai_conversations,
            storage::save_collapsed_groups,
            storage::save_sync_metadata,
            server_transfer::read_server_import_file,
            server_transfer::write_server_export_file,
            get_diagnostic_log_path,
            write_diagnostic_log,
            start_terminal,
            terminal_input,
            terminal_resize,
            stop_terminal,
            list_processes,
            signal_process,
            list_network_connections,
            list_network_interfaces,
            get_system_information,
            list_containers,
            control_container,
            list_directory,
            collect_local_upload_manifest,
            upload_file,
            upload_ai_attachment,
            download_file,
            start_upload_file,
            start_download_file,
            pause_transfer,
            resume_transfer,
            cancel_transfer,
            read_remote_file,
            write_remote_file,
            system_icons::get_system_file_icons,
            create_directory,
            create_directories,
            delete_remote_path,
            rename_remote_path,
            compress_remote_path,
            run_ssh_command,
            ai::list_rig_models,
            ai::review_ai_approval,
            ai::cancel_ai_run,
            ai::resolve_ai_approval,
            ai::run_ai_agent,
            ai::import::parse_ai_server_import
        ])
        .run(tauri::generate_context!())
        .expect("error while running Portico SSH");
}

#[cfg(test)]
mod tests {
    use super::{
        collect_local_upload_manifest_sync, copy_transfer_bytes, ensure_remote_revision,
        local_transfer_temp_path, mode_string, parse_containers, parse_network_connections,
        parse_network_interfaces, parse_processes, parse_size_bytes, parse_system_information,
        remote_parent_and_name, remote_transfer_temp_path, replace_local_file, shell_quote,
        RemoteFileRevision, TransferControl,
    };

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
    fn collects_dropped_directories_with_relative_paths() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("portico-upload-manifest-{nonce}"));
        let payload = root.join("payload");
        let nested = payload.join("nested");
        let empty = payload.join("empty");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::write(payload.join("root.txt"), b"root").unwrap();
        std::fs::write(nested.join("app.txt"), b"nested").unwrap();
        let standalone = root.join("standalone.txt");
        std::fs::write(&standalone, b"standalone").unwrap();

        let manifest = collect_local_upload_manifest_sync(vec![
            payload.to_string_lossy().into_owned(),
            standalone.to_string_lossy().into_owned(),
        ])
        .unwrap();

        assert_eq!(
            manifest.directories,
            vec!["payload", "payload/empty", "payload/nested"]
        );
        assert_eq!(
            manifest
                .files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "payload/nested/app.txt",
                "payload/root.txt",
                "standalone.txt"
            ]
        );
        assert_eq!(manifest.skipped_entries, 0);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn skips_a_child_dropped_with_its_parent_directory() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("portico-upload-dedupe-{nonce}"));
        let payload = root.join("payload");
        let nested = payload.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("app.txt"), b"nested").unwrap();

        let manifest = collect_local_upload_manifest_sync(vec![
            nested.to_string_lossy().into_owned(),
            payload.to_string_lossy().into_owned(),
        ])
        .unwrap();

        assert_eq!(manifest.directories, vec!["payload", "payload/nested"]);
        assert_eq!(manifest.files.len(), 1);
        assert_eq!(manifest.files[0].relative_path, "payload/nested/app.txt");
        assert_eq!(manifest.skipped_entries, 1);
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
    fn parses_system_information_sections() {
        let info = parse_system_information(
            "--IDENTITY--\nHOSTNAME=portico\nKERNEL=6.8.0\nARCH=x86_64\nPRETTY_NAME=Ubuntu 24.04 LTS\n\
             --CPU--\nMODEL=AMD EPYC\nCORES=8\nUSAGE=12.5\n\
             --LOAD--\n0.25 0.50 0.75 1/100 1\n\
             --UPTIME--\n90061.42 100.0\n\
             --MEMORY--\nMemTotal=16000000\nMemAvailable=6000000\nSwapTotal=2000000\nSwapFree=1500000\n\
             --DISKS--\n/dev/sda1\t100000000\t40000000\t60000000\t40%\t/\n",
        )
        .unwrap();
        assert_eq!(info.hostname, "portico");
        assert_eq!(info.cpu_cores, 8);
        assert_eq!(info.memory_used_bytes, 10_000_000 * 1024);
        assert_eq!(info.disks[0].mount_point, "/");
    }

    #[test]
    fn parses_container_rows_and_binary_sizes() {
        assert_eq!(parse_size_bytes("1.5GiB"), 1_610_612_736);
        let rows = parse_containers(
            "0123456789abcdef\tapi\tportico/api:latest\trunning\tUp 2 hours\t0.0.0.0:8080->80/tcp\t2026-08-12 10:00:00 +0800 CST\t512MiB / 2GiB\t3.5%\t1.2MB / 800kB\t25%\n",
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "api");
        assert_eq!(rows[0].memory_limit_bytes, 2_147_483_648);
        assert_eq!(rows[0].network_input_bytes, 1_200_000);
    }
}