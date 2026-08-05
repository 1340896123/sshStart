import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  Bell,
  Braces,
  CircleHelp,
  Command,
  FolderSync,
  PanelLeftClose,
  Plus,
  Server,
  Settings,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { AiPane } from "./components/AiPane";
import { AiImportDialog } from "./components/AiImportDialog";
import { ColumnSplitter } from "./components/ColumnSplitter";
import { FilePane } from "./components/FilePane";
import { ServerDialog } from "./components/ServerDialog";
import { ServerTree } from "./components/ServerTree";
import { SettingsDialog } from "./components/SettingsDialog";
import { TerminalPane } from "./components/TerminalPane";
import { TransferPanel } from "./components/TransferPanel";
import { SystemDock } from "./components/SystemDock";
import { DEV_BOOTSTRAP } from "./devBootstrap";
import { initializeAiConversations } from "./aiHistory";
import { DEMO_SERVER, isTauri, uid } from "./lib";
import { isGroupWithin, normalizeGroupPath, removeGroupLevel, replaceGroupPrefix } from "./serverGroups";
import {
  AI_IMPORT_GROUP,
  materializeServerDrafts,
  parseServerImportText,
  selectGroupsInGroup,
  selectServersInGroup,
  serializeServerExport,
} from "./serverImportExport";
import {
  loadAppStorage,
  saveAiConfig as saveAiConfigToStorage,
  saveCollapsedGroups,
  saveServerGroups,
  saveServers,
} from "./storage";
import { DEFAULT_AI_CONFIG, normalizeAiConfig } from "./types";
import type { AiConfig, ServerProfile, SessionState, TransferProgressEvent, TransferRequest, TransferTask } from "./types";
import type { ServerImportDraft, ServerImportSummary } from "./serverImportExport";

const serializeAiConfigForStorage = (config: AiConfig) => {
  if (!isTauri()) return config;
  const { apiKey: _apiKey, ...persistedConfig } = config;
  return persistedConfig;
};

const SIDEBAR_MIN_WIDTH = 210;
const SIDEBAR_MAX_WIDTH = 420;
const AI_PANE_MIN_WIDTH = 300;
const AI_PANE_MAX_WIDTH = 520;
const COLUMN_SPLITTER_WIDTH = 7;
const MAX_SERVER_IMPORT_BYTES = 10 * 1024 * 1024;
const SECRET_STORE_CONCURRENCY = 8;

interface ServerSecretBundle {
  password?: string;
  passphrase?: string;
  jumpPassword?: string;
  jumpPassphrase?: string;
}

const clampWidth = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const copyServerName = (servers: ServerProfile[], sourceName: string) => {
  const baseName = `${sourceName} 副本`;
  const existingNames = new Set(servers.map((server) => server.name.toLocaleLowerCase()));
  if (!existingNames.has(baseName.toLocaleLowerCase())) return baseName;

  let copyNumber = 2;
  while (existingNames.has(`${baseName} ${copyNumber}`.toLocaleLowerCase())) copyNumber += 1;
  return `${baseName} ${copyNumber}`;
};

const initialSidebarWidth = () => {
  if (window.innerWidth <= 1100) return SIDEBAR_MIN_WIDTH;
  if (window.innerWidth <= 1180) return 232;
  return 276;
};

const initialAiPaneWidth = () => {
  if (window.innerWidth <= 1100) return AI_PANE_MIN_WIDTH;
  if (window.innerWidth <= 1180) return 330;
  return clampWidth(window.innerWidth * 0.29, 330, 410);
};

