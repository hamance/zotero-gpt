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
  let savedEmbed: any;

  before(() => {
    const c = provider().getConfig();
    savedCfg = {
      api: c.api,
      model: c.model,
      secretKey: c.secretKey,
      temperature: c.temperature,
      chatNumber: c.chatNumber,
    };
    const e = provider().getEmbedConfig();
    savedEmbed = {
      enabled: e.enabled,
      api: e.api,
      secretKey: e.secretKey,
      model: e.model,
      providerType: e.providerType,
      dim: e.dim,
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
    provider().setEmbedConfig(savedEmbed);
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

  it("shows a labeled settings toggle and persists chat + embedding config", async function () {
    host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    doc.documentElement.appendChild(host);
    api().renderPanel(host);
    const panel = host.querySelector(`.${cls}-panel`) as HTMLElement;
    const toggle = panel.querySelector(`.${cls}-s-toggle`) as HTMLButtonElement;
    const settings = panel.querySelector(`.${cls}-settings`) as HTMLElement;
    assert.ok(toggle, "labeled settings toggle rendered");
    assert.ok((toggle.textContent || "").length > 0, "toggle has a visible text label");
    assert.notOk(settings.hidden, "settings open by default for first-run configuration");

    const sApi = panel.querySelector(`.${cls}-s-api`) as HTMLInputElement;
    const sKey = panel.querySelector(`.${cls}-s-key`) as HTMLInputElement;
    const sModel = panel.querySelector(`.${cls}-s-model`) as HTMLInputElement;
    const sTemp = panel.querySelector(`.${cls}-s-temp`) as HTMLInputElement;
    const eEnabled = panel.querySelector(`.${cls}-e-enabled`) as HTMLInputElement;
    const eApi = panel.querySelector(`.${cls}-e-api`) as HTMLInputElement;
    const eKey = panel.querySelector(`.${cls}-e-key`) as HTMLInputElement;
    const eModel = panel.querySelector(`.${cls}-e-model`) as HTMLInputElement;
    const eType = panel.querySelector(`.${cls}-e-type`) as HTMLSelectElement;
    const eDim = panel.querySelector(`.${cls}-e-dim`) as HTMLInputElement;
    assert.ok(sApi && sKey && sModel && sTemp, "chat settings fields rendered");
    assert.ok(eEnabled && eApi && eKey && eModel && eType && eDim, "embedding settings fields rendered");

    sApi.value = "https://my.proxy/v1";
    sKey.value = "sk-123";
    sModel.value = "my-model";
    sTemp.value = "0.3";
    eEnabled.checked = true;
    eApi.value = "http://localhost:11434";
    eKey.value = "";
    eModel.value = "nomic-embed-text";
    eType.value = "openai";
    eDim.value = "768";
    (panel.querySelector(`.${cls}-s-save`) as HTMLButtonElement).click();

    const cfg = provider().getConfig();
    assert.equal(cfg.api, "https://my.proxy/v1");
    assert.equal(cfg.secretKey, "sk-123");
    assert.equal(cfg.model, "my-model");
    assert.approximately(cfg.temperature, 0.3, 1e-9);
    const ecfg = provider().getEmbedConfig();
    assert.isTrue(ecfg.enabled);
    assert.equal(ecfg.api, "http://localhost:11434");
    assert.equal(ecfg.secretKey, "");
    assert.equal(ecfg.model, "nomic-embed-text");
    assert.equal(ecfg.providerType, "openai");
    assert.equal(ecfg.dim, "768");
    assert.ok(settings.hidden, "settings collapse after save");

    toggle.click(); // reopen via the labeled button
    assert.notOk(settings.hidden, "settings reopen from the labeled toggle");
  });

  it("discovers chat and embedding models into their datalists", async function () {
    mockHttp("unused");
    host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    doc.documentElement.appendChild(host);
    api().renderPanel(host);
    const panel = host.querySelector(`.${cls}-panel`) as HTMLElement;
    (panel.querySelector(`.${cls}-s-refresh`) as HTMLButtonElement).click();
    (panel.querySelector(`.${cls}-e-refresh`) as HTMLButtonElement).click();
    await Zotero.Promise.delay(400);
    const chatValues = Array.from(panel.querySelectorAll(`#${cls}-models option`)).map(
      (o) => (o as HTMLOptionElement).value,
    );
    const embedValues = Array.from(panel.querySelectorAll(`#${cls}-embed-models option`)).map(
      (o) => (o as HTMLOptionElement).value,
    );
    assert.includeMembers(chatValues, ["model-a", "model-b"], "chat datalist populated");
    assert.includeMembers(embedValues, ["model-a", "model-b"], "embedding datalist populated");
  });

  it("keeps the section header and injected body intact (l10n must not wipe DOM)", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "structure guard");
    await item.saveTx();
    await win.ZoteroPane.selectItem(item.id);
    let section = doc.querySelector("item-pane-custom-section") as HTMLElement | null;
    for (let i = 0; i < 20 && !section; i++) {
      await Zotero.Promise.delay(300);
      section = doc.querySelector("item-pane-custom-section") as HTMLElement | null;
    }
    assert.ok(section, "custom section registered and connected");
    const collapsible = section!.querySelector("collapsible-section") as HTMLElement;
    assert.ok(collapsible, "collapsible-section present");
    // Header title comes from the .label attribute, not textContent, so the
    // framework-injected head/body children survive Fluent translation.
    assert.equal(collapsible.getAttribute("label"), "Zotero GPT");
    assert.ok(collapsible.querySelector(".head"), "section head survives");
    const body = section!.querySelector('[data-type="body"]') as HTMLElement | null;
    assert.ok(body, "body container survives");
    const panel = body?.querySelector(`.${cls}-panel`) as HTMLElement | null;
    assert.ok(panel, "chat panel present inside body");
    assert.equal(
      doc.defaultView!.getComputedStyle(panel!).display,
      "flex",
      "panel styles are applied in the real document",
    );
    const rect = panel!.getBoundingClientRect();
    assert.isAbove(rect.width, 0, "panel laid out with real width");
    assert.isAbove(rect.height, 0, "panel laid out with real height");
  });

  it("does not register the old floating position:fixed overlay", function () {
    assert.equal(doc.querySelectorAll(`#${config.addonRef}`).length, 0);
  });
});
