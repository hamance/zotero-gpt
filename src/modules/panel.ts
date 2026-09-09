import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { estimateTokens, renderMarkdown } from "./markdown";
import {
  ChatMessage,
  ChatStream,
  chatEndpoint,
  configError,
  deltaFromSSELine,
  embedConfigError,
  embedEndpoint,
  embedTexts,
  getConfig,
  getEmbedConfig,
  listEmbedModels,
  listModels,
  modelsEndpoint,
  normalizeBaseUrl,
  setConfig,
  setEmbedConfig,
  streamChat,
} from "./provider";
import {
  buildMarkdown,
  buildNoteHTML,
  chatsDir,
  exportToMd,
  saveAsNote,
} from "./chatlog";
import {
  buildAnnotationsMessage,
  buildPageMessage,
  buildSelectionMessage,
  collectAnnotations,
  getCurrentPageNumber,
  getPageText,
  getReaderForItem,
  getSelectionText,
  navigateToPage,
  parsePageCommand,
  trackPageChanges,
  trackSelectionChanges,
} from "./reader";

const REF = config.addonRef;
const PANE_ID = `${REF}-chat`;
const STYLE_ID = `${PANE_ID}-style`;
const XHTML = "http://www.w3.org/1999/xhtml";

let sectionRegistered = false;

/**
 * Conversation + UI state (survives section re-renders).
 * Chat history is kept per item ("context threads"): key = itemID, with 0
 * reserved for the library view when no item is selected.
 */
const GLOBAL_THREAD = 0;

const state: {
  threads: Map<number, ChatMessage[]>;
  pending: string;
  busy: boolean;
  itemID: number | null;
  activeStream: ChatStream | null;
  settingsOpen: boolean;
  reader: any;
  currentPage: number;
  pageCleanup: (() => void) | null;
  pdfAttach: string | null;
  selectionCleanup: (() => void) | null;
  selectionReader: any;
  statusEl: HTMLElement | null;
} = {
  threads: new Map(),
  pending: "",
  busy: false,
  itemID: null,
  activeStream: null,
  settingsOpen: true,
  reader: null,
  currentPage: 0,
  pageCleanup: null,
  pdfAttach: null,
  selectionCleanup: null,
  selectionReader: null,
  statusEl: null,
};

/** Map key for the active thread (itemID, or 0 when no item is selected). */
const threadKey = (): number => state.itemID ?? GLOBAL_THREAD;

/** The current item's conversation; created on first use. */
const thread = (): ChatMessage[] => {
  const key = threadKey();
  let t = state.threads.get(key);
  if (!t) {
    t = [];
    state.threads.set(key, t);
  }
  return t;
};

/** Title of the currently selected item ("" when none / not an item). */
const currentItemTitle = (): string => {
  try {
    const item = state.itemID
      ? (Zotero as any).Items?.get?.(state.itemID)
      : null;
    return item && typeof item.getField === "function"
      ? String(item.getField?.("title") || "")
      : "";
  } catch {
    return "";
  }
};

/** Main window (first Zotero main window). */
function getMainWindow(): Window | null {
  try {
    return (
      (Zotero as any).getMainWindow?.() ??
      (Zotero as any).getMainWindows?.()?.[0] ??
      null
    );
  } catch {
    return null;
  }
}

/** The framework namespaces + CSS-escapes the paneID as `<pluginID>-<paneID>`. */
function namespacedPaneID(): string {
  const raw = `${config.addonID}-${PANE_ID}`;
  try {
    const escape = (globalThis as any).CSS?.escape;
    return typeof escape === "function" ? escape(raw) : raw;
  } catch {
    return raw;
  }
}

/** The docked section element in a window (or null). */
function findSection(win: Window | null): HTMLElement | null {
  try {
    if (!win?.document) return null;
    const want = namespacedPaneID();
    const nodes = win.document.querySelectorAll(
      "item-pane-custom-section collapsible-section",
    );
    for (const el of Array.from(nodes)) {
      const elAny = el as any;
      if (elAny.dataset?.pane === want) return el as HTMLElement;
    }
    return null;
  } catch {
    return null;
  }
}

/** Ensure the docked section is expanded (used for PDF split view). */
function ensureSectionOpen(win?: Window | null): boolean {
  try {
    const sec = findSection(win ?? getMainWindow());
    if (sec && !(sec as any).open) (sec as any).open = true;
    return !!sec;
  } catch {
    return false;
  }
}

/**
 * Split view: keep the chat section expanded and open/widen the right
 * context pane so the chat sits side-by-side with the PDF reader.
 */
function splitView(win?: Window | null): boolean {
  try {
    const w = win ?? getMainWindow();
    if (!w) return false;
    ensureSectionOpen(w);
    const cp = (w.document as Document).getElementById(
      "zotero-context-pane",
    ) as HTMLElement | null;
    if (cp) {
      cp.setAttribute("width", "420");
      cp.style.width = "420px";
    }
    const zcp = (w as any).ZoteroContextPane;
    if (zcp && zcp.collapsed) zcp.collapsed = false;
    return true;
  } catch {
    return false;
  }
}

// Re-check timer used to enable PDF quick actions once a reader registers.
let readerPollTimer: ReturnType<typeof setInterval> | null = null;
let readerPollFn: (() => void) | null = null;

function stopReaderPoll() {
  if (readerPollTimer != null) {
    clearInterval(readerPollTimer);
    readerPollTimer = null;
  }
  readerPollFn = null;
}

