// popup/popup.js
// Context Handoff popup — Phase 3 (final)
//
// Four export modes:
//   1. Handoff Prompt  (primary) — scrape + summarize → toHandoffPrompt()
//   2. Export Summary  (secondary) — scrape + summarize → toSummaryMarkdown()
//   3. Full Transcript (secondary) — scrape → toMarkdown()
//   4. Send to ChatGPT (enabled once handoff prompt has been generated)
//
// Requires lib/formatter.js + lib/summarizer.js loaded first via popup.html.

'use strict';

document.addEventListener('DOMContentLoaded', function () {

  // ── Element refs ─────────────────────────────────────────────────────────────
  var exportHandoffBtn    = document.getElementById('exportHandoffBtn');
  var exportSummaryBtn    = document.getElementById('exportSummaryBtn');
  var exportTranscriptBtn = document.getElementById('exportTranscriptBtn');
  var sendToGPTBtn        = document.getElementById('sendToGPTBtn');
  var statusDot    = document.getElementById('statusDot');
  var statusLabel  = document.getElementById('statusLabel');
  var toastEl      = document.getElementById('toast');
  var toastMsg     = document.getElementById('toastMsg');
  var metaEl       = document.getElementById('convMeta');
  var optionsLink  = document.getElementById('optionsLink');

  var toastTimer = null;

  // The most recently generated handoff prompt text — stored so "Send to ChatGPT"
  // can use it without re-scraping.
  var lastHandoffText = null;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function setStatus(type, text) {
    statusDot.dataset.status = type;
    statusLabel.textContent = text;
  }

  function showToast(text, type) {
    toastMsg.textContent = text;
    toastEl.dataset.type = type || 'success';
    // Update icon to match type
    var iconEl = document.querySelector('.toast-icon');
    if (iconEl) iconEl.textContent = (type === 'error') ? '✗' : (type === 'warning') ? '⚠' : '✓';
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('visible');
    }, 5000);
  }

  function setMeta(text) {
    metaEl.textContent = text || '';
  }

  function sendToTab(tabId, message) {
    return new Promise(function (resolve, reject) {
      chrome.tabs.sendMessage(tabId, message, function (response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  function setExportBtnsDisabled(disabled) {
    exportHandoffBtn.disabled    = disabled;
    exportSummaryBtn.disabled    = disabled;
    exportTranscriptBtn.disabled = disabled;
    // sendToGPTBtn stays disabled until handoff text exists
  }

  function setLoading(btn, loading) {
    btn.disabled = loading;
    btn.classList.toggle('loading', loading);
  }

  /**
   * Shared scrape helper — sends GET_CONVERSATION to the active tab.
   */
  async function scrape(tabId) {
    var response = await sendToTab(tabId, { action: 'GET_CONVERSATION' });
    if (!response || !response.ok || !response.conversation) {
      throw new Error(
        (response && response.error) ||
        'No conversation data. Make sure you\'re on a conversation page, not the home screen.'
      );
    }
    return response.conversation;
  }

  /**
   * Write text to clipboard and trigger a .md file download.
   */
  async function clipboardAndDownload(text, filename) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.warn('[Context Handoff] Clipboard write failed:', e);
    }
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url  = URL.createObjectURL(blob);
    await chrome.downloads.download({ url: url, filename: filename, saveAs: false });
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  // ── Init: detect current tab ──────────────────────────────────────────────────

  var activeTab = null;

  (async function init() {
    setStatus('loading', 'Checking tab…');

    // Clear limit-detection badge now that popup is open
    try { chrome.runtime.sendMessage({ action: 'POPUP_OPENED' }); } catch (e) { /* */ }

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];

    if (!activeTab || !activeTab.url) {
      setStatus('error', 'No active tab');
      setExportBtnsDisabled(true);
      return;
    }

    if (!activeTab.url.startsWith('https://claude.ai/')) {
      setStatus('warning', 'Open a Claude.ai conversation');
      setExportBtnsDisabled(true);
      setMeta('Navigate to claude.ai and open a conversation.');
      return;
    }

    try {
      var pong = await sendToTab(activeTab.id, { action: 'PING' });
      if (pong && pong.ok) {
        setStatus('ready', 'Ready to export');
        setExportBtnsDisabled(false);
      } else {
        throw new Error('Bad pong');
      }
    } catch (e) {
      setStatus('warning', 'Reload the Claude page');
      setMeta('The content script isn\'t responding. Reload the page and reopen this popup.');
      setExportBtnsDisabled(true);
    }
  })();

  // ── Export: Handoff Prompt (primary) ─────────────────────────────────────────

  exportHandoffBtn.addEventListener('click', async function () {
    if (!activeTab) return;
    setLoading(exportHandoffBtn, true);
    setStatus('loading', 'Building handoff…');
    setMeta('');

    try {
      var conversation = await scrape(activeTab.id);
      var summary      = window.ContextHandoff.summarize(conversation);
      var text         = window.ContextHandoff.toHandoffPrompt(conversation, summary);
      if (!text) throw new Error('Handoff prompt generation returned empty output.');

      // Store for "Send to ChatGPT"
      lastHandoffText = text;
      sendToGPTBtn.disabled = false;
      var gptHint = document.getElementById('gptHint');
      if (gptHint) gptHint.textContent = 'Ready — click to fill ChatGPT';

      // Fire the teal glow animation to draw the eye to the now-active button
      sendToGPTBtn.classList.remove('just-activated');
      void sendToGPTBtn.offsetWidth; // force reflow to restart animation
      sendToGPTBtn.classList.add('just-activated');
      setTimeout(function() { sendToGPTBtn.classList.remove('just-activated'); }, 600);

      var filename = window.ContextHandoff.safeFilename(conversation.title) + '-handoff.md';
      await clipboardAndDownload(text, filename);

      var turnCount = conversation.turns.length;
      setStatus('success', turnCount + ' turns exported — handoff ready');
      setMeta('"' + conversation.title + '" → ' + filename);
      // No toast here: the button activation and status line are the feedback.
      // A toast would compete for space with the button that just became available.

    } catch (err) {
      console.error('[Context Handoff] Handoff export error:', err);
      setStatus('error', 'Export failed');
      setMeta(err.message);
      showToast(err.message, 'error');
    } finally {
      setLoading(exportHandoffBtn, false);
    }
  });

  // ── Export: Summary ───────────────────────────────────────────────────────────

  exportSummaryBtn.addEventListener('click', async function () {
    if (!activeTab) return;
    setLoading(exportSummaryBtn, true);
    setStatus('loading', 'Summarising…');
    setMeta('');

    try {
      var conversation = await scrape(activeTab.id);
      var summary      = window.ContextHandoff.summarize(conversation);
      var text         = window.ContextHandoff.toSummaryMarkdown(summary, conversation);
      if (!text) throw new Error('Summary generation returned empty output.');

      var filename = window.ContextHandoff.safeFilename(conversation.title) + '-summary.md';
      await clipboardAndDownload(text, filename);

      setStatus('success', 'Summary exported');
      setMeta('"' + conversation.title + '" → ' + filename);
      showToast('Summary copied + downloaded as ' + filename, 'success');

    } catch (err) {
      console.error('[Context Handoff] Summary export error:', err);
      setStatus('error', 'Export failed');
      setMeta(err.message);
      showToast(err.message, 'error');
    } finally {
      setLoading(exportSummaryBtn, false);
    }
  });

  // ── Export: Full Transcript ───────────────────────────────────────────────────

  exportTranscriptBtn.addEventListener('click', async function () {
    if (!activeTab) return;
    setLoading(exportTranscriptBtn, true);
    setStatus('loading', 'Scraping conversation…');
    setMeta('');

    try {
      var conversation = await scrape(activeTab.id);
      var text         = window.ContextHandoff.toMarkdown(conversation);
      if (!text) throw new Error('Formatter returned empty output.');

      var filename = window.ContextHandoff.safeFilename(conversation.title) + '.md';
      await clipboardAndDownload(text, filename);

      var turnCount = conversation.turns.length;
      setStatus('success', turnCount + ' turns exported');
      setMeta('"' + conversation.title + '" → ' + filename);
      showToast('Transcript copied + downloaded as ' + filename, 'success');

    } catch (err) {
      console.error('[Context Handoff] Transcript export error:', err);
      setStatus('error', 'Export failed');
      setMeta(err.message);
      showToast(err.message, 'error');
    } finally {
      setLoading(exportTranscriptBtn, false);
    }
  });

  // ── Send to ChatGPT ───────────────────────────────────────────────────────────

  sendToGPTBtn.addEventListener('click', async function () {
    if (!lastHandoffText) return;

    setLoading(sendToGPTBtn, true);
    setStatus('loading', 'Opening ChatGPT…');

    try {
      // Store the handoff text in chrome.storage.session (cleared on browser restart)
      // so chatgpt.js can read it after the tab loads.
      await new Promise(function (resolve) {
        chrome.storage.local.set({ pendingHandoff: lastHandoffText }, resolve);
      });

      // Find an existing ChatGPT tab or create one
      var gptTabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
      var gptTab;

      if (gptTabs.length > 0) {
        gptTab = gptTabs[0];
        await chrome.tabs.update(gptTab.id, { active: true });
        // Bring its window to front
        await chrome.windows.update(gptTab.windowId, { focused: true });
      } else {
        gptTab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: true });
      }

      setStatus('loading', 'Waiting for ChatGPT input…');

      // Poll until the content script is ready (tab may still be loading)
      var gptTabId = gptTab.id;
      var maxWait  = 15000;
      var interval = 500;
      var elapsed  = 0;
      var pongOk   = false;

      while (elapsed < maxWait) {
        await new Promise(function (r) { setTimeout(r, interval); });
        elapsed += interval;
        try {
          var pong = await sendToTab(gptTabId, { action: 'PING' });
          if (pong && pong.ok) { pongOk = true; break; }
        } catch (e) { /* tab still loading */ }
      }

      if (!pongOk) {
        throw new Error('ChatGPT tab took too long to load. Try again once it\'s fully loaded.');
      }

      // Ask chatgpt.js to fill the input
      var fillResp = await sendToTab(gptTabId, { action: 'FILL_INPUT', text: lastHandoffText });

      if (fillResp && fillResp.ok) {
        setStatus('success', 'Filled — review and press Enter');
        setMeta('ChatGPT input ready. Review and send manually.');
        showToast('ChatGPT input filled — review and press Enter to send.', 'success');
      } else if (fillResp && fillResp.clipboardFallback) {
        // chatgpt.js already tried clipboard
        setStatus('warning', 'Couldn\'t auto-fill — check clipboard');
        setMeta('Auto-fill failed. Handoff prompt is in your clipboard — paste manually.');
        showToast('Couldn\'t auto-fill ChatGPT input — copied to clipboard, paste manually.', 'error');
      } else {
        throw new Error((fillResp && fillResp.error) || 'Fill failed with unknown error.');
      }

    } catch (err) {
      console.error('[Context Handoff] Send to ChatGPT error:', err);
      // Last-resort clipboard fallback
      try { await navigator.clipboard.writeText(lastHandoffText); } catch (e) {}
      setStatus('error', 'Auto-fill failed');
      setMeta(err.message);
      showToast('Couldn\'t auto-fill — copied to clipboard, paste manually.', 'error');
    } finally {
      setLoading(sendToGPTBtn, false);
    }
  });

  // ── Options link ──────────────────────────────────────────────────────────────

  if (optionsLink) {
    optionsLink.addEventListener('click', function (e) {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }

});
