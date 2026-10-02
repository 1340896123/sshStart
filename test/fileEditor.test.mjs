import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";
import React from "react";
import renderer, { act } from "react-test-renderer";
import ts from "typescript";

const sourceRoot = new URL("../src/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) return { format: "module", source: ts.transpileModule(fs.readFileSync(new URL(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText, shortCircuit: true };
    return nextLoad(url, context);
  },
});
globalThis.window = { __TAURI_INTERNALS__: {} };
mock.module("../src/monaco.ts", { namedExports: { definePorticoEditorTheme() {} } });
mock.module("@monaco-editor/react", { defaultExport: (props) => React.createElement("test-editor", props) });
let invokeHandler;
mock.module("@tauri-apps/api/core", { namedExports: { invoke: (...args) => invokeHandler(...args) } });
const { FileEditor } = await import("../src/components/FileEditor.tsx");
const revision = { size: 8, modified: 1, sha256: "initial", resolvedPath: "/config.txt" };

async function setup(t, initialContent = "original") {
  const calls = [], dirty = [], writes = [];
  const props = { server: { id: "A", host: "A" }, sessionId: "session-A", file: { name: "config.txt", path: "/config.txt" }, active: true, onDirtyChange: (value) => dirty.push(value), onSaved() {} };
  invokeHandler = (command, args) => {
    calls.push({ command, args });
    if (command === "read_remote_file") return Promise.resolve({ content: initialContent, revision });
    return new Promise((resolve, reject) => writes.push({ resolve, reject }));
  };
  let root;
  await act(async () => { root = renderer.create(React.createElement(FileEditor, props)); });
  t.after(async () => { await act(async () => root.unmount()); });
  return {
    calls, dirty, writes, props,
    editor: () => root.root.findByType("test-editor"),
    button: () => root.root.findByType("button"),
    edit: (value) => act(async () => root.root.findByType("test-editor").props.onChange(value)),
    save: () => act(async () => root.root.findByType("button").props.onClick()),
    update: (next) => act(async () => root.update(React.createElement(FileEditor, { ...props, ...next }))),
  };
}

test("edits made while saving remain dirty, and the next save uses the returned revision", async (t) => {
  const h = await setup(t);
  await h.edit("submitted"); await h.save(); await h.edit("newer");
  const nextRevision = { ...revision, sha256: "submitted", modified: 2 };
  await act(async () => h.writes[0].resolve(nextRevision));
  assert.equal(h.editor().props.value, "newer");
  assert.equal(h.dirty.at(-1), true);
  assert.equal(h.button().props.disabled, false);
  await h.save();
  assert.deepEqual(h.calls.at(-1).args.expectedRevision, nextRevision);
  assert.equal(h.calls.at(-1).args.content, "newer");
  await act(async () => h.writes[1].resolve({ ...nextRevision, sha256: "newer" }));
  assert.equal(h.dirty.at(-1), false);
});

test("profile updates preserve the buffer and its original connection", async (t) => {
  const h = await setup(t);
  await h.edit("unsaved");
  await h.update({ server: { ...h.props.server, name: "renamed", host: "other" } });
  assert.equal(h.calls.length, 1);
  assert.equal(h.editor().props.value, "unsaved");
  await h.save();
  assert.equal(h.calls.at(-1).args.server.host, "A");
});

test("failed writes keep the content dirty and retryable", async (t) => {
  const h = await setup(t);
  await h.edit("retry"); await h.save();
  await act(async () => h.writes[0].reject("permission denied"));
  assert.equal(h.editor().props.value, "retry");
  assert.equal(h.dirty.at(-1), true);
  assert.equal(h.button().props.disabled, false);
});

test("shortcut saves use the latest buffer and cannot enqueue duplicate writes", async (t) => {
  const h = await setup(t);
  let shortcut;
  h.editor().props.onMount({ addCommand: (_, fn) => { shortcut = fn; }, focus() {} }, { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 } });
  await h.edit("latest");
  await act(async () => { shortcut(); shortcut(); });
  assert.equal(h.writes.length, 1);
  assert.equal(h.calls.at(-1).args.content, "latest");
});

test("model URIs distinguish server, session, and special characters in paths", async (t) => {
  const h = await setup(t);
  const first = h.editor().props.path;
  await h.update({ sessionId: "session-B" });
  assert.notEqual(h.editor().props.path, first);
  await h.update({ file: { name: "a#b?.txt", path: "/a#b?.txt" } });
  assert.ok(h.editor().props.path.endsWith("/a%23b%3F.txt"));
});

test("UTF-8 BOM survives Monaco change callbacks", async (t) => {
  const h = await setup(t, "\uFEFForiginal");
  await h.edit("edited"); await h.save();
  assert.equal(h.calls.at(-1).args.content, "\uFEFFedited");
});