function bump(key: string) {
  try {
    const api = (Zotero as any)[config.addonInstance]?.api as
      | Record<string, number>
      | undefined;
    if (api) api[key] = (api[key] || 0) + 1;
  } catch {}
}

const PANEL_CSS = `
.${REF}-panel{display:flex;flex-direction:column;gap:10px;padding:10px;font-size:14px;min-width:0;}
.${REF}-topbar{display:flex;flex-direction:column;gap:6px;}
.${REF}-s-toggle{align-self:flex-start;border:1px solid #c9c9c9;border-radius:8px;background:#f7f7f7;color:#333;padding:6px 14px;cursor:pointer;font:inherit;font-size:13px;}
.${REF}-s-toggle:hover{background:#ececec;}
.${REF}-hint{color:#9a6700;background:#fff8c5;border:1px solid #e0c366;border-radius:6px;padding:4px 8px;font-size:12px;}
.${REF}-hint[hidden]{display:none;}
.${REF}-top-row{display:flex;gap:6px;align-items:center;}
.${REF}-s-split{border:1px solid #c9c9c9;border-radius:6px;background:#f7f7f7;color:#333;padding:3px 10px;cursor:pointer;font:inherit;}
.${REF}-s-split:hover{background:#ececec;}
.${REF}-ctx{display:flex;gap:8px;align-items:center;font-size:13px;color:#555;background:#f6f8fa;border:1px solid #e2e2e2;border-radius:8px;padding:6px 10px;min-width:0;flex-wrap:wrap;}
.${REF}-ctx-label{color:#888;flex:none;}
.${REF}-ctx-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;flex:1;min-width:0;}
.${REF}-ctx-page{color:#1a7f37;background:#e6f4ea;border-radius:10px;padding:1px 8px;font-size:12px;flex:none;}
.${REF}-ctx-status{color:#57606a;background:#eef1f4;border:1px solid #dfe3e8;border-radius:10px;padding:1px 8px;font-size:12px;flex:none;white-space:nowrap;font-variant-numeric:tabular-nums;}
.${REF}-ctx-status[hidden]{display:none;}
.${REF}-pdf-actions{display:flex;gap:6px;flex-wrap:wrap;}
.${REF}-settings{display:flex;flex-direction:column;gap:8px;border:1px solid #e0e0e0;border-radius:8px;padding:8px;background:#fafafa;}
.${REF}-settings[hidden]{display:none;}
.${REF}-group{display:flex;flex-direction:column;gap:5px;border-top:1px solid #ececec;padding-top:6px;}
.${REF}-group:first-of-type{border-top:none;padding-top:0;}
.${REF}-group-title{font-weight:600;color:#333;margin-bottom:2px;}
.${REF}-field{display:flex;flex-direction:column;gap:2px;font-size:12px;color:#444;}
.${REF}-field>span{color:#555;}
.${REF}-settings input[type=text],.${REF}-settings input[type=password],.${REF}-settings input:not([type]),.${REF}-settings select,.${REF}-settings input[type=number]{border:1px solid #c9c9c9;border-radius:6px;padding:4px 6px;font:inherit;background:#fff;color:#222;}
.${REF}-row-inline{display:flex;gap:6px;align-items:center;}
.${REF}-row-inline .${REF}-s-model,.${REF}-row-inline .${REF}-e-model{flex:1;}
.${REF}-btn{border:1px solid #c9c9c9;border-radius:8px;padding:6px 12px;background:#fff;color:#333;cursor:pointer;font:inherit;white-space:nowrap;font-size:13px;}
.${REF}-btn:hover{background:#f0f0f0;}
.${REF}-btn[disabled]{opacity:.55;cursor:default;}
.${REF}-s-save{border:none;border-radius:6px;padding:5px 16px;background:#1f6feb;color:#fff;cursor:pointer;font:inherit;align-self:flex-end;}
.${REF}-settings-actions{display:flex;justify-content:flex-end;gap:6px;}
.${REF}-e-status{font-size:12px;color:#333;min-height:16px;}
.${REF}-e-status.ok{color:#1a7f37;}
.${REF}-e-status.err{color:#cf222e;}
.${REF}-messages{display:flex;flex-direction:column;gap:8px;min-height:300px;max-height:60vh;overflow-y:auto;overscroll-behavior:contain;background:#fff;border:1px solid #e2e2e2;border-radius:10px;padding:10px;}
.${REF}-msg{padding:8px 12px;border-radius:10px;white-space:pre-wrap;word-wrap:break-word;line-height:1.55;font-size:14px;}
.${REF}-msg.user{align-self:flex-end;background:#e8f3ff;color:#0a2540;max-width:85%;}
.${REF}-msg.assistant{align-self:flex-start;background:#f4f4f5;max-width:100%;min-width:0;}
.${REF}-msg .markdown-body{font-size:14px;line-height:1.55;color:#24292f;}
.${REF}-msg .markdown-body pre{background:#f6f8fa;border:1px solid #e2e2e2;border-radius:8px;padding:10px;overflow-x:auto;white-space:pre;}
.${REF}-msg .markdown-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:rgba(175,184,193,.2);border-radius:4px;padding:1px 4px;}
.${REF}-msg .markdown-body pre code{background:none;padding:0;}
.${REF}-msg .markdown-body table{border-collapse:collapse;margin:8px 0;display:block;overflow-x:auto;}
.${REF}-msg .markdown-body th,.${REF}-msg .markdown-body td{border:1px solid #d0d7de;padding:5px 10px;}
.${REF}-msg .markdown-body a{color:#0969da;text-decoration:underline;}
.${REF}-empty{color:#888;font-style:italic;padding:8px 4px;}
.${REF}-attach{display:flex;gap:6px;align-items:center;border:1px dashed #c9c9c9;border-radius:6px;background:#f6f8fa;padding:4px 8px;font-size:12px;color:#444;min-width:0;}
.${REF}-attach[hidden]{display:none;}
.${REF}-attach-label{flex:none;color:#1f6feb;font-weight:600;white-space:nowrap;}
.${REF}-attach-preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
.${REF}-attach-x{flex:none;border:none;background:transparent;color:#888;cursor:pointer;font-size:13px;padding:0 2px;}
.${REF}-attach-x:hover{color:#c00;}
.${REF}-input-row{display:flex;gap:6px;align-items:flex-end;}
.${REF}-actions{display:flex;gap:6px;flex-wrap:wrap;}
.${REF}-input{flex:1;resize:vertical;min-height:64px;max-height:200px;border:1px solid #c9c9c9;border-radius:8px;padding:10px 12px;font:inherit;font-size:14px;line-height:1.5;}
.${REF}-input:focus{outline:none;border-color:#1f6feb;box-shadow:0 0 0 2px rgba(31,111,235,.2);}
.${REF}-send{border:none;border-radius:8px;padding:12px 20px;background:#1f6feb;color:#fff;cursor:pointer;font:inherit;font-size:14px;font-weight:600;}
.${REF}-send[disabled]{opacity:.5;cursor:default;}
`;

