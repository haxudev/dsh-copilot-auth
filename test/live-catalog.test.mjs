import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLiveCatalog } from "../src/live-catalog.mjs";
import { fetchLiveModelCatalog, COPILOT_HEADERS } from "../src/copilot-models.mjs";
import { mergeCatalog, mergeCatalogForDisk, validateCatalog } from "../src/catalog.mjs";

// Exact allowlisted fields observed by the parent via the authenticated read-only
// diagnostic on 2026-11-18; these are account metadata, NOT catalog guesses.
function gpt() {
  return {
    id: "gpt-6.2-sol", name: "GPT-6.2 Sol", model_picker_enabled: true, policy: {},
    supported_endpoints: ["/responses"],
    capabilities: {
      type: "chat", family: "gpt-6.2-sol", tokenizer: "o200k_base",
      limits: { max_context_window_tokens: 1050000, max_prompt_tokens: 1050000, max_output_tokens: 128000 },
      supports: { tool_calls: true, vision: true, streaming: true, reasoning_effort: ["low", "medium", "high", "xhigh", "max"] },
    },
  };
}
function gemini() {
  return {
    id: "gemini-4-carbon", name: "Gemini 4 Carbon", model_picker_enabled: true, policy: {},
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      type: "chat",
      limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 936000, max_output_tokens: 64000 },
      supports: { tool_calls: true, vision: true, streaming: true, parallel_tool_calls: true, reasoning_effort: ["low", "medium", "high"] },
    },
  };
}
function convert(models, extra = {}) {
  return buildLiveCatalog({ models, availableIds: models.map((m) => m.id), ...extra });
}
function expectRejected(mutate, reason) {
  const model = gpt();
  mutate(model);
  const result = convert([model]);
  assert.deepEqual(result.catalog, {});
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.skipped, [{ id: model.id, reason }]);
}

test("real GPT6.2 Sol / Gemini4 Carbon metadata becomes validated additive catalog without name inference", () => {
  const models = [gpt(), gemini()];
  const originals = structuredClone(models);
  const result = convert(models);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.added, [
    { id: "gpt-6.2-sol", api: "openai-responses" },
    { id: "gemini-4-carbon", api: "openai-completions" },
  ]);
  const sol = result.catalog["openai-responses"]["gpt-6.2-sol"];
  const carbon = result.catalog["openai-completions"]["gemini-4-carbon"];
  assert.equal(sol.contextWindow, 1050000);
  assert.equal(sol.maxTokens, 128000);
  assert.equal(carbon.contextWindow, 1000000);
  assert.equal(carbon.maxTokens, 64000);
  assert.equal(sol.baseUrl, "https://api.individual.githubcopilot.com");
  assert.deepEqual(sol.input, ["text", "image"]);
  assert.equal(sol.reasoning, true);
  assert.deepEqual(sol.headers, COPILOT_HEADERS);
  assert.equal(sol.thinkingLevelMap.xhigh, "xhigh");
  assert.equal(sol.thinkingLevelMap.max, "max");
  assert.equal(sol.thinkingLevelMap.minimal, null);
  assert.equal(carbon.thinkingLevelMap.xhigh, null);
  assert.deepEqual(sol.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  for (const [api, section] of Object.entries(result.catalog)) {
    for (const [id, entry] of Object.entries(section)) assert.equal(validateCatalog(api, id, entry), true);
  }
  assert.deepEqual(models, originals);
});

