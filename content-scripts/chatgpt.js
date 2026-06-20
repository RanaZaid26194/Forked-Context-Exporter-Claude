// content-scripts/chatgpt.js — Phase 3
//
// Fill-only paste-back. Hard requirement: NEVER auto-submit.
// Receives a FILL_INPUT message from the popup (relayed via background.js),
// waits for ChatGPT's input element to appear (up to 10s), fills it, focuses it.
//
// If the input is not found within the timeout, copies the text to clipboard
// and sends a FILL_RESULT error back to the popup.

'use strict';

// ── ChatGPT input selectors ───────────────────────────────────────────────────
// Listed in preference order; first match wins. Update the front of this list
// if ChatGPT's DOM changes — the older selectors stay as fallbacks.
var INPUT_SELS = [
  '#prompt-textarea',
  'div[contenteditable="true"][data-id="root"]',
  'div[contenteditable="true"].ProseMirror',
  'div[contenteditable="true"]',
  'textarea[data-id="root"]',
  'textarea[placeholder]',
];

var FILL_TIMEOUT_MS = 10000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function findInput() {
  for (var i = 0; i < INPUT_SELS.length; i++) {
    try {
      var el = document.querySelector(INPUT_SELS[i]);
      if (el) return el;
    } catch (e) { /* invalid selector */ }
  }
  return null;
}

/**
 * Fill text into the ChatGPT input. Supports both textarea and contenteditable.
 * Uses both direct assignment and React synthetic event dispatch so React's
 * internal state updates correctly (otherwise the Send button stays disabled).
 *
 * Does NOT dispatch Enter, submit, or click the send button.
 */
function fillInput(el, text) {
  el.focus();

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    // Standard textarea
    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    );
    if (nativeInputValueSetter && nativeInputValueSetter.set) {
      nativeInputValueSetter.set.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // contenteditable div (ChatGPT's ProseMirror editor)
    // Clear existing content first
    el.innerHTML = '';
    // Use execCommand for best compatibility with ProseMirror's undo stack
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    // Also fire input event in case execCommand didn't trigger it
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  // Move cursor to end
  try {
    var range = document.createRange();
    var sel   = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) { /* non-contenteditable */ }
}

/**
 * Wait for the input element to appear, up to timeoutMs.
 * Uses MutationObserver with a polling heartbeat fallback.
 * Resolves with the element or rejects on timeout.
 */
function waitForInput(timeoutMs) {
  return new Promise(function (resolve, reject) {
    // Check immediately first
    var el = findInput();
    if (el) { resolve(el); return; }

    var timer;
    var observer = new MutationObserver(function () {
      var found = findInput();
      if (found) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(found);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    timer = setTimeout(function () {
      observer.disconnect();
      reject(new Error('ChatGPT input not found within ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);
  });
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

  if (message.action === 'PING') {
    sendResponse({ ok: true, source: 'chatgpt' });
    return true;
  }

  if (message.action === 'FILL_INPUT') {
    var text = message.text || '';
    if (!text) {
      sendResponse({ ok: false, error: 'No text provided to fill.' });
      return true;
    }

    waitForInput(FILL_TIMEOUT_MS)
      .then(function (inputEl) {
        fillInput(inputEl, text);
        inputEl.focus();
        sendResponse({ ok: true });
      })
      .catch(function (err) {
        // Graceful fallback: try clipboard, then report error
        try {
          navigator.clipboard.writeText(text).catch(function() {});
        } catch (e) { /* clipboard not available in content script context */ }
        sendResponse({ ok: false, error: err.message, clipboardFallback: true });
      });

    return true; // keep channel open for async sendResponse
  }
});

console.log('[Context Handoff] chatgpt.js loaded on', window.location.href);
