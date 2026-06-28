// content-scripts/gemini.js
// Fill-only paste-back for Gemini. Never auto-submit.
// Uses the shared robustFill helper from fill-utils.js.

'use strict';

// ── Input selectors ───────────────────────────────────────────────────────────
// Gemini (Jun 2026): Angular app with input-area-v2 component. The Quill
// editor lives inside as div.ql-editor. Listed in preference order.
var INPUT_SELS = [
  'div.ql-editor[contenteditable="true"]',
  '.ql-editor',
  'div[contenteditable="true"]',
  'rich-textarea div[contenteditable="true"]',
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
      reject(new Error('Gemini input not found within ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action === 'PING') { sendResponse({ ok: true, source: 'gemini' }); return true; }

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
          throw new Error('robustFill could not fill the Gemini input.');
        }
      })
      .catch(function (err) {
        try { navigator.clipboard.writeText(text).catch(function () {}); } catch (e) {}
        sendResponse({ ok: false, error: err.message, clipboardFallback: true });
      });

    return true;
  }
});

console.log('[Context Handoff] gemini.js loaded on', window.location.href);