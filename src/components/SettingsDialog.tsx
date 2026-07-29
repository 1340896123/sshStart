import { useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Check, ExternalLink, Image, RefreshCw, ShieldCheck, X } from "lucide-react";
import { isTauri } from "../lib";
import type { AiConfig } from "../types";

interface Props {
  config: AiConfig;
  onSave: (config: AiConfig) => void | Promise<void>;
  onClose: () => void;
}

export function SettingsDialog({ config, onSave, onClose }: Props) {
  const [value, setValue] = useState(config);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const modelListId = useId();

  const loadModels = async () => {
    setLoadingModels(true);
    setError("");
    try {
      if (!isTauri()) throw new Error("模型列表仅可在桌面应用中获取");
      const nextModels = await invoke<string[]>("list_ai_models", { config: value });
      setModels(nextModels);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoadingModels(false);
    }
  };

  const save = async () => {
    if (!value.endpoint.trim()) {
      setError("请填写接口地址");
      return;
    }
    if (!value.model.trim()) {
      setError("请填写或选择模型");
      return;
    }
    if (!Number.isInteger(value.contextWindow) || value.contextWindow < 1024 || value.contextWindow > 2000000) {
      setError("上下文大小需为 1,024–2,000,000 之间的整数");
      return;
    }
    if (!Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) {
      setError("温度需在 0–2 之间");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({
        ...value,
        endpoint: value.endpoint.trim(),
        apiKey: value.apiKey.trim(),
        model: value.model.trim(),
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog settings-dialog">
        <div className="dialog-header">
          <div className="dialog-icon"><Bot size={17} /></div>
          <div><h2>AI 助手设置</h2><p>配置 OpenAI 兼容接口和会话策略。</p></div>
          <button className="icon-button quiet" onClick={onClose} title="关闭"><X size={16} /></button>
        </div>
        <div className="settings-body">
          <label className="field"><span>接口地址</span><input value={value.endpoint} onChange={(e) => setValue({ ...value, endpoint: e.target.value })} /></label>
          <div className="form-grid">
            <label className="field"><span>API Key</span><input type="password" autoComplete="off" value={value.apiKey} onChange={(e) => setValue({ ...value, apiKey: e.target.value })} placeholder="sk-..." /></label>
            <label className="field model-field">
              <span>模型 <small>{models.length > 0 ? `已获取 ${models.length} 个` : "支持手动输入"}</small></span>
              <div className="input-with-action">
                <input list={modelListId} value={value.model} onChange={(e) => setValue({ ...value, model: e.target.value })} placeholder="输入或选择模型" />
                <button type="button" disabled={loadingModels} onClick={() => void loadModels()} title="从接口获取模型列表" aria-label="获取模型列表">
                  <RefreshCw className={loadingModels ? "spinning" : ""} size={14} />
                </button>
              </div>
              <datalist id={modelListId}>{models.map((model) => <option key={model} value={model} />)}</datalist>
            </label>
          </div>
          <div className="ai-parameter-grid">
            <label className="field">
              <span>上下文大小 <small>tokens</small></span>
              <input type="number" min={1024} max={2000000} step={1024} value={value.contextWindow} onChange={(e) => setValue({ ...value, contextWindow: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>温度 <small>{value.temperature.toFixed(1)}</small></span>
              <input type="range" min={0} max={2} step={0.1} value={value.temperature} onChange={(e) => setValue({ ...value, temperature: Number(e.target.value) })} />
            </label>
            <label className="image-support-toggle">
              <span className="toggle-icon"><Image size={14} /></span>
              <span><strong>支持图片</strong><small>标记当前模型的多模态能力</small></span>
              <input type="checkbox" checked={value.supportsImages} onChange={(e) => setValue({ ...value, supportsImages: e.target.checked })} />
              <span className="switch" aria-hidden="true" />
            </label>
          </div>
          <label className="field"><span>系统提示词</span><textarea rows={5} value={value.systemPrompt} onChange={(e) => setValue({ ...value, systemPrompt: e.target.value })} /></label>
          <div className="settings-note"><ShieldCheck size={15} /><span>API Key 保存在系统凭据库。AI 只能访问当前会话，高风险命令会由 Rust 核心直接拦截。</span></div>
          <a className="docs-link" href="https://platform.openai.com/docs" target="_blank" rel="noreferrer">接口格式说明 <ExternalLink size={12} /></a>
        </div>
        {error && <div className="dialog-inline-error" role="alert">{error}</div>}
        <div className="dialog-footer">
          <span className="footer-spacer" />
          <button className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={saving} onClick={() => void save()}><Check size={14} /> {saving ? "保存中…" : "保存设置"}</button>
        </div>
      </div>
    </div>
  );
}
