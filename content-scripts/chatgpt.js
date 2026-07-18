// content-scripts/chatgpt.js
// Fill-only paste-back for ChatGPT. Never auto-submit.
// Uses the shared robustFill helper from fill-utils.js.

'use strict';

// ── Input selectors ───────────────────────────────────────────────────────────
// ChatGPT desktop (Jun 2026): ProseMirror contenteditable inside
// div.wCDTda.prosemirror-parent. The old #prompt-textarea textarea is gone.
// Listed in preference order — update the front of this list if it changes.
var INPUT_SELS = [
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"].ProseMirror',
  '[data-testid="composer-speech-button"] ~ div[contenteditable]',
  'div[contenteditable="true"]',
  '#prompt-textarea',       // legacy fallback — may still exist on some layouts
  'textarea[placeholder]',
  'textarea',
];

var FILL_TIMEOUT_MS = 10000;

function findInput() {
  for (var i = 0; i < INPUT_SELS.length; i++) {
    try {
      var el = document.querySelector(INPUT_SELS[i]);
      if (el) return el;
    } catch (e) { /* invalid selector */ }
  }
  return null;
}

function waitForInput(timeoutMs) {
  return new Promise(function (resolve, reject) {
    var el = findInput();
    if (el) { resolve(el); return; }
    var timer;
    var observer = new MutationObserver(function () {
      var found = findInput();
      if (found) { clearTimeout(timer); observer.disconnect(); resolve(found); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timer = setTimeout(function () {
      observer.disconnect();
      reject(new Error('ChatGPT input not found within ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action === 'PING') { sendResponse({ ok: true, source: 'chatgpt' }); return true; }

  if (message.action === 'FILL_INPUT') {
    var text = message.text || '';
    if (!text) { sendResponse({ ok: false, error: 'No text provided.' }); return true; }

    waitForInput(FILL_TIMEOUT_MS)
      .then(function () { return new Promise(function (r) { setTimeout(r, 200); }); })
      .then(function () {
        var result = window.ContextHandoff.robustFill(findInput, text);
        if (result.ok) {
          sendResponse({ ok: true, strategy: result.strategy });
        } else {
          throw new Error('robustFill could not fill the ChatGPT input.');
        }
      })
      .catch(function (err) {
        try { navigator.clipboard.writeText(text).catch(function () {}); } catch (e) {}
        sendResponse({ ok: false, error: err.message, clipboardFallback: true });
      });

    return true;
  }
});

console.log('[Context Handoff] chatgpt.js loaded on', window.location.href);