// content-scripts/shared/fill-utils.js
//
// Shared paste-back layer. Each site's editor needs a different approach —
// this file tries the right one first and falls through to generics only if
// it fails. Confirmed via live console testing on each site (June 2026).
//
// Strategy map:
//   Tiptap API     → Claude.ai          (el.editor.commands.setContent)
//   Quill API      → Gemini             (container.__quill.setText)
//   Native setter  → ChatGPT, Grok      (HTMLTextAreaElement setter + InputEvent)
//   execCommand    → generic fallback
//   Paste event    → last resort
//
// Zero external API calls. Everything runs against objects already in the page.

'use strict';

window.ContextHandoff = window.ContextHandoff || {};

// ── Verification ──────────────────────────────────────────────────────────────

function chNormalize(str) {
  return (str || '').replace(/\u200b|\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function chLooksFilled(el, text) {
  var rendered = chNormalize(
    (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el.value : el.innerText
  );
  var expected = chNormalize(text);
  if (!expected) return rendered.length > 0;
  return rendered.indexOf(expected.slice(0, 40)) !== -1 || rendered.length >= expected.length * 0.6;
}

function chMoveCursorToEnd(el) {
  try {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      el.selectionStart = el.selectionEnd = el.value.length;
    } else {
      var range = document.createRange();
      var sel   = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch (e) { /* best effort */ }
}

// ── Strategy: Tiptap (Claude.ai) ─────────────────────────────────────────────
// Confirmed: el.editor.commands.setContent(text) works on [data-testid="chat-input"]
function chFillTiptap(el, text) {
  var ed = el.editor;
  if (!ed || typeof ed.commands !== 'object' || typeof ed.commands.setContent !== 'function') {
    throw new Error('No Tiptap editor on element.');
  }
  ed.commands.focus();
  ed.commands.setContent(text);
  if (typeof ed.chain === 'function') ed.chain().focus().run();
}

// ── Strategy: Quill (Gemini) ──────────────────────────────────────────────────
// Confirmed: container.__quill.setText(text) works on .ql-container
function chFillQuill(el, text) {
  // el may be .ql-editor or a parent — walk up to find .ql-container
  var container = el.closest ? el.closest('.ql-container') : null;
  if (!container) throw new Error('No .ql-container found.');
  var quill = container.__quill;
  if (!quill || typeof quill.setText !== 'function') throw new Error('No Quill instance.');
  quill.setText(text);
  try { quill.setSelection(quill.getLength(), 0); } catch (e) { /* best effort */ }
}

// ── Strategy: Native setter (ChatGPT, Grok — React textareas) ────────────────
// React's synthetic event system listens at document root, not on the element.
// Native setter + real bubbling InputEvent is what it actually catches.
function chFillNative(el, text) {
  var isTA  = el.tagName === 'TEXTAREA';
  var proto = isTA ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  var desc  = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) {
    desc.set.call(el, text);
  } else {
    el.value = text;
  }
  try {
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: text,
    }));
  } catch (e) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── Strategy: execCommand (ProseMirror / Lexical fallback) ────────────────────
function chFillExecCommand(el, text) {
  el.focus();
  document.execCommand('selectAll', false, null);
  var ok = document.execCommand('insertText', false, text);
  if (!ok) throw new Error('execCommand insertText returned false.');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Strategy: Paste event (last resort) ───────────────────────────────────────
function chFillPaste(el, text) {
  var dt = new DataTransfer();
  dt.setData('text/plain', text);
  var notCancelled = el.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true, cancelable: true, clipboardData: dt,
  }));
  if (notCancelled) {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// ── robustFill ────────────────────────────────────────────────────────────────

window.ContextHandoff.robustFill = function robustFill(findInputFn, text) {
  var probe = findInputFn();
  if (!probe) return { ok: false, strategy: null };

  var isFormField = probe.tagName === 'TEXTAREA' || probe.tagName === 'INPUT';
  var hasTiptap   = !isFormField && typeof probe.editor === 'object' && probe.editor !== null;
  var hasQuill    = !isFormField && !hasTiptap && !!(probe.closest && probe.closest('.ql-container'));

  var strategies;
  if (isFormField) {
    strategies = [['native', chFillNative], ['execCommand', chFillExecCommand]];
  } else if (hasTiptap) {
    // Live-tested on Grok (Jul 2026): execCommand('insertText') actually
    // persists and is NOT reverted by ProseMirror's render cycle — confirmed
    // via console (text survived 400ms later). chFillTiptap's
    // el.editor.commands.setContent() call is plausible but unverified on
    // Grok's specific editor build, so don't bet on it going first. The
    // `paste` ClipboardEvent strategy is confirmed BROKEN here: ProseMirror's
    // clipboard plugin intercepts it (preventDefault, notCancelled=false) but
    // doesn't read our synthetic DataTransfer, leaving the editor empty — so
    // it's dropped entirely rather than kept as a silent dead-end fallback.
    strategies = [['execCommand', chFillExecCommand], ['tiptap', chFillTiptap]];
  } else if (hasQuill) {
    strategies = [['quill', chFillQuill], ['execCommand', chFillExecCommand], ['paste', chFillPaste]];
  } else {
    // Generic contenteditable, no known editor API on the node.
    strategies = [['execCommand', chFillExecCommand], ['native', chFillNative], ['paste', chFillPaste]];
  }

  for (var i = 0; i < strategies.length; i++) {
    var name = strategies[i][0];
    var fn   = strategies[i][1];
    var el   = findInputFn();
    if (!el) continue;
    try {
      el.focus();
      fn(el, text);
      chMoveCursorToEnd(el);
    } catch (e) { continue; }
    if (chLooksFilled(el, text)) return { ok: true, strategy: name };
  }

  return { ok: false, strategy: null };
};