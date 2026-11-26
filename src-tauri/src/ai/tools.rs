use super::super::{risk_reasons, shell_quote, CommandResult, ServerProfile};
use super::policy::AiApprovalPolicy;
use rig::message::ToolName;
use rig::tool::{DynamicTool, ToolExecutionError, ToolOutput};
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_BASH_STDIN_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AiToolSettings {
    #[serde(skip)]
    cancellation: Option<tokio::sync::watch::Receiver<bool>>,
    #[serde(default = "default_true")]
    pub(super) bash: bool,
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
            cancellation: None,
            bash: true,
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
    name == "bash" && settings.bash
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
    if !ai_tool_enabled(settings, "bash") {
        return Vec::new();
    }
    vec![ai_function_tool(
        "bash",
        "在当前 SSH 服务器上使用 Bash 执行命令或多行脚本。命令可能读取或修改远端状态，执行前必须考虑风险。可选 stdin 会作为脚本的标准输入传入。",
        json!({
            "command": { "type": "string", "description": "要通过 bash -lc 执行的完整命令或多行脚本" },
            "stdin": { "type": "string", "description": "可选的标准输入内容，适合一次性交互或输入重定向" }
        }),
        &["command"],
    )]
}

fn required_ai_arg<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("工具参数缺少 {key}"))
}

fn optional_ai_string(arguments: &Value, key: &str) -> Result<Option<String>, String> {
    let Some(value) = arguments.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .map(|value| Some(value.to_string()))
        .ok_or_else(|| format!("工具参数 {key} 必须是字符串"))
}

fn bounded_ai_command(command: &str, timeout_seconds: u32) -> String {
    let timeout_seconds = timeout_seconds.max(5);
    let quoted = shell_quote(command);
    format!(
        "if ! command -v bash >/dev/null 2>&1; then printf '%s\\n' 'sshStar AI requires bash on the remote host' >&2; exit 127; fi; if command -v timeout >/dev/null 2>&1; then timeout --kill-after=5s --signal=TERM {timeout_seconds}s bash -lc {quoted}; else bash -lc {quoted}; fi"
    )
}

async fn run_ai_command(
    server: &ServerProfile,
    command: String,
    stdin: Option<String>,
    settings: &AiToolSettings,
) -> Result<CommandResult, String> {
    use super::super::command::{self, CancelOnDrop, CommandControl};
    if settings
        .cancellation
        .as_ref()
        .is_some_and(|receiver| *receiver.borrow())
    {
        return Err(super::AI_RUN_CANCELLED.to_string());
    }
    if stdin
        .as_deref()
        .is_some_and(|value| value.len() > MAX_BASH_STDIN_BYTES)
    {
        return Err(format!("Bash stdin 超过 {} 字节限制", MAX_BASH_STDIN_BYTES));
    }
    let server = server.clone();
    let command = bounded_ai_command(&command, settings.command_timeout_seconds);
    let stdin = stdin.map(String::into_bytes);
    let control = std::sync::Arc::new(CommandControl::new(
        std::time::Duration::from_secs(u64::from(settings.command_timeout_seconds.clamp(5, 3600))),
        settings
            .max_output_chars
            .clamp(1024, 2_000_000)
            .saturating_mul(4),
    ));
    let guard = CancelOnDrop(control.clone());
    let task = tauri::async_runtime::spawn_blocking(move || {
        command::run_with_stdin(&server, &command, stdin.as_deref(), &control)
    });
    let result = if let Some(mut cancellation) = settings.cancellation.clone() {
        tokio::select! {
            result = task => result.map_err(|error| format!("AI 工具任务失败: {error}"))?,
            _ = super::wait_for_cancellation(&mut cancellation) => Err(super::AI_RUN_CANCELLED.to_string()),
        }
    } else {
        task.await
            .map_err(|error| format!("AI 工具任务失败: {error}"))?
    };
    drop(guard);
    result
}

#[derive(Debug)]
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
    if name != "bash" {
        return Err(format!("未知 AI 工具 {name}"));
    }
    let command = required_ai_arg(arguments, "command")?.to_string();
    let stdin = optional_ai_string(arguments, "stdin")?;
    let result = run_ai_command(server, command.clone(), stdin, settings).await?;
    Ok(AiToolExecution {
        display_command: command,
        result,
    })
}

