// copilot-models.mjs — GitHub Copilot 可用性适配（只读 GET /models）。
// ⚠️ 显式耦合 pi-ai 0.84.4：COPILOT_HEADERS / COPILOT_API_VERSION / normalizeDomain /
// getGitHubCopilotBaseUrl / parseGitHubCopilotModelCatalog 的语义逐行抄录自
// @earendil-works/pi-ai@0.84.4 dist/auth/oauth/github-copilot.js。
// 不实现 token 获取/policy 修改；token 刷新仅限 v1.2.21 起的 ephemeral 续期（见文末，
// 只存内存、绝不落库）；其余语义漂移或任何失败一律由调用方回退凭证缓存
// （payload.availableModelIds）。pi-ai 升级后本文件必须对照新版源码复核。
// v1.2.21 增抄：copilot_internal/v2/token 续期语义抄录自 pi-ai dist/auth/oauth/github-copilot.js
// refreshGitHubCopilotAccessToken（0.84.4 与 0.87.1 该函数 diff 为空）；ephemeral 使用、绝不落库。

// ↓↓↓ 以下常量抄录自 pi-ai 0.84.4 dist/auth/oauth/github-copilot.js（勿改值）
export const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};
const COPILOT_API_VERSION = "2026-06-01";
// ↑↑↑ 抄录结束

const INDIVIDUAL_DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";

