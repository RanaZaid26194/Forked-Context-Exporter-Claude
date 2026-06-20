// popup/popup.js
// Context Handoff popup — Phase 2
//
// Three export modes:
//   1. Handoff Prompt  (primary) — scrape + summarize → toHandoffPrompt()
//   2. Export Summary  (secondary) — scrape + summarize → toSummaryMarkdown()
//   3. Full Transcript (secondary) — scrape → toMarkdown()
//
// Requires lib/formatter.js + lib/summarizer.js loaded first via popup.html.

'use strict';

document.addEventListener('DOMContentLoaded', function () {

  // ── Element refs ─────────────────────────────────────────────────────────────
  var exportHandoffBtn  = document.getElementById('exportHandoffBtn');
  var exportSummaryBtn  = document.getElementById('exportSummaryBtn');
  var exportTranscriptBtn = document.getElementById('exportTranscriptBtn');
  var statusDot   = document.getElementById('statusDot');
  var statusLabel = document.getElementById('statusLabel');
  var toastEl     = document.getElementById('toast');
  var toastMsg    = document.getElementById('toastMsg');
  var metaEl      = document.getElementById('convMeta');
  var optionsLink = document.getElementById('optionsLink');

  var toastTimer = null;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function setStatus(type, text) {
    statusDot.dataset.status = type;
    statusLabel.textContent = text;
  }

  function showToast(text, type) {
    toastMsg.textContent = text;
    toastEl.dataset.type = type || 'success';
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('visible');
    }, 4000);
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

  function setAllBtnsDisabled(disabled) {
    exportHandoffBtn.disabled    = disabled;
    exportSummaryBtn.disabled    = disabled;
    exportTranscriptBtn.disabled = disabled;
  }

  function setLoading(btn, loading) {
    btn.disabled = loading;
    if (loading) {
      btn.classList.add('loading');
    } else {
      btn.classList.remove('loading');
    }
  }

  /**
   * Shared scrape helper. Sends GET_CONVERSATION to the active tab.
   * Returns the normalized conversation object or throws.
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
   * Write text to clipboard and trigger a file download.
   */
  async function clipboardAndDownload(text, filename) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.warn('[Context Handoff] Clipboard write failed:', e);
    }
    var blob   = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url    = URL.createObjectURL(blob);
    await chrome.downloads.download({ url: url, filename: filename, saveAs: false });
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  // ── Init: detect current tab ──────────────────────────────────────────────────

  var activeTab = null;

  (async function init() {
    setStatus('loading', 'Checking tab…');

    // Tell the background to clear the limit-detection badge now that the popup is open
    try { chrome.runtime.sendMessage({ action: 'POPUP_OPENED' }); } catch (e) { /* */ }

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];

    if (!activeTab || !activeTab.url) {
      setStatus('error', 'No active tab');
      setAllBtnsDisabled(true);
      return;
    }

    if (!activeTab.url.startsWith('https://claude.ai/')) {
      setStatus('warning', 'Open a Claude.ai conversation');
      setAllBtnsDisabled(true);
      setMeta('Navigate to claude.ai and open a conversation.');
      return;
    }

    try {
      var pong = await sendToTab(activeTab.id, { action: 'PING' });
      if (pong && pong.ok) {
        setStatus('ready', 'Ready to export');
        setAllBtnsDisabled(false);
      } else {
        throw new Error('Bad pong');
      }
    } catch (e) {
      setStatus('warning', 'Reload the Claude page');
      setMeta('The content script isn\'t responding. Reload the page and reopen this popup.');
      setAllBtnsDisabled(true);
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

      var filename = window.ContextHandoff.safeFilename(conversation.title) + '-handoff.md';
      await clipboardAndDownload(text, filename);

      var turnCount = conversation.turns.length;
      setStatus('success', turnCount + ' turns exported');
      setMeta('"' + conversation.title + '" → ' + filename);
      showToast('Handoff prompt copied + downloaded as ' + filename, 'success');

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

  // ── Options link ──────────────────────────────────────────────────────────────

  if (optionsLink) {
    optionsLink.addEventListener('click', function (e) {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }

});
