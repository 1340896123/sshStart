import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Copy,
  History,
  MessageSquarePlus,
  Play,
  Send,
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
import { isTauri, uid } from "../lib";
import type { AiConfig, AiMessage, AiResponse, ServerProfile, SessionState } from "../types";
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

export function AiPane({ session, server, config, onUpdate, onOpenSettings }: Props) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [autoExecute, setAutoExecute] = useState(true);
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<AiConversation[]>(readAiConversations);
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const requestVersionRef = useRef(0);
  const activeConversationIdRef = useRef<string>();
  const conversationsRef = useRef(conversations);
  const historyControlRef = useRef<HTMLDivElement>(null);

  const contextLabel = useMemo(() => `${server.name} · ${session.cwd}`, [server.name, session.cwd]);
  const serverConversations = useMemo(
    () => conversations.filter((conversation) => conversation.serverId === server.id),
    [conversations, server.id],
  );

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

  const setMessages = (messages: AiMessage[]) => {
    onUpdate({ aiMessages: messages });
    if (messages.length === 0) return;
    const conversationId = activeConversationIdRef.current ?? uid("ai-conversation");
    if (!activeConversationIdRef.current) {
      activeConversationIdRef.current = conversationId;
      setActiveConversationId(conversationId);
    }
    replaceConversations(upsertAiConversation(conversationsRef.current, conversationId, server, messages));
  };

  const startNewConversation = () => {
    requestVersionRef.current += 1;
    activeConversationIdRef.current = undefined;
    setActiveConversationId(undefined);
    setHistoryOpen(false);
    setInput("");
    setLoading(false);
    setThinkingOpen({});
    onUpdate({ aiMessages: [] });
  };

  const selectConversation = (conversation: AiConversation) => {
    requestVersionRef.current += 1;
    activeConversationIdRef.current = conversation.id;
    setActiveConversationId(conversation.id);
    setHistoryOpen(false);
    setInput("");
    setLoading(false);
    setThinkingOpen({});
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

  const send = async (content = input) => {
    const text = content.trim();
    if (!text || loading) return;
    setHistoryOpen(false);
    setInput("");
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const userMessage: AiMessage = { id: uid("message"), role: "user", content: text, createdAt: Date.now() };
    const pendingMessages = [...session.aiMessages, userMessage];
    setMessages(pendingMessages);
    setLoading(true);

    try {
      if (text.startsWith("/run ")) {
        const command = text.slice(5).trim();
        const result = await runDirectCommand(command);
        if (requestVersionRef.current !== requestVersion) return;
        setMessages([...pendingMessages, {
          id: uid("message"), role: "assistant", content: result.exitCode === 0 ? "命令已执行完成。" : "命令执行失败，请检查输出。",
          reasoning: "识别到显式 /run 指令，跳过模型推理并在当前 SSH 会话直接执行。",
          command, commandOutput: `${result.stdout}${result.stderr}`, createdAt: Date.now(),
        }]);
      } else if (!isTauri()) {
        await new Promise((resolve) => setTimeout(resolve, 850));
        if (requestVersionRef.current !== requestVersion) return;
        setMessages([...pendingMessages, {
          id: uid("message"), role: "assistant",
          content: "当前服务器运行状态正常。磁盘根分区使用率 42%，内存仍有充足余量，没有发现需要立即处理的告警。建议继续检查最近 30 分钟的服务错误日志。",
          reasoning: "先确认请求目标，再读取当前会话上下文；浏览器预览未连接真实 SSH，因此返回演示分析，未执行远程命令。",
          command: "df -h / && free -h",
          commandOutput: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        80G   32G   44G  42% /\nMem:            7.7G  2.1G  4.8G",
          createdAt: Date.now(),
        }]);
      } else {
        const response = await invoke<AiResponse>("ai_chat", {
          config,
          server,
          messages: pendingMessages.map(({ role, content }) => ({ role, content })),
          allowExecute: autoExecute,
        });
        if (requestVersionRef.current !== requestVersion) return;
        const lastTool = response.toolCalls[response.toolCalls.length - 1];
        setMessages([...pendingMessages, {
          id: uid("message"), role: "assistant", content: response.content,
          reasoning: response.reasoning, command: lastTool?.command, commandOutput: lastTool?.output, createdAt: Date.now(),
        }]);
      }
    } catch (reason) {
      if (requestVersionRef.current !== requestVersion) return;
      setMessages([...pendingMessages, { id: uid("message"), role: "assistant", content: `请求失败：${String(reason)}`, createdAt: Date.now() }]);
    } finally {
      if (requestVersionRef.current === requestVersion) setLoading(false);
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
        {session.aiMessages.map((message) => (
          <article className={`ai-message ${message.role}`} key={message.id}>
            <div className="message-meta">{message.role === "user" ? <User size={12} /> : <Bot size={12} />}<span>{message.role === "user" ? "你" : "Portico AI"}</span></div>
            {message.role === "assistant"
              ? <Suspense fallback={<div className="message-copy plain-text">{message.content}</div>}><MarkdownMessage content={message.content} /></Suspense>
              : <div className="message-copy plain-text">{message.content}</div>}
            {message.reasoning && (
              <div className="reasoning-block">
                <button onClick={() => setThinkingOpen((current) => ({ ...current, [message.id]: !current[message.id] }))}>
                  <BrainCircuit size={13} /><span>深度思考</span>{thinkingOpen[message.id] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {thinkingOpen[message.id] && <p>{message.reasoning}</p>}
              </div>
            )}
            {message.command && (
              <div className="tool-call">
                <div className="tool-call-header"><TerminalSquare size={12} /><span>执行命令</span><Check size={12} /><button title="复制命令" onClick={() => navigator.clipboard.writeText(message.command ?? "")}><Copy size={11} /></button></div>
                <code>$ {message.command}</code>
                {message.commandOutput && <pre>{message.commandOutput}</pre>}
              </div>
            )}
          </article>
        ))}
        {loading && (
          <article className="ai-message assistant thinking-message">
            <div className="message-meta"><Bot size={12} /><span>Portico AI</span></div>
            <div className="thinking-progress"><span className="thinking-pulse" /><span>正在分析当前会话</span></div>
            <div className="thinking-steps"><span>读取上下文</span><span>评估命令风险</span><span>准备响应</span></div>
          </article>
        )}
      </div>

      <div className="ai-composer-wrap">
        <div className="execution-policy">
          <button className={`toggle ${autoExecute ? "on" : ""}`} onClick={() => setAutoExecute((value) => !value)} aria-pressed={autoExecute}><span /></button>
          <span>允许执行命令</span>
          <small>{autoExecute ? "自动" : "仅建议"}</small>
        </div>
        <div className="ai-composer">
          <textarea
            rows={2}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
            placeholder="描述任务，或输入 /run 执行命令"
          />
          <div className="composer-footer"><span>当前目录 {session.cwd}</span>{loading ? <button className="send-button stop" title="停止" onClick={() => { requestVersionRef.current += 1; setLoading(false); }}><CircleStop size={15} /></button> : <button className="send-button" title="发送" disabled={!input.trim()} onClick={() => void send()}><Send size={15} /></button>}</div>
        </div>
      </div>
    </aside>
  );
}
