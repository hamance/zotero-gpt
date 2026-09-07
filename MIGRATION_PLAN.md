# Zotero GPT — Modernization Plan (Z7–Z10, docked panel, custom provider)

**Target:** Zotero 7 → 10 (drop Zotero 6 only). License AGPL-3.0.
**Branch:** `dev/zetoro-10`.
**Rule:** every stage must build/typecheck and pass its recorded tests *before* it is committed. Runtime tests in real Zotero are manual (no automated suite) and require a local Zotero binary (`scripts/zotero-cmd.json`).

## Stages / TODO

| # | Stage | Status |
|---|-------|--------|
| 0 | Make the repo build again (remove external `../../validation/core` import + dead `zotero-adv-installer: file:..` dep); `npm install` + bundle + typecheck green | **Done** |
| 1 | Modern scaffold: current `zotero-plugin-toolkit` 5.x / `zotero-types` 4.x, ESM bootstrap, drop Z6, `strict_min_version 7.0` / `strict_max_version 10.0.*`, `.ftl` locale | In progress — version targeting + dev harness done; scaffold/toolkit migration next |
| 2 | Docked side panel: register `Zotero.Reader.registerReaderTabPanel(...)` (reader) and/or `Zotero.ItemPaneManager.registerSection(...)` (item pane); port chat UI from the floating `position:fixed` overlay; delete drag/zoom/position + reader-`eval`/`.selection-popup` hacks | Planned |
| 3 | Custom providers: OpenAI-compatible **chat** provider with model auto-discovery; **independent embedding provider** (own URL/key/model, local-model support); vector-cache correctness fixes; real settings UI. Detail below. | Planned |

## Key facts gathered
- UI today = `position:fixed` draggable div (`src/modules/views.ts`, ~1.4k lines), rebuilt on each `Ctrl+/`.
- Chat already POSTs to `${api}/v1/chat/completions` with Bearer auth + SSE parsing of `choices[0].delta.content` (`src/modules/Meet/OpenAI.ts`).
- Embeddings currently share the chat config: URL hard-coded `${api}/v1/embeddings`, model hard-coded `text-embedding-ada-002`, key = chat `secretKey` (and **empty key aborts the request**), response parsed as `{data:[{embedding}]}`.
- Vector cache (`src/modules/localStorage.ts`) is keyed by `item.key` -> `MD5(pageContent)` only — it does **not** include the embedding model, so switching models silently reuses stale vectors of a different dimension/semantics.
- App code only imports: `crypto-js`, `compute-cosine-similarity`, `markdown-it(+mathjax3)`, `langchain/document` (type only), toolkit. Other package.json deps are unused.
- Z8 = Firefox 140 + full ESM/Bluebird removal; Z9 = no dev changes; Z10 = plural selection getters (we use plural `getSelectedItems()` — safe), ItemTree refactor, FTS5, FTL rework. Panel APIs (`registerReaderTabPanel`, `ItemPaneManager.registerSection`) introduced in Z7 and not removed through Z10.

## Stage 3 detail — custom providers

### 3a. Chat provider (OpenAI-compatible)
- Minimum inputs: **base URL** (`api`), **API key** (`secretKey`), **chat model id** (`model`). Already functional via `POST {base}/v1/chat/completions`, `Authorization: Bearer`, body `{model, messages, stream:true, temperature}`; SSE parsed from `choices[0].delta.content`.
- Base-URL normalization already strips a trailing `/v1`; user may enter root domain with or without `/v1`.
- **Model auto-discovery (new):** `GET {base}/v1/models` with Bearer auth -> take `data[].id`; populate a dropdown with a refresh button. Must fail soft (some compatible servers omit `/models` or use a different path) -> fall back to a free-text model field; never block chat.
- **Remove dead fallbacks:** delete the hard-coded `aigpt.one` / `theb.ai` `requestArgs` and the empty-key fallback that routes to them. Missing key -> clear configuration error instead.
- Keep client-side knobs: `temperature`, `chatNumber` (history window). `stream:true` stays; no non-stream fallback for now.

### 3b. Independent embedding provider (separate from chat)
Embeddings may live on a different host, use a different model/key, or run **locally with no key** — so they get their own config block:

| New pref | Purpose |
|---|---|
| `embedEnabled` (bool) | Master switch; when off, RAG / similarity search degrades gracefully (no vectors) instead of erroring |
| `embedApi` | Embedding base URL, independent of chat `api` (may be `http://localhost:11434` etc.) |
| `embedSecretKey` | Separate key; **empty allowed** for local servers (omit the `Authorization` header when blank) |
| `embedModel` | e.g. `text-embedding-3-small`, `nomic-embed-text`, `bge-m3` |
| `embedProviderType` | Response/endpoint shape: `openai` (default, `/v1/embeddings` -> `{data:[{embedding}]}`), `ollama-native` (`/api/embeddings`, single `prompt`, loop), `tei` (`/embed`, body `{inputs:[]}`, returns **bare arrays**) |
| `embedDim` (optional) | Sent as `dimensions` when supported; also used to validate returned vectors |
| `embeddingBatchNum` (existing) | Batch size for `input[]`; keep |

