import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeAiConversations,
  mergeAppStorageSnapshots,
  mergeServerProfiles,
  snapshotsEqual,
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

const snapshot = (servers) => ({
  servers,
  deletedServerIds: [],
  savedGroups: [],
  aiConfig: null,
  aiConversations: [],
  collapsedGroups: [],
});

test("merges disjoint server lists without dropping either device", () => {
  const localServers = Array.from({ length: 100 }, (_, index) => server(`local-${index}`));
  const remoteServers = Array.from({ length: 50 }, (_, index) => server(`remote-${index}`));

  const merged = mergeAppStorageSnapshots(snapshot(localServers), snapshot(remoteServers));

  assert.equal(merged.servers.length, 150);
  assert.deepEqual(merged.servers.slice(0, 50).map(({ id }) => id), remoteServers.map(({ id }) => id));
  assert.deepEqual(new Set(merged.servers.map(({ id }) => id)).size, 150);
});

test("keeps the local version when the same server id exists on both devices", () => {
  const merged = mergeServerProfiles(
    [server("shared", "本机名称")],
    [server("shared", "云端名称"), server("remote-only")],
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, "本机名称");
  assert.equal(merged[1].id, "remote-only");
});

test("uses the newest AI conversation and produces a stable second merge", () => {
  const older = { id: "conversation", serverId: "server", serverName: "Server", title: "旧", messages: [], createdAt: 1, updatedAt: 2 };
  const newer = { ...older, title: "新", updatedAt: 3 };

  assert.equal(mergeAiConversations([newer], [older])[0].title, "新");

  const first = mergeAppStorageSnapshots(snapshot([server("local")]), snapshot([server("remote")]));
  const second = mergeAppStorageSnapshots(first, first);
  assert.equal(snapshotsEqual(first, second), true);
});

test("keeps an explicit server deletion across devices", () => {
  const local = { ...snapshot([]), deletedServerIds: ["deleted"] };
  const remote = snapshot([server("deleted"), server("kept")]);

  const merged = mergeAppStorageSnapshots(local, remote);

  assert.deepEqual(merged.servers.map(({ id }) => id), ["kept"]);
  assert.deepEqual(merged.deletedServerIds, ["deleted"]);
});
