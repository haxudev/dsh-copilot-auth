import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRefreshService } from "../src/refresh-service.mjs";
import { createTransaction } from "../src/refresh-transaction.mjs";
import { loadRefreshState, saveRefreshState } from "../src/state.mjs";
import { registerModelTool } from "../src/model-tool.mjs";

const entry = (id) => ({ id, type: "chat", api: "openai-responses", provider: "github-copilot", contextWindow: 100000, maxTokens: 10000 });
const view = (models, overrides = null) => ({ modelsPresent: models !== null, models, modelOverridesPresent: overrides !== null, modelOverrides: overrides });
async function world({ raw = view([{ id: "old", maxTokens: 777 }]), effective = raw, account = ["new"], metadata = {}, staticCatalog, stale = false, missingServed = false } = {}) {
  const scope = { known: true, profileId: "supplement", dataDir: mkdtempSync(join(tmpdir(), "supplement-")) };
  const stateIO = { load: () => loadRefreshState(scope).state, save: (s) => saveRefreshState(scope, s) };
  const settings = { raw, effective, revision: 1, mutations: [] };
  const injected = new Set(["old"]);
  const landed = [];
  const network = { stale };
  const deps = {
    describeConfigView: async () => ({ view: settings.raw, effectiveView: settings.effective, revision: settings.revision }),
    mutateSettings: async (ops, revision) => {
      assert.equal(revision, settings.revision);
      settings.mutations.push(ops);
      for (const op of ops) {
        if (op.path[2] === "models") settings.raw = { ...settings.raw, modelsPresent: op.op === "set", models: op.value ?? null };
        if (op.path[2] === "modelOverrides") settings.raw = { ...settings.raw, modelOverridesPresent: op.op === "set", modelOverrides: op.value ?? null };
      }
      settings.effective = settings.raw; settings.revision++;
    },
    readDiskCatalog: () => ({ "openai-responses": { "chat:old": entry("old") } }),
    registryIds: async () => injected,
    injectRegistry: async (overlay) => { landed.push(overlay); for (const section of Object.values(overlay)) for (const id of Object.keys(section)) injected.add(id); return { ok: true }; },
    listServedIds: async () => missingServed ? new Set(["old"]) : injected,
    touchRouteIdentity: async () => false,
    resolveCatalog: async () => staticCatalog ?? ({ catalogSource: "latest", provenance: { kind: "latest", piAiVersion: "1.5.2" }, newEntryCount: 1, resolvableIds: ["old", "new"], addedOverlay: { "openai-responses": { new: entry("new") } } }),
  };
  const tx = createTransaction({}, { scope, stateIO, install: { writable: false, version: "1.3.0" }, deps, readIntentVersion: () => 1, servedRetry: { attempts: 1, delayMs: 0 } });
  const service = createRefreshService({ credentials: { readRecord: async () => ({ payload: { access: "tid=test;exp=4000000000;" } }) } }, {
    scope, stateIO, transaction: tx, deps, readIntentVersion: () => 1,
    fetchImpl: async () => { if (network.stale) throw new Error("offline"); return new Response(JSON.stringify({ data: account.map((id) => ({ id, model_picker_enabled: true, ...metadata[id] })) })); },
  });
  await service.bootReady();
  return { service, settings, injected, stateIO, landed, scope, network, deps, tx };
}
const preview = (w) => w.service.preview({ operation: "manage", selectionMode: "supplement" });

test("supplement uses real kernel, preserves unreported customized model and appends only available models", async () => {
  const w = await world();
  const p = await preview(w);
  assert.deepEqual(p.diff.removed, []);
  assert.deepEqual(p.diff.selectedIds, ["old", "new"]);
  assert.equal(p.provenance.piAiVersion, "1.5.2");
  const r = await w.service.apply(p);
  assert.equal(r.result.status, "applied");
  assert.deepEqual(w.settings.raw.models, [{ id: "old", maxTokens: 777 }, { id: "new" }]);
  assert.equal(w.settings.mutations.length, 1);
  assert.equal((await w.service.apply(p)).idempotent, true);
});

for (const models of [null, []]) test(`supplement preserves automatic catalog (${models === null ? "absent" : "empty"}) and all overrides`, async () => {
  const raw = view(models, { old: { maxTokens: 777 } });
  const w = await world({ raw });
  const p = await preview(w);
  assert.equal(p.automaticCatalog, true);
  assert.equal(p.diff.writeSet.models, false);
  assert.deepEqual(p.diff.targetView, raw);
  assert.equal((await w.service.apply(p)).result.status, "applied");
  assert.deepEqual(w.settings.raw, raw);
  assert.equal(w.settings.mutations.length, 0);
  assert.ok(w.injected.has("new"));
});

