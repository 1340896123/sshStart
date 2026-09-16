import "./registerTs.mjs";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import React from "react";
import renderer, { act } from "react-test-renderer";

const listeners = new Map();
const starts = [];
mock.module("@tauri-apps/api/core", { exports: { invoke: (name) => name === "start_terminal" ? new Promise(resolve => starts.push(resolve)) : Promise.resolve() } });
mock.module("@tauri-apps/api/event", { exports: { listen: async (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name); } } });
mock.module("@xterm/xterm", { exports: { Terminal: class {
  cols = 80; rows = 24;
  loadAddon() {} open() {} write() {} writeln() {} dispose() {}
  onData() { return { dispose() {} }; }
} } });
mock.module("@xterm/addon-fit", { exports: { FitAddon: class { fit() {} } } });
mock.module(new URL("../src/diagnostics.ts", import.meta.url).href, { exports: { diagnosticLog() {}, diagnosticError() {} } });
const { TerminalPane } = await import("../src/components/TerminalPane.tsx");

test("terminal closure before startup completes and late closure from a prior connection cannot mark the wrong generation connected", async t => {
  globalThis.window = { __TAURI_INTERNALS__: {} };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const updates = [];
  let root;
  await act(async () => { root = renderer.create(React.createElement(TerminalPane, {
    session: { id: "session-test" }, server: { id: "a", host: "original", username: "test" }, onUpdate: update => updates.push(update),
  }), { createNodeMock: () => ({}) }); });
  t.after(() => act(() => root.unmount()));
  const closed = payload => listeners.get("terminal-closed-session-test")({ payload });
  await act(async () => { closed({ generation: "old" }); starts[0]("old"); });
  assert.equal(updates.at(-1).connected, false);
  assert.match(JSON.stringify(root.toJSON()), /终端连接已关闭/);
  await act(async () => root.root.findAllByType("button").find(button => button.props.title === "重新连接").props.onClick());
  await act(async () => { closed({ generation: "old", error: "old connection failure" }); starts[1]("new"); });
  assert.equal(updates.at(-1).connected, true);
  await act(async () => closed({ generation: "old", error: "late old connection failure" }));
  assert.equal(updates.at(-1).connected, true);
  await act(async () => closed({ generation: "new" }));
  assert.equal(updates.at(-1).connected, false);
});
