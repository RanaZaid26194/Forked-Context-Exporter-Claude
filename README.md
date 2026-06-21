# Context Handoff

A free, local-only Chromium extension (Chrome, Edge, Brave) that scrapes LLM chat conversations, exports them in multiple formats, and builds curated handoff prompts for continuing work in a new chat session — zero AI API calls, nothing leaves your machine.

## How it's different

- **Proactive limit detection** — detects when Claude's usage limit is hit and offers to export automatically, rather than waiting for you to remember.
- **Curated handoff prompt, not just a raw dump** — builds a structured summary (decisions made, current code state, open items, last exchange verbatim) sized to fit a new chat's context window.
- **Zero AI / fully local** — summarization is 100% rule-based extractive logic. No API keys, no external requests, no telemetry. `chrome.storage.local` only.

## Install (unpacked, for now)

1. Clone this repo.
2. Open Chrome → `chrome://extensions` → enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** → select the `Context-Exporter-Claude` folder.
4. Pin the extension. Open a claude.ai conversation and click the toolbar icon.

## Usage

When you click the extension popup inside a Claude.ai conversation:

1. **Export Handoff Prompt** (Recommended): Builds a structured summary (decisions made, current code state, open items, last 2-3 exchanges verbatim) sized to fit a new chat's context window.
2. **Export Summary**: Generates a quick markdown summary highlighting decisions and code blocks.
3. **Full Transcript**: Copies and downloads the entire raw conversation as a clean markdown file.
4. **Handoff Destinations**: Once you click *Export Handoff Prompt*, three destination buttons activate:
   - **Send HandOff to GPT**: Opens or switches to ChatGPT, waits for the page to load, and automatically fills the text input.
   - **Send HandOff to Gemini**: Redirects and fills your handoff prompt in Gemini.
   - **Send HandOff to Grok**: Redirects and fills your handoff prompt in Grok.
   
   *Hard guarantee: The extension will focus and fill the inputs, but never auto-submits. You always review the text and press Enter yourself.*

## Status & Roadmap

All main development phases are fully complete:

| Phase | Status | Scope |
|---|---|---|
| 1 — MVP | ✅ Done | Repo skeleton, `claude.js` scraper, Markdown export, popup UI |
| 2 — Summarization & Limit Detection | ✅ Done | `summarizer.js`, handoff prompt template, automatic limit signals banner, Options page |
| 3 — Destination Handoffs | ✅ Done | `chatgpt.js`, `gemini.js`, `grok.js`, custom colorful popup buttons, MutationObserver auto-fill |

If exports or auto-fill behaviors stop working after a platform updates its UI, you can update selectors in `content-scripts/claude.js` (for Claude scraping) or the respective destination content scripts (`chatgpt.js`, `gemini.js`, `grok.js`).

