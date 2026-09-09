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
export function renderMarkdown(text: string): string {
  try {
    const html = md.render(text || "");
    return sanitizeHtml(html);
  } catch {
    return escapeHtml(text || "");
  }
}

/** Strip event handlers and dangerous URL schemes from rendered HTML. */
export function sanitizeHtml(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const body = doc.body;
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

/** Escape plain text for safe insertion as HTML. */
export function escapeHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}