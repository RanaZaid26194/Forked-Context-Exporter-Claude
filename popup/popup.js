// popup/popup.js
// Handles the Context Handoff popup UI.
//
// Phase 1: "Export Full Transcript" — scrapes the active Claude tab,
// formats to Markdown, copies to clipboard, and offers a .md file download.
//
// Requires lib/formatter.js to be loaded first via popup.html <script> tags.

'use strict';

document.addEventListener('DOMContentLoaded', function () {

  // ── Element refs ────────────────────────────────────────────────────────────
  var exportBtn     = document.getElementById('exportTranscriptBtn');
  var statusDot     = document.getElementById('statusDot');
  var statusLabel   = document.getElementById('statusLabel');
  var toastEl       = document.getElementById('toast');
  var toastMsg      = document.getElementById('toastMsg');
  var metaEl        = document.getElementById('convMeta');
  var optionsLink   = document.getElementById('optionsLink');

  var toastTimer = null;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function setStatus(type, text) {
    // type: 'idle' | 'ready' | 'loading' | 'success' | 'error' | 'warning'
    statusDot.dataset.status = type;
    statusLabel.textContent = text;
  }

  function showToast(text, type) {
    // type: 'success' | 'error'
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

  // ── Init: detect current tab ─────────────────────────────────────────────────

  var activeTab = null;

  (async function init() {
    setStatus('loading', 'Checking tab…');

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tabs[0];

    if (!activeTab || !activeTab.url) {
      setStatus('error', 'No active tab');
      exportBtn.disabled = true;
      return;
    }

    if (!activeTab.url.startsWith('https://claude.ai/')) {
      setStatus('warning', 'Open a Claude.ai conversation');
      exportBtn.disabled = true;
      setMeta('Navigate to claude.ai and open a conversation.');
      return;
    }

    // Ping content script to confirm it's injected and ready
    try {
      var pong = await sendToTab(activeTab.id, { action: 'PING' });
      if (pong && pong.ok) {
        setStatus('ready', 'Ready to export');
        exportBtn.disabled = false;
      } else {
        throw new Error('Bad pong');
      }
    } catch (e) {
      setStatus('warning', 'Reload the Claude page');
      setMeta('The content script isn\'t responding. Reload the page and reopen this popup.');
      exportBtn.disabled = true;
    }
  })();

  // ── Export button ─────────────────────────────────────────────────────────────

  exportBtn.addEventListener('click', async function () {
    if (!activeTab) return;

    exportBtn.disabled = true;
    exportBtn.classList.add('loading');
    setStatus('loading', 'Scraping conversation…');
    setMeta('');

    try {
      var response = await sendToTab(activeTab.id, { action: 'GET_CONVERSATION' });

      if (!response || !response.ok || !response.conversation) {
        throw new Error(
          (response && response.error) ||
          'No conversation data. Make sure you\'re on a conversation page, not the home screen.'
        );
      }

      var conversation = response.conversation;
      console.log('[CH-DEBUG-POPUP] turns received:', conversation.turns.length,
        '| roles:', conversation.turns.map(function(t) { return t.role; }).join(','));
      var markdown = window.ContextHandoff.toMarkdown(conversation);
      console.log('[CH-DEBUG-POPUP] markdown length:', markdown.length,
        '| has "### Claude":', markdown.indexOf('### Claude') !== -1,
        '| "### You" count:', (markdown.match(/### You/g) || []).length,
        '| "### Claude" count:', (markdown.match(/### Claude/g) || []).length);

      if (!markdown) throw new Error('Formatter returned empty output.');

      // ── Clipboard ──────────────────────────────────────────────────────────
      try {
        await navigator.clipboard.writeText(markdown);
      } catch (clipErr) {
        console.warn('[Context Handoff] Clipboard write failed:', clipErr);
        // Non-fatal — download still proceeds
      }

      // ── Download .md file ──────────────────────────────────────────────────
      var filename = window.ContextHandoff.safeFilename(conversation.title) + '.md';
      var blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      var blobUrl = URL.createObjectURL(blob);

      await chrome.downloads.download({
        url: blobUrl,
        filename: filename,
        saveAs: false,
      });

      // Revoke blob URL after a short delay so Chrome finishes reading it
      setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 10000);

      // ── Success feedback ───────────────────────────────────────────────────
      var turnCount = conversation.turns.length;
      setStatus('success', turnCount + ' turns exported');
      setMeta('"' + conversation.title + '" → ' + filename);
      showToast('Copied to clipboard + downloaded as ' + filename, 'success');

    } catch (err) {
      console.error('[Context Handoff] Export error:', err);
      setStatus('error', 'Export failed');
      setMeta(err.message);
      showToast(err.message, 'error');
    } finally {
      exportBtn.disabled = false;
      exportBtn.classList.remove('loading');
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
