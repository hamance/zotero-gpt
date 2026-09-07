import { ChatMessage } from "./provider";

export interface ChatLogMeta {
  itemTitle?: string;
  itemID?: number | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function fileNameStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function roleName(role: ChatMessage["role"]): string {
  return role === "user" ? "User" : "Zotero GPT";
}

/** Render the conversation as a Markdown transcript. */
export function buildMarkdown(
  messages: ChatMessage[],
  meta: ChatLogMeta = {},
): string {
  const lines: string[] = ["# Zotero GPT Chat Transcript"];
  lines.push("", `- Date: ${timestamp()}`);
  if (meta.itemTitle) lines.push(`- Item: ${meta.itemTitle}`);
  lines.push("");
  for (const m of messages) {
    if (m.role === "system") continue;
    lines.push(`## ${roleName(m.role)}`, "", m.content, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Render the conversation as HTML suitable for a Zotero note body. */
export function buildNoteHTML(
  messages: ChatMessage[],
  meta: ChatLogMeta = {},
): string {
  const parts: string[] = ["<h1>Zotero GPT Chat Transcript</h1>"];
  parts.push(`<p><i>${escapeHtml(timestamp())}</i></p>`);
  if (meta.itemTitle) {
    parts.push(`<p><b>Item:</b> ${escapeHtml(meta.itemTitle)}</p>`);
  }
  for (const m of messages) {
    if (m.role === "system") continue;
    parts.push(`<h3>${escapeHtml(roleName(m.role))}</h3>`);
    const paras = m.content.split(/\r?\n/);
    parts.push(
      "<p>" +
        paras.map((line) => escapeHtml(line)).join("<br/>") +
        "</p>",
    );
  }
  return parts.join("\n");
}

/** Directory used for exported transcripts (under the Zotero data dir). */
export function chatsDir(): string {
  const base = String((Zotero as any).DataDirectory?.dir ?? "").replace(
    /[\\/]+$/,
    "",
  );
  return `${base}/Zotero GPT`;
}

function nativePath(p: string): string {
  try {
    const os = (Services as any)?.appinfo?.OS;
    return os === "WINNT" ? p.replace(/\//g, "\\") : p;
  } catch {
    return p;
  }
}

/** Export the conversation to a timestamped Markdown file; returns the path. */
export async function exportToMd(
  messages: ChatMessage[],
  meta: ChatLogMeta = {},
  dirOverride?: string,
): Promise<string> {
  const dir = (dirOverride ?? chatsDir()).replace(/[\\/]+$/, "");
  const file = nativePath(`${dir}/Zotero-GPT-${fileNameStamp()}.md`);
  const folder = nativePath(dir);
  await (Zotero.File as any).createDirectoryIfMissingAsync(folder);
  (Zotero.File as any).putContents(
    (Zotero.File as any).pathToFile(file),
    buildMarkdown(messages, meta),
  );
  return file;
}

/**
 * Create a Zotero note containing the chat transcript.
 * Attaches to `parentID` when given (e.g. the discussed item), otherwise to
 * `meta.itemID`, otherwise creates a standalone note. Returns the note id.
 */
export async function saveAsNote(
  messages: ChatMessage[],
  meta: ChatLogMeta = {},
  parentID?: number | null,
): Promise<number> {
  const target = parentID ?? meta.itemID ?? null;
  const note = new Zotero.Item("note");
  if (target) note.parentID = target;
  note.setNote(buildNoteHTML(messages, meta));
  await note.saveTx();
  return note.id;
}
