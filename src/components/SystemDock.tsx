import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CircleStop,
  Folder,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { isTauri } from "../lib";
import type { NetworkConnection, NetworkInterface, ProcessInfo, ServerProfile } from "../types";

type DockView = "processes" | "network";
type NetworkView = "listening" | "active" | "interfaces";
type ProcessSort = "pid" | "user" | "command" | "memoryPercent" | "cpuPercent" | "elapsedSeconds";

interface Props {
  server: ServerProfile;
  filesActive: boolean;
  onOpenSystem: () => void;
  onOpenFiles: () => void;
}

const DEMO_PROCESSES: ProcessInfo[] = [
  { pid: 305511, user: "plm", command: "java", memoryPercent: 2.4, cpuPercent: 11, elapsedSeconds: 13154822, arguments: "/usr/share/elasticsearch/jdk/bin/java -Xshare:auto -Des.networkaddress.cache.ttl=60" },
  { pid: 300324, user: "root", command: "dockerd", memoryPercent: 0.1, cpuPercent: 7.9, elapsedSeconds: 13155180, arguments: "/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock" },
  { pid: 4100284, user: "root", command: "apps.plugin", memoryPercent: 0, cpuPercent: 7.6, elapsedSeconds: 3670702, arguments: "/usr/libexec/netdata/plugins.d/apps.plugin 1" },
  { pid: 4100286, user: "201", command: "netdata", memoryPercent: 0.7, cpuPercent: 6.6, elapsedSeconds: 3670679, arguments: "/usr/sbin/netdata -u netdata -D -s /host -p 19999" },
  { pid: 41233785, user: "root", command: "java", memoryPercent: 4.7, cpuPercent: 3, elapsedSeconds: 117659, arguments: "java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=7899" },
  { pid: 3592011, user: "root", command: "java", memoryPercent: 11.2, cpuPercent: 2.7, elapsedSeconds: 721791, arguments: "java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005" },
];

const DEMO_CONNECTIONS: NetworkConnection[] = [
  { protocol: "TCP", state: "LISTEN", localAddress: "0.0.0.0", localPort: 19999, remoteAddress: "0.0.0.0", process: "docker-proxy", pid: 4100284 },
  { protocol: "TCP", state: "LISTEN", localAddress: "0.0.0.0", localPort: 2089, remoteAddress: "0.0.0.0", process: "docker-proxy", pid: 673434 },
  { protocol: "TCP", state: "LISTEN", localAddress: "127.0.0.1", localPort: 631, remoteAddress: "0.0.0.0", process: "cupsd", pid: 849322 },
  { protocol: "TCP", state: "LISTEN", localAddress: "0.0.0.0", localPort: 22, remoteAddress: "0.0.0.0", process: "sshd", pid: 3091128 },
  { protocol: "UDP", state: "UNCONN", localAddress: "127.0.0.54", localPort: 53, remoteAddress: "0.0.0.0", process: "systemd-resolve", pid: 1531365 },
  { protocol: "TCP", state: "ESTAB", localAddress: "10.0.0.12", localPort: 22, remoteAddress: "81.71.66.200", remotePort: 51002, process: "sshd", pid: 3091162 },
];

const DEMO_INTERFACES: NetworkInterface[] = [
  { name: "eth0", family: "INET", address: "10.0.0.12", prefixLength: 24, state: "UP", mac: "02:42:ac:11:00:02", mtu: 1500 },
  { name: "eth0", family: "INET6", address: "fe80::42:acff:fe11:2", prefixLength: 64, state: "UP", mac: "02:42:ac:11:00:02", mtu: 1500 },
  { name: "lo", family: "INET", address: "127.0.0.1", prefixLength: 8, state: "UNKNOWN", mac: "00:00:00:00:00:00", mtu: 65536 },
];

