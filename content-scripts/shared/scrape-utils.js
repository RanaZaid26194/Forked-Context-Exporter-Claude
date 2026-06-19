// content-scripts/shared/scrape-utils.js
// Shared DOM utilities loaded before every site-specific content script.
// Exposes helpers under window.ContextHandoff to avoid polluting global scope.

'use strict';

window.ContextHandoff = window.ContextHandoff || {};

/**
 * Try a list of CSS selectors in order; return the first matching element.
 * Invalid selectors are silently skipped so a stale selector doesn't crash
 * the whole scrape.
 *
 * @param {string|string[]} selectors
 * @param {Element|Document} [root=document]
 * @returns {Element|null}
 */
window.ContextHandoff.queryFirst = function queryFirst(selectors, root) {
  root = root || document;
  var list = Array.isArray(selectors) ? selectors : [selectors];
  for (var i = 0; i < list.length; i++) {
    try {
      var el = root.querySelector(list[i]);
      if (el) return el;
    } catch (e) { /* invalid selector — skip */ }
  }
  return null;
};

/**
 * Try a list of CSS selectors in order; return all elements for the first
 * selector that yields at least one result.
 *
 * @param {string|string[]} selectors
 * @param {Element|Document} [root=document]
 * @returns {Element[]}
 */
window.ContextHandoff.queryAll = function queryAll(selectors, root) {
  root = root || document;
  var list = Array.isArray(selectors) ? selectors : [selectors];
  for (var i = 0; i < list.length; i++) {
    try {
      var els = root.querySelectorAll(list[i]);
      if (els.length > 0) return Array.from(els);
    } catch (e) { /* invalid selector — skip */ }
  }
  return [];
};

/**
 * Extract code blocks from a turn element.
 * Returns an array of { language, code } objects.
 * Language is derived from the CSS class on <code> (e.g. "language-python" → "python").
 *
 * @param {Element} turnEl
 * @returns {{ language: string, code: string }[]}
 */
window.ContextHandoff.extractCodeBlocks = function extractCodeBlocks(turnEl) {
  var blocks = [];
  var LANG_RE = /language-(\w+)/;
  turnEl.querySelectorAll('pre code').forEach(function (codeEl) {
    var lang = (codeEl.className.match(LANG_RE) || [])[1] || '';
    blocks.push({ language: lang, code: codeEl.textContent || '' });
  });
  return blocks;
};

/**
 * Normalize whitespace in a string: collapse 3+ consecutive newlines to 2, trim.
 *
 * @param {string} text
 * @returns {string}
 */
window.ContextHandoff.normalizeWhitespace = function normalizeWhitespace(text) {
  return (text || '').replace(/\n{3,}/g, '\n\n').trim();
};

/**
 * Build the outer conversation metadata envelope.
 * The caller fills in the turns array.
 *
 * @param {{ source: string, title: string, url?: string }} opts
 * @returns {Object}
 */
window.ContextHandoff.buildConversationMeta = function buildConversationMeta(opts) {
  opts = opts || {};
  return {
    source: opts.source || 'unknown',
    title: opts.title || 'Untitled Conversation',
    url: opts.url || window.location.href,
    capturedAt: new Date().toISOString(),
    turns: [],
  };
};