// 抄录语义：trim → 空 → null；含 :// 直接 new URL，否则补 https://；取 hostname；异常 → null
function normalizeDomain(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

// 抄录语义：token 形如 tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
// proxy.xxx → api.xxx
function getBaseUrlFromToken(token) {
  const match = String(token ?? "").match(/proxy-ep=([^;]+)/);
  if (!match) return null;
  const proxyHost = match[1];
  const apiHost = proxyHost.replace(/^proxy\./, "api.");
  return `https://${apiHost}`;
}

// 抄录语义：token proxy-ep 优先 → enterprise copilot-api.<domain> → individual 缺省
export function copilotBaseUrl(access, enterpriseUrl) {
  const enterpriseDomain = normalizeDomain(enterpriseUrl);
  if (access) {
    const urlFromToken = getBaseUrlFromToken(access);
    if (urlFromToken) return urlFromToken;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return INDIVIDUAL_DEFAULT_BASE_URL;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function safeText(value, maxLength = 256) {
  return typeof value === "string" && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : undefined;
}

// No raw response object is retained. The nested allowlists are intentional:
// credentials, arbitrary headers/URLs, billing blobs and unknown fields must not
// leak through a diagnostic response or become persistent catalog metadata.
function sanitizeModel(item) {
  const out = { id: item.id };
  for (const key of ["name", "vendor", "version"]) {
    const value = safeText(item[key]);
    if (value !== undefined) out[key] = value;
  }
  if (typeof item.model_picker_enabled === "boolean") out.model_picker_enabled = item.model_picker_enabled;
  const policy = asRecord(item.policy);
  const policyState = safeText(policy?.state, 64);
  if (policyState !== undefined) out.policy = { state: policyState };
  const capabilities = asRecord(item.capabilities);
  if (capabilities) {
    const caps = {};
    for (const key of ["type", "family", "tokenizer"]) {
      const value = safeText(capabilities[key]);
      if (value !== undefined) caps[key] = value;
    }
    const limits = asRecord(capabilities.limits);
    if (limits) {
      caps.limits = {};
      for (const key of ["max_context_window_tokens", "max_prompt_tokens", "max_output_tokens"]) {
        if (typeof limits[key] === "number" && Number.isFinite(limits[key])) caps.limits[key] = limits[key];
      }
    }
    const supports = asRecord(capabilities.supports);
    if (supports) {
      caps.supports = {};
      for (const key of ["tool_calls", "parallel_tool_calls", "streaming", "vision", "prediction", "thinking", "adaptive_thinking"]) {
        if (typeof supports[key] === "boolean") caps.supports[key] = supports[key];
      }
      for (const key of ["max_thinking_budget", "min_thinking_budget"]) {
        if (typeof supports[key] === "number" && Number.isFinite(supports[key])) caps.supports[key] = supports[key];
      }
      if (Array.isArray(supports.reasoning_effort)) {
        caps.supports.reasoning_effort = supports.reasoning_effort.slice(0, 16)
          .filter((value) => ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value));
      }
    }
    out.capabilities = caps;
  }
  if (Array.isArray(item.supported_endpoints)) {
    // Keep unknown paths so the converter can explicitly reject future protocols,
    // but never trust a returned URL as a base URL or send credentials to it.
    const endpoints = item.supported_endpoints.map((value) => safeText(value, 128));
    out.supported_endpoints = endpoints.length > 16 || endpoints.some((value) => value === undefined)
      ? ["<invalid-supported-endpoints>"] : endpoints;
  }
  return out;
}

// Existing availability policy is unchanged: tool_calls === false is excluded;
// picker true + policy not disabled wins. Only an empty Individual primary set
// permits policy.state === enabled fallback. Metadata conversion is stricter.
function parseLiveModelCatalog(raw, allowPolicyFallback) {
  const data = asRecord(raw)?.data;
  if (!Array.isArray(data)) throw new Error("Invalid Copilot models response");
  const diagnostics = [];
  const accountModels = data.flatMap((rawItem) => {
    const item = asRecord(rawItem);
    if (!item || safeText(item.id) === undefined || item.id.length === 0) {
      diagnostics.push({ id: null, reason: "invalid-model-id" });
      return [];
    }
    if (asRecord(asRecord(item.capabilities)?.supports)?.tool_calls === false) {
      diagnostics.push({ id: item.id, reason: "tool-calls-disabled" });
      return [];
    }
    return [item];
  });
  const primary = accountModels.filter((item) => item.model_picker_enabled === true
    && asRecord(item.policy)?.state !== "disabled");
  const selected = primary.length > 0 || !allowPolicyFallback
    ? primary : accountModels.filter((item) => asRecord(item.policy)?.state === "enabled");
  const selectedSet = new Set(selected);
  for (const item of accountModels) {
    if (!selectedSet.has(item)) diagnostics.push({ id: item.id, reason: "not-account-available" });
  }
  const ids = [...new Set(selected.map((item) => item.id))];
  return { ids, models: selected.map(sanitizeModel), diagnostics };
}

// Read-only live metadata fetch; same credentials, headers, policy and 5s timeout
// as the former IDs-only path. No OAuth/policy mutations or persistent writes.
export async function fetchLiveModelCatalog({ credential, fetchImpl } = {}) {
  const access = credential?.access;
  if (!access || typeof fetchImpl !== "function") {
    throw new Error("credential.access and fetchImpl required");
  }
  const baseUrl = copilotBaseUrl(access, credential.enterpriseUrl);
  // 0.84.4 注释：部分 Individual 账号 picker 标志全 false 但 policy 显式 enabled，
  // 回退严格限定在 individual 端点。
  const allowPolicyFallback = baseUrl === INDIVIDUAL_DEFAULT_BASE_URL;
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${access}`,
      ...COPILOT_HEADERS,
      "X-GitHub-Api-Version": COPILOT_API_VERSION,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    // 携 status 供调用方证据分型（401/403 → token-rejected；其余 → network），与 refreshEphemeralAccess 同款
    throw Object.assign(new Error(`${response.status} ${response.statusText}: GET ${baseUrl}/models`), { status: response.status });
  }
  return parseLiveModelCatalog(await response.json(), allowPolicyFallback);
}

// Compatibility for callers which need availability evidence but not metadata.
export async function fetchLiveAvailableModelIds(options = {}) {
  return (await fetchLiveModelCatalog(options)).ids;
}

// 本地解析 access（tid 会话令牌）内的 exp=（秒 → 毫秒）；缺失/不可解析 → null。
// 零网络：调用方据此在发请求前判断"是否需要续期"。
export function parseAccessExpiryMs(access) {
  const match = String(access ?? "").match(/exp=(\d+)/);
  return match ? Number(match[1]) * 1000 : null;
}

// 铸一枚新的短命 tid：GET copilot_internal/v2/token（Bearer = 长期 ghu）。
// 语义抄录自 pi-ai refreshGitHubCopilotAccessToken（见文件头）；单次尝试、5s 超时、
// 不重试、结果仅存内存（调用方绝不写回凭据库）。HTTP 失败抛错并携 status 供分型
// （401/403 → 长期令牌被拒；其余/网络 → network）。错误消息保真对齐 0.87.1 L261/L264。
export async function refreshEphemeralAccess({ refreshToken, enterpriseUrl, fetchImpl } = {}) {
  if (typeof refreshToken !== "string" || refreshToken === "" || typeof fetchImpl !== "function") {
    throw new Error("refreshToken and fetchImpl required");
  }
  const domain = normalizeDomain(enterpriseUrl) ?? "github.com";
  const url = `https://api.${domain}/copilot_internal/v2/token`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${refreshToken}`,
      ...COPILOT_HEADERS,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`${response.status} ${response.statusText}: GET ${url}`), { status: response.status });
  }
  const raw = await response.json();
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Copilot token response");
  }
  const token = raw.token;
  const expiresAt = raw.expires_at;
  if (typeof token !== "string" || typeof expiresAt !== "number") {
    throw new Error("Invalid Copilot token response fields");
  }
  return { access: token, expiresAtMs: expiresAt * 1000 - 5 * 60 * 1000 };
}
