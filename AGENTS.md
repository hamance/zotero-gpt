# Repository Guidelines

Zotero GPT is a Zotero 6/7 add-on (TypeScript, built on `zotero-plugin-toolkit`) that brings GPT chat and one-click "command tags" into Zotero. License: AGPL-3.0.

## Project Structure & Module Organization

- `src/` — TypeScript source:
  - `index.ts` (entry), `addon.ts` (singleton), `hooks.ts` (lifecycle: `onStartup`/`onShutdown`).
  - `modules/` — `views.ts` (UI panel), `utils.ts`, `locale.ts`, `localStorage.ts`, `base.ts`.
  - `modules/Meet/` — `api.ts` (user-facing **Meet API** for command tags), `OpenAI.ts`, `Zotero.ts`, `BetterNotes.ts`.
- `addon/` — plugin scaffold: `bootstrap.js`, `manifest.json`, `install.rdf`, `chrome/content/` (icons, `md.css`), `chrome/locale/` (`en-US`, `zh-CN`).
- `scripts/` — `build.js`, `start.js`, `stop.js`.
- `tags/` — built-in command-tag prompts (`*.txt`); `typing/` — type declarations; `imgs/` — README assets.
- Build output lands in gitignored `builds/` as the installable `.xpi`.

## Build, Test, and Development Commands

- `npm install` — install dependencies.
- `npm run build-dev` — esbuild development bundle into `builds/`.
- `npm run build` — production bundle plus `tsc --noEmit` type check.
- `npm run start` / `start-z6` / `start-z7` — launch Zotero (7 by default) with the plugin loaded; `npm run stop` closes it.
- `npm run restart-dev` — rebuild, stop, and relaunch; use this while iterating.
- `npm run release` — cut a release via `release-it` (maintainers).

## Coding Style & Naming Conventions

- TypeScript, 2-space indentation, double-quoted imports, semicolons. No ESLint/Prettier is configured — match surrounding code.
- `tsconfig.json` uses `strict: true`, ES2016, CommonJS. Run `npm run tsc` before submitting.
- Classes are PascalCase (`Addon`, `Views`, `Utils`); place new helpers under `src/modules/`.
- User-facing strings go in `addon/chrome/locale/` (both `en-US` and `zh-CN`); expose new tag features via `src/modules/Meet/api.ts`.

## Testing Guidelines

There is no test framework. Validate with `npm run restart-dev`, exercise the UI, and check Zotero 6 and 7 when UI or APIs change. Test tag prompts in the tag editor (`Ctrl+R` run, `Ctrl+S` save). Use the templates under `.github/ISSUE_TEMPLATE/` for bug reports.

## Commit & Pull Request Guidelines

- Use short, imperative commit messages, as in history: `add embeddingBatchNum to param`, `fix ${} bug`, `Update README.md`.
- Keep commits focused on one logical change.
- PRs should state what changed and why, link the related issue, and include screenshots/GIFs for UI changes. Ensure `npm run build` passes.

## Security & Configuration

- Never commit secrets: `.env` is gitignored and users enter their OpenAI API key in plugin settings — never hard-code keys.
- Add-on metadata (ID, name, version) lives under `config` in `package.json`; bump it there for releases.

