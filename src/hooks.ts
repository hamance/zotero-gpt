import { config } from "../package.json";
import { initLocale, getString } from "./utils/locale";
import { ChatPanel } from "./modules/panel";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  initLocale();
  ztoolkit.log("onStartup");

  // Docked side panel (right-hand item pane; also shown in the reader).
  ChatPanel.register();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  ztoolkit.log("onMainWindowLoad", win?.location?.href);
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-addon.ftl`);
  ChatPanel.registerStyles(win.document);

  new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: 4000,
  })
    .createLine({ text: getString("startup"), type: "default" })
    .show();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  ChatPanel.unregister();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};



