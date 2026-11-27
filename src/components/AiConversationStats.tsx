import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { CircleGauge, Database } from "lucide-react";
import { conversationStatistics } from "../ai/statistics";
import type { AiMessage, AiTokenUsage } from "../types";

interface Props {
  messages: AiMessage[];
  contextWindow: number;
  running: boolean;
  hidden: boolean;
}

type Detail = "session" | "tokens" | "context";
const TITLES: Record<Detail, string> = { session: "会话统计", tokens: "Token 用量", context: "上下文用量" };
const numberFormatter = new Intl.NumberFormat("zh-CN");
const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const count = (value: number) => numberFormatter.format(value);
const compactCount = (value: number) => compactFormatter.format(value);
const duration = (milliseconds?: number) => {
  if (milliseconds === undefined) return "--";
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}秒`;
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return `${hours ? `${hours}小时` : ""}${minutes}分${seconds % 60}秒`;
};

export function AiConversationStats({ messages, contextWindow, running, hidden }: Props) {
  const [detail, setDetail] = useState<Detail>();
  const [now, setNow] = useState(Date.now);
  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>();
  const popoverId = useId();
  const conversationId = messages.find((message) => message.role === "user")?.id;
  const statistics = conversationStatistics(messages, running ? now : Date.now());
  const usage = messages.reduce<AiTokenUsage>((summary, message) => {
    const next = message.usage;
    if (message.role !== "assistant" || !next?.available) return summary;
    return {
      available: true,
      inputTokens: summary.inputTokens + next.inputTokens,
      outputTokens: summary.outputTokens + next.outputTokens,
      totalTokens: summary.totalTokens + next.totalTokens,
      cachedTokens: summary.cachedTokens + next.cachedTokens,
      reasoningTokens: summary.reasoningTokens + next.reasoningTokens,
      contextTokens: next.contextTokens,
      contextBreakdown: next.contextBreakdown,
      requests: summary.requests + next.requests,
    };
  }, { available: false, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, contextTokens: 0, requests: 0 });
  const cacheRate = usage.inputTokens > 0 ? Math.min(100, Math.round(usage.cachedTokens / usage.inputTokens * 100)) : 0;
  const uncachedInputTokens = Math.max(0, usage.inputTokens - usage.cachedTokens);
  const contextPercent = usage.available && contextWindow > 0 ? Math.round(usage.contextTokens / contextWindow * 100) : undefined;
  const contextParts = [
    { key: "system", label: "系统提示词", tokens: usage.contextBreakdown?.systemPromptTokens },
    { key: "tools", label: "工具定义", tokens: usage.contextBreakdown?.toolDefinitionTokens },
    { key: "messages", label: "对话消息", tokens: usage.contextBreakdown?.conversationTokens },
  ];
  const summary = `${count(statistics.rounds)} 轮 ${count(statistics.steps)} 步`;
  const speed = statistics.tokensPerSecond === undefined ? "--" : `${statistics.tokensPerSecond.toFixed(0)} tok/s`;

  useEffect(() => { setDetail(undefined); }, [conversationId, hidden]);
  useEffect(() => {
    if (!running || hidden || !detail) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [running, hidden, detail]);
  useEffect(() => {
    if (!detail) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target)) setDetail(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setDetail(undefined);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, [detail]);

  const toggle = (next: Detail, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger;
    setNow(Date.now());
    setDetail((current) => current === next ? undefined : next);
  };
  const triggerProps = (next: Detail) => ({
    type: "button" as const,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": detail === next,
    "aria-controls": detail === next ? popoverId : undefined,
    onClick: (event: MouseEvent<HTMLButtonElement>) => toggle(next, event.currentTarget),
  });

  return (
    <div className="token-usage-control" ref={controlRef} onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setDetail(undefined);
    }}>
      <button {...triggerProps("session")} className="composer-stat-trigger composer-request-usage" aria-label="会话统计" title="会话统计">
        <CircleGauge size={13} aria-hidden="true" />{summary}
        {statistics.tokensPerSecond !== undefined && <span className="composer-output-speed"> · {speed}</span>}
      </button>
      <button {...triggerProps("tokens")} className="composer-stat-trigger composer-token-total" aria-label="当前会话 Token 用量" title="当前会话 Token 用量">
        <Database size={13} aria-hidden="true" />{usage.available ? compactCount(usage.totalTokens) : "--"} tok
        <span className="composer-cache-rate"> · 缓存命中 {usage.available ? `${cacheRate}%` : "--"}</span>
      </button>
      <button {...triggerProps("context")} className="composer-stat-trigger composer-context-usage" aria-label="上下文用量" title="上下文用量">
        <span className="composer-context-ring" style={{ background: `conic-gradient(var(--muted) ${Math.min(100, contextPercent ?? 0)}%, var(--border) 0)` }} aria-hidden="true" />
        {contextPercent === undefined ? "--" : `${contextPercent}%`}
      </button>
      {detail && <section className="token-usage-popover" data-detail={detail} id={popoverId} role="dialog" aria-label={TITLES[detail]}>
        {detail === "context" ? <div className="context-usage-heading">
          <span>上下文已用 <strong>{contextPercent === undefined ? "--" : `${contextPercent}%`}</strong></span>
          <b title={`${usage.available ? count(usage.contextTokens) : "--"} / ${contextWindow > 0 ? count(contextWindow) : "--"} Token`}>
            {usage.available ? `~${compactCount(usage.contextTokens)}` : "--"} / {contextWindow > 0 ? compactCount(contextWindow) : "--"}
          </b>
        </div> : <div className="token-usage-heading">
          <span>{detail === "session" && <CircleGauge size={13} aria-hidden="true" />}{detail === "tokens" && <Database size={13} aria-hidden="true" />}{TITLES[detail]}</span>
          <strong>{detail === "session" ? summary : detail === "tokens" ? `${usage.available ? count(usage.totalTokens) : "--"} tok` : contextPercent === undefined ? "--" : `${contextPercent}%`}</strong>
        </div>}
        {detail === "session" ? <dl className="token-usage-stats">
          <div title="任务总耗时扣除工具调用阶段，包含网络与模型等待时间"><dt>模型用时（估算）</dt><dd>{duration(statistics.modelMs)}</dd></div>
          <div title="工具调用阶段耗时，包含审批等待；并行工具的重叠区间只计一次"><dt>工具调用用时</dt><dd>{duration(statistics.toolMs)}</dd></div>
          <div title={`已记录的 ${statistics.ttftSamples} 轮任务从启动到首个文本或思考 token 的平均延迟`}><dt>首 token 平均（TTFT）</dt><dd>{duration(statistics.averageTtftMs)}</dd></div>
          <div title="已完成任务的输出 Token 数除以流式输出时长，扣除工具调用阶段"><dt>输出速度（TPS）</dt><dd>{speed}</dd></div>
        </dl> : detail === "tokens" ? usage.available ? <dl className="token-usage-stats">
          <div><dt>缓存命中</dt><dd>{cacheRate}%</dd></div>
          <div><dt>未缓存输入</dt><dd>{count(uncachedInputTokens)} tok</dd></div>
          <div><dt>缓存读取</dt><dd>{count(usage.cachedTokens)} tok</dd></div>
          <div><dt>输出</dt><dd>{count(usage.outputTokens)} tok</dd></div>
        </dl> : <p className="stats-empty">暂无用量数据，模型返回用量后更新。</p> : <>
          <div className="context-usage-track" role="progressbar" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={contextWindow > 0 ? contextWindow : 100}
            aria-valuenow={contextPercent === undefined ? undefined : Math.min(contextWindow, usage.contextTokens)}
            aria-valuetext={usage.available ? `已用 ${count(usage.contextTokens)} Token，上限 ${count(contextWindow)} Token` : "暂无用量数据"}>
            {usage.contextBreakdown ? contextParts.map((part) => <span key={part.key} className={`context-${part.key}`}
              style={{ width: `${contextWindow > 0 ? Math.max(0, part.tokens ?? 0) / contextWindow * 100 : 0}%` }} />)
              : <span className="context-messages" style={{ width: `${Math.min(100, contextPercent ?? 0)}%` }} />}
          </div>
          <dl className="token-usage-stats context-usage-breakdown" title={usage.contextBreakdown ? "分项按实际系统提示和工具定义估算，对话消息包含历史消息、工具结果及请求格式开销。" : "此会话未记录上下文分项；新请求返回用量后更新。"}>
            {contextParts.map((part) => <div key={part.key}>
              <dt><span className={`context-${part.key}`} />{part.label}</dt>
              <dd>{part.tokens === undefined ? "--" : `~${compactCount(part.tokens)}`}</dd>
            </div>)}
          </dl>
        </>}
      </section>}
    </div>
  );
}
