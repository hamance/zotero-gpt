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
| 3b | **Embedding provider**: OpenAI-compatible `/v1/embeddings` (own URL/key/model/type/dim), keyless local support, fail-soft model discovery, settings UI (enabled + test connection) | **Done** (config + provider + tests 23/23). Remaining: ollama-native/tei response shapes, wiring into RAG (AskPDF), vector-cache identity fixes |

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

### Stage 2 fix 2 — docked panel UI polish (2026-09-08, after user report)
- **Report:** header icon looked large, gear button invisible, chat area looked blank.
- **Fixes:**
  - Ship native-size icons instead of scaling at runtime: generated `addon/content/icons/icon16.png` (16px, header) and `icon20.png` (20px, sidenav) from `favicon.png`; removed the CSS `background-size` overrides.
  - Gear button no longer relies on the `⚙` text glyph (not present in all fonts): replaced with an SVG icon `addon/content/icons/gear.svg` rendered as the button background; button is 30x30 with a localized tooltip (`settings-title`).
  - Made the empty state visually read as a chat box: `.zoterogpt-messages` now has a white background + 1px border + radius; `.zoterogpt-empty` gets padding.
- Gates: `npm run build` green; `npm test` → **17 passed**.
- Note: a real screenshot could not be captured — the scaffold test instance opens Zotero with a hidden window (no HWND), so visual confirmation is still manual via the xpi.

### Stage 3b — Embedding provider config + redesigned settings UI (2026-09-08)
- **Why:** user reported the gear icon was still invisible and asked how to configure embeddings.
- Settings UI reworked (panel.ts): the icon-only gear was replaced by a **labeled text button** (`设置 / Settings`, FTL `settings-open`/`settings-close`) that renders without font glyphs or background-image support; the settings panel sits at the top of the chat section and **opens by default on first run** (chat config missing or never saved).
- New **Embeddings** group in settings: enable checkbox, API base URL, key (blank = no auth for local servers), model (datalist + refresh from `GET {embedApi}/v1/models`), provider type (`openai` implemented; `ollama-native`/`tei` reserved), optional dimensions, and a **Test connection** button that runs a probe embedding and reports the returned vector dimension.
- New prefs (`addon/prefs.js`): `embedEnabled` (true), `embedApi` (""), `embedSecretKey` (""), `embedModel` ("text-embedding-3-small"), `embedProviderType` ("openai"), `embedDim` ("").
- provider.ts: `getEmbedConfig`/`setEmbedConfig`, `embedEndpoint`, `embedConfigError`, `embedTexts()` (POST `{embedApi}/v1/embeddings`, Bearer only when key set, optional `dimensions`, validates uniform/dim-consistent vectors), `listEmbedModels()` (fail-soft); all exposed on `addon.api.provider`.
- FTL keys added (en-US + zh-CN): `settings-open/-close/-chat-group/-embed-group/-embed-enabled/-embed-api/-embed-key/-embed-model/-embed-type/-embed-dim/-embed-test/-embed-ok`; chat labels clarified (key may be blank for local servers).
- Debug note: an early embedding test hung (mock HTTP misuse) and another failed from cross-test pref leakage (`embedDim` 768 not reset) — isolated with a temporary checkpoint test, fixed by resetting `dim` per test and using simpler mocks; checkpoint removed.
- Gates: `npm run build` green; `npm test` → **23 passed** (startup 4 + docked panel 6 + chat provider 8 + embedding provider 5).
- Remaining: `ollama-native`/`tei` response shapes, and wiring embeddings into a real retrieval/RAG flow (e.g. AskPDF), are still TODO; the provider + config surface is ready.

