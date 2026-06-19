// content-scripts/chatgpt.js — Phase 3 stub
// Will handle:
//   - Filling the handoff prompt into ChatGPT's input textarea (no auto-submit).
//   - Receiving the FILL_INPUT message from the popup.
//
// TODO(Phase 3): implement chatgpt.js scraper + fill logic

'use strict';

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action === 'PING') {
    sendResponse({ ok: true, source: 'chatgpt' });
    return true;
  }
  // TODO(Phase 3): handle FILL_INPUT action
});

console.log('[Context Handoff] chatgpt.js stub loaded.');
