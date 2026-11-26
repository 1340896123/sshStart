use super::super::{risk_reasons, CommandResult, ServerProfile};
use super::policy::AiApprovalPolicy;
use crate::command::CommandControl;
use rig::message::ToolName;
use rig::tool::{DynamicTool, ToolExecutionError, ToolOutput};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const MAX_EXEC_STDIN_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AiToolSettings {
    #[serde(skip)]
    cancellation: Option<tokio::sync::watch::Receiver<bool>>,
    #[serde(default = "default_true", alias = "bash")]
    pub(super) execute_command: bool,
    #[serde(default = "default_tool_rounds")]
    pub(super) max_tool_rounds: u32,
    #[serde(default = "default_tool_output_chars")]
    pub(super) max_output_chars: usize,
    #[serde(skip)]
    pub(super) command_control: Option<Arc<Mutex<Option<Arc<CommandControl>>>>>,
}

impl Default for AiToolSettings {
    fn default() -> Self {
        Self {
            cancellation: None,
            execute_command: true,
            max_tool_rounds: default_tool_rounds(),
            max_output_chars: default_tool_output_chars(),
            command_control: None,
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

fn ai_tool_enabled(settings: &AiToolSettings, name: &str) -> bool {
    name == "exec_command" && settings.execute_command
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
    if !ai_tool_enabled(settings, "exec_command") {
        return Vec::new();
    }
    vec![ai_function_tool(
        "exec_command",
        "在当前 SSH 服务器上执行命令，返回 stdout、stderr 和退出码。命令可能读取或修改远端状态，执行前必须考虑风险。可选 stdin 会作为命令的标准输入传入。",
        json!({
            "cmd": { "type": "string", "description": "要执行的完整远端命令或多行脚本" },
            "stdin": { "type": "string", "description": "可选的标准输入内容，适合一次性交互或输入重定向" }
        }),
        &["cmd"],
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
        .is_some_and(|value| value.len() > MAX_EXEC_STDIN_BYTES)
    {
        return Err(format!("命令 stdin 超过 {} 字节限制", MAX_EXEC_STDIN_BYTES));
    }
    let server = server.clone();
    let stdin = stdin.map(String::into_bytes);
    let control = std::sync::Arc::new(CommandControl::unlimited(
        settings
            .max_output_chars
            .clamp(1024, 2_000_000)
            .saturating_mul(4),
    ));
    let active_command_guard = if let Some(slot) = settings.command_control.clone() {
        {
            let mut active = slot
                .lock()
                .map_err(|_| "SSH 命令状态锁已损坏".to_string())?;
            *active = Some(control.clone());
        }
        Some(ActiveCommandGuard {
            slot,
            control: control.clone(),
        })
    } else {
        None
    };
    let guard = CancelOnDrop(control.clone());
    let task_control = control.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        command::run_with_stdin(&server, &command, stdin.as_deref(), &task_control)
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
    drop(active_command_guard);
    result
}

struct ActiveCommandGuard {
    slot: Arc<Mutex<Option<Arc<CommandControl>>>>,
    control: Arc<CommandControl>,
}

impl Drop for ActiveCommandGuard {
    fn drop(&mut self) {
        let Ok(mut active) = self.slot.lock() else {
            return;
        };
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &self.control))
        {
            *active = None;
        }
    }
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
    if name != "exec_command" {
        return Err(format!("未知 AI 工具 {name}"));
    }
    let command = required_ai_arg(arguments, "cmd")?.to_string();
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
    command_control: Arc<Mutex<Option<Arc<CommandControl>>>>,
) -> Vec<DynamicTool> {
    let mut settings = settings.clone();
    settings.cancellation = Some(cancellation);
    settings.command_control = Some(command_control);
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
                            .map_err(|error| {
                                if error == "命令已取消" {
                                    ToolExecutionError::cancelled(error)
                                } else {
                                    ToolExecutionError::provider(error)
                                }
                            })?;
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
        Some("命令执行工具可修改远端状态，需要按当前策略审批".to_string())
    } else {
        Some(format!(
            "命令执行工具可修改远端状态；{}",
            reasons.join("；")
        ))
    }
}

pub(super) fn ai_tool_is_mutating(name: &str, _arguments: &Value) -> bool {
    name == "exec_command"
}

pub(super) fn ai_tool_command_for_risk(name: &str, arguments: &Value) -> Option<String> {
    (name == "exec_command")
        .then(|| {
            arguments
                .get("cmd")
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
    fn tool_definitions_expose_only_exec_command_with_optional_stdin() {
        let definitions = tool_definitions(&AiToolSettings::default());
        assert_eq!(definitions.len(), 1);
        let function = &definitions[0]["function"];
        assert_eq!(function["name"], "exec_command");
        assert_eq!(function["parameters"]["required"], json!(["cmd"]));
        assert_eq!(
            function["parameters"]["properties"]["cmd"]["type"],
            "string"
        );
        assert_eq!(
            function["parameters"]["properties"]["stdin"]["type"],
            "string"
        );
    }

    #[test]
    fn exec_command_is_always_available_for_approval_with_risk_details() {
        let settings = AiToolSettings::default();
        let arguments = json!({"cmd": "rm -rf /"});
        let ToolPermission::Ask(reason) = tool_permission(
            &settings,
            AiApprovalPolicy::Request,
            "exec_command",
            &arguments,
        ) else {
            panic!("exec_command should require approval");
        };
        assert!(reason.contains("递归删除"));
        assert!(matches!(
            tool_permission(
                &AiToolSettings::default(),
                AiApprovalPolicy::Reviewer,
                "exec_command",
                &arguments,
            ),
            ToolPermission::Ask(_)
        ));
        assert_eq!(
            tool_permission(
                &AiToolSettings::default(),
                AiApprovalPolicy::FullAccess,
                "exec_command",
                &arguments
            ),
            ToolPermission::Allow
        );
    }

    #[test]
    fn disabled_exec_command_is_not_exposed_or_authorized() {
        let settings = AiToolSettings {
            execute_command: false,
            ..Default::default()
        };
        assert!(tool_definitions(&settings).is_empty());
        assert!(matches!(
            tool_permission(
                &settings,
                AiApprovalPolicy::FullAccess,
                "exec_command",
                &json!({}),
            ),
            ToolPermission::Deny(_)
        ));
    }

    #[test]
    fn legacy_bash_setting_migrates_to_exec_command() {
        let settings: AiToolSettings = serde_json::from_value(json!({"bash": false})).unwrap();
        assert!(!settings.execute_command);
    }

    #[tokio::test]
    async fn rejects_oversized_stdin_before_connecting() {
        let server: ServerProfile = serde_json::from_value(json!({
            "id": "test", "host": "localhost", "port": 22, "username": "test", "authType": "password"
        }))
        .unwrap();
        let result = execute_tool(
            "exec_command",
            &json!({
                "cmd": "cat",
                "stdin": "x".repeat(MAX_EXEC_STDIN_BYTES + 1)
            }),
            &server,
            &AiToolSettings::default(),
        )
        .await;
        assert!(result.unwrap_err().contains("stdin 超过"));
    }
}