### Stage 4 — Chat log: export to Markdown + save as Zotero note (2026-09-08)
- **Ask:** persist the whole Zotero GPT conversation to a .md file and organize it into a note.
- New `src/modules/chatlog.ts`: `buildMarkdown` (transcript w/ headers, date, item title; system context excluded), `buildNoteHTML` (escaped HTML note body), `chatsDir()` (Zotero data dir + `/Zotero GPT`), `exportToMd()` (timestamped `Zotero-GPT-YYYYMMDD-HHmmss.md`, creates folder, platform-native path), `saveAsNote()` (creates a `note` item attached to the discussed item or standalone). Exposed as `addon.api.chatlog`.
- Panel: two labeled buttons under the conversation — `导出对话 (.md)` and `保存为笔记` — disabled until there is a conversation; success/error reported inline in the chat.
- Locale keys (en-US/zh-CN): `action-export`, `action-note`, `action-empty`, `action-exported`, `action-note-done`.
- Debug note: `Zotero.File.pathToFile` rejects mixed `/`+`\` Windows paths, so `exportToMd` converts to platform-native separators before calling File APIs and returns the native path.
- Gates: `npm run build` green; `npm test` → **28 passed** (adds 5 chat-log tests: markdown, HTML escaping, real file export under the Zotero data dir, child-note creation, UI button enable/disable).

### Stage 5 — PDF split-screen, per-item context, reader linkage (DESIGN, 2026-09-08)
User goals: (1) chat split side-by-side with the PDF, (2) chat corresponds to the PDF / per-item context division, (3) PDF actions linked into the chat.

Verified Zotero 10.0.1 API facts (from `omni.ja`):
- `Zotero.ItemPaneManager.registerSection(...)` is the supported docked-panel API; `Zotero.Reader.registerReaderTabPanel` does NOT exist in Z10.
- The right-hand "context pane" is shown for `reader`/`note` tabs (`tabs.js` `_hasContextPaneTypes = ['reader','note']`), so the docked section is already side-by-side with an open PDF at window level.
- Context pane DOM: `#zotero-context-pane` + splitters `zotero-context-splitter[-stacked]`; `reader.setContextPaneOpen(open)` toggles it per reader tab.
- Reader access: `Zotero.Reader.getByTabID(tabID)` / `Zotero.Reader._readers`; `reader.itemID`, `reader.navigate({pageIndex})`, `reader._iframeWindow.PDFViewerApplication` (pdf.js: `.pdfViewer.currentPageNumber`, `.eventBus`, `.pdfDocument.getPage(n).getTextContent()`).
- Annotations: `item.getAnnotations()`.

Sub-stage plan (each stage: build + tests green before commit):

| # | Stage | Status |
|---|-------|--------|
| 5a | Per-item conversation threads + visible context bar | **Done** (2026-09-08) |
| 5b | Split-screen UX: auto-expand section + "split view" button (`setContextPaneOpen(true)`, widen `#zotero-context-pane`) | **Done** (2026-09-09) |
| 5c | Reader linkage: current-page tracking, "explain selection" / "summarize page" / "summarize annotations" actions, `/page N` chat→PDF navigation | **Done** (2026-09-09) |
| 5d | Optional: persist per-item threads to disk (JSON under data dir) | TODO (maybe later) |

