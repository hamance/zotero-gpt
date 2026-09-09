import { config } from "../../package.json";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatConfig {
  api: string;
  secretKey: string;
  model: string;
  temperature: number;
  chatNumber: number;
  /** Assumed context window (tokens) of the configured model, for the usage chip. */
  contextLimit: number;
}

export interface ChatStream {
  done: Promise<string>;
  cancel: () => void;
}

const REF = config.addonRef;
const prefKey = (name: string) => `${REF}.${name}`;

function getPref(name: string, fallback: unknown): unknown {
  try {
    const v = Zotero.Prefs.get(prefKey(name));
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** Read the chat provider configuration from addon prefs. */
export function getConfig(): ChatConfig {
  return {
    api: String(getPref("api", "https://api.openai.com") ?? ""),
    secretKey: String(getPref("secretKey", "") ?? ""),
    model: String(getPref("model", "gpt-4o-mini") ?? ""),
    temperature: Number(getPref("temperature", 1.0)) || 1.0,
    chatNumber: Number(getPref("chatNumber", 12)) || 12,
    contextLimit: Number(getPref("contextLimit", 128000)) || 128000,
  };
}

/** Persist a partial chat provider configuration to addon prefs. */
export function setConfig(patch: Partial<ChatConfig>): void {
  const entries: Array<[string, unknown]> = [
    ["api", patch.api],
    ["secretKey", patch.secretKey],
    ["model", patch.model],
    ["temperature", patch.temperature],
    ["chatNumber", patch.chatNumber],
    ["contextLimit", patch.contextLimit],
  ];
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    Zotero.Prefs.set(prefKey(name), value as string | number | boolean);
  }
}

/**
 * Normalize a user-entered base URL: trim whitespace, drop trailing slashes
 * and a trailing `/v1` so callers can always append `/v1/...`.
 * `https://x.com/v1/` -> `https://x.com`; `https://x.com` -> `https://x.com`.
 */
export function normalizeBaseUrl(raw: string): string {
  let u = (raw || "").trim().replace(/\/+$/, "");
  u = u.replace(/\/v1$/i, "").replace(/\/+$/, "");
  return u;
}

export const chatEndpoint = (base: string) =>
  `${normalizeBaseUrl(base)}/v1/chat/completions`;
export const modelsEndpoint = (base: string) =>
  `${normalizeBaseUrl(base)}/v1/models`;

/** Return a human-readable configuration error, or null when ready to chat. */
export function configError(cfg: ChatConfig): string | null {
  if (!cfg.api.trim()) return "API base URL is not set.";
  if (!cfg.model.trim()) return "Chat model is not set.";
  return null;
}

/**
 * Parse one Server-Sent-Events line into a text delta.
 * Handles `data: {json}`, `data: [DONE]`, comments, and blank lines;
 * returns null for anything without incremental content.
 */
export function deltaFromSSELine(line: string): string | null {
  const t = (line || "").trim();
  if (!t.startsWith("data:")) return null;
  const data = t.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    const json = JSON.parse(data);
    const choice = json?.choices?.[0];
    const delta = choice?.delta?.content ?? choice?.message?.content;
    return typeof delta === "string" && delta.length ? delta : null;
  } catch {
    return null;
  }
}

function extractError(response: unknown, status: unknown, url: string): string {
  try {
    const obj =
      typeof response === "string" && response.length
        ? JSON.parse(response)
        : response;
    const message =
      (obj as any)?.error?.message || (obj as any)?.message || "";
    if (message) return status ? `(${status}) ${message}` : String(message);
  } catch {
    /* fall through */
  }
  return status ? `Request to ${url} failed (${status}).` : `Request to ${url} failed.`;
}

/**
 * Stream a chat completion from any OpenAI-compatible endpoint.
 * POST {api}/v1/chat/completions with `Authorization: Bearer <key>` (omitted
 * for blank keys, e.g. local servers), `stream: true`; parses SSE deltas.
 * Leading system messages are always preserved; the rest are trimmed to the
 * `chatNumber` history window. There is no fallback provider — a missing
 * configuration or failed request rejects with a clear error.
 */
