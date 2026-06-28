// content-scripts/grok.js
// Fill-only paste-back for Grok. Never auto-submit.
// Uses the shared robustFill helper from fill-utils.js.

'use strict';

// ── Input selectors ───────────────────────────────────────────────────────────
// Grok (Jul 2026): input is now a Tiptap/ProseMirror contenteditable div,
// NOT a textarea (confirmed via live DOM — class="tiptap ProseMirror w-full
// px-2 bg-transparent ... " with role="textbox" aria-label="Ask Grok
// anything"). Older textarea selectors kept as fallback in case Grok
// reverts. Listed in preference order — most specific first.
var INPUT_SELS = [
  'div.tiptap.ProseMirror[contenteditable="true"]',
  'div[role="textbox"][aria-label="Ask Grok anything"]',
  'form div[contenteditable="true"]',
  'div[contenteditable="true"]',
  'form textarea',
  'main textarea',
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
      reject(new Error('Grok input not found within ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action === 'PING') { sendResponse({ ok: true, source: 'grok' }); return true; }

  if (message.action === 'FILL_INPUT') {
    var text = message.text || '';
    if (!text) { sendResponse({ ok: false, error: 'No text provided.' }); return true; }

    waitForInput(FILL_TIMEOUT_MS)
      .then(function () { return new Promise(function (r) { setTimeout(r, 200); }); })
      .then(function () {
        var result = window.ContextHandoff.robustFill(findInput, text);
        if (result.ok) {
          console.log('[Context Handoff] grok.js FILL_INPUT succeeded via strategy:', result.strategy);
          sendResponse({ ok: true, strategy: result.strategy });
        } else {
          console.warn('[Context Handoff] grok.js FILL_INPUT: robustFill returned ok:false — all strategies failed.');
          throw new Error('robustFill could not fill the Grok input.');
        }
      })
      .catch(function (err) {
        try { navigator.clipboard.writeText(text).catch(function () {}); } catch (e) {}
        sendResponse({ ok: false, error: err.message, clipboardFallback: true });
      });

    return true;
  }
});

console.log('[Context Handoff] grok.js loaded on', window.location.href);