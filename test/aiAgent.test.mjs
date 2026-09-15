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
let eventListener;
mock.module("@tauri-apps/api/core", { exports: { invoke: (...args) => invokeHandler(...args) } });
mock.module("@tauri-apps/api/event", { exports: {
  listen: async (_name, handler) => { eventListener = handler; return () => {}; },
} });
const { useAiAgent } = await import("../src/ai/useAiAgent.ts");

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function setup(t, initialPolicy, onInvoke = () => undefined) {
  const calls = [];
  const run = deferred();
  let agent, messages, root, runPromise, runId;
  let sequence = 0;
  const config = { tools: { allowMutatingTools: false } };
  invokeHandler = (command, args) => {
    calls.push({ command, args });
    if (command === "run_ai_agent") { runId = args.runId; return run.promise; }
    if (command === "cancel_ai_run") { run.reject("AI 运行已取消"); return Promise.resolve(); }
    return Promise.resolve(onInvoke(command, args));
  };
  function Harness({ policy }) {
    const [history, setHistory] = React.useState([]);
    messages = history;
    agent = useAiAgent({ config, server: { id: "test" }, messages: history, onMessagesChange: setHistory, approvalPolicy: policy });
    return null;
  }
  await act(async () => { root = renderer.create(React.createElement(Harness, { policy: initialPolicy })); });
  await act(async () => { runPromise = agent.start({ content: "部署应用并重启服务", attachments: [], allowTools: true }); });
  const emit = (event) => act(async () => {
    eventListener({ payload: { runId, sequence: ++sequence, timestamp: Date.now(), ...event } });
  });
  await emit({ type: "run_started" });
  t.after(async () => {
    await act(async () => { root.unmount(); });
    await runPromise;
  });
  return {
    calls, config, run, emit,
    latest: () => messages.at(-1),
    agent: () => agent,
    setPolicy: (policy) => act(async () => { root.update(React.createElement(Harness, { policy })); }),
  };
}

const approval = {
  type: "approval_required", approvalId: "approval-1", actionId: "action-1", tool: "execute_command",
  command: "systemctl restart app", arguments: { command: "systemctl restart app" }, reason: "变更状态",
};
const started = { ...approval, type: "tool_started", startedAt: 1 };

test("full access is sent to the backend without frontend auto-approval", async (t) => {
  const harness = await setup(t, "full-access");
  assert.equal(harness.calls.find(({ command }) => command === "run_ai_agent").args.approvalPolicy, "full-access");
  await harness.emit(started);
  assert.equal(harness.latest().toolCalls[0].status, "running");
  assert.ok(!harness.calls.some(({ command }) => ["review_ai_approval", "resolve_ai_approval"].includes(command)));
  assert.equal(harness.config.tools.allowMutatingTools, false);
});

test("a late reviewer rejection cannot override switching to full access", async (t) => {
  const review = deferred();
  const harness = await setup(t, "reviewer", (command) => command === "review_ai_approval" ? review.promise : undefined);
  await harness.emit(approval);
  assert.equal(harness.agent().resolvingApprovalId, "approval-1");
  await harness.setPolicy("full-access");
  assert.equal(harness.calls.filter(({ command }) => command === "set_ai_approval_policy").at(-1).args.approvalPolicy, "full-access");
  await harness.emit(started);
  await act(async () => { review.resolve({ decision: "reject", reason: "late result" }); });
  assert.equal(harness.latest().approvalState, "approved");
  assert.equal(harness.latest().toolCalls[0].status, "running");
  assert.ok(!harness.calls.some(({ command }) => command === "resolve_ai_approval"));
});

test("switching to manual approval releases the reviewer UI immediately", async (t) => {
  const review = deferred();
  const harness = await setup(t, "reviewer", (command) => command === "review_ai_approval" ? review.promise : undefined);
  await harness.emit(approval);
  await harness.setPolicy("request");
  assert.equal(harness.agent().resolvingApprovalId, undefined);
  await act(async () => { review.resolve({ decision: "approve", reason: "late result" }); });
  assert.equal(harness.latest().approvalState, "pending");
  assert.ok(!harness.calls.some(({ command }) => command === "resolve_ai_approval"));
});

test("an IPC approval failure stays pending and remains retryable", async (t) => {
  let fails = true;
  const harness = await setup(t, "request", (command) => {
    if (command === "resolve_ai_approval" && fails) throw new Error("test IPC failure");
  });
  await harness.emit(approval);
  await act(async () => { await harness.agent().resolveApproval(harness.latest().id, "approve"); });
  assert.equal(harness.latest().approvalState, "pending");
  assert.match(harness.latest().approvalNote, /test IPC failure/);
  fails = false;
  await act(async () => { await harness.agent().resolveApproval(harness.latest().id, "approve"); });
  assert.equal(harness.latest().approvalState, "approved");
});

test("cancelling during review clears pending approval and ignores its later result", async (t) => {
  const review = deferred();
  const harness = await setup(t, "reviewer", (command) => command === "review_ai_approval" ? review.promise : undefined);
  await harness.emit(approval);
  await act(async () => { await harness.agent().cancel(); });
  await act(async () => { review.resolve({ decision: "approve", reason: "late result" }); });
  assert.equal(harness.latest().status, "cancelled");
  assert.equal(harness.latest().approval, undefined);
  assert.ok(!harness.calls.some(({ command }) => command === "resolve_ai_approval"));
});
