import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import { FilePane } from "./components/FilePane";
import { ServerDialog } from "./components/ServerDialog";
import { ServerTree } from "./components/ServerTree";
import { SettingsDialog } from "./components/SettingsDialog";
import { TerminalPane } from "./components/TerminalPane";
import { TransferPanel } from "./components/TransferPanel";
import { SystemDock } from "./components/SystemDock";
import { DEV_BOOTSTRAP } from "./devBootstrap";
import { DEMO_SERVER, isTauri, uid } from "./lib";
import { normalizeGroupPath, removeGroupLevel, replaceGroupPrefix } from "./serverGroups";
import { DEFAULT_AI_TOOL_SETTINGS } from "./types";
import type { AiConfig, ServerProfile, SessionState, TransferRequest, TransferTask } from "./types";

const DEFAULT_AI_CONFIG: AiConfig = {
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  contextWindow: 128000,
  maxOutputTokens: 4096,
  autoCompress: true,
  supportsImages: true,
  temperature: 0.2,
  systemPrompt:
    "你是一名谨慎的 Linux 运维助手。优先解释风险；先使用 risk_checker 评估动作，再调用合适的结构化工具。高风险操作必须等待人工确认，不要尝试绕过本地策略。",
  tools: DEFAULT_AI_TOOL_SETTINGS,
};

function useStoredState<T>(key: string, initialValue: T, serialize: (value: T) => unknown = (value) => value) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (!stored) return initialValue;
      const parsed = JSON.parse(stored) as T;
      return typeof initialValue === "object" && initialValue !== null && !Array.isArray(initialValue)
        ? { ...initialValue, ...parsed }
        : parsed;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(serialize(value)));
  }, [key, serialize, value]);

  return [value, setValue] as const;
}

