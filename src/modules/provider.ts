export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderHandle {
  cancel: () => void;
}

/**
 * Stream a chat reply. `onDelta` receives incremental text; the final full
 * text is returned. Stage 3 will replace the stub with an OpenAI-compatible
 * request (POST {api}/v1/chat/completions, SSE parsing) driven by prefs
 * (base URL, model, secret key).
 */
export async function streamChat(
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
): Promise<string> {
  // --- STAGE 3 PLACEHOLDER ------------------------------------------------
  // Simulate a streaming reply so the panel wiring is fully testable now.
  const reply =
    "Provider is not wired yet (Stage 3). " +
    "Configure your OpenAI-compatible base URL, model, and API key in settings, " +
    "then this panel will stream ChatGPT replies here.";
  const tokens = reply.split(" ");
  let full = "";
  for (let i = 0; i < tokens.length; i++) {
    const chunk = (i ? " " : "") + tokens[i];
    full += chunk;
    onDelta(chunk);
    await new Promise((r) => setTimeout(r, 35));
  }
  return full;
}
