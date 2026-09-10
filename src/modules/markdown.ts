/**
 * Markdown rendering for chat replies.
 *
 * Uses `markdown-it` (already a dependency) with raw HTML disabled and a
 * small sanitizer pass so model output can never inject event handlers or
 * `javascript:`/`data:` links into the chrome UI.
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false, // never trust raw HTML from the model
  breaks: true, // newlines become <br>
  linkify: true,
  typographer: true,
});

/** Render Markdown to sanitized HTML suitable for innerHTML. */
export function renderMarkdown(text: string, doc?: Document): string {
  try {
    const html = md.render(text || "");
    return sanitizeHtml(html, doc);
  } catch {
    return escapeHtml(text || "");
  }
}

/**
 * Resolve a usable HTML parser. In the addon bootstrap sandbox the global
 * `DOMParser` may be missing, so prefer the panel document's window parser.
 */
function getParser(doc?: Document): any {
  try {
    const fromWin = (doc?.defaultView as any)?.DOMParser;
    if (fromWin) return fromWin;
  } catch {
    /* fall through */
  }
  try {
    return (globalThis as any).DOMParser || null;
  } catch {
    return null;
  }
}

/** Strip event handlers and dangerous URL schemes from rendered HTML. */
export function sanitizeHtml(html: string, doc?: Document): string {
  try {
    const Parser = getParser(doc);
    if (!Parser) return html;
    const parsed = new Parser().parseFromString(html, "text/html");
    const body = parsed.body;
    if (!body) return html;
    const walk = (el: Element) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();
        if (
          name.startsWith("on") ||
          ((name === "href" || name === "src") &&
            /^(javascript|data|vbscript):/.test(val))
        ) {
          el.removeAttribute(attr.name);
        }
      }
      for (const child of Array.from(el.children)) walk(child);
    };
    walk(body);
    return String(body.innerHTML);
  } catch {
    return html;
  }
}


/**
 * Parse rendered Markdown with the HTML parser (DOMParser "text/html") and
 * append the resulting nodes into `container` via importNode.
 *
 * Needed because the Zotero UI document is XML/XUL: setting innerHTML (or
 * createContextualFragment) with non-well-formed HTML such as a bare `<br>`
 * throws "An invalid or illegal string was specified", which silently fell
 * back to plain text and made Markdown appear unrendered.
 */
export function appendMarkdown(
  container: Element,
  text: string,
  doc: Document,
): void {
  const html = renderMarkdown(text, doc);
  const Parser = getParser(doc);
  if (!Parser || !html) {
    container.textContent = text;
    return;
  }
  const parsed = new Parser().parseFromString(html, "text/html");
  const body = parsed?.body;
  if (!body) {
    container.textContent = text;
    return;
  }
  // 3 = TEXT_NODE, 1 = ELEMENT_NODE (avoid the `Node` global, which is not
  // available in the addon bootstrap sandbox).
  for (let i = 0; i < body.childNodes.length; i++) {
    const node = body.childNodes[i];
    if (node?.nodeType === 3 || node?.nodeType === 1) {
      container.appendChild(doc.importNode(node, true));
    }
  }
}
/** Escape plain text for safe insertion as HTML. */
export function escapeHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
/**
 * Rough token estimate for context-usage display. Latin text ≈ 4 chars/token;
 * CJK text is counted more generously (~1 char/token) so Chinese replies do
 * not look absurdly short.
 */
export function estimateTokens(text: string): number {
  const s = String(text || "");
  if (!s) return 0;
  let latin = 0;
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0;
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
    else if (!/\s/.test(ch)) latin++;
  }
  return Math.ceil(latin / 4) + cjk;
}
