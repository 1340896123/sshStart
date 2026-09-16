import type { ServerProfile } from "./types";

export const isTauri = () => Boolean(window.__TAURI_INTERNALS__);

export const uid = (prefix: string) =>
  `${prefix}-${crypto.randomUUID()}`;

export const formatBytes = (size: number) => {
  if (size === 0) return "0 B";
  if (!size) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
  return `${(size / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export const connectionLabel = (server: ServerProfile) =>
  `${server.username}@${server.host}:${server.port}`;

export const connectionIdentity = (server: ServerProfile) => JSON.stringify([
  server.id, server.host, server.port, server.username, server.authType,
  server.privateKeyPath, server.password, server.passphrase,
  server.jumpHost?.enabled ? [server.jumpHost.host, server.jumpHost.port, server.jumpHost.username,
    server.jumpHost.authType, server.jumpHost.privateKeyPath, server.jumpHost.password, server.jumpHost.passphrase] : null,
]);

export const parentPath = (path: string) => {
  if (path === "/") return "/";
  const clean = path.replace(/\/$/, "");
  const index = clean.lastIndexOf("/");
  return index <= 0 ? "/" : clean.slice(0, index);
};

export const joinRemotePath = (base: string, child: string) =>
  base === "/" ? `/${child}` : `${base.replace(/\/$/, "")}/${child}`;
