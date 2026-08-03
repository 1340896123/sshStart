use super::tools::{self, AiToolSettings};
use rig::agent::{
    AgentHook, HookContext, StepEventKind, ToolCall, ToolCallAction, ToolResultAction,
    ToolResultEvent,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

#[derive(Clone, Default)]
pub(crate) struct AiRuntimeState {
    inner: Arc<AiRuntimeInner>,
}

#[derive(Default)]
struct AiRuntimeInner {
    approvals: Mutex<HashMap<String, PendingApproval>>,
    runs: Mutex<HashMap<String, watch::Sender<bool>>>,
}

struct PendingApproval {
    sender: oneshot::Sender<ApprovalDecision>,
}

enum ApprovalDecision {
    Approve(Option<Value>),
    Reject(String),
}

impl AiRuntimeState {
    pub(super) fn begin_run(&self, run_id: &str) -> Result<watch::Receiver<bool>, String> {
        let (sender, receiver) = watch::channel(false);
        self.inner
            .runs
            .lock()
            .map_err(|_| "AI 运行状态已损坏".to_string())?
            .insert(run_id.to_string(), sender);
        Ok(receiver)
    }

    pub(super) fn finish_run(&self, run_id: &str) {
        if let Ok(mut runs) = self.inner.runs.lock() {
            runs.remove(run_id);
        }
    }

    pub(super) fn cancel_run(&self, run_id: &str) -> Result<(), String> {
        let runs = self
            .inner
            .runs
            .lock()
            .map_err(|_| "AI 运行状态已损坏".to_string())?;
        let sender = runs
            .get(run_id)
            .ok_or_else(|| "AI 运行不存在或已结束".to_string())?;
        sender
            .send(true)
            .map_err(|_| "AI 运行已结束".to_string())
    }

    async fn request_approval(
        &self,
        run_id: String,
        approval_id: String,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<ApprovalDecision, String> {
        let (sender, receiver) = oneshot::channel();
        self.inner
            .approvals
            .lock()
            .map_err(|_| "AI 审批状态已损坏".to_string())?
            .insert(approval_id.clone(), PendingApproval { sender });
        let decision = tokio::select! {
            decision = receiver => decision.map_err(|_| format!("审批 {approval_id} 已取消")),
            changed = cancellation.changed() => {
                changed.map_err(|_| "AI 运行已结束".to_string())?;
                Err(format!("AI 运行 {run_id} 已取消"))
            }
        };
        if let Ok(mut approvals) = self.inner.approvals.lock() {
            approvals.remove(&approval_id);
        }
        decision
    }

    fn resolve(
        &self,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), String> {
        let pending = self
            .inner
            .approvals
            .lock()
            .map_err(|_| "AI 审批状态已损坏".to_string())?
            .remove(approval_id)
            .ok_or_else(|| "审批请求不存在或已处理".to_string())?;
        pending
            .sender
            .send(decision)
            .map_err(|_| "AI 运行已结束，无法提交审批".to_string())
    }
}

pub(super) fn resolve_approval(
    state: &AiRuntimeState,
    approval_id: String,
    decision: String,
    arguments: Option<Value>,
    reason: Option<String>,
) -> Result<(), String> {
    let decision = match decision.as_str() {
        "approve" => ApprovalDecision::Approve(arguments),
        "reject" => ApprovalDecision::Reject(
            reason
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "用户拒绝了该工具调用".to_string()),
        ),
        _ => return Err("未知审批决定".to_string()),
    };
    state.resolve(&approval_id, decision)
}

#[derive(Clone)]
pub(super) struct EventSink {
    app: AppHandle,
    event_name: String,
    run_id: String,
    sequence: Arc<AtomicU64>,
}

impl EventSink {
    pub(super) fn new(app: AppHandle, run_id: &str) -> Self {
        Self {
            app,
            event_name: format!("ai-agent:{run_id}"),
            run_id: run_id.to_string(),
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(super) fn emit(&self, event: AiAgentEventKind) {
        let payload = AiAgentEvent {
            run_id: self.run_id.clone(),
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed),
            timestamp: timestamp_ms(),
            event,
        };
        self.app.emit(&self.event_name, payload).ok();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiAgentEvent {
    run_id: String,
    sequence: u64,
    timestamp: u64,
    #[serde(flatten)]
    event: AiAgentEventKind,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub(super) enum AiAgentEventKind {
    RunStarted {
        model: String,
        api_mode: String,
    },
    TextDelta {
        delta: String,
    },
    ReasoningDelta {
        delta: String,
    },
    ToolStarted {
        action_id: String,
        tool: String,
        command: String,
        arguments: Value,
        started_at: u64,
    },
    ApprovalRequired {
        approval_id: String,
        action_id: String,
        tool: String,
        command: String,
        arguments: Value,
        reason: String,
    },
    ToolFinished {
        action_id: String,
        tool: String,
        command: String,
        output: String,
        exit_code: i32,
        status: String,
        started_at: u64,
        completed_at: u64,
    },
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
        cached_tokens: u64,
        reasoning_tokens: u64,
        requests: u32,
    },
    RunCompleted,
    RunCancelled,
    RunFailed {
        error: String,
    },
}

#[derive(Clone)]
struct ActionState {
    tool: String,
    command: String,
    started_at: u64,
}

#[derive(Clone)]
pub(super) struct RunHook {
    runtime: AiRuntimeState,
    sink: EventSink,
    run_id: String,
    cancellation: watch::Receiver<bool>,
    settings: AiToolSettings,
    actions: Arc<Mutex<HashMap<String, ActionState>>>,
}

impl RunHook {
    pub(super) fn new(
        runtime: AiRuntimeState,
        sink: EventSink,
        run_id: String,
        cancellation: watch::Receiver<bool>,
        settings: AiToolSettings,
    ) -> Self {
        Self {
            runtime,
            sink,
            run_id,
            cancellation,
            settings,
            actions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl AgentHook for RunHook {
    async fn on_tool_call(
        &self,
        _context: &HookContext,
        event: ToolCall<'_>,
    ) -> ToolCallAction {
        let arguments = serde_json::from_str::<Value>(event.args).unwrap_or(Value::Null);
        let command = tools::display_command(event.tool_name, &arguments);
        let started_at = timestamp_ms();
        self.actions
            .lock()
            .ok()
            .map(|mut actions| {
                actions.insert(
                    event.internal_call_id.to_string(),
                    ActionState {
                        tool: event.tool_name.to_string(),
                        command: command.clone(),
                        started_at,
                    },
                )
            });

        if !tools::tool_is_allowed(&self.settings, event.tool_name, &arguments) {
            return ToolCallAction::skip("设置已禁止变更型工具");
        }

        if let Some(reason) = tools::approval_reason(event.tool_name, &arguments) {
            let approval_id = format!("approval-{}", Uuid::new_v4());
            self.sink.emit(AiAgentEventKind::ApprovalRequired {
                approval_id: approval_id.clone(),
                action_id: event.internal_call_id.to_string(),
                tool: event.tool_name.to_string(),
                command: command.clone(),
                arguments: arguments.clone(),
                reason,
            });
            return match self
                .runtime
                .request_approval(
                    self.run_id.clone(),
                    approval_id,
                    self.cancellation.clone(),
                )
                .await
            {
                Ok(ApprovalDecision::Approve(Some(arguments))) => {
                    self.sink.emit(AiAgentEventKind::ToolStarted {
                        action_id: event.internal_call_id.to_string(),
                        tool: event.tool_name.to_string(),
                        command,
                        arguments: arguments.clone(),
                        started_at,
                    });
                    ToolCallAction::rewrite(arguments)
                }
                Ok(ApprovalDecision::Approve(None)) => {
                    self.sink.emit(AiAgentEventKind::ToolStarted {
                        action_id: event.internal_call_id.to_string(),
                        tool: event.tool_name.to_string(),
                        command,
                        arguments,
                        started_at,
                    });
                    ToolCallAction::run()
                }
                Ok(ApprovalDecision::Reject(reason)) => ToolCallAction::skip(reason),
                Err(error) => ToolCallAction::stop(error),
            };
        }

        self.sink.emit(AiAgentEventKind::ToolStarted {
            action_id: event.internal_call_id.to_string(),
            tool: event.tool_name.to_string(),
            command,
            arguments,
            started_at,
        });
        ToolCallAction::run()
    }

    async fn on_tool_result(
        &self,
        _context: &HookContext,
        event: ToolResultEvent<'_>,
    ) -> ToolResultAction {
        let state = self
            .actions
            .lock()
            .ok()
            .and_then(|mut actions| actions.remove(event.internal_call_id))
            .unwrap_or_else(|| ActionState {
                tool: event.tool_name.to_string(),
                command: event.tool_name.to_string(),
                started_at: timestamp_ms(),
            });
        let rendered = event.presentation.render();
        let structured = serde_json::from_str::<Value>(&rendered).unwrap_or(Value::Null);
        let command = structured
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or(&state.command)
            .to_string();
        let output = structured
            .get("output")
            .and_then(Value::as_str)
            .unwrap_or(&rendered)
            .to_string();
        let exit_code = structured
            .get("exitCode")
            .and_then(Value::as_i64)
            .map(|value| value as i32)
            .unwrap_or_else(|| if event.raw_result.is_error() { 1 } else { 0 });
        let status = if event.raw_result.is_skipped() {
            "rejected"
        } else if event.raw_result.is_error() || event.raw_result.is_refused() || exit_code != 0 {
            "error"
        } else {
            "completed"
        };
        self.sink.emit(AiAgentEventKind::ToolFinished {
            action_id: event.internal_call_id.to_string(),
            tool: state.tool,
            command,
            output,
            exit_code,
            status: status.to_string(),
            started_at: state.started_at,
            completed_at: timestamp_ms(),
        });
        ToolResultAction::keep()
    }

    fn observes(&self, kind: StepEventKind) -> bool {
        matches!(kind, StepEventKind::ToolCall | StepEventKind::ToolResult)
    }
}

fn timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::{AiAgentEvent, AiAgentEventKind, AiRuntimeState};
    use serde_json::json;

    #[test]
    fn serializes_agent_events_for_the_frontend_contract() {
        let payload = serde_json::to_value(AiAgentEvent {
            run_id: "run-1".to_string(),
            sequence: 3,
            timestamp: 42,
            event: AiAgentEventKind::ApprovalRequired {
                approval_id: "approval-1".to_string(),
                action_id: "action-1".to_string(),
                tool: "execute_command".to_string(),
                command: "uptime".to_string(),
                arguments: json!({ "command": "uptime" }),
                reason: "需要审批".to_string(),
            },
        })
        .unwrap();

        assert_eq!(payload["runId"], "run-1");
        assert_eq!(payload["type"], "approval_required");
        assert_eq!(payload["approvalId"], "approval-1");
        assert_eq!(payload["actionId"], "action-1");
        assert!(payload.get("approval_id").is_none());
    }

    #[test]
    fn cancels_registered_agent_runs() {
        let state = AiRuntimeState::default();
        let mut cancellation = state.begin_run("run-1").unwrap();

        state.cancel_run("run-1").unwrap();
        futures::executor::block_on(cancellation.changed()).unwrap();

        assert!(*cancellation.borrow());
        state.finish_run("run-1");
        assert!(state.cancel_run("run-1").is_err());
    }
}
