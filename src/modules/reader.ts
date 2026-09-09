/**
 * Reader (PDF) integration helpers.
 *
 * All functions are defensive and testable: anything that touches the live
 * Zotero reader iframe / pdf.js globals is wrapped, and the pure builders
 * (`build*Message`, `parsePageCommand`) are unit-tested in `test/reader.test.ts`.
 */
import { config } from "../../package.json";

export interface AnnotationSummary {
  type: string;
  text: string;
  comment: string;
  pageLabel: string;
}

/**
 * The PDF reader tab currently open for an item (or null).
 *
 * Zotero keys readers by the *attachment* item id, but the item pane shows
 * the *parent* item when a reader is open (contextPane.js resolves
 * `targetItem = parentID ? Zotero.Items.get(parentID) : item`), so we match
 * the item itself AND any of its attachments / its parent.
 */
export function getReaderForItem(
  itemID: number | null | undefined,
  readers?: any[],
): any {
  if (!itemID) return null;
  try {
    const arr = readers ?? (Zotero as any).Reader?._readers ?? [];
    const ids = relatedItemIDs(itemID);
    return arr.find((r: any) => r && r.itemID != null && ids.has(r.itemID)) ?? null;
  } catch {
    return null;
  }
}

/** The item id plus its attachment ids and parent id (for reader matching). */
function relatedItemIDs(itemID: number): Set<number> {
  const ids = new Set<number>([itemID]);
  try {
    const item = (Zotero as any).Items?.get?.(itemID);
    if (!item) return ids;
    if (typeof item.getAttachments === "function") {
      for (const aid of item.getAttachments() ?? []) ids.add(aid);
    }
    if (item.parentID != null) ids.add(item.parentID);
  } catch {
    /* keep the plain id */
  }
  return ids;
}

/**
 * Candidate windows that may host the pdf.js viewer / text selection.
 *
 * In Zotero 7+ the reader is nested: `reader._iframeWindow` is the reader
 * host shell, while the actual pdf.js viewer (with `PDFViewerApplication`
 * and the text selection) lives in the primary/secondary view iframe
 * (`reader._internalReader._primaryView._iframeWindow`). Return the most
 * specific first, with the legacy host iframe as a fallback.
 */
function getIframes(reader: any): Window[] {
  const out: Window[] = [];
  const push = (w: any) => {
    if (w && typeof w === "object") out.push(w);
  };
  try {
    const internal = reader?._internalReader;
    push(internal?._primaryView?._iframeWindow);
    push(internal?._secondaryView?._iframeWindow);
    push(reader?._iframeWindow);
  } catch {
    /* keep whatever we collected */
  }
  return out;
}

/** The pdf.js viewer iframe window, or null. */
export function getIframe(reader: any): Window | null {
  return getIframes(reader)[0] ?? null;
}

/** The pdf.js `PDFViewerApplication` inside the reader iframe, or null. */
export function getPDFApp(reader: any): any {
  try {
    for (const win of getIframes(reader)) {
      const app = (win as any)?.PDFViewerApplication;
      if (app) return app;
    }
    return null;
  } catch {
    return null;
  }
}

/** Current 1-based page number (0 when unavailable). */
export function getCurrentPageNumber(reader: any): number {
  try {
    const viewer = getPDFApp(reader)?.pdfViewer;
    // Prefer the public getter; fall back to the backing field if the getter
    // is hidden behind an Xray boundary.
    return Number(viewer?.currentPageNumber ?? viewer?._currentPageNumber) || 0;
  } catch {
    return 0;
  }
}

