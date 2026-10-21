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
mock.module("@tauri-apps/api/core", { namedExports: { invoke: (...args) => invokeHandler(...args) } });
mock.module("@tauri-apps/api/event", { namedExports: {
  listen: async (_name, handler) => { eventListener = handler; return () => {}; },
} });
const { useAiAgent } = await import("../src/ai/useAiAgent.ts");

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function setup(t, initialPolicy, onInvoke = () => undefined, initialMessages = []) {
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
    const [history, setHistory] = React.useState(initialMessages);
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
    finish: (result) => act(async () => { run.resolve(result); await runPromise; }),
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

const usage = {
  available: true, inputTokens: 4000, outputTokens: 200, totalTokens: 4200,
  cachedTokens: 3600, reasoningTokens: 40, contextTokens: 2500, requests: 2,
};

test("usage snapshots retain cache hits and the latest context without double counting", async (t) => {
  const harness = await setup(t, "request");
  await harness.emit({ type: "usage", ...usage, inputTokens: 2000, cachedTokens: 1800, requests: 1 });
  await harness.emit({ type: "usage", ...usage });
  assert.deepEqual(harness.latest().usage, usage);
  await harness.finish({ content: "完成", usage });
  assert.deepEqual(harness.latest().usage, usage);
});

test("a provider without usage does not appear to have reported zero tokens", async (t) => {
  const harness = await setup(t, "request");
  const unavailable = Object.fromEntries(Object.keys(usage).map((key) => [key, key === "available" ? false : 0]));
  await harness.emit({ type: "usage", ...unavailable, requests: 1 });
  assert.equal(harness.latest().usage.available, false);
});

test("completed transcripts survive persistence and are sent on the next turn", async (t) => {
  const harness = await setup(t, "request");
  const modelMessages = [
    { role: "assistant", content: [{ id: "call-1", function: { name: "read_file", arguments: { path: "/etc/app" } } }] },
    { role: "user", content: [{ type: "toolresult", id: "call-1", content: [{ type: "text", text: "配置" }] }] },
    { role: "assistant", content: [{ text: "完成" }] },
  ];
  await harness.finish({ content: "完成", usage, modelMessages });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.latest())).modelMessages, modelMessages);
  await act(async () => { await harness.agent().start({ content: "继续", attachments: [], allowTools: true }); });
  const messages = harness.calls.filter(({ command }) => command === "run_ai_agent").at(-1).args.messages;
  assert.deepEqual(messages[1].modelMessages, modelMessages);
  assert.equal(messages.at(-1).content, "继续");
  const runs = harness.calls.filter(({ command }) => command === "run_ai_agent");
  assert.match(runs[0].args.conversationId, /^ai-user-/);
  assert.equal(runs[0].args.conversationId, runs[1].args.conversationId);
  assert.notEqual(runs[0].args.runId, runs[1].args.runId);
});

test("restored conversations retain their first user identity for cache routing", async (t) => {
  const harness = await setup(t, "request", undefined, [
    { id: "restored-first-user", role: "user", content: "原始任务", status: "completed" },
    { id: "restored-assistant", role: "assistant", content: "完成", status: "completed" },
  ]);
  const run = harness.calls.find(({ command }) => command === "run_ai_agent");
  assert.equal(run.args.conversationId, "restored-first-user");
  assert.notEqual(run.args.conversationId, run.args.runId);
});

test("cancelled replies use their displayed partial text instead of a stale transcript", async (t) => {
  const harness = await setup(t, "request", undefined, [{
    id: "cancelled", role: "assistant", content: "部分回复", status: "cancelled",
    modelMessages: [{ role: "assistant", content: [{ text: "过时内容" }] }],
  }]);
  const messages = harness.calls.find(({ command }) => command === "run_ai_agent").args.messages;
  assert.equal(messages[0].modelMessages, undefined);
  assert.match(messages[0].content, /部分回复/);
});

test("a failed request retains both the streamed reply and the IPC error", async (t) => {
  const harness = await setup(t, "request");
  await harness.emit({ type: "text_delta", delta: "磁盘检查完成，正在检查服务。" });
  await act(async () => { harness.run.reject("HTTP 429: 请求过多，请稍后重试"); });
  assert.equal(harness.latest().status, "error");
  assert.equal(harness.latest().content, "磁盘检查完成，正在检查服务。");
  assert.match(harness.latest().error, /HTTP 429/);
  assert.equal(harness.agent().running, false);
});

test("the specific run failure survives a later IPC error", async (t) => {
  const harness = await setup(t, "request");
  await harness.emit({ type: "text_delta", delta: "部分回复" });
  await harness.emit({ type: "run_failed", error: "API key 无效，请检查配置" });
  await act(async () => { harness.run.reject("IPC channel closed"); });
  assert.equal(harness.latest().content, "部分回复");
  assert.equal(harness.latest().error, "API key 无效，请检查配置");
});

test("a terminal run failure cannot be replaced by a successful IPC result", async (t) => {
  const harness = await setup(t, "request");
  await harness.emit({ type: "run_failed", error: "连接中断" });
  await harness.finish({ content: "" });
  assert.equal(harness.latest().status, "error");
  assert.equal(harness.latest().error, "连接中断");
});
