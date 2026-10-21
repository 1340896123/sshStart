import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { isTauri } from "../lib";
import { AI_REASONING_EFFORT_OPTIONS, type AiConfig, type AiModelSettings, type AiReasoningEffort } from "../types";

interface Props {
  config: AiConfig;
  disabled: boolean;
  onChange: (patch: Partial<AiModelSettings>) => void;
}

export function AiModelControls({ config, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverPosition, setPopoverPosition] = useState<CSSProperties>({});
  const popoverId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const control = controlRef.current;
    const trigger = triggerRef.current;
    const pane = control?.closest<HTMLElement>(".ai-pane");
    const composer = control?.closest<HTMLElement>(".ai-composer");
    if (!control || !trigger || !pane || !composer) return;
    const reposition = () => {
      const bounds = composer.getBoundingClientRect();
      const topEdge = Math.max(8, pane.getBoundingClientRect().top + 8);
      // Keep the input exposed when a usable picker fits above the composer.
      const anchor = bounds.top - topEdge - 8 >= 180 ? bounds : trigger.getBoundingClientRect();
      const above = Math.max(0, anchor.top - topEdge - 8);
      const below = Math.max(0, window.innerHeight - anchor.bottom - 8);
      const showAbove = above >= 180 || above >= below;
      const width = Math.min(bounds.width, window.innerWidth - 16);
      setPopoverPosition({
        left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
        width,
        maxHeight: Math.min(380, showAbove ? above : below),
        ...(showAbove ? { bottom: window.innerHeight - anchor.top + 8 } : { top: anchor.bottom + 8 }),
      });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(control);
    observer.observe(composer);
    observer.observe(pane);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || disabled) { setOpen(false); return; }
    let cancelled = false;
    setLoading(true);
    setModels([]);
    setError("");
    const load = async () => {
      try {
        if (!isTauri()) throw new Error("请在桌面应用中获取模型列表，也可直接输入模型 ID。");
        const result = await invoke<string[]>("list_rig_models", { config });
        if (!cancelled) setModels([...new Set(result)]);
      } catch (reason) {
        if (!cancelled) setError(String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [open, disabled, config.endpoint, config.apiKey, refresh]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const available = [...new Set([config.model, ...models].filter(Boolean))];
  const filtered = available.filter((model) => model.toLowerCase().includes(query.trim().toLowerCase()));
  const custom = query.trim();
  const choose = (model: string) => {
    if (disabled || !model.trim()) return;
    onChange({ model: model.trim() });
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="ai-model-controls" ref={controlRef}>
      <button
        className="composer-model-trigger"
        type="button"
        ref={triggerRef}
        title={`选择模型：${config.model}`}
        aria-label={`选择模型：${config.model}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={disabled}
        onClick={() => { setOpen((value) => !value); setQuery(""); }}
      >
        <span>{config.model || "选择模型"}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      <label className="composer-effort-control" title="思考强度；自动使用模型默认值，其他档位需模型支持">
        <span className="sr-only">思考强度</span>
        <select
          aria-label="思考强度"
          value={config.reasoningEffort}
          disabled={disabled}
          onChange={(event) => onChange({ reasoningEffort: event.target.value as AiReasoningEffort })}
        >
          {AI_REASONING_EFFORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.value === "auto" ? "思考 · 自动" : `思考 · ${option.label}`}</option>
          ))}
        </select>
        <ChevronDown size={10} aria-hidden="true" />
      </label>
      {open && (
        <section className="composer-model-popover" style={popoverPosition} id={popoverId} role="dialog" aria-label="选择对话模型">
          <header>
            <strong>选择模型</strong>
            <button type="button" className="icon-button quiet" title="刷新模型列表" aria-label="刷新模型列表" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
              {loading ? <LoaderCircle size={14} className="ai-loading-icon" /> : <RefreshCw size={14} />}
            </button>
          </header>
          <form className="composer-model-search" onSubmit={(event) => { event.preventDefault(); choose(custom); }}>
            <Search size={14} aria-hidden="true" />
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索或输入模型 ID" placeholder="搜索或输入模型 ID" />
          </form>
          <div className="composer-model-list" aria-label="可用模型">
            {filtered.map((model) => (
              <button className={`composer-model-option ${model === config.model ? "selected" : ""}`} key={model} type="button" aria-pressed={model === config.model} onClick={() => choose(model)}>
                <span>{model}</span>
                {model === config.model && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
            {custom && !available.includes(custom) && (
              <button className="composer-model-option custom" type="button" onClick={() => choose(custom)}><span>使用「{custom}」</span></button>
            )}
          </div>
          <p className={`composer-model-note ${error ? "error" : ""}`} role="status" title={error || undefined}>
            {loading ? "正在获取模型列表…" : error ? "暂时无法获取列表，可输入模型 ID 后按 Enter 使用。" : "选择模型，或输入自定义模型 ID。"}
          </p>
        </section>
      )}
    </div>
  );
}
