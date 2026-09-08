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
    // The framework sets data-l10n-id and Fluent DOM fills the label attribute
    // asynchronously, so poll briefly before asserting.
    let label = collapsible.getAttribute("label");
    for (let i = 0; i < 10 && label !== "Zotero GPT"; i++) {
      await Zotero.Promise.delay(100);
      label = collapsible.getAttribute("label");
    }
    assert.equal(label, "Zotero GPT");
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


  it("keeps separate conversation threads per item (context division)", async function () {
    provider().setConfig({ api: "https://example.test/v1", model: "gpt-test", secretKey: "sk-test" });
    mockHttp("Reply for A");
    const itemA = new Zotero.Item("journalArticle");
    itemA.setField("title", "Thread Paper A");
    await itemA.saveTx();
    const itemB = new Zotero.Item("journalArticle");
    itemB.setField("title", "Thread Paper B");
    await itemB.saveTx();

    host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    doc.documentElement.appendChild(host);
    api().renderPanel(host, itemA.id);
    const panel = host.querySelector(`.${cls}-panel`) as HTMLElement;
    const input = panel.querySelector("textarea") as HTMLTextAreaElement;
    const send = panel.querySelector(`.${cls}-send`) as HTMLButtonElement;
    input.value = "Question about A";
    send.click();
    await Zotero.Promise.delay(1200);

    let bubbles = Array.from(panel.querySelectorAll(`.${cls}-msg`)) as HTMLElement[];
    assert.ok(
      bubbles.some((b) => /Question about A/.test(b.textContent || "")),
      "A: user question stored",
    );
    assert.ok(
      bubbles.some((b) => b.className.includes("assistant") && /Reply for A/.test(b.textContent || "")),
      "A: assistant reply stored",
    );

    // Switch to item B: its context thread is independent (empty).
    api().renderPanel(host, itemB.id);
    bubbles = Array.from(panel.querySelectorAll(`.${cls}-msg`)) as HTMLElement[];
    assert.equal(bubbles.length, 0, "B starts with an empty thread");
    assert.equal(api().currentThread().length, 0, "B thread empty in state");

    // Switch back to item A: its thread is preserved.
    api().renderPanel(host, itemA.id);
    bubbles = Array.from(panel.querySelectorAll(`.${cls}-msg`)) as HTMLElement[];
    assert.ok(
      bubbles.some((b) => /Question about A/.test(b.textContent || "")),
      "A thread restored after switching away",
    );
    assert.isAtLeast(api().currentThread().length, 2, "A thread has user + assistant");
  });

  it("shows the active item as the chat context bar", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Context Bar Paper");
    await item.saveTx();
    host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    doc.documentElement.appendChild(host);
    api().renderPanel(host, item.id);
    const panel = host.querySelector(`.${cls}-panel`) as HTMLElement;
    const ctxLabel = panel.querySelector(`.${cls}-ctx-label`) as HTMLElement;
    const ctxTitle = panel.querySelector(`.${cls}-ctx-title`) as HTMLElement;
    assert.ok(ctxLabel && ctxTitle, "context bar rendered");
    assert.equal(ctxTitle.textContent, "Context Bar Paper", "shows the selected item title");
    assert.ok((ctxLabel.textContent || "").length > 0, "context label localized");

    api().renderPanel(host, null);
    const noneTitle = (panel.querySelector(`.${cls}-ctx-title`) as HTMLElement).textContent;
    assert.ok(noneTitle && noneTitle.length > 0, "no-item fallback is a localized string");
    assert.notEqual(noneTitle, "Context Bar Paper", "fallback is not a stale title");
  });
  it("auto-expands the section and exposes split-view helpers", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Split View Paper");
    await item.saveTx();
    await win.ZoteroPane.selectItem(item.id);
    let section: any = null;
    for (let i = 0; i < 20 && !section; i++) {
      await Zotero.Promise.delay(300);
      section = doc.querySelector("item-pane-custom-section collapsible-section") as any;
    }
    assert.ok(section, "docked section connected");

    section.open = false;
    assert.notOk(section.open, "section collapsed for the test");
    const ok = api().ensureSectionOpen();
    assert.isTrue(ok, "ensureSectionOpen found the section");
    assert.isTrue(section.open, "section re-expanded by ensureSectionOpen");

    let threw = false;
    try {
      api().splitView();
    } catch {
      threw = true;
    }
    assert.isFalse(threw, "splitView runs without throwing");
    const cp = doc.getElementById("zotero-context-pane") as HTMLElement | null;
    if (cp) {
      assert.equal(cp.getAttribute("width"), "420", "context pane widened for split view");
    }
    const zcp = (win as any).ZoteroContextPane;
    if (zcp && typeof zcp.collapsed !== "undefined") {
      assert.equal(zcp.collapsed, false, "context pane open after split view");
    }
  });

  it("renders PDF quick actions that are disabled without an open reader", async function () {
    host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    doc.documentElement.appendChild(host);
    api().renderPanel(host);
    const panel = host.querySelector(`.${cls}-panel`) as HTMLElement;
    const qSel = panel.querySelector(`.${cls}-q-sel`) as HTMLButtonElement;
    const qPage = panel.querySelector(`.${cls}-q-page`) as HTMLButtonElement;
    const qAnn = panel.querySelector(`.${cls}-q-ann`) as HTMLButtonElement;
    assert.ok(qSel && qPage && qAnn, "PDF quick-action buttons rendered");
    assert.ok((qSel.textContent || "").length > 0, "selection button localized");
    assert.ok((qPage.textContent || "").length > 0, "page button localized");
    assert.ok((qAnn.textContent || "").length > 0, "annotations button localized");
    assert.ok(qSel.disabled, "selection disabled without a reader");
    assert.ok(qPage.disabled, "page disabled without a reader");
    assert.ok(qAnn.disabled, "annotations disabled without a reader");
  });

  it("links the open PDF to the chat from the parent item (attachment reader)", async function () {
    provider().setConfig({ api: "https://example.test/v1", model: "gpt-test", secretKey: "sk-test" });
    mockHttp("Selection reply");
    const parent = new Zotero.Item("journalArticle");
    parent.setField("title", "Selection Paper Parent");
    await parent.saveTx();
    // Zotero keys readers by the ATTACHMENT id, but the item pane shows the
    // parent item. Stub the parent's attachments instead of creating a real
    // child (a bare attachment's parentID does not persist in the test DB).
    const openPDFID = 424242;
    const origGetAttachments = (parent as any).getAttachments.bind(parent);
    (parent as any).getAttachments = () => [openPDFID];
    const fakeReader: any = {
      itemID: openPDFID,
      _iframeWindow: {
        getSelection: () => ({ toString: () => "selected phrase" }),
        PDFViewerApplication: {
          pdfViewer: { currentPageNumber: 2 },
          pdfDocument: {
            getPage: async () => ({
              getTextContent: async () => ({ items: [{ str: "page text" }] }),
            }),
          },
        },
      },
    };
    const prevReaders = (Zotero as any).Reader?._readers;
    if (!(Zotero as any).Reader) (Zotero as any).Reader = {};
    (Zotero as any).Reader._readers = [fakeReader];
    try {
      host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      doc.documentElement.appendChild(host);
      // The item pane shows the PARENT item while the reader is open on the
      // attachment — quick actions must still enable.
      api().renderPanel(host, parent.id);
      const panel = host.querySelector(`.${cls}-panel`) as HTMLElement;
      const qSel = panel.querySelector(`.${cls}-q-sel`) as HTMLButtonElement;
      assert.isFalse(qSel.disabled, "selection enabled when the reader is on the item's attachment");
      const ctxPage = panel.querySelector(`.${cls}-ctx-page`) as HTMLElement;
      assert.equal(ctxPage.textContent, "p. 2", "page indicator shows the current page");

      qSel.click();
      await Zotero.Promise.delay(1200);
      const bubbles = Array.from(panel.querySelectorAll(`.${cls}-msg`)) as HTMLElement[];
      assert.ok(
        bubbles.some((b) => b.className.includes("user") && /selected phrase/.test(b.textContent || "")),
        "PDF selection sent into chat as a user message",
      );
      assert.ok(
        bubbles.some((b) => b.className.includes("assistant") && /Selection reply/.test(b.textContent || "")),
        "reply streamed for the selection",
      );
    } finally {
      (parent as any).getAttachments = origGetAttachments;
      if (prevReaders === undefined) {
        delete (Zotero as any).Reader._readers;
      } else {
        (Zotero as any).Reader._readers = prevReaders;
      }
    }
  });
  it("does not register the old floating position:fixed overlay", function () {
    assert.equal(doc.querySelectorAll(`#${config.addonRef}`).length, 0);
  });
});

