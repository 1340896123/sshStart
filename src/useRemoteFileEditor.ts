import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib";
import type { RemoteFileContent, RemoteFileRevision, ServerProfile } from "./types";

export function useRemoteFileEditor(server: ServerProfile, path: string, onDirtyChange: (dirty: boolean) => void, onSaved: () => void) {
  const [content, setContent] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ kind: "ok" | "error"; message: string }>();
  const state = useRef({ generation: 0, content: undefined as string | undefined, saved: undefined as string | undefined, revision: undefined as RemoteFileRevision | undefined, saving: false });
  const callbacks = useRef({ onDirtyChange, onSaved });
  callbacks.current = { onDirtyChange, onSaved };

  useEffect(() => {
    const current = { generation: state.current.generation + 1, content: undefined as string | undefined, saved: undefined as string | undefined, revision: undefined as RemoteFileRevision | undefined, saving: false };
    state.current = current;
    setContent(undefined);
    setLoading(true);
    setError("");
    setSaving(false);
    setDirty(false);
    setSaveStatus(undefined);
    callbacks.current.onDirtyChange(false);
    void (async () => {
      try {
        if (!isTauri()) throw new Error("文件编辑仅在桌面应用中可用");
        const data = await invoke<RemoteFileContent>("read_remote_file", { server, remotePath: path });
        if (state.current !== current) return;
        current.content = current.saved = data.content;
        current.revision = data.revision;
        setContent(data.content);
      } catch (reason) {
        if (state.current === current) setError(String(reason));
      } finally {
        if (state.current === current) setLoading(false);
      }
    })();
    return () => { state.current = { ...current, generation: current.generation + 1 }; };
  }, [path, server]);

  const handleChange = useCallback((value?: string) => {
    const current = state.current;
    current.content = value ?? "";
    const changed = current.content !== current.saved;
    setContent(current.content);
    setDirty(changed);
    setSaveStatus(undefined);
    callbacks.current.onDirtyChange(changed);
  }, []);

  const save = useCallback(async () => {
    const current = state.current;
    if (!isTauri() || current.content === undefined || !current.revision || current.saving) return;
    const submitted = current.content;
    current.saving = true;
    setSaving(true);
    setSaveStatus(undefined);
    try {
      const revision = await invoke<RemoteFileRevision>("write_remote_file", {
        server, remotePath: path, content: submitted, expectedRevision: current.revision,
      });
      if (state.current !== current) return;
      current.revision = revision;
      current.saved = submitted;
      const changed = current.content !== submitted;
      setDirty(changed);
      callbacks.current.onDirtyChange(changed);
      setSaveStatus({ kind: "ok", message: changed ? "已保存提交的版本，仍有未保存的修改" : "已保存" });
      callbacks.current.onSaved();
    } catch (reason) {
      if (state.current === current) setSaveStatus({ kind: "error", message: String(reason) });
    } finally {
      current.saving = false;
      if (state.current === current) setSaving(false);
    }
  }, [path, server]);
  return { content, loading, error, saving, dirty, saveStatus, save, handleChange };
}
