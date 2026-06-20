// content-scripts/gemini.js
// Fill-only paste-back for Gemini. Never auto-submit.
// Receives a FILL_INPUT message, finds Gemini's input, and fills it.

'use strict';

var INPUT_SELS = [
  'div[contenteditable="true"]',
  'textarea',
  '.textarea',
  'rich-textarea div',
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

function fillInput(el, text) {
  el.focus();

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
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
    // contenteditable
    el.innerHTML = '';
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
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

function waitForInput(timeoutMs) {
  return new Promise(function (resolve, reject) {
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
      reject(new Error('Gemini input not found within ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action === 'PING') {
    sendResponse({ ok: true, source: 'gemini' });
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
        try {
          navigator.clipboard.writeText(text).catch(function() {});
        } catch (e) {}
        sendResponse({ ok: false, error: err.message, clipboardFallback: true });
      });

    return true;
  }
});

console.log('[Context Handoff] gemini.js loaded on', window.location.href);
