import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSyncServer } from "../src/app.mjs";

const TEST_SECRET = "portico-sync-test-secret-that-is-long-enough";

async function startFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "portico-sync-"));
  const databasePath = join(directory, "sync.sqlite");
  const app = createSyncServer({
    databasePath,
    tokenSecret: TEST_SECRET,
    authRateLimit: 100,
    ...options,
  });
  await new Promise((resolvePromise) => app.server.listen(0, "127.0.0.1", resolvePromise));
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    databasePath,
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

const register = (baseUrl, email, password = "correct-horse-battery-staple") =>
  requestJson(baseUrl, "/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

test("health endpoint reports readiness", async (context) => {
  const fixture = await startFixture();
  context.after(() => fixture.close());
  const { response, body } = await requestJson(fixture.baseUrl, "/healthz");
  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: "ok" });
});

test("registration and login issue compatible bearer tokens", async (context) => {
  const fixture = await startFixture();
  context.after(() => fixture.close());

  const created = await register(fixture.baseUrl, "User@Example.com");
  assert.equal(created.response.status, 201);
  assert.equal(created.body.email, "user@example.com");
  assert.match(created.body.token, /^[^.]+\.[^.]+\.[^.]+$/);

  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  const storedUser = database.prepare("SELECT password_hash FROM users WHERE email = ?").get("user@example.com");
  database.close();
  assert.match(storedUser.password_hash, /^scrypt\$v1\$/);
  assert.doesNotMatch(storedUser.password_hash, /correct-horse-battery-staple/);

  const duplicate = await register(fixture.baseUrl, "user@example.com");
  assert.equal(duplicate.response.status, 409);

  const invalid = await requestJson(fixture.baseUrl, "/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "user@example.com", password: "wrong-password" }),
  });
  assert.equal(invalid.response.status, 401);

  const loggedIn = await requestJson(fixture.baseUrl, "/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "USER@example.com", password: "correct-horse-battery-staple" }),
  });
  assert.equal(loggedIn.response.status, 200);
  assert.equal(loggedIn.body.email, "user@example.com");
  assert.ok(loggedIn.body.token);
});

test("sync snapshots are opaque and isolated by account", async (context) => {
  const fixture = await startFixture();
  context.after(() => fixture.close());
  const first = await register(fixture.baseUrl, "first@example.com");
  const second = await register(fixture.baseUrl, "second@example.com");

  const empty = await requestJson(fixture.baseUrl, "/sync/data", {
    headers: { authorization: `Bearer ${first.body.token}` },
  });
  assert.equal(empty.response.status, 404);

  const ciphertext = "opaque-aes-256-gcm-envelope";
  const uploaded = await requestJson(fixture.baseUrl, "/sync/data", {
    method: "PUT",
    headers: { authorization: `Bearer ${first.body.token}` },
    body: JSON.stringify({ ciphertext, updatedAt: 1785945600 }),
  });
  assert.equal(uploaded.response.status, 204);

  const downloaded = await requestJson(fixture.baseUrl, "/sync/data", {
    headers: { authorization: `Bearer ${first.body.token}` },
  });
  assert.equal(downloaded.response.status, 200);
  assert.deepEqual(downloaded.body, { ciphertext, updatedAt: 1785945600 });

  const otherAccount = await requestJson(fixture.baseUrl, "/sync/data", {
    headers: { authorization: `Bearer ${second.body.token}` },
  });
  assert.equal(otherAccount.response.status, 404);
});

test("encrypted key backups are opaque and isolated by account", async (context) => {
  const fixture = await startFixture();
  context.after(() => fixture.close());
  const first = await register(fixture.baseUrl, "key-first@example.com");
  const second = await register(fixture.baseUrl, "key-second@example.com");

  const empty = await requestJson(fixture.baseUrl, "/sync/keys", {
    headers: { authorization: `Bearer ${first.body.token}` },
  });
  assert.equal(empty.response.status, 404);

  const ciphertext = "opaque-passphrase-encrypted-key-bundle";
  const uploaded = await requestJson(fixture.baseUrl, "/sync/keys", {
    method: "PUT",
    headers: { authorization: `Bearer ${first.body.token}` },
    body: JSON.stringify({ ciphertext, updatedAt: 1786032000 }),
  });
  assert.equal(uploaded.response.status, 204);

  const downloaded = await requestJson(fixture.baseUrl, "/sync/keys", {
    headers: { authorization: `Bearer ${first.body.token}` },
  });
  assert.equal(downloaded.response.status, 200);
  assert.deepEqual(downloaded.body, { ciphertext, updatedAt: 1786032000 });

  const otherAccount = await requestJson(fixture.baseUrl, "/sync/keys", {
    headers: { authorization: `Bearer ${second.body.token}` },
  });
  assert.equal(otherAccount.response.status, 404);
});