/** Text currently selected in the PDF (empty string when none). */
export function getSelectionText(reader: any): string {
  try {
    for (const win of getIframes(reader)) {
      const sel = win?.getSelection?.();
      const text = sel ? String(sel.toString() || "").trim() : "";
      if (text) return text;
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Extract the text of one PDF page (1-based).
 *
 * Preferred source: the already-rendered text layer
 * (`pdfViewer.getPageView(n-1)._textHighlighter.textContentItemsStr`) which
 * is synchronous and needs no worker round-trip. Fallback: pdf.js
 * `getTextContent()`. Whitespace is collapsed; result truncated to
 * `maxChars`.
 */
export async function getPageText(
  reader: any,
  pageNumber: number,
  maxChars = 8000,
): Promise<string> {
  try {
    const app = getPDFApp(reader);
    const viewer = app?.pdfViewer;
    // Fast path: rendered text-layer strings for this page.
    const pageView = viewer?.getPageView?.(pageNumber - 1);
    const rendered = pageView?._textHighlighter?.textContentItemsStr;
    if (Array.isArray(rendered) && rendered.length) {
      const fast = (rendered as any[])
        .filter((s) => typeof s === "string")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (fast) return fast.slice(0, maxChars);
    }
    // Fallback: ask pdf.js for the page's text content.
    const doc = app?.pdfDocument;
    if (!doc || !pageNumber) return "";
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const items: any[] = content?.items ?? [];
    const text = items
      .map((it: any) => (typeof it?.str === "string" ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, maxChars);
  } catch (e) {
    try {
      ztoolkit.log("getPageText failed", pageNumber, e);
    } catch {
      /* no logger available */
    }
    return "";
  }
}

/**
 * Collect highlight/note annotations from the PDF attachment(s) of an item.
 * Each annotation item exposes `annotationType` / `annotationText` /
 * `annotationComment` / `annotationPageLabel` getters (Zotero 7+).
 */
export function collectAnnotations(item: any): AnnotationSummary[] {
  const out: AnnotationSummary[] = [];
  try {
    if (!item || typeof item.getAttachments !== "function") return out;
    const attachIDs: number[] = item.getAttachments() ?? [];
    for (const aid of attachIDs) {
      const att: any = (Zotero as any).Items?.get?.(aid);
      if (!att || typeof att.getAnnotations !== "function") continue;
      let anns: any[];
      try {
        anns = att.getAnnotations();
      } catch {
        continue;
      }
      for (const a of anns ?? []) {
        if (!a || typeof a.getField !== "function") continue;
        const text = String(
          a.getField("annotationText") || a.annotationText || "",
        ).trim();
        const comment = String(
          a.getField("annotationComment") || a.annotationComment || "",
        ).trim();
        const pageLabel = String(
          a.getField("annotationPageLabel") || a.annotationPageLabel || "",
        ).trim();
        if (text || comment) {
          out.push({
            type: String(
              a.annotationType || a.getField("annotationType") || "note",
            ),
            text,
            comment,
            pageLabel,
          });
        }
      }
    }
  } catch {
    /* no annotations available */
  }
  return out;
}

/** User message asking the model to explain a PDF selection (null if empty). */
export function buildSelectionMessage(selection: string): string | null {
  const s = (selection || "").trim();
  if (!s) return null;
  return `Please explain the following selected passage from the open PDF:\n\n"""\n${s}\n"""`;
}

/** User message asking to summarize the current PDF page (null if unusable). */
export function buildPageMessage(
  pageNumber: number,
  pageText: string,
): string | null {
  if (!pageNumber || !(pageText || "").trim()) return null;
  return `Please summarize the current page (page ${pageNumber}) of the open PDF:\n\n"""\n${pageText}\n"""`;
}

/** User message asking to summarize the item's PDF annotations (null if none). */
export function buildAnnotationsMessage(
  annotations: AnnotationSummary[],
): string | null {
  if (!annotations.length) return null;
  const parts = annotations.map((a) => {
    const loc = a.pageLabel ? ` [p. ${a.pageLabel}]` : "";
    const lines = [`- (${a.type})${loc}: ${a.text || "(no text)"}`];
    if (a.comment) lines.push(`  comment: ${a.comment}`);
    return lines.join("\n");
  });
  return `Please summarize the annotations I made on this PDF:\n\n${parts.join("\n")}`;
}

/** Parse `/page N` into a 1-based page number, or null. */
export function parsePageCommand(raw: string): number | null {
  const m = /^\/page\s+(\d+)\s*$/i.exec((raw || "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Navigate the reader to a 1-based page number. */
export function navigateToPage(reader: any, pageNumber: number): boolean {
  try {
    if (!reader || !pageNumber) return false;
    reader.navigate?.({ pageIndex: pageNumber - 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Subscribe to selection changes inside the pdf.js iframe; reports the
 * current trimmed selection ("" when cleared) after a short debounce.
 * Returns a cleanup function; safe no-op when the reader is unavailable.
 */
export function trackSelectionChanges(
  reader: any,
  onSelection: (text: string) => void,
  debounceMs = 400,
): () => void {
  try {
    const win = getIframes(reader)[0];
    const doc = win?.document;
    if (!doc || typeof doc.addEventListener !== "function") return () => {};
    let token = 0;
    const onChange = () => {
      const myToken = ++token;
      Zotero.Promise.delay(debounceMs).then(() => {
        if (myToken === token) onSelection(getSelectionText(reader));
      });
    };
    doc.addEventListener("selectionchange", onChange);
    return () => {
      token++; // cancels any pending debounced callback
      try {
        doc.removeEventListener("selectionchange", onChange);
      } catch {
        /* ignore */
      }
    };
  } catch {
    return () => {};
  }
}

/**
 * Subscribe to pdf.js page changes; returns a cleanup function.
 * Safe no-op when the reader/eventBus is unavailable.
 */
export function trackPageChanges(
  reader: any,
  onPage: (page: number) => void,
): () => void {
  try {
    const bus = getPDFApp(reader)?.eventBus;
    if (!bus || typeof bus.on !== "function") return () => {};
    const fn = (evt: any) => onPage(Number(evt?.pageNumber) || 0);
    bus.on("pagechanging", fn);
    return () => {
      try {
        bus.off?.("pagechanging", fn);
      } catch {
        /* ignore */
      }
    };
  } catch {
    return () => {};
  }
}

/** Exported for tests/debugging: the addon ref this module belongs to. */
export const readerRef = config.addonRef;

