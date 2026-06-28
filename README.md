# Context Handoff

A free, local-only Chromium extension (Chrome, Edge, Brave) that scrapes LLM chat conversations, exports them in multiple formats, and builds curated handoff prompts for continuing work in a new chat session — zero AI API calls, nothing leaves your machine.

## How it's different

- **Proactive limit detection** — detects when Claude's usage limit is hit and badges the icon so you know exactly when to export, rather than waiting for you to notice.
- **Curated handoff prompt, not just a raw dump** — builds a structured summary (decisions made, current code state, open items, last exchange verbatim) sized to fit a new chat's context window.
- **Claude-to-Claude account handoff** — log out of your current Claude account and into a fresh one without leaving the extension. The handoff prompt is pasted automatically once you're signed in.
- **Reliable auto-paste across all destinations** — uses a shared `robustFill` helper that tries four strategies in order (React fiber, native setter, execCommand, paste event) so it works on React-controlled inputs, ProseMirror editors, plain textareas, and contenteditable divs alike.
- **Persistent copy/export preferences** — choose whether each export copies to clipboard, downloads a file, or both. Your choice is remembered across sessions.
- **Zero AI / fully local** — summarization is 100% rule-based extractive logic. No API keys, no external requests, no telemetry. `chrome.storage.local` only.

## Install (unpacked, for now)

1. Clone this repo.
2. Open Chrome → `chrome://extensions` → enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** → select the `Context-Exporter-Claude` folder.
4. Pin the extension. Open a claude.ai conversation and click the toolbar icon.

## Usage

When you click the extension popup inside a Claude.ai conversation:

1. **Export Handoff Prompt** (Recommended): Builds a structured summary (decisions made, current code state, open items, last 2–3 exchanges verbatim) sized to fit a new chat's context window.
2. **Export Summary**: Generates a quick markdown summary highlighting decisions and code blocks.
3. **Full Transcript**: Copies and downloads the entire raw conversation as a clean markdown file.

### Copy / Export preference

Two checkboxes in the popup control what happens on every export action:

| Copy | Download | Behaviour |
|:----:|:--------:|-----------|
| ✓ | ✓ | Copies to clipboard **and** downloads a `.md` file (default) |
| ✓ |   | Clipboard only — no file saved |
|   | ✓ | File download only — nothing on clipboard |

Your choice is saved locally and remembered until you change it.

### Handoff destinations

Once you click *Export Handoff Prompt*, four destination buttons activate:

- **Send HandOff to GPT** — opens ChatGPT, waits for the page to load, and automatically fills the text input.
- **Send HandOff to Gemini** — opens Gemini and fills your handoff prompt.
- **Send HandOff to Grok** — opens Grok and fills your handoff prompt.
- **Send HandOff to Claude** — logs you out of your current Claude account, waits for you to sign into a different one, then navigates to a new chat and fills the handoff prompt automatically.

> **Hard guarantee:** the extension fills inputs but never auto-submits. You always review the text and press Enter yourself.

Auto-paste can be turned off in Settings if you only want the tab to open without touching the input.

### Claude-to-Claude account switch (detailed flow)

1. Click **Send HandOff to Claude**. A confirmation dialog appears (can be skipped permanently via "Don't ask me again" or the Settings toggle).
2. The extension clicks through the Claude avatar menu and logs you out.
3. If *Auto-click "Continue with Google"* is enabled in Settings (on by default), the extension finds the Google sign-in button by its visible text and clicks it — landing you straight on the Google account picker.
4. Pick your second account. The extension detects the successful login automatically by polling for authenticated DOM elements.
5. It navigates to `claude.ai/new` and pastes the handoff prompt. Hit Enter to go.

## Settings

Open the settings page via the gear icon in the popup top-right.

### General

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-detect usage limits | On | Watches for usage-limit banners and badges the extension icon so you know when to export |
| Auto-paste into destination | On | When you click Send HandOff to any destination, automatically fill the chat input with the handoff prompt. Turn off if you only want the tab to open |

### Claude Account Switch

| Setting | Default | Description |
|---------|---------|-------------|
| Auto-click "Continue with Google" | On | After logout, automatically clicks the Google sign-in button so you land straight on the account picker |
| Skip logout confirmation | Off | Skip the "Switch Claude Account?" dialog and go straight to logout. Also settable via the "Don't ask me again" checkbox in the popup — both write the same storage key and stay in sync |

The settings page also lets you manage custom detection phrases and review any unrecognized limit banners that were logged but didn't match a known phrase.

## Status & Roadmap

| Phase | Status | Scope |
|---|---|---|
| 1 — MVP | ✅ Done | Repo skeleton, `claude.js` scraper, Markdown export, popup UI |
| 2 — Summarization & Limit Detection | ✅ Done | `summarizer.js`, handoff prompt template, automatic limit signals banner, Options page |
| 3 — Destination Handoffs | ✅ Done | `chatgpt.js`, `gemini.js`, `grok.js`, colorful popup buttons, auto-fill |
| 4 — Claude Account Handoff & UX Polish | ✅ Done | Claude-to-Claude transfer, `robustFill` shared helper, copy/export preference row, auto-paste setting, fixed Google sign-in detection |

## Selector maintenance

If exports or auto-fill behaviours stop working after a platform updates its UI, update the relevant selector arrays — no logic changes needed, just the selectors at the top of each file:

| What broke | File to update | What to change |
|---|---|---|
| Claude scraping | `content-scripts/claude.js` | `SEL` object |
| Claude logout / login detection | `content-scripts/claude.js` | `NAV_SEL` object |
| ChatGPT paste | `content-scripts/chatgpt.js` | `INPUT_SELS` array |
| Gemini paste | `content-scripts/gemini.js` | `INPUT_SELS` array |
| Grok paste | `content-scripts/grok.js` | `INPUT_SELS` array |
| Shared fill logic | `content-scripts/shared/fill-utils.js` | strategy functions |