### Stage 5a — Per-item context threads + context bar (2026-09-08)
- **Ask:** "对话框最好能和pdf对应，划分context" — each PDF/item should have its own chat context, and the panel should make the correspondence visible.
- `panel.ts` state refactor: `state.messages: ChatMessage[]` → `state.threads: Map<number, ChatMessage[]>` keyed by itemID (`0` = library view, no item). Helpers `threadKey()` / `thread()` return the active item's conversation, created on first use.
- All read/write points moved to `thread()`: rendering, `/clear` (clears only the current item's thread), export, save-as-note, Send/Stop.
- Item switching (`onItemChange`) now cancels any in-flight reply and clears `pending`/`busy` so a reply never lands in the wrong thread; `onSend` captures `threadKey()` and only commits deltas/replies while the same item is still active.
- New **context bar** above the messages: shows the active item title (or a localized "no item selected" fallback). FTL keys `panel-context-label` / `panel-context-none` (en-US + zh-CN); CSS `.zoterogpt-ctx[-label|-title]`.
- API surface additions: `addon.api.renderPanel(body, itemID?)` (mount with a specific context), `setActiveItem(id)`, `currentThread()`, `threadKey()` (test/reader hooks).
- Notes: threads are in-memory for now (per-session); disk persistence is Stage 5d.
- Gates: `npm run build` green; `npm test` → **30 passed** (startup 4 + docked panel 8 + chat provider 8 + embedding provider 5 + chatlog 5).

### Stage 5b — Split-screen UX: auto-expand + "Split view" button (2026-09-09)
- **Ask:** "对话框最好能和pdf左右并列分屏" — chat should sit side-by-side with the PDF.
- Verified in Zotero 10: the right-hand context pane is shown for reader/note tabs (`tabs.js` `_hasContextPaneTypes`), so the docked section is already right of the PDF; 5b makes the split real and comfortable.
- `panel.ts`:
  - New `namespacedPaneID()` helper: the framework namespaces + CSS-escapes the paneID as `${pluginID}-${paneID}` (observed `data-pane="zoterogpt\@polygon\.org-zoterogpt-chat"`). `findSection()` now locates the docked section by iterating `item-pane-custom-section collapsible-section` and matching `dataset.pane`.
  - `ensureSectionOpen(win?)` expands the docked section (`collapsible-section.open = true`); `splitView(win?)` additionally opens `ZoteroContextPane` (collapsed=false) and widens `#zotero-context-pane` to 420px. Both wrapped + fail-soft.
  - Topbar now has a labeled **Split view / 分屏** button (`split-open` FTL) next to Settings.
  - `onItemChange`: when `props.tabType === "reader"` (PDF open), auto-expand the section.
  - Fixed the default-open pref key to the real namespaced pane id (`panes.<namespaced>.open`).
- Test hardening: the pre-existing "section header survives l10n" test raced Fluent DOM filling the `label` attribute — it now polls for the label before asserting (real behavior unchanged; `data-l10n-id` was already set).
- Exposed `addon.api.ensureSectionOpen` / `addon.api.splitView`.
- Gates: `npm run build` green; `npm test` → **31 passed** (adds 1 split-view test).




### Stage 5c fix — PDF quick actions stayed disabled in the real GUI (2026-09-09)
- **Symptom (user report):** after selecting text in an open PDF, "解释选中" (explain selection) and the other quick-action buttons were still disabled.
- **Root cause (verified in Zotero 10.0.1 `omni.ja`, `chrome/content/zotero/elements/contextPane.js` 329-334):** while a reader tab is open, the item pane resolves its `item` to the **parent** item of the PDF attachment (`targetItem = parentID ? Zotero.Items.get(parentID) : item`), but readers are keyed by **attachment id** (`reader.itemID`). Our one-shot `getReaderForItem(item.id)` therefore never matched, so the buttons stayed disabled. The reader also registers **asynchronously** after a PDF opens, so a check only at render time was not enough.
- **Fix:**
  - `src/modules/reader.ts`: `getReaderForItem(itemID)` now matches the item id plus its attachments (`item.getAttachments()`) and its parent (`item.parentID`) via a `relatedItemIDs()` set.
  - `src/modules/panel.ts`: `refreshPdfActions()` re-enables the buttons as soon as a reader is found; on `pagechanging` it re-calls `refreshPdfActions()` (previously only `syncPageLabel()`); when no reader is found and an item is selected, it starts a 1s `setInterval` poll (`readerPollTimer`/`readerPollFn`) until the reader registers — polling stops on success, item switch, and `unregister()`.
- **Tests:** new `test/reader.test.ts` case stubs the parent's `getAttachments()` and asserts `getReaderForItem(parent.id)` matches a reader keyed by the attachment id; `test/panel.test.ts` renders the panel for the parent item with a reader keyed by a fake attachment id and asserts the selection action is enabled, the page indicator reads `p. 2`, and the selection streams a chat reply. (A bare `new Zotero.Item("attachment")`'s `parentID` does not persist in the test DB, so tests stub `getAttachments()` instead.)
- Gates: `npm run build` green; `npm test` → **42 passed**.

### Stage 5c fix 2 — quick actions enabled but selection/page text still empty (2026-09-09)
- **Symptom (user report):** the 4 quick-action buttons were now clickable, but clicking them could not obtain the selected PDF text ("没法选取pdf内容").
- **Root cause (verified in Zotero 10.0.1 `omni.ja`, `xpcom/reader.js` + `resource/reader/reader.js`):** Zotero 7+ readers are **nested iframes** — `reader._iframeWindow` is only the reader *host shell*; the actual pdf.js viewer (with `PDFViewerApplication`, the text layer, and the selection) lives in `reader._internalReader._primaryView._iframeWindow` (secondary in split view). Our helpers only read the host `_iframeWindow`, so `getSelectionText()` / `getCurrentPageNumber()` / `getPageText()` always returned empty.
- **Fix (`src/modules/reader.ts`):** new `getIframes()` returns candidate windows in order — `_internalReader._primaryView._iframeWindow`, `_internalReader._secondaryView._iframeWindow`, then the legacy `_iframeWindow` — and `getPDFApp()` / `getSelectionText()` search them; `getIframe()` returns the first.
- **Tests:** `test/reader.test.ts` fake reader now mirrors the real nested shape (host shell without pdf.js + nested primary-view iframe) and a second case covers the legacy `_iframeWindow` fallback; `test/panel.test.ts` end-to-end fake reader updated to the nested shape.
- Gates: `npm run build` green; `npm test` → **43 passed**.