export default function App() {
  const hadStoredAiConfig = useRef(false);
  const [storageReady, setStorageReady] = useState(!isTauri());
  const [servers, setServers] = useState<ServerProfile[]>([DEMO_SERVER]);
  const [savedGroups, setSavedGroups] = useState<string[]>([]);
  const [aiConfig, setAiConfig] = useState<AiConfig>(DEFAULT_AI_CONFIG);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<"servers" | "transfers">("servers");
  const [aiOpen, setAiOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [aiPaneWidth, setAiPaneWidth] = useState(initialAiPaneWidth);
  const [serverDialogOpen, setServerDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerProfile>();
  const [serverDialogGroup, setServerDialogGroup] = useState<string>();
  const [selectedServerId, setSelectedServerId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiImportOpen, setAiImportOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [transfers, setTransfers] = useState<TransferTask[]>([]);
  const cancelledTransfers = useRef(new Set<string>());
  const transferProgressSamples = useRef(new Map<string, {
    transferredBytes: number;
    sampledAt: number;
    speedBytesPerSecond: number;
  }>());
  const appBodyRef = useRef<HTMLDivElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeServer = servers.find((server) => server.id === activeSession?.serverId);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    void loadAppStorage()
      .then((state) => {
        if (disposed) return;
        setServers(state.servers.length ? state.servers : [DEMO_SERVER]);
        setSavedGroups(state.savedGroups);
        setAiConfig(state.aiConfig ? normalizeAiConfig(state.aiConfig) : DEFAULT_AI_CONFIG);
        setCollapsedGroups(state.collapsedGroups);
        hadStoredAiConfig.current = state.aiConfig !== null;
        initializeAiConversations(state.aiConversations);
        setStorageReady(true);
      })
      .catch((error) => {
        if (disposed) return;
        console.error("Failed to load SQLite application state", error);
        setStorageReady(true);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    void saveServers(servers).catch((error) => console.error("Failed to save servers", error));
  }, [servers, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    void saveServerGroups(savedGroups).catch((error) => console.error("Failed to save server groups", error));
  }, [savedGroups, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    void saveAiConfigToStorage(serializeAiConfigForStorage(aiConfig))
      .catch((error) => console.error("Failed to save AI configuration", error));
  }, [aiConfig, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    void saveCollapsedGroups(collapsedGroups)
      .catch((error) => console.error("Failed to save collapsed groups", error));
  }, [collapsedGroups, storageReady]);

  useEffect(() => {
    if (!isTauri() || !storageReady) return;
    let disposed = false;
    let dispose: () => void = () => undefined;
    void listen<TransferProgressEvent>("transfer-progress", ({ payload }) => {
      const sampledAt = Date.now();
      const previous = transferProgressSamples.current.get(payload.transferId);
      let speedBytesPerSecond = previous?.speedBytesPerSecond ?? 0;
      if (previous && payload.transferredBytes > previous.transferredBytes) {
        const elapsedSeconds = (sampledAt - previous.sampledAt) / 1000;
        if (elapsedSeconds > 0) {
          const currentSpeed = (payload.transferredBytes - previous.transferredBytes) / elapsedSeconds;
          speedBytesPerSecond = previous.speedBytesPerSecond > 0
            ? previous.speedBytesPerSecond * 0.65 + currentSpeed * 0.35
            : currentSpeed;
        }
      }
      transferProgressSamples.current.set(payload.transferId, {
        transferredBytes: payload.transferredBytes,
        sampledAt,
        speedBytesPerSecond,
      });
      const remainingSeconds = payload.totalBytes !== undefined && speedBytesPerSecond > 0 && payload.totalBytes > payload.transferredBytes
        ? (payload.totalBytes - payload.transferredBytes) / speedBytesPerSecond
        : payload.totalBytes !== undefined && payload.transferredBytes >= payload.totalBytes ? 0 : undefined;
      setTransfers((current) => current.map((item) => {
        if (item.transferId !== payload.transferId || (item.status !== "queued" && item.status !== "running" && item.status !== "paused")) return item;
        return {
          ...item,
          transferredBytes: payload.transferredBytes,
          totalBytes: payload.totalBytes,
          speedBytesPerSecond,
          remainingSeconds,
        };
      }));
    }).then((unlisten) => {
      if (disposed) unlisten();
      else dispose = unlisten;
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    void invoke<string | null>("load_ai_key")
      .then((apiKey) => {
        if (disposed || !apiKey) return;
        setAiConfig((current) => current.apiKey.trim() ? current : { ...current, apiKey });
      })
      .catch((error) => console.error("Failed to load saved AI API key", error));
    return () => {
      disposed = true;
    };
  }, [storageReady]);

  useEffect(() => {
    if (!DEV_BOOTSTRAP || !storageReady) return;

    const { servers: bootstrapServers = [], ai } = DEV_BOOTSTRAP;
    if (bootstrapServers.length) {
      setServers((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        bootstrapServers.forEach((server) => byId.set(server.id, { ...byId.get(server.id), ...server }));
        return [...byId.values()];
      });
      setSavedGroups((current) => bootstrapServers.reduce((groups, server) =>
        server.group && !groups.includes(server.group) ? [...groups, server.group] : groups, current));
    }
    if (ai && !hadStoredAiConfig.current) {
      setAiConfig((current) => normalizeAiConfig(ai, current));
    }

    if (!isTauri()) return;
    const writes: Promise<unknown>[] = [];
    bootstrapServers.forEach((server) => {
      if (server.password || server.passphrase || server.jumpHost?.password || server.jumpHost?.passphrase) {
        writes.push(invoke("store_server_secret", {
          serverId: server.id,
          password: server.password ?? null,
          passphrase: server.passphrase ?? null,
          jumpPassword: server.jumpHost?.password ?? null,
          jumpPassphrase: server.jumpHost?.passphrase ?? null,
        }));
      }
    });
    if (ai?.apiKey && !hadStoredAiConfig.current) {
      writes.push(invoke("store_ai_key", { apiKey: ai.apiKey }));
    }
    void Promise.all(writes).catch((error) => console.error("Failed to initialize development credentials", error));
  }, [setAiConfig, setSavedGroups, setServers, storageReady]);

  const updateSession = (id: string, patch: Partial<SessionState>) => {
    setSessions((current) =>
      current.map((session) => (session.id === id ? { ...session, ...patch } : session)),
    );
  };

  const openSession = (server: ServerProfile, forceNew = false) => {
    if (!forceNew) {
      const existing = sessions.find((session) => session.serverId === server.id);
      if (existing) {
        setActiveSessionId(existing.id);
        return;
      }
    }

    const count = sessions.filter((session) => session.serverId === server.id).length + 1;
    const session: SessionState = {
      id: uid("session"),
      serverId: server.id,
      title: count > 1 ? `${server.name} ${count}` : server.name,
      connected: false,
      terminalStarted: false,
      cwd: "/",
      aiMessages: [],
    };
    setSessions((current) => [...current, session]);
    setActiveSessionId(session.id);
  };

  const closeSession = async (id: string) => {
    if (isTauri()) {
      await invoke("stop_terminal", { sessionId: id }).catch(() => undefined);
    }
    setSessions((current) => {
      const index = current.findIndex((session) => session.id === id);
      const remaining = current.filter((session) => session.id !== id);
      if (id === activeSessionId) {
        setActiveSessionId(remaining[Math.max(0, index - 1)]?.id);
      }
      return remaining;
    });
  };

  const saveServer = async (server: ServerProfile) => {
    const nextServer = { ...server, group: normalizeGroupPath(server.group) };
    if (isTauri()) {
      await invoke("store_server_secret", {
        serverId: nextServer.id,
        password: nextServer.password?.trim() || null,
        passphrase: nextServer.passphrase?.trim() || null,
        jumpPassword: nextServer.jumpHost?.password?.trim() || null,
        jumpPassphrase: nextServer.jumpHost?.passphrase?.trim() || null,
      });
    }
    setServers((current) => {
      const exists = current.some((item) => item.id === nextServer.id);
      return exists
        ? current.map((item) => (item.id === nextServer.id ? nextServer : item))
        : [...current, nextServer];
    });
    if (nextServer.group) {
      setSavedGroups((current) => current.includes(nextServer.group) ? current : [...current, nextServer.group]);
    }
    setServerDialogOpen(false);
    setEditingServer(undefined);
    setSelectedServerId(nextServer.id);
    openSession(nextServer, true);
  };

  const copyServer = async (server: ServerProfile) => {
    const copy = {
      ...server,
      id: uid("server"),
      name: copyServerName(servers, server.name),
      jumpHost: server.jumpHost ? { ...server.jumpHost } : undefined,
    };
    try {
      if (isTauri()) {
        await invoke("copy_server_secret", {
          sourceServerId: server.id,
          targetServerId: copy.id,
        });
      }
      setServers((current) => [...current, copy]);
      setSelectedServerId(copy.id);
    } catch (error) {
      console.error("Failed to copy server", error);
      alert(`复制服务器失败：${String(error)}`);
    }
  };

  const deleteServers = (serverIds: string[]) => {
    const deletedIds = new Set(serverIds);
    if (deletedIds.size === 0) return;
    if (isTauri()) {
      deletedIds.forEach((serverId) => {
        void invoke("delete_server_secret", { serverId }).catch(() => undefined);
      });
    }
    setServers((current) => current.filter((server) => !deletedIds.has(server.id)));
    setSelectedServerId((current) => current && deletedIds.has(current) ? undefined : current);
    sessions
      .filter((session) => deletedIds.has(session.serverId))
      .forEach((session) => void closeSession(session.id));
  };

  const deleteServer = (serverId: string) => deleteServers([serverId]);

  const saveAiConfig = async (next: AiConfig) => {
    const nextConfig = normalizeAiConfig(next);
    if (isTauri() && nextConfig.apiKey.trim()) {
      await invoke("store_ai_key", { apiKey: nextConfig.apiKey.trim() });
    }
    setAiConfig(nextConfig);
  };

  const removeSavedAiKey = async () => {
    if (isTauri()) {
      await invoke("delete_ai_key");
    }
    setAiConfig((current) => ({ ...current, apiKey: "" }));
  };

  const startTransfer = async (
    session: SessionState,
    server: ServerProfile,
    request: TransferRequest,
    operation: (transferId: string) => Promise<void>,
  ) => {
    const id = uid("transfer");
    const transferId = uid("transfer-run");
    const task: TransferTask = {
      ...request,
      id,
      transferId,
      sessionId: session.id,
      sessionTitle: session.title,
      serverName: server.name,
      serverHost: server.host,
      status: "queued",
      createdAt: Date.now(),
      transferredBytes: 0,
      speedBytesPerSecond: 0,
    };
    setTransfers((current) => [task, ...current]);
    const operationPromise = operation(transferId);
    setTransfers((current) => current.map((item) => item.id === id ? { ...item, status: "running" } : item));
    try {
      await operationPromise;
      if (cancelledTransfers.current.has(id)) {
        cancelledTransfers.current.delete(id);
        setTransfers((current) => current.map((item) => item.id === id ? { ...item, status: "cancelled", finishedAt: item.finishedAt ?? Date.now() } : item));
      } else {
        setTransfers((current) => current.map((item) => item.id === id ? {
          ...item,
          status: "completed",
          transferredBytes: item.totalBytes ?? item.transferredBytes,
          speedBytesPerSecond: 0,
          remainingSeconds: 0,
          finishedAt: Date.now(),
        } : item));
      }
    } catch (reason) {
      if (cancelledTransfers.current.has(id)) {
        cancelledTransfers.current.delete(id);
        setTransfers((current) => current.map((item) => item.id === id ? { ...item, status: "cancelled", error: undefined, finishedAt: item.finishedAt ?? Date.now() } : item));
        return;
      }
      const error = String(reason);
      setTransfers((current) => current.map((item) => item.id === id ? {
        ...item,
        status: "failed",
        speedBytesPerSecond: 0,
        remainingSeconds: undefined,
        error,
        finishedAt: Date.now(),
      } : item));
      throw reason;
    } finally {
      transferProgressSamples.current.delete(transferId);
    }
  };

  const retryTransfer = async (task: TransferTask) => {
    const session = sessions.find((item) => item.id === task.sessionId);
    const server = session
      ? servers.find((item) => item.id === session.serverId)
      : servers.find((item) => item.name === task.serverName && item.host === task.serverHost);
    if (!server) {
      setTransfers((current) => current.map((item) => item.id === task.id
        ? { ...item, status: "failed", error: "找不到对应的服务器配置，请重新连接后再试。", finishedAt: Date.now() }
        : item));
      return;
    }

    const transferId = uid("transfer-run");
    cancelledTransfers.current.delete(task.id);
    setTransfers((current) => current.map((item) => item.id === task.id
      ? {
        ...item,
        transferId,
        status: "queued",
        transferredBytes: 0,
        totalBytes: undefined,
        speedBytesPerSecond: 0,
        remainingSeconds: undefined,
        error: undefined,
        finishedAt: undefined,
      }
      : item));
    setTransfers((current) => current.map((item) => item.id === task.id ? { ...item, status: "running" } : item));

    try {
      if (task.direction === "upload") {
        await invoke("start_upload_file", { server, localPath: task.sourcePath, remotePath: task.destinationPath, transferId });
      } else {
        await invoke("start_download_file", { server, remotePath: task.sourcePath, localPath: task.destinationPath, transferId });
      }
      if (cancelledTransfers.current.has(task.id)) {
        cancelledTransfers.current.delete(task.id);
        setTransfers((current) => current.map((item) => item.id === task.id ? { ...item, status: "cancelled", finishedAt: item.finishedAt ?? Date.now() } : item));
      } else {
        setTransfers((current) => current.map((item) => item.id === task.id
          ? {
            ...item,
            status: "completed",
            transferredBytes: item.totalBytes ?? item.transferredBytes,
            speedBytesPerSecond: 0,
            remainingSeconds: 0,
            error: undefined,
            finishedAt: Date.now(),
          }
          : item));
      }
    } catch (reason) {
      if (cancelledTransfers.current.has(task.id)) {
        cancelledTransfers.current.delete(task.id);
        setTransfers((current) => current.map((item) => item.id === task.id ? { ...item, status: "cancelled", error: undefined, finishedAt: item.finishedAt ?? Date.now() } : item));
      } else {
        setTransfers((current) => current.map((item) => item.id === task.id
          ? {
            ...item,
            status: "failed",
            speedBytesPerSecond: 0,
            remainingSeconds: undefined,
            error: String(reason),
            finishedAt: Date.now(),
          }
          : item));
      }
    } finally {
      transferProgressSamples.current.delete(transferId);
    }
  };

  const pauseTransfer = async (task: TransferTask) => {
    try {
      await invoke("pause_transfer", { transferId: task.transferId });
      transferProgressSamples.current.delete(task.transferId);
      setTransfers((current) => current.map((item) => item.id === task.id && (item.status === "queued" || item.status === "running")
        ? { ...item, status: "paused", speedBytesPerSecond: 0, remainingSeconds: undefined, error: undefined }
        : item));
    } catch (reason) {
      setTransfers((current) => current.map((item) => item.id === task.id ? { ...item, error: `暂停失败：${String(reason)}` } : item));
    }
  };

  const resumeTransfer = async (task: TransferTask) => {
    try {
      await invoke("resume_transfer", { transferId: task.transferId });
      transferProgressSamples.current.delete(task.transferId);
      setTransfers((current) => current.map((item) => item.id === task.id && item.status === "paused"
        ? { ...item, status: "running", speedBytesPerSecond: 0, remainingSeconds: undefined, error: undefined }
        : item));
    } catch (reason) {
      setTransfers((current) => current.map((item) => item.id === task.id ? { ...item, error: `继续失败：${String(reason)}` } : item));
    }
  };

  const cancelTransfer = async (task: TransferTask) => {
    const currentTask = transfers.find((item) => item.id === task.id);
    if (!currentTask || (currentTask.status !== "queued" && currentTask.status !== "running" && currentTask.status !== "paused")) return;
    cancelledTransfers.current.add(task.id);
    transferProgressSamples.current.delete(task.transferId);
    setTransfers((current) => current.map((item) => item.id === task.id
      ? {
        ...item,
        status: "cancelled",
        speedBytesPerSecond: 0,
        remainingSeconds: undefined,
        error: undefined,
        finishedAt: item.finishedAt ?? Date.now(),
      }
      : item));
    try {
      await invoke("cancel_transfer", { transferId: task.transferId });
    } catch (reason) {
      cancelledTransfers.current.delete(task.id);
      setTransfers((current) => current.map((item) => item.id === task.id && item.status === "cancelled"
        ? { ...item, status: "running", error: `取消失败：${String(reason)}`, finishedAt: undefined }
        : item));
    }
  };

  const copyTransferPath = async (task: TransferTask) => {
    if (!navigator.clipboard) throw new Error("当前环境不支持复制到剪贴板");
    await navigator.clipboard.writeText(task.destinationPath);
  };

  const selectSidebar = (view: "servers" | "transfers") => {
    if (view === "servers" && sidebarOpen && sidebarView === view) {
      setSidebarOpen(false);
      return;
    }
    setSidebarView(view);
    setSidebarOpen(true);
  };

  const openServerDialog = (server?: ServerProfile, group?: string) => {
    setEditingServer(server);
    setServerDialogGroup(group);
    setServerDialogOpen(true);
  };

  const createGroup = (group: string) => {
    const normalized = normalizeGroupPath(group);
    setSavedGroups((current) => current.includes(normalized) ? current : [...current, normalized]);
  };

  const renameGroup = (currentGroup: string, nextGroup: string) => {
    setServers((current) => current.map((server) =>
      ({ ...server, group: replaceGroupPrefix(server.group, currentGroup, nextGroup) }),
    ));
    setSavedGroups((current) => {
      const next = current.map((group) => replaceGroupPrefix(group, currentGroup, nextGroup));
      if (!next.includes(nextGroup)) next.push(nextGroup);
      return next.filter((group, index) => group && next.indexOf(group) === index);
    });
  };

  const deleteGroup = (group: string, deleteContainedServers: boolean) => {
    if (deleteContainedServers) {
      deleteServers(servers
        .filter((server) => isGroupWithin(server.group, group))
        .map((server) => server.id));
      setSavedGroups((current) => current.filter((item) => !isGroupWithin(item, group)));
      return;
    }
    setServers((current) => current.map((server) =>
      ({ ...server, group: removeGroupLevel(server.group, group) }),
    ));
    setSavedGroups((current) => {
      const next = current.map((item) => removeGroupLevel(item, group));
      return next.filter((item, index) => item && next.indexOf(item) === index);
    });
  };

  const moveServer = (server: ServerProfile, group: string) => {
    const normalized = normalizeGroupPath(group);
    setServers((current) => current.map((item) => item.id === server.id ? { ...item, group: normalized } : item));
    if (normalized) setSavedGroups((current) => current.includes(normalized) ? current : [...current, normalized]);
  };

  const downloadInBrowser = (content: string, fileName: string) => {
    const blob = new Blob([content], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const exportServerList = async (scope?: string) => {
    const selected = scope === undefined ? servers : selectServersInGroup(servers, scope);
    if (!selected.length) {
      alert(scope !== undefined ? "这个分组没有可导出的服务器" : "当前没有可导出的服务器");
      return;
    }
    const exportGroups = scope === undefined ? savedGroups : selectGroupsInGroup(savedGroups, scope);
    const safeName = scope !== undefined
      ? (normalizeGroupPath(scope).replace(/[\\/:*?"<>|]+/g, "-") || "ungrouped")
      : "portico-servers";
    try {
      const includeSecrets = aiConfig.serverImportExport.includeSecretsInExport;
      const exportServers = includeSecrets && isTauri()
        ? await Promise.all(selected.map(async (server) => {
            const secrets = await invoke<ServerSecretBundle>("load_server_secrets", { serverId: server.id });
            return {
              ...server,
              password: secrets.password ?? server.password,
              passphrase: secrets.passphrase ?? server.passphrase,
              jumpHost: server.jumpHost
                ? {
                    ...server.jumpHost,
                    password: secrets.jumpPassword ?? server.jumpHost.password,
                    passphrase: secrets.jumpPassphrase ?? server.jumpHost.passphrase,
                  }
                : server.jumpHost,
            };
          }))
        : selected;
      const content = serializeServerExport(exportServers, exportGroups, scope, { includeSecrets });
      if (!isTauri()) {
        downloadInBrowser(content, `${safeName}.json`);
        return;
      }
      const path = await saveFileDialog({
        defaultPath: `${safeName}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) await invoke("write_server_export_file", { path, content });
    } catch (error) {
      alert(`导出服务器失败：${String(error)}`);
    }
  };

  const storeImportedSecrets = async (importedServers: ServerProfile[]) => {
    if (!isTauri()) return;
    const serversWithSecrets = importedServers
      .filter((server) => server.password || server.passphrase || server.jumpHost?.password || server.jumpHost?.passphrase);
    for (let offset = 0; offset < serversWithSecrets.length; offset += SECRET_STORE_CONCURRENCY) {
      await Promise.all(serversWithSecrets.slice(offset, offset + SECRET_STORE_CONCURRENCY).map((server) => invoke("store_server_secret", {
        serverId: server.id,
        password: server.password ?? null,
        passphrase: server.passphrase ?? null,
        jumpPassword: server.jumpHost?.password ?? null,
        jumpPassphrase: server.jumpHost?.passphrase ?? null,
      })));
    }
  };

  const commitImportedServers = async (
    drafts: ServerImportDraft[],
    groups: string[] = [],
    forcedGroup?: string,
  ): Promise<ServerImportSummary> => {
    const materialized = materializeServerDrafts(drafts, servers, forcedGroup);
    if (!materialized.servers.length) {
      return { imported: 0, skipped: materialized.skipped, groups: 0 };
    }
    await storeImportedSecrets(materialized.servers);
    setServers((current) => [...current, ...materialized.servers]);
    const nextGroups = [...new Set([...groups, ...materialized.groups].map(normalizeGroupPath).filter(Boolean))];
    if (nextGroups.length) setSavedGroups((current) => [...new Set([...current, ...nextGroups])]);
    setSelectedServerId(materialized.servers[materialized.servers.length - 1]?.id);
    return {
      imported: materialized.servers.length,
      skipped: materialized.skipped,
      groups: nextGroups.length,
    };
  };

  const importServerText = async (rawText: string) => {
    try {
      const parsed = parseServerImportText(rawText);
      const defaultGroup = normalizeGroupPath(aiConfig.serverImportExport.defaultImportGroup);
      const drafts = defaultGroup
        ? parsed.drafts.map((draft) => draft.group ? draft : { ...draft, group: defaultGroup })
        : parsed.drafts;
      const summary = await commitImportedServers(drafts, parsed.groups);
      const skipped = summary.skipped + parsed.skipped;
      alert(`已导入 ${summary.imported} 台服务器${skipped ? `，跳过 ${skipped} 条重复或无效记录` : ""}。`);
    } catch (error) {
      alert(`导入服务器失败：${String(error)}`);
    }
  };

  const importServerList = async () => {
    if (!isTauri()) {
      importFileRef.current?.click();
      return;
    }
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const rawText = await invoke<string>("read_server_import_file", { path });
      await importServerText(rawText);
    } catch (error) {
      alert(`导入服务器失败：${String(error)}`);
    }
  };

  const parseAiServerList = async (input: string) => {
    if (!isTauri()) throw new Error("AI 导入仅在桌面应用中可用");
    return invoke<ServerImportDraft[]>("parse_ai_server_import", {
      config: aiConfig,
      input,
    });
  };

  const importAiServerList = (drafts: ServerImportDraft[]) =>
    commitImportedServers(drafts, [AI_IMPORT_GROUP], AI_IMPORT_GROUP);

  const activeTransferCount = transfers.filter((task) => task.status === "queued" || task.status === "running" || task.status === "paused").length;

  const resizeSidebar = (nextWidth: number) => {
    const body = appBodyRef.current;
    const rail = body?.querySelector<HTMLElement>(".activity-rail");
    const operations = body?.querySelector<HTMLElement>(".workspace-session.active .operations-column");
    const aiPane = body?.querySelector<HTMLElement>(".workspace-session.active .ai-pane");
    const operationsMinWidth = operations ? Number.parseFloat(getComputedStyle(operations).minWidth) : 380;
    const aiWidth = aiOpen ? aiPane?.getBoundingClientRect().width ?? aiPaneWidth : 34;
    const availableWidth = body
      ? body.getBoundingClientRect().width - (rail?.getBoundingClientRect().width ?? 48) - COLUMN_SPLITTER_WIDTH
      : window.innerWidth - 48 - COLUMN_SPLITTER_WIDTH;
    const maxWidth = Math.min(SIDEBAR_MAX_WIDTH, availableWidth - operationsMinWidth - aiWidth - (aiOpen ? COLUMN_SPLITTER_WIDTH : 0));
    setSidebarWidth(clampWidth(nextWidth, SIDEBAR_MIN_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, maxWidth)));
  };

  const resizeAiPane = (nextWidth: number) => {
    const session = appBodyRef.current?.querySelector<HTMLElement>(".workspace-session.active");
    const operations = session?.querySelector<HTMLElement>(".operations-column");
    const operationsMinWidth = operations ? Number.parseFloat(getComputedStyle(operations).minWidth) : 380;
    const availableWidth = session?.getBoundingClientRect().width ?? window.innerWidth - 48 - sidebarWidth - COLUMN_SPLITTER_WIDTH;
    const maxWidth = Math.min(AI_PANE_MAX_WIDTH, availableWidth - operationsMinWidth - COLUMN_SPLITTER_WIDTH);
    setAiPaneWidth(clampWidth(nextWidth, AI_PANE_MIN_WIDTH, Math.max(AI_PANE_MIN_WIDTH, maxWidth)));
  };

  return (
    <div className="app-shell">
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand-lockup">
          <div className="brand-mark"><Command size={14} /></div>
          <span>Portico</span>
        </div>
        <div className="titlebar-status">
          <span className="environment-dot" />
          <span>{isTauri() ? "Native core ready" : "Browser preview"}</span>
        </div>
        <div className="titlebar-actions">
          <button className="icon-button quiet" aria-label="通知" title="通知"><Bell size={14} /></button>
        </div>
      </header>

      <div
        ref={appBodyRef}
        className="app-body"
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <nav className="activity-rail" aria-label="主导航">
          <div className="activity-main">
            <button
              className={`activity-button ${sidebarOpen && sidebarView === "servers" ? "active" : ""}`}
              type="button"
              title={sidebarOpen && sidebarView === "servers" ? "隐藏服务器列表" : "显示服务器列表"}
              aria-label={sidebarOpen && sidebarView === "servers" ? "隐藏服务器列表" : "显示服务器列表"}
              aria-expanded={sidebarOpen && sidebarView === "servers"}
              aria-controls="server-sidebar"
              onClick={() => selectSidebar("servers")}
            >
              <SquareTerminal size={18} />
            </button>
            <button className="activity-button" title="命令片段"><Braces size={18} /></button>
            <button className="activity-button" title="AI 助手" onClick={() => setAiOpen((open) => !open)}><Sparkles size={18} /></button>
          </div>
          <div className="activity-footer">
            <button className={`activity-button transfer-activity ${sidebarView === "transfers" ? "active" : ""}`} title="文件传输" onClick={() => selectSidebar("transfers")}>
              <FolderSync size={18} />
              {activeTransferCount > 0 && <span className="activity-badge">{activeTransferCount > 9 ? "9+" : activeTransferCount}</span>}
            </button>
            <button className="activity-button" title="帮助"><CircleHelp size={18} /></button>
            <button className="activity-button" title="设置" onClick={() => setSettingsOpen(true)}><Settings size={18} /></button>
          </div>
        </nav>

        {sidebarOpen && sidebarView === "servers" && (
          <aside id="server-sidebar" className="server-sidebar">
            <ServerTree
              servers={servers}
              savedGroups={savedGroups}
              initialCollapsedGroups={collapsedGroups}
              sessions={sessions}
              search={search}
              selectedServerId={selectedServerId ?? activeServer?.id}
              activeServerId={activeServer?.id}
              onSearchChange={setSearch}
              onSelect={(server) => setSelectedServerId(server.id)}
              onOpen={(server) => { setSelectedServerId(server.id); openSession(server); }}
              onNewSession={(server) => { setSelectedServerId(server.id); openSession(server, true); }}
              onAddServer={(group) => openServerDialog(undefined, group)}
              onCopyServer={(server) => { void copyServer(server); }}
              onEditServer={(server) => openServerDialog(server)}
              onDeleteServer={(server) => deleteServer(server.id)}
              onMoveServer={moveServer}
              onCreateGroup={createGroup}
              onRenameGroup={renameGroup}
              onDeleteGroup={deleteGroup}
              onCollapsedGroupsChange={setCollapsedGroups}
              onExportAll={() => { void exportServerList(); }}
              onImport={() => { void importServerList(); }}
              onAiImport={() => setAiImportOpen(true)}
              onExportGroup={(group) => { void exportServerList(group); }}
            />
          </aside>
        )}
        {sidebarOpen && sidebarView === "transfers" && (
          <TransferPanel
            transfers={transfers}
            onActivateSession={setActiveSessionId}
            onClearFinished={() => setTransfers((current) => current.filter((task) => task.status === "queued" || task.status === "running" || task.status === "paused"))}
            onDismiss={(id) => setTransfers((current) => current.filter((task) => task.id !== id))}
            onRetry={(task) => { void retryTransfer(task); }}
            onCopyPath={copyTransferPath}
            onPause={(task) => { void pauseTransfer(task); }}
            onResume={(task) => { void resumeTransfer(task); }}
            onCancel={(task) => { void cancelTransfer(task); }}
          />
        )}
        {sidebarOpen && (
          <ColumnSplitter
            label="调整服务器栏宽度"
            value={sidebarWidth}
            min={SIDEBAR_MIN_WIDTH}
            max={SIDEBAR_MAX_WIDTH}
            pane="previous"
            onChange={resizeSidebar}
          />
        )}

        <main className="workspace">
          <div className="session-strip">
            <button className="icon-button quiet" title={sidebarOpen ? "收起侧边栏" : "展开侧边栏"} onClick={() => setSidebarOpen((open) => !open)}>
              <PanelLeftClose className={sidebarOpen ? "" : "flipped"} size={15} />
            </button>
            <div className="session-tabs">
              {sessions.map((session) => {
                const server = servers.find((item) => item.id === session.serverId);
                return (
                  <button
                    key={session.id}
                    className={`session-tab ${session.id === activeSessionId ? "active" : ""}`}
                    onClick={() => setActiveSessionId(session.id)}
                  >
                    <span className={`connection-indicator ${session.connected ? "online" : ""}`} />
                    <span>{session.title}</span>
                    <small>{server?.username}</small>
                    <X
                      size={12}
                      className="tab-close"
                      onClick={(event) => { event.stopPropagation(); void closeSession(session.id); }}
                    />
                  </button>
                );
              })}
            </div>
            <button
              className="icon-button quiet"
              title="为当前服务器新建会话"
              disabled={!activeServer}
              onClick={() => activeServer && openSession(activeServer, true)}
            ><Plus size={15} /></button>
          </div>

          {sessions.length === 0 ? (
            <div className="empty-workspace">
              <div className="empty-glyph"><Server size={24} /></div>
              <h2>选择一台服务器开始</h2>
              <p>在左侧选择连接，双击服务器或按 Enter 即可打开会话。</p>
              <button className="primary-button" onClick={() => openServerDialog()}><Plus size={14} /> 添加第一台服务器</button>
            </div>
          ) : (
            <div className="workspace-sessions">
              {sessions.map((session) => {
                const server = servers.find((item) => item.id === session.serverId);
                if (!server) return null;
                return (
                  <div
                    className={`workspace-session ${session.id === activeSessionId ? "active" : ""}`}
                    key={session.id}
                    style={{ "--ai-pane-width": `${aiPaneWidth}px` } as CSSProperties}
                  >
                    <section className="operations-column">
                      <TerminalPane session={session} server={server} onUpdate={(patch) => updateSession(session.id, patch)} />
                      <SystemDock
                        server={server}
                        filePane={(
                          <FilePane
                            session={session}
                            server={server}
                            onUpdate={(patch) => updateSession(session.id, patch)}
                            onTransfer={(request, operation) => startTransfer(session, server, request, operation)}
                          />
                        )}
                      />
                    </section>
                    {aiOpen && (
                      <>
                        <ColumnSplitter
                          label="调整 AI 助手宽度"
                          value={aiPaneWidth}
                          min={AI_PANE_MIN_WIDTH}
                          max={AI_PANE_MAX_WIDTH}
                          pane="next"
                          onChange={resizeAiPane}
                        />
                        <AiPane session={session} server={server} config={aiConfig} onUpdate={(patch) => updateSession(session.id, patch)} onOpenSettings={() => setSettingsOpen(true)} />
                      </>
                    )}
                    {!aiOpen && (
                      <button className="ai-reopen" title="打开 AI 助手" onClick={() => setAiOpen(true)}><Sparkles size={16} /></button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>

      {serverDialogOpen && (
        <ServerDialog
          server={editingServer}
          initialGroup={serverDialogGroup}
          onClose={() => { setServerDialogOpen(false); setEditingServer(undefined); setServerDialogGroup(undefined); }}
          onSave={saveServer}
          onDelete={editingServer ? () => { deleteServer(editingServer.id); setServerDialogOpen(false); setEditingServer(undefined); } : undefined}
        />
      )}
      <input
        ref={importFileRef}
        className="visually-hidden"
        type="file"
        accept="application/json,.json"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          if (file.size > MAX_SERVER_IMPORT_BYTES) {
            alert("导入文件不能超过 10 MB");
            return;
          }
          void file.text()
            .then(importServerText)
            .catch((error) => alert(`读取导入文件失败：${String(error)}`));
        }}
      />
      {aiImportOpen && (
        <AiImportDialog
          onClose={() => setAiImportOpen(false)}
          onParse={parseAiServerList}
          onImport={importAiServerList}
        />
      )}
      {settingsOpen && <SettingsDialog config={aiConfig} onSave={saveAiConfig} onRemoveSavedKey={removeSavedAiKey} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
