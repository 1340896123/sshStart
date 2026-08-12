import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
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
  ShieldCheck,
  Settings2,
  Sparkles,
  TerminalSquare,
  User,
  X,
} from "lucide-react";
import {
  AI_HISTORY_UPDATED_EVENT,
  publishAiConversations,
  readAiConversations,
  upsertAiConversation,
  type AiConversation,
} from "../aiHistory";
import { useAiAgent } from "../ai/useAiAgent";
import { formatBytes, isTauri, uid } from "../lib";
import type {
  AiActionStatus,
  AiApprovalPolicy,
  AiConfig,
  AiImageAttachment,
  AiMessage,
  AiMessageType,
  AiReasoning,
  AiTextSegment,
  AiTokenUsage,
  AiToolResult,
  ServerProfile,
  SessionState,
} from "../types";
import { AiHistoryPopover } from "./AiHistoryPopover";

const MarkdownMessage = lazy(() => import("./MarkdownMessage").then((module) => ({
  default: module.MarkdownMessage,
})));

interface Props {
  session: SessionState;
  server: ServerProfile;
  config: AiConfig;
  onUpdate: (patch: Partial<SessionState>) => void;
  onOpenSettings: () => void;
}

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

type AiTimelineItem =
  | { kind: "text"; segment: AiTextSegment; index: number; sequence: number }
  | { kind: "reasoning"; reasoning: AiReasoning; index: number; sequence: number }
  | { kind: "tool"; toolCall: AiToolResult; index: number; sequence: number };

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
  snippet_library: "命令片段",
  log_analyzer: "日志分析",
};
const ACTION_STATUS_LABELS: Record<AiActionStatus, string> = {
  started: "开始",
  running: "执行中",
  completed: "已完成",
  error: "错误",
  rejected: "已拒绝",
  cancelled: "已停止",
};
const MESSAGE_TYPE_LABELS: Record<AiMessageType, string> = {
  text: "文本",
  tool: "工具",
  approval: "审批",
  error: "错误消息",
};
const APPROVAL_POLICY_META: Record<AiApprovalPolicy, { label: string; description: string }> = {
  request: { label: "请求批准", description: "高风险或变更型工具调用等待你确认" },
  reviewer: { label: "替我审批", description: "由设置中的审核模型逐次批准或拒绝" },
  "full-access": { label: "完全访问", description: "自动批准所有运行时审批请求" },
};
const TOKEN_NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN");
const TOKEN_COMPACT_FORMATTER = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const LARGE_PASTE_THRESHOLD = 32_000;
const MAX_PASTED_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PASTED_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_PASTED_ATTACHMENTS = 4;

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
  const extension = file.type === "image/jpeg"
    ? "jpg"
    : file.type === "image/webp"
      ? "webp"
      : file.type === "image/gif"
        ? "gif"
        : "png";
  return `pasted-image.${extension}`;
};

