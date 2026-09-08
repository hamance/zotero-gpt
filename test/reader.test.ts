import { assert } from "chai";
import {
  buildAnnotationsMessage,
  buildPageMessage,
  buildSelectionMessage,
  getCurrentPageNumber,
  getPageText,
  getReaderForItem,
  getSelectionText,
  navigateToPage,
  parsePageCommand,
  trackPageChanges,
} from "../src/modules/reader";

describe("reader (PDF) linkage helpers", function () {
  it("builds a selection message (null when empty)", function () {
    assert.isNull(buildSelectionMessage("   "));
    const msg = buildSelectionMessage("The quick brown fox");
    assert.ok(msg && msg.includes("The quick brown fox"));
  });

  it("builds a page message (null without page or text)", function () {
    assert.isNull(buildPageMessage(0, "text"));
    assert.isNull(buildPageMessage(3, "  "));
    const msg = buildPageMessage(3, "Some page text");
    assert.ok(msg && msg.includes("page 3") && msg.includes("Some page text"));
  });

  it("builds an annotations message (null when empty)", function () {
    assert.isNull(buildAnnotationsMessage([]));
    const msg = buildAnnotationsMessage([
      { type: "highlight", text: "key idea", comment: "important", pageLabel: "4" },
      { type: "note", text: "second", comment: "", pageLabel: "" },
    ]);
    assert.ok(msg);
    assert.ok(msg.includes("key idea"));
    assert.ok(msg.includes("comment: important"));
    assert.ok(msg.includes("[p. 4]"));
    assert.ok(msg.includes("second"));
  });

  it("parses /page commands", function () {
    assert.equal(parsePageCommand("/page 5"), 5);
    assert.equal(parsePageCommand("  /page 12  "), 12);
    assert.equal(parsePageCommand("/page 0"), null);
    assert.equal(parsePageCommand("/page -3"), null);
    assert.equal(parsePageCommand("page 5"), null);
    assert.equal(parsePageCommand("/page abc"), null);
    assert.equal(parsePageCommand("/clear"), null);
  });

  it("finds a reader by item id", function () {
    const readers = [{ itemID: 1 }, { itemID: 2 }, { itemID: 1 }];
    const r = getReaderForItem(1, readers);
    assert.equal(r.itemID, 1);
    assert.isNull(getReaderForItem(null, readers));
    assert.isNull(getReaderForItem(99, readers));
  });

  it("reads current page / selection / page text from a fake pdf.js reader", async function () {
    const reader: any = {
      _iframeWindow: {
        getSelection: () => ({ toString: () => "selected words" }),
        PDFViewerApplication: {
          pdfViewer: { currentPageNumber: 7 },
          pdfDocument: {
            getPage: async (n: number) => ({
              getTextContent: async () => ({
                items: [{ str: "Hello" }, { str: " " }, { str: "world" }],
              }),
            }),
          },
        },
      },
    };
    assert.equal(getCurrentPageNumber(reader), 7);
    assert.equal(getSelectionText(reader), "selected words");
    assert.equal(await getPageText(reader, 7), "Hello world");
    assert.equal(await getPageText(reader, 0), "");
    assert.equal(await getPageText(reader, 7, 5), "Hello");
  });

  it("navigates to a 1-based page", function () {
    let called: any = null;
    const reader: any = {
      navigate: (loc: any) => {
        called = loc;
      },
    };
    assert.isTrue(navigateToPage(reader, 4));
    assert.deepEqual(called, { pageIndex: 3 });
    assert.isFalse(navigateToPage(null, 4));
  });

  it("tracks pdf.js page changes and cleans up", function () {
    const listeners: Record<string, any> = {};
    const bus: any = {
      on: (name: string, fn: any) => {
        listeners[name] = fn;
      },
      off: (name: string, fn: any) => {
        if (listeners[name] === fn) delete listeners[name];
      },
    };
    const reader: any = {
      _iframeWindow: { PDFViewerApplication: { eventBus: bus } },
    };
    const seen: number[] = [];
    const cleanup = trackPageChanges(reader, (p) => seen.push(p));
    listeners.pagechanging?.({ pageNumber: 3 });
    listeners.pagechanging?.({ pageNumber: 4 });
    assert.deepEqual(seen, [3, 4]);
    cleanup();
    assert.isUndefined(listeners.pagechanging, "listener removed on cleanup");
    // Unavailable reader -> safe no-op
    assert.isFunction(trackPageChanges(null as any, () => {}));
  });
});

