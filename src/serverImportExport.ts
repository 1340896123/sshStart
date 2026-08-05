import { normalizeGroupPath, isGroupWithin } from "./serverGroups";
import { uid } from "./lib";
import type { AuthType, JumpHostProfile, ServerProfile } from "./types";

export const SERVER_EXPORT_FORMAT = "portico-server-list";
export const SERVER_EXPORT_VERSION = 1;
export const AI_IMPORT_GROUP = "AI 导入";
export const MAX_SERVER_IMPORT_RECORDS = 5_000;

export interface ServerImportDraft {
  name?: string;
  group?: string;
  host: string;
  port?: number;
  username?: string;
  authType?: AuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  jumpHost?: Partial<JumpHostProfile>;
}

export interface ServerImportParseResult {
  drafts: ServerImportDraft[];
  groups: string[];
  skipped: number;
}

export interface ServerImportSummary {
  imported: number;
  skipped: number;
  groups: number;
}

interface ServerExportDocument {
  format: typeof SERVER_EXPORT_FORMAT;
  version: typeof SERVER_EXPORT_VERSION;
  exportedAt: string;
  includeSecrets: false;
  scope?: string;
  groups: string[];
  servers: Array<Omit<ServerProfile, "password" | "passphrase" | "jumpHost"> & {
    jumpHost?: Omit<JumpHostProfile, "password" | "passphrase">;
  }>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const textValue = (value: unknown) => typeof value === "string" ? value.trim() : "";

const portValue = (value: unknown, fallback = 22) => {
  const port = typeof value === "number" ? value : Number.parseInt(textValue(value), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
};

const authTypeValue = (value: unknown, privateKeyPath: string): AuthType => {
  const authType = textValue(value).toLocaleLowerCase();
  if (authType === "key" || authType === "password") return authType;
  return privateKeyPath ? "key" : "password";
};

const normalizeJumpHost = (value: unknown): JumpHostProfile | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const host = textValue(record.host);
  if (!host) return undefined;
  const privateKeyPath = textValue(record.privateKeyPath);
  return {
    enabled: record.enabled !== false,
    host,
    port: portValue(record.port),
    username: textValue(record.username) || "root",
    authType: authTypeValue(record.authType, privateKeyPath),
    password: textValue(record.password) || undefined,
    privateKeyPath: privateKeyPath || undefined,
    passphrase: textValue(record.passphrase) || undefined,
  };
};

export const normalizeServerDraft = (value: unknown, forcedGroup?: string): ServerImportDraft | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const host = textValue(record.host);
  if (!host) return undefined;
  const privateKeyPath = textValue(record.privateKeyPath);
  const username = textValue(record.username) || "root";
  return {
    name: textValue(record.name) || undefined,
    group: normalizeGroupPath(forcedGroup ?? textValue(record.group)),
    host,
    port: portValue(record.port),
    username,
    authType: authTypeValue(record.authType, privateKeyPath),
    password: textValue(record.password) || undefined,
    privateKeyPath: privateKeyPath || undefined,
    passphrase: textValue(record.passphrase) || undefined,
    jumpHost: normalizeJumpHost(record.jumpHost),
  };
};

export const parseServerImportText = (rawText: string): ServerImportParseResult => {
  const parsed = JSON.parse(rawText) as unknown;
  const root = asRecord(parsed);
  const values = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root?.servers)
      ? root.servers
      : Array.isArray(root?.data)
        ? root.data
        : [];
  if (values.length > MAX_SERVER_IMPORT_RECORDS) {
    throw new Error(`单次最多导入 ${MAX_SERVER_IMPORT_RECORDS} 台服务器`);
  }
  const groups = (Array.isArray(root?.groups) ? root.groups : [])
    .map(textValue)
    .map(normalizeGroupPath)
    .filter(Boolean);
  let skipped = 0;
  const drafts = values.flatMap((value) => {
    const draft = normalizeServerDraft(value);
    if (!draft) skipped += 1;
    return draft ? [draft] : [];
  });
  if (!drafts.length) throw new Error("文件中没有可导入的服务器记录");
  return { drafts, groups: [...new Set(groups)], skipped };
};

const safeServerForExport = (server: ServerProfile): ServerExportDocument["servers"][number] => {
  const { password: _password, passphrase: _passphrase, jumpHost, ...safeServer } = server;
  const safeJumpHost = jumpHost
    ? (({ password: _jumpPassword, passphrase: _jumpPassphrase, ...rest }) => rest)(jumpHost)
    : undefined;
  return { ...safeServer, jumpHost: safeJumpHost };
};

