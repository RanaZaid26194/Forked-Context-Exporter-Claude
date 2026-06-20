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

// ── TextRank fallback ─────────────────────────────────────────────────────────
// Used only when structural extraction finds nothing usable in a long turn.
// Complexity: O(n²) on sentences — fine for typical assistant turns (< 80 sentences).

var STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','it','its','as','be','was','are','were','been','have',
  'has','had','do','does','did','will','would','could','should','may',
  'might','this','that','these','those','i','we','you','he','she','they',
  'not','no','so','if','then','than','when','where','which','who','can',
]);

/**
 * Tokenise a sentence into a bag-of-words (lowercased, stopwords removed).
 * @param {string} sentence
 * @returns {Object.<string,number>} word → count
 */
function bagOfWords(sentence) {
  var bag = {};
  var words = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w.length > 2 && !STOPWORDS.has(w)) {
      bag[w] = (bag[w] || 0) + 1;
    }
  }
  return bag;
}

/**
 * Jaccard similarity between two bag-of-words objects.
 * Returns a value in [0, 1].
 */
function jaccardSim(bagA, bagB) {
  var keysA = Object.keys(bagA);
  var keysB = Object.keys(bagB);
  if (keysA.length === 0 && keysB.length === 0) return 0;
  var intersection = 0;
  for (var i = 0; i < keysA.length; i++) {
    if (bagB[keysA[i]]) intersection++;
  }
  var union = keysA.length + keysB.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * TextRank-style sentence scoring for unstructured text.
 * Returns the top `topN` sentences by graph centrality, in original order.
 *
 * @param {string[]} sentences
 * @param {number}   [topN=3]
 * @param {number}   [iterations=4]
 * @param {number}   [damping=0.85]
 * @returns {string[]}
 */
function textRankTopSentences(sentences, topN, iterations, damping) {
  topN       = topN       || 3;
  iterations = iterations || 4;
  damping    = damping    || 0.85;

  var n = sentences.length;
  if (n <= topN) return sentences.slice();

  // Pre-compute bags
  var bags = sentences.map(bagOfWords);

  // Build similarity matrix (upper triangle only, symmetric)
  var sim = [];
  for (var i = 0; i < n; i++) {
    sim[i] = new Array(n).fill(0);
  }
  for (var a = 0; a < n; a++) {
    for (var b = a + 1; b < n; b++) {
      var s = jaccardSim(bags[a], bags[b]);
      sim[a][b] = s;
      sim[b][a] = s;
    }
  }

  // Compute row sums for normalisation
  var rowSums = new Array(n).fill(0);
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) rowSums[r] += sim[r][c];
  }

  // PageRank iterations
  var scores = new Array(n).fill(1 / n);
  for (var iter = 0; iter < iterations; iter++) {
    var newScores = new Array(n).fill((1 - damping) / n);
    for (var j = 0; j < n; j++) {
      for (var k = 0; k < n; k++) {
        if (k !== j && rowSums[k] > 0) {
          newScores[j] += damping * (sim[k][j] / rowSums[k]) * scores[k];
        }
      }
    }
    scores = newScores;
  }

  // Rank by score, pick topN, restore original order
  var indexed = scores.map(function(sc, idx) { return { idx: idx, score: sc }; });
  indexed.sort(function(x, y) { return y.score - x.score; });
  var topIdxs = indexed.slice(0, topN).map(function(e) { return e.idx; });
  topIdxs.sort(function(x, y) { return x - y; }); // restore original order
  return topIdxs.map(function(idx) { return sentences[idx]; });
}


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
    if (text.length < 40) continue; // skip trivially short turns

    var highlights = extractStructuralHighlights(text);
    highlights.forEach(function(h) { structuralSet[h.toLowerCase()] = true; });

    var sentences   = splitSentences(text);
    var turnScored  = 0; // count of sentences that scored >= 1 for THIS turn

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
          fromTextRank: false,
        });
        turnScored++;
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
          fromTextRank: false,
        });
        turnScored++;
      }
    }

    // ── TextRank fallback ─────────────────────────────────────────────────────
    // Only run when: (a) this turn is long enough to be meaningful, and
    // (b) structural pass yielded nothing — i.e. no highlights AND no scored sentences.
    var isLongTurn     = sentences.length >= 5 && text.length >= 200;
    var noStructure    = highlights.length === 0;
    var nothingScored  = turnScored === 0;

    if (isLongTurn && noStructure && nothingScored) {
      var trSentences = textRankTopSentences(sentences, 3, 4, 0.85);
      for (var tr = 0; tr < trSentences.length; tr++) {
        var trSent  = trSentences[tr];
        var trLower = trSent.toLowerCase();
        scoredSentences.push({
          text:         trSent,
          score:        0.8, // TextRank sentences rank below keyword matches
          isOpen:       scoreSignals(trLower, OPEN_ITEM_SIGNALS) >= 1,
          fromTextRank: true,
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