test("automatic catalog verifies actual models and never rolls back untouched settings", async () => {
  const raw = view(null, { old: { maxTokens: 777 } });
  const w = await world({ raw, missingServed: true });
  const p = await preview(w);
  const r = await w.service.apply(p);
  assert.equal(r.result.status, "partial");
  assert.match(r.result.error, /registry-not-served: new/);
  assert.deepEqual(w.settings.raw, raw);
  assert.equal(w.settings.mutations.length, 0);
});

test("inherited explicit list is preserved including per-model customizations", async () => {
  const w = await world({ raw: view(null), effective: view([{ id: "old", maxTokens: 999 }]) });
  const p = await preview(w);
  assert.deepEqual(p.diff.targetView.models, [{ id: "old", maxTokens: 999 }, { id: "new" }]);
});

test("supplement retains revision and stale evidence safety gates", async () => {
  const w = await world(); const p = await preview(w); w.settings.revision++;
  await assert.rejects(() => w.service.apply(p), { code: "PREVIEW_STALE" });
  assert.equal(w.settings.mutations.length, 0);
  const offline = await world({ stale: true }); const q = await preview(offline);
  await assert.rejects(() => offline.service.apply(q), { code: "EVIDENCE_STALE" });
});

test("supplement mode rejects destructive flags and unknown selection modes", async () => {
  const w = await world();
  for (const body of [{ clearOverrides: true, selectionMode: "supplement" }, { selectedIds: [], selectionMode: "supplement" }, { selectionMode: "typo" }]) {
    await assert.rejects(() => w.service.preview({ operation: "manage", ...body }), { code: "INVALID_REQUEST" });
  }
});

test("agent tool exercises the same service and real transaction as UI", async () => {
  const w = await world(); let tool;
  registerModelTool({ tools: { register: (t) => { tool = t; return () => {}; } } }, w.service);
  const p = await tool.execute({ action: "preview", catalogSource: "latest", selectedIds: [], previewId: "", operationId: "" });
  assert.deepEqual(p.diff.removed, []);
  assert.equal((await tool.execute({ action: "apply", previewId: p.previewId, operationId: p.operationId })).result.status, "applied");
  assert.equal((await tool.execute({ action: "status", operationId: p.operationId })).query, "last");
  await assert.rejects(() => tool.execute({ action: "logout" }), /invalid-action/);
  await assert.rejects(() => tool.execute({ action: "preview-manual" }), /selectedIds required/);
  await assert.rejects(() => tool.execute({ action: "preview-manual", selectedIds: [] }), { code: "empty-target-unconfirmed" });
});

const liveMetadata = (endpoint, contextWindow, maxTokens) => ({
  name: "Server provided model", supported_endpoints: [endpoint],
  capabilities: { type: "chat", supports: { tool_calls: true, vision: true, streaming: true, reasoning_effort: ["low", "medium", "high"] },
    limits: { max_context_window_tokens: contextWindow, max_prompt_tokens: contextWindow, max_output_tokens: maxTokens } },
});
const liveIds = ["old", "gpt-6.2-sol", "gemini-4-carbon", "gemini-4-hydrogen", "gpt-5.6-sol-fast", "mai-code-2", "mai-code-2-flash"];
const liveRows = {
  "gpt-6.2-sol": liveMetadata("/responses", 1050000, 128000),
  "gemini-4-carbon": liveMetadata("/chat/completions", 1000000, 64000),
  "gemini-4-hydrogen": liveMetadata("/chat/completions", 1048576, 65536),
  "gpt-5.6-sol-fast": liveMetadata("/responses", 1050000, 128000),
  "mai-code-2": { ...liveMetadata("/responses", 1050000, 128000), supported_endpoints: ["/responses", "/chat/completions"] },
  "mai-code-2-flash": { ...liveMetadata("/responses", 1050000, 128000), supported_endpoints: ["/responses", "/chat/completions"] },
};
const oldCatalog = { catalogSource: "latest", provenance: { kind: "latest", piAiVersion: "1.5.2" }, newEntryCount: 0, resolvableIds: ["old"], addedOverlay: {} };

