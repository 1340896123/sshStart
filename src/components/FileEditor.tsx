import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, CircleAlert, LoaderCircle, Save } from "lucide-react";
import { isTauri } from "../lib";
import { definePorticoEditorTheme } from "../monaco";
import type { RemoteFile, RemoteFileContent, RemoteFileRevision, ServerProfile } from "../types";

interface Props {
  server: ServerProfile;
  sessionId: string;
  file: RemoteFile;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}

type SaveStatus = { kind: "ok" | "error"; message: string };

export function FileEditor({ server, sessionId, file, active, onDirtyChange, onSaved }: Props) {
  const [content, setContent] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>();
  const dirtyRef = useRef(false);
  const contentRef = useRef<string>();
  const revisionRef = useRef<RemoteFileRevision>();
  const bomRef = useRef(false);
  const editVersionRef = useRef(0);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  // An open document belongs to the connection it was opened with. Metadata edits
  // must neither reload its buffer nor silently redirect its next save.
  const connectionRef = useRef(server);
  const callbacksRef = useRef({ onDirtyChange, onSaved });
  callbacksRef.current = { onDirtyChange, onSaved };
  const modelPath = `portico://remote/${encodeURIComponent(server.id)}/${encodeURIComponent(sessionId)}${file.path.split("/").map(encodeURIComponent).join("/")}`;
  // onMount 只触发一次，addCommand 的闭包会随之固化；用 ref 转发最新的 save，确保 Ctrl+S 永远保存当前内容。
  const saveRef = useRef<() => Promise<void>>(async () => undefined);

  const markDirty = useCallback(() => {
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    setDirty(true);
    callbacksRef.current.onDirtyChange(true);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        if (!isTauri()) throw new Error("文件编辑仅在桌面应用中可用");
        const data = await invoke<RemoteFileContent>("read_remote_file", { server: connectionRef.current, remotePath: file.path });
        if (disposed) return;
        contentRef.current = data.content;
        revisionRef.current = data.revision;
        bomRef.current = data.content.startsWith("\uFEFF");
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
  }, [file.path]);

  const save = useCallback(async () => {
    if (!isTauri() || contentRef.current === undefined || !revisionRef.current || savingRef.current || !dirtyRef.current) return;
    savingRef.current = true;
    const submittedVersion = editVersionRef.current;
    const submittedContent = contentRef.current;
    setSaving(true);
    setSaveStatus(undefined);
    try {
      const revision = await invoke<RemoteFileRevision>("write_remote_file", {
        server: connectionRef.current,
        remotePath: file.path,
        content: submittedContent,
        expectedRevision: revisionRef.current,
      });
      if (!mountedRef.current) return;
      revisionRef.current = revision;
      const unchanged = editVersionRef.current === submittedVersion;
      if (unchanged) {
        dirtyRef.current = false;
        setDirty(false);
        callbacksRef.current.onDirtyChange(false);
      }
      const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
      setSaveStatus({ kind: "ok", message: unchanged ? `已保存 ${time}` : `已保存提交版本 ${time}，后续修改未保存` });
      callbacksRef.current.onSaved();
    } catch (reason) {
      if (mountedRef.current) setSaveStatus({ kind: "error", message: String(reason) });
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [file.path]);
  saveRef.current = save;

  const handleChange = useCallback((value?: string) => {
    const next = value ?? "";
    contentRef.current = bomRef.current && !next.startsWith("\uFEFF") ? `\uFEFF${next}` : next;
    editVersionRef.current++;
    setContent(next);
    setSaveStatus(undefined);
    markDirty();
  }, [markDirty]);

  const handleMount: OnMount = useCallback((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
    editor.focus();
  }, []);

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
            path={modelPath}
            theme="portico"
            beforeMount={definePorticoEditorTheme}
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
