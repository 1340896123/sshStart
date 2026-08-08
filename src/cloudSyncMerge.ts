import type { AiConversation } from "./aiHistory";
import type { AppStorageSnapshot } from "./storage";
import type { ServerProfile } from "./types";

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
  const deletedServerIds = mergeStringValues(
    localSnapshot.deletedServerIds ?? [],
    remoteSnapshot.deletedServerIds ?? [],
  );
  const deletedServers = new Set(deletedServerIds);
  return {
    servers: mergeServerProfiles(localSnapshot.servers, remoteSnapshot.servers)
      .filter((server) => !deletedServers.has(server.id)),
    deletedServerIds,
    savedGroups: mergeStringValues(localSnapshot.savedGroups, remoteSnapshot.savedGroups),
    aiConfig: localSnapshot.aiConfig ?? remoteSnapshot.aiConfig,
    aiConversations: mergeAiConversations(localSnapshot.aiConversations, remoteSnapshot.aiConversations),
    collapsedGroups: mergeStringValues(localSnapshot.collapsedGroups, remoteSnapshot.collapsedGroups),
  };
};

export const snapshotsEqual = (left: AppStorageSnapshot, right: AppStorageSnapshot) =>
  JSON.stringify(left) === JSON.stringify(right);
