import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error" | "fatal";
export type DiagnosticFields = Record<string, unknown>;

const redactedKey = /password|passphrase|api.?key|token|secret|private.?key|authorization|credential/i;
const pendingEntries: string[] = [];
let flushing = false;
let retryTimer: number | undefined;
let installed = false;
let sequence = 0;

function sanitize(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && redactedKey.test(key)) return "[REDACTED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: sanitize((value as Error & { cause?: unknown }).cause, "cause", seen),
    };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, undefined, seen));
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    sanitize(entryValue, entryKey, seen),
  ]));
}

function browserContext() {
  const performanceWithMemory = performance as Performance & {
    memory?: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  };
  return {
    href: window.location.href,
    readyState: document.readyState,
    visibility: document.visibilityState,
    online: navigator.onLine,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    memory: performanceWithMemory.memory,
  };
}

async function flush() {
  if (flushing || !isTauri()) return;
  flushing = true;
  try {
    while (pendingEntries.length) {
      const entry = pendingEntries.shift();
      if (!entry) continue;
      try {
        await invoke("write_diagnostic_log", { entry });
      } catch {
        pendingEntries.unshift(entry);
        if (retryTimer === undefined) {
          retryTimer = window.setTimeout(() => {
            retryTimer = undefined;
            void flush();
          }, 1000);
        }
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

export function diagnosticLog(level: DiagnosticLevel, event: string, fields: DiagnosticFields = {}) {
  const entry = {
    sequence: ++sequence,
    timestampUnixMs: Date.now(),
    level,
    event,
    context: browserContext(),
    fields: sanitize(fields),
  };
  if (pendingEntries.length >= 512) pendingEntries.shift();
  pendingEntries.push(JSON.stringify(entry));
  void flush();
}

export function diagnosticError(event: string, error: unknown, fields: DiagnosticFields = {}) {
  diagnosticLog("error", event, { ...fields, error: sanitize(error) });
}

export function installDiagnostics() {
  if (installed) return;
  installed = true;

  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);
  console.error = (...args) => {
    originalConsoleError(...args);
    diagnosticLog("error", "console.error", { arguments: args });
  };
  console.warn = (...args) => {
    originalConsoleWarn(...args);
    diagnosticLog("warn", "console.warn", { arguments: args });
  };

  window.addEventListener("error", (event) => {
    diagnosticLog("error", "window.error", {
      message: event.message,
      filename: event.filename,
      lineNumber: event.lineno,
      columnNumber: event.colno,
      error: event.error,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    diagnosticLog("error", "window.unhandledrejection", { reason: event.reason });
  });
  document.addEventListener("visibilitychange", () => {
    diagnosticLog("debug", "document.visibility_changed", { visibility: document.visibilityState });
  });
  window.addEventListener("online", () => diagnosticLog("info", "browser.online"));
  window.addEventListener("offline", () => diagnosticLog("warn", "browser.offline"));
  window.addEventListener("pagehide", () => diagnosticLog("info", "window.pagehide"));

  diagnosticLog("info", "frontend.started");
  if (isTauri()) {
    void invoke<string>("get_diagnostic_log_path")
      .then((path) => diagnosticLog("info", "diagnostics.log_path", { path }))
      .catch((error) => diagnosticError("diagnostics.log_path_failed", error));
  }
}
