import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib";
import type { AiConversation } from "./aiHistory";
import type { AiConfig, ServerProfile } from "./types";

export interface AppStorageSnapshot {
  servers: ServerProfile[];
  savedGroups: string[];
  aiConfig: Partial<AiConfig> | null;
  aiConversations: AiConversation[];
  collapsedGroups: string[];
}

const EMPTY_SNAPSHOT: AppStorageSnapshot = {
  servers: [],
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

export const loadAppStorage = () =>
  isTauri() ? invoke<AppStorageSnapshot>("load_app_state") : Promise.resolve(EMPTY_SNAPSHOT);

export const saveServers = (servers: ServerProfile[]) =>
  isTauri()
    ? invoke("save_servers", { servers: servers.map(stripServerSecrets) })
    : Promise.resolve();

export const saveServerGroups = (groups: string[]) =>
  isTauri() ? invoke("save_server_groups", { groups }) : Promise.resolve();

export const saveAiConfig = (config: Partial<AiConfig>) =>
  isTauri() ? invoke("save_ai_config", { config }) : Promise.resolve();

export const saveAiConversations = (conversations: AiConversation[]) =>
  isTauri() ? invoke("save_ai_conversations", { conversations }) : Promise.resolve();

export const saveCollapsedGroups = (groups: string[]) =>
  isTauri() ? invoke("save_collapsed_groups", { groups }) : Promise.resolve();
