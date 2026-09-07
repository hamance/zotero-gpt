import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("registers the plugin instance", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("marks the addon initialized (onStartup + section register completed)", function () {
    assert.isTrue(Zotero[config.addonInstance].data.initialized);
  });

  it("resolves localized strings", function () {
    const title = (Zotero[config.addonInstance].data.locale as any)?.current
      ?.formatMessagesSync([
        { id: `${config.addonRef}-panel-title` },
      ])?.[0]?.value;
    assert.equal(title, "Zotero GPT");
  });

  it("exposes the item-pane manager used by the docked panel", function () {
    assert.isFunction((Zotero as any).ItemPaneManager?.registerSection);
  });
});
