# Zotero GPT — Modernization Plan (Z7–Z10, docked panel, custom provider)

**Target:** Zotero 7 → 10 (drop Zotero 6 only). License AGPL-3.0.
**Branch:** `dev/zetoro-10`.
**Rule:** every stage must build/typecheck and pass its recorded tests *before* it is committed. Runtime tests in real Zotero are manual (no automated suite) and require a local Zotero binary (`scripts/zotero-cmd.json`).

## Stages / TODO

| # | Stage | Status |
|---|-------|--------|
| 0 | Make the repo build again (remove external `../../validation/core` import + dead `zotero-adv-installer: file:..` dep); `npm install` + bundle + typecheck green | **Done** |
| 1 | Modern scaffold: current `zotero-plugin-toolkit` 5.x / `zotero-types` 4.x, ESM bootstrap, drop Z6 (`install.rdf`, Z6 bootstrap paths), `strict_min_version 7.0` / `strict_max_version 10.0.*`, `.ftl` locale | Planned |
| 2 | Docked side panel: register `Zotero.Reader.registerReaderTabPanel(...)` (reader) and/or `Zotero.ItemPaneManager.registerSection(...)` (item pane); port chat UI from the floating `position:fixed` overlay; delete drag/zoom/position + reader-`eval`/`.selection-popup` hacks | Planned |
| 3 | Custom OpenAI-compatible provider: configurable base URL / model / key, configurable-or-optional embeddings model, remove dead fallbacks (`aigpt.one`, `theb.ai`), real settings UI | Planned |

## Key facts gathered
- UI today = `position:fixed` draggable div (`src/modules/views.ts`, ~1.4k lines), rebuilt on each `Ctrl+/`.
- Provider already POSTs to `${api}/v1/chat/completions` with Bearer auth + SSE parsing (`src/modules/Meet/OpenAI.ts`); embeddings model hard-coded `text-embedding-ada-002`.
- App code only imports: `crypto-js`, `compute-cosine-similarity`, `markdown-it(+mathjax3)`, `langchain/document` (type only), toolkit. Other package.json deps are unused.
- Z8 = Firefox 140 + full ESM/Bluebird removal; Z9 = no dev changes; Z10 = plural selection getters (we use plural `getSelectedItems()` — safe), ItemTree refactor, FTS5, FTL rework. Panel APIs (`registerReaderTabPanel`, `ItemPaneManager.registerSection`) introduced in Z7 and not removed through Z10.

## Test log

### Stage 0 — restore build (2026-09-07)
- `npm install --no-audit --no-fund` → exit 0, 791 packages (deprecation warnings only).
- `npm run tsc` (`tsc --noEmit`, strict) → exit 0. Fixed pre-existing strict errors: typed `final_embeddings: any[]`, coerced `embeddingBatchNum` to `number` (`OpenAI.ts`); cast toolkit `appendElement` results `auxDiv`/`menuNode` to `HTMLElement` (`views.ts`).
- `npm run build` (prod esbuild + terser pack + tsc) → exit 0; artifact `builds/zotero-gpt.xpi` (~829 KB).
- Changes: removed `initValidation` import+call (`src/hooks.ts`); removed dead `zotero-adv-installer: "file:.."` dep (`package.json`).
- **Manual gate (not run here):** install `zotero-gpt.xpi` in Zotero 7 and confirm the plugin window opens (`Ctrl+/`). Requires a local Zotero binary path in `scripts/zotero-cmd.json`.

## Commit log

- Stage 0 — see `git log` (build restored, typecheck/build green).

