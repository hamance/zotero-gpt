import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import {
  ChatMessage,
  ChatStream,
  chatEndpoint,
  configError,
  deltaFromSSELine,
  getConfig,
  listModels,
  modelsEndpoint,
  normalizeBaseUrl,
  setConfig,
  streamChat,
} from "./provider";

const REF = config.addonRef;
const PANE_ID = `${REF}-chat`;
const STYLE_ID = `${PANE_ID}-style`;
const XHTML = "http://www.w3.org/1999/xhtml";

let sectionRegistered = false;

/** Conversation + UI state (survives section re-renders). */
const state: {
  messages: ChatMessage[];
  pending: string;
  busy: boolean;
  itemID: number | null;
  activeStream: ChatStream | null;
} = { messages: [], pending: "", busy: false, itemID: null, activeStream: null };

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
.${REF}-hint{color:#9a6700;background:#fff8c5;border:1px solid #e0c366;border-radius:6px;padding:4px 8px;font-size:12px;}
.${REF}-hint[hidden]{display:none;}
.${REF}-settings{display:flex;flex-direction:column;gap:6px;border:1px solid #e0e0e0;border-radius:8px;padding:8px;background:#fafafa;}
.${REF}-settings[hidden]{display:none;}
.${REF}-field{display:flex;flex-direction:column;gap:2px;font-size:12px;color:#444;}
.${REF}-model-row{display:flex;gap:6px;}
.${REF}-model-row .${REF}-s-model{flex:1;}
.${REF}-settings input{border:1px solid #d4d4d4;border-radius:6px;padding:4px 6px;font:inherit;}
.${REF}-settings-actions{display:flex;justify-content:flex-end;}
.${REF}-s-save{border:none;border-radius:6px;padding:4px 12px;background:#1f6feb;color:#fff;cursor:pointer;font:inherit;}
.${REF}-s-refresh{border:1px solid #d4d4d4;border-radius:6px;padding:4px 8px;background:#fff;cursor:pointer;font:inherit;white-space:nowrap;}
.${REF}-input-row{display:flex;gap:6px;align-items:flex-end;}
.${REF}-input{flex:1;resize:vertical;min-height:38px;max-height:160px;border:1px solid #d4d4d8;border-radius:6px;padding:6px 8px;font:inherit;}
.${REF}-send{border:none;border-radius:6px;padding:6px 14px;background:#1f6feb;color:#fff;cursor:pointer;font:inherit;}
.${REF}-gear{border:1px solid #d4d4d8;border-radius:6px;padding:6px 10px;background:#fff;cursor:pointer;font-size:14px;line-height:1;}

/* Fit our 32px png into Zotero item-pane icon slots (16px header, 20px sidenav). */
item-pane-custom-section[data-pane*="zoterogpt-chat"] collapsible-section>.head .title::before{background-size:16px 16px;}
item-pane-sidenav .btn[data-pane*="zoterogpt-chat"]{background-size:20px 20px;}
`;

const BODY_XHTML = `
<html:div class="${REF}-panel">
  <html:div class="${REF}-messages"></html:div>
  <html:div class="${REF}-hint" hidden="hidden"></html:div>
  <html:div class="${REF}-settings" hidden="hidden">
    <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-api"></html:span><html:input class="${REF}-s-api" type="text" /></html:label>
    <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-key"></html:span><html:input class="${REF}-s-key" type="password" /></html:label>
    <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-model"></html:span>
      <html:span class="${REF}-model-row">
        <html:input class="${REF}-s-model" type="text" list="${REF}-models" />
        <html:button class="${REF}-s-refresh" type="button"></html:button>
      </html:span>
    </html:label>
    <html:datalist id="${REF}-models"></html:datalist>
    <html:label class="${REF}-field"><html:span class="${REF}-lbl ${REF}-lbl-temp"></html:span><html:input class="${REF}-s-temp" type="number" step="0.1" min="0" max="2" /></html:label>
    <html:div class="${REF}-settings-actions"><html:button class="${REF}-s-save" type="button"></html:button></html:div>
  </html:div>
  <html:div class="${REF}-input-row">
    <html:textarea class="${REF}-input" rows="2"></html:textarea>
    <html:button class="${REF}-send" type="button"></html:button>
    <html:button class="${REF}-gear" type="button">&#9881;</html:button>
  </html:div>
</html:div>`;

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

/** Build a system message describing the currently selected item (if any). */
function itemContextSystem(): ChatMessage | null {
  try {
    const id = state.itemID;
    if (!id) return null;
    const item = (Zotero as any).Items?.get?.(id);
    if (!item || typeof item.isItem !== "function" || !item.isItem()) return null;
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

  const hint = q(body, `.${REF}-hint`) as HTMLElement;
  const settings = q(body, `.${REF}-settings`) as HTMLElement;
  const input = q(body, `.${REF}-input`) as HTMLTextAreaElement;
  const send = q(body, `.${REF}-send`) as HTMLButtonElement;
  const gear = q(body, `.${REF}-gear`) as HTMLButtonElement;
  const sApi = q(body, `.${REF}-s-api`) as HTMLInputElement;
  const sKey = q(body, `.${REF}-s-key`) as HTMLInputElement;
  const sModel = q(body, `.${REF}-s-model`) as HTMLInputElement;
  const sTemp = q(body, `.${REF}-s-temp`) as HTMLInputElement;
  const sRefresh = q(body, `.${REF}-s-refresh`) as HTMLButtonElement;
  const sSave = q(body, `.${REF}-s-save`) as HTMLButtonElement;
  const dataList = body.querySelector(`#${REF}-models`) as HTMLDataListElement | null;

  const note = (text: string) => {
    state.messages.push({ role: "assistant", content: text });
    state.pending = "";
    syncMessages(body);
  };

  const fillModels = (models: string[]) => {
    if (!dataList) return;
    dataList.textContent = "";
    for (const id of models) {
      const opt = doc.createElementNS(XHTML, "option");
      opt.setAttribute("value", id);
      dataList.appendChild(opt);
    }
  };

  const populateSettings = () => {
    const cfg = getConfig();
    sApi.value = cfg.api;
    sKey.value = cfg.secretKey;
    sModel.value = cfg.model;
    sTemp.value = String(cfg.temperature);
    sApi.placeholder = "https://api.openai.com";
    sKey.placeholder = "sk-...";
    sModel.placeholder = "gpt-4o-mini";
  };

  const refreshHint = () => {
    const cfg = getConfig();
    hint.textContent = getString("panel-hint-nokey");
    hint.hidden = !!cfg.secretKey.trim();
  };

  // Localized labels (re-applied on every render; cheap).
  input.setAttribute("placeholder", getString("panel-placeholder"));
  gear.textContent = "\u2699";
  gear.title = getString("settings-title");
  send.textContent = state.busy
    ? getString("panel-stop")
    : getString("panel-send");
  (q(body, `.${REF}-lbl-api`) as HTMLElement).textContent =
    getString("settings-api");
  (q(body, `.${REF}-lbl-key`) as HTMLElement).textContent =
    getString("settings-key");
  (q(body, `.${REF}-lbl-model`) as HTMLElement).textContent =
    getString("settings-model");
  (q(body, `.${REF}-lbl-temp`) as HTMLElement).textContent =
    getString("settings-temperature");
  sRefresh.textContent = getString("settings-refresh");
  sSave.textContent = getString("settings-save");
  populateSettings();
  refreshHint();
  syncMessages(body);

  if (panel.dataset.wired === "1") return;
  panel.dataset.wired = "1";

  const handleCommand = (raw: string): boolean => {
    const parts = raw.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");
    switch (cmd) {
      case "/clear":
        state.messages = [];
        state.pending = "";
        syncMessages(body);
        return true;
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

  const onSend = async () => {
    const text = input.value.trim();
    if (!text || state.busy) return;
    input.value = "";

    if (text.startsWith("/") && handleCommand(text)) return;

    const cfg = getConfig();
    const problem = configError(cfg);
    if (problem) {
      note(problem);
      settings.hidden = false;
      populateSettings();
      return;
    }

    state.busy = true;
    send.textContent = getString("panel-stop");
    state.messages.push({ role: "user", content: text });
    syncMessages(body);

    const sys = itemContextSystem();
    const outgoing = sys ? [sys, ...state.messages] : [...state.messages];
    const stream = streamChat(outgoing, (delta) => {
      state.pending += delta;
      syncMessages(body);
    });
    state.activeStream = stream;
    state.pending = "";

    try {
      const full = await stream.done;
      state.messages.push({
        role: "assistant",
        content: full || "(empty response)",
      });
    } catch (e: any) {
      state.messages.push({
        role: "assistant",
        content: `\u26a0 ${e?.message || e}`,
      });
    } finally {
      state.pending = "";
      state.busy = false;
      state.activeStream = null;
      send.textContent = getString("panel-send");
      syncMessages(body);
      input.focus();
    }
  };

  send.addEventListener("click", () => {
    if (state.busy) state.activeStream?.cancel();
    else void onSend();
  });
  gear.addEventListener("click", () => {
    settings.hidden = !settings.hidden;
    if (!settings.hidden) populateSettings();
  });
  sRefresh.addEventListener("click", async () => {
    sRefresh.disabled = true;
    try {
      fillModels(await listModels());
    } finally {
      sRefresh.disabled = false;
    }
  });
  sSave.addEventListener("click", () => {
    setConfig({
      api: sApi.value.trim(),
      secretKey: sKey.value.trim(),
      model: sModel.value.trim(),
      temperature: Number(sTemp.value) || 1,
    });
    settings.hidden = true;
    refreshHint();
    note(getString("settings-saved"));
  });
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (state.busy) state.activeStream?.cancel();
      else void onSend();
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
        state.itemID =
          props?.item?.id ?? props?.itemID ?? props?.itemId ?? null;
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
        inst.api.renderPanel = (body: HTMLElement) => wire(body);
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
        };
      }
    } catch {}
    ztoolkit.log("Zotero GPT item-pane section registered");
  },

  unregister() {
    if (!sectionRegistered) return;
    Zotero.ItemPaneManager.unregisterSection(PANE_ID);
    sectionRegistered = false;
  },
};