function formatElapsed(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}-${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function endpoint(address: string, port?: number) {
  const host = address.includes(":") ? `[${address}]` : address;
  return port === undefined ? host : `${host}:${port}`;
}

export function SystemDock({ server, filesActive, onOpenSystem, onOpenFiles }: Props) {
  const [active, setActive] = useState<DockView | undefined>("processes");
  const [networkView, setNetworkView] = useState<NetworkView>("listening");
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [connections, setConnections] = useState<NetworkConnection[]>([]);
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [selectedPid, setSelectedPid] = useState<number>();
  const [signaling, setSignaling] = useState(false);
  const [sort, setSort] = useState<{ key: ProcessSort; direction: "asc" | "desc" }>({ key: "cpuPercent", direction: "desc" });

  const loadProcesses = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const rows = isTauri() ? await invoke<ProcessInfo[]>("list_processes", { server }) : DEMO_PROCESSES;
      setProcesses(rows);
      setSelectedPid((current) => current !== undefined && rows.some((row) => row.pid === current) ? current : undefined);
    } catch (reason) {
      setError(String(reason));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [server]);

  const loadNetwork = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const [nextConnections, nextInterfaces] = isTauri()
        ? await Promise.all([
            invoke<NetworkConnection[]>("list_network_connections", { server }),
            invoke<NetworkInterface[]>("list_network_interfaces", { server }),
          ])
        : [DEMO_CONNECTIONS, DEMO_INTERFACES];
      setConnections(nextConnections);
      setInterfaces(nextInterfaces);
    } catch (reason) {
      setError(String(reason));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [server]);

  const refresh = useCallback((quiet = false) => {
    if (active === "processes") return loadProcesses(quiet);
    if (active === "network") return loadNetwork(quiet);
    return Promise.resolve();
  }, [active, loadNetwork, loadProcesses]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useEffect(() => {
    if (!autoRefresh || !active) return;
    const timer = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [active, autoRefresh, refresh]);

  const visibleProcesses = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const direction = sort.direction === "asc" ? 1 : -1;
    return processes
      .filter((process) => `${process.pid} ${process.user} ${process.command} ${process.arguments}`.toLowerCase().includes(needle))
      .sort((left, right) => {
        const leftValue = left[sort.key];
        const rightValue = right[sort.key];
        const result = typeof leftValue === "number"
          ? leftValue - Number(rightValue)
          : String(leftValue).localeCompare(String(rightValue), "zh-CN", { numeric: true });
        return result * direction;
      });
  }, [processes, query, sort]);

  const visibleConnections = useMemo(() => {
    const listeners = connections.filter((row) => row.state === "LISTEN" || row.state === "UNCONN");
    const source = networkView === "listening" ? listeners : connections.filter((row) => !listeners.includes(row));
    const needle = query.trim().toLowerCase();
    return source.filter((row) => `${row.protocol} ${row.state} ${row.localAddress} ${row.localPort ?? ""} ${row.remoteAddress} ${row.remotePort ?? ""} ${row.pid ?? ""} ${row.process ?? ""}`.toLowerCase().includes(needle));
  }, [connections, networkView, query]);

  const visibleInterfaces = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return interfaces.filter((item) => `${item.name} ${item.family} ${item.address} ${item.state} ${item.mac}`.toLowerCase().includes(needle));
  }, [interfaces, query]);

  const toggleSort = (key: ProcessSort) => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "user" || key === "command" ? "asc" : "desc" });
  };

  const signalProcess = async (signal: "TERM" | "KILL") => {
    const process = processes.find((item) => item.pid === selectedPid);
    if (!process) return;
    const action = signal === "TERM" ? "结束" : "强制结束";
    if (!window.confirm(`${action}进程 ${process.command} (PID ${process.pid})？`)) return;
    setSignaling(true);
    setError("");
    try {
      if (isTauri()) await invoke("signal_process", { server, pid: process.pid, signal });
      else setProcesses((current) => current.filter((item) => item.pid !== process.pid));
      setSelectedPid(undefined);
      if (isTauri()) await loadProcesses(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSignaling(false);
    }
  };

  const switchView = (view: DockView) => {
    setQuery("");
    const next = active === view ? undefined : view;
    setActive(next);
    if (next) onOpenSystem();
  };

  const sortGlyph = (key: ProcessSort) => sort.key === key
    ? sort.direction === "asc" ? <ArrowUp size={10} /> : <ArrowDown size={10} />
    : null;

  return (
    <section className={`system-dock ${active ? "expanded" : "collapsed"}`} aria-label="系统工具">
      {active && (
        <div className="system-dock-content">
          <div className="system-toolbar">
            <label className="system-search">
              <Search size={13} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={active === "processes" ? "搜索 PID、用户、命令或参数" : "搜索地址、端口、进程或网卡"}
              />
            </label>
            {active === "processes" && selectedPid !== undefined && (
              <div className="process-actions">
                <span>PID {selectedPid}</span>
                <button disabled={signaling} title="发送 TERM 信号" onClick={() => void signalProcess("TERM")}><CircleStop size={13} />结束</button>
                <button className="danger" disabled={signaling} title="发送 KILL 信号" onClick={() => void signalProcess("KILL")}><ShieldAlert size={13} />强制结束</button>
              </div>
            )}
            <span className="system-toolbar-spacer" />
            <button
              className={`system-icon-button ${autoRefresh ? "active" : ""}`}
              title={autoRefresh ? "关闭每 5 秒自动刷新" : "开启每 5 秒自动刷新"}
              aria-pressed={autoRefresh}
              onClick={() => setAutoRefresh((value) => !value)}
            ><Activity size={13} /></button>
            <button className="system-icon-button" title="刷新" onClick={() => void refresh()}><RefreshCw className={loading ? "spinning" : ""} size={13} /></button>
            <button className="system-icon-button" title="收起" onClick={() => setActive(undefined)}><X size={13} /></button>
          </div>

          {active === "network" && (
            <div className="network-tabs" role="tablist" aria-label="网络视图">
              <button className={networkView === "listening" ? "active" : ""} onClick={() => setNetworkView("listening")}>监听端口</button>
              <button className={networkView === "active" ? "active" : ""} onClick={() => setNetworkView("active")}>活动连接</button>
              <button className={networkView === "interfaces" ? "active" : ""} onClick={() => setNetworkView("interfaces")}>网卡</button>
            </div>
          )}

          {error ? (
            <div className="system-state error"><span>{error}</span><button onClick={() => void refresh()}>重试</button></div>
          ) : active === "processes" ? (
            <div className="system-table-wrap">
              <table className="system-table process-table">
                <thead><tr>
                  {([
                    ["pid", "PID"], ["user", "用户"], ["command", "命令"], ["memoryPercent", "内存"],
                    ["cpuPercent", "CPU"], ["elapsedSeconds", "运行时间"],
                  ] as Array<[ProcessSort, string]>).map(([key, label]) => (
                    <th key={key} aria-sort={sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                      <button onClick={() => toggleSort(key)}>{label}{sortGlyph(key)}</button>
                    </th>
                  ))}
                  <th>参数</th>
                </tr></thead>
                <tbody>
                  {visibleProcesses.map((process) => (
                    <tr
                      key={process.pid}
                      className={process.pid === selectedPid ? "selected" : ""}
                      onClick={() => setSelectedPid(process.pid)}
                      onDoubleClick={() => setSelectedPid(process.pid)}
                    >
                      <td>{process.pid}</td><td>{process.user}</td><td className="strong">{process.command}</td>
                      <td>{process.memoryPercent.toFixed(1)}%</td><td>{process.cpuPercent.toFixed(1)}%</td>
                      <td>{formatElapsed(process.elapsedSeconds)}</td><td title={process.arguments}>{process.arguments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!loading && visibleProcesses.length === 0 && <div className="system-state">没有匹配的进程</div>}
            </div>
          ) : networkView === "interfaces" ? (
            <div className="system-table-wrap">
              <table className="system-table interface-table">
                <thead><tr><th>网卡</th><th>状态</th><th>协议</th><th>地址</th><th>MAC</th><th>MTU</th></tr></thead>
                <tbody>{visibleInterfaces.map((item, index) => (
                  <tr key={`${item.name}-${item.family}-${item.address}-${index}`}>
                    <td className="strong">{item.name}</td><td><span className={`status-pill ${item.state === "UP" ? "online" : ""}`}>{item.state}</span></td>
                    <td>{item.family}</td><td>{item.address}{item.prefixLength === undefined ? "" : `/${item.prefixLength}`}</td><td>{item.mac}</td><td>{item.mtu}</td>
                  </tr>
                ))}</tbody>
              </table>
              {!loading && visibleInterfaces.length === 0 && <div className="system-state">没有匹配的网卡</div>}
            </div>
          ) : (
            <div className="system-table-wrap">
              <table className="system-table network-table">
                <thead><tr><th>协议</th><th>本地地址</th><th>远程地址</th><th>状态</th><th>PID</th><th>进程</th></tr></thead>
                <tbody>{visibleConnections.map((row, index) => (
                  <tr key={`${row.protocol}-${row.localAddress}-${row.localPort}-${row.remoteAddress}-${row.remotePort}-${index}`}>
                    <td className="protocol">{row.protocol}</td><td className="strong">{endpoint(row.localAddress, row.localPort)}</td>
                    <td>{endpoint(row.remoteAddress, row.remotePort)}</td><td><span className={`status-pill ${row.state === "LISTEN" || row.state === "ESTAB" ? "online" : ""}`}>{row.state}</span></td>
                    <td>{row.pid ?? "-"}</td><td className="strong">{row.process ?? "-"}</td>
                  </tr>
                ))}</tbody>
              </table>
              {!loading && visibleConnections.length === 0 && <div className="system-state">没有匹配的网络连接</div>}
            </div>
          )}
        </div>
      )}

      <div className="system-dock-tabs" role="tablist" aria-label="终端工具">
        <button className={active === "processes" ? "active" : ""} onClick={() => switchView("processes")}><Activity size={13} />进程管理</button>
        <button className={active === "network" ? "active" : ""} onClick={() => switchView("network")}><Network size={13} />网络</button>
        <button className={!active && filesActive ? "active" : ""} onClick={() => { setActive(undefined); onOpenFiles(); }}><Folder size={13} />文件管理</button>
      </div>
    </section>
  );
}
