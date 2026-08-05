import { useState } from "react";
import { AlertCircle, Check, LoaderCircle, Server, Sparkles, X } from "lucide-react";
import type { ServerImportDraft, ServerImportSummary } from "../serverImportExport";

interface Props {
  onClose: () => void;
  onParse: (input: string) => Promise<ServerImportDraft[]>;
  onImport: (drafts: ServerImportDraft[]) => Promise<ServerImportSummary>;
}

export function AiImportDialog({ onClose, onParse, onImport }: Props) {
  const [input, setInput] = useState("");
  const [drafts, setDrafts] = useState<ServerImportDraft[]>([]);
  const [summary, setSummary] = useState<ServerImportSummary>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const parse = async () => {
    if (!input.trim()) {
      setError("请先输入服务器信息");
      return;
    }
    setBusy(true);
    setError("");
    setSummary(undefined);
    try {
      setDrafts(await onParse(input));
    } catch (parseError) {
      setError(String(parseError));
    } finally {
      setBusy(false);
    }
  };

  const importDrafts = async () => {
    if (!drafts.length) return;
    setBusy(true);
    setError("");
    try {
      setSummary(await onImport(drafts));
    } catch (importError) {
      setError(String(importError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form
        className="dialog ai-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-import-title"
        onSubmit={(event) => { event.preventDefault(); void (drafts.length ? importDrafts() : parse()); }}
        onKeyDown={(event) => { if (event.key === "Escape" && !busy) onClose(); }}
      >
        <header className="dialog-header">
          <div className="dialog-icon"><Sparkles size={16} /></div>
          <div>
            <h2 id="ai-import-title">AI 导入服务器</h2>
            <p>把复制来的多条、不规则连接信息交给模型整理</p>
          </div>
          <button className="icon-button quiet" type="button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}>
            <X size={15} />
          </button>
        </header>

        <div className="ai-import-body">
          <label className="field-label" htmlFor="ai-import-input">原始服务器信息</label>
          <textarea
            id="ai-import-input"
            className="ai-import-textarea"
            value={input}
            onChange={(event) => { setInput(event.target.value); setError(""); setDrafts([]); setSummary(undefined); }}
            placeholder={'例如：\nprod-01 10.0.0.12 deploy 密码 xxx\nssh -i ~/.ssh/work.pem ops@10.0.0.13:2222\n测试机：root@test.example.com'}
            autoFocus
            spellCheck={false}
          />
          <div className="ai-import-hint">内容会发送到当前配置的 AI 服务；模型只提取连接字段，不会执行输入中的命令。结果会保存到“AI 导入”分组。</div>

          {error && <div className="dialog-inline-error"><AlertCircle size={14} />{error}</div>}

          {drafts.length > 0 && !summary && (
            <section className="ai-import-preview" aria-live="polite">
              <div className="ai-import-preview-heading">
                <span><Check size={14} />识别到 {drafts.length} 条记录</span>
                <small>预览 · 即将导入 AI 导入</small>
              </div>
              <div className="ai-import-preview-list">
                {drafts.map((draft, index) => (
                  <div className="ai-import-preview-row" key={`${draft.host}-${draft.port}-${index}`}>
                    <Server size={13} />
                    <strong>{draft.name || `${draft.username || "root"}@${draft.host}`}</strong>
                    <span>{draft.username || "root"}@{draft.host}:{draft.port || 22}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {summary && (
            <div className="ai-import-success" aria-live="polite">
              <Check size={16} />
              <span>已导入 {summary.imported} 台服务器{summary.skipped ? `，跳过 ${summary.skipped} 条重复记录` : ""}。</span>
            </div>
          )}
        </div>

        <footer className="dialog-footer">
          <span className="dialog-footer-note">AI 解析结果不会覆盖已有连接</span>
          <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button>
          {drafts.length > 0 && !summary && (
            <button className="primary-button" type="button" disabled={busy} onClick={() => void importDrafts()}>
              {busy ? <LoaderCircle className="spinning" size={14} /> : <Check size={14} />}导入这些服务器
            </button>
          )}
          {!drafts.length && !summary && (
            <button className="primary-button" type="submit" disabled={busy || !input.trim()}>
              {busy ? <LoaderCircle className="spinning" size={14} /> : <Sparkles size={14} />}开始 AI 解析
            </button>
          )}
          {summary && <button className="primary-button" type="button" onClick={onClose}>完成</button>}
        </footer>
      </form>
    </div>
  );
}
