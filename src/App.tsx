import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bell,
  Braces,
  ChevronDown,
  CircleHelp,
  Command,
  FolderSync,
  PanelLeftClose,
  Plus,
  Search,
  Server,
  Settings,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { AiPane } from "./components/AiPane";
import { FilePane } from "./components/FilePane";
import { ServerDialog } from "./components/ServerDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { TerminalPane } from "./components/TerminalPane";
import { TransferPanel } from "./components/TransferPanel";
import { SystemDock } from "./components/SystemDock";
import { DEMO_SERVER, connectionLabel, isTauri, uid } from "./lib";
import type { AiConfig, ServerProfile, SessionState, TransferRequest, TransferTask, WorkspaceView } from "./types";

const DEFAULT_AI_CONFIG: AiConfig = {
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  systemPrompt:
    "你是一名谨慎的 Linux 运维助手。优先解释风险；需要时使用 run_ssh_command 工具，并在执行破坏性命令前请求确认。",
};

function useStoredState<T>(key: string, initialValue: T, serialize: (value: T) => unknown = (value) => value) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : initialValue;
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
    items.map(({ password: _password, passphrase: _passphrase, ...server }) => server),
  );
  const [aiConfig, setAiConfig] = useStoredState<AiConfig>("portico.ai", DEFAULT_AI_CONFIG, ({ apiKey: _apiKey, ...config }) => config);
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("terminal");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<"servers" | "transfers">("servers");
  const [aiOpen, setAiOpen] = useState(true);
  const [serverDialogOpen, setServerDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerProfile>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [transfers, setTransfers] = useState<TransferTask[]>([]);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeServer = servers.find((server) => server.id === activeSession?.serverId);

  const groups = useMemo(() => {
    const filtered = servers.filter((server) => {
      const value = `${server.name} ${server.host} ${server.group}`.toLowerCase();
      return value.includes(search.toLowerCase());
    });
    return Object.entries(
      filtered.reduce<Record<string, ServerProfile[]>>((result, server) => {
        (result[server.group || "未分组"] ||= []).push(server);
        return result;
      }, {}),
    );
  }, [search, servers]);

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
    if (isTauri()) {
      await invoke("store_server_secret", {
        serverId: server.id,
        password: server.password?.trim() || null,
        passphrase: server.passphrase?.trim() || null,
      });
    }
    setServers((current) => {
      const exists = current.some((item) => item.id === server.id);
      return exists
        ? current.map((item) => (item.id === server.id ? server : item))
        : [...current, server];
    });
    setServerDialogOpen(false);
    setEditingServer(undefined);
    openSession(server, true);
  };

  const deleteServer = (serverId: string) => {
    if (isTauri()) void invoke("delete_server_secret", { serverId }).catch(() => undefined);
    setServers((current) => current.filter((server) => server.id !== serverId));
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
    operation: () => Promise<void>,
  ) => {
    const id = uid("transfer");
    const task: TransferTask = {
      ...request,
      id,
      sessionId: session.id,
      sessionTitle: session.title,
      serverName: server.name,
      serverHost: server.host,
      status: "queued",
      createdAt: Date.now(),
    };
    setTransfers((current) => [task, ...current]);
    await Promise.resolve();
    setTransfers((current) => current.map((item) => item.id === id ? { ...item, status: "running" } : item));
    try {
      await operation();
      setTransfers((current) => current.map((item) => item.id === id ? { ...item, status: "completed", finishedAt: Date.now() } : item));
    } catch (reason) {
      const error = String(reason);
      setTransfers((current) => current.map((item) => item.id === id ? { ...item, status: "failed", error, finishedAt: Date.now() } : item));
      throw reason;
    }
  };

  const selectSidebar = (view: "servers" | "transfers") => {
    setSidebarView(view);
    setSidebarOpen(true);
  };

  const activeTransferCount = transfers.filter((task) => task.status === "queued" || task.status === "running").length;

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
            <div className="sidebar-heading">
              <div>
                <span className="eyebrow">工作区</span>
                <h1>服务器</h1>
              </div>
              <button
                className="icon-button"
                aria-label="添加服务器"
                title="添加服务器"
                onClick={() => setServerDialogOpen(true)}
              ><Plus size={15} /></button>
            </div>
            <label className="search-field">
              <Search size={14} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、主机或分组" />
              <kbd>Ctrl K</kbd>
            </label>

            <div className="server-list">
              {groups.map(([group, items]) => (
                <section className="server-group" key={group}>
                  <div className="group-label"><ChevronDown size={12} /><span>{group}</span><small>{items.length}</small></div>
                  {items.map((server) => {
                    const isActive = activeServer?.id === server.id;
                    const liveCount = sessions.filter((session) => session.serverId === server.id).length;
                    return (
                      <div
                        className={`server-row ${isActive ? "selected" : ""}`}
                        key={server.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => openSession(server)}
                        onDoubleClick={() => openSession(server, true)}
                        onKeyDown={(event) => event.key === "Enter" && openSession(server)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setEditingServer(server);
                          setServerDialogOpen(true);
                        }}
                      >
                        <span className="server-avatar" style={{ background: server.color }}>{server.name.slice(0, 1).toUpperCase()}</span>
                        <span className="server-copy">
                          <strong>{server.name}</strong>
                          <span>{connectionLabel(server)}</span>
                        </span>
                        {liveCount > 0 && <span className="session-count">{liveCount}</span>}
                        <button
                          className="row-action"
                          title="新建独立会话"
                          aria-label={`为 ${server.name} 新建会话`}
                          onClick={(event) => { event.stopPropagation(); openSession(server, true); }}
                        ><Plus size={13} /></button>
                      </div>
                    );
                  })}
                </section>
              ))}
              {groups.length === 0 && <div className="sidebar-empty">没有匹配的服务器</div>}
            </div>

            <button className="add-server-button" onClick={() => setServerDialogOpen(true)}>
              <Plus size={14} /> 添加服务器
            </button>
          </aside>
        )}
        {sidebarOpen && sidebarView === "transfers" && (
          <TransferPanel
            transfers={transfers}
            onActivateSession={setActiveSessionId}
            onClearFinished={() => setTransfers((current) => current.filter((task) => task.status === "queued" || task.status === "running"))}
            onDismiss={(id) => setTransfers((current) => current.filter((task) => task.id !== id))}
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
              <p>从左侧打开已有连接，双击可直接创建新的独立会话。</p>
              <button className="primary-button" onClick={() => setServerDialogOpen(true)}><Plus size={14} /> 添加第一台服务器</button>
            </div>
          ) : (
            <div className="workspace-sessions">
              {sessions.map((session) => {
                const server = servers.find((item) => item.id === session.serverId);
                if (!server) return null;
                return (
                  <div className={`workspace-session ${session.id === activeSessionId ? "active" : ""}`} key={session.id}>
                    <section className="operations-column">
                      <div className="view-switcher" role="tablist" aria-label="工作视图">
                        <button className={workspaceView === "terminal" ? "active" : ""} onClick={() => setWorkspaceView("terminal")}><SquareTerminal size={13} /> 终端</button>
                        <button className={workspaceView === "split" ? "active" : ""} onClick={() => setWorkspaceView("split")}>双栏</button>
                        <button className={workspaceView === "files" ? "active" : ""} onClick={() => setWorkspaceView("files")}><FolderSync size={13} /> 文件</button>
                      </div>
                      <div className={`operations-grid view-${workspaceView}`}>
                        <TerminalPane session={session} server={server} onUpdate={(patch) => updateSession(session.id, patch)} />
                        <FilePane
                          session={session}
                          server={server}
                          onUpdate={(patch) => updateSession(session.id, patch)}
                          onTransfer={(request, operation) => startTransfer(session, server, request, operation)}
                        />
                      </div>
                      <SystemDock
                        server={server}
                        filesActive={workspaceView === "files"}
                        onOpenSystem={() => setWorkspaceView("terminal")}
                        onOpenFiles={() => setWorkspaceView("files")}
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
          onClose={() => { setServerDialogOpen(false); setEditingServer(undefined); }}
          onSave={saveServer}
          onDelete={editingServer ? () => { deleteServer(editingServer.id); setServerDialogOpen(false); setEditingServer(undefined); } : undefined}
        />
      )}
      {settingsOpen && <SettingsDialog config={aiConfig} onSave={saveAiConfig} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
