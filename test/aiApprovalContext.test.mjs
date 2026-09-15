import assert from "node:assert/strict";
import test from "node:test";
import { buildApprovalContext } from "../src/ai/approvalContext.ts";

test("reviewing a continuation retains the original authorization and execution context", () => {
  const context = JSON.parse(buildApprovalContext([
    { role: "user", content: "部署 /srv/app，允许更新配置并重启服务" },
    {
      role: "assistant", content: "配置已更新",
      approval: { tool: "write_file", command: "write_file /srv/app/config" },
      approvalState: "approved", approvalNote: "你已批准",
      toolCalls: [{ tool: "write_file", command: "write_file /srv/app/config", status: "completed", exitCode: 0, output: "private log contents" }],
    },
    { role: "user", content: "继续" },
  ]));
  assert.equal(context[0].content, "部署 /srv/app，允许更新配置并重启服务");
  assert.equal(context[1].approval.state, "approved");
  assert.equal(context[1].tools[0].status, "completed");
  assert.equal(context[1].role, "assistant");
  assert.equal(context[2].content, "继续");
  assert.ok(!JSON.stringify(context).includes("private log contents"));
});

test("review context bounds large conversations and retains the latest user request", () => {
  const messages = Array.from({ length: 100 }, () => ({ role: "assistant", content: "x".repeat(20000) }));
  messages.push({ role: "user", content: "继续验证部署结果" });
  const context = JSON.parse(buildApprovalContext(messages));
  assert.equal(context.length, 32);
  assert.equal(context[0].content.length, 2000);
  assert.equal(context.at(-1).content, "继续验证部署结果");
});
