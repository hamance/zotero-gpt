import { config } from "../package.json";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  ztoolkit.log("onStartup");

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Confirms plugin load status to the scaffold test/serve process.
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  ztoolkit.log("onMainWindowLoad", win?.location?.href);

  new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: 4000,
  })
    .createLine({
      text: "Zotero GPT loaded",
      type: "default",
    })
    .show();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
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