test("conditional writes reject stale application and key snapshots", async (context) => {
  const fixture = await startFixture();
  context.after(() => fixture.close());
  const registered = await register(fixture.baseUrl, "conflict@example.com");
  const headers = { authorization: `Bearer ${registered.body.token}` };

  for (const path of ["/sync/data", "/sync/keys"]) {
    const first = await requestJson(fixture.baseUrl, path, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ciphertext: `first-${path}`, updatedAt: 100, expectedUpdatedAt: null }),
    });
    assert.equal(first.response.status, 204);

    const stale = await requestJson(fixture.baseUrl, path, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ciphertext: `stale-${path}`, updatedAt: 101, expectedUpdatedAt: null }),
    });
    assert.equal(stale.response.status, 409);

    const current = await requestJson(fixture.baseUrl, path, { headers });
    const updated = await requestJson(fixture.baseUrl, path, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        ciphertext: `updated-${path}`,
        updatedAt: current.body.updatedAt,
        expectedUpdatedAt: current.body.updatedAt,
      }),
    });
    assert.equal(updated.response.status, 204);
  }
});

test("cloud data can be cleared by snapshot type or all at once", async (context) => {
  const fixture = await startFixture();
  context.after(() => fixture.close());
  const registered = await register(fixture.baseUrl, "clear@example.com");
  const headers = { authorization: `Bearer ${registered.body.token}` };

  for (const path of ["/sync/data", "/sync/keys"]) {
    const uploaded = await requestJson(fixture.baseUrl, path, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ciphertext: `opaque-${path}`, updatedAt: 1786118400 }),
    });
    assert.equal(uploaded.response.status, 204);
  }

  const clearedData = await requestJson(fixture.baseUrl, "/sync/data", { method: "DELETE", headers });
  assert.equal(clearedData.response.status, 204);
  assert.equal((await requestJson(fixture.baseUrl, "/sync/data", { headers })).response.status, 404);
  assert.equal((await requestJson(fixture.baseUrl, "/sync/keys", { headers })).response.status, 200);

  const clearedKeys = await requestJson(fixture.baseUrl, "/sync/keys", { method: "DELETE", headers });
  assert.equal(clearedKeys.response.status, 204);
  assert.equal((await requestJson(fixture.baseUrl, "/sync/keys", { headers })).response.status, 404);

  for (const path of ["/sync/data", "/sync/keys"]) {
    await requestJson(fixture.baseUrl, path, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ciphertext: `opaque-restored-${path}`, updatedAt: 1786118401 }),
    });
  }
  const clearedAll = await requestJson(fixture.baseUrl, "/sync", { method: "DELETE", headers });
  assert.equal(clearedAll.response.status, 204);
  assert.equal((await requestJson(fixture.baseUrl, "/sync/data", { headers })).response.status, 404);
  assert.equal((await requestJson(fixture.baseUrl, "/sync/keys", { headers })).response.status, 404);

  const repeated = await requestJson(fixture.baseUrl, "/sync", { method: "DELETE", headers });
  assert.equal(repeated.response.status, 204);
});

test("sync routes reject missing authentication and invalid payloads", async (context) => {
  const fixture = await startFixture();
  context.after(() => fixture.close());

  const unauthorized = await requestJson(fixture.baseUrl, "/sync/data");
  assert.equal(unauthorized.response.status, 401);
  const unauthorizedKeys = await requestJson(fixture.baseUrl, "/sync/keys");
  assert.equal(unauthorizedKeys.response.status, 401);
  const unauthorizedDelete = await requestJson(fixture.baseUrl, "/sync", { method: "DELETE" });
  assert.equal(unauthorizedDelete.response.status, 401);

  const registered = await register(fixture.baseUrl, "payload@example.com");
  const invalidPayload = await requestJson(fixture.baseUrl, "/sync/data", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.body.token}` },
    body: JSON.stringify({ ciphertext: "", updatedAt: "yesterday" }),
  });
  assert.equal(invalidPayload.response.status, 400);

  const invalidKeyPayload = await requestJson(fixture.baseUrl, "/sync/keys", {
    method: "PUT",
    headers: { authorization: `Bearer ${registered.body.token}` },
    body: JSON.stringify({ ciphertext: "", updatedAt: "yesterday" }),
  });
  assert.equal(invalidKeyPayload.response.status, 400);
});

test("expired bearer tokens are rejected", async (context) => {
  let currentTime = Date.UTC(2026, 7, 6);
  const fixture = await startFixture({
    tokenTtlSeconds: 1,
    now: () => currentTime,
  });
  context.after(() => fixture.close());

  const registered = await register(fixture.baseUrl, "expired@example.com");
  currentTime += 2000;
  const expired = await requestJson(fixture.baseUrl, "/sync/data", {
    headers: { authorization: `Bearer ${registered.body.token}` },
  });
  assert.equal(expired.response.status, 401);
});
