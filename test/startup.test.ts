import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("registers the plugin instance", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("marks the addon initialized (onStartup completed)", function () {
    assert.isTrue(Zotero[config.addonInstance].data.initialized);
  });
});