- Local-model coverage: **Ollama** (`http://localhost:11434/v1/embeddings`) and **LM Studio** (`http://localhost:1234/v1/embeddings`) already speak the OpenAI shape with no key -> use type `openai`; add `ollama-native`/`tei` only as needed.
- Model auto-discovery for embeddings too (`GET {embedApi}/v1/models` lists locally pulled models on Ollama) with the same fail-soft behavior.

### 3c. Correctness fixes (required — otherwise results are silently wrong)
- **Cache key must include embedding identity:** fold `embedApi + embedModel + embedDim` into the cache id / a per-model namespace in `localStorage.ts` + `OpenAI.ts similaritySearch`. Today switching model reuses another model's vectors (dimension/semantics mismatch -> cosine NaN/garbage).
- **Dimension consistency check:** after embedding, verify query-vector length == document-vector length; on mismatch, discard cached vectors and recompute.
- **Empty-key path:** allow embeddings requests with no `Authorization` header (local servers); remove the current "no secretKey -> return/abort" guard for the embedding provider.

### 3d. Settings UI
- Ship a real preferences UI (builds on Stage 1 scaffold / Stage 2 panel): chat section (base URL, key, model dropdown+refresh, temperature) and embeddings section (enabled, base URL, key, model dropdown+refresh, provider type, dim). Replaces the missing `preferences.xul` and the slash-command-only setup; keep `/api`, `/model`, `/secretKey`, `/report` slash commands as a fallback.

### New prefs to add (`addon/prefs.js`)
`embedEnabled` (true), `embedApi` (""), `embedSecretKey` (""), `embedModel` ("text-embedding-3-small"), `embedProviderType` ("openai"), `embedDim` (""). Chat `api`/`secretKey`/`model`/`temperature` already exist.

### Stage 3 test gates (record before commit)
- `npm run tsc` and `npm run build` green.
- Manual (Zotero): configure an OpenAI-compatible chat endpoint (e.g. DeepSeek or local) -> answer streams; bad/missing `/models` still allows typed model id.
- Embeddings: point `embedApi` at a local Ollama/LM Studio with **blank key** -> AskPDF/RAG works; toggle `embedEnabled` off -> RAG disabled with no error.
- Switch `embedModel` -> vectors recompute (no stale cache); cosine ranking sane (no NaN).
- If `tei`/`ollama-native` implemented, verify their response shapes parse.

## Test log

### Stage 0 — restore build (2026-09-07)
- `npm install --no-audit --no-fund` -> exit 0, 791 packages (deprecation warnings only).
- `npm run tsc` (`tsc --noEmit`, strict) -> exit 0. Fixed pre-existing strict errors: typed `final_embeddings: any[]`, coerced `embeddingBatchNum` to `number` (`OpenAI.ts`); cast toolkit `appendElement` results `auxDiv`/`menuNode` to `HTMLElement` (`views.ts`).
- `npm run build` (prod esbuild + terser pack + tsc) -> exit 0; artifact `builds/zotero-gpt.xpi` (~829 KB).
- Changes: removed `initValidation` import+call (`src/hooks.ts`); removed dead `zotero-adv-installer: "file:.."` dep (`package.json`).
- **Manual gate (not run here):** install `zotero-gpt.xpi` in Zotero 7 and confirm the plugin window opens (`Ctrl+/`). Requires a local Zotero binary path in `scripts/zotero-cmd.json`.

### Stage 1 — modern targeting + dev harness (2026-09-07)
- Dropped Z6 ceil / set range: `addon/manifest.json` `strict_min_version 7.0.0`, `strict_max_version 10.0.*` (build still green: `npm run build-dev` packs xpi with new range).
- Dev runtime harness added (gitignored): `scripts/zotero-cmd.json` → installed Zotero at `C:\Program Files\Zotero\zotero.exe`; isolated profile under `profiles/zgp/` (`.gitignore` += `profiles/`).
- Detected installed Zotero platform: **Firefox 140 ESR** (Zotero 8/9/10 generation).
- Empirical finding: dropping the built `.xpi` into `<profile>/extensions/` (and as a CLI `file:` arg) does **not** sideload on this generation even with `autoDisableScopes/sideloadScopes/startupScanScopes=15`; the modern Zotero requires an actual install (the official `zotero-plugin` scaffold handles dev-install + hot reload). The old proxy-text-file method is also ignored.
- Next: adopt the current official scaffold (`zotero-plugin.config.ts`, toolkit 5.x) — it provides `start` dev-install/hot-reload — and migrate the ESM bootstrap; then verify the addon actually boots on FF140 before porting the panel.
- Remaining Z6 cleanup (folded into scaffold migration): remove `install.rdf`, Z6 `waitForZotero`/`setDefaultPrefs` paths in `addon/bootstrap.js`, prune dead deps, replace `langchain/document` type with a local type.
- Stage 0 — see git log (build restored, typecheck/build green).
- Stage 1 (partial) — version targeting + dev harness; scaffold migration in progress.

