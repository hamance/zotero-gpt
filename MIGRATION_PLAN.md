# Zotero GPT — Modernization Plan (Z7–Z10, docked panel, custom provider)

**Target:** Zotero 7 → 10 (drop Zotero 6 only). License AGPL-3.0.
**Branch:** `dev/zetoro-10`.
**Rule:** every stage must build/typecheck and pass its recorded tests *before* it is committed. Runtime tests in real Zotero are manual (no automated suite) and require a local Zotero binary (`scripts/zotero-cmd.json`).

## Stages / TODO

| # | Stage | Status |
|---|-------|--------|
| 0 | Make the repo build again (remove external `../../validation/core` import + dead `zotero-adv-installer: file:..` dep); `npm install` + bundle + typecheck green | **Done** |
| 1 | Modern scaffold: `zotero-plugin-scaffold` CLI, toolkit 5.x / zotero-types 4.x, ESM bootstrap, drop Z6, `strict_min 7.0` / `strict_max 10.0.*`, FTL locale | **Done** (boots + passes on FF140 Zotero) |
| 2 | Docked side panel: register `Zotero.Reader.registerReaderTabPanel(...)` (reader) and/or `Zotero.ItemPaneManager.registerSection(...)` (item pane); port chat UI from the floating `position:fixed` overlay; delete drag/zoom/position + reader-`eval`/`.selection-popup` hacks; floating `position:fixed` overlay removed | **Done** (docked item-pane/reader section via `ItemPaneManager.registerSection`; 7/7 tests) |
| 3a | OpenAI-compatible **chat** provider: `streamChat` POST `{api}/v1/chat/completions` (Bearer, SSE), URL normalization, model auto-discovery (fail-soft), no dead fallbacks (removed aigpt.one/theb.ai), settings form + `/api` `/model` `/key` `/clear` in the docked panel | **Done** (16/16 tests) |
| 3b | **Independent embedding provider** (own URL/key/model, local-model support incl. Ollama/LM Studio), vector-cache correctness fixes (cache key incl. model identity, dimension checks), settings UI embeddings section | **Deferred** — not required for the core GPT chat use-case; tracked in Stage 3 detail below |

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
- Stage 1 — modern scaffold migration; Z6 dropped; boots + harness tests pass on FF140 Zotero (see log).



### Stage 2 — docked side panel (2026-09-08)
- API probe on the installed FF140 Zotero: `Zotero.Reader.registerReaderTabPanel` is **undefined**; `Zotero.ItemPaneManager.registerSection` **is** available. Used the item-pane section (renders in the library right-hand pane **and** the reader, with a sidenav button).
- New `src/modules/panel.ts` registers section `zoterogpt-chat` (pluginID `zoterogpt@polygon.org`). Section body is supplied as declarative **`bodyXHTML`** (the framework injects `<html:div data-type="body">` via `MozXULElement.parseXULToFragment`); dynamic DOM appended only in `onRender` does not persist, so all structural markup lives in `bodyXHTML` and CSS in a per-window `<style>`.
- Conversation state held in a module-level `state` object so it survives section re-renders; CSS classes are `zoterogpt-`-prefixed. Open-state pref `panes.zoterogpt@polygon.org-zoterogpt-chat.open` is defaulted to `true` at register.
- `src/modules/provider.ts` added with a `streamChat` stub (fake streaming) so the panel is fully exercisable before Stage 3 wires the real provider.
- Locale: FTL moved to `addon/locale/{en-US,zh-CN}/addon.ftl`; scaffold auto-prefixes IDs with `zoterogpt-` (source uses unprefixed keys). Added keys: `panel-title`, `panel-sidenav`, `panel-placeholder`, `panel-send`, `panel-empty`.
- Fixes to reach green: added strict-null guards for `body.ownerDocument` in `panel.ts` (tsc `strict`).
- Gates: `npm run build` (`zotero-plugin build && tsc --noEmit`) **green**; `npm test` → **7 passed** (4 startup + 3 docked panel). Headless harness cannot connect the custom-section element (`body.isConnected === false`), so tests assert (a) the framework invokes `onInit`/`onRender` on item selection and (b) the `wire(body)` UI build + send + streaming via `addon.api.renderPanel(body)` mounted into a connected live document.
- **Not yet verified:** a real visible GUI run (no computer-use runtime in this environment). The section is expected in the right-hand item pane (and sidenav); confirm auto-expand and appearance manually via `npm start`.