const pastedTextName = () => `pasted-text-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
const formatTokenCount = (value: number, compact = false) =>
  (compact ? TOKEN_COMPACT_FORMATTER : TOKEN_NUMBER_FORMATTER).format(value);

const formatActionTime = (timestamp: number) => {
  const value = new Date(timestamp);
  return `${value.toLocaleTimeString("zh-CN", { hour12: false })}.${String(value.getMilliseconds()).padStart(3, "0")}`;
};

const formatActionDuration = (startedAt: number, completedAt?: number) => {
  if (!completedAt) return undefined;
  const duration = Math.max(0, completedAt - startedAt);
  return duration < 1_000
    ? `${duration}ms`
    : `${(duration / 1_000).toFixed(duration < 10_000 ? 2 : 1)}s`;
};

const shortActionId = (id: string) => id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;

const timelineForMessage = (message: AiMessage): AiTimelineItem[] => [
  ...(message.textSegments ?? []).map((segment, index): AiTimelineItem => ({
    kind: "text",
    segment,
    index,
    sequence: segment.sequence,
  })),
  ...(message.reasonings ?? []).map((reasoning, index): AiTimelineItem => ({
    kind: "reasoning",
    reasoning,
    index,
    sequence: reasoning.sequence,
  })),
  ...(message.toolCalls ?? []).map((toolCall, index): AiTimelineItem => ({
    kind: "tool",
    toolCall,
    index,
    sequence: toolCall.sequence,
  })),
].sort((left, right) => left.sequence - right.sequence || left.index - right.index);

function CopyAction({ text, label, className }: { text: string; label: string; className: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number>();

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
    resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_200);
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
  const running = toolCall.status === "started" || toolCall.status === "running";
  const [expanded, setExpanded] = useState(running);
  const contentId = useId();
  const failed = toolCall.status === "error";
  const stopped = toolCall.status === "rejected" || toolCall.status === "cancelled";
  const duration = formatActionDuration(toolCall.startedAt, toolCall.completedAt);

  useEffect(() => {
    setExpanded(running);
  }, [running]);

  return (
    <div className={`tool-call ${expanded ? "expanded" : "collapsed"} status-${toolCall.status}`}>
      <div className="tool-call-header">
        <button
          className="tool-call-toggle"
          type="button"
          aria-label={expanded ? "折叠工具执行区域" : "展开工具执行区域"}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <TerminalSquare size={12} />
          <span className="tool-call-name">{TOOL_LABELS[toolCall.tool] ?? toolCall.tool}</span>
          {toolCall.status === "started"
            ? <Play className="tool-call-status started" size={12} />
            : running
              ? <CircleGauge className="tool-call-status running" size={12} />
              : failed || stopped
                ? <X className="tool-call-status failed" size={12} />
                : <Check className="tool-call-status" size={12} />}
          <span className={`tool-call-status-label ${toolCall.status}`}>
            {ACTION_STATUS_LABELS[toolCall.status]}
          </span>
        </button>
        <CopyAction className="tool-call-copy" label="复制命令" text={toolCall.command} />
      </div>
      <div className="tool-call-body" id={contentId} aria-hidden={!expanded}>
        <div className="tool-call-content">
          <div className="tool-call-metadata">
            <code title={toolCall.id}>ID {shortActionId(toolCall.id)}</code>
            <time dateTime={new Date(toolCall.startedAt).toISOString()}>
              {formatActionTime(toolCall.startedAt)}
            </time>
            {duration && <span>{duration}</span>}
          </div>
          <code>$ {toolCall.command}</code>
          {toolCall.output
            ? <pre>{toolCall.output}</pre>
            : running
              ? <pre>Rig Agent 正在执行…</pre>
              : stopped
                ? <pre>工具调用已拒绝</pre>
                : failed
                  ? <pre>工具执行失败</pre>
                  : null}
        </div>
      </div>
    </div>
  );
}

export function AiPane({ session, server, config, onUpdate, onOpenSettings }: Props) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<DraftAiAttachment[]>([]);
  const [pasteNotice, setPasteNotice] = useState<string>();
  const [allowTools, setAllowTools] = useState(true);
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<AiConversation[]>(readAiConversations);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const activeConversationIdRef = useRef<string>();
  const conversationsRef = useRef(conversations);
  const messagesRef = useRef(session.aiMessages);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyControlRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  messagesRef.current = session.aiMessages;

  const replaceHistory = (next: AiConversation[]) => {
    const published = publishAiConversations(next);
    conversationsRef.current = published;
    setConversations(published);
  };

  const commitMessages = (next: AiMessage[], persist: boolean) => {
    messagesRef.current = next;
    onUpdate({ aiMessages: next });
    if (!persist || next.length === 0) return;
    const conversationId = activeConversationIdRef.current ?? uid("ai-conversation");
    if (!activeConversationIdRef.current) {
      activeConversationIdRef.current = conversationId;
      setActiveConversationId(conversationId);
    }
    replaceHistory(upsertAiConversation(
      conversationsRef.current,
      conversationId,
      server,
      next,
    ));
  };

  const approvalPolicy = session.approvalPolicy ?? "request";
  const agent = useAiAgent({
    config,
    server,
    messages: session.aiMessages,
    onMessagesChange: commitMessages,
    approvalPolicy,
  });

  const contextLabel = useMemo(
    () => `${server.name} · ${session.cwd}`,
    [server.name, session.cwd],
  );
  const serverConversations = useMemo(
    () => conversations.filter((conversation) => conversation.serverId === server.id),
    [conversations, server.id],
  );
  const tokenUsage = useMemo(() => {
    const usages = session.aiMessages
      .map((message) => message.usage)
      .filter((usage): usage is AiTokenUsage => Boolean(usage?.available));
    return usages.reduce((summary, usage) => ({
      available: true,
      inputTokens: summary.inputTokens + usage.inputTokens,
      outputTokens: summary.outputTokens + usage.outputTokens,
      totalTokens: summary.totalTokens + usage.totalTokens,
      cachedTokens: summary.cachedTokens + usage.cachedTokens,
      reasoningTokens: summary.reasoningTokens + usage.reasoningTokens,
      contextTokens: usage.contextTokens,
      requests: summary.requests + usage.requests,
    }), {
      available: false,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      contextTokens: 0,
      requests: 0,
    });
  }, [session.aiMessages]);
  const tokenUsagePopoverId = `token-usage-${session.id}`;

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || !shouldStickToBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [session.aiMessages]);

  useLayoutEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 200 ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    const syncHistory = (event: Event) => {
      const next = (event as CustomEvent<AiConversation[]>).detail ?? readAiConversations();
      conversationsRef.current = next;
      setConversations(next);
    };
    window.addEventListener(AI_HISTORY_UPDATED_EVENT, syncHistory);
    return () => {
      window.removeEventListener(AI_HISTORY_UPDATED_EVENT, syncHistory);
    };
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !historyControlRef.current?.contains(event.target)) {
        setHistoryOpen(false);
      }
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

  const addPastedAttachments = async (files: File[], largeText?: string) => {
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
        sources.push({
          kind: "text",
          name: pastedTextName(),
          mimeType: textBlob.type,
          blob: textBlob,
        });
      } else {
        rejectedCount += 1;
      }
    }
    const availableSlots = Math.max(0, MAX_PASTED_ATTACHMENTS - attachments.length);
    const selected = sources.slice(0, availableSlots);
    if (selected.length === 0) {
      setPasteNotice(availableSlots === 0
        ? `每条消息最多引用 ${MAX_PASTED_ATTACHMENTS} 个临时文件。`
        : "附件超过大小限制。");
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
    setAttachments((current) => [...current, ...pending]);
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
        setAttachments((current) => current.map((item) => item.id === attachment.id
          ? {
              ...item,
              remotePath: uploaded.remotePath,
              size: uploaded.size,
              status: "ready",
              error: undefined,
            }
          : item));
        return true;
      } catch (reason) {
        setAttachments((current) => current.map((item) => item.id === attachment.id
          ? { ...item, status: "failed", error: String(reason) }
          : item));
        return false;
      }
    }));
    const uploadedCount = results.filter(Boolean).length;
    const skippedCount = rejectedCount + sources.length - selected.length;
    setPasteNotice(uploadedCount
      ? `已上传 ${uploadedCount} 个临时文件${skippedCount ? `；${skippedCount} 个未添加` : ""}。`
      : "附件上传失败。");
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
    void addPastedAttachments(imageFiles, largeText);
  };

  const startNewConversation = () => {
    if (agent.running) void agent.cancel();
    activeConversationIdRef.current = undefined;
    setActiveConversationId(undefined);
    setHistoryOpen(false);
    setInput("");
    setAttachments([]);
    setPasteNotice(undefined);
    setThinkingOpen({});
    messagesRef.current = [];
    onUpdate({ aiMessages: [] });
  };

  const selectConversation = (conversation: AiConversation) => {
    if (agent.running) void agent.cancel();
    activeConversationIdRef.current = conversation.id;
    setActiveConversationId(conversation.id);
    setHistoryOpen(false);
    setInput("");
    setAttachments([]);
    setPasteNotice(undefined);
    setThinkingOpen({});
    messagesRef.current = conversation.messages;
    onUpdate({ aiMessages: conversation.messages });
  };

  const deleteConversation = (conversationId: string) => {
    replaceHistory(conversationsRef.current.filter(
      (conversation) => conversation.id !== conversationId,
    ));
    if (activeConversationIdRef.current === conversationId) startNewConversation();
  };

  const send = async (starter?: string) => {
    if (agent.running) return;
    const content = (starter ?? input).trim();
    const readyAttachments = attachments
      .filter((attachment): attachment is DraftAiAttachment & { remotePath: string } =>
        attachment.status === "ready" && Boolean(attachment.remotePath))
      .map(({ id, kind, remotePath, mimeType, name, size }) => ({
        id,
        kind,
        remotePath,
        mimeType,
        name,
        size,
      }));
    if (!content && readyAttachments.length === 0) return;
    setInput("");
    setAttachments([]);
    setPasteNotice(undefined);
    await agent.start({ content, attachments: readyAttachments, allowTools });
  };

  return (
    <aside className="ai-pane">
      <div className="ai-header">
        <div className="pane-title">
          <Sparkles size={14} />
          <span>Rig Agent</span>
          <small>{config.model} · {config.apiMode === "responses" ? "Responses" : "Chat Completions"}</small>
        </div>
        <span className="header-spacer" />
        <button className="icon-button quiet" title="新建会话" aria-label="新建会话" onClick={startNewConversation}>
          <MessageSquarePlus size={14} />
        </button>
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
        <button className="icon-button quiet" title="Agent 设置" onClick={onOpenSettings}>
          <Settings2 size={14} />
        </button>
        <button
          className="icon-button quiet"
          title="关闭助手"
          onClick={() => document.querySelector<HTMLButtonElement>('.activity-button[title="AI 助手"]')?.click()}
        >
          <X size={14} />
        </button>
      </div>
      <div className="ai-context">
        <span className="environment-dot" />
        <span>{contextLabel}</span>
      </div>

      <div
        className="ai-messages"
        ref={messagesContainerRef}
        onScroll={({ currentTarget }) => {
          const distanceFromBottom = currentTarget.scrollHeight - currentTarget.scrollTop - currentTarget.clientHeight;
          shouldStickToBottomRef.current = distanceFromBottom <= 24;
        }}
      >
        {session.aiMessages.length === 0 && (
          <div className="ai-welcome">
            <div className="ai-mark"><Bot size={20} /></div>
            <h3>让 Agent 处理服务器任务</h3>
            <p>Rig 负责模型、多轮工具和运行生命周期；变更型动作仍由你最终批准。</p>
            <div className="starter-list">
              {STARTERS.map((starter) => (
                <button key={starter} onClick={() => void send(starter)}>
                  <span>{starter}</span>
                  <ChevronRight size={13} />
                </button>
              ))}
            </div>
          </div>
        )}
        {session.aiMessages.map((message) => {
          const timeline = timelineForMessage(message);
          const hasTextTimeline = Boolean(message.textSegments?.length);
          const isStreaming = agent.running && agent.activeMessageId === message.id;
          const approvalResolving = agent.resolvingApprovalId === message.approval?.id;
          return (
            <article
              className={`ai-message ${message.role} status-${message.status} ${isStreaming ? "streaming" : ""}`}
              data-message-type={message.messageType}
              key={message.id}
            >
              <div className="message-meta">
                {message.role === "user" ? <User size={12} /> : <Bot size={12} />}
                <span>{message.role === "user" ? "你" : "Portico Rig"}</span>
                <span>{MESSAGE_TYPE_LABELS[message.messageType]}</span>
                <span className={`message-status ${message.status}`}>
                  {ACTION_STATUS_LABELS[message.status]}
                </span>
                <time dateTime={new Date(message.updatedAt).toISOString()}>
                  {formatActionTime(message.updatedAt)}
                </time>
                <code title={message.id}>{shortActionId(message.id)}</code>
                {message.content.trim() && (
                  <CopyAction className="message-copy-button" label="复制消息" text={message.content} />
                )}
              </div>
              {message.attachments?.length ? (
                <div className="message-attachments" aria-label="服务器临时文件引用">
                  {message.attachments.map((attachment) => (
                    <div className="attachment-reference ready" key={attachment.id} title={attachment.remotePath}>
                      {attachment.kind === "image"
                        ? <ImageIcon size={13} aria-hidden="true" />
                        : <FileText size={13} aria-hidden="true" />}
                      <span className="attachment-reference-copy">
                        <strong>{attachment.name}</strong>
                        <code>{attachment.remotePath}</code>
                      </span>
                      <small>{formatBytes(attachment.size)}</small>
                    </div>
                  ))}
                </div>
              ) : null}
              {timeline.map((item) => {
                if (item.kind === "text") {
                  return (
                    <div className="message-text-segment" key={item.segment.id}>
                      <Suspense fallback={<div className="message-copy plain-text">{item.segment.content}</div>}>
                        <MarkdownMessage content={item.segment.content} />
                      </Suspense>
                    </div>
                  );
                }
                if (item.kind === "reasoning") {
                  return (
                    <div className="reasoning-block" key={item.reasoning.id}>
                      <button
                        aria-controls={`${item.reasoning.id}-content`}
                        aria-expanded={Boolean(thinkingOpen[item.reasoning.id])}
                        onClick={() => setThinkingOpen((current) => ({
                          ...current,
                          [item.reasoning.id]: !current[item.reasoning.id],
                        }))}
                      >
                        <BrainCircuit size={13} />
                        <span>{(message.reasonings?.length ?? 0) > 1 ? `推理 ${item.index + 1}` : "推理"}</span>
                        <code title={item.reasoning.id}>{shortActionId(item.reasoning.id)}</code>
                        {thinkingOpen[item.reasoning.id]
                          ? <ChevronDown size={12} />
                          : <ChevronRight size={12} />}
                      </button>
                      {thinkingOpen[item.reasoning.id] && (
                        <p id={`${item.reasoning.id}-content`}>{item.reasoning.content}</p>
                      )}
                    </div>
                  );
                }
                return <ToolCallCard toolCall={item.toolCall} key={item.toolCall.id} />;
              })}
              {message.role === "assistant"
                && !message.content
                && timeline.length === 0
                && (message.status === "started" || message.status === "running") && (
                  <div className="thinking-progress">
                    <span className="thinking-pulse" />
                    <span>Rig Agent 正在规划下一步</span>
                  </div>
                )}
              {message.approval && message.approvalState === "pending" && (
                <div className="approval-call">
                  <div className="approval-call-heading">
                    <ShieldAlert size={14} />
                    <span>Agent 请求执行</span>
                    <small>{approvalResolving
                      ? approvalPolicy === "reviewer" ? "审核模型评估中" : "正在自动放行"
                      : message.approvalNote ? "需要人工处理" : "等待人工审批"}</small>
                    <CopyAction
                      className="approval-command-copy"
                      label="复制命令"
                      text={message.approval.command}
                    />
                  </div>
                  <code>$ {message.approval.command}</code>
                  <p>{message.approval.reason}</p>
                  {message.approvalNote && <p className="approval-call-note">{message.approvalNote}</p>}
                  {!approvalResolving && <div className="approval-call-actions">
                    <button
                      className="approval-confirm"
                      disabled={agent.resolvingApprovalId === message.approval.id}
                      onClick={() => void agent.resolveApproval(message.id, "approve")}
                    >
                      <Check size={12} />
                      {agent.resolvingApprovalId === message.approval.id ? "提交中…" : "批准并继续"}
                    </button>
                    <button
                      className="approval-reject"
                      disabled={agent.resolvingApprovalId === message.approval.id}
                      onClick={() => void agent.resolveApproval(message.id, "reject")}
                    >
                      <X size={12} />
                      拒绝
                    </button>
                  </div>}
                </div>
              )}
              {message.approvalState === "approved" && (
                <div className="approval-dismissed"><Check size={12} />{message.approvalNote || "已批准，Agent 正在继续"}</div>
              )}
              {message.approvalState === "rejected" && (
                <div className="approval-dismissed"><X size={12} />{message.approvalNote || "已拒绝该工具调用"}</div>
              )}
              {message.role === "assistant"
                ? !hasTextTimeline && (
                  <Suspense fallback={<div className="message-copy plain-text">{message.content}</div>}>
                    <MarkdownMessage content={message.content} />
                  </Suspense>
                )
                : <div className="message-copy plain-text">{message.content}</div>}
            </article>
          );
        })}
      </div>

      <div className="ai-composer-wrap">
        <div className="execution-policy">
          <button
            className={`toggle ${allowTools ? "on" : ""}`}
            onClick={() => setAllowTools((value) => !value)}
            aria-pressed={allowTools}
          >
            <span />
          </button>
          <span>启用 Agent 工具</span>
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
                  <dl className="token-usage-stats">
                    <div className="input"><dt><span />输入 Token</dt><dd>{formatTokenCount(tokenUsage.inputTokens)}</dd></div>
                    <div className="output"><dt><span />输出 Token</dt><dd>{formatTokenCount(tokenUsage.outputTokens)}</dd></div>
                    <div className="cached"><dt><span />缓存 Token</dt><dd>{formatTokenCount(tokenUsage.cachedTokens)}</dd></div>
                    <div className="reasoning"><dt><span />推理 Token</dt><dd>{formatTokenCount(tokenUsage.reasoningTokens)}</dd></div>
                    <div className="requests"><dt><span />模型请求</dt><dd>{formatTokenCount(tokenUsage.requests)} 次</dd></div>
                  </dl>
                  <div className="token-cache-summary">
                    <span>最近上下文</span>
                    <strong>{formatTokenCount(tokenUsage.contextTokens, true)}</strong>
                    <small>由 Rig usage 汇总</small>
                  </div>
                </>
              ) : (
                <div className="token-usage-empty">
                  <CircleGauge size={17} strokeWidth={1.6} />
                  <strong>暂无 usage 数据</strong>
                  <span>完成一次 Agent 运行后更新</span>
                </div>
              )}
            </div>
          </div>
          <small>{allowTools ? "Rig 自动编排" : "仅对话"}</small>
        </div>
        <div className="ai-composer">
          {attachments.length > 0 && (
            <div className="composer-attachments" aria-label="待发送的服务器临时文件引用">
              {attachments.map((attachment) => (
                <div
                  className={`attachment-reference ${attachment.status}`}
                  key={attachment.id}
                  title={attachment.error || attachment.remotePath}
                >
                  {attachment.kind === "image"
                    ? <ImageIcon size={13} aria-hidden="true" />
                    : <FileText size={13} aria-hidden="true" />}
                  <span className="attachment-reference-copy">
                    <strong>{attachment.name}</strong>
                    <code>
                      {attachment.status === "ready"
                        ? attachment.remotePath
                        : attachment.status === "uploading"
                          ? "正在上传到服务器临时目录…"
                          : "上传失败"}
                    </code>
                  </span>
                  <small>{formatBytes(attachment.size)}</small>
                  <button
                    type="button"
                    title={`移除 ${attachment.name}`}
                    aria-label={`移除 ${attachment.name}`}
                    onClick={() => {
                      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
                      setPasteNotice(undefined);
                      inputRef.current?.focus();
                    }}
                  >
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
            disabled={agent.running}
            onChange={(event) => {
              setInput(event.target.value);
              setPasteNotice(undefined);
            }}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="描述目标，Rig Agent 会规划并选择工具"
          />
          <div className="composer-footer">
            <label
              className="approval-policy-control"
              data-policy={approvalPolicy}
              title={APPROVAL_POLICY_META[approvalPolicy].description}
            >
              <ShieldCheck size={11} aria-hidden="true" />
              <select
                aria-label="工具审批策略"
                value={approvalPolicy}
                onChange={(event) => onUpdate({ approvalPolicy: event.target.value as AiApprovalPolicy })}
              >
                <option value="request">请求批准</option>
                <option value="reviewer" disabled={!config.reviewerModel.trim()}>替我审批</option>
                <option value="full-access">完全访问</option>
              </select>
              <ChevronDown size={10} aria-hidden="true" />
            </label>
            {pasteNotice && <span className="composer-status">{pasteNotice}</span>}
            {agent.running ? (
              <button className="send-button stop" title="停止 Agent" onClick={() => void agent.cancel()}>
                <CircleStop size={15} />
              </button>
            ) : (
              <button
                className="send-button"
                title="发送"
                disabled={attachments.some((attachment) => attachment.status !== "ready")
                  || (!input.trim() && attachments.length === 0)}
                onClick={() => void send()}
              >
                <Send size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