export function streamChat(
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
): ChatStream {
  const cfg = getConfig();
  const problem = configError(cfg);
  if (problem) {
    return { done: Promise.reject(new Error(problem)), cancel: () => {} };
  }

  const url = chatEndpoint(cfg.api);
  const system = messages.filter((m) => m.role === "system");
  const history = messages.filter((m) => m.role !== "system");
  const body = JSON.stringify({
    model: cfg.model,
    messages: [...system, ...history.slice(-Math.max(1, cfg.chatNumber))],
    stream: true,
    temperature: cfg.temperature,
  });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.secretKey.trim()) {
    headers["Authorization"] = `Bearer ${cfg.secretKey.trim()}`;
  }

  let xhr: XMLHttpRequest | null = null;
  let cancelled = false;
  let buffer = "";
  let consumed = 0;
  let accumulated = "";

  const pump = () => {
    if (!xhr) return;
    const full = (xhr as any).responseText || "";
    buffer += full.slice(consumed);
    consumed = full.length;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const delta = deltaFromSSELine(line);
      if (delta) {
        accumulated += delta;
        try {
          onDelta(delta);
        } catch {}
      }
    }
  };

  const done = (async () => {
    try {
      const res: any = await (Zotero as any).HTTP.request("POST", url, {
        headers,
        body,
        responseType: "text",
        timeout: 120000,
        requestObserver: (req: XMLHttpRequest) => {
          xhr = req;
          req.onprogress = () => pump();
          req.onload = () => pump();
        },
      });
      pump();
      const status = res?.status ?? (xhr as any)?.status ?? 200;
      if (status >= 400) {
        throw new Error(extractError(res?.response, status, url));
      }
      return accumulated;
    } catch (e: any) {
      if (cancelled) return accumulated;
      const status = e?.status ?? (xhr as any)?.status;
      const resp = e?.xmlhttp?.response ?? e?.response;
      throw new Error(extractError(resp, status, url) || e?.message || "Request failed");
    }
  })();

  return {
    done,
    cancel: () => {
      cancelled = true;
      try {
        xhr?.abort();
      } catch {}
    },
  };
}

/**
 * Discover available chat models via GET {api}/v1/models.
 * Fails soft: any error (missing/non-standard endpoint, network, auth)
 * returns an empty list so the caller can fall back to a typed model id.
 */
export async function listModels(): Promise<string[]> {
  const cfg = getConfig();
  if (!cfg.api.trim()) return [];
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cfg.secretKey.trim()) {
      headers["Authorization"] = `Bearer ${cfg.secretKey.trim()}`;
    }
    const res: any = await (Zotero as any).HTTP.request(
      "GET",
      modelsEndpoint(cfg.api),
      { headers, responseType: "json", timeout: 10000 },
    );
    const payload = res?.response ?? res;
    const data = payload?.data ?? payload;
    if (Array.isArray(data)) {
      return data
        .map((m: any) => (typeof m === "string" ? m : m?.id))
        .filter((id: unknown) => typeof id === "string" && id.length > 0)
        .sort() as string[];
    }
    return [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Embeddings (OpenAI-compatible, e.g. OpenAI / Ollama / LM Studio / TEI)
// ---------------------------------------------------------------------------

export interface EmbedConfig {
  enabled: boolean;
  api: string;
  secretKey: string;
  model: string;
  providerType: string;
  dim: string;
}

export function getEmbedConfig(): EmbedConfig {
  return {
    enabled: Boolean(getPref("embedEnabled", true)),
    api: String(getPref("embedApi", "") ?? ""),
    secretKey: String(getPref("embedSecretKey", "") ?? ""),
    model: String(getPref("embedModel", "text-embedding-3-small") ?? ""),
    providerType: String(getPref("embedProviderType", "openai") ?? ""),
    dim: String(getPref("embedDim", "") ?? ""),
  };
}

export function setEmbedConfig(patch: Partial<EmbedConfig>): void {
  const entries: Array<[string, unknown]> = [
    ["embedEnabled", patch.enabled],
    ["embedApi", patch.api],
    ["embedSecretKey", patch.secretKey],
    ["embedModel", patch.model],
    ["embedProviderType", patch.providerType],
    ["embedDim", patch.dim],
  ];
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    Zotero.Prefs.set(prefKey(name), value as string | number | boolean);
  }
}

