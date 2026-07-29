import { useState } from "react";
import { Bot, Check, ExternalLink, ShieldCheck, X } from "lucide-react";
import type { AiConfig } from "../types";

interface Props {
  config: AiConfig;
  onSave: (config: AiConfig) => void | Promise<void>;
  onClose: () => void;
}

export function SettingsDialog({ config, onSave, onClose }: Props) {
  const [value, setValue] = useState(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave(value);
      onClose();
    } catch (reason) {
      setError(String(reason));
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
            <label className="field"><span>模型</span><input value={value.model} onChange={(e) => setValue({ ...value, model: e.target.value })} /></label>
            <label className="field"><span>API Key</span><input type="password" autoComplete="off" value={value.apiKey} onChange={(e) => setValue({ ...value, apiKey: e.target.value })} placeholder="sk-..." /></label>
          </div>
          <label className="field"><span>系统提示词</span><textarea rows={5} value={value.systemPrompt} onChange={(e) => setValue({ ...value, systemPrompt: e.target.value })} /></label>
          <div className="settings-note"><ShieldCheck size={15} /><span>API Key 保存在系统凭据库。AI 只能访问当前会话，高风险命令会由 Rust 核心直接拦截。</span></div>
          <a className="docs-link" href="https://platform.openai.com/docs" target="_blank" rel="noreferrer">接口格式说明 <ExternalLink size={12} /></a>
        </div>
        {error && <div className="dialog-inline-error">{error}</div>}
        <div className="dialog-footer">
          <span className="footer-spacer" />
          <button className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={saving} onClick={() => void save()}><Check size={14} /> {saving ? "保存中…" : "保存设置"}</button>
        </div>
      </div>
    </div>
  );
}
