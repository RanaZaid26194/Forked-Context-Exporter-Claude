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
      '[class*="font-user-message"], [class*="font-claude-message"]',
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
      '[data-testid="chat-title-split"] .truncate',
      '[data-testid="chat-title-split"]',
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
    var cls = turnEl.className || '';
    if (typeof cls === 'string') {
      if (cls.indexOf('font-claude-message') !== -1) return true;
      if (cls.indexOf('font-user-message') !== -1) return false;
    }

    // Fallbacks:
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

    // ── Strategy 1: Common-ancestor walk ────────────────────────────────────────
    // Find a user-message element AND a feedback button. Walk up from each to
    // find their closest common ancestor — that's the conversation container.
    // Then walk its children, classifying each by what it contains.
    var firstUserMsg = document.querySelector('[data-testid="user-message"]');
    var firstFeedbackBtn = null;
    for (var fb = 0; fb < SEL.feedbackButtons.length; fb++) {
      try {
        firstFeedbackBtn = document.querySelector(SEL.feedbackButtons[fb]);
        if (firstFeedbackBtn) break;
      } catch (e) { /* */ }
    }



    if (firstUserMsg && firstFeedbackBtn) {
      // Collect all ancestors of the user message element
      var userAncestors = new Set();
      var node = firstUserMsg;
      while (node) {
        userAncestors.add(node);
        node = node.parentElement;
      }
      // Walk up from feedback button until we hit a shared ancestor
      var container = firstFeedbackBtn.parentElement;
      while (container && !userAncestors.has(container)) {
        container = container.parentElement;
      }



      if (container && container.children.length >= 2) {
        var classifiedEls = [];
        var children = Array.from(container.children);
        for (var c = 0; c < children.length; c++) {
          var child = children[c];
          // User turn: contains a user-message testid
          if (child.querySelector('[data-testid="user-message"]') || child.getAttribute('data-testid') === 'user-message') {
            classifiedEls.push({ el: child, role: 'user' });
            continue;
          }
          // Assistant turn: contains a feedback button
          var hasFeedback = false;
          for (var f = 0; f < SEL.feedbackButtons.length; f++) {
            try {
              if (child.querySelector(SEL.feedbackButtons[f])) {
                hasFeedback = true;
                break;
              }
            } catch (e) { /* */ }
          }
          if (hasFeedback) {
            classifiedEls.push({ el: child, role: 'assistant' });
          }
        }



        if (classifiedEls.length > 0) {
          var turns = [];
          for (var t = 0; t < classifiedEls.length; t++) {
            var text = extractText(classifiedEls[t].el);
            var codeBlocks = extractCodeBlocks(classifiedEls[t].el);

            if (!text && codeBlocks.length === 0) continue;
            turns.push({ role: classifiedEls[t].role, text: text, codeBlocks: codeBlocks });
          }

          if (turns.length > 0) {
            return {
              source: 'claude.ai',
              title: title,
              capturedAt: new Date().toISOString(),
              url: window.location.href,
              turns: turns,
            };
          }
        }
      }
    }

    // ── Strategy 2: Legacy CSS-class selector fallback ─────────────────────────
    // Used if Strategy 1 finds nothing (e.g. Claude refactors data-testid).
    var turnEls = queryAll(SEL.turnContainers);

    if (turnEls.length === 0) {
      console.warn('[Context Handoff] No turns via primary selectors — trying structural fallback.');
      turnEls = fallbackTurnScan();
    }

    if (turnEls.length === 0) {
      console.warn('[Context Handoff] Could not find any conversation turns. ' +
        'Verify you are on a conversation page (not the home/new-chat screen). ' +
        'If Claude updated their DOM, update SEL.turnContainers in claude.js.');
      return null;
    }

    // Keep only outermost matched elements (avoid nested duplicates)
    var outerEls = [];
    for (var k = 0; k < turnEls.length; k++) {
      var isDescendant = false;
      for (var j = 0; j < turnEls.length; j++) {
        if (k !== j && turnEls[j].contains(turnEls[k])) {
          isDescendant = true;
          break;
        }
      }
      if (!isDescendant) outerEls.push(turnEls[k]);
    }

    var legacyTurns = [];
    for (var i = 0; i < outerEls.length; i++) {
      var el = outerEls[i];
      var role = isAssistantTurn(el) ? 'assistant' : 'user';
      var text = extractText(el);
      var codeBlocks = extractCodeBlocks(el);
      if (!text && codeBlocks.length === 0) continue;
      legacyTurns.push({ role: role, text: text, codeBlocks: codeBlocks });
    }

    if (legacyTurns.length === 0) {
      console.warn('[Context Handoff] Turn elements found but all were empty after extraction.');
      return null;
    }

    return {
      source: 'claude.ai',
      title: title,
      capturedAt: new Date().toISOString(),
      url: window.location.href,
      turns: legacyTurns,
    };
  }

  function debugDOM() {
    var report = [];
    try {
      // 1. Check if main exists
      var main = document.querySelector('main');
      report.push('main exists: ' + (!!main));
      if (main) {
        report.push('main classes: ' + main.className);
        report.push('main children count: ' + main.children.length);
        for (var i = 0; i < Math.min(main.children.length, 5); i++) {
          var child = main.children[i];
          report.push('  child ' + i + ': ' + child.tagName + ' class="' + child.className + '" testid="' + child.getAttribute('data-testid') + '"');
        }
      }

      // 2. Look for any data-testid elements on the page
      var testidEls = document.querySelectorAll('[data-testid]');
      report.push('Total elements with data-testid: ' + testidEls.length);
      var uniqueTestIds = {};
      testidEls.forEach(function(el) {
        uniqueTestIds[el.getAttribute('data-testid')] = true;
      });
      report.push('Unique data-testids found: ' + Object.keys(uniqueTestIds).slice(0, 30).join(', '));

      // 3. Search for potential turn elements containing "feedback", "thumbs", or "copy"
      var copyBtns = document.querySelectorAll('button');
      var btnLabels = [];
      copyBtns.forEach(function(btn) {
        var label = btn.getAttribute('aria-label') || btn.getAttribute('data-testid') || btn.textContent.trim();
        if (label && (label.toLowerCase().includes('feedback') || label.toLowerCase().includes('thumbs') || label.toLowerCase().includes('copy') || label.toLowerCase().includes('share'))) {
          btnLabels.push(label + ' (' + btn.className + ')');
        }
      });
      report.push('Buttons with indicators: ' + btnLabels.slice(0, 10).join('; '));

      // 4. Look for divs with classes that might be conversation items
      var divs = document.querySelectorAll('div');
      var potentialDivs = [];
      divs.forEach(function(d) {
        var cls = d.className || '';
        if (typeof cls === 'string' && (cls.includes('ConversationItem') || cls.includes('message') || cls.includes('chat-content') || cls.includes('conversation-content'))) {
          potentialDivs.push(d.tagName + '.' + cls.split(' ').join('.'));
        }
      });
      report.push('Potential conversation divs: ' + potentialDivs.slice(0, 10).join('; '));
    } catch (e) {
      report.push('Error during debugDOM: ' + e.message);
    }
    return report.join('\n');
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
          var debugInfo = debugDOM();
          console.warn('[Context Handoff] Scrape failed. DOM Report:\n', debugInfo);
          sendResponse({
            ok: false,
            error: 'No conversation found.\n\nDOM Report:\n' + debugInfo,
          });
        }
      } catch (err) {
        console.error('[Context Handoff] Scrape error:', err);
        sendResponse({ ok: false, error: err.message });
      }
      return true; // keep message channel open (required for async sendResponse)
    }

    // Phase 2: handle LIMIT_CHECK action (internal — see limit detection below)
  });

  // ── Limit detection (Phase 2) ──────────────────────────────────────────────
  //
  // Layer 1: phrase matching against limit-signals (from storage or bundled JSON).
  // Layer 2: chat input becomes disabled AND a new banner/block appears in same tick.
  // Layer 3: Layer 2 fires without Layer 1 → log banner text for user review in Options.
  //
  // Fires at most once per page load to avoid notification spam.

  var limitFired   = false;
  var limitPhrases = [];

  var INPUT_SELS = [
    '[data-testid="chat-input"]',
    'div[contenteditable="true"]',
    'textarea',
  ];

  function isInputDisabled() {
    for (var s = 0; s < INPUT_SELS.length; s++) {
      var el = document.querySelector(INPUT_SELS[s]);
      if (el) {
        return el.disabled === true ||
               el.getAttribute('aria-disabled') === 'true' ||
               el.getAttribute('contenteditable') === 'false';
      }
    }
    return false;
  }

  function extractNodeText(node) {
    try { return (node.innerText || node.textContent || '').trim(); } catch (e) { return ''; }
  }

  function checkPhrases(text) {
    var lower = text.toLowerCase();
    for (var i = 0; i < limitPhrases.length; i++) {
      if (lower.indexOf(limitPhrases[i].toLowerCase()) !== -1) return limitPhrases[i];
    }
    return null;
  }

  function fireLimitDetected(phrase, bannerText) {
    if (limitFired) return;
    limitFired = true;
    chrome.runtime.sendMessage({ action: 'LIMIT_DETECTED', phrase: phrase || null, url: window.location.href });
    if (!phrase && bannerText) {
      chrome.runtime.sendMessage({
        action: 'UNRECOGNIZED_BANNER',
        text: bannerText.slice(0, 500),
        url: window.location.href,
        timestamp: new Date().toISOString(),
      });
    }
  }

  function setupLimitObserver() {
    var observer = new MutationObserver(function (mutations) {
      if (limitFired) return;
      var addedTexts = [];
      var hasNewBlock = false;
      for (var m = 0; m < mutations.length; m++) {
        var nodes = mutations[m].addedNodes;
        for (var n = 0; n < nodes.length; n++) {
          if (nodes[n].nodeType !== Node.ELEMENT_NODE) continue;
          var t = extractNodeText(nodes[n]);
          if (t.length > 10) { addedTexts.push(t); hasNewBlock = true; }
        }
      }
      if (!addedTexts.length) return;
      var allText = addedTexts.join(' ');
      // Layer 1: phrase match
      var matched = checkPhrases(allText);
      if (matched) { fireLimitDetected(matched, null); return; }
      // Layer 2: input disabled + new block
      if (hasNewBlock && isInputDisabled()) { fireLimitDetected(null, allText); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function loadLimitPhrases(callback) {
    chrome.storage.local.get(['limitPhrases', 'autoDetectEnabled'], function (result) {
      if (result.autoDetectEnabled === false) return;
      if (result.limitPhrases && result.limitPhrases.length > 0) {
        limitPhrases = result.limitPhrases;
        callback();
      } else {
        fetch(chrome.runtime.getURL('config/limit-signals.json'))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            limitPhrases = data.phrases || [];
            chrome.storage.local.set({ limitPhrases: limitPhrases });
            callback();
          })
          .catch(function () { callback(); });
      }
    });
  }

  if (window.location.pathname.startsWith('/chat/')) {
    loadLimitPhrases(setupLimitObserver);
  }

  console.log('[Context Handoff] claude.js loaded on', window.location.href);

})();

