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
    // panel-title is an attribute-only Fluent message (.label) so that Zotero
    // renders the section header without wiping the injected body.
    const msg = (Zotero[config.addonInstance].data.locale as any)?.current
      ?.formatMessagesSync([
        { id: `${config.addonRef}-panel-title` },
      ])?.[0];
    const label = (msg?.attributes || []).find(
      (a: any) => a.name === "label",
    )?.value;
    assert.equal(label, "Zotero GPT");
    assert.isNull(msg?.value ?? null);
  });

  it("exposes the item-pane manager used by the docked panel", function () {
    assert.isFunction((Zotero as any).ItemPaneManager?.registerSection);
  });
});
