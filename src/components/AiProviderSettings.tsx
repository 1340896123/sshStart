import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Box, Check, ChevronDown, ChevronRight, Eye, EyeOff, Plus, RefreshCw, Trash2 } from "lucide-react";
import { isTauri, uid } from "../lib";
import { AI_REASONING_EFFORT_OPTIONS, changeAiModelSettings, createAiProviderModel, normalizeAiConfig,
  type AiConfig, type AiProvider, type AiProviderModel, type AiReasoningEffort } from "../types";

interface Props {
  value: AiConfig;
  onChange: (value: AiConfig) => void;
  onRemoveSavedKey: (providerId: string) => Promise<void>;
  disabled: boolean;
}

export function AiProviderSettings({ value, onChange, onRemoveSavedKey, disabled }: Props) {
  const [editingId, setEditingId] = useState(value.selectedProviderId);
  const [modelIndex, setModelIndex] = useState<number>();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [keyVisible, setKeyVisible] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const treeRef = useRef<HTMLUListElement>(null);
  const editorRef = useRef<HTMLFieldSetElement>(null);
  const provider = value.providers.find((item) => item.id === editingId) ?? value.providers[0];
  const model = modelIndex === undefined ? undefined : provider?.models[modelIndex];
  const selectedKey = model ? `${provider.id}:model:${modelIndex}` : provider?.id;
  const busy = disabled || removing;

  useEffect(() => {
    request.current += 1;
    setModels([]); setLoading(false); setError(""); setQuery(""); setKeyVisible(false);
    return () => { request.current += 1; };
  }, [provider?.id, provider?.endpoint, provider?.apiMode, provider?.apiKey]);

  useEffect(() => { editorRef.current?.scrollTo(0, 0); }, [provider?.id, modelIndex]);
  useEffect(() => {
    treeRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedKey]);

  const update = (patch: Partial<AiProvider>) => onChange(normalizeAiConfig({ ...value,
    providers: value.providers.map((item) => item.id === provider.id ? { ...item, ...patch } : item) }));
  const edit = (id: string, index?: number) => {
    setEditingId(id); setModelIndex(index); setKeyVisible(false);
  };
  const expand = (id: string) => setCollapsed((current) => {
    const next = new Set(current); next.delete(id); return next;
  });
  const toggle = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (id === provider?.id && model) edit(id);
  };
  const focusNode = (node: HTMLElement | undefined | null) => {
    node?.focus(); node?.scrollIntoView({ block: "nearest" });
  };
  const treeKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (busy || !(event.target instanceof HTMLElement)) return;
    const node = event.target.closest<HTMLElement>('[role="treeitem"]');
    if (!node) return;
    const nodes = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
    const position = nodes.indexOf(node);
    const id = node.dataset.providerId!;
    const isProvider = node.dataset.modelIndex === undefined;
    switch (event.key) {
      case "ArrowDown": focusNode(nodes[Math.min(nodes.length - 1, position + 1)]); break;
      case "ArrowUp": focusNode(nodes[Math.max(0, position - 1)]); break;
      case "Home": focusNode(nodes[0]); break;
      case "End": focusNode(nodes[nodes.length - 1]); break;
      case "ArrowRight":
        if (isProvider) {
          if (collapsed.has(id)) expand(id);
          else focusNode(node.querySelector<HTMLElement>('[role="group"] [role="treeitem"]'));
        }
        break;
      case "ArrowLeft":
        if (isProvider) { if (!collapsed.has(id)) toggle(id); }
        else focusNode(node.parentElement?.closest<HTMLElement>('[role="treeitem"]'));
        break;
      case "Enter": case " ": edit(id, isProvider ? undefined : Number(node.dataset.modelIndex)); break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
  };
  const addProvider = () => {
    const id = uid("provider");
    onChange(normalizeAiConfig({ ...value, providers: [...value.providers, {
      id, name: `提供商 ${value.providers.length + 1}`, apiMode: "chat-completions", endpoint: "", apiKey: "",
      models: [createAiProviderModel("")], selectedModelId: "",
    }] }));
    edit(id);
  };
  const addModel = () => {
    update({ models: [...provider.models, createAiProviderModel("")] });
    expand(provider.id); setModelIndex(provider.models.length);
  };
  const updateModel = (patch: Partial<AiProviderModel>) => {
    if (!model) return;
    update({ models: provider.models.map((item, index) => index === modelIndex ? { ...item, ...patch } : item),
      ...(patch.id !== undefined && provider.selectedModelId === model.id ? { selectedModelId: patch.id } : {}) });
  };
  const loadModels = async () => {
    const sequence = ++request.current;
    setLoading(true); setError(""); setModels([]);
    try {
      if (!isTauri()) throw new Error("请在桌面应用中获取模型列表，也可以手动添加模型 ID。");
      const result = await invoke<string[]>("list_rig_models", { config: changeAiModelSettings(value, { providerId: provider.id }) });
      if (sequence === request.current) {
        setModels([...new Set(result)].sort());
        if (!result.length) setError("此提供商未返回模型，可手动添加模型 ID。");
      }
    } catch (reason) { if (sequence === request.current) setError(String(reason)); }
    finally { if (sequence === request.current) setLoading(false); }
  };
  const removeKey = async () => {
    setRemoving(true); setError("");
    try { await onRemoveSavedKey(provider.id); update({ apiKey: "" }); }
    catch (reason) { setError(String(reason)); }
    finally { setRemoving(false); }
  };
  const isCurrentModel = provider?.id === value.selectedProviderId && model?.id === value.model;

  return (
    <div className="provider-settings">
      <aside className="settings-panel provider-tree-panel" aria-label="提供商和模型导航">
        <header className="settings-panel-header-with-action"><div><strong>提供商与模型</strong><small>{value.providers.length} 个提供商 · {value.providers.reduce((count, item) => count + item.models.length, 0)} 个模型</small></div>
          <button type="button" className="icon-button quiet" disabled={busy} onClick={addProvider} aria-label="添加提供商" title="添加提供商"><Plus size={16} /></button>
        </header>
        <ul className="provider-tree" role="tree" aria-label="模型提供商列表" ref={treeRef} onKeyDown={treeKeyDown} aria-disabled={busy}>
          {value.providers.map((item) => {
            const name = item.name || "未命名提供商";
            const expanded = !collapsed.has(item.id);
            return <li key={item.id} role="treeitem" className="provider-tree-branch" data-provider-id={item.id}
              aria-label={name} aria-expanded={expanded} aria-selected={selectedKey === item.id} aria-level={1} tabIndex={selectedKey === item.id ? 0 : -1}
              onFocus={(event) => { if (!busy && event.target === event.currentTarget) edit(item.id); }}
              onClick={(event) => { if (!busy && event.target instanceof Element && event.target.closest('[role="treeitem"]') === event.currentTarget) focusNode(event.currentTarget); }}>
              <div className={`provider-tree-row ${selectedKey === item.id ? "selected" : ""}`}>
                <button type="button" className="provider-tree-toggle" tabIndex={-1} disabled={busy} aria-label={`${expanded ? "收起" : "展开"} ${name} 的模型`}
                  onClick={(event) => { event.stopPropagation(); toggle(item.id); focusNode(event.currentTarget.closest<HTMLElement>('[role="treeitem"]')); }}>
                  {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <Bot size={16} aria-hidden="true" /><span className="provider-tree-name" title={name}>{name}</span>
                {item.id === value.selectedProviderId && <span className="provider-tree-current">使用中</span>}
                <small>{item.models.length}</small>
              </div>
              {expanded && <ul role="group" className="provider-tree-models" aria-label={`${name} 的模型`}>
                {item.models.map((entry, index) => {
                  const nodeKey = `${item.id}:model:${index}`;
                  const selected = selectedKey === nodeKey;
                  return <li role="treeitem" key={index} className="provider-tree-model" data-provider-id={item.id} data-model-index={index}
                    aria-label={entry.id || "未命名模型"} aria-selected={selected} aria-level={2} tabIndex={selected ? 0 : -1}
                    onFocus={(event) => { if (!busy && event.target === event.currentTarget) edit(item.id, index); }}
                    onClick={(event) => { if (!busy) { event.stopPropagation(); focusNode(event.currentTarget); } }}>
                    <div className={`provider-tree-row ${selected ? "selected" : ""}`}><Box size={14} aria-hidden="true" />
                      <span className="provider-tree-name" title={entry.id || "未命名模型"}>{entry.id || "未命名模型"}</span>
                      {item.id === value.selectedProviderId && entry.id === item.selectedModelId && <Check size={12} className="provider-tree-model-current" aria-label="当前使用模型" />}
                    </div>
                  </li>;
                })}
              </ul>}
            </li>;
          })}
        </ul>
        <footer>选择节点，编辑右侧配置</footer>
      </aside>

      {provider && <fieldset className="provider-editor" disabled={busy} ref={editorRef} aria-label={model ? "模型配置" : "提供商配置"}>
        <div className="provider-editor-breadcrumb"><button type="button" onClick={() => edit(provider.id)}>{provider.name || "未命名提供商"}</button><ChevronRight size={13} aria-hidden="true" /><span>{model ? "模型配置" : "提供商配置"}</span></div>
        {model ? <section className="settings-panel provider-model-card">
          <header className="settings-panel-header-with-action"><div><strong>{model.id || "未命名模型"}</strong><small>模型 ID 与思考强度</small></div>
            <div className="provider-actions"><button className="secondary-button" type="button" disabled={isCurrentModel || !model.id.trim()}
              onClick={() => onChange(changeAiModelSettings(value, { providerId: provider.id, model: model.id }))}><Check size={14} aria-hidden="true" />{isCurrentModel ? "当前使用" : "设为当前模型"}</button>
              <button className="icon-button danger" type="button" aria-label={`删除模型 ${model.id || modelIndex! + 1}`} title="删除模型" disabled={provider.models.length <= 1}
                onClick={() => { update({ models: provider.models.filter((_, index) => index !== modelIndex) }); setModelIndex(Math.max(0, modelIndex! - 1)); }}><Trash2 size={15} /></button></div>
          </header>
          <label className="settings-config-row"><span className="settings-row-copy"><strong>模型 ID</strong><small>填写此提供商支持的模型名称</small></span>
            <input aria-label="模型 ID" className="settings-input settings-mono-input" value={model.id} placeholder="输入模型 ID" onChange={(event) => updateModel({ id: event.target.value })} /></label>
          <div className="provider-model-reasoning"><fieldset className="provider-efforts"><legend>可选思考强度</legend>
            {AI_REASONING_EFFORT_OPTIONS.map((option) => <label key={option.value}><input type="checkbox" checked={model.reasoningEfforts.includes(option.value)} disabled={model.reasoningEfforts.length === 1 && model.reasoningEfforts.includes(option.value)}
              onChange={(event) => updateModel({ reasoningEfforts: event.target.checked ? [...model.reasoningEfforts, option.value] : model.reasoningEfforts.filter((effort) => effort !== option.value) })} />{option.label}</label>)}
          </fieldset><p>仅勾选此模型支持的档位，助手面板将显示这些选项。</p></div>
          <label className="settings-config-row"><span className="settings-row-copy"><strong>默认思考强度</strong><small>首次使用此模型时的默认档位</small></span>
            <select aria-label="默认思考强度" className="settings-input" value={model.defaultReasoningEffort} onChange={(event) => updateModel({ defaultReasoningEffort: event.target.value as AiReasoningEffort, reasoningEffort: event.target.value as AiReasoningEffort })}>
              {AI_REASONING_EFFORT_OPTIONS.filter((option) => model.reasoningEfforts.includes(option.value)).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>
          <footer className="provider-model-footer"><button className="secondary-button" type="button" onClick={addModel}><Plus size={14} aria-hidden="true" />添加模型</button><span>模型配置独立保存于此提供商</span></footer>
        </section> : <>
          <section className="settings-panel">
            <header className="settings-panel-header-with-action"><div><strong>{provider.name || "未命名提供商"}</strong><small>OpenAI 兼容服务</small></div>
              <div className="provider-actions"><button className="secondary-button" type="button" disabled={provider.id === value.selectedProviderId}
                onClick={() => onChange(changeAiModelSettings(value, { providerId: provider.id }))}><Check size={14} aria-hidden="true" />{provider.id === value.selectedProviderId ? "当前使用" : "设为当前提供商"}</button>
                <button className="icon-button danger" type="button" aria-label="删除提供商" title="删除提供商" disabled={value.providers.length <= 1}
                  onClick={() => { onChange(normalizeAiConfig({ ...value, providers: value.providers.filter((item) => item.id !== provider.id) })); edit(value.providers.find((item) => item.id !== provider.id)!.id); }}><Trash2 size={15} /></button></div>
            </header>
            <label className="settings-config-row"><span className="settings-row-copy"><strong>提供商名称</strong><small>在助手面板中显示的名称</small></span>
              <input aria-label="提供商名称" className="settings-input" value={provider.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如 DeepSeek、OpenAI" /></label>
            <label className="settings-config-row"><span className="settings-row-copy"><strong>接口模式</strong><small>选择此提供商支持的接口</small></span>
              <select aria-label="接口模式" className="settings-input" value={provider.apiMode} onChange={(event) => update({ apiMode: event.target.value as AiProvider["apiMode"] })}>
                <option value="chat-completions">Chat Completions</option><option value="responses">Responses</option>
              </select></label>
            <label className="settings-config-row"><span className="settings-row-copy"><strong>Base URL</strong><small>API 基础地址或完整接口地址</small></span>
              <input aria-label="Base URL" className="settings-input settings-mono-input" value={provider.endpoint} onChange={(event) => update({ endpoint: event.target.value })} placeholder="https://api.example.com/v1" /></label>
            <div className="settings-config-row"><label className="settings-row-copy" htmlFor="provider-api-key"><strong>API Key</strong><small>按提供商独立保存到系统凭据库</small></label>
              <span className="settings-secret-control"><input id="provider-api-key" aria-label="API Key" className="settings-input settings-mono-input" type={keyVisible ? "text" : "password"} autoComplete="off" spellCheck={false}
                value={provider.apiKey} onChange={(event) => update({ apiKey: event.target.value })} placeholder="sk-..." />
                <button className="settings-secret-toggle" type="button" aria-label={keyVisible ? "隐藏 API Key" : "显示 API Key"} aria-pressed={keyVisible} onClick={() => setKeyVisible(!keyVisible)}>{keyVisible ? <EyeOff size={15} /> : <Eye size={15} />}</button></span></div>
            <div className="settings-config-row"><span className="settings-row-copy"><strong>移除已保存密钥</strong><small>立即移除此提供商的密钥</small></span>
              <button className="danger-button" type="button" disabled={removing} onClick={() => void removeKey()}><Trash2 size={14} aria-hidden="true" />{removing ? "移除中…" : "移除已保存密钥"}</button></div>
          </section>
          <section className="settings-panel provider-model-panel">
            <header className="settings-panel-header-with-action"><div><strong>模型管理</strong><small>在左侧选择模型，配置各自的思考强度</small></div>
              <div className="provider-actions"><button className="secondary-button" type="button" disabled={loading} onClick={() => void loadModels()}><RefreshCw size={14} aria-hidden="true" className={loading ? "spinning" : ""} />{loading ? "获取中…" : "获取模型"}</button>
                <button className="secondary-button" type="button" onClick={addModel}><Plus size={14} aria-hidden="true" />添加模型</button></div>
            </header>
            {models.length > 0 ? <div className="provider-discovered-models"><label><span>搜索提供商模型</span><input className="settings-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型 ID" /></label>
              <div>{models.filter((id) => id.toLowerCase().includes(query.trim().toLowerCase())).map((id) => {
                const added = provider.models.some((entry) => entry.id === id);
                return <button className="provider-discovered-model" type="button" key={id} disabled={added} onClick={() => { update({ models: [...provider.models.filter((entry) => entry.id.trim()), createAiProviderModel(id)] }); expand(provider.id); }}><span>{id}</span>{added ? <Check size={14} /> : <Plus size={14} />}</button>;
              })}</div>
              {!models.some((id) => id.toLowerCase().includes(query.trim().toLowerCase())) && <p className="provider-model-hint" role="status">没有匹配的模型</p>}
            </div> : <p className="provider-model-hint">已配置 {provider.models.length} 个模型，可手动添加或从接口获取。</p>}
            {error && <p className="provider-error" role="alert">{error}</p>}
          </section>
        </>}
      </fieldset>}
    </div>
  );
}
