import { useEffect, useMemo, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { diagnosticError } from "../diagnostics";
import { isTauri } from "../lib";

export function WindowControls() {
  const appWindow = useMemo(() => isTauri() ? getCurrentWindow() : undefined, []);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!appWindow) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    const refreshMaximized = async () => {
      try {
        const value = await appWindow.isMaximized();
        if (!disposed) setMaximized(value);
      } catch (error) {
        diagnosticError("window.state.error", error);
      }
    };

    void appWindow.onResized(() => { void refreshMaximized(); })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => diagnosticError("window.listener.error", error));
    void refreshMaximized();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [appWindow]);

  if (!appWindow) return null;

  const runAction = async (action: "minimize" | "toggleMaximize" | "close") => {
    try {
      await appWindow[action]();
    } catch (error) {
      diagnosticError("window.control.error", error, { action });
    }
  };
  const maximizeLabel = maximized ? "还原窗口" : "最大化窗口";

  return (
    <div className="window-controls" role="group" aria-label="窗口控制" data-tauri-drag-region="false">
      <button className="window-control" type="button" aria-label="最小化窗口" title="最小化窗口" onClick={() => { void runAction("minimize"); }}>
        <Minus size={14} aria-hidden="true" />
      </button>
      <button className="window-control" type="button" aria-label={maximizeLabel} title={maximizeLabel} onClick={() => { void runAction("toggleMaximize"); }}>
        {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
      </button>
      <button className="window-control close" type="button" aria-label="关闭窗口" title="关闭窗口" onClick={() => { void runAction("close"); }}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