### Stage 5c fix 3 — "Summarize page" still empty + selection auto-attach (2026-09-09)
- **Symptom (user report):** "解释选中" and "总结批注" now work, but "总结本页" still returns nothing; also requested: selected PDF text should attach to the chat conversation directly, not only via buttons.
- **Page-text root cause (verified in `resource/reader/pdf/web/viewer.mjs`):** the previous `getPageText()` relied solely on `pdfDocument.getPage(n).getTextContent()`, an async worker round-trip that can come back empty/unavailable for the current page. The already-rendered text layer (`pdfViewer.getPageView(n-1)._textHighlighter.textContentItemsStr`, an array of strings) is synchronous and always present once the page is rendered.
- **Fix (`src/modules/reader.ts`):**
  - `getPageText()` now reads the rendered text layer first, then falls back to `getTextContent()`; failures are logged via `ztoolkit.log`.
  - `getCurrentPageNumber()` falls back to `pdfViewer._currentPageNumber` (the backing field) if the getter is hidden behind an Xray boundary; the panel's page button also prefers the eventBus-tracked `state.currentPage`.
  - New `trackSelectionChanges()` subscribes to `selectionchange` on the pdf.js iframe document, debounced via `Zotero.Promise.delay`, and reports the trimmed selection.
- **Feature (`src/modules/panel.ts`):** an attachment bar above the input shows the current PDF selection automatically as the user drags text (chip with preview + ✕). Pressing **Send** with an attachment sends it as quoted context together with any typed text, or as an "explain selection" request when the input is empty; the quick "解释选中" button consumes the same attachment. Cleanup happens on reader change, item switch, and unregister. FTL keys `pdf-attach-label` / `pdf-attach-remove` (en-US + zh-CN).
- **Test-only gotchas fixed along the way:** XUL template attributes must be `hidden="hidden"` (a bare boolean `hidden` breaks `parseXULToFragment`, which silently unmounts the whole section); an injected test must not be nested inside the previous `it()` (mocha never registers it).
- Gates: `npm run build` green; `npm test` → **45 passed**.

### Stage 5f — UI pass reverted; Markdown only (2026-09-10)
- **Ask (user):** after trying the UI pass (5e), "虽然 markdown 显示了但是显示完就消失", the independent dock is not possible, and the enlarged UI looked worse — revert that change; later: add **Markdown rendering only**.
- `87a96ca` reverts 5e in full (back to the compact panel at `78af175`): no scroll-island wheel capture, no bigger input/buttons, no model/context chip, no `contextLimit` pref.
- **Minimal Markdown (this stage):** `src/modules/markdown.ts` renders assistant replies with `markdown-it` (`html:false`) + a `DOMParser` sanitizer (strips `on*` handlers and `javascript:`/`data:` URLs); assistant bubbles get a `.markdown-body` child and the bundled `addon/content/md.css` is linked once (`registerStyles`). User messages stay plain text; **no layout/CSS/scroll changes**.
- **"显示完就消失" hardening:** `syncMessages` now builds the whole message list in an off-DOM fragment and swaps it in only on success, so a render hiccup can never wipe already-shown messages (previous code blanked the container first).
- `punycode` re-added as a dependency (markdown-it browser-bundle requirement).
- Tests: `test/markdown.test.ts` (render/sanitize/escape); a panel e2e test streams a Markdown reply and asserts `.markdown-body` shows `<strong>`/`<code>` and the conversation is kept; an `innerHTML` round-trip probe documents that XHTML `innerHTML` works in the Zotero document. Test gotcha: `state.threads` is module-level and shared across tests (itemless tests share thread key 0), so the e2e assertion targets the **last** assistant bubble, not the first.
- Gates: `npm run build` green; `npm test` → **51 passed**.
