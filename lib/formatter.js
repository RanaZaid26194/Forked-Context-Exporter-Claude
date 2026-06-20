// lib/formatter.js
// Converts a normalized conversation JSON object into export formats.
// Loaded via <script> tag in popup.html so it runs in the popup's JS context.
//
// Conversation schema:
//   {
//     source: string,        // e.g. "claude.ai"
//     title: string,
//     capturedAt: string,    // ISO 8601
//     url: string,
//     turns: [
//       {
//         role: "user" | "assistant",
//         text: string,
//         codeBlocks: [{ language: string, code: string }]
//       }
//     ]
//   }

'use strict';

window.ContextHandoff = window.ContextHandoff || {};

// ── Internal helpers ─────────────────────────────────────────────────────────

function fenceCodeBlock(block) {
  var fence = '```';
  var lang = block.language || block.lang || '';
  return fence + lang + '\n' + (block.code || '').trimEnd() + '\n' + fence;
}

function roleLabel(role) {
  if (role === 'assistant') return 'Claude';
  if (role === 'user') return 'You';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatDate(isoString) {
  if (!isoString) return 'Unknown';
  try {
    return new Date(isoString).toLocaleString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch (e) {
    return isoString;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert a normalized conversation object to a Markdown transcript string.
 * Each turn gets a ### heading (### You / ### Claude), with inline text
 * followed by fenced code blocks preserving language tags.
 *
 * @param {Object} conversation
 * @returns {string}
 */
window.ContextHandoff.toMarkdown = function toMarkdown(conversation) {
  if (!conversation) return '';

  var source = conversation.source || 'unknown';
  var title = conversation.title || 'Untitled Conversation';
  var capturedAt = formatDate(conversation.capturedAt);
  var url = conversation.url || '';
  var turns = conversation.turns || [];

  var lines = [
    '# ' + title,
    '',
    '**Source:** ' + source + '  ',
    '**Captured:** ' + capturedAt + '  ',
  ];

  if (url) lines.push('**URL:** ' + url + '  ');
  lines.push('', '---', '');

  for (var i = 0; i < turns.length; i++) {
    var turn = turns[i];
    var label = roleLabel(turn.role);

    lines.push('### ' + label);
    lines.push('');

    if (turn.text) {
      lines.push(turn.text);
      lines.push('');
    }

    var blocks = turn.codeBlocks || [];
    for (var j = 0; j < blocks.length; j++) {
      lines.push(fenceCodeBlock(blocks[j]));
      lines.push('');
    }
  }

  return lines.join('\n');
};

/**
 * Generate a safe filename base from a conversation title.
 * Replaces characters illegal in common filesystems, collapses whitespace.
 *
 * @param {string} title
 * @returns {string}
 */
window.ContextHandoff.safeFilename = function safeFilename(title) {
  return (title || 'conversation')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'conversation';
};

/**
 * Render a structured summary object as a concise Markdown brief.
 *
 * @param {Object} summary - Output of ContextHandoff.summarize().
 * @param {Object} [conversation] - Optional, used for title.
 * @returns {string}
 */
window.ContextHandoff.toSummaryMarkdown = function toSummaryMarkdown(summary, conversation) {
  if (!summary) return '';
  var title = (conversation && conversation.title) || 'Conversation Summary';
  var lines = ['# ' + title + ' — Summary', ''];

  // Decisions
  var decisions = summary.decisionsLog || [];
  if (decisions.length > 0) {
    lines.push('## Key Decisions');
    lines.push('');
    for (var d = 0; d < decisions.length; d++) {
      lines.push('- ' + decisions[d]);
    }
    lines.push('');
  }

  // Code state
  var codeState = summary.codeState || [];
  if (codeState.length > 0) {
    lines.push('## Current Code State');
    lines.push('');
    for (var c = 0; c < codeState.length; c++) {
      var block = codeState[c];
      var heading = block.file ? block.file : (block.lang ? '(' + block.lang + ')' : 'Code block');
      lines.push('### ' + heading);
      lines.push('');
      lines.push('```' + (block.lang || ''));
      lines.push((block.code || '').trimEnd());
      lines.push('```');
      lines.push('');
    }
  }

  // Open items
  var openItems = summary.openItems || [];
  if (openItems.length > 0) {
    lines.push('## Open Items');
    lines.push('');
    for (var o = 0; o < openItems.length; o++) {
      lines.push('- ' + openItems[o]);
    }
    lines.push('');
  }

  // Last turns
  var lastTurns = summary.lastTurns || [];
  if (lastTurns.length > 0) {
    lines.push('## Last Exchange');
    lines.push('');
    for (var t = 0; t < lastTurns.length; t++) {
      var turn = lastTurns[t];
      lines.push('### ' + roleLabel(turn.role));
      lines.push('');
      if (turn.text) { lines.push(turn.text); lines.push(''); }
      var blocks = turn.codeBlocks || [];
      for (var b = 0; b < blocks.length; b++) {
        lines.push(fenceCodeBlock(blocks[b]));
        lines.push('');
      }
    }
  }

  return lines.join('\n');
};

/**
 * Generate the handoff prompt — a single pasteable block for a new AI session.
 * Includes instruction frame, decisions, code state, open items, verbatim last exchange.
 *
 * @param {Object} conversation - Normalized conversation.
 * @param {Object} summary      - Output of ContextHandoff.summarize().
 * @returns {string}
 */
window.ContextHandoff.toHandoffPrompt = function toHandoffPrompt(conversation, summary) {
  if (!conversation || !summary) return '';

  var title      = conversation.title || 'Untitled Conversation';
  var source     = conversation.source || 'an AI assistant';
  var url        = conversation.url || '';
  var turns      = conversation.turns || [];
  var firstUser  = '';
  for (var fi = 0; fi < turns.length; fi++) {
    if (turns[fi].role === 'user' && turns[fi].text) {
      firstUser = turns[fi].text.slice(0, 300);
      if (turns[fi].text.length > 300) firstUser += '…';
      break;
    }
  }

  var decisions  = summary.decisionsLog || [];
  var codeState  = summary.codeState    || [];
  var openItems  = summary.openItems    || [];
  var lastTurns  = summary.lastTurns    || [];

  var lines = [
    'I\'m continuing a conversation from another AI assistant (' + source + ').',
    'Below is the context you need to pick up where we left off.',
    '',
    '---',
    '',
    '## What we\'re building',
    '',
    '**' + title + '**',
  ];

  if (firstUser) {
    lines.push('');
    lines.push(firstUser);
  }
  if (url) {
    lines.push('');
    lines.push('_Original conversation: ' + url + '_');
  }
  lines.push('');

  // Decisions
  if (decisions.length > 0) {
    lines.push('## Key decisions made');
    lines.push('');
    for (var d = 0; d < decisions.length; d++) {
      lines.push('- ' + decisions[d]);
    }
    lines.push('');
  }

  // Code state
  if (codeState.length > 0) {
    lines.push('## Current code state');
    lines.push('');
    for (var c = 0; c < codeState.length; c++) {
      var block = codeState[c];
      if (block.file) lines.push('**' + block.file + '**');
      lines.push('```' + (block.lang || ''));
      lines.push((block.code || '').trimEnd());
      lines.push('```');
      lines.push('');
    }
  }

  // Open items
  if (openItems.length > 0) {
    lines.push('## Open items');
    lines.push('');
    for (var o = 0; o < openItems.length; o++) {
      lines.push('- ' + openItems[o]);
    }
    lines.push('');
  }

  // Last exchange verbatim
  if (lastTurns.length > 0) {
    lines.push('## Last exchange (verbatim)');
    lines.push('');
    for (var t = 0; t < lastTurns.length; t++) {
      var turn = lastTurns[t];
      lines.push('### ' + roleLabel(turn.role));
      lines.push('');
      if (turn.text) { lines.push(turn.text); lines.push(''); }
      var blocks = turn.codeBlocks || [];
      for (var b = 0; b < blocks.length; b++) {
        lines.push(fenceCodeBlock(blocks[b]));
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('Please review the code state and open items, then continue from where we left off.');

  return lines.join('\n');
};
