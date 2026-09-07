# Repository Guidelines

Zotero GPT is a Zotero 7–10 add-on (TypeScript/ESM, `zotero-plugin-scaffold` + `zotero-plugin-toolkit`) that adds a docked GPT chat panel to the item pane/reader and talks to any OpenAI-compatible API. License: AGPL-3.0. The `dev/zetoro-10` branch is the modernization line; `MIGRATION_PLAN.md` tracks stages and the test log.

## Project Structure & Module Organization

- `src/` — TypeScript source: `index.ts` (entry), `addon.ts` (singleton), `hooks.ts` (lifecycle), `modules/panel.ts` (docked item-pane section + settings UI + actions), `modules/provider.ts` (OpenAI-compatible chat + embedding providers), `modules/chatlog.ts` (Markdown export / Zotero note), `utils/` (`locale.ts`, `ztoolkit.ts`).
- `addon/` — scaffold assets: `bootstrap.js`, `manifest.json`, `prefs.js`, `content/` (icons, `md.css`), `locale/{en-US,zh-CN}/addon.ftl`.
- `test/` — mocha tests that run inside Zotero.
- `legacy/` (plus `tags/`, `imgs/`) — pre-migration code kept for reference; excluded from the build.
- Generated and gitignored: `.scaffold/build`, `typings/i10n.d.ts`, `typings/prefs.d.ts`.

## Build, Test, and Development Commands

- `npm install` — install dependencies.
- `npm run build` — `zotero-plugin build && tsc --noEmit` (strict); must pass before committing.
- `npm run tsc` — typecheck only.
- `npm test` — builds, launches Zotero (set `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` to `zotero.exe` if needed), and runs mocha in `test/`.
- `npm start` / `npm stop` — dev-install with hot reload; `npm run build-dev` / `build-prod` — dev/prod bundles.
- `npm run release` — cut a release (maintainers).

## Coding Style & Naming Conventions

- TypeScript `strict: true`; 2-space indentation, double quotes, semicolons. No ESLint/Prettier — match surrounding code.
- Classes are PascalCase (`Addon`, `ChatPanel`); helpers camelCase; UI/CSS classes prefixed `zoterogpt-`.
- User-facing strings live in both FTL files under `addon/locale/` using unprefixed keys (the scaffold adds the `zoterogpt-` prefix at build).
- Declare prefs in `addon/prefs.js` unprefixed; read them as `Zotero.Prefs.get("zoterogpt.<key>")`.

## Testing Guidelines

- Mocha + chai; `npm test` runs `test/*.test.ts` inside Zotero.
- Mock `Zotero.HTTP.request` for provider/network tests (stream SSE chunks via `onprogress`/`onload`).
- The harness cannot connect the custom item-pane section, so UI tests mount `addon.api.renderPanel(body)` into a live document and assert framework callback counters.
- Update the test log in `MIGRATION_PLAN.md` at each stage; build and tests must pass before the stage is committed.

## Commit & Pull Request Guidelines

- Follow Conventional Commits as in history: `feat(panel): …`, `refactor(scaffold): …`, `fix(build): …`, `docs: …`.
- Keep each commit one logical change; commit a stage only after `npm run build` and `npm test` pass.
- PRs: describe what and why, link the issue, and include screenshots/GIFs for UI changes.

## Security & Configuration

- Never commit secrets; users enter API keys at runtime (stored in prefs) — never hard-code keys.
- A blank key means "no `Authorization` header" (for keyless local servers such as Ollama/LM Studio).
