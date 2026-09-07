import { assert } from "chai";
import { config } from "../package.json";

describe("chat provider", function () {
  this.timeout(20000);
  const api = () => (Zotero as any)[config.addonInstance].api as any;
  const provider = () => api().provider;
  let origRequest: any = null;
  let saved: any;

  before(() => {
    const c = provider().getConfig();
    saved = {
      api: c.api,
      model: c.model,
      secretKey: c.secretKey,
      temperature: c.temperature,
      chatNumber: c.chatNumber,
    };
  });

  afterEach(() => {
    if (origRequest) {
      (Zotero as any).HTTP.request = origRequest;
      origRequest = null;
    }
  });

  after(() => {
    provider().setConfig(saved);
  });

  it("normalizes base URLs (trailing slash and a trailing /v1)", () => {
    const p = provider();
    assert.equal(p.normalizeBaseUrl("https://api.openai.com/"), "https://api.openai.com");
    assert.equal(p.normalizeBaseUrl("https://x.com/v1"), "https://x.com");
    assert.equal(p.normalizeBaseUrl("https://x.com/v1/"), "https://x.com");
    assert.equal(p.normalizeBaseUrl("  http://localhost:11434/v1  "), "http://localhost:11434");
    assert.equal(p.chatEndpoint("https://x.com/v1"), "https://x.com/v1/chat/completions");
    assert.equal(p.modelsEndpoint("https://x.com"), "https://x.com/v1/models");
  });

  it("parses SSE data lines into content deltas", () => {
    const p = provider();
    assert.isNull(p.deltaFromSSELine(""));
    assert.isNull(p.deltaFromSSELine(": keep-alive"));
    assert.isNull(p.deltaFromSSELine("data: [DONE]"));
    assert.isNull(p.deltaFromSSELine("data: not-json"));
    assert.equal(
      p.deltaFromSSELine('data: {"choices":[{"delta":{"content":"Hi"}}]}'),
      "Hi",
    );
    assert.equal(
      p.deltaFromSSELine('data: {"choices":[{"message":{"content":"there"}}]}'),
      "there",
    );
    assert.isNull(p.deltaFromSSELine('data: {"choices":[{"delta":{"role":"assistant"}}]}'));
  });

  it("reports a config error when the base URL or model is missing", () => {
    const p = provider();
    assert.isNull(p.configError(p.getConfig()));
    assert.isString(
      p.configError({ api: "", model: "m", secretKey: "", temperature: 1, chatNumber: 12 }),
    );
    assert.isString(
      p.configError({ api: "https://x", model: "", secretKey: "", temperature: 1, chatNumber: 12 }),
    );
  });

  it("round-trips provider config through addon prefs", () => {
    const p = provider();
    p.setConfig({ model: "test-model-xyz", temperature: 0.7, secretKey: "test-key" });
    const cfg = p.getConfig();
    assert.equal(cfg.model, "test-model-xyz");
    assert.equal(cfg.secretKey, "test-key");
    assert.approximately(cfg.temperature, 0.7, 1e-9);
  });

  it("fails soft on model discovery when the endpoint is unreachable", async function () {
    const p = provider();
    p.setConfig({ api: "http://127.0.0.1:9", secretKey: "" });
    const models = await p.listModels();
    assert.deepEqual(models, []);
  });

  it("streams a chat completion and sends the expected request", async function () {
    const p = provider();
    p.setConfig({ api: "https://example.test/v1", model: "gpt-test", secretKey: "sk-test", temperature: 0.4 });
    let captured: any = {};
    origRequest = (Zotero as any).HTTP.request;
    (Zotero as any).HTTP.request = async (method: string, url: string, opts: any) => {
      captured = { method, url, opts };
      const xhr: any = {
        responseText: "",
        status: 200,
        abort() {},
        onprogress: null as any,
        onload: null as any,
      };
      opts.requestObserver?.(xhr);
      for (const c of [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        "data: [DONE]\n\n",
      ]) {
        xhr.responseText += c;
        xhr.onprogress?.();
        await Zotero.Promise.delay(10);
      }
      xhr.onload?.();
      return { status: 200, response: "" };
    };

    const deltas: string[] = [];
    const stream = p.streamChat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      (d: string) => deltas.push(d),
    );
    const full = await stream.done;
    assert.equal(full, "Hello world");
    assert.deepEqual(deltas, ["Hello", " world"]);
    assert.equal(captured.method, "POST");
    assert.equal(captured.url, "https://example.test/v1/chat/completions");
    assert.equal(captured.opts.headers.Authorization, "Bearer sk-test");
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.model, "gpt-test");
    assert.isTrue(body.stream);
    assert.equal(body.temperature, 0.4);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[body.messages.length - 1].content, "hi");
  });

  it("omits the Authorization header for keyless local servers", async function () {
    const p = provider();
    p.setConfig({ api: "http://localhost:11434", secretKey: "", model: "local" });
    let headers: any = {};
    origRequest = (Zotero as any).HTTP.request;
    (Zotero as any).HTTP.request = async (method: string, url: string, opts: any) => {
      headers = opts.headers;
      const xhr: any = {
        responseText: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        status: 200,
        abort() {},
        onprogress: null as any,
        onload: null as any,
      };
      opts.requestObserver?.(xhr);
      xhr.onprogress?.();
      xhr.onload?.();
      return { status: 200, response: "" };
    };
    const stream = p.streamChat([{ role: "user", content: "hi" }], () => {});
    const full = await stream.done;
    assert.equal(full, "ok");
    assert.isUndefined(headers.Authorization);
  });

  it("rejects with a clear error when no model is configured", async function () {
    const p = provider();
    p.setConfig({ api: "https://example.test", model: "" });
    let threw = "";
    try {
      await p.streamChat([{ role: "user", content: "hi" }], () => {}).done;
    } catch (e: any) {
      threw = e?.message || String(e);
    }
    assert.match(threw, /model/i);
  });
});
