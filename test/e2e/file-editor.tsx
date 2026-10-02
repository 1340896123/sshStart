import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePane } from "../../src/components/FilePane";
import monaco from "../../src/monaco";
import type { ServerProfile, SessionState } from "../../src/types";
import "../../src/styles.css";

const initialServers = JSON.parse(new URL(location.href).searchParams.get("servers") ?? "[]") as ServerProfile[];

function Harness({ initialServers }: { initialServers: ServerProfile[] }) {
  const [servers, setServers] = useState(initialServers);
  const [active, setActive] = useState(0);
  const [sessions, setSessions] = useState<SessionState[]>(() => initialServers.map((server, index) => ({
    id: `e2e-session-${index}`, serverId: server.id, title: server.name,
    connected: true, terminalStarted: false, cwd: "/", aiMessages: [],
  })));
  return <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <nav style={{ display: "flex", gap: 12, padding: 12 }}>
      {servers.map((server, index) => <button key={sessions[index].id} onClick={() => setActive(index)}>{index < initialServers.length ? server.id : `${server.id}-same-server`}</button>)}
      <button onClick={() => setServers((current) => current.map((server, index) => index === active ? { ...server, name: `${server.name} renamed` } : server))}>修改服务器名称</button>
      <button onClick={() => {
        setServers((current) => [...current, { ...current[active] }]);
        setSessions((current) => [...current, { ...current[active], id: `e2e-session-${current.length}` }]);
        setActive(sessions.length);
      }}>同服务器新会话</button>
    </nav>
    {sessions.map((session, index) => <div key={session.id} data-e2e-server={index < initialServers.length ? servers[index].id : `${servers[index].id}-same-server`} hidden={index !== active} style={{ display: index === active ? "flex" : "none", flex: 1, minHeight: 0 }}>
      <FilePane session={session} server={servers[index]}
        onUpdate={(patch) => setSessions((current) => current.map((item) => item.id === session.id ? { ...item, ...patch } : item))}
        onTransfer={async (_, operation) => { await operation(crypto.randomUUID()); }} />
    </div>)}
  </main>;
}

// Observation only: edits and saves in the suite use WebDriver keyboard/mouse.
(window as unknown as { e2eModels: () => unknown }).e2eModels = () => monaco.editor.getModels().map((model) => ({ uri: model.uri.toString(), content: model.getValue() }));
const root = createRoot(document.getElementById("root")!);
let sequence = 0;
(window as unknown as { e2eConfigure: (servers: ServerProfile[]) => void }).e2eConfigure = (servers) => {
  root.render(<Harness key={++sequence} initialServers={servers} />);
};
root.render(<Harness initialServers={initialServers} />);
