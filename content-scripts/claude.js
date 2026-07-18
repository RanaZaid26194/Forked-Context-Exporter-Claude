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

  // Selectors for the logout flow — avatar menu first, then the logout item.
  // Same deal as the scraper selectors: if Anthropic refactors their nav,
  // add the new selector to the front of the array and the old one stays as fallback.
  var NAV_SEL = {

    // The clickable avatar / user-menu trigger in the sidebar.
    // best-effort selectors, verify against live DOM
    avatarBtn: [
      'button[data-testid="user-menu-trigger"]',
      'button[aria-label="Open user menu"]',
      'button[aria-label="User menu"]',
      '[data-testid="user-menu-button"]',
      'nav button[class*="avatar"]',
    ],

    // The logout item inside the dropdown that appears after clicking the avatar.
    // best-effort selectors, verify against live DOM
    logoutItem: [
      'button[data-testid="logout"]',
      '[role="menuitem"][data-testid="logout"]',
      'button[aria-label="Log out"]',
      '[role="menuitem"]',   // last-resort: grab all menuitems and find one whose text matches
    ],

    // Something that only exists when the user is properly logged in.
    // If any of these are found we consider the session authenticated.
    // best-effort selectors, verify against live DOM
    authIndicator: [
      '[data-testid="user-menu-trigger"]',
      '[data-testid="new-chat-button"]',
      'nav[aria-label="Sidebar"]',
      'button[aria-label="Open user menu"]',
    ],

    // The chat input — used by FILL_INPUT.
    // Matches what limit detection already uses in INPUT_SELS below.
    chatInput: [
      '[data-testid="chat-input"]',
      'div[contenteditable="true"]',
      'textarea',
    ],

    // "Continue with Google" button on the Claude login page.
    // Confirmed via live DOM (Jun 2026): the button has data-testid="login-with-google".
    // That goes first. Text-content scan is the fallback in case Anthropic ever
    // removes the testid — it picks the shortest element whose visible text
    // contains "google", which is always the sign-in button.
    googleSignInBtn: [
      '[data-testid="login-with-google"]',
      'button[data-testid="login-with-google"]',
    ],

  };

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
    var firstUserMsg = document.querySelector('[data-testid="user-message"]');
    var firstFeedbackBtn = null;
    for (var fb = 0; fb < SEL.feedbackButtons.length; fb++) {
      try {
        firstFeedbackBtn = document.querySelector(SEL.feedbackButtons[fb]);
        if (firstFeedbackBtn) break;
      } catch (e) { /* */ }
    }

    if (firstUserMsg && firstFeedbackBtn) {
      var userAncestors = new Set();
      var node = firstUserMsg;
      while (node) {
        userAncestors.add(node);
        node = node.parentElement;
      }
      var container = firstFeedbackBtn.parentElement;
      while (container && !userAncestors.has(container)) {
        container = container.parentElement;
      }

      if (container && container.children.length >= 2) {
        var classifiedEls = [];
        var children = Array.from(container.children);
        for (var c = 0; c < children.length; c++) {
          var child = children[c];
          if (child.querySelector('[data-testid="user-message"]') || child.getAttribute('data-testid') === 'user-message') {
            classifiedEls.push({ el: child, role: 'user' });
            continue;
          }
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

      var testidEls = document.querySelectorAll('[data-testid]');
      report.push('Total elements with data-testid: ' + testidEls.length);
      var uniqueTestIds = {};
      testidEls.forEach(function(el) {
        uniqueTestIds[el.getAttribute('data-testid')] = true;
      });
      report.push('Unique data-testids found: ' + Object.keys(uniqueTestIds).slice(0, 30).join(', '));

      var copyBtns = document.querySelectorAll('button');
      var btnLabels = [];
      copyBtns.forEach(function(btn) {
        var label = btn.getAttribute('aria-label') || btn.getAttribute('data-testid') || btn.textContent.trim();
        if (label && (label.toLowerCase().includes('feedback') || label.toLowerCase().includes('thumbs') || label.toLowerCase().includes('copy') || label.toLowerCase().includes('share'))) {
          btnLabels.push(label + ' (' + btn.className + ')');
        }
      });
      report.push('Buttons with indicators: ' + btnLabels.slice(0, 10).join('; '));

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

  // ── findChatInput helper ──────────────────────────────────────────────────
  // Shared by FILL_INPUT — re-queries fresh each time so robustFill's
  // retry loop always sees the latest DOM state.
  function findChatInput() {
    for (var i = 0; i < NAV_SEL.chatInput.length; i++) {
      try {
        var el = document.querySelector(NAV_SEL.chatInput[i]);
        if (el) return el;
      } catch (e) { /* invalid selector */ }
    }
    return null;
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
      return true;
    }

    // ── FILL_INPUT ─────────────────────────────────────────────────────────────
    // Paste the handoff prompt into the chat input using the shared robustFill
    // helper (same as chatgpt.js / gemini.js / grok.js). Falls back to
    // clipboard-only if we can't find or set the input.

    if (message.action === 'FILL_INPUT') {
      var text = message.text || '';
      if (!text) {
        sendResponse({ ok: false, error: 'No text provided to fill.' });
        return true;
      }

      // Wait up to 10 s for the input to appear (claude.ai/new needs a moment to hydrate)
      var fillMaxWait = 10000;
      var fillStart   = Date.now();

      function tryFill() {
        var result = window.ContextHandoff.robustFill(findChatInput, text);
        if (result.ok) {
          sendResponse({ ok: true, strategy: result.strategy });
          return;
        }

        if (Date.now() - fillStart < fillMaxWait) {
          setTimeout(tryFill, 200);
        } else {
          console.warn('[Context Handoff] FILL_INPUT: could not fill chat input within timeout.');
          try { navigator.clipboard.writeText(text).catch(function() {}); } catch (e) {}
          sendResponse({ ok: false, clipboardFallback: true });
        }
      }

      // Short initial delay — claude.ai/new finishes React hydration a beat
      // after document_idle fires, so the input may not exist yet.
      setTimeout(tryFill, 200);
      return true; // keep message channel open for async sendResponse
    }

    // ── LOGOUT ─────────────────────────────────────────────────────────────────
    // Clicks through the avatar menu → logout item.
    // We wait up to 3 s for the dropdown to appear after clicking the avatar,
    // then scan menuitems for one whose text contains "log out" / "sign out".

    if (message.action === 'LOGOUT') {
      (function () {
        var avatarEl = null;
        for (var ai = 0; ai < NAV_SEL.avatarBtn.length; ai++) {
          avatarEl = document.querySelector(NAV_SEL.avatarBtn[ai]);
          if (avatarEl) break;
        }

        if (!avatarEl) {
          console.warn('[Context Handoff] LOGOUT: could not find avatar/menu button.');
          sendResponse({ ok: false, error: 'Could not find user menu button.' });
          return;
        }

        avatarEl.click();

        var waited  = 0;
        var maxWait = 3000;
        var tick    = 100;

        var poll = setInterval(function () {
          waited += tick;

          // Try specific selectors first
          var logoutEl = null;
          for (var li = 0; li < NAV_SEL.logoutItem.length - 1; li++) {
            logoutEl = document.querySelector(NAV_SEL.logoutItem[li]);
            if (logoutEl) break;
          }

          // Last resort: find any menuitem whose text matches "log out" / "sign out"
          if (!logoutEl) {
            var allItems = document.querySelectorAll('[role="menuitem"]');
            for (var mi = 0; mi < allItems.length; mi++) {
              var itemText = (allItems[mi].textContent || '').toLowerCase();
              if (itemText.indexOf('log out') !== -1 || itemText.indexOf('sign out') !== -1) {
                logoutEl = allItems[mi];
                break;
              }
            }
          }

          if (logoutEl) {
            clearInterval(poll);
            logoutEl.click();
            sendResponse({ ok: true });
            return;
          }

          if (waited >= maxWait) {
            clearInterval(poll);
            console.warn('[Context Handoff] LOGOUT: menu appeared but no logout item found within timeout.');
            sendResponse({ ok: false, error: 'Logout item not found in menu.' });
          }
        }, tick);
      })();

      return true; // async sendResponse
    }

    // ── CLICK_GOOGLE_SIGNIN ────────────────────────────────────────────────────
    // After logout, the login page appears. This handler finds the
    // "Continue with Google" / "Sign in with Google" button and clicks it,
    // so the user only has to pick their account in the Google popup.
    // Polls for up to 8 s since the login page may still be loading.

    if (message.action === 'CLICK_GOOGLE_SIGNIN') {
      var gsWaited  = 0;
      var gsMaxWait = 8000;
      var gsTick    = 150;

      var gsPoll = setInterval(function () {
        gsWaited += gsTick;

        var btnEl = null;

        // Primary: data-testid="login-with-google" — confirmed via live DOM
        // inspection on claude.ai/login (Jun 2026). Most reliable, unambiguous.
        for (var gi = 0; gi < NAV_SEL.googleSignInBtn.length; gi++) {
          try {
            var candidate = document.querySelector(NAV_SEL.googleSignInBtn[gi]);
            if (candidate) { btnEl = candidate; break; }
          } catch (e) { /* invalid selector, skip */ }
        }

        // Fallback: text-content scan — finds the shortest element whose visible
        // text contains "google". Handles Anthropic removing the testid attribute.
        if (!btnEl) {
          var allClickable = document.querySelectorAll('button, [role="button"]');
          var bestLen      = Infinity;
          for (var bi = 0; bi < allClickable.length; bi++) {
            var elText = (allClickable[bi].textContent || '').trim().toLowerCase();
            if (elText.indexOf('google') !== -1 && elText.length < 60 && elText.length < bestLen) {
              bestLen = elText.length;
              btnEl   = allClickable[bi];
            }
          }
        }

        if (btnEl) {
          clearInterval(gsPoll);
          btnEl.focus();
          btnEl.click();
          sendResponse({ ok: true });
          return;
        }

        if (gsWaited >= gsMaxWait) {
          clearInterval(gsPoll);
          // Non-fatal — user just has to click the Google button manually
          console.warn('[Context Handoff] CLICK_GOOGLE_SIGNIN: button not found within timeout.');
          sendResponse({ ok: false, error: 'Google sign-in button not found — click it manually.' });
        }
      }, gsTick);

      return true; // async sendResponse
    }

    // ── CHECK_LOGGED_IN ────────────────────────────────────────────────────────
    // Popup polls this after the user picks their new account on the Google
    // auth screen. Returns true once the sidebar / nav reappears — that's our
    // signal that the new session is live and we're safe to navigate to /new.

    if (message.action === 'CHECK_LOGGED_IN') {
      try {
        var loggedIn = false;
        for (var ci = 0; ci < NAV_SEL.authIndicator.length; ci++) {
          if (document.querySelector(NAV_SEL.authIndicator[ci])) {
            loggedIn = true;
            break;
          }
        }
        sendResponse({ ok: true, loggedIn: loggedIn });
      } catch (err) {
        sendResponse({ ok: false, loggedIn: false, error: err.message });
      }
      return true;
    }

  });

  // ── Limit detection (Phase 2) ──────────────────────────────────────────────

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
      var matched = checkPhrases(allText);
      if (matched) { fireLimitDetected(matched, null); return; }
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