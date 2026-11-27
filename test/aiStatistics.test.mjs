import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationStatistics } from "../src/ai/statistics.ts";

const round = {
  role: "assistant", status: "completed", createdAt: 900, runStartedAt: 1000,
  firstTokenAt: 2000, lastTokenAt: 11000, updatedAt: 12000, completedAt: 12000,
  usage: { available: true, outputTokens: 400 },
  toolCalls: [
    { startedAt: 4000, completedAt: 8000 },
    { startedAt: 6000, completedAt: 9000 },
  ],
};

test("parallel tool intervals are counted once and excluded from model time and throughput", () => {
  assert.deepEqual(conversationStatistics([{ role: "user" }, round]), {
    rounds: 1, steps: 2, toolMs: 5000, modelMs: 6000,
    ttftSamples: 1, averageTtftMs: 1000, tokensPerSecond: 100,
  });
});

test("legacy conversations and single-chunk replies do not invent missing timings", () => {
  const legacy = { ...round, runStartedAt: undefined, firstTokenAt: undefined, lastTokenAt: undefined };
  const result = conversationStatistics([legacy]);
  assert.equal(result.modelMs, undefined);
  assert.equal(result.averageTtftMs, undefined);
  assert.equal(result.tokensPerSecond, undefined);
  assert.equal(result.toolMs, 5000);
  assert.equal(conversationStatistics([{ ...round, lastTokenAt: round.firstTokenAt }]).tokensPerSecond, undefined);
  assert.equal(conversationStatistics([round, legacy]).modelMs, undefined);
});

test("active tools are clipped to the current run and partial output has no final throughput", () => {
  const active = { ...round, status: "running", completedAt: undefined, toolCalls: [{ status: "running", startedAt: 4000 }] };
  const result = conversationStatistics([active], 6000);
  assert.equal(result.toolMs, 2000);
  assert.equal(result.modelMs, 3000);
  assert.equal(result.tokensPerSecond, undefined);
});

test("TTFT samples and throughput are weighted by measured time across completed rounds", () => {
  const second = { ...round, firstTokenAt: 3000, lastTokenAt: 11000, toolCalls: [], usage: { available: true, outputTokens: 800 } };
  const result = conversationStatistics([round, second]);
  assert.equal(result.averageTtftMs, 1500);
  assert.equal(result.tokensPerSecond, 100);
  assert.equal(result.modelMs, 17000);
});
