import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib";
import type { AiConversation } from "./aiHistory";
import type { AiConfig, ServerProfile } from "./types";

export interface AppStorageSnapshot {
  servers: ServerProfile[];
  deletedServerIds?: string[];
  savedGroups: string[];
  aiConfig: Partial<AiConfig> | null;
  aiConversations: AiConversation[];
  collapsedGroups: string[];
}

export interface CloudSyncStatus {
  authenticated: boolean;
  email?: string;
  keyPath: string;
  lastDataSync?: CloudSyncRecord;
  lastKeySync?: CloudKeySyncRecord;
}

export interface CloudSyncContentSummary {
  serverCount: number;
  groupCount: number;
  conversationCount: number;
  collapsedGroupCount: number;
  hasAiConfig: boolean;
  encryptedBytes: number;
}

export interface CloudSyncRecord {
  direction: "upload" | "download";
  completedAt: number;
  remoteUpdatedAt?: number;
  content: CloudSyncContentSummary;
}

export interface CloudKeySyncRecord {
  direction: "upload" | "download";
  completedAt: number;
  updatedAt: number;
  fileCount: number;
  totalBytes: number;
}

export type CloudSyncOperation = "push" | "pull" | "keys-upload" | "keys-download";
export type CloudSyncProgressStatus = "running" | "success" | "error";

export interface CloudSyncProgress {
  operationId: string;
  operation: CloudSyncOperation;
  status: CloudSyncProgressStatus;
  phase: string;
  progress: number;
  message: string;
}

export interface KeyFileInfo {
  name: string;
  size: number;
}

export interface KeySyncResult {
  files: KeyFileInfo[];
  updatedAt: number;
  pathUpdates: ServerKeyPathUpdate[];
}

export interface ServerKeyPathUpdate {
  serverId: string;
  jumpHost: boolean;
  privateKeyPath: string;
}

const EMPTY_SNAPSHOT: AppStorageSnapshot = {
  servers: [],
  deletedServerIds: [],
  savedGroups: [],
  aiConfig: null,
  aiConversations: [],
  collapsedGroups: [],
};

const stripServerSecrets = (server: ServerProfile) => {
  const { password: _password, passphrase: _passphrase, jumpHost, ...safeServer } = server;
  return {
    ...safeServer,
    jumpHost: jumpHost
      ? (({ password: _jumpPassword, passphrase: _jumpPassphrase, ...safeJumpHost }) => safeJumpHost)(jumpHost)
      : undefined,
  };
};

const cloudKeyServers = (servers: ServerProfile[]) => servers.map((server) => ({
  id: server.id,
  name: server.name,
  authType: server.authType,
  privateKeyPath: server.privateKeyPath,
  jumpHost: server.jumpHost
    ? {
        enabled: server.jumpHost.enabled,
        authType: server.jumpHost.authType,
        privateKeyPath: server.jumpHost.privateKeyPath,
      }
    : undefined,
}));

export const loadAppStorage = () =>
  isTauri() ? invoke<AppStorageSnapshot>("load_app_state") : Promise.resolve(EMPTY_SNAPSHOT);

export const saveServers = (servers: ServerProfile[]) =>
  isTauri()
    ? invoke("save_servers", { servers: servers.map(stripServerSecrets) })
    : Promise.resolve();

export const saveDeletedServerIds = (serverIds: string[]) =>
  isTauri() ? invoke("save_deleted_server_ids", { serverIds }) : Promise.resolve();

export const saveServerGroups = (groups: string[]) =>
  isTauri() ? invoke("save_server_groups", { groups }) : Promise.resolve();

export const saveAiConfig = (config: Partial<AiConfig>) =>
  isTauri() ? invoke("save_ai_config", { config }) : Promise.resolve();

export const saveAiConversations = (conversations: AiConversation[]) =>
  isTauri() ? invoke("save_ai_conversations", { conversations }) : Promise.resolve();

export const saveCollapsedGroups = (groups: string[]) =>
  isTauri() ? invoke("save_collapsed_groups", { groups }) : Promise.resolve();

export const getCloudSyncStatus = () =>
  isTauri() ? invoke<CloudSyncStatus>("sync_status") : Promise.resolve({ authenticated: false, keyPath: "" });

export const registerCloudSync = (endpoint: string, email: string, password: string) =>
  isTauri() ? invoke<{ email: string }>("sync_register", { endpoint, email, password }) : Promise.reject(new Error("云端同步仅可在桌面应用中使用"));

export const loginCloudSync = (endpoint: string, email: string, password: string) =>
  isTauri() ? invoke<{ email: string }>("sync_login", { endpoint, email, password }) : Promise.reject(new Error("云端同步仅可在桌面应用中使用"));

export const logoutCloudSync = () =>
  isTauri() ? invoke("sync_logout") : Promise.resolve();

export const pushCloudSync = (endpoint: string, snapshot: AppStorageSnapshot, operationId: string) =>
  isTauri() ? invoke("sync_push", { endpoint, snapshot, operationId }) : Promise.resolve();

export const pullCloudSync = (endpoint: string, operationId: string) =>
  isTauri() ? invoke<AppStorageSnapshot | null>("sync_pull", { endpoint, operationId }) : Promise.resolve(null);

export const listCloudSyncKeyFiles = (servers: ServerProfile[]) =>
  isTauri() ? invoke<KeyFileInfo[]>("sync_list_key_files", { servers: cloudKeyServers(servers) }) : Promise.resolve([]);

export const uploadCloudSyncKeys = (endpoint: string, passphrase: string, servers: ServerProfile[], operationId: string) =>
  isTauri()
    ? invoke<KeySyncResult>("sync_upload_keys", { endpoint, passphrase, servers: cloudKeyServers(servers), operationId })
    : Promise.reject(new Error("密钥同步仅可在桌面应用中使用"));

export const downloadCloudSyncKeys = (endpoint: string, passphrase: string, overwrite: boolean, operationId: string) =>
  isTauri()
    ? invoke<KeySyncResult>("sync_download_keys", { endpoint, passphrase, overwrite, operationId })
    : Promise.reject(new Error("密钥同步仅可在桌面应用中使用"));