const BODY_XHTML = `
<html:div class="${REF}-panel">
  <html:div class="${REF}-topbar">
    <html:div class="${REF}-top-row">
      <html:button class="${REF}-s-toggle" type="button"></html:button>
      <html:button class="${REF}-s-split" type="button"></html:button>
    </html:div>
    <html:div class="${REF}-hint" hidden="hidden"></html:div>
  </html:div>
  <html:div class="${REF}-settings" hidden="hidden">
    <html:div class="${REF}-group">
      <html:div class="${REF}-group-title ${REF}-lbl-chat"></html:div>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-api"></html:span><html:input class="${REF}-s-api" type="text" /></html:label>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-key"></html:span><html:input class="${REF}-s-key" type="password" /></html:label>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-model"></html:span>
        <html:span class="${REF}-row-inline">
          <html:input class="${REF}-s-model" type="text" list="${REF}-models" />
          <html:button class="${REF}-btn ${REF}-s-refresh" type="button"></html:button>
        </html:span>
      </html:label>
      <html:datalist id="${REF}-models"></html:datalist>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-temp"></html:span><html:input class="${REF}-s-temp" type="number" step="0.1" min="0" max="2" /></html:label>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-ctx-limit"></html:span><html:input class="${REF}-s-ctx-limit" type="number" step="1000" min="0" /></html:label>
    </html:div>
    <html:div class="${REF}-group">
      <html:div class="${REF}-group-title ${REF}-lbl-embed"></html:div>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-embed-enabled"></html:span>
        <html:span class="${REF}-row-inline"><html:input class="${REF}-e-enabled" type="checkbox" /></html:span>
      </html:label>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-embed-api"></html:span><html:input class="${REF}-e-api" type="text" /></html:label>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-embed-key"></html:span><html:input class="${REF}-e-key" type="password" /></html:label>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-embed-model"></html:span>
        <html:span class="${REF}-row-inline">
          <html:input class="${REF}-e-model" type="text" list="${REF}-embed-models" />
          <html:button class="${REF}-btn ${REF}-e-refresh" type="button"></html:button>
        </html:span>
      </html:label>
      <html:datalist id="${REF}-embed-models"></html:datalist>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-embed-type"></html:span>
        <html:select class="${REF}-e-type">
          <html:option value="openai">openai</html:option>
          <html:option value="ollama-native">ollama-native</html:option>
          <html:option value="tei">tei</html:option>
        </html:select>
      </html:label>
      <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-embed-dim"></html:span><html:input class="${REF}-e-dim" type="number" step="1" min="0" /></html:label>
      <html:div class="${REF}-row-inline">
        <html:button class="${REF}-btn ${REF}-e-test" type="button"></html:button>
        <html:span class="${REF}-e-status"></html:span>
      </html:div>
    </html:div>
    <html:div class="${REF}-settings-actions"><html:button class="${REF}-s-save" type="button"></html:button></html:div>
  </html:div>
  <html:div class="${REF}-ctx">
    <html:span class="${REF}-ctx-label"></html:span>
    <html:span class="${REF}-ctx-title"></html:span>
    <html:span class="${REF}-ctx-page"></html:span>
    <html:span class="${REF}-ctx-status" hidden="hidden"></html:span>
  </html:div>
  <html:div class="${REF}-messages"></html:div>
  <html:div class="${REF}-pdf-actions">
    <html:button class="${REF}-btn ${REF}-q-sel" type="button"></html:button>
    <html:button class="${REF}-btn ${REF}-q-page" type="button"></html:button>
    <html:button class="${REF}-btn ${REF}-q-ann" type="button"></html:button>
  </html:div>
  <html:div class="${REF}-actions">
    <html:button class="${REF}-btn ${REF}-a-export" type="button"></html:button>
    <html:button class="${REF}-btn ${REF}-a-note" type="button"></html:button>
  </html:div>
  <html:div class="${REF}-attach" hidden="hidden">
    <html:span class="${REF}-attach-label"></html:span>
    <html:span class="${REF}-attach-preview"></html:span>
    <html:button class="${REF}-attach-x" type="button"></html:button>
  </html:div>
  <html:div class="${REF}-input-row">
    <html:textarea class="${REF}-input" rows="3"></html:textarea>
    <html:button class="${REF}-send" type="button"></html:button>
  </html:div>
</html:div>`;

