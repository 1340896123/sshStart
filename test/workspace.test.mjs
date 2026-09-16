import "./registerTs.mjs";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import renderer, { act } from "react-test-renderer";

let invokeHandler;
mock.module("@tauri-apps/api/core", { exports: { invoke: (...args) => invokeHandler(...args) } });
mock.module("@tauri-apps/api/event", { exports: { listen: async () => () => {} } });
mock.module("@tauri-apps/plugin-dialog", { exports: { open: async () => null, save: async () => null } });
mock.module(new URL("../src/devBootstrap.ts", import.meta.url).href, { exports: { DEV_BOOTSTRAP: undefined } });
const components = {};
for (const name of ["AiPane", "AiImportDialog", "ColumnSplitter", "FilePane", "ServerDialog", "ServerTree", "SettingsDialog", "TerminalPane", "TransferPanel", "SystemDock"]) {
  components[name] = () => null;
  mock.module(new URL(`../src/components/${name}.tsx`, import.meta.url).href, { exports: { [name]: components[name] } });
}
const { default: App } = await import("../src/App.tsx");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function setup(t) {
  globalThis.window = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, innerWidth: 1400, setTimeout, clearTimeout, location: { reload() {} } });
  const load = deferred();
  const calls = [];
  invokeHandler = (command, args) => {
    calls.push({ command, args });
    if (command === "load_app_state") return load.promise;
    if (command === "load_server_secrets") return Promise.resolve({ password: "saved password" });
    return Promise.resolve(null);
  };
  let root;
  await act(async () => { root = renderer.create(React.createElement(App)); });
  t.after(() => act(() => root.unmount()));
  const server = { id: "server-1", name: "Original", group: "", host: "old.example", port: 22, username: "root", authType: "password", color: "green" };
  const snapshot = { servers: [server], savedGroups: [], collapsedGroups: [], aiConversations: [], aiConfig: { cloudSync: { enabled: false, endpoint: "" } } };
  return { root, load, calls, snapshot, component: name => root.root.findByType(components[name]) };
}

test("initial storage loading prevents edits, and load failure does not start saving empty state", async t => {
  t.mock.method(console, "error", () => {});
  const h = await setup(t);
  assert.equal(h.root.root.findAllByType(components.ServerTree).length, 0);
  assert.equal(h.root.root.findAllByType(components.ServerDialog).length, 0);
  await act(async () => h.load.reject(new Error("database unavailable")));
  assert.equal(h.root.root.findAllByType(components.ServerTree).length, 0);
  assert.equal(h.calls.some(call => call.command.startsWith("save_")), false);
  assert.match(JSON.stringify(h.root.toJSON()), /无法加载本地数据/);
});

test("existing sessions and transfer retries keep their target when a profile is edited", async t => {
  const h = await setup(t);
  await act(async () => h.load.resolve(h.snapshot));
  await act(() => h.component("ServerTree").props.onOpen(h.snapshot.servers[0]));
  const original = h.component("TerminalPane").props;
  const request = { direction: "upload", fileName: "test", sourcePath: "local", destinationPath: "/tmp/test" };
  const oldFilePane = h.component("SystemDock").props.filePane;
  await act(async () => { await oldFilePane.props.onTransfer(request, async () => { throw new Error("offline"); }).catch(() => {}); });
  await act(async () => h.component("ServerTree").props.onEditServer(h.snapshot.servers[0]));
  await act(async () => h.component("ServerDialog").props.onSave({ ...h.snapshot.servers[0], host: "new.example", password: "" }));
  const terminals = h.root.root.findAllByType(components.TerminalPane);
  assert.equal(terminals.length, 2);
  assert.equal(terminals[0].props.server.host, "old.example");
  assert.equal(terminals[0].props.session.id, original.session.id);
  assert.equal(terminals[1].props.server.host, "new.example");
  await act(async () => h.component("ServerTree").props.onOpen(h.component("ServerTree").props.servers[0]));
  assert.equal(h.root.root.findByProps({ className: "workspace-session active" }).findByType(components.TerminalPane).props.server.host, "new.example");
  const docks = h.root.root.findAllByType(components.SystemDock);
  assert.equal(docks[0].props.server.host, "old.example");
  assert.equal(docks[0].props.filePane.props.server.host, "old.example");
  assert.equal(h.calls.find(call => call.command === "store_server_secret").args.password, "");
  const transferButton = h.root.root.findAllByType("button").find(button => button.props.title === "文件传输");
  await act(() => transferButton.props.onClick());
  const transfer = h.component("TransferPanel");
  assert.equal(transfer.props.transfers[0].server.host, "old.example");
  await act(async () => transfer.props.onRetry(transfer.props.transfers[0]));
  assert.equal(h.calls.find(call => call.command === "start_upload_file").args.server.host, "old.example");
});
