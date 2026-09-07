import { assert } from "chai";
import { config } from "../package.json";

describe("docked panel", function () {
  this.timeout(45000);
  const cls = config.addonRef;
  const win: any = Zotero.getMainWindow();
  const doc: Document = win.document;
  const api = () => Zotero[config.addonInstance].api as any;
  let host: HTMLElement;

  afterEach(() => {
    host?.remove();
  });

  it("is registered as an item-pane section and receives framework render callbacks", async function () {
    assert.isFunction(api().renderPanel, "render hook exposed");
    const before = api().panelRenderCount || 0;
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "framework callback check");
    await item.saveTx();
    await win.ZoteroPane.selectItem(item.id);
    // The framework invokes onRender as part of item-pane rendering.
    let called = api().panelRenderCount > before;
    for (let i = 0; i < 20 && !called; i++) {
      await Zotero.Promise.delay(300);
      called = api().panelRenderCount > before;
    }
    assert.isTrue(called, "ItemPaneManager should invoke our onRender callback");
    assert.isAtLeast(api().panelInitCount, 1, "onInit should fire");
  });

  it("builds the chat UI and streams a reply inside a connected docked container", async function () {
    host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    doc.documentElement.appendChild(host);
    api().renderPanel(host);

    const panel = host.querySelector(`.${cls}-panel`) as HTMLElement;
    assert.ok(panel, "chat panel root rendered");
    const input = panel.querySelector("textarea") as HTMLTextAreaElement;
    const send = panel.querySelector(`.${cls}-send`) as HTMLButtonElement;
    assert.ok(input && send, "input + send rendered");

    input.value = "Summarize this paper";
    send.click();
    await Zotero.Promise.delay(2800);

    const bubbles = Array.from(
      panel.querySelectorAll(`.${cls}-msg`),
    ) as HTMLElement[];
    assert.isAtLeast(bubbles.length, 2, "user + assistant bubbles present");
    assert.ok(
      bubbles.some((b) => b.className.includes("user") && /Summarize/.test(b.textContent || "")),
      "user bubble",
    );
    assert.ok(
      bubbles.some((b) => b.className.includes("assistant") && (b.textContent || "").length > 0),
      "assistant reply streamed",
    );
  });

  it("does not register the old floating position:fixed overlay", function () {
    assert.equal(doc.querySelectorAll(`#${config.addonRef}`).length, 0);
  });
});

