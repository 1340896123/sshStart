import type { AiConversation } from "./aiHistory";
import type { AppStorageSnapshot, CloudSyncMetadata, SyncPendingState, SyncRevision } from "./storage";
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

const normalizePending = (pending?: SyncPendingState): SyncPendingState | undefined => {
  const serverIds = [...new Set((pending?.serverIds ?? []).filter(Boolean))];
  const hasPending = serverIds.length > 0
    || Boolean(pending?.serverOrder)
    || Boolean(pending?.groups)
    || Boolean(pending?.aiConfig)
    || Boolean(pending?.collapsedGroups);
  if (!hasPending) return undefined;
  return {
    serverIds,
    serverOrder: Boolean(pending?.serverOrder),
    groups: Boolean(pending?.groups),
    aiConfig: Boolean(pending?.aiConfig),
    collapsedGroups: Boolean(pending?.collapsedGroups),
  };
};

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
    pending: normalizePending(metadata?.pending),
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

/** Records a user edit: advances revisions AND marks the categories as pending local changes. */
export const markPendingSyncChange = (
  metadata: CloudSyncMetadata,
  change: SyncMetadataChange,
): CloudSyncMetadata => {
  const next = advanceSyncMetadata(metadata, change);
  const pending = next.pending ?? {};
  return {
    ...next,
    pending: normalizePending({
      serverIds: [...new Set([...(pending.serverIds ?? []), ...(change.serverIds ?? [])])],
      serverOrder: Boolean(pending.serverOrder || change.serverOrder),
      groups: Boolean(pending.groups || change.groups),
      aiConfig: Boolean(pending.aiConfig || change.aiConfig),
      collapsedGroups: Boolean(pending.collapsedGroups || change.collapsedGroups),
    }),
  };
};

/** Drops pending markers once local changes have been confirmed on the cloud. */
export const clearSyncPending = (metadata?: CloudSyncMetadata): CloudSyncMetadata | undefined => {
  if (!metadata?.pending) return metadata;
  const { pending: _pending, ...rest } = metadata;
  return rest;
};

const mergeMetadata = (
  local?: CloudSyncMetadata,
  remote?: CloudSyncMetadata,
  overrides?: {
    serverRevisions?: Record<string, SyncRevision>;
    serverOrderRevision?: SyncRevision;
    groupsRevision?: SyncRevision;
    aiConfigRevision?: SyncRevision;
    collapsedGroupsRevision?: SyncRevision;
    pending?: SyncPendingState;
  },
) => {
  const localMeta = normalizeSyncMetadata(local, local?.deviceId || "legacy-local");
  const remoteMeta = normalizeSyncMetadata(remote, remote?.deviceId || "legacy-remote");
  const serverRevisions = { ...remoteMeta.serverRevisions };
  for (const [serverId, revision] of Object.entries(localMeta.serverRevisions)) {
    serverRevisions[serverId] = newerRevision(revision, serverRevisions[serverId]) ?? revision;
  }
  const overrideValue = <T>(key: keyof NonNullable<typeof overrides>, fallback: T): T =>
    overrides && Object.prototype.hasOwnProperty.call(overrides, key) ? (overrides[key] as T) : fallback;
  const merged = {
    version: 2 as const,
    deviceId: localMeta.deviceId,
    clock: Math.max(metadataClock(localMeta), metadataClock(remoteMeta)),
    serverRevisions: overrideValue("serverRevisions", serverRevisions),
    serverOrderRevision: overrideValue("serverOrderRevision",
      newerRevision(localMeta.serverOrderRevision, remoteMeta.serverOrderRevision)),
    groupsRevision: overrideValue("groupsRevision",
      newerRevision(localMeta.groupsRevision, remoteMeta.groupsRevision)),
    aiConfigRevision: overrideValue("aiConfigRevision",
      newerRevision(localMeta.aiConfigRevision, remoteMeta.aiConfigRevision)),
    collapsedGroupsRevision: overrideValue("collapsedGroupsRevision",
      newerRevision(localMeta.collapsedGroupsRevision, remoteMeta.collapsedGroupsRevision)),
    pending: overrideValue("pending",
      normalizePending({ ...(localMeta.pending ?? {}), ...(remoteMeta.pending ?? {}) })),
  };
  return { ...merged, clock: metadataClock(merged) } satisfies CloudSyncMetadata;
};

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

