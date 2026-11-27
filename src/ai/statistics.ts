import type { AiMessage } from "../types";

const intervalDuration = (intervals: Array<[number, number]>, start: number, end: number) => {
  const sorted = intervals.map(([left, right]): [number, number] => [Math.max(start, left), Math.min(end, right)])
    .filter(([left, right]) => Number.isFinite(left) && Number.isFinite(right) && right > left)
    .sort(([left], [right]) => left - right);
  let duration = 0;
  let coveredUntil = start;
  for (const [left, right] of sorted) {
    duration += Math.max(0, right - Math.max(left, coveredUntil));
    coveredUntil = Math.max(coveredUntil, right);
  }
  return duration;
};

export function conversationStatistics(messages: AiMessage[], now = Date.now()) {
  const rounds = messages.filter((message) => message.role === "assistant");
  let steps = 0;
  let toolMs = 0;
  let modelMs = 0;
  let measuredRounds = 0;
  let ttftMs = 0;
  let ttftSamples = 0;
  let generatedTokens = 0;
  let generationMs = 0;
  for (const message of rounds) {
    const end = message.completedAt ?? (message.status === "running" || message.status === "started" ? now : message.updatedAt);
    const start = message.runStartedAt ?? message.createdAt;
    const intervals = (message.toolCalls ?? []).map((tool): [number, number] => [
      tool.startedAt,
      tool.completedAt ?? (tool.status === "running" || tool.status === "started" ? end : tool.updatedAt),
    ]);
    steps += intervals.length;
    const tools = intervalDuration(intervals, start, end);
    toolMs += tools;
    if (Number.isFinite(message.runStartedAt) && end >= start) {
      measuredRounds += 1;
      modelMs += Math.max(0, end - start - tools);
      if (message.firstTokenAt !== undefined && message.firstTokenAt >= start && message.firstTokenAt <= end) {
        ttftSamples += 1;
        ttftMs += message.firstTokenAt - start;
        if (message.completedAt !== undefined && message.usage?.available && message.lastTokenAt !== undefined) {
          const duration = message.lastTokenAt - message.firstTokenAt
            - intervalDuration(intervals, message.firstTokenAt, message.lastTokenAt);
          if (duration > 0 && message.usage.outputTokens > 0) {
            generationMs += duration;
            generatedTokens += message.usage.outputTokens;
          }
        }
      }
    }
  }
  return {
    rounds: rounds.length,
    steps,
    modelMs: measuredRounds && measuredRounds === rounds.length ? modelMs : undefined,
    toolMs,
    ttftSamples,
    averageTtftMs: ttftSamples ? ttftMs / ttftSamples : undefined,
    tokensPerSecond: generationMs ? generatedTokens * 1_000 / generationMs : undefined,
  };
}
