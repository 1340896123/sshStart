import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";
import React from "react";
import renderer, { act } from "react-test-renderer";

const sourceRoot = new URL("../src/", import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
} });
let invokeHandler;
mock.module("@tauri-apps/api/core", { exports: { invoke: (...args) => invokeHandler(...args) } });
const { useRemoteFileEditor } = await import("../src/useRemoteFileEditor.ts");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function setup(t) {
  globalThis.window = { __TAURI_INTERNALS__: {} };
  const requests = [];
  let editor, root;
  const dirty = [];
  const server = { id: "server-1", host: "original" };
  invokeHandler = (command, args) => { const pending = deferred(); requests.push({ command, args, ...pending }); return pending.promise; };
  function Harness({ path }) { editor = useRemoteFileEditor(server, path, value => dirty.push(value), () => {}); return null; }
  await act(async () => { root = renderer.create(React.createElement(Harness, { path: "/a" })); });
  const initialRevision = { size: 3, modified: 1, sha256: "first" };
  await act(async () => { requests[0].resolve({ content: "old", revision: initialRevision }); });
  t.after(() => act(() => root.unmount()));
  return { requests, dirty, latest: () => editor, initialRevision, update: path => act(() => root.update(React.createElement(Harness, { path }))) };
}

test("saving preserves edits made while the write is pending and advances the expected revision", async t => {
  const h = await setup(t);
  await act(() => h.latest().handleChange("submitted"));
  let save;
  await act(() => { save = h.latest().save(); });
  assert.deepEqual(h.requests[1].args.expectedRevision, h.initialRevision);
  await act(() => h.latest().handleChange("newer unsaved edit"));
  const nextRevision = { size: 9, modified: 2, sha256: "second" };
  await act(async () => { h.requests[1].resolve(nextRevision); await save; });
  assert.equal(h.latest().content, "newer unsaved edit");
  assert.equal(h.latest().dirty, true);
  assert.equal(h.dirty.at(-1), true);
  await act(() => { save = h.latest().save(); });
  assert.deepEqual(h.requests[2].args.expectedRevision, nextRevision);
  assert.equal(h.requests[2].args.content, "newer unsaved edit");
  await act(async () => { h.requests[2].resolve({ sha256: "third" }); await save; });
  assert.equal(h.latest().dirty, false);
});

test("a rejected conflict keeps the local edit and original revision for a retry", async t => {
  const h = await setup(t);
  await act(() => h.latest().handleChange("local work"));
  let save;
  await act(() => { save = h.latest().save(); void h.latest().save(); });
  assert.equal(h.requests.length, 2, "rapid repeated save must not start a concurrent write");
  await act(async () => { h.requests[1].reject("remote conflict"); await save; });
  assert.equal(h.latest().dirty, true);
  assert.equal(h.latest().content, "local work");
  assert.equal(h.latest().saveStatus.kind, "error");
});

test("a save completing after changing files cannot clear the new file's dirty state", async t => {
  const h = await setup(t);
  await act(() => h.latest().handleChange("old file edit"));
  let save;
  await act(() => { save = h.latest().save(); });
  await h.update("/b");
  await act(async () => { h.requests[2].resolve({ content: "file b", revision: { sha256: "b" } }); });
  await act(() => h.latest().handleChange("file b edited"));
  await act(async () => { h.requests[1].resolve({ sha256: "a" }); await save; });
  assert.equal(h.latest().content, "file b edited");
  assert.equal(h.latest().dirty, true);
});
