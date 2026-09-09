# Zotero GPT

Zotero GPT brings a **docked GPT chat panel** into Zotero. It runs on **Zotero 7 – 10** and talks to any **OpenAI-compatible** chat/embedding API (OpenAI, DeepSeek, Moonshot, Ollama, LM Studio, …). License: AGPL-3.0.

The modernization branch is `dev/zetoro-10`; the staged plan and test log live in [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md).

## ✨ Features

- **Docked panel, not a floating window** — the chat lives in Zotero's right-hand item pane (and appears in the reader via the sidenav). No overlay that covers your library.
- **PDF split view** — a labeled **分屏 / Split view** button opens and widens the right pane so the chat sits side-by-side with the PDF; the section also auto-expands while you read a PDF.
- **PDF ↔ chat linkage** — quick actions **解释选中 / 总结本页 / 总结批注** pull the current PDF selection, page text or annotations into the chat (per-item context), a live `p. N` indicator tracks the page you are on, and `/page N` jumps the reader to a page. Selecting text in the PDF also **auto-attaches it to the chat** (a chip above the input; pressing Send includes it as quoted context, or sends an explain request when the input is empty).
- **Any OpenAI-compatible chat provider** — set your own base URL, model, API key, temperature. A blank key means *no `Authorization` header*, so local servers (Ollama, LM Studio) work out of the box.
- **Streaming replies with Stop** — type a question and press `Enter`; press `Enter` again (or click Stop) to cancel a running reply.
- **Per-item context threads** — each item/PDF keeps its own conversation; switching items switches threads (a context bar shows the active item), and the selected item's title/authors/date/abstract are attached so the model answers about that paper.
- **Settings UI** (open by default on first run):
  - *Chat*: base URL, API key, model (with refresh-from-`/v1/models`), temperature.
  - *Embeddings*: enable, base URL, key, model, provider type, optional dimensions, and a **Test connection** button.
- **Chat log** — below the conversation:
  - `Export chat (.md)` writes the whole conversation to a Markdown file under `<Zotero data dir>/Zotero GPT/`.
  - `Save as note` creates a Zotero note (attached to the selected item, or standalone) with the full transcript.
- **Slash commands** (type in the input): `/clear`, `/api <url>`, `/model <id>`, `/key <key>`.
- Localization: English + Chinese (Fluent/FTL).

## 🚀 Quick start (中文)

1. 安装：`Zotero → 工具 → 附加组件 → 齿轮 → Install Add-on From File…`，选择 `zotero-gpt.xpi`，重启 Zotero。
2. 选中任一文献，右侧信息栏会多出 **Zotero GPT** 分区（或点击侧栏图标）。
3. 顶部 **设置** 面板（首次自动展开）：
   - **对话**：接口地址如 `https://api.deepseek.com`（本地可 `http://localhost:11434`），模型如 `deepseek-chat` / `gpt-4o-mini`；托管服务填 API Key，**本地服务可留空**。
   - **嵌入（可选）**：填嵌入接口/模型后点 **测试连接**；对话与嵌入可分别用不同服务。
4. 提问 → `Enter` 流式回复；`Enter` 停止。
5. 对话记录：点 **导出对话 (.md)** 存成 Markdown 到 Zotero 数据目录的 `Zotero GPT/` 文件夹；点 **保存为笔记** 把整段对话整理成当前文献下的笔记。

## 🔧 Build / dev

```bash
npm install
npm run build        # zotero-plugin build + tsc --noEmit (strict); must pass before commit
npm test             # launches Zotero (set ZOTERO_PLUGIN_ZOTERO_BIN_PATH to zotero.exe) and runs mocha
npm run tsc          # typecheck only
npm start            # dev install + hot reload (remote debugging)
npm run build-dev / build-prod
```

The installable artifact is produced at `.scaffold/build/zotero-gpt.xpi`.

## 🗂️ Project structure

- `src/` — `index.ts` (entry), `addon.ts` (singleton), `hooks.ts` (lifecycle),
  `modules/panel.ts` (docked section + settings UI + actions),
  `modules/provider.ts` (chat + embedding providers), `modules/chatlog.ts` (Markdown export / note), `utils/`.
- `addon/` — scaffold assets (`bootstrap.js`, `manifest.json`, `prefs.js`, `content/`, `locale/`).
- `test/` — mocha tests that run inside Zotero.
- `legacy/`, `tags/`, `imgs/` — pre-migration code/assets kept for reference (not wired into the current build).
- `MIGRATION_PLAN.md` — stage plan, decisions, and the test log.

## 📋 Status & limitations

See [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md). Notable notes:

- Zotero 6 support was dropped; the manifest targets `7.0.0 → 10.0.*`.
- Legacy **command tags / Meet API** and Better Notes integration are **not ported** to the new docked panel yet (kept under `legacy/`).
- Replies are rendered as plain text (no Markdown/LaTeX rendering yet); embedding config + provider are ready, but full RAG/AskPDF retrieval is not wired yet.

## ❤️ Support the project

If you find it useful, star/watch the repo and report issues — see the [original project](https://github.com/MuiseDestiny/zotero-gpt).



