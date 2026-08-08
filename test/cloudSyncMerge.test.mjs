import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSyncMetadata,
  createSyncMetadata,
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

const snapshot = (servers, deviceId = "device") => ({
  servers,
  deletedServerIds: [],
  savedGroups: [],
  aiConfig: null,
  aiConversations: [],
  collapsedGroups: [],
  syncMeta: createSyncMetadata(deviceId),
});

const withChange = (value, change) => ({
  ...value,
  syncMeta: advanceSyncMetadata(value.syncMeta, change),
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
