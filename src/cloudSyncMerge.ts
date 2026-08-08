import type { AiConversation } from "./aiHistory";
import type { AppStorageSnapshot, CloudSyncMetadata, SyncRevision } from "./storage";
import type { ServerProfile } from "./types";

export interface SyncMetadataChange {
  serverIds?: Iterable<string>;
  serverOrder?: boolean;
  groups?: boolean;
  aiConfig?: boolean;
  collapsedGroups?: boolean;
}

const newDeviceId = () => globalThis.crypto?.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const createSyncMetadata = (deviceId = newDeviceId()): CloudSyncMetadata => ({
  version: 2,
  deviceId,
  clock: 0,
  serverRevisions: {},
});

export const normalizeSyncMetadata = (
  metadata?: CloudSyncMetadata,
  fallbackDeviceId = "legacy-device",
): CloudSyncMetadata => {
  const deviceId = metadata?.deviceId?.trim() || fallbackDeviceId;
  return {
    version: 2,
    deviceId,
    clock: Number.isSafeInteger(metadata?.clock) && (metadata?.clock ?? 0) >= 0 ? metadata!.clock : 0,
    serverRevisions: { ...(metadata?.serverRevisions ?? {}) },
    serverOrderRevision: metadata?.serverOrderRevision,
    groupsRevision: metadata?.groupsRevision,
    aiConfigRevision: metadata?.aiConfigRevision,
    collapsedGroupsRevision: metadata?.collapsedGroupsRevision,
  };
};

const revisionCompare = (left?: SyncRevision, right?: SyncRevision) => {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left.clock - right.clock || left.deviceId.localeCompare(right.deviceId);
};

const newerRevision = (left?: SyncRevision, right?: SyncRevision) =>
  revisionCompare(left, right) >= 0 ? left : right;

const metadataClock = (metadata: CloudSyncMetadata) => Math.max(
  metadata.clock,
  metadata.serverOrderRevision?.clock ?? 0,
  metadata.groupsRevision?.clock ?? 0,
  metadata.aiConfigRevision?.clock ?? 0,
  metadata.collapsedGroupsRevision?.clock ?? 0,
  ...Object.values(metadata.serverRevisions).map((revision) => revision.clock),
);

export const advanceSyncMetadata = (
  metadata: CloudSyncMetadata,
  change: SyncMetadataChange,
): CloudSyncMetadata => {
  const current = normalizeSyncMetadata(metadata, metadata.deviceId);
  const revision = { clock: metadataClock(current) + 1, deviceId: current.deviceId };
  const serverRevisions = { ...current.serverRevisions };
  for (const serverId of change.serverIds ?? []) serverRevisions[serverId] = revision;
  return {
    ...current,
    clock: revision.clock,
    serverRevisions,
    serverOrderRevision: change.serverOrder ? revision : current.serverOrderRevision,
    groupsRevision: change.groups ? revision : current.groupsRevision,
    aiConfigRevision: change.aiConfig ? revision : current.aiConfigRevision,
    collapsedGroupsRevision: change.collapsedGroups ? revision : current.collapsedGroupsRevision,
  };
};

const mergeMetadata = (local?: CloudSyncMetadata, remote?: CloudSyncMetadata) => {
  const localMeta = normalizeSyncMetadata(local, local?.deviceId || "legacy-local");
  const remoteMeta = normalizeSyncMetadata(remote, remote?.deviceId || "legacy-remote");
  const serverRevisions = { ...remoteMeta.serverRevisions };
  for (const [serverId, revision] of Object.entries(localMeta.serverRevisions)) {
    serverRevisions[serverId] = newerRevision(revision, serverRevisions[serverId]) ?? revision;
  }
  return {
    version: 2 as const,
    deviceId: localMeta.deviceId,
    clock: Math.max(metadataClock(localMeta), metadataClock(remoteMeta)),
    serverRevisions,
    serverOrderRevision: newerRevision(localMeta.serverOrderRevision, remoteMeta.serverOrderRevision),
    groupsRevision: newerRevision(localMeta.groupsRevision, remoteMeta.groupsRevision),
    aiConfigRevision: newerRevision(localMeta.aiConfigRevision, remoteMeta.aiConfigRevision),
    collapsedGroupsRevision: newerRevision(localMeta.collapsedGroupsRevision, remoteMeta.collapsedGroupsRevision),
  } satisfies CloudSyncMetadata;
};

const mergeById = <T extends { id: string }>(
  localItems: T[],
  remoteItems: T[],
  resolveConflict: (localItem: T, remoteItem: T) => T,
) => {
  const localById = new Map(localItems.map((item) => [item.id, item]));
  const merged = remoteItems.map((remoteItem) => {
    const localItem = localById.get(remoteItem.id);
    if (!localItem) return remoteItem;
    localById.delete(remoteItem.id);
    return resolveConflict(localItem, remoteItem);
  });
  return [...merged, ...localById.values()];
};

export const mergeServerProfiles = (localServers: ServerProfile[], remoteServers: ServerProfile[]) =>
  mergeById(localServers, remoteServers, (localServer) => localServer);

export const mergeStringValues = (localValues: string[], remoteValues: string[]) =>
  [...new Set([...remoteValues, ...localValues])];

export const mergeAiConversations = (
  localConversations: AiConversation[],
  remoteConversations: AiConversation[],
) => mergeById(localConversations, remoteConversations, (localConversation, remoteConversation) =>
  localConversation.updatedAt >= remoteConversation.updatedAt ? localConversation : remoteConversation)
  .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));