test("live account metadata bridges stale static catalog through real preview/apply kernel", async () => {
  const w = await world({ account: liveIds, metadata: liveRows, staticCatalog: oldCatalog });
  const p = await preview(w);
  assert.equal(p.discovery.accountCount, 7);
  assert.equal(p.discovery.resolvableCount, 7);
  assert.equal(p.discovery.added.length, 6);
  assert.deepEqual(p.discovery.unresolved, []);
  assert.equal(p.catalogNewEntries, 6);
  assert.deepEqual(p.diff.removed, []);
  assert.equal(p.provenance.liveAccount.models.length, 6);
  assert.equal((await w.service.apply(p)).result.status, "applied");
  const landed = w.landed.at(-1);
  assert.equal(landed["openai-responses"]["gpt-6.2-sol"].maxTokens, 128000);
  assert.equal(landed["openai-completions"]["gemini-4-carbon"].contextWindow, 1000000);
  assert.deepEqual(w.settings.raw.models[0], { id: "old", maxTokens: 777 });
  assert.equal(w.settings.raw.models.length, 7);
  const state = w.stateIO.load();
  assert.ok(state.appliedOverlay["openai-responses"]["gpt-6.2-sol"]);
  for (const id of ["mai-code-2", "mai-code-2-flash"]) {
    assert.equal(landed["openai-responses"][id].api, "openai-responses");
    assert.equal(landed["openai-completions"][id], undefined);
    assert.equal(state.appliedOverlay["openai-responses"][id].maxTokens, 128000);
    assert.ok(w.settings.raw.models.some((model) => model.id === id));
  }
  const cache = JSON.parse(readFileSync(join(w.scope.dataDir, "account-model-cache.json"), "utf8"));
  assert.deepEqual(Object.keys(cache).sort(), ["fetchedAt", "ids", "intentVersion"]);
  assert.equal(JSON.stringify(cache).includes("capabilities"), false);
});

test("dynamic automatic catalog is verified without materializing models or dropping overrides", async () => {
  const raw = view([], { old: { maxTokens: 777 } });
  const w = await world({ raw, account: liveIds, metadata: liveRows, staticCatalog: oldCatalog });
  const p = await preview(w);
  assert.equal(p.automaticCatalog, true);
  assert.equal((await w.service.apply(p)).result.status, "applied");
  assert.deepEqual(w.settings.raw, raw);
  assert.equal(w.settings.mutations.length, 0);
  assert.ok(w.injected.has("gpt-6.2-sol"));
  assert.ok(w.injected.has("gemini-4-carbon"));
});

test("persisted dynamic overlay replays through real boot recovery", async () => {
  const w = await world({ account: liveIds, metadata: liveRows, staticCatalog: oldCatalog });
  await w.service.apply(await preview(w));
  w.injected.delete("gpt-6.2-sol");
  w.injected.delete("gemini-4-carbon");
  await w.tx.bootRecover();
  assert.ok(w.injected.has("gpt-6.2-sol"));
  assert.ok(w.injected.has("gemini-4-carbon"));
  assert.equal(w.settings.mutations.length, 1);
});

test("automatic catalog crash residue does not verify an empty target instead of actual discovered IDs", async () => {
  const raw = view([], { old: { maxTokens: 777 } });
  const w = await world({ raw, account: liveIds, metadata: liveRows, staticCatalog: oldCatalog, missingServed: true });
  const p = await preview(w);
  await w.service.apply(p);
  const state = w.stateIO.load();
  state.activeOperation = {
    operationId: "crash-residue", phase: "catalog-landed", intentVersion: 1,
    targetView: raw, settingsBaseline: { view: raw, revision: 1 },
    verificationIds: ["gpt-6.2-sol", "gemini-4-carbon"], pendingOverlay: state.appliedOverlay,
    writeSet: { catalogEntries: true, models: false, modelOverrides: false },
  };
  w.stateIO.save(state);
  const recovered = await w.tx.bootRecover();
  assert.equal(recovered.status, "partial");
  assert.match(w.stateIO.load().lastResult.error, /registry-not-served: gpt-6.2-sol,gemini-4-carbon/);
  assert.equal(w.settings.mutations.length, 0);
});

test("cached account IDs do not invent missing metadata or authorize dynamic catalog creation", async () => {
  const w = await world({ account: liveIds, metadata: liveRows, staticCatalog: oldCatalog });
  await preview(w);
  w.network.stale = true;
  const cached = await preview(w);
  assert.equal(cached.discovery.source, "cache");
  assert.equal(cached.discovery.accountCount, 7);
  assert.equal(cached.discovery.resolvableCount, 1);
  assert.equal(cached.discovery.added.length, 0);
  assert.ok(cached.discovery.unresolved.every((r) => r.reason === "live-metadata-unavailable"));
});

test("live metadata does not overwrite existing catalog entries", async () => {
  const w = await world({ account: ["old"], metadata: { old: liveRows["gpt-6.2-sol"] }, staticCatalog: oldCatalog });
  const p = await preview(w);
  assert.equal(p.discovery.added.length, 0);
  assert.equal(p.catalogNewEntries, 0);
  assert.equal(p.discovery.resolvableCount, 1);
});
