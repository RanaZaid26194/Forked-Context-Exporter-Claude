// background.js — Context Handoff service worker (Manifest V3)
//
// Phase 1: minimal stub. Listens for messages from content scripts and
// coordinates between popup and content scripts.
//
// Phase 2 will add:
//   - Limit-detection badge logic (chrome.action.setBadgeText)
//   - chrome.notifications for proactive limit alerts
//   - Wiring of config/limit-signals.json phrase matching
//   - MutationObserver results relayed from content scripts

'use strict';

// Keep the service worker alive while a popup is open (MV3 best practice).
chrome.runtime.onConnect.addListener((_port) => {
  // Connection from popup keeps the SW alive during export operations.
});

// ── Message relay ─────────────────────────────────────────────────────────────
// Content scripts may send messages here for central handling.
// Phase 1: just log and pass through.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'LOG') {
    console.log('[Context Handoff BG]', message.data);
    sendResponse({ ok: true });
    return true;
  }

  // TODO(Phase 2): handle LIMIT_DETECTED action from content scripts
  // TODO(Phase 2): handle UNRECOGNIZED_BANNER action for the self-logging flow
});

console.log('[Context Handoff] Background service worker started.');