function registerStyles(doc: Document) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElementNS(XHTML, "style");
  style.setAttribute("id", STYLE_ID);
  style.textContent = PANEL_CSS;
  doc.documentElement?.appendChild(style);
  if (!doc.getElementById(`${STYLE_ID}-md`)) {
    const link = doc.createElementNS(XHTML, "link");
    link.setAttribute("id", `${STYLE_ID}-md`);
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", `chrome://${REF}/content/md.css`);
    (doc.head || doc.documentElement)?.appendChild(link);
  }
}

function q(body: HTMLElement, sel: string): HTMLElement {
  return body.querySelector(sel) as HTMLElement;
}

function syncMessages(body: HTMLElement) {
  const container = q(body, `.${REF}-messages`);
  if (!container) return;
  syncStatus();
  container.textContent = "";
  const doc = body.ownerDocument;
  if (!doc) return;
  if (thread().length === 0 && !state.pending) {
    const empty = doc.createElementNS(XHTML, "div");
    empty.setAttribute("class", `${REF}-empty`);
    empty.textContent = getString("panel-empty");
    container.appendChild(empty);
    return;
  }
  for (const m of thread()) {
    const b = doc.createElementNS(XHTML, "div");
    const isUser = m.role === "user";
    b.setAttribute(
      "class",
      `${REF}-msg ${isUser ? "user" : "assistant"}`,
    );
    if (isUser) {
      b.textContent = m.content;
    } else {
      const inner = doc.createElementNS(XHTML, "div");
      inner.setAttribute("class", "markdown-body");
      inner.innerHTML = renderMarkdown(m.content);
      b.appendChild(inner);
    }
    container.appendChild(b);
  }
  if (state.pending) {
    const b = doc.createElementNS(XHTML, "div");
    b.setAttribute("class", `${REF}-msg assistant`);
    const inner = doc.createElementNS(XHTML, "div");
    inner.setAttribute("class", "markdown-body");
    inner.innerHTML = renderMarkdown(state.pending);
    b.appendChild(inner);
    container.appendChild(b);
  }
  container.scrollTop = container.scrollHeight;
  syncStatus();
}

/** Model + estimated context-usage chip in the context bar. */
function syncStatus() {
  try {
    const el = state.statusEl;
    if (!el) return;
    const cfg = getConfig();
    const model = cfg.model.trim();
    if (!model || !state.itemID) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const sys = itemContextSystem();
    const outgoing = sys ? [sys, ...thread()] : [...thread()];
    const text = outgoing.map((m) => m.content).join("\n") + (state.pending || "");
    const tokens = estimateTokens(text);
    const limit = Number(cfg.contextLimit) || 128000;
    const pct = Math.min(100, Math.round((tokens / limit) * 100));
    el.textContent = `${model} · ${tokens.toLocaleString()} / ${limit.toLocaleString()} tok · ${pct}%`;
    el.hidden = false;
  } catch {
    /* status chip is optional */
  }
}

/** Build a system message describing the currently selected item (if any). */
function itemContextSystem(): ChatMessage | null {
  try {
    const id = state.itemID;
    if (!id) return null;
    const item = (Zotero as any).Items?.get?.(id);
    if (!item || typeof item.getField !== "function") return null;
    const title = item.getField?.("title") || "";
    const creators =
      item
        .getCreators?.()
        ?.map((c: any) =>
          [c.firstName, c.lastName].filter(Boolean).join(" "),
        )
        .filter(Boolean)
        .join(", ") || "";
    const date = item.getField?.("date") || "";
    const abstract = item.getField?.("abstractNote") || "";
    let ctx = `Selected Zotero item: "${title}".`;
    if (creators) ctx += ` Authors: ${creators}.`;
    if (date) ctx += ` Date: ${date}.`;
    if (abstract) ctx += `\nAbstract: ${abstract}`;
    return {
      role: "system",
      content:
        "You are Zotero GPT, an assistant inside the Zotero reference manager. " +
        "Help the user with the selected item and answer in Markdown.\n\n" +
        ctx,
    };
  } catch {
    return null;
  }
}