export const buildServerExportDocument = (
  servers: ServerProfile[],
  savedGroups: string[],
  scope?: string,
): ServerExportDocument => ({
  format: SERVER_EXPORT_FORMAT,
  version: SERVER_EXPORT_VERSION,
  exportedAt: new Date().toISOString(),
  includeSecrets: false,
  ...(scope !== undefined ? { scope: normalizeGroupPath(scope) || "未分组" } : {}),
  groups: [...new Set([
    ...savedGroups.map(normalizeGroupPath).filter(Boolean),
    ...servers.map((server) => normalizeGroupPath(server.group)).filter(Boolean),
  ])],
  servers: servers.map(safeServerForExport),
});

export const serializeServerExport = (
  servers: ServerProfile[],
  savedGroups: string[],
  scope?: string,
) => JSON.stringify(buildServerExportDocument(servers, savedGroups, scope), null, 2);

export const selectServersInGroup = (servers: ServerProfile[], group: string) => {
  const normalizedGroup = normalizeGroupPath(group);
  return servers.filter((server) => normalizedGroup
    ? isGroupWithin(server.group, normalizedGroup)
    : !normalizeGroupPath(server.group));
};

export const selectGroupsInGroup = (groups: string[], group: string) => {
  const normalizedGroup = normalizeGroupPath(group);
  if (!normalizedGroup) return [];
  return groups.filter((candidate) => isGroupWithin(candidate, normalizedGroup));
};

type ServerIdentityInput = Pick<
  ServerProfile,
  "name" | "group" | "host" | "port" | "username" | "authType" | "privateKeyPath" | "jumpHost"
>;

const serverIdentity = (server: ServerIdentityInput) => JSON.stringify([
  server.name.trim().toLocaleLowerCase(),
  normalizeGroupPath(server.group).toLocaleLowerCase(),
  server.username.trim().toLocaleLowerCase(),
  server.host.trim().toLocaleLowerCase(),
  server.port,
  server.authType,
  textValue(server.privateKeyPath),
  server.jumpHost
    ? [
        server.jumpHost.enabled,
        server.jumpHost.username.trim().toLocaleLowerCase(),
        server.jumpHost.host.trim().toLocaleLowerCase(),
        server.jumpHost.port,
        server.jumpHost.authType,
        textValue(server.jumpHost.privateKeyPath),
      ]
    : null,
]);

export const materializeServerDrafts = (
  drafts: ServerImportDraft[],
  existingServers: ServerProfile[],
  forcedGroup?: string,
): { servers: ServerProfile[]; groups: string[]; skipped: number } => {
  const identities = new Set(existingServers.map(serverIdentity));
  const names = new Set(existingServers.map((server) => server.name.trim().toLocaleLowerCase()));
  const servers: ServerProfile[] = [];
  let skipped = 0;
  drafts.forEach((draft) => {
    const normalizedGroup = normalizeGroupPath(forcedGroup ?? draft.group ?? "");
    const port = portValue(draft.port);
    const username = textValue(draft.username) || "root";
    const host = textValue(draft.host);
    const baseName = textValue(draft.name) || `${username}@${host}`;
    const privateKeyPath = textValue(draft.privateKeyPath) || undefined;
    const authType = draft.authType === "key"
      ? "key"
      : draft.authType === "password"
        ? "password"
        : privateKeyPath ? "key" : "password";
    const jumpHost = normalizeJumpHost(draft.jumpHost);
    const identity = serverIdentity({
      name: baseName,
      group: normalizedGroup,
      host,
      port,
      username,
      authType,
      privateKeyPath,
      jumpHost,
    });
    if (!host || identities.has(identity)) {
      skipped += 1;
      return;
    }
    let name = baseName;
    let suffix = 2;
    while (names.has(name.toLocaleLowerCase())) {
      name = `${baseName} ${suffix}`;
      suffix += 1;
    }
    const server: ServerProfile = {
      id: uid("server"),
      name,
      group: normalizedGroup,
      host,
      port,
      username,
      authType,
      password: textValue(draft.password) || undefined,
      privateKeyPath,
      passphrase: textValue(draft.passphrase) || undefined,
      color: "var(--accent)",
      jumpHost,
    };
    identities.add(serverIdentity(server));
    names.add(name.toLocaleLowerCase());
    servers.push(server);
  });
  const groups = [...new Set(servers.map((server) => server.group).filter(Boolean))];
  return { servers, groups, skipped };
};
