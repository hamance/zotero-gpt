import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { ChatMessage, streamChat } from "./provider";

const REF = config.addonRef;
const PANE_ID = `${REF}-chat`;
const STYLE_ID = `${PANE_ID}-style`;

let sectionRegistered = false;

/** Conversation state (survives section re-renders). */
const state: {
  messages: ChatMessage[];
  pending: string;
  busy: boolean;
} = { messages: [], pending: "", busy: false };

function bump(key: string) {
  try {
    const api = (Zotero as any)[config.addonInstance]?.api as
      | Record<string, number>
      | undefined;
    if (api) api[key] = (api[key] || 0) + 1;
  } catch {}
}

const PANEL_CSS = `
.${REF}-panel{display:flex;flex-direction:column;gap:8px;padding:6px;font-size:13px;}
.${REF}-messages{display:flex;flex-direction:column;gap:6px;min-height:110px;max-height:420px;overflow-y:auto;}
.${REF}-msg{padding:6px 8px;border-radius:8px;white-space:pre-wrap;word-wrap:break-word;line-height:1.4;}
.${REF}-msg.user{align-self:flex-end;background:#e8f3ff;color:#0a2540;max-width:85%;}
.${REF}-msg.assistant{align-self:flex-start;background:#f4f4f5;max-width:95%;}
.${REF}-empty{color:#888;font-style:italic;}
.${REF}-input-row{display:flex;gap:6px;align-items:flex-end;}
.${REF}-input{flex:1;resize:vertical;min-height:38px;max-height:160px;border:1px solid #d4d4d4;border-radius:6px;padding:6px 8px;font:inherit;}
.${REF}-send{border:none;border-radius:6px;padding:6px 14px;background:#1f6feb;color:#fff;cursor:pointer;font:inherit;}
.${REF}-send[disabled]{opacity:.5;cursor:default;}
`;

const BODY_XHTML = `
<html:div class="${REF}-panel">
  <html:div class="${REF}-messages"></html:div>
  <html:div class="${REF}-input-row">
    <html:textarea class="${REF}-input" rows="2"></html:textarea>
    <html:button class="${REF}-send"></html:button>
  </html:div>
</html:div>`;

const XHTML = "http://www.w3.org/1999/xhtml";

function registerStyles(doc: Document) {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElementNS(XHTML, "style");
  style.setAttribute("id", STYLE_ID);
  style.textContent = PANEL_CSS;
  doc.documentElement?.appendChild(style);
}

function q(body: HTMLElement, sel: string): HTMLElement {
  return body.querySelector(sel) as HTMLElement;
}

function syncMessages(body: HTMLElement) {
  const container = q(body, `.${REF}-messages`);
  if (!container) return;
  container.textContent = "";
  const doc = body.ownerDocument;
  if (!doc) return;
  if (state.messages.length === 0 && !state.pending) {
    const empty = doc.createElementNS(XHTML, "div");
    empty.setAttribute("class", `${REF}-empty`);
    empty.textContent = getString("panel-empty");
    container.appendChild(empty);
    return;
  }
  for (const m of state.messages) {
    const b = doc.createElementNS(XHTML, "div");
    b.setAttribute(
      "class",
      `${REF}-msg ${m.role === "user" ? "user" : "assistant"}`,
    );
    b.textContent = m.content;
    container.appendChild(b);
  }
  if (state.pending) {
    const b = doc.createElementNS(XHTML, "div");
    b.setAttribute("class", `${REF}-msg assistant`);
    b.textContent = state.pending;
    container.appendChild(b);
  }
  container.scrollTop = container.scrollHeight;
}

function wire(body: HTMLElement) {
  bump("panelRenderCount");
  // In production the framework injects bodyXHTML before onRender. When wired
  // against a fresh container (e.g. standalone mounting), inject it ourselves.
  if (!q(body, `.${REF}-panel`)) {
    try {
      const doc = body.ownerDocument;
      if (!doc) return;
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

  const input = q(body, `.${REF}-input`) as HTMLTextAreaElement;
  const send = q(body, `.${REF}-send`) as HTMLButtonElement;
  input.setAttribute("placeholder", getString("panel-placeholder"));
  send.textContent = getString("panel-send");
  send.disabled = state.busy;
  syncMessages(body);

  if (panel.dataset.wired === "1") return;
  panel.dataset.wired = "1";

  const onSend = async () => {
    const text = input.value.trim();
    if (!text || state.busy) return;
    state.busy = true;
    send.disabled = true;
    input.value = "";
    state.messages.push({ role: "user", content: text });
    state.pending = "";
    syncMessages(body);

    try {
      const full = await streamChat(state.messages, (delta) => {
        state.pending += delta;
        syncMessages(body);
      });
      state.messages.push({ role: "assistant", content: full });
      state.pending = "";
      syncMessages(body);
    } catch (e: any) {
      state.messages.push({
        role: "assistant",
        content: `Error: ${e?.message || e}`,
      });
      state.pending = "";
      syncMessages(body);
    } finally {
      state.busy = false;
      send.disabled = false;
      input.focus();
    }
  };

  send.addEventListener("click", onSend);
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
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
      Zotero.Prefs.set(`panes.${config.addonID}-${PANE_ID}.open`, true);
    } catch {}
    Zotero.ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: config.addonID,
      bodyXHTML: BODY_XHTML,
      header: {
        l10nID: getLocaleID("panel-title"),
        icon: `chrome://${REF}/content/icons/favicon.png`,
      },
      sidenav: {
        l10nID: getLocaleID("panel-sidenav"),
        icon: `chrome://${REF}/content/icons/favicon.png`,
      },
      onInit() {
        bump("panelInitCount");
        ztoolkit.log("Zotero GPT section init");
      },
      onItemChange(props: any) {
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
      if (inst?.api) inst.api.renderPanel = (body: HTMLElement) => wire(body);
    } catch {}
    ztoolkit.log("Zotero GPT item-pane section registered");
  },

  unregister() {
    if (!sectionRegistered) return;
    Zotero.ItemPaneManager.unregisterSection(PANE_ID);
    sectionRegistered = false;
  },
};




