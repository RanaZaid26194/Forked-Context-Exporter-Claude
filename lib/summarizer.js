// lib/summarizer.js — Phase 2 stub
//
// Will implement extractive summarization (NO AI API calls — rule-based only):
//   - Structural extraction: headers, bullet points, bold text, last 2-3 turns in full.
//   - Keyword/pattern scoring: signal phrases like "decided", "final", "TODO",
//     "next step", "the issue was", "let's use".
//   - Phase 3 extension: TextRank-style sentence ranking via word-overlap
//     cosine similarity + iterative scoring (~150 lines of plain JS, no library).
//
// TODO(Phase 2): implement summarizer.js

'use strict';

window.ContextHandoff = window.ContextHandoff || {};

/**
 * Placeholder — returns null until Phase 2 is implemented.
 * @param {Object} conversation - Normalized conversation JSON.
 * @returns {null}
 */
window.ContextHandoff.summarize = function summarize(_conversation) {
  // TODO(Phase 2): implement structural extraction + keyword scoring
  return null;
};