function wire(body: HTMLElement) {
  bump("panelRenderCount");
  const doc = body.ownerDocument;
  if (!doc) return;

  // In production the framework injects bodyXHTML before onRender. When wired
  // against a fresh container (e.g. standalone mounting), inject it ourselves.
  if (!q(body, `.${REF}-panel`)) {
    try {
      const win = doc.defaultView as any;
      const MozX = win?.MozXULElement || (globalThis as any).MozXULElement;
      const frag = MozX
        ? doc.importNode(MozX.parseXULToFragment(BODY_XHTML), true)
        : doc.createRange().createContextualFragment(BODY_XHTML);
      body.appendChild(frag);
    } catch (e) {
      ztoolkit.log("panel bodyXHTML inject failed", e);
    }
  }

  const panel = q(body, `.${REF}-panel`);
  if (!panel) return;

  const toggle = q(body, `.${REF}-s-toggle`) as HTMLButtonElement;
  const sSplit = q(body, `.${REF}-s-split`) as HTMLButtonElement;
  const hint = q(body, `.${REF}-hint`) as HTMLElement;
  const settings = q(body, `.${REF}-settings`) as HTMLElement;
  const messagesEl = q(body, `.${REF}-messages`) as HTMLElement;
  const input = q(body, `.${REF}-input`) as HTMLTextAreaElement;
  const send = q(body, `.${REF}-send`) as HTMLButtonElement;
  const sApi = q(body, `.${REF}-s-api`) as HTMLInputElement;
  const sKey = q(body, `.${REF}-s-key`) as HTMLInputElement;
  const sModel = q(body, `.${REF}-s-model`) as HTMLInputElement;
  const sTemp = q(body, `.${REF}-s-temp`) as HTMLInputElement;
  const sCtxLimit = q(body, `.${REF}-s-ctx-limit`) as HTMLInputElement;
  const sRefresh = q(body, `.${REF}-s-refresh`) as HTMLButtonElement;
  const sSave = q(body, `.${REF}-s-save`) as HTMLButtonElement;
  const sModels = body.querySelector(`#${REF}-models`) as HTMLDataListElement | null;
  const eEnabled = q(body, `.${REF}-e-enabled`) as HTMLInputElement;
  const eApi = q(body, `.${REF}-e-api`) as HTMLInputElement;
  const eKey = q(body, `.${REF}-e-key`) as HTMLInputElement;
  const eModel = q(body, `.${REF}-e-model`) as HTMLInputElement;
  const eType = q(body, `.${REF}-e-type`) as HTMLSelectElement;
  const eDim = q(body, `.${REF}-e-dim`) as HTMLInputElement;
  const eRefresh = q(body, `.${REF}-e-refresh`) as HTMLButtonElement;
  const eTest = q(body, `.${REF}-e-test`) as HTMLButtonElement;
  const eStatus = q(body, `.${REF}-e-status`) as HTMLElement;
  const eModels = body.querySelector(`#${REF}-embed-models`) as HTMLDataListElement | null;
  const aExport = q(body, `.${REF}-a-export`) as HTMLButtonElement;
  const aNote = q(body, `.${REF}-a-note`) as HTMLButtonElement;
  const ctxLabel = q(body, `.${REF}-ctx-label`) as HTMLElement;
  const ctxTitle = q(body, `.${REF}-ctx-title`) as HTMLElement;
  const ctxPage = q(body, `.${REF}-ctx-page`) as HTMLElement;
  const ctxStatus = q(body, `.${REF}-ctx-status`) as HTMLElement;
  state.statusEl = ctxStatus;
  const qSel = q(body, `.${REF}-q-sel`) as HTMLButtonElement;
  const qPage = q(body, `.${REF}-q-page`) as HTMLButtonElement;
  const qAnn = q(body, `.${REF}-q-ann`) as HTMLButtonElement;
  const attachBar = q(body, `.${REF}-attach`) as HTMLElement;
  const attachLabel = q(body, `.${REF}-attach-label`) as HTMLElement;
  const attachPreview = q(body, `.${REF}-attach-preview`) as HTMLElement;
  const attachX = q(body, `.${REF}-attach-x`) as HTMLButtonElement;

  const getItemTitle = (): string => currentItemTitle();

  const refreshActions = () => {
    const has = thread().length > 0;
    aExport.disabled = !has;
    aNote.disabled = !has;
  };

  const syncPageLabel = () => {
    const has = state.reader && state.currentPage > 0;
    ctxPage.textContent = has ? `p. ${state.currentPage}` : "";
    ctxPage.hidden = !has;
  };

  /** Show/hide the PDF-selection attachment bar above the input. */
  const syncAttach = () => {
    const has = !!state.pdfAttach;
    attachBar.hidden = !has;
    attachLabel.textContent = getString("pdf-attach-label");
    attachX.textContent = "✕";
    attachX.title = getString("pdf-attach-remove");
    attachPreview.textContent = has ? state.pdfAttach : "";
  };



  /** Enable PDF quick actions when a reader is open for the current item. */
  const refreshPdfActions = () => {
    const reader = getReaderForItem(state.itemID);
    state.reader = reader;
    const hasReader = !!reader;
    qSel.disabled = !hasReader;
    qPage.disabled = !hasReader;
    qAnn.disabled = !hasReader;
    if (hasReader) {
      if (!state.pageCleanup) {
        state.currentPage = getCurrentPageNumber(reader);
        state.pageCleanup = trackPageChanges(reader, (p) => {
          state.currentPage = p;
          refreshPdfActions();
        });
      }
      // Auto-attach PDF selections to the chat input as the user drags text.
      if (state.selectionCleanup == null || state.selectionReader !== reader) {
        state.selectionCleanup?.();
        state.selectionCleanup = trackSelectionChanges(reader, (text) => {
          state.pdfAttach = text || null;
          syncAttach();
        });
        state.selectionReader = reader;
      }
      syncPageLabel();
      stopReaderPoll();
    } else {
      state.selectionCleanup?.();
      state.selectionCleanup = null;
      state.selectionReader = null;
      state.pdfAttach = null;
      syncAttach();
      syncPageLabel();
      // The reader registers asynchronously after a PDF opens; poll briefly
      // so the actions enable as soon as it is available.
      if (state.itemID) {
        readerPollFn = () => refreshPdfActions();
        if (readerPollTimer == null) {
          readerPollTimer = setInterval(() => {
            try {
              readerPollFn?.();
            } catch {
              /* keep polling */
            }
          }, 1000);
        }
      } else {
        stopReaderPoll();
      }
    }
  };

  const note = (text: string) => {
    thread().push({ role: "assistant", content: text });
    state.pending = "";
    syncMessages(body);
    refreshActions();
  };

  const fillList = (list: HTMLDataListElement | null, models: string[]) => {
    if (!list) return;
    list.textContent = "";
    for (const id of models) {
      const opt = doc.createElementNS(XHTML, "option");
      opt.setAttribute("value", id);
      list.appendChild(opt);
    }
  };

  const populateSettings = () => {
    const cfg = getConfig();
    sApi.value = cfg.api;
    sKey.value = cfg.secretKey;
    sModel.value = cfg.model;
    sTemp.value = String(cfg.temperature);
    sCtxLimit.value = String(Number(cfg.contextLimit) || 128000);
    sApi.placeholder = "https://api.openai.com";
    sKey.placeholder = "sk-...";
    sModel.placeholder = "gpt-4o-mini";

    const ecfg = getEmbedConfig();
    eEnabled.checked = ecfg.enabled;
    eApi.value = ecfg.api;
    eKey.value = ecfg.secretKey;
    eModel.value = ecfg.model;
    eType.value = ecfg.providerType || "openai";
    eDim.value = ecfg.dim;
    eApi.placeholder = "https://api.openai.com";
    eKey.placeholder = "sk-... (blank for local servers)";
    eModel.placeholder = "text-embedding-3-small";
  };

  const refreshHint = () => {
    const cfg = getConfig();
    const show = !cfg.secretKey.trim() && !state.settingsOpen;
    hint.textContent = getString("panel-hint-nokey");
    hint.hidden = !show;
  };

  const syncToggle = () => {
    toggle.textContent = getString(
      state.settingsOpen ? "settings-close" : "settings-open",
    );
    settings.hidden = !state.settingsOpen;
  };

  // Localized labels (re-applied on every render; cheap).
  (q(body, `.${REF}-lbl-chat`) as HTMLElement).textContent =
    getString("settings-chat-group");
  (q(body, `.${REF}-lbl-embed`) as HTMLElement).textContent =
    getString("settings-embed-group");
  (q(body, `.${REF}-lbl-api`) as HTMLElement).textContent =
    getString("settings-api");
  (q(body, `.${REF}-lbl-key`) as HTMLElement).textContent =
    getString("settings-key");
  (q(body, `.${REF}-lbl-model`) as HTMLElement).textContent =
    getString("settings-model");
  (q(body, `.${REF}-lbl-temp`) as HTMLElement).textContent =
    getString("settings-temperature");
  (q(body, `.${REF}-lbl-ctx-limit`) as HTMLElement).textContent =
    getString("settings-context-limit");
  sRefresh.textContent = getString("settings-refresh");
  sSave.textContent = getString("settings-save");
  (q(body, `.${REF}-lbl-embed-enabled`) as HTMLElement).textContent =
    getString("settings-embed-enabled");
  (q(body, `.${REF}-lbl-embed-api`) as HTMLElement).textContent =
    getString("settings-embed-api");
  (q(body, `.${REF}-lbl-embed-key`) as HTMLElement).textContent =
    getString("settings-embed-key");
  (q(body, `.${REF}-lbl-embed-model`) as HTMLElement).textContent =
    getString("settings-embed-model");
  (q(body, `.${REF}-lbl-embed-type`) as HTMLElement).textContent =
    getString("settings-embed-type");
  (q(body, `.${REF}-lbl-embed-dim`) as HTMLElement).textContent =
    getString("settings-embed-dim");
  eRefresh.textContent = getString("settings-refresh");
  eTest.textContent = getString("settings-embed-test");
  ctxLabel.textContent = getString("panel-context-label");
  ctxTitle.textContent = currentItemTitle() || getString("panel-context-none");
  qSel.textContent = getString("pdf-action-selection");
  qPage.textContent = getString("pdf-action-page");
  qAnn.textContent = getString("pdf-action-annotations");
  aExport.textContent = getString("action-export");
  aNote.textContent = getString("action-note");
  input.setAttribute("placeholder", getString("panel-placeholder"));
  send.textContent = state.busy ? getString("panel-stop") : getString("panel-send");

  sSplit.textContent = getString("split-open");

  syncToggle();
  populateSettings();
  refreshHint();
  syncMessages(body);
  refreshActions();
  refreshPdfActions();
  syncAttach();

  if (panel.dataset.wired === "1") return;
  panel.dataset.wired = "1";

  // Treat the chat as its own scroll island: wheel events over the panel must
  // never bubble to the item pane (which would scroll it / switch sections).
  panel.addEventListener(
    "wheel",
    (e: Event) => {
      e.stopPropagation();
    },
    { passive: true },
  );

  const handleCommand = (raw: string): boolean => {
    const parts = raw.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");
    switch (cmd) {
      case "/clear":
        thread().length = 0;
        state.pending = "";
        syncMessages(body);
        refreshActions();
        return true;
      case "/page": {
        const n = parsePageCommand(raw);
        if (!n) {
          note(getString("pdf-page-invalid"));
          return true;
        }
        const r = getReaderForItem(state.itemID);
        if (!r) {
          note(getString("pdf-no-open"));
          return true;
        }
        navigateToPage(r, n);
        note(`${getString("pdf-page-goto")} ${n}`);
        return true;
      }
      case "/api":
      case "/model":
      case "/key":
        if (!arg) return true;
        if (cmd === "/api") setConfig({ api: arg });
        if (cmd === "/model") setConfig({ model: arg });
        if (cmd === "/key") setConfig({ secretKey: arg });
        populateSettings();
        refreshHint();
        note(getString("settings-saved"));
        return true;
      default:
        return false;
    }
  };

  const sendText = async (raw: string, attachPdf = false) => {
    let text = (raw || "").trim();
    if (!text || state.busy) return;

    if (text.startsWith("/") && handleCommand(text)) return;

    // Attach the currently selected PDF passage to this message (input Send
    // only). With no typed text this becomes an "explain selection" request;
    // with text it is added as quoted context.
    if (attachPdf && state.pdfAttach) {
      const attach = state.pdfAttach;
      text = text
        ? `${text}\n\n[${getString("pdf-attach-label")}]\n"""\n${attach}\n"""`
        : buildSelectionMessage(attach) || text;
      if (!text) return;
      state.pdfAttach = null;
      syncAttach();
    }

    const cfg = getConfig();
    const problem = configError(cfg);
    if (problem) {
      state.settingsOpen = true;
      syncToggle();
      populateSettings();
      note(problem);
      return;
    }

    state.busy = true;
    send.textContent = getString("panel-stop");
    thread().push({ role: "user", content: text });
    syncMessages(body);

    const key = threadKey();
    const sys = itemContextSystem();
    const outgoing = sys ? [sys, ...thread()] : [...thread()];
    const stream = streamChat(outgoing, (delta) => {
      state.pending += delta;
      if (threadKey() === key) syncMessages(body);
    });
    state.activeStream = stream;
    state.pending = "";

    try {
      const full = await stream.done;
      if (threadKey() === key) {
        thread().push({
          role: "assistant",
          content: full || "(empty response)",
        });
      }
    } catch (e: any) {
      if (threadKey() === key) {
        thread().push({
          role: "assistant",
          content: `\u26a0 ${e?.message || e}`,
        });
      }
    } finally {
      if (threadKey() === key) {
        state.pending = "";
        state.busy = false;
        state.activeStream = null;
        send.textContent = getString("panel-send");
        syncMessages(body);
        refreshActions();
        input.focus();
      }
    }
  };

  const onSend = async () => {
    const text = input.value.trim();
    input.value = "";
    void sendText(text, true);
  };

  qSel.addEventListener("click", () => {
    const r = state.reader;
    if (!r) {
      note(getString("pdf-no-open"));
      return;
    }
    const msg = buildSelectionMessage(state.pdfAttach || getSelectionText(r));
    if (!msg) {
      note(getString("pdf-no-selection"));
      return;
    }
    state.pdfAttach = null;
    syncAttach();
    void sendText(msg);
  });
  qPage.addEventListener("click", async () => {
    const r = state.reader;
    if (!r) {
      note(getString("pdf-no-open"));
      return;
    }
    const page = state.currentPage || getCurrentPageNumber(r);
    const text = await getPageText(r, page);
    const msg = buildPageMessage(page, text);
    if (!msg) {
      note(getString("pdf-no-page-text"));
      return;
    }
    void sendText(msg);
  });
  qAnn.addEventListener("click", () => {
    if (!state.reader) {
      note(getString("pdf-no-open"));
      return;
    }
    const item = state.itemID
      ? (Zotero as any).Items?.get?.(state.itemID)
      : null;
    const msg = buildAnnotationsMessage(collectAnnotations(item));
    if (!msg) {
      note(getString("pdf-no-annotations"));
      return;
    }
    void sendText(msg);
  });
  attachX.addEventListener("click", () => {
    state.pdfAttach = null;
    syncAttach();
  });
  sSplit.addEventListener("click", () => {
    splitView();
  });
  toggle.addEventListener("click", () => {
    state.settingsOpen = !state.settingsOpen;
    syncToggle();
    populateSettings();
    refreshHint();
    if (state.settingsOpen) settings.scrollIntoView({ block: "nearest" });
  });
  sRefresh.addEventListener("click", async () => {
    sRefresh.disabled = true;
    try {
      fillList(sModels, await listModels());
    } finally {
      sRefresh.disabled = false;
    }
  });
  eRefresh.addEventListener("click", async () => {
    eRefresh.disabled = true;
    try {
      fillList(eModels, await listEmbedModels());
    } finally {
      eRefresh.disabled = false;
    }
  });
  eTest.addEventListener("click", async () => {
    eStatus.textContent = "";
    eStatus.className = `${REF}-e-status`;
    eTest.disabled = true;
    try {
      const vectors = await embedTexts(["connection test"]);
      const dim = vectors[0]?.length ?? 0;
      eStatus.textContent = getString("settings-embed-ok") + ` (${dim})`;
      eStatus.classList.add("ok");
    } catch (e: any) {
      eStatus.textContent = `\u26a0 ${e?.message || e}`;
      eStatus.classList.add("err");
    } finally {
      eTest.disabled = false;
    }
  });
  sSave.addEventListener("click", () => {
    setConfig({
      api: sApi.value.trim(),
      secretKey: sKey.value.trim(),
      model: sModel.value.trim(),
      temperature: Number(sTemp.value) || 1,
      contextLimit: Number(sCtxLimit.value) || 128000,
    });
    setEmbedConfig({
      enabled: eEnabled.checked,
      api: eApi.value.trim(),
      secretKey: eKey.value.trim(),
      model: eModel.value.trim(),
      providerType: eType.value || "openai",
      dim: eDim.value.trim(),
    });
    state.settingsOpen = false;
    syncToggle();
    refreshHint();
    note(getString("settings-saved"));
  });
  aExport.addEventListener("click", async () => {
    if (!thread().length) {
      note(getString("action-empty"));
      return;
    }
    try {
      const path = await exportToMd(thread(), {
        itemTitle: getItemTitle(),
        itemID: state.itemID,
      });
      note(`${getString("action-exported")} ${path}`);
    } catch (e: any) {
      note(`\u26a0 ${e?.message || e}`);
    }
  });
  aNote.addEventListener("click", async () => {
    if (!thread().length) {
      note(getString("action-empty"));
      return;
    }
    try {
      const id = await saveAsNote(
        thread(),
        { itemTitle: getItemTitle(), itemID: state.itemID },
        state.itemID,
      );
      note(`${getString("action-note-done")} ${id}`);
    } catch (e: any) {
      note(`\u26a0 ${e?.message || e}`);
    }
  });
  send.addEventListener("click", () => {
    if (state.busy) state.activeStream?.cancel();
    else void onSend();
  });
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (state.busy) state.activeStream?.cancel();
      else void onSend();
    }
  });
  void messagesEl;
}

