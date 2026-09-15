import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";
import React from "react";
import renderer, { act } from "react-test-renderer";

const sourceRoot = new URL("../src/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

let invokeHandler;
globalThis.window = { __TAURI_INTERNALS__: {} };
mock.module("@tauri-apps/api/core", { exports: { invoke: (...args) => invokeHandler(...args) } });
const { useCloudSyncStatus } = await import("../src/useCloudSyncStatus.ts");
const serverA = "https://a.example.com";
const serverB = "https://b.example.com";
const signedIn = (email) => ({ authenticated: true, email, keyPath: "cloud.key" });
const signedOut = { authenticated: false, keyPath: "cloud.key" };

async function setup(t, endpoint = serverA) {
  const requests = [];
  let current, root;
  invokeHandler = (command, args) => {
    assert.equal(command, "sync_status");
    return new Promise((resolve, reject) => requests.push({ endpoint: args.endpoint, resolve, reject }));
  };
  function Harness(props) {
    current = useCloudSyncStatus(props.endpoint, props.activity);
    return null;
  }
  await act(async () => { root = renderer.create(React.createElement(Harness, { endpoint })); });
  t.after(async () => { await act(async () => root.unmount()); });
  return {
    requests,
    current: () => current,
    update: (endpoint, activity) => act(async () => root.update(React.createElement(Harness, { endpoint, activity }))),
    resolve: (index, status) => act(async () => requests[index].resolve(status)),
  };
}

test("changing the server immediately hides the previous login and requests the new server's status", async (t) => {
  const h = await setup(t);
  await h.resolve(0, signedIn("a@example.com"));
  assert.equal(h.current().syncStatus.authenticated, true);
  await h.update(serverB);
  assert.equal(h.current().syncStatus, undefined);
  assert.deepEqual(h.requests.map(({ endpoint }) => endpoint), [serverA, serverB]);
  await h.resolve(1, signedOut);
  assert.equal(h.current().syncStatus.authenticated, false);
});

test("a slow response from the old server cannot replace the new server's login", async (t) => {
  const h = await setup(t);
  await h.update(serverB);
  await h.resolve(1, signedIn("b@example.com"));
  await h.resolve(0, signedIn("a@example.com"));
  assert.equal(h.current().syncStatus.email, "b@example.com");
});

test("a 401 sync failure refreshes status so the login form can reopen", async (t) => {
  const h = await setup(t);
  await h.resolve(0, signedIn("a@example.com"));
  await h.update(serverA, { operationId: "sync-1", status: "error", message: "HTTP 401" });
  await h.resolve(1, signedOut);
  assert.equal(h.current().syncStatus.authenticated, false);
  assert.equal(h.current().syncStatus.email, undefined);
});

test("refresh after re-login wins over an earlier request for the same server", async (t) => {
  const h = await setup(t);
  let refresh;
  await act(async () => { refresh = h.current().refreshSyncStatus(); });
  await h.resolve(1, signedIn("new@example.com"));
  await refresh;
  await h.resolve(0, signedOut);
  assert.equal(h.current().syncStatus.email, "new@example.com");
});

test("an invalid draft address or failed credential lookup cannot retain authenticated controls", async (t) => {
  const h = await setup(t);
  await h.resolve(0, signedIn("a@example.com"));
  await h.update("https://");
  await act(async () => h.requests[1].reject(new Error("invalid endpoint")));
  assert.equal(h.current().syncStatus, undefined);
});

test("whitespace and trailing slash edits keep the same server login", async (t) => {
  const h = await setup(t, ` ${serverA}/ `);
  await h.resolve(0, signedIn("a@example.com"));
  await h.update(serverA);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].endpoint, serverA);
  assert.equal(h.current().syncStatus.authenticated, true);
});
