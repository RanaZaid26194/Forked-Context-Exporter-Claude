// content-scripts/claude.js
// Scrapes conversation turns from claude.ai's DOM into a normalized JSON structure.
//
// ── Turn discrimination technique ────────────────────────────────────────────
// Claude (assistant) turns contain a feedback action bar with thumbs-up/down
// buttons. User turns do not. We use presence of these buttons as the primary
// role discriminator.
//
// This technique is derived from agarwalvishal/claude-chat-exporter (MIT):
//   SELECTORS.feedbackButton = 'button[aria-label="Give positive feedback"]'
//
// All selectors below are best-effort and based on Claude.ai's DOM as observed
// in publicly available reference extensions. Claude.ai refactors its DOM
// periodically — if scraping breaks, inspect the live page and update the
// selector lists in SEL below.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

(function () {

  // ── Selector candidates ────────────────────────────────────────────────────
  // Arrays are tried in order; the first selector that yields results wins.
  // This makes the scraper resilient to DOM refactors — add newer selectors to
  // the front of each array when Claude updates their UI.

  var SEL = {

    // Turn containers — each conversation turn (human or AI) lives in one of
    // these. data-testid attributes are more stable than generated class names.
    // best-effort selectors, verify against live DOM
    turnContainers: [
      '[data-testid^="message-"]',          // message-<uuid> — most specific
      '[data-testid="human-turn"]',
      '[data-testid="ai-turn"]',
      '[data-testid="human-turn-content"]',
      '[data-testid="ai-turn-content"]',
      'div[class*="ConversationItem"]',
      '[role="article"]',
    ],

    // Conversation scroll container — used as fallback root when no turn
    // containers are found via the selectors above.
    // best-effort selectors, verify against live DOM
    conversationRoot: [
      '[data-testid="conversation-content"]',
      '[data-testid="chat-content"]',
      'div[class*="conversation-content"]',
      'main',
    ],

    // Feedback buttons are rendered ONLY on Claude (assistant) turns.
    // Their presence is the primary role discriminator.
    // Source: agarwalvishal/claude-chat-exporter selector strategy
    // best-effort selectors, verify against live DOM
    feedbackButtons: [
      'button[aria-label="Give positive feedback"]',
      'button[aria-label="Thumbs up"]',
      'button[data-testid="feedback-positive"]',
      'button[aria-label*="positive"]',
      'button[aria-label*="helpful"]',
    ],

    // Copy button — also exclusive to Claude turns (secondary discriminator).
    // best-effort selector, verify against live DOM
    copyButton: 'button[data-testid="action-bar-copy"]',

    // Message actions group — another secondary discriminator for Claude turns.
    // best-effort selector, verify against live DOM
    messageActionsGroup: '[role="group"][aria-label="Message actions"]',

    // Conversation title.
    // best-effort selectors, verify against live DOM
    title: [
      '[data-testid="chat-title-button"] .truncate',
      'button[data-testid="chat-title-button"] div.truncate',
      '[data-testid="chat-title-button"]',
      'h1',
    ],
  };

  // Language class regex for code block detection
  var LANG_RE = /language-(\w+)/;

  // ── Helpers (prefer window.ContextHandoff from scrape-utils.js) ───────────

  var CH = window.ContextHandoff || {};

  function queryFirst(sels, root) {
    return CH.queryFirst ? CH.queryFirst(sels, root)
      : (root || document).querySelector(Array.isArray(sels) ? sels[0] : sels);
  }

  function queryAll(sels, root) {
    return CH.queryAll ? CH.queryAll(sels, root) : [];
  }

  // ── Role detection ─────────────────────────────────────────────────────────

  /**
   * Returns true if turnEl is a Claude (assistant) turn.
   *
   * Primary signal: feedback/reaction buttons (only present on assistant turns).
   * Secondary signal: copy button, message actions group.
   *
   * Why: Claude's DOM renders an action bar with thumbs-up/down (and a copy
   * button) beneath every assistant message but not beneath user messages.
   * This is more reliable than positional index because Claude sometimes
   * inserts system messages or tool-use blocks that break simple even/odd
   * alternation.
   */
  function isAssistantTurn(turnEl) {
    // Primary: feedback buttons
    for (var i = 0; i < SEL.feedbackButtons.length; i++) {
      try {
        if (turnEl.querySelector(SEL.feedbackButtons[i])) return true;
      } catch (e) { /* invalid selector */ }
    }
    // Secondary: copy button
    try {
      if (turnEl.querySelector(SEL.copyButton)) return true;
    } catch (e) { /* */ }
    // Tertiary: message actions group
    try {
      if (turnEl.querySelector(SEL.messageActionsGroup)) return true;
    } catch (e) { /* */ }
    return false;
  }

  // ── Text extraction ────────────────────────────────────────────────────────

  /**
   * Extract the human-readable text from a turn element, stripping code blocks
   * so they can be captured separately with language metadata.
   */
  function extractText(turnEl) {
    var clone = turnEl.cloneNode(true);
    // Remove <pre> elements (code blocks) before extracting plain text
    clone.querySelectorAll('pre').forEach(function (pre) { pre.remove(); });
    // Also remove button/action bars to avoid capturing UI text
    clone.querySelectorAll('button, [role="toolbar"], [role="group"]').forEach(function (el) {
      el.remove();
    });
    var raw = clone.textContent || '';
    return CH.normalizeWhitespace ? CH.normalizeWhitespace(raw) : raw.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Extract code blocks from a turn element.
   * Returns [{ language, code }] — language may be empty string if not detected.
   */
  function extractCodeBlocks(turnEl) {
    if (CH.extractCodeBlocks) return CH.extractCodeBlocks(turnEl);
    var blocks = [];
    turnEl.querySelectorAll('pre code').forEach(function (codeEl) {
      var lang = (codeEl.className.match(LANG_RE) || [])[1] || '';
      blocks.push({ language: lang, code: codeEl.textContent || '' });
    });
    return blocks;
  }

  // ── Conversation title ─────────────────────────────────────────────────────

  function getTitle() {
    var el = queryFirst(SEL.title);
    if (el) {
      var text = el.textContent.trim();
      if (text && text !== 'New conversation' && text !== 'Claude') return text;
    }
    return document.title.replace(/\s*[-|].*$/, '').trim() || 'Untitled Conversation';
  }

  // ── Structural fallback ────────────────────────────────────────────────────

  /**
   * When no turn containers are found via SEL.turnContainers, fall back to
   * walking direct children of the conversation root. Any child with more than
   * 20 characters of text content is treated as a potential turn.
   */
  function fallbackTurnScan() {
    var root = queryFirst(SEL.conversationRoot);
    if (!root) return [];
    return Array.from(root.children).filter(function (el) {
      return (el.textContent || '').trim().length > 20;
    });
  }

  // ── Main scrape ────────────────────────────────────────────────────────────

  function scrapeConversation() {
    var title = getTitle();

    // 1. Find turn containers
    var turnEls = queryAll(SEL.turnContainers);

    // 2. Structural fallback
    if (turnEls.length === 0) {
      console.warn('[Context Handoff] No turns via primary selectors — trying structural fallback.');
      turnEls = fallbackTurnScan();
    }

    if (turnEls.length === 0) {
      // Log so the user can report what page state we couldn't handle
      console.warn('[Context Handoff] Could not find any conversation turns. ' +
        'Verify you are on a conversation page (not the home/new-chat screen). ' +
        'If Claude updated their DOM, update SEL.turnContainers in claude.js.');
      return null;
    }

    // 3. Build normalized turns
    var turns = [];
    for (var i = 0; i < turnEls.length; i++) {
      var el = turnEls[i];
      var role = isAssistantTurn(el) ? 'assistant' : 'user';
      var text = extractText(el);
      var codeBlocks = extractCodeBlocks(el);

      // Skip turns with no meaningful content (e.g. decorative wrappers)
      if (!text && codeBlocks.length === 0) continue;

      turns.push({ role: role, text: text, codeBlocks: codeBlocks });
    }

    if (turns.length === 0) {
      console.warn('[Context Handoff] Turn elements found but all were empty after extraction.');
      return null;
    }

    return {
      source: 'claude.ai',
      title: title,
      capturedAt: new Date().toISOString(),
      url: window.location.href,
      turns: turns,
    };
  }

  // ── Message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

    if (message.action === 'PING') {
      sendResponse({ ok: true, source: 'claude.ai' });
      return true;
    }

    if (message.action === 'GET_CONVERSATION') {
      try {
        var conversation = scrapeConversation();
        if (conversation) {
          sendResponse({ ok: true, conversation: conversation });
        } else {
          sendResponse({
            ok: false,
            error: 'No conversation found. Open a conversation (not the home screen) and try again.',
          });
        }
      } catch (err) {
        console.error('[Context Handoff] Scrape error:', err);
        sendResponse({ ok: false, error: err.message });
      }
      return true; // keep message channel open (required for async sendResponse)
    }

    // TODO(Phase 2): handle LIMIT_CHECK action
  });

  console.log('[Context Handoff] claude.js loaded on', window.location.href);

})();
