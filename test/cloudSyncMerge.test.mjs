import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSyncMetadata,
  createSyncMetadata,
  markPendingSyncChange,
  mergeAiConversations,
  mergeAppStorageSnapshots,
  snapshotsEqual,
  stampUnversionedSnapshot,
} from "../src/cloudSyncMerge.ts";

const server = (id, name = id) => ({
  id,
  name,
  group: "",
  host: `${id}.example.com`,
  port: 22,
  username: "root",
  authType: "password",
  color: "#000000",
});

const snapshot = (servers, deviceId = "device", aiConfig = null, syncMeta) => ({
  servers,
  deletedServerIds: [],
  savedGroups: [],
  aiConfig,
  aiConversations: [],
  collapsedGroups: [],
  syncMeta: syncMeta ?? createSyncMetadata(deviceId),
});

const withChange = (value, change) => ({
  ...value,
  syncMeta: advanceSyncMetadata(value.syncMeta, change),
});

const withPendingChange = (value, change) => ({
  ...value,
  syncMeta: markPendingSyncChange(value.syncMeta, change),
});

test("merges disjoint server lists without dropping either device", () => {
  const localServers = Array.from({ length: 100 }, (_, index) => server(`local-${index}`));
  const remoteServers = Array.from({ length: 50 }, (_, index) => server(`remote-${index}`));

  const merged = mergeAppStorageSnapshots(snapshot(localServers), snapshot(remoteServers));

  assert.equal(merged.servers.length, 150);
  assert.deepEqual(merged.servers.slice(0, 50).map(({ id }) => id), remoteServers.map(({ id }) => id));
  assert.deepEqual(new Set(merged.servers.map(({ id }) => id)).size, 150);
});

test("uses the newest revision when the same server changes on two devices", () => {
  const local = withChange(snapshot([server("shared", "本机旧名称")], "local"), { serverIds: ["shared"] });
  let remote = withChange(snapshot([server("shared", "云端旧名称"), server("remote-only")], "remote"), { serverIds: ["shared", "remote-only"] });
  remote = { ...remote, servers: [server("shared", "云端新名称"), server("remote-only")] };
  remote = withChange(remote, { serverIds: ["shared"] });
  const merged = mergeAppStorageSnapshots(local, remote);

  assert.equal(merged.servers.length, 2);
  assert.equal(merged.servers[0].name, "云端新名称");
  assert.equal(merged.servers[1].id, "remote-only");
});

test("uses the newest AI conversation and produces a stable second merge", () => {
  const older = { id: "conversation", serverId: "server", serverName: "Server", title: "旧", messages: [], createdAt: 1, updatedAt: 2 };
  const newer = { ...older, title: "新", updatedAt: 3 };

  assert.equal(mergeAiConversations([newer], [older])[0].title, "新");

  const first = mergeAppStorageSnapshots(snapshot([server("local")]), snapshot([server("remote")]));
  const second = mergeAppStorageSnapshots(first, first);
  assert.equal(snapshotsEqual(first, second), true);
  assert.equal(snapshotsEqual(
    { ...first, syncMeta: { ...first.syncMeta, deviceId: "device-a" } },
    { ...first, syncMeta: { ...first.syncMeta, deviceId: "device-b" } },
  ), true);
});

test("keeps an explicit server deletion across devices", () => {
  let local = { ...snapshot([], "local"), deletedServerIds: ["deleted"] };
  local = withChange(local, { serverIds: ["deleted"], serverOrder: true });
  local = withChange(local, { serverIds: ["deleted"] });
  const remote = withChange(snapshot([server("deleted"), server("kept")], "remote"), { serverIds: ["deleted", "kept"] });

  const merged = mergeAppStorageSnapshots(local, remote);

  assert.deepEqual(merged.servers.map(({ id }) => id), ["kept"]);
  assert.deepEqual(merged.deletedServerIds, ["deleted"]);
});

test("syncs group deletion, collapsed state, server order, and settings by revision", () => {
  let local = snapshot([server("a"), server("b")], "local");
  local = {
    ...local,
    savedGroups: ["旧分组"],
    collapsedGroups: ["旧分组"],
    aiConfig: { model: "old-model" },
  };
  local = withChange(local, { serverIds: ["a", "b"], serverOrder: true, groups: true, collapsedGroups: true, aiConfig: true });

  let remote = stampUnversionedSnapshot(snapshot([server("b"), server("a")], "remote"));
  remote = {
    ...remote,
    savedGroups: [],
    collapsedGroups: [],
    aiConfig: { model: "new-model" },
  };
  remote = withChange(remote, { serverOrder: true, groups: true, collapsedGroups: true, aiConfig: true });

  const merged = mergeAppStorageSnapshots(local, remote);
  assert.deepEqual(merged.servers.map(({ id }) => id), ["b", "a"]);
  assert.deepEqual(merged.savedGroups, []);
  assert.deepEqual(merged.collapsedGroups, []);
  assert.equal(merged.aiConfig.model, "new-model");
});

