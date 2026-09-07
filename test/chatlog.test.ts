import { assert } from "chai";
import { config } from "../package.json";

describe("chat log (export .md + save as note)", function () {
  this.timeout(45000);
  const cls = config.addonRef;
  const api = () => (Zotero as any)[config.addonInstance].api as any;
  const chatlog = () => api().chatlog;
  const provider = () => api().provider;
  const msgs = [
    { role: "user" as const, content: "Summarize this paper" },
    { role: "assistant" as const, content: "It proposes a **new method**." },
  ];

  it("builds a Markdown transcript with user/assistant turns", () => {
    const md = chatlog().buildMarkdown(msgs, { itemTitle: "My Paper" });
    assert.include(md, "# Zotero GPT Chat Transcript");
    assert.include(md, "Item: My Paper");
    assert.include(md, "## User");
    assert.include(md, "Summarize this paper");
    assert.include(md, "## Zotero GPT");
    assert.include(md, "It proposes a **new method**.");
    // system messages are excluded
    const withSys = [{ role: "system" as const, content: "secret ctx" }, ...msgs];
    assert.notInclude(chatlog().buildMarkdown(withSys), "secret ctx");
  });

  it("builds a note HTML body and escapes markup", () => {
    const html = chatlog().buildNoteHTML(
      [{ role: "user" as const, content: "<script>alert(1)</script> & ok" }],
      {},
    );
    assert.include(html, "&lt;script&gt;alert(1)&lt;/script&gt; &amp; ok");
    assert.include(html, "<h3>User</h3>");
  });

  it("exports the transcript to a Markdown file under the data dir", async function () {
    let file = "";
    try {
      file = await chatlog().exportToMd(msgs, { itemTitle: "My Paper" });
      assert.match(file, /Zotero GPT[\\\/]Zotero-GPT-\d{8}-\d{6}\.md$/);
      assert.ok((Zotero.File as any).pathToFile(file).exists(), "file written");
      const content = (Zotero.File as any).getContents(
        (Zotero.File as any).pathToFile(file),
      );
      assert.include(content, "Summarize this paper");
      assert.include(content, "My Paper");
    } finally {
      try {
        if (file) {
          (Zotero.File as any).removeIfExists((Zotero.File as any).pathToFile(file));
          (Zotero.File as any).removeIfExists(
            (Zotero.File as any).pathToFile(file.replace(/\/[^/]+$/, "")),
          );
        }
      } catch {}
    }  });

  it("creates a child note on the selected item from the conversation", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Note Target Paper");
    await item.saveTx();
    let noteID = 0;
    try {
      noteID = await chatlog().saveAsNote(msgs, { itemTitle: "Note Target Paper" }, item.id);
      const note = Zotero.Items.get(noteID);
      assert.ok(note.isNote(), "created item is a note");
      assert.equal(note.parentID, item.id, "note attached to the discussed item");
      const body = note.getNote();
      assert.include(body, "Zotero GPT Chat Transcript");
      assert.include(body, "Summarize this paper");
    } finally {
      try {
        if (noteID) await Zotero.Items.get(noteID).eraseTx();
      } catch {}
      try {
        await item.eraseTx();
      } catch {}
    }
  });

  it("shows export/note buttons that enable after a conversation", async function () {
    provider().setConfig({ api: "https://example.test/v1", model: "gpt-test", secretKey: "sk-test" });
    const origRequest = (Zotero as any).HTTP.request;
    (Zotero as any).HTTP.request = async (_m: string, _u: string, opts: any) => {
      const xhr: any = {
        responseText: 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
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
    const win: any = Zotero.getMainWindow();
    const doc: Document = win.document;
    const host = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    doc.documentElement.appendChild(host);
    try {
      api().renderPanel(host);
      const panel = host.querySelector(`.${cls}-panel`) as HTMLElement;
      const aExport = panel.querySelector(`.${cls}-a-export`) as HTMLButtonElement;
      const aNote = panel.querySelector(`.${cls}-a-note`) as HTMLButtonElement;
      assert.ok(aExport && aNote, "export/note buttons rendered");
      assert.ok(aExport.disabled && aNote.disabled, "disabled while empty");
      const input = panel.querySelector("textarea") as HTMLTextAreaElement;
      input.value = "hello";
      (panel.querySelector(`.${cls}-send`) as HTMLButtonElement).click();
      await Zotero.Promise.delay(600);
      assert.notOk(aExport.disabled, "export enabled after a conversation");
      assert.notOk(aNote.disabled, "note enabled after a conversation");
    } finally {
      host.remove();
      (Zotero as any).HTTP.request = origRequest;
    }
  });
});
