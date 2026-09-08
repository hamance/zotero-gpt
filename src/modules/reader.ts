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

/** The reader's iframe window (pdf.js host), or null. */
export function getIframe(reader: any): Window | null {
  try {
    return reader?._iframeWindow ?? null;
  } catch {
    return null;
  }
}

/** The pdf.js `PDFViewerApplication` inside the reader iframe, or null. */
export function getPDFApp(reader: any): any {
  try {
    return (getIframe(reader) as any)?.PDFViewerApplication ?? null;
  } catch {
    return null;
  }
}

/** Current 1-based page number (0 when unavailable). */
export function getCurrentPageNumber(reader: any): number {
  try {
    return Number(getPDFApp(reader)?.pdfViewer?.currentPageNumber) || 0;
  } catch {
    return 0;
  }
}

/** Text currently selected in the PDF (empty string when none). */
export function getSelectionText(reader: any): string {
  try {
    const win = getIframe(reader);
    const sel = win?.getSelection?.();
    return sel ? String(sel.toString() || "").trim() : "";
  } catch {
    return "";
  }
}

/**
 * Extract the text of one PDF page (1-based) via pdf.js getTextContent().
 * Whitespace is collapsed and the result truncated to `maxChars`.
 */
export async function getPageText(
  reader: any,
  pageNumber: number,
  maxChars = 8000,
): Promise<string> {
  try {
    const app = getPDFApp(reader);
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
  } catch {
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

