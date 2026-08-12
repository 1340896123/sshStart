import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { uid } from "../lib";
import type {
  AiAgentEvent,
  AiApproval,
  AiApprovalPolicy,
  AiConfig,
  AiImageAttachment,
  AiMessage,
  AiReasoning,
  AiRunResult,
  AiTextSegment,
  AiTokenUsage,
  AiToolResult,
  ServerProfile,
} from "../types";

interface UseAiAgentOptions {
  config: AiConfig;
  server: ServerProfile;
  messages: AiMessage[];
  onMessagesChange: (messages: AiMessage[], persist: boolean) => void;
  approvalPolicy: AiApprovalPolicy;
}

interface StartAiAgentInput {
  content: string;
  attachments: AiImageAttachment[];
  allowTools: boolean;
}

interface ActiveRun {
  runId: string;
  messageId: string;
  cancelRequested: boolean;
  activeReasoningId?: string;
  activeTextSegmentId?: string;
  unlisten?: UnlistenFn;
}

interface AiApprovalReview {
  decision: "approve" | "reject";
  reason: string;
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

const appendTextSegment = (
  segments: AiTextSegment[] = [],
  segmentId: string,
  delta: string,
  sequence: number,
) => {
  const index = segments.findIndex((segment) => segment.id === segmentId);
  if (index < 0) return [...segments, { id: segmentId, content: delta, sequence }];
  return segments.map((segment, segmentIndex) => segmentIndex === index
    ? { ...segment, content: `${segment.content}${delta}` }
    : segment);
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
  approvalPolicy,
}: UseAiAgentOptions) {
  const [running, setRunning] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string>();
  const messagesRef = useRef(messages);
  const lastPropMessagesRef = useRef(messages);
  const pendingLocalMessagesRef = useRef<AiMessage[]>();
  const onMessagesChangeRef = useRef(onMessagesChange);
  const activeRunRef = useRef<ActiveRun>();
  const approvalPolicyRef = useRef(approvalPolicy);

  if (messages !== lastPropMessagesRef.current) {
    lastPropMessagesRef.current = messages;
    if (pendingLocalMessagesRef.current !== messages) messagesRef.current = messages;
    pendingLocalMessagesRef.current = undefined;
  }
  onMessagesChangeRef.current = onMessagesChange;
  approvalPolicyRef.current = approvalPolicy;

  const commit = (
    updater: (messages: AiMessage[]) => AiMessage[],
    persist = false,
  ) => {
    const next = updater(messagesRef.current);
    messagesRef.current = next;
    pendingLocalMessagesRef.current = next;
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

  const commitApprovalDecision = async (
    messageId: string,
    approval: AiApproval,
    decision: "approve" | "reject",
    note: string,
    rejectionReason?: string,
  ) => {
    updateAssistant(messageId, (message) => ({
      ...message,
      approvalState: decision === "approve" ? "approved" : "rejected",
      approvalNote: note,
      updatedAt: Date.now(),
    }), true);
    await invoke("resolve_ai_approval", {
      approvalId: approval.id,
      decision,
      arguments: decision === "approve" ? approval.arguments : undefined,
      reason: decision === "reject" ? rejectionReason : undefined,
    });
  };

  const fallbackToManualApproval = (messageId: string, reason: unknown) => {
    updateAssistant(messageId, (message) => ({
      ...message,
      approvalState: "pending",
      approvalNote: `自动审批失败：${String(reason)}，请人工处理。`,
      updatedAt: Date.now(),
    }), true);
  };

  const submitApproval = async (
    messageId: string,
    approval: AiApproval,
    decision: "approve" | "reject",
    note: string,
    rejectionReason?: string,
  ) => {
    setResolvingApprovalId(approval.id);
    try {
      await commitApprovalDecision(messageId, approval, decision, note, rejectionReason);
    } catch (reason) {
      fallbackToManualApproval(messageId, reason);
    } finally {
      setResolvingApprovalId(undefined);
    }
  };

  const reviewApproval = async (messageId: string, approval: AiApproval) => {
    setResolvingApprovalId(approval.id);
    updateAssistant(messageId, (message) => ({
      ...message,
      approvalNote: "审核模型正在评估工具调用…",
      updatedAt: Date.now(),
    }), true);
    try {
      const requestContext = [...messagesRef.current]
        .reverse()
        .find((message) => message.role === "user")?.content ?? "";
      const review = await invoke<AiApprovalReview>("review_ai_approval", {
        config,
        server,
        tool: approval.tool,
        command: approval.command,
        arguments: approval.arguments,
        reason: approval.reason,
        requestContext,
      });
      await commitApprovalDecision(
        messageId,
        approval,
        review.decision,
        `审核模型${review.decision === "approve" ? "批准" : "拒绝"}：${review.reason}`,
        review.reason,
      );
    } catch (reason) {
      fallbackToManualApproval(messageId, reason);
    } finally {
      setResolvingApprovalId(undefined);
    }
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
        activeRun.activeTextSegmentId ??= `text-${event.runId}-${event.sequence}`;
        updateAssistant(messageId, (message) => ({
          ...message,
          content: `${message.content}${event.delta}`,
          textSegments: appendTextSegment(
            message.textSegments,
            activeRun.activeTextSegmentId!,
            event.delta,
            event.sequence,
          ),
          messageType: message.toolCalls?.length ? "tool" : "text",
          status: "running",
          updatedAt: event.timestamp,
        }));
        break;
      case "reasoning_delta": {
        activeRun.activeTextSegmentId = undefined;
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
        activeRun.activeTextSegmentId = undefined;
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
        activeRun.activeTextSegmentId = undefined;
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
          approvalNote: undefined,
          messageType: "approval",
          status: "running",
          updatedAt: event.timestamp,
        }), true);
        if (approvalPolicyRef.current === "full-access") {
          void submitApproval(messageId, approval, "approve", "完全访问已自动批准，Agent 正在继续");
        } else if (approvalPolicyRef.current === "reviewer") {
          void reviewApproval(messageId, approval);
        }
        break;
      }
      case "tool_finished":
        activeRun.activeReasoningId = undefined;
        activeRun.activeTextSegmentId = undefined;
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
    activeRunRef.current = { runId, messageId: assistantMessage.id, cancelRequested: false };
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
          .filter((message) => message.status !== "error")
          .map((message) => ({
            role: message.role,
            content: message.role === "assistant" && message.status === "cancelled"
              ? `${message.content}\n\n[上一轮回复在此处被用户停止，请基于已有内容继续对话。]`
              : message.content,
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
      if (error.includes("AI 运行已取消")) {
        const completedAt = Date.now();
        updateAssistant(assistantMessage.id, (message) => ({
          ...message,
          content: message.content || "已停止当前 Agent 运行。",
          messageType: "text",
          status: "cancelled",
          updatedAt: completedAt,
          completedAt,
        }), true);
      } else {
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
      const activeRun = activeRunRef.current;
      if (activeRun?.runId === runId) {
        if (activeRun.cancelRequested) {
          const message = messagesRef.current.find((candidate) => candidate.id === assistantMessage.id);
          if (message && (message.status === "started" || message.status === "running")) {
            const completedAt = Date.now();
            updateAssistant(assistantMessage.id, (current) => ({
              ...current,
              content: current.content || "已停止当前 Agent 运行。",
              messageType: "text",
              status: "cancelled",
              updatedAt: completedAt,
              completedAt,
            }), true);
          }
        }
        unlisten?.();
        activeRunRef.current = undefined;
        setRunning(false);
      }
    }
  };

  const cancel = async () => {
    const activeRun = activeRunRef.current;
    if (!activeRun) return;
    activeRun.cancelRequested = true;
    await invoke("cancel_ai_run", { runId: activeRun.runId }).catch(() => undefined);
  };

  const resolveApproval = async (
    messageId: string,
    decision: "approve" | "reject",
  ) => {
    const message = messagesRef.current.find((candidate) => candidate.id === messageId);
    const approval = message?.approval;
    if (!approval || message.approvalState !== "pending") return;
    await submitApproval(
      messageId,
      approval,
      decision,
      decision === "approve" ? "你已批准，Agent 正在继续" : "你已拒绝该工具调用",
      "用户拒绝了该工具调用",
    );
  };

  useEffect(() => {
    if (approvalPolicy === "request" || resolvingApprovalId) return;
    const activeRun = activeRunRef.current;
    if (!activeRun) return;
    const message = messagesRef.current.find((candidate) => candidate.id === activeRun.messageId);
    const approval = message?.approval;
    if (!approval || message.approvalState !== "pending") return;
    if (approvalPolicy === "full-access") {
      void submitApproval(activeRun.messageId, approval, "approve", "完全访问已自动批准，Agent 正在继续");
    } else {
      void reviewApproval(activeRun.messageId, approval);
    }
  }, [approvalPolicy]);

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
