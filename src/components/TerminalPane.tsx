import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Copy, Maximize2, RotateCcw, SquareTerminal, Wifi, WifiOff } from "lucide-react";
import { diagnosticError, diagnosticLog } from "../diagnostics";
import { isTauri } from "../lib";
import type { ServerProfile, SessionState } from "../types";

interface Props {
  session: SessionState;
  server: ServerProfile;
  onUpdate: (patch: Partial<SessionState>) => void;
}

function cssVariable(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function TerminalPane({ session, server, onUpdate }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal>();
  const fitRef = useRef<FitAddon>();
  const inputBuffer = useRef("");
  const [status, setStatus] = useState<"connecting" | "connected" | "failed">("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.42,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: cssVariable("--terminal-bg", "rgb(248, 250, 249)"),
        foreground: cssVariable("--terminal-fg", "rgb(32, 38, 36)"),
        cursor: cssVariable("--accent", "rgb(28, 111, 96)"),
        selectionBackground: cssVariable("--accent-soft", "rgba(28, 111, 96, .16)"),
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;

    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    let inputCount = 0;
    let inputBytes = 0;
    let outputChunks = 0;
    let outputBytes = 0;
    let lastCols = 0;
    let lastRows = 0;
    diagnosticLog("info", "terminal.pane.mounted", {
      sessionId: session.id,
      serverId: server.id,
      host: server.host,
      username: server.username,
    });

    const start = async () => {
      diagnosticLog("info", "terminal.frontend.start.begin", { sessionId: session.id });
      try {
        fit.fit();
        lastCols = terminal.cols;
        lastRows = terminal.rows;
        diagnosticLog("debug", "terminal.frontend.fitted", { sessionId: session.id, cols: lastCols, rows: lastRows });
        terminal.writeln(`\x1b[38;2;96;108;104mPortico · ${server.username}@${server.host}\x1b[0m`);
      } catch (reason) {
        diagnosticError("terminal.frontend.setup_failed", reason, { sessionId: session.id });
        throw reason;
      }
      if (!isTauri()) {
        terminal.writeln("\x1b[38;2;28;111;96m✓ Browser preview connected\x1b[0m");
        terminal.writeln("Type a command to explore the terminal interaction.\r\n");
        terminal.write(`\x1b[1m${server.username}@${server.name.toLowerCase().replace(/\s+/g, "-")}\x1b[0m:\x1b[38;2;28;111;96m~\x1b[0m$ `);
        setStatus("connected");
        onUpdate({ connected: true, terminalStarted: true });
        return;
      }

      try {
        unlisten = await listen<string>(`terminal-output-${session.id}`, (event) => {
          outputChunks += 1;
          outputBytes += event.payload.length;
          if (outputChunks <= 3 || outputChunks % 100 === 0) {
            diagnosticLog("debug", "terminal.output.received", {
              sessionId: session.id,
              chunks: outputChunks,
              bytes: event.payload.length,
              totalBytes: outputBytes,
            });
          }
          try {
            terminal.write(event.payload);
          } catch (reason) {
            diagnosticError("terminal.output.render_failed", reason, {
              sessionId: session.id,
              chunks: outputChunks,
              totalBytes: outputBytes,
            });
          }
        });
        diagnosticLog("info", "terminal.output_listener.ready", { sessionId: session.id });
        await invoke("start_terminal", {
          sessionId: session.id,
          server,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        diagnosticLog("info", "terminal.frontend.start.completed", {
          sessionId: session.id,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        if (!disposed) {
          setStatus("connected");
          onUpdate({ connected: true, terminalStarted: true });
        }
      } catch (reason) {
        const message = String(reason);
        diagnosticError("terminal.frontend.start_failed", reason, { sessionId: session.id });
        terminal.writeln(`\r\n\x1b[31m连接失败: ${message}\x1b[0m`);
        setError(message);
        setStatus("failed");
        onUpdate({ connected: false });
      }
    };

    const dataDisposable = terminal.onData((data) => {
      if (isTauri()) {
        inputCount += 1;
        inputBytes += data.length;
        if (inputCount <= 5 || inputCount % 100 === 0) {
          diagnosticLog("debug", "terminal.input.sent", {
            sessionId: session.id,
            count: inputCount,
            bytes: data.length,
            totalBytes: inputBytes,
          });
        }
        void invoke("terminal_input", { sessionId: session.id, data }).catch((reason) => {
          diagnosticError("terminal.input.failed", reason, { sessionId: session.id, bytes: data.length });
        });
        return;
      }
      if (data === "\r") {
        const command = inputBuffer.current.trim();
        terminal.write("\r\n");
        if (command === "clear") terminal.clear();
        else if (command === "ls") terminal.writeln("apps   backups   logs   public   releases");
        else if (command === "pwd") terminal.writeln(`/home/${server.username}`);
        else if (command) terminal.writeln(`preview: ${command}`);
        inputBuffer.current = "";
        terminal.write(`\x1b[1m${server.username}@${server.name.toLowerCase().replace(/\s+/g, "-")}\x1b[0m:\x1b[38;2;28;111;96m~\x1b[0m$ `);
      } else if (data === "\u007f") {
        if (inputBuffer.current.length) {
          inputBuffer.current = inputBuffer.current.slice(0, -1);
          terminal.write("\b \b");
        }
      } else {
        inputBuffer.current += data;
        terminal.write(data);
      }
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch (reason) {
        diagnosticError("terminal.resize.fit_failed", reason, { sessionId: session.id });
        return;
      }
      if (isTauri()) {
        if (terminal.cols !== lastCols || terminal.rows !== lastRows) {
          lastCols = terminal.cols;
          lastRows = terminal.rows;
          diagnosticLog("debug", "terminal.resize.sent", {
            sessionId: session.id,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        }
        void invoke("terminal_resize", { sessionId: session.id, cols: terminal.cols, rows: terminal.rows }).catch((reason) => {
          diagnosticError("terminal.resize.failed", reason, {
            sessionId: session.id,
            cols: terminal.cols,
            rows: terminal.rows,
          });
        });
      }
    });
    observer.observe(hostRef.current);
    void start();

    return () => {
      disposed = true;
      diagnosticLog("info", "terminal.pane.unmounted", {
        sessionId: session.id,
        inputCount,
        inputBytes,
        outputChunks,
        outputBytes,
      });
      unlisten?.();
      observer.disconnect();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = undefined;
      if (isTauri()) {
        void invoke("stop_terminal", { sessionId: session.id }).catch((reason) => {
          diagnosticError("terminal.stop.cleanup_failed", reason, { sessionId: session.id });
        });
      }
    };
    // The terminal belongs to this session for its entire lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const reconnect = async () => {
    if (!isTauri()) return;
    diagnosticLog("info", "terminal.reconnect.begin", { sessionId: session.id });
    setStatus("connecting");
    setError("");
    try {
      await invoke("stop_terminal", { sessionId: session.id });
      await invoke("start_terminal", {
        sessionId: session.id,
        server,
        cols: terminalRef.current?.cols ?? 100,
        rows: terminalRef.current?.rows ?? 30,
      });
      setStatus("connected");
      onUpdate({ connected: true });
      diagnosticLog("info", "terminal.reconnect.completed", { sessionId: session.id });
    } catch (reason) {
      diagnosticError("terminal.reconnect.failed", reason, { sessionId: session.id });
      setError(String(reason));
      setStatus("failed");
    }
  };

  return (
    <div className="pane terminal-pane">
      <div className="pane-header">
        <div className="pane-title"><SquareTerminal size={14} /><span>终端</span><small>zsh</small></div>
        <div className={`terminal-status ${status}`}>
          {status === "connected" ? <Wifi size={12} /> : <WifiOff size={12} />}
          <span>{status === "connecting" ? "连接中" : status === "connected" ? "已连接" : "连接失败"}</span>
        </div>
        <span className="header-spacer" />
        <button className="icon-button quiet" title="复制选中内容" onClick={() => navigator.clipboard.writeText(terminalRef.current?.getSelection() ?? "")}><Copy size={13} /></button>
        <button className="icon-button quiet" title="重新连接" onClick={() => void reconnect()}><RotateCcw size={13} /></button>
        <button className="icon-button quiet" title="最大化终端"><Maximize2 size={13} /></button>
      </div>
      {error && <div className="inline-error"><span>{error}</span><button onClick={() => void reconnect()}>重试</button></div>}
      <div ref={hostRef} className="terminal-host" />
      <div className="terminal-footer"><span>UTF-8</span><span>{terminalRef.current?.cols ?? 0} × {terminalRef.current?.rows ?? 0}</span><span>会话 {session.id.slice(-5)}</span></div>
    </div>
  );
}