pub(super) fn build_dynamic_tools(
    server: &ServerProfile,
    settings: &AiToolSettings,
    cancellation: tokio::sync::watch::Receiver<bool>,
) -> Vec<DynamicTool> {
    let mut settings = settings.clone();
    settings.cancellation = Some(cancellation);
    tool_definitions(&settings)
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
                ToolName::new(name).ok()?,
                description,
                parameters,
                move |arguments| {
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

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ToolPermission {
    Allow,
    Ask(String),
    Deny(&'static str),
}

pub(super) fn tool_permission(
    settings: &AiToolSettings,
    policy: AiApprovalPolicy,
    name: &str,
    arguments: &Value,
) -> ToolPermission {
    if !ai_tool_enabled(settings, name) {
        return ToolPermission::Deny("该工具未启用");
    }
    if policy == AiApprovalPolicy::FullAccess {
        return ToolPermission::Allow;
    }
    if ai_tool_is_mutating(name, arguments) && !settings.allow_mutating_tools {
        return ToolPermission::Deny("设置已禁止变更型工具");
    }
    match approval_reason(name, arguments) {
        Some(reason) => ToolPermission::Ask(reason),
        None => ToolPermission::Allow,
    }
}

pub(super) fn approval_reason(name: &str, arguments: &Value) -> Option<String> {
    if !ai_tool_is_mutating(name, arguments) {
        return None;
    }
    let command = ai_tool_command_for_risk(name, arguments);
    let reasons = command.as_deref().map(risk_reasons).unwrap_or_default();
    if reasons.is_empty() {
        Some("Bash 工具可修改远端状态，需要按当前策略审批".to_string())
    } else {
        Some(format!("Bash 工具可修改远端状态；{}", reasons.join("；")))
    }
}

pub(super) fn ai_tool_is_mutating(name: &str, _arguments: &Value) -> bool {
    name == "bash"
}

pub(super) fn ai_tool_command_for_risk(name: &str, arguments: &Value) -> Option<String> {
    (name == "bash")
        .then(|| {
            arguments
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .flatten()
}

pub(super) fn display_command(name: &str, arguments: &Value) -> String {
    ai_tool_command_for_risk(name, arguments).unwrap_or_else(|| format!("{name} {arguments}"))
}

fn bounded_tool_output(output: String, limit: usize) -> String {
    if output.chars().count() <= limit {
        return output;
    }
    let mut bounded = output.chars().take(limit).collect::<String>();
    bounded.push_str("\n…[tool output truncated]");
    bounded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definitions_expose_only_bash_with_optional_stdin() {
        let definitions = tool_definitions(&AiToolSettings::default());
        assert_eq!(definitions.len(), 1);
        let function = &definitions[0]["function"];
        assert_eq!(function["name"], "bash");
        assert_eq!(function["parameters"]["required"], json!(["command"]));
        assert_eq!(
            function["parameters"]["properties"]["command"]["type"],
            "string"
        );
        assert_eq!(
            function["parameters"]["properties"]["stdin"]["type"],
            "string"
        );
    }

    #[test]
    fn bash_wrapper_uses_bash_and_rejects_missing_interpreter() {
        let wrapped = bounded_ai_command("printf hello", 30);
        assert!(wrapped.contains("command -v bash"));
        assert!(wrapped.contains("bash -lc"));
        assert!(wrapped.contains("exit 127"));
        assert!(!wrapped.contains(" sh -lc "));
    }

    #[test]
    fn bash_is_a_mutating_tool_with_risk_details() {
        let settings = AiToolSettings::default();
        let arguments = json!({"command": "rm -rf /"});
        assert!(matches!(
            tool_permission(&settings, AiApprovalPolicy::Request, "bash", &arguments),
            ToolPermission::Deny(_)
        ));
        let mut settings = settings;
        settings.allow_mutating_tools = true;
        let ToolPermission::Ask(reason) =
            tool_permission(&settings, AiApprovalPolicy::Reviewer, "bash", &arguments)
        else {
            panic!("bash should require approval");
        };
        assert!(reason.contains("递归删除"));
        assert_eq!(
            tool_permission(&settings, AiApprovalPolicy::FullAccess, "bash", &arguments),
            ToolPermission::Allow
        );
    }

    #[test]
    fn disabled_bash_is_not_exposed_or_authorized() {
        let settings = AiToolSettings {
            bash: false,
            ..Default::default()
        };
        assert!(tool_definitions(&settings).is_empty());
        assert!(matches!(
            tool_permission(&settings, AiApprovalPolicy::FullAccess, "bash", &json!({})),
            ToolPermission::Deny(_)
        ));
    }

    #[tokio::test]
    async fn rejects_oversized_stdin_before_connecting() {
        let server: ServerProfile = serde_json::from_value(json!({
            "id": "test", "host": "localhost", "port": 22, "username": "test", "authType": "password"
        }))
        .unwrap();
        let result = execute_tool(
            "bash",
            &json!({
                "command": "cat",
                "stdin": "x".repeat(MAX_BASH_STDIN_BYTES + 1)
            }),
            &server,
            &AiToolSettings::default(),
        )
        .await;
        assert!(result.unwrap_err().contains("stdin 超过"));
    }
}
