import "./registerTs.mjs";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import renderer, { act } from "react-test-renderer";

let invokeHandler;
mock.module("@tauri-apps/api/core", { exports: { invoke: (...args) => invokeHandler(...args) } });
mock.module("@tauri-apps/api/webview", { exports: { getCurrentWebview: () => ({
  window: { scaleFactor: async () => 1, onScaleChanged: async () => () => {} }, onDragDropEvent: async () => () => {},
}) } });
mock.module("@tauri-apps/plugin-dialog", { exports: { open: async () => null, save: async () => null } });
mock.module(new URL("../src/components/FileEditor.tsx", import.meta.url).href, { exports: { FileEditor: () => null } });
const { FilePane } = await import("../src/components/FilePane.tsx");
const { SystemDock } = await import("../src/components/SystemDock.tsx");
const serverA = { id: "a", host: "a.example" };
const serverB = { id: "b", host: "b.example" };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const processRow = command => ({ pid: 123, user: "test", command, arguments: command, memoryPercent: 1, cpuPercent: 1, elapsedSeconds: 1 });

function setupRequests() {
  globalThis.window = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout, setInterval, clearInterval });
  const requests = [];
  invokeHandler = (command, args) => {
    if (command === "get_system_file_icons") return Promise.resolve([]);
    const pending = deferred(); requests.push({ command, args, ...pending }); return pending.promise;
  };
  return requests;
}

test("system responses from an old host or an older refresh cannot replace the current host", async t => {
  const requests = setupRequests();
  let root;
  await act(async () => { root = renderer.create(React.createElement(SystemDock, { server: serverA, filePane: null })); });
  t.after(() => act(() => root.unmount()));
  await act(async () => root.update(React.createElement(SystemDock, { server: serverB, filePane: null })));
  await act(async () => requests[1].resolve([processRow("current-host-process")]));
  await act(async () => requests[0].resolve([processRow("old-host-process")]));
  assert.match(JSON.stringify(root.toJSON()), /current-host-process/);
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /old-host-process/);
  const refresh = () => root.root.findAllByType("button").find(button => button.props.title === "刷新").props.onClick();
  await act(async () => { refresh(); refresh(); });
  await act(async () => requests[3].resolve([processRow("newest-refresh")]));
  await act(async () => requests[2].reject("stale failure"));
  assert.match(JSON.stringify(root.toJSON()), /newest-refresh/);
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /stale failure/);
});

test("rapid directory navigation keeps the latest path and ignores late initial and intermediate responses", async t => {
  const requests = setupRequests();
  const updates = [];
  let root;
  await act(async () => { root = renderer.create(React.createElement(FilePane, { session: { id: "session-a", cwd: "/" }, server: serverA, onUpdate: value => updates.push(value), onTransfer: async () => {} })); });
  t.after(() => act(() => root.unmount()));
  const pathInput = () => root.root.findAllByType("input").find(input => input.props["aria-label"] === "远程路径");
  for (const path of ["/slow", "/latest"]) {
    await act(() => pathInput().props.onChange({ target: { value: path } }));
    await act(async () => pathInput().props.onKeyDown({ key: "Enter" }));
  }
  const file = path => [{ name: path.slice(1), path, isDir: false, size: 1, permissions: "-rw-------" }];
  await act(async () => requests[2].resolve(file("/latest")));
  await act(async () => requests[1].resolve(file("/slow")));
  await act(async () => requests[0].reject("late initial error"));
  assert.equal(pathInput().props.value, "/latest");
  assert.deepEqual(updates, [{ cwd: "/latest", selectedFile: undefined }]);
  assert.doesNotMatch(JSON.stringify(root.toJSON()), /late initial error/);
});
