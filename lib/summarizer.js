// lib/summarizer.js
// Extractive summarization — NO AI API calls. Rule-based only.
//
// Two-pass extraction over a normalized conversation object:
//   Pass 1 — structural: code blocks, headers/bullets/bold, last N turns verbatim.
//   Pass 2 — keyword scoring: signal phrases identify decision sentences & open items.
//
// Phase 3 extension point: TextRank sentence ranking (word-overlap similarity).
// Add it here as a third pass without changing the output schema.

'use strict';

window.ContextHandoff = window.ContextHandoff || {};

// ── Signal phrases ────────────────────────────────────────────────────────────
// Sentences hitting more of these score higher in decisionsLog.
var DECISION_SIGNALS = [
  "let's", "i'll use", "final", "decided", "next step", "todo",
  "we need to", "fixed", "the issue was", "the problem is", "solution",
  "approach", "implemented", "changed", "going with", "we're using",
  "the fix", "resolved", "updated", "added", "removed",
];

var OPEN_ITEM_SIGNALS = [
  "todo", "next step", "we need to", "remaining", "still need",
  "haven't", "will need", "should", "eventually", "later",
  "not yet", "pending", "open question",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split text into sentences on . ! ? followed by space/end, preserving URLs.
 */
function splitSentences(text) {
  // Replace URLs temporarily to avoid splitting on dots inside them
  var urlPlaceholders = [];
  var safe = text.replace(/https?:\/\/[^\s]+/g, function(url) {
    urlPlaceholders.push(url);
    return '<<URL' + (urlPlaceholders.length - 1) + '>>';
  });
  var parts = safe.split(/(?<=[.!?])\s+/);
  return parts.map(function(p) {
    return p.replace(/<<URL(\d+)>>/g, function(_, i) {
      return urlPlaceholders[parseInt(i, 10)];
    }).trim();
  }).filter(function(s) { return s.length > 10; });
}

/**
 * Count how many signal phrases appear in a lowercased sentence.
 */
function scoreSignals(lower, signals) {
  var hits = 0;
  for (var i = 0; i < signals.length; i++) {
    if (lower.indexOf(signals[i]) !== -1) hits++;
  }
  return hits;
}

/**
 * Try to infer a filename from the text immediately before a code block.
 * Looks for patterns like "in foo.js", "file: bar.py", "filename: baz.ts".
 */
function inferFilename(contextText) {
  if (!contextText) return '';
  var patterns = [
    /(?:file|filename|in|edit|update|create|open|modify)\s+[`"]?([A-Za-z0-9_./\\-]+\.[A-Za-z]{1,6})[`"]?/i,
    /[`"]([A-Za-z0-9_./\\-]+\.[A-Za-z]{1,6})[`"]/,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var m = contextText.match(patterns[i]);
    if (m && m[1] && m[1].length < 60) return m[1];
  }
  return '';
}

/**
 * Extract text from markdown-style structural elements (headers, bullets, bold).
 * Returns an array of plain strings.
 */
function extractStructuralHighlights(text) {
  var highlights = [];
  var lines = text.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    // Headers: # ## ###
    if (/^#{1,3}\s+/.test(line)) {
      var h = line.replace(/^#+\s+/, '').trim();
      if (h.length > 3) highlights.push(h);
      continue;
    }
    // Bullet/numbered lists
    if (/^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      var b = line.replace(/^[-*•\d.]+\s+/, '').trim();
      if (b.length > 5) highlights.push(b);
      continue;
    }
    // Bold text: **...**
    var boldMatches = line.match(/\*\*(.+?)\*\*/g);
    if (boldMatches) {
      boldMatches.forEach(function(m) {
        var inner = m.replace(/\*\*/g, '').trim();
        if (inner.length > 3) highlights.push(inner);
      });
    }
  }
  return highlights;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Summarize a normalized conversation into structured summary data.
 *
 * @param {Object} conversation - Normalized conversation (turns array).
 * @param {Object} [opts]
 * @param {number} [opts.lastTurnsCount=3] - How many trailing turns to keep verbatim.
 * @param {number} [opts.maxDecisions=10]  - Max sentences in decisionsLog.
 * @param {number} [opts.maxOpenItems=8]   - Max open items to surface.
 * @returns {{ decisionsLog, codeState, openItems, lastTurns }}
 */
window.ContextHandoff.summarize = function summarize(conversation, opts) {
  opts = opts || {};
  var lastTurnsCount = opts.lastTurnsCount || 3;
  var maxDecisions   = opts.maxDecisions   || 10;
  var maxOpenItems   = opts.maxOpenItems   || 8;

  var turns = (conversation && conversation.turns) || [];

  // ── Pass 1: Structural extraction ─────────────────────────────────────────

  var codeState  = [];
  var lastTurns  = turns.slice(-lastTurnsCount);
  var seenCode   = {};  // deduplicate identical code blocks

  // Collect all code blocks across all turns
  for (var t = 0; t < turns.length; t++) {
    var turn = turns[t];
    var blocks = turn.codeBlocks || [];
    for (var b = 0; b < blocks.length; b++) {
      var block = blocks[b];
      var dedupeKey = (block.lang || block.language || '') + '::' + (block.code || '').slice(0, 120);
      if (seenCode[dedupeKey]) continue;
      seenCode[dedupeKey] = true;

      // Try to infer filename from the surrounding turn text
      var file = inferFilename(turn.text || '');

      codeState.push({
        file: file,
        lang: block.lang || block.language || '',
        code: block.code || '',
      });
    }
  }

  // ── Pass 2: Keyword/pattern decision scoring ───────────────────────────────

  // Build a set of structural highlight strings for bonus scoring
  var structuralSet = {};
  var scoredSentences = [];

  for (var i = 0; i < turns.length; i++) {
    var aTurn = turns[i];
    if (aTurn.role !== 'assistant') continue;

    var text = aTurn.text || '';
    var highlights = extractStructuralHighlights(text);
    highlights.forEach(function(h) { structuralSet[h.toLowerCase()] = true; });

    var sentences = splitSentences(text);
    for (var s = 0; s < sentences.length; s++) {
      var sentence = sentences[s];
      var lower = sentence.toLowerCase();
      var decisionScore = scoreSignals(lower, DECISION_SIGNALS);
      var isStructural  = structuralSet[lower] ? 0.5 : 0;
      var totalScore    = decisionScore + isStructural;

      if (totalScore >= 1) {
        scoredSentences.push({
          text:     sentence,
          score:    totalScore,
          isOpen:   scoreSignals(lower, OPEN_ITEM_SIGNALS) >= 1,
        });
      }
    }

    // Also score structural highlights themselves
    for (var h = 0; h < highlights.length; h++) {
      var hl = highlights[h];
      var hlLower = hl.toLowerCase();
      var hlScore = scoreSignals(hlLower, DECISION_SIGNALS) + 0.5;
      if (hlScore >= 1) {
        scoredSentences.push({
          text:   hl,
          score:  hlScore,
          isOpen: scoreSignals(hlLower, OPEN_ITEM_SIGNALS) >= 1,
        });
      }
    }
  }

  // Sort by score descending, deduplicate by trimmed text
  scoredSentences.sort(function(a, b) { return b.score - a.score; });
  var seenTexts  = {};
  var decisionsLog = [];
  var openItems    = [];

  for (var ss = 0; ss < scoredSentences.length; ss++) {
    var item = scoredSentences[ss];
    var key  = item.text.trim().toLowerCase().slice(0, 80);
    if (seenTexts[key]) continue;
    seenTexts[key] = true;

    if (item.isOpen && openItems.length < maxOpenItems) {
      openItems.push(item.text.trim());
    } else if (!item.isOpen && decisionsLog.length < maxDecisions) {
      decisionsLog.push(item.text.trim());
    }

    if (decisionsLog.length >= maxDecisions && openItems.length >= maxOpenItems) break;
  }

  return {
    decisionsLog: decisionsLog,
    codeState:    codeState,
    openItems:    openItems,
    lastTurns:    lastTurns,
  };
};
