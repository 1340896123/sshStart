import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const configUrl = new URL("../src/types.ts", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    // Supply Vite's build-time environment when loading the config in Node.
    return url === configUrl ? { ...loaded, source: `import.meta.env = {};\n${loaded.source}` } : loaded;
  },
});
const { DEFAULT_AI_CONFIG, normalizeAiConfig } = await import(configUrl);
const legacyPrompt = "你是 Portico SSH 的 Rig 运维 Agent。先观察再行动，优先使用结构化工具获取事实；明确说明风险和执行结果。不要声称读取过尚未通过工具访问的文件，高风险或变更型动作必须等待人工审批。";

test("saved default prompts migrate to the current approval behavior", () => {
  assert.equal(normalizeAiConfig({ systemPrompt: legacyPrompt }).systemPrompt, DEFAULT_AI_CONFIG.systemPrompt);
  assert.equal(normalizeAiConfig({}, { ...DEFAULT_AI_CONFIG, systemPrompt: legacyPrompt }).systemPrompt, DEFAULT_AI_CONFIG.systemPrompt);
});

test("custom prompts and explicit tool restrictions survive normalization", () => {
  const result = normalizeAiConfig({ systemPrompt: "仅管理测试服务器", tools: { executeCommand: false, allowMutatingTools: false } });
  assert.equal(result.systemPrompt, "仅管理测试服务器");
  assert.equal(result.tools.executeCommand, false);
  assert.equal(result.tools.allowMutatingTools, false);
  assert.equal(normalizeAiConfig({ systemPrompt: "" }).systemPrompt, "");
});
