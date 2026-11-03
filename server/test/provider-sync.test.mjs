import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSyncServer } from "../src/app.mjs";

const TEST_SECRET = "sshstar-provider-sync-test-signing-secret";

// Match the desktop's AES-256-GCM envelope. Only the test client knows this key.
function encryptSnapshot(snapshot, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ version: 1, algorithm: "AES-256-GCM", nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") });
}

function decryptSnapshot(raw, key) {
  const envelope = JSON.parse(raw);
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAuthTag(ciphertext.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString("utf8"));
}

async function startFixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "sshstar-provider-sync-"));
  const databasePath = join(directory, "sync.sqlite");
  let app;
  const fixture = {
    databasePath,
    baseUrl: "",
    async restart() {
      if (app) await app.close();
      app = createSyncServer({ databasePath, tokenSecret: TEST_SECRET });
      await new Promise((resolvePromise) => app.server.listen(0, "127.0.0.1", resolvePromise));
      fixture.baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    },
  };
  context.after(async () => {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  await fixture.restart();
  return fixture;
}

async function requestJson(fixture, path, { token, body, method = "GET" } = {}) {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("encrypted provider trees preserve every model, selection, key and extension across upgrades and restarts", async (context) => {
  const fixture = await startFixture(context);
  const registration = await requestJson(fixture, "/auth/register", {
    method: "POST", body: { email: "providers@example.com", password: "provider-sync-test-password" },
  });
  assert.equal(registration.response.status, 201);
  const token = registration.body.token;
  const key = randomBytes(32);
  const legacy = { aiConfig: { endpoint: "https://legacy.example/v1", apiKey: "legacy-test-key", model: "shared-model", reasoningEffort: "high" } };
  const legacyCiphertext = encryptSnapshot(legacy, key);

  // Older clients omit expectedUpdatedAt and do not have a providers array.
  const uploadedLegacy = await requestJson(fixture, "/sync/data", {
    method: "PUT", token, body: { ciphertext: legacyCiphertext, updatedAt: 100 },
  });
  assert.equal(uploadedLegacy.response.status, 204);
  const downloadedLegacy = await requestJson(fixture, "/sync/data", { token });
  assert.deepEqual(downloadedLegacy.body, { ciphertext: legacyCiphertext, updatedAt: 100 });
  assert.deepEqual(decryptSnapshot(downloadedLegacy.body.ciphertext, key), legacy);

  const snapshot = {
    servers: [], deletedServerIds: [], savedGroups: [], aiConversations: [], collapsedGroups: [],
    aiConfig: {
      selectedProviderId: "provider-two", apiMode: "responses", endpoint: "https://second.example/v1", model: "shared-model", reasoningEffort: "xhigh",
      providers: [
        { id: "provider-one", name: "第一个提供商", apiMode: "chat-completions", endpoint: "https://first.example/v1", apiKey: "test-provider-one-key", selectedModelId: "fast-model",
          models: [
            { id: "shared-model", reasoningEfforts: ["auto", "none", "low"], defaultReasoningEffort: "none", reasoningEffort: "low" },
            { id: "fast-model", reasoningEfforts: ["auto"], defaultReasoningEffort: "auto", reasoningEffort: "auto" },
          ], futureProviderOption: { enabled: true } },
        { id: "provider-two", name: "Second provider", apiMode: "responses", endpoint: "https://second.example/v1", apiKey: "test-provider-two-key", selectedModelId: "shared-model",
          models: [{ id: "shared-model", reasoningEfforts: ["auto", "high", "xhigh"], defaultReasoningEffort: "high", reasoningEffort: "xhigh", futureReasoningOption: { budgetTokens: 8192 } }] },
      ], futureConfigOption: ["preserve", "unknown", "fields"],
    },
    syncMeta: { deviceId: "test-device", clock: 2, aiConfigRevision: { clock: 2, deviceId: "test-device" } },
    futureSnapshotOption: { keep: true },
  };
  const ciphertext = encryptSnapshot(snapshot, key);
  const uploaded = await requestJson(fixture, "/sync/data", {
    method: "PUT", token, body: { ciphertext, updatedAt: 101, expectedUpdatedAt: 100 },
  });
  assert.equal(uploaded.response.status, 204);
  const downloaded = await requestJson(fixture, "/sync/data", { token });
  assert.deepEqual(downloaded.body, { ciphertext, updatedAt: 101 });
  assert.deepEqual(decryptSnapshot(downloaded.body.ciphertext, key), snapshot);

  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    const stored = database.prepare("SELECT ciphertext FROM sync_snapshots").get();
    assert.equal(stored.ciphertext, ciphertext);
    for (const plaintext of ["test-provider-one-key", "test-provider-two-key", "第一个提供商", "shared-model"]) {
      assert.equal(stored.ciphertext.includes(plaintext), false);
    }
  } finally {
    database.close();
  }

  // A device still based on the older snapshot must not replace the newer tree.
  const stale = await requestJson(fixture, "/sync/data", {
    method: "PUT", token, body: { ciphertext: legacyCiphertext, updatedAt: 102, expectedUpdatedAt: 100 },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.response.headers.get("x-sshstar-current-version"), "101");

  await fixture.restart();
  const restored = await requestJson(fixture, "/sync/data", { token });
  assert.equal(restored.response.status, 200);
  assert.deepEqual(restored.body, downloaded.body);
  assert.deepEqual(decryptSnapshot(restored.body.ciphertext, key), snapshot);
});
