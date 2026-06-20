// background.js — Context Handoff service worker (Manifest V3) — Phase 2
//
// Handles limit detection signals from content scripts:
//   LIMIT_DETECTED      → badge "!" + chrome.notifications
//   UNRECOGNIZED_BANNER → badge "?" + log to storage for Options page review

'use strict';

// Keep the service worker alive while a popup is open.
chrome.runtime.onConnect.addListener(function (_port) {
  // Connection from popup keeps the SW alive during export operations.
});

// ── Badge helpers ─────────────────────────────────────────────────────────────

function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: color });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
}

// ── Notification helper ───────────────────────────────────────────────────────

var NOTIF_ID = 'context-handoff-limit';

function showLimitNotification(phrase) {
  var body = phrase
    ? 'Phrase detected: "' + phrase + '". Click to open popup and export.'
    : 'Usage limit heuristic triggered. Click to review and export.';

  chrome.notifications.create(NOTIF_ID, {
    type:     'basic',
    iconUrl:  'icons/icon48.png',
    title:    'Context Handoff — Limit reached',
    message:  body,
    priority: 2,
    buttons:  [{ title: 'Open & Export' }],
  });
}

// Clicking the notification or its button opens the popup
chrome.notifications.onClicked.addListener(function (id) {
  if (id === NOTIF_ID) {
    chrome.notifications.clear(NOTIF_ID);
    // Open the extension popup (Chrome 127+ supports openPopup without user gesture
    // in service workers; on older builds we fall back to just clearing the badge)
    if (chrome.action.openPopup) {
      chrome.action.openPopup().catch(function () { /* not in user gesture context */ });
    }
  }
});

chrome.notifications.onButtonClicked.addListener(function (id, btnIdx) {
  if (id === NOTIF_ID && btnIdx === 0) {
    chrome.notifications.clear(NOTIF_ID);
    if (chrome.action.openPopup) {
      chrome.action.openPopup().catch(function () { /* */ });
    }
  }
});

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

  if (message.action === 'LOG') {
    console.log('[Context Handoff BG]', message.data);
    sendResponse({ ok: true });
    return true;
  }

  // Layer 1 or Layer 2 confirmed detection
  if (message.action === 'LIMIT_DETECTED') {
    setBadge('!', '#ef4444'); // red
    showLimitNotification(message.phrase);
    sendResponse({ ok: true });
    return true;
  }

  // Layer 3: unrecognized banner — log for user review
  if (message.action === 'UNRECOGNIZED_BANNER') {
    setBadge('?', '#f59e0b'); // amber
    chrome.storage.local.get(['unrecognizedBanners'], function (result) {
      var banners = result.unrecognizedBanners || [];
      banners.push({
        text:      message.text,
        url:       message.url,
        timestamp: message.timestamp || new Date().toISOString(),
        approved:  false,
      });
      // Cap at 20 stored banners
      if (banners.length > 20) banners = banners.slice(-20);
      chrome.storage.local.set({ unrecognizedBanners: banners });
    });
    sendResponse({ ok: true });
    return true;
  }

  // Clear badge when popup is opened (user is aware of the state)
  if (message.action === 'POPUP_OPENED') {
    clearBadge();
    sendResponse({ ok: true });
    return true;
  }
});

console.log('[Context Handoff] Background service worker started (Phase 2).');
