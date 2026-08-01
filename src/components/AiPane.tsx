import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  CircleStop,
  Copy,
  FileText,
  History,
  ImageIcon,
  MessageSquarePlus,
  Play,
  Send,
  ShieldAlert,
  Settings2,
  Sparkles,
  TerminalSquare,
  User,
  X,
} from "lucide-react";
import {
  AI_HISTORY_STORAGE_KEY,
  AI_HISTORY_UPDATED_EVENT,
  publishAiConversations,
  readAiConversations,
  upsertAiConversation,
  type AiConversation,
} from "../aiHistory";
import { formatBytes, isTauri, uid } from "../lib";
import type { AiActionStatus, AiApproval, AiConfig, AiImageAttachment, AiMessage, AiMessageType, AiReasoning, AiResponse, AiStreamDelta, AiTokenUsage, AiToolResult, ServerProfile, SessionState } from "../types";
import { AiHistoryPopover } from "./AiHistoryPopover";

const MarkdownMessage = lazy(() => import("./MarkdownMessage").then((module) => ({ default: module.MarkdownMessage })));

interface Props {
  session: SessionState;
  server: ServerProfile;
  config: AiConfig;
  onUpdate: (patch: Partial<SessionState>) => void;
  onOpenSettings: () => void;
}

const STARTERS = ["检查磁盘与内存使用", "查看最近的错误日志", "分析当前目录的部署结构"];
const TOOL_LABELS: Record<string, string> = {
  execute_command: "单条命令",
  background_task: "后台作业",
  pty_interaction: "交互式终端",
  read_file: "读取文件",
  write_file: "写入文件",
  sftp_upload: "SFTP 上传",
  sftp_download: "SFTP 下载",
  list_directory: "目录列表",
  get_system_metrics: "系统指标",
  process_manager: "进程管理",
  network_checker: "网络诊断",
  docker_manager: "Docker 管理",
  systemd_control: "systemd 服务",
  risk_checker: "高危检查",
  snippet_library: "代码片段",
  log_analyzer: "日志分析",
};
const REASONING_OPEN = "<reasoning_summary>";
const REASONING_CLOSE = "</reasoning_summary>";
const TOKEN_NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN");
const TOKEN_COMPACT_FORMATTER = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const LARGE_PASTE_THRESHOLD = 32_000;
const MAX_PASTED_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PASTED_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_PASTED_ATTACHMENTS = 4;
const ACTION_STATUS_LABELS: Record<AiActionStatus, string> = {
  started: "开始",
  running: "执行中",
  completed: "已完成",
  error: "错误",
};
const MESSAGE_TYPE_LABELS: Record<AiMessageType, string> = {
  text: "文本",
  command: "命令",
  tool: "工具",
  approval: "审批",
  status: "状态",
  error: "错误消息",
};

interface DraftAiAttachment extends Omit<AiImageAttachment, "remotePath"> {
  remotePath?: string;
  status: "uploading" | "ready" | "failed";
  error?: string;
}

interface AiUploadedAttachment {
  remotePath: string;
  size: number;
}

interface PastedAttachmentSource {
  kind: AiImageAttachment["kind"];
  name: string;
  mimeType: string;
  blob: Blob;
}

const readBlobAsBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    const dataUrl = String(reader.result);
    const separator = dataUrl.indexOf(",");
    if (separator < 0) reject(new Error("无法编码附件"));
    else resolve(dataUrl.slice(separator + 1));
  });
  reader.addEventListener("error", () => reject(reader.error ?? new Error("无法读取附件")));
  reader.readAsDataURL(blob);
});

const pastedImageName = (file: File) => {
  if (file.name) return file.name;
  const extension = file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : file.type === "image/gif" ? "gif" : "png";
  return `pasted-image.${extension}`;
};