export const embedEndpoint = (base: string) =>
  `${normalizeBaseUrl(base)}/v1/embeddings`;

export function embedConfigError(cfg: EmbedConfig): string | null {
  if (!cfg.enabled) return "Embeddings are disabled.";
  if (!cfg.api.trim()) return "Embedding API base URL is not set.";
  if (!cfg.model.trim()) return "Embedding model is not set.";
  return null;
}

/**
 * Embed a list of texts with an OpenAI-compatible `/v1/embeddings` endpoint.
 * The `Authorization` header is omitted when the key is blank (local servers).
 * Returns one vector per input text.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const cfg = getEmbedConfig();
  const problem = embedConfigError(cfg);
  if (problem) throw new Error(problem);
  if (!texts.length) return [];

  const url = embedEndpoint(cfg.api);
  const body: Record<string, unknown> = {
    model: cfg.model,
    input: texts,
  };
  const dim = Number(cfg.dim);
  if (Number.isFinite(dim) && dim > 0) {
    body.dimensions = dim;
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.secretKey.trim()) {
    headers["Authorization"] = `Bearer ${cfg.secretKey.trim()}`;
  }

  try {
    const res: any = await (Zotero as any).HTTP.request("POST", url, {
      headers,
      body: JSON.stringify(body),
      responseType: "json",
      timeout: 120000,
    });
    const payload = res?.response ?? res;
    const status = res?.status ?? 200;
    if (status >= 400) {
      throw new Error(extractError(payload, status, url));
    }
    const data = payload?.data;
    if (!Array.isArray(data)) {
      throw new Error(`Unexpected embeddings response from ${url}`);
    }
    const vectors = data.map((d: any) => d?.embedding);
    if (!vectors.every((v: any) => Array.isArray(v))) {
      throw new Error(`Unexpected embeddings response from ${url}`);
    }
    const dims = (vectors as any[][]).map((v) => v.length);
    if (new Set(dims).size > 1) {
      throw new Error(
        `Embedding dimension mismatch: ${Array.from(new Set(dims)).join(", ")}`,
      );
    }
    if (Number.isFinite(dim) && dim > 0 && dims[0] !== dim) {
      throw new Error(
        `Embedding returned ${dims[0]} dims, expected ${dim} (model "${cfg.model}").`,
      );
    }
    return vectors as number[][];
  } catch (e: any) {
    if (e instanceof Error) throw e;
    throw new Error(extractError(e?.response ?? e?.xmlhttp?.response, e?.status, url));
  }
}

/** Discover embedding models via GET {embedApi}/v1/models (fail-soft). */
export async function listEmbedModels(): Promise<string[]> {
  const cfg = getEmbedConfig();
  if (!cfg.enabled || !cfg.api.trim()) return [];
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (cfg.secretKey.trim()) {
      headers["Authorization"] = `Bearer ${cfg.secretKey.trim()}`;
    }
    const res: any = await (Zotero as any).HTTP.request(
      "GET",
      modelsEndpoint(cfg.api),
      { headers, responseType: "json", timeout: 10000 },
    );
    const payload = res?.response ?? res;
    const data = payload?.data ?? payload;
    if (Array.isArray(data)) {
      return data
        .map((m: any) => (typeof m === "string" ? m : m?.id))
        .filter((id: unknown) => typeof id === "string" && id.length > 0)
        .sort() as string[];
    }
    return [];
  } catch {
    return [];
  }
}
