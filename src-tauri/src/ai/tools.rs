use super::super::{
    CommandResult, ServerProfile, download_file, is_high_risk_command, list_directory,
    list_network_connections, list_network_interfaces, list_processes, risk_reasons,
    run_command_sync, shell_quote, signal_process, upload_file,
};
use rig::tool::{DynamicTool, ToolExecutionError, ToolOutput};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AiToolSettings {
    #[serde(default = "default_true")]
    pub(super) execute_command: bool,
    #[serde(default = "default_true")]
    pub(super) background_task: bool,
    #[serde(default)]
    pub(super) pty_interaction: bool,
    #[serde(default = "default_true")]
    pub(super) read_file: bool,
    #[serde(default)]
    pub(super) write_file: bool,
    #[serde(default)]
    pub(super) sftp_upload: bool,
    #[serde(default = "default_true")]
    pub(super) sftp_download: bool,
    #[serde(default = "default_true")]
    pub(super) list_directory: bool,
    #[serde(default = "default_true")]
    pub(super) get_system_metrics: bool,
    #[serde(default = "default_true")]
    pub(super) process_manager: bool,
    #[serde(default = "default_true")]
    pub(super) network_checker: bool,
    #[serde(default = "default_true")]
    pub(super) docker_manager: bool,
    #[serde(default = "default_true")]
    pub(super) systemd_control: bool,
    #[serde(default = "default_true")]
    pub(super) risk_checker: bool,
    #[serde(default = "default_true")]
    pub(super) snippet_library: bool,
    #[serde(default = "default_true")]
    pub(super) log_analyzer: bool,
    #[serde(default = "default_tool_rounds")]
    pub(super) max_tool_rounds: u32,
    #[serde(default = "default_tool_output_chars")]
    pub(super) max_output_chars: usize,
    #[serde(default = "default_command_timeout_seconds")]
    pub(super) command_timeout_seconds: u32,
    #[serde(default)]
    pub(super) allow_mutating_tools: bool,
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

fn default_true() -> bool {
    true
}

fn default_tool_rounds() -> u32 {
    200
}

fn default_tool_output_chars() -> usize {
    128_000
}

fn default_command_timeout_seconds() -> u32 {
    30
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

fn tool_definitions(settings: &AiToolSettings) -> Vec<Value> {
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

pub(super) fn ai_tool_is_mutating(name: &str, arguments: &Value) -> bool {
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

pub(super) fn ai_tool_command_for_risk(name: &str, arguments: &Value) -> Option<String> {
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

async fn execute_tool(
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


pub(super) fn build_dynamic_tools(
    server: &ServerProfile,
    settings: &AiToolSettings,
) -> Vec<DynamicTool> {
    tool_definitions(settings)
        .into_iter()
        .filter_map(|definition| {
            let function = definition.get("function")?;
            let name = function.get("name")?.as_str()?.to_string();
            let description = function.get("description")?.as_str()?.to_string();
            let parameters = function.get("parameters")?.clone();
            let callback_name = name.clone();
            let server = server.clone();
            let settings = settings.clone();
            Some(DynamicTool::new(
                name,
                description,
                parameters,
                move |_context, arguments| {
                    let server = server.clone();
                    let settings = settings.clone();
                    let tool_name = callback_name.clone();
                    Box::pin(async move {
                        let execution = execute_tool(&tool_name, &arguments, &server, &settings)
                            .await
                            .map_err(ToolExecutionError::provider)?;
                        let output = bounded_tool_output(
                            format!("{}{}", execution.result.stdout, execution.result.stderr),
                            settings.max_output_chars,
                        );
                        Ok(ToolOutput::json(json!({
                            "command": execution.display_command,
                            "output": output,
                            "exitCode": execution.result.exit_code,
                        })))
                    })
                },
            ))
        })
        .collect()
}

pub(super) fn tool_is_allowed(
    settings: &AiToolSettings,
    name: &str,
    arguments: &Value,
) -> bool {
    !ai_tool_is_mutating(name, arguments) || settings.allow_mutating_tools
}

pub(super) fn approval_reason(name: &str, arguments: &Value) -> Option<String> {
    if ai_tool_is_mutating(name, arguments) {
        return Some("该工具会修改远端状态，需要人工确认".to_string());
    }
    let command = ai_tool_command_for_risk(name, arguments)?;
    let reasons = risk_reasons(&command);
    (!reasons.is_empty()).then(|| reasons.join("；"))
}

pub(super) fn display_command(name: &str, arguments: &Value) -> String {
    ai_tool_command_for_risk(name, arguments)
        .unwrap_or_else(|| format!("{name} {}", arguments))
}

fn bounded_tool_output(output: String, limit: usize) -> String {
    if output.chars().count() <= limit {
        return output;
    }
    let mut bounded = output.chars().take(limit).collect::<String>();
    bounded.push_str("\n…[tool output truncated]");
    bounded
}