test("conversion is generic for IDs, protocol, limits and name fallback, never copies source URLs/headers", () => {
  const model = gpt();
  model.id = "future-vendor.model:custom";
  delete model.name;
  model.baseUrl = "https://attacker.invalid";
  model.headers = { Authorization: "secret" };
  model.supported_endpoints = ["/v1/messages"];
  model.capabilities.limits = { max_context_window_tokens: 54321, max_output_tokens: 1234 };
  model.capabilities.supports = { tool_calls: true, streaming: true };
  const result = convert([model]);
  const entry = result.catalog["anthropic-messages"][model.id];
  assert.equal(entry.name, model.id);
  assert.equal(entry.id, model.id);
  assert.equal(entry.contextWindow, 54321);
  assert.equal(entry.maxTokens, 1234);
  assert.equal(entry.reasoning, false);
  assert.deepEqual(entry.input, ["text"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("attacker.invalid"), false);
});

test("only missing account-available IDs are synthesized; existing metadata and disk keys survive", () => {
  const sol = gpt();
  const carbon = gemini();
  const existing = { "openai-responses": { "chat:gpt-6.2-sol": { id: sol.id, provider: "github-copilot", api: "openai-responses", contextWindow: 999, maxTokens: 99, name: "user-edited" } } };
  const result = convert([sol, carbon], { existingIds: new Set([sol.id]) });
  assert.deepEqual(result.added, [{ id: carbon.id, api: "openai-completions" }]);
  const merged = mergeCatalog(existing, result.catalog);
  assert.equal(merged.merged["openai-responses"][sol.id].name, "user-edited");
  const disk = mergeCatalogForDisk(existing, result.catalog);
  assert.equal(disk.merged["openai-responses"]["chat:gpt-6.2-sol"].name, "user-edited");
  assert.equal(disk.merged["openai-completions"]["chat:gemini-4-carbon"].id, carbon.id);
  assert.deepEqual(buildLiveCatalog({ models: [sol] }).skipped, [{ id: sol.id, reason: "not-account-available" }]);
});

test("explicit endpoints only: HTTP responses plus matching websocket accepted; unknown/ambiguous rejected", () => {
  const sol = gpt();
  sol.supported_endpoints = ["/responses", "ws:/responses"];
  assert.equal(convert([sol]).added.length, 1);
  expectRejected((m) => { delete m.supported_endpoints; }, "missing-supported-endpoints");
  expectRejected((m) => { m.supported_endpoints = ["/chat/completions", "/responses"]; }, "ambiguous-supported-endpoints");
  expectRejected((m) => { m.supported_endpoints = ["/v1/messages", "ws:/responses"]; }, "ambiguous-supported-endpoints");
  expectRejected((m) => { m.supported_endpoints = ["ws:/responses"]; }, "unsupported-websocket-only-endpoint");
  expectRejected((m) => { m.supported_endpoints = ["/responses", "/future/unknown"]; }, "unknown-supported-endpoint");
  expectRejected((m) => { m.supported_endpoints = ["https://attacker.invalid/responses"]; }, "unknown-supported-endpoint");
});

test("only the two verified MAI IDs resolve the observed dual HTTP endpoints to Responses", () => {
  const dual = ["/chat/completions", "/responses"];
  const mai = { ...gpt(), id: "mai-code-2", name: "MAI Code 2", supported_endpoints: dual };
  const flash = { ...mai, id: "mai-code-2-flash", supported_endpoints: [...dual].reverse() };
  const result = convert([mai, flash]);
  assert.deepEqual(result.added, [mai, flash].map(({ id }) => ({ id, api: "openai-responses" })));
  assert.equal(result.catalog["openai-responses"][mai.id].thinkingLevelMap.max, "max");
  assert.equal(result.catalog["openai-completions"], undefined);
  assert.deepEqual(convert([mai], { availableIds: [] }).skipped, [{ id: mai.id, reason: "not-account-available" }]);
  assert.deepEqual(convert([mai], { existingIds: [mai.id] }).added, []);
  for (const [model, reason] of [
    [{ ...mai, id: "mai-code-2-preview" }, "ambiguous-supported-endpoints"],
    [{ ...mai, supported_endpoints: [...dual, "/v1/messages"] }, "ambiguous-supported-endpoints"],
    [{ ...mai, supported_endpoints: [...dual, "ws:/responses"] }, "ambiguous-supported-endpoints"],
    [{ ...mai, supported_endpoints: [...dual, "/future/unknown"] }, "unknown-supported-endpoint"],
    [{ ...mai, policy: { state: "disabled" } }, "policy-disabled"],
  ]) {
    assert.deepEqual(convert([model]).skipped, [{ id: model.id, reason }]);
  }
});

test("require explicit chat and tool support, policy, context and output limits; do not infer from model names", () => {
  expectRejected((m) => { delete m.capabilities.type; }, "chat-capability-not-confirmed");
  expectRejected((m) => { m.capabilities.type = "embeddings"; }, "chat-capability-not-confirmed");
  expectRejected((m) => { delete m.capabilities.supports.tool_calls; }, "tool-calls-not-confirmed");
  expectRejected((m) => { m.capabilities.supports.tool_calls = false; }, "tool-calls-not-confirmed");
  expectRejected((m) => { delete m.capabilities.supports.streaming; }, "streaming-not-confirmed");
  expectRejected((m) => { m.capabilities.supports.streaming = false; }, "streaming-not-confirmed");
  expectRejected((m) => { m.policy = { state: "disabled" }; }, "policy-disabled");
  expectRejected((m) => { delete m.capabilities.limits.max_context_window_tokens; }, "missing-or-invalid-context-window");
  expectRejected((m) => { delete m.capabilities.limits.max_output_tokens; }, "missing-or-invalid-output-limit");
  for (const bad of [0, -1, 1.5, Infinity, NaN, "128000", Number.MAX_SAFE_INTEGER + 1]) {
    expectRejected((m) => { m.capabilities.limits.max_output_tokens = bad; }, "missing-or-invalid-output-limit");
  }
  expectRejected((m) => { m.capabilities.limits.max_context_window_tokens = 64000; }, "inconsistent-token-limits");
  expectRejected((m) => { m.capabilities.limits.max_prompt_tokens = 1050001; }, "inconsistent-token-limits");
});

test("duplicate model ID is rejected rather than choosing an arbitrary protocol; unsafe keys do not pollute prototypes", () => {
  const model = gpt();
  const duplicate = gpt();
  duplicate.supported_endpoints = ["/chat/completions"];
  const result = convert([model, duplicate]);
  assert.deepEqual(result.skipped, [{ id: model.id, reason: "duplicate-model-id" }]);
  assert.deepEqual(result.catalog, {});
  const invalid = gpt();
  invalid.id = "__proto__";
  assert.deepEqual(convert([invalid]).skipped, [{ id: null, reason: "invalid-model-id" }]);
  assert.equal(Object.prototype.id, undefined);
});

test("live fetch + real converter integration: policy is retained and secrets/unknown metadata never reach catalog", async () => {
  const sol = gpt();
  sol.token = "NEVER-EXPOSE";
  sol.headers = { Authorization: "NEVER-EXPOSE" };
  sol.capabilities.secret = "NEVER-EXPOSE";
  sol.capabilities.supports.secret = "NEVER-EXPOSE";
  sol.capabilities.limits.secret = "NEVER-EXPOSE";
  sol.policy.secret = "NEVER-EXPOSE";
  const disabled = gemini();
  disabled.policy = { state: "disabled" };
  const live = await fetchLiveModelCatalog({
    credential: { access: "NEVER-EXPOSE" },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [sol, disabled], token: "NEVER-EXPOSE" }) }),
  });
  assert.deepEqual(live.ids, [sol.id]);
  assert.equal(live.models.length, 1);
  assert.equal(JSON.stringify(live).includes("NEVER-EXPOSE"), false);
  const result = buildLiveCatalog({ models: live.models, availableIds: live.ids });
  assert.equal(result.added[0].id, sol.id);
  assert.equal(JSON.stringify(result).includes("NEVER-EXPOSE"), false);
});