const pastedTextName = () => `pasted-text-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;

const formatTokenCount = (value: number, compact = false) =>
  (compact ? TOKEN_COMPACT_FORMATTER : TOKEN_NUMBER_FORMATTER).format(value);

const formatUsagePercent = (value: number) => `${value < 0.1 && value > 0 ? "<0.1" : value.toFixed(1)}%`;

const formatActionTime = (timestamp: number) => {
  const value = new Date(timestamp);
  return `${value.toLocaleTimeString("zh-CN", { hour12: false })}.${String(value.getMilliseconds()).padStart(3, "0")}`;
};

const formatActionDuration = (startedAt: number, completedAt?: number) => {
  if (!completedAt) return undefined;
  const duration = Math.max(0, completedAt - startedAt);
  return duration < 1_000 ? `${duration}ms` : `${(duration / 1_000).toFixed(duration < 10_000 ? 2 : 1)}s`;
};

const shortActionId = (id: string) => id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;

const messageStatus = (message: AiMessage): AiActionStatus => message.status ?? "completed";

const resolveMessageType = (message: AiMessage): AiMessageType => {
  if (message.messageType) return message.messageType;
  if (messageStatus(message) === "error") return "error";
  if (message.approval) return "approval";
  if (message.role === "user" && message.content.trim().startsWith("/run ")) return "command";
  if (message.toolCalls?.length || message.command) return "tool";
  if (!message.content && (messageStatus(message) === "started" || messageStatus(message) === "running")) return "status";
  return "text";
};

const normalizeToolCall = (toolCall: AiToolResult, fallbackId: string, fallbackTime: number): AiToolResult => {
  const status = toolCall.status ?? (toolCall.exitCode === 0 ? "completed" : "error");
  const startedAt = toolCall.startedAt ?? fallbackTime;
  const updatedAt = toolCall.updatedAt ?? toolCall.completedAt ?? startedAt;
  return {
    ...toolCall,
    id: toolCall.id || toolCall.callId || fallbackId,
    status,
    startedAt,
    updatedAt,
    completedAt: toolCall.completedAt ?? (status === "completed" || status === "error" ? updatedAt : undefined),
  };
};

const reasoningsForMessage = (message: AiMessage): AiReasoning[] => {
  const reasonings = message.reasonings?.filter((reasoning) => reasoning.id && reasoning.content.trim());
  if (reasonings?.length) return reasonings;
  return message.reasoning?.trim()
    ? [{ id: `${message.id}-reasoning-legacy`, content: message.reasoning }]
    : [];
};

const mergeReasoning = (reasonings: AiReasoning[], id: string, content: string): AiReasoning[] => {
  if (!content.trim()) return reasonings;
  const existingIndex = reasonings.findIndex((reasoning) => reasoning.id === id);
  if (existingIndex >= 0) {
    return reasonings.map((reasoning, index) => index === existingIndex ? { ...reasoning, content } : reasoning);
  }
  return [...reasonings, { id, content }];
};

function presentStreamedResponse(content: string, providerReasoning: string) {
  const start = content.indexOf(REASONING_OPEN);
  if (start < 0) {
    const possibleTagStart = content.lastIndexOf("<");
    const partialTag = possibleTagStart >= 0 ? content.slice(possibleTagStart) : "";
    return {
      content: REASONING_OPEN.startsWith(partialTag) ? content.slice(0, possibleTagStart).trim() : content,
      reasoning: providerReasoning || undefined,
    };
  }
  const summaryStart = start + REASONING_OPEN.length;
  const end = content.indexOf(REASONING_CLOSE, summaryStart);
  if (end < 0) {
    return {
      content: content.slice(0, start).trim(),
      reasoning: content.slice(summaryStart).trim() || providerReasoning || undefined,
    };
  }
  const summary = content.slice(summaryStart, end).trim();
  return {
    content: `${content.slice(0, start)}${content.slice(end + REASONING_CLOSE.length)}`.trim(),
    reasoning: summary || providerReasoning || undefined,
  };
}

const isApprovalPlaceholder = (toolCall: AiToolResult, approval?: AiApproval) =>
  Boolean(
    approval &&
    toolCall.exitCode === 126 &&
    toolCall.command === approval.command &&
    toolCall.output.startsWith("BLOCKED:"),
  );

const toolCallsForMessage = (message: AiMessage): AiToolResult[] => {
  const toolCalls = message.toolCalls?.length
    ? message.toolCalls
    : !message.command
      ? []
      : [{
          tool: message.toolName ?? "execute_command",
          command: message.command,
          output: message.commandOutput ?? "",
          exitCode: 0,
          id: `${message.id}-legacy-tool`,
          status: "completed" as const,
          startedAt: message.createdAt,
          updatedAt: message.completedAt ?? message.updatedAt ?? message.createdAt,
          completedAt: message.completedAt ?? message.updatedAt ?? message.createdAt,
      }];
  return toolCalls
    .filter((toolCall) => !isApprovalPlaceholder(toolCall, message.approval))
    .map((toolCall, index) => normalizeToolCall(toolCall, `${message.id}-tool-${index}`, message.createdAt));
};

const mergeStreamedToolCall = (
  toolCalls: AiToolResult[],
  update: NonNullable<AiStreamDelta["toolCall"]>,
) => {
  const updateId = update.id || update.callId || uid("ai-action");
  const existingIndex = toolCalls.findIndex((toolCall) => toolCall.id === updateId || toolCall.callId === update.callId);
  const existing = existingIndex >= 0 ? toolCalls[existingIndex] : undefined;
  const updatedAt = update.updatedAt ?? Date.now();
  const status = update.status
    ?? (update.phase === "started" ? "started" : update.phase === "running" ? "running" : update.phase === "error" || update.exitCode ? "error" : "completed");
  const next: AiToolResult = {
    id: updateId,
    callId: update.callId ?? existing?.callId,
    tool: update.tool || existing?.tool || "execute_command",
    command: update.command || existing?.command || update.tool,
    output: update.output ?? existing?.output ?? "",
    exitCode: update.exitCode ?? existing?.exitCode ?? (status === "error" ? 1 : 0),
    status,
    startedAt: update.startedAt ?? existing?.startedAt ?? updatedAt,
    updatedAt,
    completedAt: update.completedAt ?? existing?.completedAt ?? (status === "completed" || status === "error" ? updatedAt : undefined),
  };
  if (existingIndex < 0) return [...toolCalls, next];
  return toolCalls.map((toolCall, index) => index === existingIndex ? next : toolCall);
};

const mergeToolCalls = (current: AiToolResult[] = [], updates: AiToolResult[] = []) =>
  updates.reduce((merged, update, index) => {
    const normalized = normalizeToolCall(update, `ai-action-${index}`, update.startedAt ?? Date.now());
    const existingIndex = merged.findIndex((toolCall) => toolCall.id === normalized.id);
    if (existingIndex < 0) return [...merged, normalized];
    return merged.map((toolCall, toolCallIndex) => toolCallIndex === existingIndex ? {
      ...toolCall,
      ...normalized,
      output: normalized.output || toolCall.output,
      startedAt: Math.min(toolCall.startedAt, normalized.startedAt),
      updatedAt: Math.max(toolCall.updatedAt, normalized.updatedAt),
      completedAt: normalized.completedAt ?? toolCall.completedAt,
    } : toolCall);
  }, [...current]);

const mergeMessageById = (messages: AiMessage[], messageId: string, patch: Partial<AiMessage>) =>
  messages.map((message) => message.id === messageId ? {
    ...message,
    ...patch,
    toolCalls: patch.toolCalls ? mergeToolCalls(toolCallsForMessage(message), patch.toolCalls) : message.toolCalls,
  } : message);

function CopyAction({ text, label, className }: { text: string; label: string; className: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      className={`copy-action ${className}`}
      type="button"
      title={copied ? "已复制" : label}
      aria-label={copied ? "已复制" : label}
      onClick={() => void copy()}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
    </button>
  );
}

function ToolCallCard({ toolCall }: { toolCall: AiToolResult }) {
  const [expanded, setExpanded] = useState(toolCall.status !== "completed");
  const contentId = useId();
  const running = toolCall.status === "started" || toolCall.status === "running";
  const failed = toolCall.status === "error";
  const duration = formatActionDuration(toolCall.startedAt, toolCall.completedAt);

  useEffect(() => {
    if (toolCall.status === "completed") setExpanded(false);
  }, [toolCall.status]);

  return (
    <div className={`tool-call ${expanded ? "expanded" : "collapsed"} status-${toolCall.status}`}>
      <div className="tool-call-header">
        <button
          className="tool-call-toggle"
          type="button"
          title={expanded ? "折叠命令执行区域" : "展开命令执行区域"}
          aria-label={expanded ? "折叠命令执行区域" : "展开命令执行区域"}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <TerminalSquare size={12} />
          <span className="tool-call-name">{TOOL_LABELS[toolCall.tool] ?? toolCall.tool}</span>
          {toolCall.status === "started"
            ? <Play className="tool-call-status started" size={12} aria-label="开始" />
            : running
            ? <CircleGauge className="tool-call-status running" size={12} aria-label="执行中" />
            : failed
              ? <X className="tool-call-status failed" size={12} aria-label="执行失败" />
              : <Check className="tool-call-status" size={12} aria-label="执行完成" />}
          <span className={`tool-call-status-label ${toolCall.status}`}>{ACTION_STATUS_LABELS[toolCall.status]}</span>
        </button>
        <CopyAction className="tool-call-copy" label="复制命令" text={toolCall.command} />
      </div>
      <div className="tool-call-body" id={contentId} aria-hidden={!expanded}>
        <div className="tool-call-content">
          <div className="tool-call-metadata">
            <code title={toolCall.id}>ID {shortActionId(toolCall.id)}</code>
            <time dateTime={new Date(toolCall.startedAt).toISOString()}>{formatActionTime(toolCall.startedAt)}</time>
            {duration && <span>{duration}</span>}
          </div>
          <code>$ {toolCall.command}</code>
          {toolCall.output
            ? <pre>{toolCall.output}</pre>
            : running
              ? <pre>{toolCall.status === "started" ? "等待执行…" : "正在执行…"}</pre>
              : failed
                ? <pre>执行失败</pre>
              : null}
        </div>
      </div>
    </div>
  );
}

export function AiPane({ session, server, config, onUpdate, onOpenSettings }: Props) {
  const [input, setInput] = useState("");
  const [pastedImages, setPastedImages] = useState<DraftAiAttachment[]>([]);
  const [pasteNotice, setPasteNotice] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [autoExecute, setAutoExecute] = useState(true);
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<AiConversation[]>(readAiConversations);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [streamingMessageId, setStreamingMessageId] = useState<string>();
  const [approvalLoading, setApprovalLoading] = useState<string>();
  const requestVersionRef = useRef(0);
  const activeConversationIdRef = useRef<string>();
  const conversationsRef = useRef(conversations);
  const messagesRef = useRef(session.aiMessages);
  const compactionStateRef = useRef<{ summary: string; cutoff: number }>();
  const approvalArgumentsRef = useRef(new Map<string, Record<string, unknown>>());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  messagesRef.current = session.aiMessages;
  const historyControlRef = useRef<HTMLDivElement>(null);

  const contextLabel = useMemo(() => `${server.name} · ${session.cwd}`, [server.name, session.cwd]);
  const serverConversations = useMemo(
    () => conversations.filter((conversation) => conversation.serverId === server.id),
    [conversations, server.id],
  );
  const tokenUsage = useMemo(() => {
    const records = session.aiMessages
      .map((message) => message.usage)
      .filter((usage): usage is AiTokenUsage => Boolean(usage?.available));
    const latest = records[records.length - 1];
    const totals = records.reduce((summary, usage) => ({
      inputTokens: summary.inputTokens + usage.inputTokens,
      outputTokens: summary.outputTokens + usage.outputTokens,
      totalTokens: summary.totalTokens + usage.totalTokens,
      cachedTokens: summary.cachedTokens + usage.cachedTokens,
      reasoningTokens: summary.reasoningTokens + usage.reasoningTokens,
      requests: summary.requests + usage.requests,
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, requests: 0 });
    const contextTokens = latest?.contextTokens ?? 0;
    return {
      ...totals,
      available: records.length > 0,
      contextTokens,
      contextPercent: config.contextWindow > 0 ? Math.min(100, contextTokens / config.contextWindow * 100) : 0,
      cachePercent: totals.inputTokens > 0 ? Math.min(100, totals.cachedTokens / totals.inputTokens * 100) : 0,
    };
  }, [config.contextWindow, session.aiMessages]);
  const tokenUsagePopoverId = `token-usage-${session.id}`;

  useEffect(() => {
    compactionStateRef.current = undefined;
  }, [config.autoCompress, config.contextWindow, config.maxOutputTokens]);

  useEffect(() => {
    const syncHistory = (event: Event) => {
      const detail = (event as CustomEvent<AiConversation[]>).detail;
      const next = detail ?? readAiConversations();
      conversationsRef.current = next;
      setConversations(next);
    };
    const syncStorage = (event: StorageEvent) => {
      if (event.key === AI_HISTORY_STORAGE_KEY) syncHistory(event);
    };
    window.addEventListener(AI_HISTORY_UPDATED_EVENT, syncHistory);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(AI_HISTORY_UPDATED_EVENT, syncHistory);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !historyControlRef.current?.contains(event.target)) setHistoryOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [historyOpen]);

  const replaceConversations = (next: AiConversation[]) => {
    const published = publishAiConversations(next);
    conversationsRef.current = published;
    setConversations(published);
  };

  const setMessages = (messages: AiMessage[], persist = true) => {
    messagesRef.current = messages;
    onUpdate({ aiMessages: messages });
    if (!persist || messages.length === 0) return;
    const conversationId = activeConversationIdRef.current ?? uid("ai-conversation");
    if (!activeConversationIdRef.current) {
      activeConversationIdRef.current = conversationId;
      setActiveConversationId(conversationId);
    }
    replaceConversations(upsertAiConversation(conversationsRef.current, conversationId, server, messages));
  };
  const updateMessage = (messageId: string, patch: Partial<AiMessage>, persist = false) => {
    setMessages(mergeMessageById(messagesRef.current, messageId, patch), persist);
  };

  const insertPastedText = (textarea: HTMLTextAreaElement, text: string) => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setInput((current) => `${current.slice(0, start)}${text}${current.slice(end)}`);
    window.requestAnimationFrame(() => {
      const caret = start + text.length;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  const addPastedImages = async (files: File[], largeText?: string) => {
    const sources: PastedAttachmentSource[] = files
      .filter((file) => file.size <= MAX_PASTED_IMAGE_BYTES)
      .map((file) => ({
        kind: "image",
        name: pastedImageName(file),
        mimeType: file.type || "image/png",
        blob: file,
      }));
    let rejectedCount = files.length - sources.length;
    if (largeText) {
      const textBlob = new Blob([largeText], { type: "text/plain;charset=utf-8" });
      if (textBlob.size <= MAX_PASTED_ATTACHMENT_BYTES) {
        sources.push({ kind: "text", name: pastedTextName(), mimeType: textBlob.type, blob: textBlob });
      } else {
        rejectedCount += 1;
      }
    }
    const availableSlots = Math.max(0, MAX_PASTED_ATTACHMENTS - pastedImages.length);
    const selected = sources.slice(0, availableSlots);
    if (selected.length === 0) {
      setPasteNotice(
        availableSlots === 0
          ? `每条消息最多引用 ${MAX_PASTED_ATTACHMENTS} 个临时文件。`
          : `图片不能超过 ${MAX_PASTED_IMAGE_BYTES / 1024 / 1024} MiB，大文本不能超过 ${MAX_PASTED_ATTACHMENT_BYTES / 1024 / 1024} MiB。`,
      );
      return;
    }
    const pending = selected.map((source): DraftAiAttachment => ({
      id: uid("pasted-attachment"),
      kind: source.kind,
      mimeType: source.mimeType,
      name: source.name,
      size: source.blob.size,
      status: "uploading",
    }));
    setPastedImages((current) => [...current, ...pending]);
    setPasteNotice(`正在上传 ${pending.length} 个附件到服务器临时目录…`);
    const results = await Promise.all(pending.map(async (attachment, index) => {
      try {
        if (!isTauri()) throw new Error("仅桌面应用可上传到 SSH 服务器");
        const uploaded = await invoke<AiUploadedAttachment>("upload_ai_attachment", {
          server,
          attachmentId: attachment.id,
          name: attachment.name,
          contentBase64: await readBlobAsBase64(selected[index].blob),
        });
        setPastedImages((current) => current.map((item) => item.id === attachment.id
          ? { ...item, remotePath: uploaded.remotePath, size: uploaded.size, status: "ready", error: undefined }
          : item));
        return true;
      } catch (reason) {
        setPastedImages((current) => current.map((item) => item.id === attachment.id
          ? { ...item, status: "failed", error: String(reason) }
          : item));
        return false;
      }
    }));
    const uploadedCount = results.filter(Boolean).length;
    const failedCount = results.length - uploadedCount;
    const skippedCount = rejectedCount + sources.length - selected.length;
    setPasteNotice(
      uploadedCount
        ? `已上传 ${uploadedCount} 个临时文件${failedCount ? `；${failedCount} 个失败` : ""}${skippedCount ? `；${skippedCount} 个未添加` : ""}。`
        : `附件上传失败${skippedCount ? `；${skippedCount} 个未添加` : ""}。`,
    );
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = event.clipboardData;
    const imageFiles = Array.from(clipboard.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const text = clipboard.getData("text/plain");
    if (imageFiles.length === 0 && text.length < LARGE_PASTE_THRESHOLD) return;

    event.preventDefault();
    const largeText = text.length >= LARGE_PASTE_THRESHOLD ? text : undefined;
    if (text && !largeText) insertPastedText(event.currentTarget, text);
    void addPastedImages(imageFiles, largeText);
  };

  const removePastedImage = (imageId: string) => {
    setPastedImages((current) => current.filter((image) => image.id !== imageId));
    setPasteNotice(undefined);
    inputRef.current?.focus();
  };

  const startNewConversation = () => {
    requestVersionRef.current += 1;
    activeConversationIdRef.current = undefined;
    setActiveConversationId(undefined);
    setHistoryOpen(false);
    setInput("");
    setPastedImages([]);
    setPasteNotice(undefined);
    setLoading(false);
    setStreamingMessageId(undefined);
    setApprovalLoading(undefined);
    setThinkingOpen({});
    approvalArgumentsRef.current.clear();
    compactionStateRef.current = undefined;
    messagesRef.current = [];
    onUpdate({ aiMessages: [] });
  };

  const selectConversation = (conversation: AiConversation) => {
    requestVersionRef.current += 1;
    activeConversationIdRef.current = conversation.id;
    setActiveConversationId(conversation.id);
    setHistoryOpen(false);
    setInput("");
    setPastedImages([]);
    setPasteNotice(undefined);
    setLoading(false);
    setStreamingMessageId(undefined);
    setApprovalLoading(undefined);
    setThinkingOpen({});
    compactionStateRef.current = undefined;
    messagesRef.current = conversation.messages;
    onUpdate({ aiMessages: conversation.messages });
  };

  const deleteConversation = (conversationId: string) => {
    replaceConversations(conversationsRef.current.filter((conversation) => conversation.id !== conversationId));
    if (activeConversationIdRef.current === conversationId) startNewConversation();
  };

  const runDirectCommand = async (command: string) => {
    if (!isTauri()) return { stdout: `Preview command output\n$ ${command}\nService status: healthy`, stderr: "", exitCode: 0 };
    return invoke<{ stdout: string; stderr: string; exitCode: number }>("run_ssh_command", { server, command });
  };

  const approveToolCall = async (messageId: string, approval: AiApproval) => {
    if (approvalLoading) return;
    const approvalArguments = approvalArgumentsRef.current.get(messageId);
    if (!approvalArguments) {
      const completedAt = Date.now();
      approvalArgumentsRef.current.delete(messageId);
      setMessages(messagesRef.current.map((message) => message.id === messageId
        ? {
          ...message,
          approvalState: "rejected",
          commandOutput: "该审批请求缺少原始工具参数，已拒绝执行。",
          messageType: "error",
          status: "error",
          updatedAt: completedAt,
          completedAt,
        }
        : message));
      return;
    }
    const actionId = uid("ai-action");
    const startedAt = Date.now();
    const pendingToolCall: AiToolResult = {
      id: actionId,
      tool: approval.tool,
      command: approval.command,
      output: "",
      exitCode: 0,
      status: "running",
      startedAt,
      updatedAt: startedAt,
    };
    setApprovalLoading(messageId);
    updateMessage(messageId, {
      messageType: "approval",
      status: "running",
      updatedAt: startedAt,
      completedAt: undefined,
      toolCalls: [pendingToolCall],
    });
    try {
      const result = await invoke<AiToolResult>("approve_ai_tool", {
        server,
        tool: approval.tool,
        arguments: approvalArguments,
        settings: config.tools,
        actionId,
      });
      updateMessage(messageId, {
        toolCalls: [normalizeToolCall(result, actionId, startedAt)],
        command: result.command,
        commandOutput: result.output,
        toolName: result.tool,
        approvalState: "approved",
        messageType: "approval",
        status: result.status,
        updatedAt: result.updatedAt,
        completedAt: result.completedAt,
      }, true);
    } catch (reason) {
      const completedAt = Date.now();
      const failedToolCall: AiToolResult = {
        ...pendingToolCall,
        output: String(reason),
        exitCode: 1,
        status: "error",
        updatedAt: completedAt,
        completedAt,
      };
      updateMessage(messageId, {
        toolCalls: [failedToolCall],
        command: approval.command,
        commandOutput: String(reason),
        toolName: approval.tool,
        approvalState: "approved",
        messageType: "error",
        status: "error",
        updatedAt: completedAt,
        completedAt,
      }, true);
    } finally {
      approvalArgumentsRef.current.delete(messageId);
      setApprovalLoading(undefined);
    }
  };

  const rejectToolCall = (messageId: string) => {
    approvalArgumentsRef.current.delete(messageId);
    setMessages(messagesRef.current.map((message) => message.id === messageId ? { ...message, approvalState: "rejected" } : message));
  };

  const send = async (content = input) => {
    const text = content.trim();
    if (pastedImages.some((attachment) => attachment.status === "uploading")) {
      setPasteNotice("请等待附件上传完成后再发送。");
      return;
    }
    if (pastedImages.some((attachment) => attachment.status === "failed")) {
      setPasteNotice("请移除上传失败的附件后再发送。");
      return;
    }
    const attachments = pastedImages.flatMap((attachment): AiImageAttachment[] => attachment.remotePath ? [{
      id: attachment.id,
      kind: attachment.kind,
      remotePath: attachment.remotePath,
      mimeType: attachment.mimeType,
      name: attachment.name,
      size: attachment.size,
    }] : []);
    if ((!text && attachments.length === 0) || loading) return;
    setHistoryOpen(false);
    setInput("");
    setPastedImages([]);
    setPasteNotice(undefined);
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const userCreatedAt = Date.now();
    const userMessage: AiMessage = {
      id: uid("message"),
      role: "user",
      messageType: text.startsWith("/run ") ? "command" : "text",
      content: text || "请分析我上传到服务器临时目录的附件。",
      attachments: attachments.length ? attachments : undefined,
      createdAt: userCreatedAt,
      updatedAt: userCreatedAt,
      completedAt: userCreatedAt,
      status: "completed",
    };
    const assistantMessageId = uid("message");
    const assistantCreatedAt = Date.now();
    const assistantMessage: AiMessage = {
      id: assistantMessageId,
      role: "assistant",
      messageType: "status",
      content: "",
      createdAt: assistantCreatedAt,
      updatedAt: assistantCreatedAt,
      status: "started",
    };
    const pendingMessages = [...session.aiMessages, userMessage];
    const compactionState = config.autoCompress ? compactionStateRef.current : undefined;
    const contextMessages = compactionState
      ? [{ role: "assistant" as const, content: compactionState.summary, attachments: undefined }, ...session.aiMessages.slice(compactionState.cutoff), userMessage]
      : pendingMessages;
    setMessages(pendingMessages);
    setMessages([...pendingMessages, assistantMessage], false);
    setLoading(true);
    setStreamingMessageId(assistantMessageId);
    let streamedToolCalls: AiToolResult[] = [];

    try {
      if (text.startsWith("/run ")) {
        const command = text.slice(5).trim();
        const actionStartedAt = Date.now();
        const actionId = uid("ai-action");
        const runningToolCall: AiToolResult = {
          id: actionId,
          tool: "execute_command",
          command,
          output: "",
          exitCode: 0,
          status: "running",
          startedAt: actionStartedAt,
          updatedAt: actionStartedAt,
        };
        streamedToolCalls = [runningToolCall];
        updateMessage(assistantMessageId, {
          messageType: "command",
          status: "running",
          updatedAt: actionStartedAt,
          reasonings: [{
            id: uid("ai-reasoning"),
            content: "识别到显式 /run 指令，跳过模型推理并在当前 SSH 会话直接执行。",
          }],
          toolCalls: streamedToolCalls,
        });
        const result = await runDirectCommand(command);
        if (requestVersionRef.current !== requestVersion) return;
        const completedAt = Date.now();
        const status: AiActionStatus = result.exitCode === 0 ? "completed" : "error";
        streamedToolCalls = [{
          ...runningToolCall,
          output: `${result.stdout}${result.stderr}`,
          exitCode: result.exitCode,
          status,
          updatedAt: completedAt,
          completedAt,
        }];
        updateMessage(assistantMessageId, {
          messageType: "command",
          content: result.exitCode === 0 ? "命令已执行完成。" : "命令执行失败，请检查输出。",
          toolCalls: streamedToolCalls,
          toolName: "execute_command",
          command,
          commandOutput: `${result.stdout}${result.stderr}`,
          status,
          updatedAt: completedAt,
          completedAt,
        }, true);
      } else if (!isTauri()) {
        await new Promise((resolve) => setTimeout(resolve, 850));
        if (requestVersionRef.current !== requestVersion) return;
        const completedAt = Date.now();
        updateMessage(assistantMessageId, {
          messageType: "tool",
          content: "当前服务器运行状态正常。磁盘根分区使用率 42%，内存仍有充足余量，没有发现需要立即处理的告警。建议继续检查最近 30 分钟的服务错误日志。",
          reasonings: [{
            id: uid("ai-reasoning"),
            content: "先确认请求目标，再读取当前会话上下文；浏览器预览未连接真实 SSH，因此返回演示分析，未执行远程命令。",
          }],
          toolCalls: [{
            id: uid("ai-action"),
            tool: "execute_command",
            command: "df -h / && free -h",
            output: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        80G   32G   44G  42% /\nMem:            7.7G  2.1G  4.8G",
            exitCode: 0,
            status: "completed",
            startedAt: assistantCreatedAt,
            updatedAt: completedAt,
            completedAt,
          }],
          command: "df -h / && free -h",
          commandOutput: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        80G   32G   44G  42% /\nMem:            7.7G  2.1G  4.8G",
          status: "completed",
          updatedAt: completedAt,
          completedAt,
        }, true);
      } else {
        const streamId = uid("ai-stream");
        let streamedContent = "";
        let streamedReasoning = "";
        let streamedReasonings: AiReasoning[] = [];
        let activeReasoningId: string | undefined;
        let responseReasoningId: string | undefined;
        let streamFrame: number | undefined;
        let latestStreamUpdatedAt = assistantCreatedAt;
        const flushStream = () => {
          streamFrame = undefined;
          const visible = presentStreamedResponse(streamedContent, streamedReasoning);
          let visibleReasonings = streamedReasonings;
          if (visibleReasonings.length === 0 && visible.reasoning) {
            responseReasoningId ??= uid("ai-reasoning");
            visibleReasonings = mergeReasoning(visibleReasonings, responseReasoningId, visible.reasoning);
          }
          if (!visible.content && visibleReasonings.length === 0 && streamedToolCalls.length === 0) return;
          updateMessage(assistantMessageId, {
            messageType: streamedToolCalls.length ? "tool" : visible.content || visibleReasonings.length ? "text" : "status",
            content: visible.content,
            reasonings: visibleReasonings.length ? visibleReasonings : undefined,
            toolCalls: streamedToolCalls.length ? [...streamedToolCalls] : undefined,
            status: "running",
            updatedAt: latestStreamUpdatedAt,
          });
        };
        const scheduleStreamFlush = () => {
          if (streamFrame !== undefined) return;
          streamFrame = requestAnimationFrame(flushStream);
        };
        const unlisten = await listen<AiStreamDelta>(`ai-stream:${streamId}`, ({ payload }) => {
          if (requestVersionRef.current !== requestVersion) return;
          const eventType = payload.eventType ?? (payload.toolCall ? "action_update" : "message_delta");
          if (eventType === "message_delta") {
            streamedContent += payload.content ?? "";
            const reasoningDelta = payload.reasoning ?? "";
            streamedReasoning += reasoningDelta;
            if (reasoningDelta) {
              activeReasoningId ??= uid("ai-reasoning");
              const currentReasoning = streamedReasonings.find((reasoning) => reasoning.id === activeReasoningId);
              streamedReasonings = mergeReasoning(
                streamedReasonings,
                activeReasoningId,
                `${currentReasoning?.content ?? ""}${reasoningDelta}`,
              );
            }
          }
          if (eventType === "action_update" && payload.toolCall) {
            activeReasoningId = undefined;
            streamedToolCalls = mergeStreamedToolCall(streamedToolCalls, payload.toolCall);
          }
          latestStreamUpdatedAt = Math.max(latestStreamUpdatedAt, payload.toolCall?.updatedAt ?? Date.now());
          scheduleStreamFlush();
        });
        let response: AiResponse;
        try {
          response = await invoke<AiResponse>("ai_chat", {
            config,
            server,
            messages: contextMessages.map(({ role, content, attachments: messageAttachments }) => ({
              role,
              content,
              attachments: messageAttachments?.map(({ kind, name, remotePath, mimeType, size }) => ({ kind, name, remotePath, mimeType, size })),
            })),
            allowExecute: autoExecute,
            streamId,
          });
        } finally {
          unlisten();
          if (streamFrame !== undefined) cancelAnimationFrame(streamFrame);
          flushStream();
        }
        if (requestVersionRef.current !== requestVersion) return;
        if (response.compactionSummary && typeof response.compactionMessagesRemoved === "number") {
          const previousCutoff = compactionState?.cutoff ?? 0;
          const removedFromDisplay = compactionState
            ? Math.max(0, response.compactionMessagesRemoved - 1)
            : response.compactionMessagesRemoved;
          compactionStateRef.current = {
            summary: response.compactionSummary,
            cutoff: Math.min(pendingMessages.length, previousCutoff + removedFromDisplay),
          };
        }
        const approval = response.approval;
        const responseToolCalls = response.toolCalls
          .filter((toolCall) => !isApprovalPlaceholder(toolCall, approval))
          .map((toolCall, index) => normalizeToolCall(toolCall, `${assistantMessageId}-tool-${index}`, assistantCreatedAt));
        streamedToolCalls = mergeToolCalls(streamedToolCalls, responseToolCalls);
        const toolCalls = streamedToolCalls;
        const lastTool = toolCalls[toolCalls.length - 1];
        const lastReasoning = streamedReasonings[streamedReasonings.length - 1];
        if (response.reasoning && lastReasoning?.content.trim() !== response.reasoning.trim()) {
          responseReasoningId ??= uid("ai-reasoning");
          streamedReasonings = mergeReasoning(streamedReasonings, responseReasoningId, response.reasoning);
        }
        if (approval?.arguments) approvalArgumentsRef.current.set(assistantMessageId, approval.arguments);
        const completedAt = Date.now();
        updateMessage(assistantMessageId, {
          messageType: approval ? "approval" : toolCalls.length ? "tool" : "text",
          content: response.content,
          reasonings: streamedReasonings.length ? streamedReasonings : undefined,
          reasoning: undefined,
          toolCalls,
          toolName: lastTool?.tool,
          command: lastTool?.command,
          commandOutput: lastTool?.output,
          approval: approval ? { tool: approval.tool, command: approval.command, reason: approval.reason } : undefined,
          approvalState: approval ? "pending" : undefined,
          usage: response.usage,
          status: "completed",
          updatedAt: completedAt,
          completedAt,
        }, true);
      }
    } catch (reason) {
      if (requestVersionRef.current !== requestVersion) return;
      const error = String(reason);
      const completedAt = Date.now();
      const toolCalls = streamedToolCalls.map((toolCall) => toolCall.status === "started" || toolCall.status === "running" ? {
        ...toolCall,
        output: toolCall.output || error,
        exitCode: toolCall.exitCode || 1,
        status: "error" as const,
        updatedAt: completedAt,
        completedAt,
      } : toolCall);
      updateMessage(assistantMessageId, {
        messageType: "error",
        content: `请求失败：${error}`,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        status: "error",
        updatedAt: completedAt,
        completedAt,
      }, true);
    } finally {
      if (requestVersionRef.current === requestVersion) {
        setLoading(false);
        setStreamingMessageId(undefined);
      }
    }
  };

  return (
    <aside className="ai-pane">
      <div className="ai-header">
        <div className="pane-title"><Sparkles size={14} /><span>AI 助手</span><small>{config.model}</small></div>
        <span className="header-spacer" />
        <button className="icon-button quiet" title="新建会话" aria-label="新建会话" onClick={startNewConversation}><MessageSquarePlus size={14} /></button>
        <div className="ai-history-control" ref={historyControlRef}>
          <button
            className={`icon-button quiet ${historyOpen ? "active" : ""}`}
            title="历史会话"
            aria-label="历史会话"
            aria-haspopup="dialog"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <History size={14} />
          </button>
          {historyOpen && (
            <AiHistoryPopover
              conversations={serverConversations}
              activeConversationId={activeConversationId}
              onSelect={selectConversation}
              onDelete={deleteConversation}
            />
          )}
        </div>
        <button className="icon-button quiet" title="AI 设置" onClick={onOpenSettings}><Settings2 size={14} /></button>
        <button className="icon-button quiet" title="关闭助手" onClick={() => document.querySelector<HTMLButtonElement>('.activity-button[title="AI 助手"]')?.click()}><X size={14} /></button>
      </div>
      <div className="ai-context"><span className="environment-dot" /><span>{contextLabel}</span></div>

      <div className="ai-messages">
        {session.aiMessages.length === 0 && (
          <div className="ai-welcome">
            <div className="ai-mark"><Bot size={20} /></div>
            <h3>处理这台服务器上的任务</h3>
            <p>助手可以读取当前会话上下文、分析问题，并在获得权限时执行 SSH 命令。</p>
            <div className="starter-list">
              {STARTERS.map((starter) => <button key={starter} onClick={() => void send(starter)}><span>{starter}</span><ChevronRight size={13} /></button>)}
            </div>
          </div>
        )}
        {session.aiMessages.map((message) => {
          const status = messageStatus(message);
          const type = resolveMessageType(message);
          const updatedAt = message.updatedAt ?? message.completedAt ?? message.createdAt;
          const toolCalls = toolCallsForMessage(message);
          const reasonings = reasoningsForMessage(message);
          return (
          <article className={`ai-message ${message.role} status-${status} ${streamingMessageId === message.id ? "streaming" : ""}`} data-message-type={type} key={message.id}>
            <div className="message-meta">
              {message.role === "user" ? <User size={12} /> : <Bot size={12} />}
              <span>{message.role === "user" ? "你" : "Portico AI"}</span>
              <span>{MESSAGE_TYPE_LABELS[type]}</span>
              <span className={`message-status ${status}`}>{ACTION_STATUS_LABELS[status]}</span>
              <time dateTime={new Date(updatedAt).toISOString()}>{formatActionTime(updatedAt)}</time>
              <code title={message.id}>{shortActionId(message.id)}</code>
              {message.content.trim() && <CopyAction className="message-copy-button" label="复制消息" text={message.content} />}
            </div>
            {message.attachments?.length ? (
              <div className="message-attachments" aria-label="服务器临时文件引用">
                {message.attachments.map((attachment) => (
                  <div className="attachment-reference ready" key={attachment.id} title={attachment.remotePath}>
                    {attachment.kind === "image" ? <ImageIcon size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
                    <span className="attachment-reference-copy">
                      <strong>{attachment.name}</strong>
                      <code>{attachment.remotePath}</code>
                    </span>
                    <small>{formatBytes(attachment.size)}</small>
                  </div>
                ))}
              </div>
            ) : null}
            {reasonings.map((reasoning, index) => (
              <div className="reasoning-block" data-reasoning-id={reasoning.id} key={reasoning.id}>
                <button
                  aria-controls={`${reasoning.id}-content`}
                  aria-expanded={Boolean(thinkingOpen[reasoning.id])}
                  onClick={() => setThinkingOpen((current) => ({ ...current, [reasoning.id]: !current[reasoning.id] }))}
                >
                  <BrainCircuit size={13} />
                  <span>{reasonings.length > 1 ? `深度思考 ${index + 1}` : "深度思考"}</span>
                  <code title={reasoning.id}>{shortActionId(reasoning.id)}</code>
                  {thinkingOpen[reasoning.id] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {thinkingOpen[reasoning.id] && <p id={`${reasoning.id}-content`}>{reasoning.content}</p>}
              </div>
            ))}
            {toolCalls.map((toolCall) => (
              <ToolCallCard toolCall={toolCall} key={toolCall.id} />
            ))}
            {message.role === "assistant" && !message.content && reasonings.length === 0 && toolCalls.length === 0 && (status === "started" || status === "running") && (
              <div className="thinking-progress"><span className="thinking-pulse" /><span>{status === "started" ? "开始分析当前会话" : "正在分析当前会话"}</span></div>
            )}
            {message.approval && message.approvalState === "pending" && (
              <div className="approval-call">
                <div className="approval-call-heading">
                  <ShieldAlert size={14} />
                  <span>需要人工确认</span>
                  <small>高危命令已暂停</small>
                  <CopyAction className="approval-command-copy" label="复制命令" text={message.approval.command} />
                </div>
                <code>$ {message.approval.command}</code>
                <p>{message.approval.reason}</p>
                <div className="approval-call-actions">
                  <button className="approval-confirm" disabled={approvalLoading === message.id} onClick={() => void approveToolCall(message.id, message.approval!)}><Check size={12} />{approvalLoading === message.id ? "执行中…" : "确认并执行"}</button>
                  <button className="approval-reject" disabled={approvalLoading === message.id} onClick={() => rejectToolCall(message.id)}><X size={12} />拒绝</button>
                </div>
              </div>
            )}
            {message.approvalState === "rejected" && <div className="approval-dismissed"><X size={12} />已拒绝执行该高危操作</div>}
            {message.role === "assistant"
              ? <Suspense fallback={<div className="message-copy plain-text">{message.content}</div>}><MarkdownMessage content={message.content} /></Suspense>
              : <div className="message-copy plain-text">{message.content}</div>}
          </article>
          );
        })}
      </div>

      <div className="ai-composer-wrap">
        <div className="execution-policy">
          <button className={`toggle ${autoExecute ? "on" : ""}`} onClick={() => setAutoExecute((value) => !value)} aria-pressed={autoExecute}><span /></button>
          <span>允许执行命令</span>
          <div className="token-usage-control">
            <button
              className={`token-usage-button ${tokenUsage.available ? "has-data" : ""}`}
              type="button"
              title="当前会话 Token 用量"
              aria-label="当前会话 Token 用量"
              aria-describedby={tokenUsagePopoverId}
            >
              <CircleGauge size={14} strokeWidth={1.8} />
            </button>
            <div className="token-usage-popover" id={tokenUsagePopoverId} role="tooltip">
              <div className="token-usage-heading">
                <span>当前会话 Token</span>
                <strong>{tokenUsage.available ? formatTokenCount(tokenUsage.totalTokens, true) : "--"}</strong>
              </div>
              {tokenUsage.available ? (
                <>
                  <div className="token-context-row">
                    <span>上下文容量</span>
                    <strong>{formatTokenCount(tokenUsage.contextTokens, true)} / {formatTokenCount(config.contextWindow, true)}</strong>
                    <small>{formatUsagePercent(tokenUsage.contextPercent)}</small>
                  </div>
                  <div className="token-context-track" aria-hidden="true">
                    <span style={{ width: `${tokenUsage.contextPercent}%` }} />
                  </div>
                  <dl className="token-usage-stats">
                    <div className="input"><dt><span />输入 Token</dt><dd>{formatTokenCount(tokenUsage.inputTokens)}</dd></div>
                    <div className="output"><dt><span />输出 Token</dt><dd>{formatTokenCount(tokenUsage.outputTokens)}</dd></div>
                    <div className="cached"><dt><span />缓存 Token</dt><dd>{formatTokenCount(tokenUsage.cachedTokens)}</dd></div>
                    <div className="reasoning"><dt><span />推理 Token</dt><dd>{formatTokenCount(tokenUsage.reasoningTokens)}</dd></div>
                    <div className="requests"><dt><span />模型请求</dt><dd>{formatTokenCount(tokenUsage.requests)} 次</dd></div>
                  </dl>
                  <div className="token-cache-summary">
                    <span>缓存率</span>
                    <strong>{formatUsagePercent(tokenUsage.cachePercent)}</strong>
                    <small>{formatTokenCount(tokenUsage.cachedTokens)} / {formatTokenCount(tokenUsage.inputTokens)}</small>
                  </div>
                </>
              ) : (
                <div className="token-usage-empty">
                  <CircleGauge size={17} strokeWidth={1.6} />
                  <strong>暂无 usage 数据</strong>
                  <span>完成一次模型请求后更新</span>
                </div>
              )}
            </div>
          </div>
          <small>{autoExecute ? "自动" : "仅建议"}</small>
        </div>
        <div className="ai-composer">
          {pastedImages.length > 0 && (
            <div className="composer-attachments" aria-label="待发送的服务器临时文件引用">
              {pastedImages.map((attachment) => (
                <div className={`attachment-reference ${attachment.status}`} key={attachment.id} title={attachment.error || attachment.remotePath}>
                  {attachment.kind === "image" ? <ImageIcon size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
                  <span className="attachment-reference-copy">
                    <strong>{attachment.name}</strong>
                    <code>{attachment.status === "ready" ? attachment.remotePath : attachment.status === "uploading" ? "正在上传到服务器临时目录…" : "上传失败"}</code>
                  </span>
                  <small>{formatBytes(attachment.size)}</small>
                  <button type="button" title={`移除 ${attachment.name}`} aria-label={`移除 ${attachment.name}`} onClick={() => removePastedImage(attachment.id)}>
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            rows={2}
            value={input}
            disabled={Boolean(approvalLoading)}
            onChange={(event) => {
              setInput(event.target.value);
              setPasteNotice(undefined);
            }}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
            placeholder="描述任务，或输入 /run 执行命令"
          />
          <div className="composer-footer">
            <span className="composer-status">{pasteNotice || `当前目录 ${session.cwd}`}</span>
            {loading ? <button className="send-button stop" title="停止" onClick={() => { requestVersionRef.current += 1; setLoading(false); setStreamingMessageId(undefined); }}><CircleStop size={15} /></button> : <button className="send-button" title="发送" disabled={Boolean(approvalLoading) || pastedImages.some((attachment) => attachment.status !== "ready") || (!input.trim() && pastedImages.length === 0)} onClick={() => void send()}><Send size={15} /></button>}
          </div>
        </div>
      </div>
    </aside>
  );
}