export const ChatPanel = {
  paneID: PANE_ID,

  registerStyles(doc: Document) {
    registerStyles(doc);
  },

  register() {
    if (sectionRegistered) return;
    // Default the section to expanded (framework persists open-state in this pref).
    try {
      Zotero.Prefs.set(`panes.${namespacedPaneID()}.open`, true);
    } catch {}
    Zotero.ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: config.addonID,
      bodyXHTML: BODY_XHTML,
      header: {
        l10nID: getLocaleID("panel-title"),
        icon: `chrome://${REF}/content/icons/icon16.png`,
      },
      sidenav: {
        l10nID: getLocaleID("panel-sidenav"),
        icon: `chrome://${REF}/content/icons/icon20.png`,
      },
      onInit() {
        bump("panelInitCount");
        ztoolkit.log("Zotero GPT section init");
      },
      onItemChange(props: any) {
        const id =
          props?.item?.id ?? props?.itemID ?? props?.itemId ?? null;
        if (id !== state.itemID) {
          // Switching items switches the context thread: drop any in-flight reply.
          state.activeStream?.cancel?.();
          state.activeStream = null;
          state.busy = false;
          state.pending = "";
          state.pageCleanup?.();
          state.pageCleanup = null;
          state.selectionCleanup?.();
          state.selectionCleanup = null;
          state.selectionReader = null;
          state.reader = null;
          state.currentPage = 0;
          state.pdfAttach = null;
          stopReaderPoll();
        }
        state.itemID = id;
        // Split-screen UX: keep the chat expanded while reading a PDF.
        if (props?.tabType === "reader") ensureSectionOpen();
        props?.setEnabled?.(true);
        return true;
      },
      onRender(props: any) {
        wire(props.body as HTMLElement);
      },
      onDestroy() {
        ztoolkit.log("Zotero GPT section destroy");
      },
    });
    sectionRegistered = true;
    try {
      const inst = (Zotero as any)[config.addonInstance];
      if (inst?.api) {
        inst.api.renderPanel = (body: HTMLElement, itemID?: number | null) => {
          if (itemID !== undefined) state.itemID = itemID;
          wire(body);
        };
        // Test/reader hook: switch the active context thread.
        inst.api.setActiveItem = (id: number | null) => {
          if (id === state.itemID) return;
          state.itemID = id;
          state.activeStream?.cancel?.();
          state.activeStream = null;
          state.busy = false;
          state.pending = "";
        };
        inst.api.currentThread = () => thread();
        inst.api.threadKey = () => threadKey();
        inst.api.ensureSectionOpen = () => ensureSectionOpen();
        inst.api.splitView = () => splitView();
        inst.api.reader = {
          getReaderForItem,
          getCurrentPageNumber,
          getSelectionText,
          getPageText,
          collectAnnotations,
          buildSelectionMessage,
          buildPageMessage,
          buildAnnotationsMessage,
          parsePageCommand,
          navigateToPage,
          trackPageChanges,
          trackSelectionChanges,
        };
        inst.api.provider = {
          getConfig,
          setConfig,
          normalizeBaseUrl,
          chatEndpoint,
          modelsEndpoint,
          deltaFromSSELine,
          configError,
          listModels,
          streamChat,
          getEmbedConfig,
          setEmbedConfig,
          embedConfigError,
          embedEndpoint,
          embedTexts,
          listEmbedModels,
        };
        inst.api.chatlog = {
          buildMarkdown,
          buildNoteHTML,
          chatsDir,
          exportToMd,
          saveAsNote,
        };
      }
    } catch {}
    ztoolkit.log("Zotero GPT item-pane section registered");
  },

  unregister() {
    stopReaderPoll();
    state.selectionCleanup?.();
    state.selectionCleanup = null;
    state.selectionReader = null;
    state.pdfAttach = null;
    if (!sectionRegistered) return;
    Zotero.ItemPaneManager.unregisterSection(PANE_ID);
    sectionRegistered = false;
  },
};

