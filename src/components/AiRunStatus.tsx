import { useEffect, useState } from "react";
import { AlertCircle, BrainCircuit, Check, CircleStop, Clock3, LoaderCircle, MessageSquare, ShieldAlert, TerminalSquare } from "lucide-react";
import type { AiMessage } from "../types";

interface Props {
  message?: AiMessage;
  running: boolean;
  stopping: boolean;
  resolvingApprovalId?: string;
  hidden: boolean;
}

const isActive = (status: string) => status === "started" || status === "running";

function activityFor({ message, running, stopping, resolvingApprovalId }: Props) {
  if (!message) return { phase: "idle", label: "待命", detail: "等待任务", Icon: Clock3, announcement: "" };
  if (message.status === "error") {
    const detail = message.error || "本轮请求未完成";
    return { phase: "error", label: "运行失败", detail, Icon: AlertCircle, announcement: `助手请求失败：${message.error ?? message.content}` };
  }
  if (running && stopping) return { phase: "stopping", label: "正在停止", detail: "正在停止当前任务", Icon: CircleStop, announcement: "助手正在停止当前任务。" };
  if (!running) {
    if (message.status === "completed") return { phase: "completed", label: "已完成", detail: "本轮任务已完成", Icon: Check, announcement: "助手已完成回复。" };
    if (message.status === "cancelled") return { phase: "cancelled", label: "已停止", detail: "本轮任务已停止", Icon: CircleStop, announcement: "助手已停止。" };
    return { phase: "interrupted", label: "未完成", detail: "上次任务未完成", Icon: AlertCircle, announcement: "上次助手任务未完成。" };
  }
  if (message.approvalState === "pending" && message.approval) {
    const resolving = resolvingApprovalId === message.approval.id;
    return {
      phase: resolving ? "reviewing" : "approval",
      label: resolving ? "审批处理中" : "等待审批",
      detail: message.approval.command,
      Icon: ShieldAlert,
      announcement: resolving ? "正在处理助手审批请求。" : `助手需要你批准执行命令：${message.approval.command}`,
    };
  }
  const tools = message.toolCalls ?? [];
  const activeTool = [...tools].reverse().find((tool) => isActive(tool.status));
  if (activeTool) return { phase: "executing", label: "执行中", detail: activeTool.command, Icon: TerminalSquare, announcement: `助手正在执行任务：${activeTool.command}` };
  const lastToolSequence = Math.max(-1, ...tools.map((tool) => tool.sequence));
  const textSequence = Math.max(-1, ...(message.textSegments ?? []).map((segment) => segment.sequence));
  const reasoningSequence = Math.max(-1, ...(message.reasonings ?? []).map((reasoning) => reasoning.sequence));
  if (textSequence > Math.max(lastToolSequence, reasoningSequence)) {
    return { phase: "responding", label: "回复中", detail: "正在生成回复", Icon: MessageSquare, announcement: "助手正在生成回复。" };
  }
  if (message.status === "started" && reasoningSequence < 0 && lastToolSequence < 0) {
    return { phase: "starting", label: "准备中", detail: "正在启动任务", Icon: LoaderCircle, announcement: "助手正在启动任务。" };
  }
  return { phase: "thinking", label: "思考中", detail: "正在分析任务与规划下一步", Icon: BrainCircuit, announcement: "助手正在执行任务，正在思考下一步。" };
}

const formatElapsed = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export function AiRunStatus(props: Props) {
  const { message, running, hidden } = props;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || hidden) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, hidden, message?.id]);

  const activity = activityFor(props);
  const elapsed = message ? Math.max(0, (running ? now : message.completedAt ?? message.updatedAt) - message.createdAt) : 0;
  return (
    <div className="ai-run-status" data-state={activity.phase} role="group" aria-label="助手运行状态">
      <span className="sr-only ai-status" role="status" aria-live="polite" aria-atomic="true">{hidden ? "" : activity.announcement}</span>
      <span className="ai-run-status-icon" aria-hidden="true"><activity.Icon size={15} /></span>
      <div className="ai-run-status-copy">
        <strong>{activity.label}</strong>
        <span title={activity.detail}>{activity.detail}</span>
      </div>
      {message && <span className="ai-run-elapsed" title={`本轮耗时 ${formatElapsed(elapsed)}`} aria-label={`本轮耗时 ${formatElapsed(elapsed)}`}>
        <Clock3 size={12} aria-hidden="true" />
        <span aria-hidden="true">{formatElapsed(elapsed)}</span>
      </span>}
    </div>
  );
}
