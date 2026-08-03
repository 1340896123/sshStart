import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { uid } from "../lib";
import type {
  AiAgentEvent,
  AiApproval,
  AiConfig,
  AiImageAttachment,
  AiMessage,
  AiReasoning,
  AiRunResult,
  AiTokenUsage,
  AiToolResult,
  ServerProfile,
} from "../types";

interface UseAiAgentOptions {
  config: AiConfig;
  server: ServerProfile;
  messages: AiMessage[];
  onMessagesChange: (messages: AiMessage[], persist: boolean) => void;
}

interface StartAiAgentInput {
  content: string;
  attachments: AiImageAttachment[];
  allowTools: boolean;
}

interface ActiveRun {
  runId: string;
  messageId: string;
  activeReasoningId?: string;
  unlisten?: UnlistenFn;
}

const mergeToolCall = (toolCalls: AiToolResult[] = [], next: AiToolResult) => {
  const index = toolCalls.findIndex((toolCall) => toolCall.id === next.id);
  if (index < 0) return [...toolCalls, next];
  return toolCalls.map((toolCall, toolCallIndex) => toolCallIndex === index ? {
    ...toolCall,
    ...next,
    arguments: next.arguments ?? toolCall.arguments,
    output: next.output || toolCall.output,
    startedAt: Math.min(toolCall.startedAt, next.startedAt),
    updatedAt: Math.max(toolCall.updatedAt, next.updatedAt),
    completedAt: next.completedAt ?? toolCall.completedAt,
  } : toolCall);
};

const appendReasoning = (
  reasonings: AiReasoning[] = [],
  reasoningId: string,
  delta: string,
  sequence: number,
) => {
  const index = reasonings.findIndex((reasoning) => reasoning.id === reasoningId);
  if (index < 0) return [...reasonings, { id: reasoningId, content: delta, sequence }];
  return reasonings.map((reasoning, reasoningIndex) => reasoningIndex === index
    ? { ...reasoning, content: `${reasoning.content}${delta}` }
    : reasoning);
};

const usageFromEvent = (event: Extract<AiAgentEvent, { type: "usage" }>): AiTokenUsage => ({
  available: true,
  inputTokens: event.inputTokens,
  outputTokens: event.outputTokens,
  totalTokens: event.totalTokens,
  cachedTokens: event.cachedTokens,
  reasoningTokens: event.reasoningTokens,
  contextTokens: event.inputTokens,
  requests: event.requests,
});