test("a local settings edit wins over the cloud even with a stale local clock", () => {
  // Device B last synced when the cloud clock was 3; the cloud has since advanced
  // to 10 (another device edited). B edits settings locally before syncing again,
  // so its freshly stamped revision (4) would lose to the cloud (10) without the
  // pending marker.
  let baseMeta = createSyncMetadata("device-b");
  for (let i = 0; i < 3; i += 1) baseMeta = advanceSyncMetadata(baseMeta, { aiConfig: true });

  let local = snapshot([server("a")], "device-b", { model: "cloud-model" }, baseMeta);
  local = { ...local, aiConfig: { model: "local-model" } };
  local = withPendingChange(local, { aiConfig: true });

  let cloudMeta = baseMeta;
  for (let i = 3; i < 10; i += 1) cloudMeta = advanceSyncMetadata(cloudMeta, { aiConfig: true });
  const cloud = snapshot([server("a")], "device-a", { model: "other-model" }, cloudMeta);

  const merged = mergeAppStorageSnapshots(local, cloud);
  assert.equal(merged.aiConfig.model, "local-model");
  assert.equal(merged.syncMeta.aiConfigRevision.clock, 11, "revision bumps above the cloud clock");
  assert.equal(merged.syncMeta.pending.aiConfig, true, "pending marker survives until the cloud confirms");
});

test("a local server edit wins over the cloud with a stale clock and bumps its revision", () => {
  let baseMeta = createSyncMetadata("device-b");
  for (let i = 0; i < 3; i += 1) baseMeta = advanceSyncMetadata(baseMeta, { serverIds: ["a"] });

  let local = snapshot([server("a", "local-name")], "device-b", null, baseMeta);
  local = withPendingChange(local, { serverIds: ["a"] });

  let cloudMeta = baseMeta;
  for (let i = 3; i < 10; i += 1) cloudMeta = advanceSyncMetadata(cloudMeta, { serverIds: ["a"] });
  const cloud = snapshot([server("a", "cloud-name")], "device-a", null, cloudMeta);

  const merged = mergeAppStorageSnapshots(local, cloud);
  assert.equal(merged.servers[0].name, "local-name");
  assert.equal(merged.syncMeta.serverRevisions.a.clock, 11);
  assert.deepEqual(merged.syncMeta.pending.serverIds, ["a"]);
});

test("pending markers clear once the merged state matches the cloud", () => {
  let baseMeta = createSyncMetadata("device-b");
  for (let i = 0; i < 3; i += 1) baseMeta = advanceSyncMetadata(baseMeta, { aiConfig: true });

  let local = snapshot([server("a")], "device-b", { model: "same-model" }, baseMeta);
  local = withPendingChange(local, { aiConfig: true });

  const cloud = snapshot([server("a")], "device-a", { model: "same-model" }, baseMeta);

  const merged = mergeAppStorageSnapshots(local, cloud);
  assert.equal(merged.aiConfig.model, "same-model");
  assert.equal(merged.syncMeta.pending, undefined, "pending object is dropped when the cloud already matches");
  assert.equal(
    merged.syncMeta.aiConfigRevision.clock,
    local.syncMeta.aiConfigRevision.clock,
    "revision stays put when already confirmed",
  );
});

test("an equal-clock local edit beats the cloud instead of silently losing the tie", () => {
  // Both devices start from the same cloud state and edit settings at the same
  // logical clock. The local editor's change must survive its own sync.
  let baseMeta = createSyncMetadata("device-b");
  baseMeta = advanceSyncMetadata(baseMeta, { aiConfig: true });

  let local = snapshot([server("a")], "device-b", { model: "local-model" }, baseMeta);
  local = withPendingChange(local, { aiConfig: true });

  const cloud = snapshot([server("a")], "device-a", { model: "cloud-model" }, baseMeta);

  const merged = mergeAppStorageSnapshots(local, cloud);
  assert.equal(merged.aiConfig.model, "local-model");
  assert.equal(merged.syncMeta.aiConfigRevision.clock, baseMeta.clock + 1);
  assert.equal(merged.syncMeta.pending.aiConfig, true);
});
