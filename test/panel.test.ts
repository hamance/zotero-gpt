import { assert } from "chai";
import { config } from "../package.json";

describe("docked panel", function () {
  this.timeout(45000);
  const cls = config.addonRef;
  const win: any = Zotero.getMainWindow();
  const doc: Document = win.document;
  const api = () => (Zotero as any)[config.addonInstance].api as any;
  const provider = () => api().provider;
  let host: HTMLElement;
  let origRequest: any = null;
  let savedCfg: any;

  before(() => {
    const c = provider().getConfig();
    savedCfg = {
      api: c.api,
      model: c.model,
      secretKey: c.secretKey,
      temperature: c.temperature,
      chatNumber: c.chatNumber,
    };
  });

  afterEach(() => {
    host?.remove();
    if (origRequest) {
      (Zotero as any).HTTP.request = origRequest;
      origRequest = null;
    }
  });

  after(() => {
    provider().setConfig(savedCfg);
  });

  // Mock Zotero.HTTP: POST streams SSE chunks; GET returns a /v1/models list.
  function mockHttp(streamText: string) {
    origRequest = (Zotero as any).HTTP.request;
    (Zotero as any).HTTP.request = async (method: string, _url: string, opts: any) => {
      if (method === "GET") {
        return { status: 200, response: { data: [{ id: "model-a" }, { id: "model-b" }] } };
      }
      const xhr: any = {
        responseText: "",
        status: 200,
        abort() {},
        onprogress: null as any,
        onload: null as any,
      };
      opts.requestObserver?.(xhr);
      const words = streamText.split(" ");
      for (let i = 0; i < words.length; i++) {
        const piece = (i ? " " : "") + words[i];
        xhr.responseText += `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`;
        xhr.onprogress?.();
        await Zotero.Promise.delay(8);
      }
      xhr.responseText += "data: [DONE]\n\n";
      xhr.onprogress?.();
      xhr.onload?.();
      return { status: 200, response: "" };
    };
  }

  it("is registered as an item-pane section and receives framework render callbacks", async function () {
    assert.isFunction(api().renderPanel, "render hook exposed");
    const before = api().panelRenderCount || 0;
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "framework callback check");
    await item.saveTx();
    await win.ZoteroPane.selectItem(item.id);
    let called = api().panelRenderCount > before;
    for (let i = 0; i < 20 && !called; i++) {
      await Zotero.Promise.delay(300);
      called = api().panelRenderCount > before;
    }
    assert.isTrue(called, "ItemPaneManager should invoke our onRender callback");
    assert.isAtLeast(api().panelInitCount, 1, "onInit should fire");
  });

  it("builds the chat UI and streams a provider reply inside a connected docked container", async function () {
    provider().setConfig({ api: "https://example.test/v1", model: "gpt-test", secretKey: "sk-test" });
    mockHttp("Streamed reply from provider");
    host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    doc.documentElement.appendChild(host);
    api().renderPanel(host);

    const panel = host.querySelector(`.${cls}-panel`) as HTMLElement;
    const input = panel.querySelector("textarea") as HTMLTextAreaElement;
    const send = panel.querySelector(`.${cls}-send`) as HTMLButtonElement;
    assert.ok(input && send, "input + send rendered");

    input.value = "Summarize this paper";
    send.click();
    await Zotero.Promise.delay(1200);

    const bubbles = Array.from(panel.querySelectorAll(`.${cls}-msg`)) as HTMLElement[];
    assert.isAtLeast(bubbles.length, 2, "user + assistant bubbles present");
    assert.ok(
      bubbles.some((b) => b.className.includes("user") && /Summarize/.test(b.textContent || "")),
      "user bubble",
    );
    assert.ok(
      bubbles.some(
        (b) => b.className.includes("assistant") && /Streamed reply from provider/.test(b.textContent || ""),
      ),
      "assistant reply streamed from the OpenAI-compatible provider",
    );
  });

  it("exposes a settings form that persists provider config and discovers models", async function () {
    host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    doc.documentElement.appendChild(host);
    api().renderPanel(host);
    const panel = host.querySelector(`.${cls}-panel`) as HTMLElement;
    const gear = panel.querySelector(`.${cls}-gear`) as HTMLButtonElement;
    const settings = panel.querySelector(`.${cls}-settings`) as HTMLElement;
    assert.ok(settings.hidden, "settings hidden by default");
    gear.click();
    assert.notOk(settings.hidden, "settings shown after clicking the gear");

    const sApi = panel.querySelector(`.${cls}-s-api`) as HTMLInputElement;
    const sKey = panel.querySelector(`.${cls}-s-key`) as HTMLInputElement;
    const sModel = panel.querySelector(`.${cls}-s-model`) as HTMLInputElement;
    const sTemp = panel.querySelector(`.${cls}-s-temp`) as HTMLInputElement;
    assert.ok(sApi && sKey && sModel && sTemp, "settings fields rendered");

    sApi.value = "https://my.proxy/v1";
    sKey.value = "sk-123";
    sModel.value = "my-model";
    sTemp.value = "0.3";
    (panel.querySelector(`.${cls}-s-save`) as HTMLButtonElement).click();

    const cfg = provider().getConfig();
    assert.equal(cfg.api, "https://my.proxy/v1");
    assert.equal(cfg.secretKey, "sk-123");
    assert.equal(cfg.model, "my-model");
    assert.approximately(cfg.temperature, 0.3, 1e-9);
    assert.ok(settings.hidden, "settings collapse after save");

    mockHttp("unused");
    gear.click(); // reopen settings
    (panel.querySelector(`.${cls}-s-refresh`) as HTMLButtonElement).click();
    await Zotero.Promise.delay(300);
    const values = Array.from(panel.querySelectorAll(`#${cls}-models option`)).map(
      (o) => (o as HTMLOptionElement).value,
    );
    assert.includeMembers(values, ["model-a", "model-b"], "datalist populated from /v1/models");
  });

  it("does not register the old floating position:fixed overlay", function () {
    assert.equal(doc.querySelectorAll(`#${config.addonRef}`).length, 0);
  });
});
