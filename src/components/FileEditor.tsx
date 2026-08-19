import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, CircleAlert, LoaderCircle, Save } from "lucide-react";
import { isTauri } from "../lib";
import type { RemoteFile, RemoteFileContent, ServerProfile } from "../types";

interface Props {
  server: ServerProfile;
  file: RemoteFile;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}

type SaveStatus = { kind: "ok" | "error"; message: string };

export function FileEditor({ server, file, active, onDirtyChange, onSaved }: Props) {
  const [content, setContent] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>();
  const dirtyRef = useRef(false);

  const markDirty = useCallback(() => {
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    setDirty(true);
    onDirtyChange(true);
  }, [onDirtyChange]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        if (!isTauri()) throw new Error("文件编辑仅在桌面应用中可用");
        const data = await invoke<RemoteFileContent>("read_remote_file", { server, remotePath: file.path });
        if (disposed) return;
        setContent(data.content);
      } catch (reason) {
        if (!disposed) setError(String(reason));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [file.path, server]);

  const save = useCallback(async () => {
    if (!isTauri() || content === undefined || saving) return;
    setSaving(true);
    setSaveStatus(undefined);
    try {
      await invoke("write_remote_file", {
        server,
        remotePath: file.path,
        content,
      });
      dirtyRef.current = false;
      setDirty(false);
      onDirtyChange(false);
      const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
      setSaveStatus({ kind: "ok", message: `已保存 ${time}` });
      onSaved();
    } catch (reason) {
      setSaveStatus({ kind: "error", message: String(reason) });
    } finally {
      setSaving(false);
    }
  }, [content, file.path, onDirtyChange, onSaved, saving, server]);

  const handleChange = useCallback((value?: string) => {
    setContent(value ?? "");
    markDirty();
  }, [markDirty]);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    editor.focus();
  }, [save]);

  return (
    <div className={`file-editor ${active ? "active" : ""}`} hidden={!active}>
      <div className="file-editor-toolbar">
        <span className="file-editor-path" title={file.path}>{file.path}</span>
        {dirty && <span className="file-editor-dirty">未保存</span>}
        <span className="header-spacer" />
        {saveStatus && (
          <span className={`file-editor-save-status ${saveStatus.kind}`} title={saveStatus.message}>
            {saveStatus.kind === "ok" ? <CheckCircle2 size={10} /> : <CircleAlert size={10} />}
            <span>{saveStatus.message}</span>
          </span>
        )}
        <button
          className="icon-button quiet"
          type="button"
          title="保存 (Ctrl+S)"
          disabled={saving || loading || !dirty}
          onClick={() => void save()}
        >
          {saving ? <LoaderCircle size={13} className="spinning" /> : <Save size={13} />}
        </button>
      </div>
      <div className="file-editor-host">
        {loading ? (
          <div className="file-editor-message"><LoaderCircle size={16} className="spinning" /><span>正在从远程服务器读取 {file.name}…</span></div>
        ) : error ? (
          <div className="file-editor-message file-editor-message-error">
            <CircleAlert size={16} />
            <span>{error}</span>
          </div>
        ) : (
          <Editor
            path={file.path}
            theme="portico"
            value={content}
            onChange={handleChange}
            onMount={handleMount}
            loading={<div className="file-editor-message"><LoaderCircle size={16} className="spinning" /><span>正在加载编辑器…</span></div>}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              lineNumbersMinChars: 3,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: "off",
              renderWhitespace: "selection",
              smoothScrolling: true,
              padding: { top: 8, bottom: 8 },
            }}
          />
        )}
      </div>
    </div>
  );
}
