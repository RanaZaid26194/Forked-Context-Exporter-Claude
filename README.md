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

**Phase 1 (current):**
| Button | What it produces |
|---|---|
| Export Full Transcript | Full Markdown transcript (`### You` / `### Claude` headers, fenced code blocks). Copies to clipboard + downloads as `.md`. |

**Phase 2 (coming):** Export Summary · Handoff Prompt · automatic limit detection.  
**Phase 3 (coming):** Send handoff prompt directly to ChatGPT's input (no auto-submit — you review and press Enter yourself).

## Status & roadmap

| Phase | Status | Scope |
|---|---|---|
| 1 — MVP | ✅ Done | Repo skeleton, `claude.js` scraper, Markdown export, popup UI |
| 2 — Summarization + limit detection | 🔜 Next | `summarizer.js`, handoff prompt template, limit signals, options page |
| 3 — ChatGPT fill | 🔜 Planned | `chatgpt.js`, "Send to ChatGPT" button |

Selectors target Claude.ai's DOM as of mid-2026. If exports stop working after a Claude UI update, check `content-scripts/claude.js` → `SEL` object and update the selector arrays.