const comparableSnapshot = (snapshot: AppStorageSnapshot) => ({
  ...snapshot,
  syncMeta: snapshot.syncMeta ? { ...snapshot.syncMeta, deviceId: "" } : undefined,
});

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

const stableValuesEqual = (left: unknown, right: unknown) => stableJson(left) === stableJson(right);

export const mergeAppStorageSnapshots = (
  localSnapshot: AppStorageSnapshot,
  remoteSnapshot: AppStorageSnapshot | null,
): AppStorageSnapshot => {
  if (!remoteSnapshot) return localSnapshot;
  const localMeta = normalizeSyncMetadata(localSnapshot.syncMeta, localSnapshot.syncMeta?.deviceId || "legacy-local");
  const remoteMeta = normalizeSyncMetadata(remoteSnapshot.syncMeta, remoteSnapshot.syncMeta?.deviceId || "legacy-remote");
  const localPending = localMeta.pending ?? {};
  const pendingServerIds = new Set(localPending.serverIds ?? []);
  const bumpRevision = (localRevision?: SyncRevision, remoteRevision?: SyncRevision) => {
    if (remoteRevision && revisionCompare(localRevision, remoteRevision) <= 0) {
      return {
        clock: Math.max(metadataClock(localMeta), metadataClock(remoteMeta)) + 1,
        deviceId: localMeta.deviceId,
      };
    }
    return localRevision;
  };
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
  const mergedServerRevisions: Record<string, SyncRevision> = { ...remoteMeta.serverRevisions };
  const selectedServers = new Map<string, ServerProfile>();
  const deletedServerIds: string[] = [];
  const remainingPendingServerIds: string[] = [];
  for (const serverId of allServerIds) {
    const localHasState = localServers.has(serverId) || localDeleted.has(serverId);
    const remoteHasState = remoteServers.has(serverId) || remoteDeleted.has(serverId);
    const localPendingEdit = pendingServerIds.has(serverId);
    const localRevision = localMeta.serverRevisions[serverId];
    const remoteRevision = remoteMeta.serverRevisions[serverId];
    const comparison = revisionCompare(localRevision, remoteRevision);
    const useLocal = localPendingEdit
      ? localHasState
      : localHasState && (!remoteHasState || comparison > 0);
    const selectedServer = useLocal ? localServers.get(serverId) : remoteServers.get(serverId);
    const selectedDeleted = useLocal ? localDeleted.has(serverId) : remoteDeleted.has(serverId);
    if (localHasState && remoteHasState) {
      const mergedRevision = localPendingEdit
        ? bumpRevision(localRevision, remoteRevision)
        : newerRevision(localRevision, remoteRevision);
      if (mergedRevision) mergedServerRevisions[serverId] = mergedRevision;
    } else if (localHasState && localRevision) {
      mergedServerRevisions[serverId] = localRevision;
    }
    if (selectedDeleted || !selectedServer) deletedServerIds.push(serverId);
    else selectedServers.set(serverId, selectedServer);
    if (localPendingEdit && localHasState) {
      const remoteSelected = remoteHasState
        ? (remoteDeleted.has(serverId) ? undefined : remoteServers.get(serverId))
        : undefined;
      const localSelected = localDeleted.has(serverId) ? undefined : localServers.get(serverId);
      if (localSelected !== remoteSelected || (localSelected && !stableValuesEqual(localSelected, remoteSelected))) {
        remainingPendingServerIds.push(serverId);
      }
    }
  }
  const localOrderWins = Boolean(localPending.serverOrder)
    || revisionCompare(localMeta.serverOrderRevision, remoteMeta.serverOrderRevision) > 0;
  const preferredOrder = localOrderWins ? localSnapshot.servers : remoteSnapshot.servers;
  const secondaryOrder = localOrderWins ? remoteSnapshot.servers : localSnapshot.servers;
  const orderedServerIds = [...preferredOrder, ...secondaryOrder].map((server) => server.id);
  const servers = [...new Set(orderedServerIds)]
    .map((serverId) => selectedServers.get(serverId))
    .filter((server): server is ServerProfile => Boolean(server));
  const mergedServerOrderRevision = localOrderWins
    ? bumpRevision(localMeta.serverOrderRevision, remoteMeta.serverOrderRevision)
    : newerRevision(localMeta.serverOrderRevision, remoteMeta.serverOrderRevision) ?? localMeta.serverOrderRevision;
  const selectCategory = <T,>(
    key: keyof SyncPendingState,
    localValue: T,
    remoteValue: T,
    localRevision?: SyncRevision,
    remoteRevision?: SyncRevision,
    legacyMerge?: (local: T, remote: T) => T,
  ) => {
    const pending = Boolean(localPending[key]);
    if (pending) {
      const confirmed = stableValuesEqual(localValue, remoteValue);
      return {
        value: localValue,
        revision: confirmed
          ? (newerRevision(localRevision, remoteRevision) ?? localRevision)
          : bumpRevision(localRevision, remoteRevision),
        pending: !confirmed,
      };
    }
    if (!localRevision && !remoteRevision && legacyMerge) {
      return { value: legacyMerge(localValue, remoteValue), revision: localRevision ?? remoteRevision, pending: false };
    }
    const localWins = revisionCompare(localRevision, remoteRevision) > 0;
    return localWins
      ? { value: localValue, revision: localRevision ?? remoteRevision, pending: false }
      : { value: remoteValue, revision: remoteRevision ?? localRevision, pending: false };
  };
  const groups = selectCategory("groups", localSnapshot.savedGroups, remoteSnapshot.savedGroups, localMeta.groupsRevision, remoteMeta.groupsRevision, mergeStringValues);
  const aiConfig = selectCategory("aiConfig", localSnapshot.aiConfig, remoteSnapshot.aiConfig, localMeta.aiConfigRevision, remoteMeta.aiConfigRevision, (local, remote) => remote ?? local);
  const collapsedGroups = selectCategory("collapsedGroups", localSnapshot.collapsedGroups, remoteSnapshot.collapsedGroups, localMeta.collapsedGroupsRevision, remoteMeta.collapsedGroupsRevision, mergeStringValues);
  const mergedPending = normalizePending({
    serverIds: remainingPendingServerIds,
    serverOrder: Boolean(localPending.serverOrder)
      && !stableValuesEqual(
        localSnapshot.servers.map((server) => server.id),
        remoteSnapshot.servers.map((server) => server.id),
      ),
    groups: groups.pending,
    aiConfig: aiConfig.pending,
    collapsedGroups: collapsedGroups.pending,
  });
  return {
    servers,
    deletedServerIds,
    savedGroups: groups.value,
    aiConfig: aiConfig.value,
    aiConversations: mergeAiConversations(localSnapshot.aiConversations, remoteSnapshot.aiConversations),
    collapsedGroups: collapsedGroups.value,
    syncMeta: mergeMetadata(localSnapshot.syncMeta, remoteSnapshot.syncMeta, {
      serverRevisions: mergedServerRevisions,
      serverOrderRevision: mergedServerOrderRevision,
      groupsRevision: groups.revision,
      aiConfigRevision: aiConfig.revision,
      collapsedGroupsRevision: collapsedGroups.revision,
      pending: mergedPending,
    }),
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

export const snapshotsEqual = (left: AppStorageSnapshot, right: AppStorageSnapshot) =>
  stableJson(comparableSnapshot(left)) === stableJson(comparableSnapshot(right));