export function useAiAgent({
  config,
  server,
  messages,
  onMessagesChange,
}: UseAiAgentOptions) {
  const [running, setRunning] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string>();
  const messagesRef = useRef(messages);
  const onMessagesChangeRef = useRef(onMessagesChange);
  const activeRunRef = useRef<ActiveRun>();

  messagesRef.current = messages;
  onMessagesChangeRef.current = onMessagesChange;

  const commit = (
    updater: (messages: AiMessage[]) => AiMessage[],
    persist = false,
  ) => {
    const next = updater(messagesRef.current);
    messagesRef.current = next;
    onMessagesChangeRef.current(next, persist);
  };

  const updateAssistant = (
    messageId: string,
    updater: (message: AiMessage) => AiMessage,
    persist = false,
  ) => {
    commit(
      (current) => current.map((message) => message.id === messageId ? updater(message) : message),
      persist,
    );
  };

  const applyEvent = (event: AiAgentEvent) => {
    const activeRun = activeRunRef.current;
    if (!activeRun || activeRun.runId !== event.runId) return;
    const messageId = activeRun.messageId;

    switch (event.type) {
      case "run_started":
        updateAssistant(messageId, (message) => ({
          ...message,
          status: "running",
          updatedAt: event.timestamp,
        }));
        break;
      case "text_delta":
        activeRun.activeReasoningId = undefined;
        updateAssistant(messageId, (message) => ({
          ...message,
          content: `${message.content}${event.delta}`,
          messageType: message.toolCalls?.length ? "tool" : "text",
          status: "running",
          updatedAt: event.timestamp,
        }));
        break;
      case "reasoning_delta": {
        const reasoningId = activeRun.activeReasoningId
          ?? `reasoning-${event.runId}-${event.sequence}`;
        activeRun.activeReasoningId = reasoningId;
        updateAssistant(messageId, (message) => ({
          ...message,
          reasonings: appendReasoning(message.reasonings, reasoningId, event.delta, event.sequence),
          status: "running",
          updatedAt: event.timestamp,
        }));
        break;
      }
      case "tool_started":
        activeRun.activeReasoningId = undefined;
        updateAssistant(messageId, (message) => ({
          ...message,
          messageType: "tool",
          toolCalls: mergeToolCall(message.toolCalls, {
            id: event.actionId,
            sequence: event.sequence,
            tool: event.tool,
            command: event.command,
            arguments: event.arguments,
            output: "",
            exitCode: 0,
            status: "running",
            startedAt: event.startedAt,
            updatedAt: event.timestamp,
          }),
          status: "running",
          updatedAt: event.timestamp,
        }));
        break;
      case "approval_required": {
        activeRun.activeReasoningId = undefined;
        const approval: AiApproval = {
          id: event.approvalId,
          actionId: event.actionId,
          tool: event.tool,
          command: event.command,
          reason: event.reason,
          arguments: event.arguments,
        };
        updateAssistant(messageId, (message) => ({
          ...message,
          approval,
          approvalState: "pending",
          messageType: "approval",
          status: "running",
          updatedAt: event.timestamp,
        }), true);
        break;
      }
      case "tool_finished":
        activeRun.activeReasoningId = undefined;
        updateAssistant(messageId, (message) => ({
          ...message,
          messageType: "tool",
          toolCalls: mergeToolCall(message.toolCalls, {
            id: event.actionId,
            sequence: message.toolCalls?.find((toolCall) => toolCall.id === event.actionId)?.sequence
              ?? event.sequence,
            tool: event.tool,
            command: event.command,
            output: event.output,
            exitCode: event.exitCode,
            status: event.status,
            startedAt: event.startedAt,
            updatedAt: event.completedAt,
            completedAt: event.completedAt,
          }),
          status: "running",
          updatedAt: event.completedAt,
        }));
        break;
      case "usage":
        updateAssistant(messageId, (message) => ({
          ...message,
          usage: usageFromEvent(event),
          updatedAt: event.timestamp,
        }));
        break;
      case "run_cancelled":
        updateAssistant(messageId, (message) => ({
          ...message,
          content: message.content || "已停止当前 Agent 运行。",
          messageType: "text",
          status: "cancelled",
          updatedAt: event.timestamp,
          completedAt: event.timestamp,
        }), true);
        break;
      case "run_failed":
        updateAssistant(messageId, (message) => ({
          ...message,
          content: message.content || `请求失败：${event.error}`,
          messageType: "error",
          status: "error",
          updatedAt: event.timestamp,
          completedAt: event.timestamp,
        }), true);
        break;
      case "run_completed":
        break;
    }
  };

  const start = async ({ content, attachments, allowTools }: StartAiAgentInput) => {
    if (activeRunRef.current) return;
    const now = Date.now();
    const runId = uid("ai-run");
    const userMessage: AiMessage = {
      id: uid("ai-user"),
      role: "user",
      messageType: "text",
      content,
      attachments: attachments.length ? attachments : undefined,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      status: "completed",
    };
    const assistantMessage: AiMessage = {
      id: uid("ai-assistant"),
      role: "assistant",
      messageType: "text",
      content: "",
      createdAt: now,
      updatedAt: now,
      status: "started",
    };
    const pendingMessages = [...messagesRef.current, userMessage, assistantMessage];
    activeRunRef.current = { runId, messageId: assistantMessage.id };
    commit(() => pendingMessages, true);
    setRunning(true);

    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<AiAgentEvent>(`ai-agent:${runId}`, (event) => {
        applyEvent(event.payload);
      });
      if (!activeRunRef.current || activeRunRef.current.runId !== runId) return;
      activeRunRef.current.unlisten = unlisten;
      const result = await invoke<AiRunResult>("run_ai_agent", {
        config,
        server,
        messages: pendingMessages
          .filter((message) => message.id !== assistantMessage.id)
          .filter((message) => message.status !== "error" && message.status !== "cancelled")
          .map((message) => ({
            role: message.role,
            content: message.content,
            attachments: message.attachments?.map(({ kind, name, remotePath, mimeType, size }) => ({
              kind,
              name,
              remotePath,
              mimeType,
              size,
            })),
          })),
        allowTools,
        runId,
      });
      if (activeRunRef.current?.runId !== runId) return;
      const completedAt = Date.now();
      updateAssistant(assistantMessage.id, (message) => {
        const hasReasoning = message.reasonings?.some(
          (reasoning) => reasoning.content.trim() === result.reasoning?.trim(),
        );
        const reasonings = result.reasoning && !hasReasoning
          ? [...(message.reasonings ?? []), {
              id: `reasoning-${runId}-final`,
              content: result.reasoning,
              sequence: Number.MAX_SAFE_INTEGER - 1,
            }]
          : message.reasonings;
        return {
          ...message,
          content: result.content,
          reasonings,
          messageType: message.toolCalls?.length ? "tool" : "text",
          usage: result.usage,
          approval: undefined,
          approvalState: message.approvalState === "rejected" ? "rejected" : undefined,
          status: "completed",
          updatedAt: completedAt,
          completedAt,
        };
      }, true);
    } catch (reason) {
      if (activeRunRef.current?.runId !== runId) return;
      const error = String(reason);
      if (!error.includes("AI 运行已取消")) {
        const completedAt = Date.now();
        updateAssistant(assistantMessage.id, (message) => ({
          ...message,
          content: message.content || `请求失败：${error}`,
          messageType: "error",
          status: "error",
          updatedAt: completedAt,
          completedAt,
        }), true);
      }
    } finally {
      unlisten?.();
      if (activeRunRef.current?.runId === runId) {
        activeRunRef.current = undefined;
        setRunning(false);
      }
    }
  };

  const cancel = async () => {
    const activeRun = activeRunRef.current;
    if (!activeRun) return;
    await invoke("cancel_ai_run", { runId: activeRun.runId }).catch(() => undefined);
  };

  const resolveApproval = async (
    messageId: string,
    decision: "approve" | "reject",
  ) => {
    const message = messagesRef.current.find((candidate) => candidate.id === messageId);
    const approval = message?.approval;
    if (!approval || message.approvalState !== "pending") return;
    setResolvingApprovalId(approval.id);
    updateAssistant(messageId, (current) => ({
      ...current,
      approvalState: decision === "approve" ? "approved" : "rejected",
      updatedAt: Date.now(),
    }), true);
    try {
      await invoke("resolve_ai_approval", {
        approvalId: approval.id,
        decision,
        arguments: decision === "approve" ? approval.arguments : undefined,
        reason: decision === "reject" ? "用户拒绝了该工具调用" : undefined,
      });
    } catch (reason) {
      updateAssistant(messageId, (current) => ({
        ...current,
        approvalState: "pending",
        content: current.content || `审批提交失败：${String(reason)}`,
        updatedAt: Date.now(),
      }), true);
    } finally {
      setResolvingApprovalId(undefined);
    }
  };

  useEffect(() => () => {
    const activeRun = activeRunRef.current;
    if (!activeRun) return;
    activeRun.unlisten?.();
    void invoke("cancel_ai_run", { runId: activeRun.runId }).catch(() => undefined);
    activeRunRef.current = undefined;
  }, []);

  return {
    running,
    activeMessageId: activeRunRef.current?.messageId,
    resolvingApprovalId,
    start,
    cancel,
    resolveApproval,
  };
}