### Stage 3a — OpenAI-compatible chat provider + settings UI (2026-09-08)
- `src/modules/provider.ts`: replaced the stub with a real provider.
  - `getConfig`/`setConfig` read/write prefs `zoterogpt.{api,secretKey,model,temperature,chatNumber}` (scaffold prefixes to `extensions.zotero.zoterogpt.*`).
  - `normalizeBaseUrl` trims whitespace, trailing `/` and a trailing `/v1` so callers append `/v1/...`; `chatEndpoint`/`modelsEndpoint` derive URLs.
  - `streamChat(messages, onDelta)` returns `{done, cancel}`: `POST {api}/v1/chat/completions` via `Zotero.HTTP.request`, `Authorization: Bearer <key>` **omitted when the key is blank** (local servers), body `{model, messages, stream:true, temperature}`; system messages preserved, history trimmed to `chatNumber`; SSE parsed incrementally on `onprogress`/`onload` (`deltaFromSSELine`); HTTP >=400 and JSON `error.message` surfaced as clear errors; `cancel()` aborts the XHR. **No fallback providers** — dead `aigpt.one`/`theb.ai` routing removed; missing config rejects with a clear message.
  - `listModels()` → `GET {api}/v1/models` (Bearer), fail-soft returns `[]` when the endpoint is missing/unreachable so the user can still type a model id.
- `src/modules/panel.ts`: settings form (gear) with API base URL / key / model (datalist + refresh) / temperature and Save; `/clear`, `/api`, `/model`, `/key` slash commands; Send/Stop toggle (cancel aborts the stream); a no-key hint; selected-item system context (title/authors/date/abstract) added to the request; gear + datalist + labels localized via FTL (`panel-stop`, `panel-hint-nokey`, `settings-*` keys added in `addon/locale/{en-US,zh-CN}/addon.ftl`).
- `addon/prefs.js`: `chatNumber` default raised 3 → 12 (longer history window).
- Fixes to reach green: `});` → `};` closing `ChatPanel`; `Zotero.Prefs.set` value cast; datalist looked up scoped to the section body (`body.querySelector`) not `doc.getElementById` to avoid cross-mount collisions in tests.
- Gates: `npm run build` (`zotero-plugin build && tsc --noEmit`) **green**; `npm test` → **16 passed** (4 startup + 2 docked panel + 6 provider unit + 2 panel-HTTP + 2 provider-HTTP). The scaffold compact reporter omits checkmarks for some timer-based async tests, but they execute and their assertions are enforced (verified with injected-failure runs: `15 passed, 1 failed` for both a pre-await failure and a post-await assertion corruption).
- Mocked `Zotero.HTTP.request` in tests: streaming SSE chunks on `onprogress`/`onload`; asserts URL/headers/body, keyless local-server requests omit `Authorization`, config errors reject, `listModels` fails soft.
- **Not yet verified:** a live network chat against a real OpenAI-compatible endpoint (sandbox has no network + no real key) and the visible GUI run (see Stage 2 note). Verify manually via `npm start` with a configured endpoint (e.g. DeepSeek/local Ollama).

### Stage 2 fix — real-GUI rendering broken (2026-09-08, after user report)
- **Symptom:** docked section visible but broken — title text floated over the icon, no chat UI inside.
- **Root cause (found by reading Zotero 10 source in `C:\Program Files\Zotero\app\omni.ja`):** `ItemPaneCustomSection.content` injects `<collapsible-section data-l10n-id=...>` + `<html:div data-type="body">`; `collapsibleSection.init()` builds `.head`/`.title` and reads the title from the **`label` attribute**. Our FTL messages `panel-title`/`panel-sidenav` were plain **values**, so Fluent set `textContent = "Zotero GPT"` on the `collapsible-section`, wiping the injected head/body entirely (the harness had hidden this because the section body used to be detached; in the real GUI it is connected). Zotero built-ins use **attribute-only** messages (`section-info =` + `.label = …`; sidenav `sidenav-notes =` + `.tooltiptext = …`).
- **Fix:** `panel-title` → `.label = Zotero GPT`; `panel-sidenav` → `.tooltiptext = Zotero GPT chat/对话` (attribute-only, no value). Also added scoped CSS so our 32px png fits Zotero 16px header / 20px sidenav icon slots (`background-size` overrides keyed on `[data-pane*="zoterogpt-chat"]`).
- **Verification (real connected section inside the harness):** `item-pane-custom-section` connected → `collapsible-section` has `label="Zotero GPT"`, `.head` present, `[data-type="body"]` present with `.zoterogpt-panel`; computed `display:flex`; panel rect 304×234 (real layout); sidenav `.btn[custom]` now icon-only with `tooltiptext` set and empty text. New permanent regression test in `test/panel.test.ts` asserts head/body/panel survive l10n and have non-zero rect.
- `test/startup.test.ts` updated: `panel-title` now has no value — assert the `.label` attribute instead.
- Gates: `npm run build` green; `npm test` → **17 passed** (startup 4 + docked panel 5 + provider 8).
