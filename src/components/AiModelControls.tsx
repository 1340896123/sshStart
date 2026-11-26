import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { AI_REASONING_EFFORT_OPTIONS, type AiConfig, type AiModelSettings, type AiReasoningEffort } from "../types";

interface Props {
  config: AiConfig;
  disabled: boolean;
  onChange: (patch: Partial<AiModelSettings>) => void;
}

export function AiModelControls({ config, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const provider = config.providers.find((item) => item.id === config.selectedProviderId);
  const modelConfig = provider?.models.find((item) => item.id === config.model);
  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [popoverPosition, setPopoverPosition] = useState<CSSProperties>({});
  const popoverId = useId();
  const effortLabel = AI_REASONING_EFFORT_OPTIONS.find((option) => option.value === config.reasoningEffort)?.label ?? "自动";

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
      const anchor = bounds.top - topEdge - 8 >= 280 ? bounds : trigger.getBoundingClientRect();
      const above = Math.max(0, anchor.top - topEdge - 8);
      const below = Math.max(0, window.innerHeight - anchor.bottom - 8);
      const showAbove = above >= 280 || above >= below;
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

  useEffect(() => { setOpen(false); }, [disabled]);

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

  const available = provider?.models.map((model) => model.id).filter(Boolean) ?? [];
  const filtered = available.filter((model) => model.toLowerCase().includes(query.trim().toLowerCase()));
  const choose = (model: string) => {
    if (disabled || !model.trim()) return;
    onChange({ model: model.trim() });
  };

  return (
    <div className="ai-model-controls" ref={controlRef} onBlur={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        className="composer-model-trigger"
        type="button"
        ref={triggerRef}
        title={`${provider?.name ?? ""} · ${config.model} · 思考强度：${effortLabel}`}
        aria-label={`选择模型：${config.model}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={disabled}
        onClick={() => { setOpen((value) => !value); setQuery(""); }}
      >
        <span>{config.model || "选择模型"}</span>
        <small>{effortLabel}</small>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {open && (
        <section className="composer-model-popover" style={popoverPosition} id={popoverId} role="dialog" aria-label="选择对话模型">
          <header>
            <strong>模型与思考强度</strong>
            <button className="composer-picker-done" type="button" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>完成</button>
          </header>
          <label className="composer-picker-setting composer-provider-control">
            <span>提供商</span>
            <select aria-label="模型提供商" value={config.selectedProviderId} disabled={disabled}
              onChange={(event) => { onChange({ providerId: event.target.value }); setQuery(""); }}>
              {config.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <form className="composer-model-search" onSubmit={(event) => { event.preventDefault(); if (filtered.length === 1) choose(filtered[0]); }}>
            <Search size={14} aria-hidden="true" />
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索模型 ID" placeholder="搜索已配置的模型"
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  controlRef.current?.querySelector<HTMLButtonElement>(".composer-model-option")?.focus();
                }
              }} />
          </form>
          <div className="composer-model-list" aria-label="可用模型">
            {filtered.map((model) => (
              <button className={`composer-model-option ${model === config.model ? "selected" : ""}`} key={model} type="button" aria-pressed={model === config.model} onClick={() => choose(model)}>
                <span>{model}</span>
                {model === config.model && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <label className="composer-picker-setting composer-effort-control">
            <span>思考强度</span>
            <select aria-label="思考强度" value={config.reasoningEffort} disabled={disabled || !modelConfig}
              onChange={(event) => onChange({ reasoningEffort: event.target.value as AiReasoningEffort })}>
              {AI_REASONING_EFFORT_OPTIONS.filter((option) => modelConfig?.reasoningEfforts.includes(option.value)).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <p className="composer-model-note" role="status">{filtered.length ? `${provider?.name} · ${available.length} 个已配置模型` : "没有匹配的模型，可在设置中添加。"}</p>
        </section>
      )}
    </div>
  );
}