export const mergeAppStorageSnapshots = (
  localSnapshot: AppStorageSnapshot,
  remoteSnapshot: AppStorageSnapshot | null,
): AppStorageSnapshot => {
  if (!remoteSnapshot) return localSnapshot;
  const localMeta = normalizeSyncMetadata(localSnapshot.syncMeta, localSnapshot.syncMeta?.deviceId || "legacy-local");
  const remoteMeta = normalizeSyncMetadata(remoteSnapshot.syncMeta, remoteSnapshot.syncMeta?.deviceId || "legacy-remote");
  const localServers = new Map(localSnapshot.servers.map((server) => [server.id, server]));
  const remoteServers = new Map(remoteSnapshot.servers.map((server) => [server.id, server]));
  const localDeleted = new Set(localSnapshot.deletedServerIds ?? []);
  const remoteDeleted = new Set(remoteSnapshot.deletedServerIds ?? []);
  const allServerIds = new Set([
    ...localServers.keys(),
    ...remoteServers.keys(),
    ...localDeleted,
    ...remoteDeleted,
  ]);
  const selectedServers = new Map<string, ServerProfile>();
  const deletedServerIds: string[] = [];
  for (const serverId of allServerIds) {
    const localHasState = localServers.has(serverId) || localDeleted.has(serverId);
    const remoteHasState = remoteServers.has(serverId) || remoteDeleted.has(serverId);
    const comparison = revisionCompare(localMeta.serverRevisions[serverId], remoteMeta.serverRevisions[serverId]);
    const useLocal = localHasState && (!remoteHasState || comparison > 0);
    const selectedServer = useLocal ? localServers.get(serverId) : remoteServers.get(serverId);
    const selectedDeleted = useLocal ? localDeleted.has(serverId) : remoteDeleted.has(serverId);
    if (selectedDeleted || !selectedServer) deletedServerIds.push(serverId);
    else selectedServers.set(serverId, selectedServer);
  }
  const localOrderWins = revisionCompare(localMeta.serverOrderRevision, remoteMeta.serverOrderRevision) > 0;
  const preferredOrder = localOrderWins ? localSnapshot.servers : remoteSnapshot.servers;
  const secondaryOrder = localOrderWins ? remoteSnapshot.servers : localSnapshot.servers;
  const orderedServerIds = [...preferredOrder, ...secondaryOrder].map((server) => server.id);
  const servers = [...new Set(orderedServerIds)]
    .map((serverId) => selectedServers.get(serverId))
    .filter((server): server is ServerProfile => Boolean(server));
  const selectCategory = <T,>(
    localValue: T,
    remoteValue: T,
    localRevision?: SyncRevision,
    remoteRevision?: SyncRevision,
    legacyMerge?: (local: T, remote: T) => T,
  ) => {
    if (!localRevision && !remoteRevision && legacyMerge) return legacyMerge(localValue, remoteValue);
    return revisionCompare(localRevision, remoteRevision) > 0 ? localValue : remoteValue;
  };
  return {
    servers,
    deletedServerIds,
    savedGroups: selectCategory(
      localSnapshot.savedGroups,
      remoteSnapshot.savedGroups,
      localMeta.groupsRevision,
      remoteMeta.groupsRevision,
      mergeStringValues,
    ),
    aiConfig: selectCategory(
      localSnapshot.aiConfig,
      remoteSnapshot.aiConfig,
      localMeta.aiConfigRevision,
      remoteMeta.aiConfigRevision,
      (local, remote) => remote ?? local,
    ),
    aiConversations: mergeAiConversations(localSnapshot.aiConversations, remoteSnapshot.aiConversations),
    collapsedGroups: selectCategory(
      localSnapshot.collapsedGroups,
      remoteSnapshot.collapsedGroups,
      localMeta.collapsedGroupsRevision,
      remoteMeta.collapsedGroupsRevision,
      mergeStringValues,
    ),
    syncMeta: mergeMetadata(localSnapshot.syncMeta, remoteSnapshot.syncMeta),
  };
};

export const stampUnversionedSnapshot = (snapshot: AppStorageSnapshot): AppStorageSnapshot => {
  let metadata = snapshot.syncMeta
    ? normalizeSyncMetadata(snapshot.syncMeta, snapshot.syncMeta.deviceId)
    : createSyncMetadata();
  const serverIds = [
    ...snapshot.servers.map((server) => server.id),
    ...(snapshot.deletedServerIds ?? []),
  ].filter((serverId) => !metadata.serverRevisions[serverId]);
  if (serverIds.length > 0) metadata = advanceSyncMetadata(metadata, { serverIds });
  if (!metadata.serverOrderRevision) metadata = advanceSyncMetadata(metadata, { serverOrder: true });
  if (!metadata.groupsRevision) metadata = advanceSyncMetadata(metadata, { groups: true });
  if (snapshot.aiConfig && !metadata.aiConfigRevision) metadata = advanceSyncMetadata(metadata, { aiConfig: true });
  if (!metadata.collapsedGroupsRevision) metadata = advanceSyncMetadata(metadata, { collapsedGroups: true });
  return { ...snapshot, syncMeta: metadata };
};

const comparableSnapshot = (snapshot: AppStorageSnapshot) => ({
  ...snapshot,
  syncMeta: snapshot.syncMeta ? { ...snapshot.syncMeta, deviceId: "" } : undefined,
});

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const snapshotsEqual = (left: AppStorageSnapshot, right: AppStorageSnapshot) =>
  stableJson(comparableSnapshot(left)) === stableJson(comparableSnapshot(right));
