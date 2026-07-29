use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ssh2::{CheckResult, KnownHostFileKind, Session};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};
use tauri::{Emitter, State};

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
struct AiConfig {
    endpoint: String,
    api_key: String,
    model: String,
    system_prompt: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AiInputMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiToolResult {
    command: String,
    output: String,
    exit_code: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiResponse {
    content: String,
    reasoning: Option<String>,
    tool_calls: Vec<AiToolResult>,
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

const KEYRING_SERVICE: &str = "com.portico.ssh";
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

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
    if hydrated.passphrase.as_deref().unwrap_or_default().is_empty() {
        hydrated.passphrase = read_secret(&format!("server:{}:passphrase", server.id));
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

fn connect_ssh(server: &ServerProfile) -> Result<Session, String> {
    let server = hydrate_server_secrets(server);
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
                    server.passphrase.as_deref().filter(|value| !value.is_empty()),
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
    Ok(session)
}

#[tauri::command]
fn store_server_secret(
    server_id: String,
    password: Option<String>,
    passphrase: Option<String>,
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
    Ok(())
}

#[tauri::command]
fn delete_server_secret(server_id: String) -> Result<(), String> {
    for suffix in ["password", "passphrase"] {
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
            session.set_blocking(false);
            let mut buffer = [0_u8; 16 * 1024];

            loop {
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
        let sftp = session.sftp().map_err(|error| format!("SFTP 初始化失败: {error}"))?;
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

#[tauri::command]
async fn upload_file(server: ServerProfile, local_path: String, remote_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&server)?;
        let sftp = session.sftp().map_err(|error| format!("SFTP 初始化失败: {error}"))?;
        let mut source = File::open(&local_path).map_err(|error| format!("打开本地文件失败: {error}"))?;
        let mut target = sftp
            .create(Path::new(&remote_path))
            .map_err(|error| format!("创建远程文件失败: {error}"))?;
        std::io::copy(&mut source, &mut target).map_err(|error| format!("上传失败: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("上传任务失败: {error}"))?
}

#[tauri::command]
async fn download_file(server: ServerProfile, remote_path: String, local_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&server)?;
        let sftp = session.sftp().map_err(|error| format!("SFTP 初始化失败: {error}"))?;
        let mut source = sftp
            .open(Path::new(&remote_path))
            .map_err(|error| format!("打开远程文件失败: {error}"))?;
        let mut target = File::create(&local_path).map_err(|error| format!("创建本地文件失败: {error}"))?;
        std::io::copy(&mut source, &mut target).map_err(|error| format!("下载失败: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("下载任务失败: {error}"))?
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
async fn delete_remote_path(server: ServerProfile, path: String, is_dir: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session = connect_ssh(&server)?;
        let sftp = session.sftp().map_err(|error| format!("SFTP 初始化失败: {error}"))?;
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

fn is_high_risk_command(command: &str) -> bool {
    let normalized = command.to_lowercase().replace("  ", " ");
    let root_delete = normalized.split([';', '&', '|']).any(|part| {
        let part = part.trim().strip_prefix("sudo ").unwrap_or(part.trim());
        ["rm -rf /", "rm -fr /"]
            .iter()
            .any(|prefix| part == *prefix || part.starts_with(&format!("{prefix} ")) || part.starts_with(&format!("{prefix}*")))
    });
    root_delete
        || [
            "--no-preserve-root",
            "mkfs",
            "dd if=",
            ":(){",
            "shutdown",
            "reboot",
            "init 0",
            "chmod -r 777 /",
        ]
        .iter()
        .any(|pattern| normalized.contains(pattern))
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

#[tauri::command]
async fn ai_chat(
    config: AiConfig,
    server: ServerProfile,
    messages: Vec<AiInputMessage>,
    allow_execute: bool,
) -> Result<AiResponse, String> {
    let api_key = if config.api_key.trim().is_empty() {
        read_secret("ai:api-key").ok_or_else(|| "未配置 AI API Key，请先打开助手设置".to_string())?
    } else {
        config.api_key.clone()
    };
    let endpoint = if config.endpoint.trim_end_matches('/').ends_with("chat/completions") {
        config.endpoint.clone()
    } else {
        format!("{}/chat/completions", config.endpoint.trim_end_matches('/'))
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| format!("AI 客户端初始化失败: {error}"))?;
    let system = format!(
        "{}\n当前 SSH 目标为 {}@{}:{}。最终回答开头必须使用 <reasoning_summary>...</reasoning_summary> 给出简明的判断依据与执行计划；不要披露隐藏思维链。",
        config.system_prompt, server.username, server.host, server.port
    );
    let mut api_messages = vec![json!({ "role": "system", "content": system })];
    api_messages.extend(messages.into_iter().map(|message| json!(message)));
    let mut executed_tools = Vec::new();

    for _ in 0..4 {
        let mut body = json!({
            "model": config.model,
            "messages": api_messages,
            "temperature": 0.2
        });
        if allow_execute {
            body["tools"] = json!([{
                "type": "function",
                "function": {
                    "name": "run_ssh_command",
                    "description": "在当前 SSH 服务器执行只读或低风险 shell 命令，并返回输出。高风险命令会被本地策略拒绝。",
                    "parameters": {
                        "type": "object",
                        "properties": { "command": { "type": "string", "description": "要执行的完整 shell 命令" } },
                        "required": ["command"],
                        "additionalProperties": false
                    }
                }
            }]);
            body["tool_choice"] = json!("auto");
        }

        let response = client
            .post(&endpoint)
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("AI 请求失败: {error}"))?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|error| format!("AI 响应解析失败: {error}"))?;
        if !status.is_success() {
            let detail = payload
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("未知接口错误");
            return Err(format!("AI 接口返回 {status}: {detail}"));
        }

        let message = payload
            .pointer("/choices/0/message")
            .cloned()
            .ok_or_else(|| "AI 响应缺少 message".to_string())?;
        let tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        if tool_calls.is_empty() {
            let raw_content = message.get("content").and_then(Value::as_str).unwrap_or_default();
            let provider_reasoning = message
                .get("reasoning_content")
                .and_then(Value::as_str)
                .map(str::to_string);
            let (content, summary) = extract_reasoning_summary(raw_content);
            return Ok(AiResponse {
                content,
                reasoning: summary.or(provider_reasoning),
                tool_calls: executed_tools,
            });
        }

        api_messages.push(message.clone());
        for tool_call in tool_calls {
            let id = tool_call.get("id").and_then(Value::as_str).unwrap_or("tool-call");
            let arguments = tool_call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            let parsed: Value = serde_json::from_str(arguments)
                .map_err(|error| format!("工具参数解析失败: {error}"))?;
            let command = parsed
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| "工具调用缺少 command".to_string())?
                .to_string();

            let result = if is_high_risk_command(&command) {
                CommandResult {
                    stdout: String::new(),
                    stderr: "BLOCKED: 高风险命令需要用户通过 /run 显式执行。".to_string(),
                    exit_code: 126,
                }
            } else {
                let server_for_command = server.clone();
                let command_for_task = command.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    run_command_sync(&server_for_command, &command_for_task)
                })
                .await
                .map_err(|error| format!("AI 工具任务失败: {error}"))??
            };
            let output = format!("{}{}", result.stdout, result.stderr);
            executed_tools.push(AiToolResult {
                command: command.clone(),
                output: output.clone(),
                exit_code: result.exit_code,
            });
            api_messages.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": format!("exit_code={}\n{}", result.exit_code, output)
            }));
        }
    }

    Err("AI 工具调用次数超过上限".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TerminalManager::default())
        .invoke_handler(tauri::generate_handler![
            store_server_secret,
            delete_server_secret,
            store_ai_key,
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
            download_file,
            create_directory,
            delete_remote_path,
            rename_remote_path,
            compress_remote_path,
            run_ssh_command,
            ai_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running Portico SSH");
}

#[cfg(test)]
mod tests {
    use super::{
        extract_reasoning_summary, is_high_risk_command, mode_string, parse_network_connections,
        parse_network_interfaces, parse_processes, remote_parent_and_name, shell_quote,
    };

    #[test]
    fn formats_unix_permissions() {
        assert_eq!(mode_string(Some(0o100755), false), "-rwxr-xr-x");
        assert_eq!(mode_string(Some(0o040750), true), "drwxr-x---");
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
        assert!(is_high_risk_command("shutdown -h now"));
        assert!(!is_high_risk_command("rm -rf /tmp/old-release"));
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
}
