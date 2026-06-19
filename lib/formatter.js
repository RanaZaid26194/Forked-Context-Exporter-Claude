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
  var lang = block.language || '';
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

// TODO(Phase 2): window.ContextHandoff.toSummaryMarkdown(conversation)
// TODO(Phase 2): window.ContextHandoff.toHandoffPrompt(conversation, summary)
