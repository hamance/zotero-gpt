import { config } from "../../package.json";
import { FluentMessageId } from "../../typings/i10n";

export { initLocale, getString, getLocaleID };

function initLocale() {
  const l10n = new (
    typeof Localization === "undefined"
      ? ztoolkit.getGlobal("Localization")
      : Localization
  )([`${config.addonRef}-addon.ftl`], true);
  addon.data.locale = { current: l10n };
}

function getString(localString: FluentMessageId): string;
function getString(
  localString: FluentMessageId,
  options: { branch?: string; args?: Record<string, unknown> },
): string;
function getString(...inputs: any[]) {
  const [id, options = {}] = inputs;
  const pattern = addon.data.locale?.current.formatMessagesSync([
    { id: `${config.addonRef}-${id}`, args: options.args },
  ])[0] as { value: string | null; attributes: any[] } | undefined;
  if (!pattern) return id;
  if (options.branch && pattern.attributes) {
    return (
      pattern.attributes.find((a: any) => a.name === options.branch)?.value || id
    );
  }
  return pattern.value || id;
}

function getLocaleID(id: FluentMessageId) {
  return `${config.addonRef}-${id}`;
}
