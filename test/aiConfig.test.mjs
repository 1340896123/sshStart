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

test("custom prompts and explicit tool restrictions survive normalization", () => {
  const result = normalizeAiConfig({ systemPrompt: "仅管理测试服务器", tools: { executeCommand: false, allowMutatingTools: false } });
  assert.equal(result.systemPrompt, "仅管理测试服务器");
  assert.equal(result.tools.executeCommand, false);
  assert.equal(result.tools.allowMutatingTools, false);
  assert.equal(normalizeAiConfig({ systemPrompt: "" }).systemPrompt, "");
});
