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
