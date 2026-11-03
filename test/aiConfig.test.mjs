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
const { DEFAULT_AI_CONFIG, normalizeAiConfig, changeAiModelSettings, createAiProviderModel, stripAiConfigSecrets } = await import(configUrl);

test("custom prompts and explicit tool restrictions survive normalization", () => {
  const result = normalizeAiConfig({ systemPrompt: "仅管理测试服务器", tools: { executeCommand: false, allowMutatingTools: false } });
  assert.equal(result.systemPrompt, "仅管理测试服务器");
  assert.equal(result.tools.executeCommand, false);
  assert.equal(result.tools.allowMutatingTools, false);
  assert.equal(normalizeAiConfig({ systemPrompt: "" }).systemPrompt, "");
});

test("reasoning effort preserves selections and defaults legacy or unknown values to auto", () => {
  assert.equal(normalizeAiConfig({ model: "custom-model" }).reasoningEffort, "auto");
  for (const reasoningEffort of ["auto", "none", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.equal(normalizeAiConfig({ reasoningEffort }).reasoningEffort, reasoningEffort);
  }
  assert.equal(normalizeAiConfig({ reasoningEffort: "unsupported" }).reasoningEffort, "auto");
  assert.equal(normalizeAiConfig({}, normalizeAiConfig({ reasoningEffort: "high" })).reasoningEffort, "high");
});

test("legacy settings migrate into a provider without changing their endpoint, key, model or effort", () => {
  const config = normalizeAiConfig({ endpoint: "https://legacy.example/v1", apiKey: "legacy-key", model: "legacy-model", reasoningEffort: "high" });
  assert.equal(config.selectedProviderId, "default");
  assert.equal(config.providers[0].apiMode, "chat-completions");
  assert.equal(config.providers[0].apiKey, "legacy-key");
  assert.equal(config.providers[0].endpoint, "https://legacy.example/v1");
  assert.equal(config.providers[0].models[0].id, "legacy-model");
  assert.equal(config.providers[0].models[0].defaultReasoningEffort, "high");
  assert.deepEqual(normalizeAiConfig(config), config);
});

const multiProviderConfig = () => normalizeAiConfig({ providers: [
  { id: "first", name: "First", apiMode: "responses", endpoint: "https://first.example/v1", apiKey: "first-key", selectedModelId: "shared-model",
    models: [createAiProviderModel("shared-model", "high"), { ...createAiProviderModel("fast-model", "none"), reasoningEfforts: ["none", "low"] }] },
  { id: "second", name: "Second", apiMode: "chat-completions", endpoint: "https://second.example/v1", apiKey: "second-key", selectedModelId: "shared-model",
    models: [{ ...createAiProviderModel("shared-model", "medium"), reasoningEfforts: ["auto", "medium"] }] },
], selectedProviderId: "first" });

test("switching providers selects the matching endpoint, protocol, key and remembered model effort", () => {
  let config = multiProviderConfig();
  config = changeAiModelSettings(config, { model: "fast-model", reasoningEffort: "low" });
  config = changeAiModelSettings(config, { providerId: "second" });
  assert.equal(config.endpoint, "https://second.example/v1");
  assert.equal(config.apiMode, "chat-completions");
  assert.equal(config.apiKey, "second-key");
  assert.equal(config.model, "shared-model");
  assert.equal(config.reasoningEffort, "medium");
  config = changeAiModelSettings(config, { providerId: "first" });
  assert.equal(config.apiKey, "first-key");
  assert.equal(config.model, "fast-model");
  assert.equal(config.reasoningEffort, "low");
  config = changeAiModelSettings(config, { model: "shared-model" });
  assert.equal(config.reasoningEffort, "high");
});

test("removed providers and models fall back to valid selections and unsupported effort uses the model default", () => {
  const config = multiProviderConfig();
  const second = config.providers[1];
  const next = normalizeAiConfig({ ...config, providers: [{ ...second, selectedModelId: "deleted", models: second.models.map((model) => ({ ...model, reasoningEffort: "high" })) }] });
  assert.equal(next.selectedProviderId, "second");
  assert.equal(next.model, "shared-model");
  assert.equal(next.reasoningEffort, "medium");
  assert.equal(changeAiModelSettings(next, { reasoningEffort: "xhigh" }).reasoningEffort, "medium");
});

test("persisted configs omit every key and restore keys only for matching provider IDs", () => {
  const config = multiProviderConfig();
  const stripped = stripAiConfigSecrets(config);
  assert.equal(JSON.stringify(stripped).includes('"apiKey"'), false);
  assert.equal(JSON.stringify(stripped).includes("first-key"), false);
  const restored = normalizeAiConfig(stripped, config);
  assert.equal(restored.providers[0].apiKey, "first-key");
  assert.equal(restored.providers[1].apiKey, "second-key");
  assert.equal(normalizeAiConfig(stripped).providers[1].apiKey, "");
  const legacy = normalizeAiConfig({ endpoint: "https://legacy.example", model: "legacy" }, config);
  assert.equal(legacy.apiKey, "");
});