export default function App() {
  const [servers, setServers] = useStoredState<ServerProfile[]>("portico.servers", [DEMO_SERVER], (items) =>
    items.map(({ password: _password, passphrase: _passphrase, jumpHost, ...server }) => ({
      ...server,
      jumpHost: jumpHost ? (({ password: _jumpPassword, passphrase: _jumpPassphrase, ...rest }) => rest)(jumpHost) : undefined,
    })),
  );
  const [savedGroups, setSavedGroups] = useStoredState<string[]>("portico.server-groups", []);
  const [aiConfig, setAiConfig] = useStoredState<AiConfig>("portico.ai", DEFAULT_AI_CONFIG, ({ apiKey: _apiKey, ...config }) => config);
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<"servers" | "transfers">("servers");
  const [aiOpen, setAiOpen] = useState(true);
  const [serverDialogOpen, setServerDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerProfile>();
  const [serverDialogGroup, setServerDialogGroup] = useState<string>();
  const [selectedServerId, setSelectedServerId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [transfers, setTransfers] = useState<TransferTask[]>([]);
  const cancelledTransfers = useRef(new Set<string>());

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeServer = servers.find((server) => server.id === activeSession?.serverId);

  useEffect(() => {
    if (!DEV_BOOTSTRAP) return;

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
    if (ai) setAiConfig((current) => ({ ...current, ...ai }));

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
    if (ai?.apiKey) writes.push(invoke("store_ai_key", { apiKey: ai.apiKey }));
    void Promise.all(writes).catch((error) => console.error("Failed to initialize development credentials", error));
  }, [setAiConfig, setSavedGroups, setServers]);

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

  const deleteServer = (serverId: string) => {
    if (isTauri()) void invoke("delete_server_secret", { serverId }).catch(() => undefined);
    setServers((current) => current.filter((server) => server.id !== serverId));
    setSelectedServerId((current) => current === serverId ? undefined : current);
    sessions
      .filter((session) => session.serverId === serverId)
      .forEach((session) => void closeSession(session.id));
  };

  const saveAiConfig = async (next: AiConfig) => {
    if (isTauri() && next.apiKey.trim()) {
      await invoke("store_ai_key", { apiKey: next.apiKey.trim() });
    }
    setAiConfig(next);
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
        setTransfers((current) => current.map((item) => item.id === id ? { ...item, status: "completed", finishedAt: Date.now() } : item));
      }
    } catch (reason) {
      if (cancelledTransfers.current.has(id)) {
        cancelledTransfers.current.delete(id);
        setTransfers((current) => current.map((item) => item.id === id ? { ...item, status: "cancelled", error: undefined, finishedAt: item.finishedAt ?? Date.now() } : item));
        return;
      }
      const error = String(reason);
      setTransfers((current) => current.map((item) => item.id === id ? { ...item, status: "failed", error, finishedAt: Date.now() } : item));
      throw reason;
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
      ? { ...item, transferId, status: "queued", error: undefined, finishedAt: undefined }
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
          ? { ...item, status: "completed", error: undefined, finishedAt: Date.now() }
          : item));
      }
    } catch (reason) {
      if (cancelledTransfers.current.has(task.id)) {
        cancelledTransfers.current.delete(task.id);
        setTransfers((current) => current.map((item) => item.id === task.id ? { ...item, status: "cancelled", error: undefined, finishedAt: item.finishedAt ?? Date.now() } : item));
      } else {
        setTransfers((current) => current.map((item) => item.id === task.id
          ? { ...item, status: "failed", error: String(reason), finishedAt: Date.now() }
          : item));
      }
    }
  };

  const pauseTransfer = async (task: TransferTask) => {
    try {
      await invoke("pause_transfer", { transferId: task.transferId });
      setTransfers((current) => current.map((item) => item.id === task.id && (item.status === "queued" || item.status === "running")
        ? { ...item, status: "paused", error: undefined }
        : item));
    } catch (reason) {
      setTransfers((current) => current.map((item) => item.id === task.id ? { ...item, error: `暂停失败：${String(reason)}` } : item));
    }
  };

  const resumeTransfer = async (task: TransferTask) => {
    try {
      await invoke("resume_transfer", { transferId: task.transferId });
      setTransfers((current) => current.map((item) => item.id === task.id && item.status === "paused"
        ? { ...item, status: "running", error: undefined }
        : item));
    } catch (reason) {
      setTransfers((current) => current.map((item) => item.id === task.id ? { ...item, error: `继续失败：${String(reason)}` } : item));
    }
  };

  const cancelTransfer = async (task: TransferTask) => {
    const currentTask = transfers.find((item) => item.id === task.id);
    if (!currentTask || (currentTask.status !== "queued" && currentTask.status !== "running" && currentTask.status !== "paused")) return;
    cancelledTransfers.current.add(task.id);
    setTransfers((current) => current.map((item) => item.id === task.id
      ? { ...item, status: "cancelled", error: undefined, finishedAt: item.finishedAt ?? Date.now() }
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

  const deleteGroup = (group: string) => {
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

  const activeTransferCount = transfers.filter((task) => task.status === "queued" || task.status === "running" || task.status === "paused").length;

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

      <div className="app-body">
        <nav className="activity-rail" aria-label="主导航">
          <div className="activity-main">
            <button className={`activity-button ${sidebarView === "servers" ? "active" : ""}`} title="服务器" onClick={() => selectSidebar("servers")}><SquareTerminal size={18} /></button>
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
          <aside className="server-sidebar">
            <ServerTree
              servers={servers}
              savedGroups={savedGroups}
              sessions={sessions}
              search={search}
              selectedServerId={selectedServerId ?? activeServer?.id}
              activeServerId={activeServer?.id}
              onSearchChange={setSearch}
              onSelect={(server) => setSelectedServerId(server.id)}
              onOpen={(server) => { setSelectedServerId(server.id); openSession(server); }}
              onNewSession={(server) => { setSelectedServerId(server.id); openSession(server, true); }}
              onAddServer={(group) => openServerDialog(undefined, group)}
              onEditServer={(server) => openServerDialog(server)}
              onDeleteServer={(server) => deleteServer(server.id)}
              onMoveServer={moveServer}
              onCreateGroup={createGroup}
              onRenameGroup={renameGroup}
              onDeleteGroup={deleteGroup}
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
                  <div className={`workspace-session ${session.id === activeSessionId ? "active" : ""}`} key={session.id}>
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
                    {aiOpen && <AiPane session={session} server={server} config={aiConfig} onUpdate={(patch) => updateSession(session.id, patch)} onOpenSettings={() => setSettingsOpen(true)} />}
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
      {settingsOpen && <SettingsDialog config={aiConfig} onSave={saveAiConfig} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
