// live-catalog.mjs — Conservative catalog synthesis from Copilot GET /models.
// This is an additive bridge when the published pi-ai catalog lags the account.
// Wire protocol and numeric limits must come from explicit server metadata, never
// from model names, vendors, speculative defaults, or another model's template.
// Public schema: microsoft/vscode-copilot-chat src/platform/endpoint/common/endpointProvider.ts.
import { validateCatalog } from "./catalog.mjs";
import { COPILOT_HEADERS } from "./copilot-models.mjs";

const BASE_URL = "https://api.individual.githubcopilot.com";
const ENDPOINT_API = new Map([
  ["/chat/completions", "openai-completions"],
  ["/responses", "openai-responses"],
  ["/v1/messages", "anthropic-messages"],
]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function idSet(value) {
  return new Set(value instanceof Set ? value : Array.isArray(value) ? value : []);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function protocolFor(id, endpoints) {
  if (!Array.isArray(endpoints) || endpoints.length === 0) return { reason: "missing-supported-endpoints" };
  const protocols = new Set();
  let hasWebSocket = false;
  for (const endpoint of endpoints) {
    if (endpoint === "ws:/responses") {
      hasWebSocket = true;
      continue;
    }
    const api = ENDPOINT_API.get(endpoint);
    if (!api) return { reason: "unknown-supported-endpoint" };
    protocols.add(api);
  }
  if (protocols.size === 0) return { reason: "unsupported-websocket-only-endpoint" };
  // 2026-11-18, Copilot + pi-ai 1.3.0: both exact IDs advertised these two
  // HTTP endpoints. Responses returned OK; Chat Completions returned 400.
  // Restrict the preference to the observed endpoint set; do not infer by name
  // or select a protocol for other ambiguous announcements.
  if ((id === "mai-code-2" || id === "mai-code-2-flash") && !hasWebSocket
    && protocols.size === 2 && protocols.has("openai-responses") && protocols.has("openai-completions")) {
    return { api: "openai-responses" };
  }
  if (protocols.size !== 1 || (hasWebSocket && !protocols.has("openai-responses"))) {
    return { reason: "ambiguous-supported-endpoints" };
  }
  return { api: [...protocols][0] };
}

// models are the allowlisted fetchLiveModelCatalog().models, but validate again
// to keep this pure conversion safe for independent callers and persisted inputs.
// availableIds is mandatory availability evidence; existingIds is only a guard.
// Return the same added/skipped row conventions as mergeCatalog; no mutation.
export function buildLiveCatalog({ models, availableIds, existingIds } = {}) {
  const available = idSet(availableIds);
  const existing = idSet(existingIds);
  const catalog = {};
  const added = [];
  const skipped = [];
  const grouped = new Map();
  for (const candidate of Array.isArray(models) ? models : []) {
    const model = record(candidate);
    const id = model?.id;
    if (typeof id !== "string" || id.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) {
      skipped.push({ id: null, reason: "invalid-model-id" });
      continue;
    }
    if (existing.has(id)) continue;
    if (!available.has(id)) {
      skipped.push({ id, reason: "not-account-available" });
      continue;
    }
    const group = grouped.get(id) ?? [];
    group.push(model);
    grouped.set(id, group);
  }
  for (const [id, group] of grouped) {
    // Duplicate IDs are not resolved by first/last wins: a different protocol or
    // limit on a second row would otherwise silently create an unsafe catalog.
    if (group.length !== 1) {
      skipped.push({ id, reason: "duplicate-model-id" });
      continue;
    }
    const model = group[0];
    const reject = (reason) => skipped.push({ id, reason });
    const caps = record(model.capabilities);
    const supports = record(caps?.supports);
    const limits = record(caps?.limits);
    if (caps?.type !== "chat") { reject("chat-capability-not-confirmed"); continue; }
    if (supports?.tool_calls !== true) { reject("tool-calls-not-confirmed"); continue; }
    if (supports.streaming !== true) { reject("streaming-not-confirmed"); continue; }
    if (model.policy?.state === "disabled") { reject("policy-disabled"); continue; }
    const protocol = protocolFor(id, model.supported_endpoints);
    if (!protocol.api) { reject(protocol.reason); continue; }
    const contextWindow = limits?.max_context_window_tokens;
    const maxTokens = limits?.max_output_tokens;
    if (!positiveInteger(contextWindow)) { reject("missing-or-invalid-context-window"); continue; }
    if (!positiveInteger(maxTokens)) { reject("missing-or-invalid-output-limit"); continue; }
    if (maxTokens > contextWindow || (limits.max_prompt_tokens !== undefined
      && (!positiveInteger(limits.max_prompt_tokens) || limits.max_prompt_tokens > contextWindow))) {
      reject("inconsistent-token-limits");
      continue;
    }
    const reasoning = supports.thinking === true || supports.adaptive_thinking === true
      || (Array.isArray(supports.reasoning_effort)
        && supports.reasoning_effort.some((effort) => ["minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)));
    const name = typeof model.name === "string" && model.name.length > 0 && model.name.length <= 256
      && !/[\u0000-\u001f\u007f]/.test(model.name) ? model.name : id;
    const entry = {
      id,
      name,
      type: "chat",
      api: protocol.api,
      provider: "github-copilot",
      baseUrl: BASE_URL,
      reasoning,
      input: supports.vision === true ? ["text", "image"] : ["text"],
      // Copilot is billed by account entitlement/requests, not public token
      // prices in this response. Zero is pi-ai's accounting placeholder, NOT a
      // claim that model requests are free or consume no premium quota.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      headers: { ...COPILOT_HEADERS },
    };
    if (reasoning && Array.isArray(supports.reasoning_effort) && supports.reasoning_effort.length > 0) {
      const efforts = new Set(supports.reasoning_effort);
      // pi-ai uses null to disable a level and identity values to expose xhigh/
      // max. Do not offer unsupported levels or guess an equivalent effort.
      entry.thinkingLevelMap = Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .map((level) => [level, level === "off" ? (efforts.has("none") ? "none" : null)
          : efforts.has(level) ? level : null]));
    }
    const valid = validateCatalog(protocol.api, id, entry);
    if (valid !== true) { reject(valid); continue; }
    (catalog[protocol.api] ??= {})[id] = entry;
    added.push({ id, api: protocol.api });
  }
  return { catalog, added, skipped };
}
