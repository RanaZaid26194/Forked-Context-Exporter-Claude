// popup/popup.js
// Context Handoff popup — Phase 4
//
// Four export modes:
//   1. Handoff Prompt  (primary) — scrape + summarize → toHandoffPrompt()
//   2. Export Summary  (secondary) — scrape + summarize → toSummaryMarkdown()
//   3. Full Transcript (secondary) — scrape → toMarkdown()
//   4. Send to ChatGPT / Gemini / Grok / Claude (enabled once handoff prompt
//      has been generated)
//
// Copy/Export preference row:
//   Two checkboxes — "Copy" and "Download" — saved to chrome.storage.local as
//   { copyEnabled, exportEnabled }. Both true by default. Every export click
//   checks the saved preference and only does the action(s) that are enabled.
//
// Claude destination — account-switch flow:
//   Logs out the source tab, optionally auto-clicks "Sign in with Google",
//   waits for the user to authenticate, then navigates to claude.ai/new
//   and fills the handoff prompt. A skipLogoutConfirm preference suppresses
//   the confirmation modal after the user ticks "never ask again".
//
// Requires lib/formatter.js + lib/summarizer.js loaded first via popup.html.

'use strict';

document.addEventListener('DOMContentLoaded', function () {

  // Open a persistent port to the background service worker.
  // Two things this does:
  //   1. Keeps the service worker alive for the duration of the popup session
  //   2. More importantly — keeps THIS popup window alive even when the user
  //      clicks outside it, because Chrome only closes the popup on user
  //      navigation, not while JS is actively running async work.
  // Without this, the popup's JS context is destroyed mid-flow the moment
  // Chrome decides to close it (which happens almost immediately on outside click).
  var _bgPort = chrome.runtime.connect({ name: 'popup-keepalive' });

  // ── Element refs ─────────────────────────────────────────────────────────────
  var exportHandoffBtn    = document.getElementById('exportHandoffBtn');
  var exportSummaryBtn    = document.getElementById('exportSummaryBtn');
  var exportTranscriptBtn = document.getElementById('exportTranscriptBtn');
  var sendToGPTBtn        = document.getElementById('sendToGPTBtn');
  var sendToGeminiBtn     = document.getElementById('sendToGeminiBtn');
  var sendToGrokBtn       = document.getElementById('sendToGrokBtn');
  var sendToClaudeBtn     = document.getElementById('sendToClaudeBtn');
  var copyPrefCheckbox    = document.getElementById('copyPrefCheckbox');
  var exportPrefCheckbox  = document.getElementById('exportPrefCheckbox');
  var statusDot    = document.getElementById('statusDot');
  var statusLabel  = document.getElementById('statusLabel');
  var toastEl      = document.getElementById('toast');
  var toastMsg     = document.getElementById('toastMsg');
  var metaEl       = document.getElementById('convMeta');
  var optionsLink  = document.getElementById('optionsLink');

  // Confirmation modal elements
  var confirmModal       = document.getElementById('confirmModal');
  var confirmProceedBtn  = document.getElementById('confirmProceedBtn');
  var confirmCancelBtn   = document.getElementById('confirmCancelBtn');
  var confirmNeverAgain  = document.getElementById('confirmNeverAgain');

  var toastTimer = null;

  // Copy/Export preference — loaded from storage during init(), defaults to
  // both enabled (matches original behaviour) until storage responds.
  var prefs = {
    copyEnabled:       true,
    exportEnabled:     true,
    autoPasteEnabled:  true,   // controls whether FILL_INPUT is sent to destination tabs
    skipLogoutConfirm: false,
    autoGoogleSignIn:  true,
  };

  // The most recently generated handoff prompt text — stored so destination
  // buttons can use it without re-scraping.
  var lastHandoffText = null;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function setStatus(type, text) {
    statusDot.dataset.status = type;
    statusLabel.textContent = text;
  }

  function showToast(text, type) {
    toastMsg.textContent = text;
    toastEl.dataset.type = type || 'success';
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
    // Handoff destination buttons stay disabled until handoff text exists
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
   * Write text to the clipboard only.
   */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.warn('[Context Handoff] Clipboard write failed:', e);
      return false;
    }
  }

  /**
   * Trigger a .md file download only — no clipboard write.
   */
  async function downloadFile(text, filename) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url  = URL.createObjectURL(blob);
    await chrome.downloads.download({ url: url, filename: filename, saveAs: false });
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  /**
   * Runs copy and/or download based on the saved Copy/Export preference.
   * Returns a small descriptor so callers can tailor their status/toast text.
   */
  async function exportText(text, filename) {
    var didCopy   = false;
    var didExport = false;

    if (prefs.copyEnabled) {
      didCopy = await copyToClipboard(text);
    }
    if (prefs.exportEnabled) {
      await downloadFile(text, filename);
      didExport = true;
    }

    return { didCopy: didCopy, didExport: didExport };
  }

  /**
   * Builds a short human-readable description of what just happened.
   */
  function describeExportResult(result, filename) {
    if (result.didCopy && result.didExport) return 'copied + downloaded as ' + filename;
    if (result.didExport) return 'downloaded as ' + filename;
    if (result.didCopy) return 'copied to clipboard';
    return 'done (copy and download are both off — enable one in the preferences row)';
  }

  /**
   * Load all preferences from storage and reflect them in the UI.
   * Defaults: copyEnabled=true, exportEnabled=true, skipLogoutConfirm=false,
   * autoGoogleSignIn=true.
   */
  async function loadPrefs() {
    try {
      var result = await new Promise(function (resolve) {
        chrome.storage.local.get(
          ['copyEnabled', 'exportEnabled', 'autoPasteEnabled', 'skipLogoutConfirm', 'autoGoogleSignIn'],
          resolve
        );
      });
      prefs.copyEnabled       = (result.copyEnabled       !== undefined) ? result.copyEnabled       : true;
      prefs.exportEnabled     = (result.exportEnabled     !== undefined) ? result.exportEnabled     : true;
      prefs.autoPasteEnabled  = (result.autoPasteEnabled  !== undefined) ? result.autoPasteEnabled  : true;
      prefs.skipLogoutConfirm = (result.skipLogoutConfirm !== undefined) ? result.skipLogoutConfirm : false;
      prefs.autoGoogleSignIn  = (result.autoGoogleSignIn  !== undefined) ? result.autoGoogleSignIn  : true;
    } catch (e) {
      console.warn('[Context Handoff] Failed to load preferences, using defaults:', e);
    }
    copyPrefCheckbox.checked   = prefs.copyEnabled;
    exportPrefCheckbox.checked = prefs.exportEnabled;
  }

  /**
   * Persist all preferences to storage. Fire-and-forget.
   */
  function savePrefs() {
    chrome.storage.local.set({
      copyEnabled:       prefs.copyEnabled,
      exportEnabled:     prefs.exportEnabled,
      autoPasteEnabled:  prefs.autoPasteEnabled,
      skipLogoutConfirm: prefs.skipLogoutConfirm,
      autoGoogleSignIn:  prefs.autoGoogleSignIn,
    });
  }

  // ── Confirmation modal ────────────────────────────────────────────────────────

  /**
   * Show the logout confirmation modal. Returns a Promise that resolves to
   * true (user clicked Continue) or false (user cancelled).
   * If skipLogoutConfirm is already set, resolves to true immediately.
   */
  function askLogoutConfirm() {
    if (prefs.skipLogoutConfirm) return Promise.resolve(true);

    return new Promise(function (resolve) {
      confirmNeverAgain.checked = false;
      confirmModal.classList.add('visible');

      function onProceed() {
        cleanup();
        if (confirmNeverAgain.checked) {
          prefs.skipLogoutConfirm = true;
          savePrefs();
        }
        resolve(true);
      }

      function onCancel() {
        cleanup();
        resolve(false);
      }

      function cleanup() {
        confirmModal.classList.remove('visible');
        confirmProceedBtn.removeEventListener('click', onProceed);
        confirmCancelBtn.removeEventListener('click', onCancel);
      }

      confirmProceedBtn.addEventListener('click', onProceed);
      confirmCancelBtn.addEventListener('click', onCancel);
    });
  }

  // ── Init: detect current tab ──────────────────────────────────────────────────

  var activeTab = null;

  (async function init() {
    setStatus('loading', 'Checking tab…');

    // Clear limit-detection badge now that popup is open
    try { chrome.runtime.sendMessage({ action: 'POPUP_OPENED' }); } catch (e) { /* */ }

    await loadPrefs();

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

  // ── Preference checkboxes ──────────────────────────────────────────────────

  copyPrefCheckbox.addEventListener('change', function () {
    // Both off is not a valid state — revert and tell the user why.
    if (!copyPrefCheckbox.checked && !exportPrefCheckbox.checked) {
      copyPrefCheckbox.checked = true;
      showToast('At least one of Copy or Download must stay enabled.', 'warning');
      return;
    }
    prefs.copyEnabled = copyPrefCheckbox.checked;
    savePrefs();
  });

  exportPrefCheckbox.addEventListener('change', function () {
    if (!exportPrefCheckbox.checked && !copyPrefCheckbox.checked) {
      exportPrefCheckbox.checked = true;
      showToast('At least one of Copy or Download must stay enabled.', 'warning');
      return;
    }
    prefs.exportEnabled = exportPrefCheckbox.checked;
    savePrefs();
  });

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

      // Store for handoff destinations
      lastHandoffText = text;
      chrome.storage.local.set({ pendingHandoff: text });
      sendToGPTBtn.disabled    = false;
      sendToGeminiBtn.disabled = false;
      sendToGrokBtn.disabled   = false;
      sendToClaudeBtn.disabled = false;

      // Fire the glow animations to draw the eye to the now-active buttons
      [sendToGPTBtn, sendToGeminiBtn, sendToGrokBtn, sendToClaudeBtn].forEach(function(btn) {
        btn.classList.remove('just-activated');
        void btn.offsetWidth; // force reflow to restart animation
        btn.classList.add('just-activated');
        setTimeout(function() { btn.classList.remove('just-activated'); }, 600);
      });

      var filename = window.ContextHandoff.safeFilename(conversation.title) + '-handoff.md';
      var result   = await exportText(text, filename);

      var turnCount = conversation.turns.length;
      setStatus('success', turnCount + ' turns exported — handoff ready');
      setMeta('"' + conversation.title + '" → ' + describeExportResult(result, filename));

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
      var result   = await exportText(text, filename);

      setStatus('success', 'Summary exported');
      setMeta('"' + conversation.title + '" → ' + describeExportResult(result, filename));
      showToast('Summary ' + describeExportResult(result, filename), 'success');

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
      var result   = await exportText(text, filename);

      var turnCount = conversation.turns.length;
      setStatus('success', turnCount + ' turns exported');
      setMeta('"' + conversation.title + '" → ' + describeExportResult(result, filename));
      showToast('Transcript ' + describeExportResult(result, filename), 'success');

    } catch (err) {
      console.error('[Context Handoff] Transcript export error:', err);
      setStatus('error', 'Export failed');
      setMeta(err.message);
      showToast(err.message, 'error');
    } finally {
      setLoading(exportTranscriptBtn, false);
    }
  });

  // ── Handoff Destinations ───────────────────────────────────────────────────

  // Fires SEND_TO_SERVICE in background.js and polls storage for status.
  // Background owns ALL tab work — popup just shows progress.
  async function sendToService(btn, queryUrls, launchUrl, urlFragment, name) {
    if (!lastHandoffText) {
      showToast('Generate a handoff prompt first.', 'warning');
      return;
    }
    setLoading(btn, true);
    setStatus('loading', 'Opening ' + name + '\u2026');

    // Clear stale status from previous run
    await new Promise(function (r) { chrome.storage.local.remove('bgStatus', r); });

    await new Promise(function (r) {
      chrome.storage.local.set({ pendingHandoff: lastHandoffText }, r);
    });

    chrome.runtime.sendMessage({
      action:      'SEND_TO_SERVICE',
      name:        name,
      launchUrl:   launchUrl,
      queryUrls:   queryUrls,
      urlFragment: urlFragment,
      text:        lastHandoffText,
      autoPaste:   prefs.autoPasteEnabled,
    });

    // Poll bgStatus — background writes here as it progresses
    var maxPoll = 30000;
    var elapsed = 0;
    while (elapsed < maxPoll) {
      await new Promise(function (r) { setTimeout(r, 700); });
      elapsed += 700;
      var result = await new Promise(function (r) { chrome.storage.local.get(['bgStatus'], r); });
      var st = result.bgStatus;
      if (!st) continue;
      setStatus(st.state, st.label);
      if (st.meta) setMeta(st.meta);
      if (st.state === 'success' || st.state === 'error' || st.state === 'warning') {
        if (st.state !== 'success') {
          
          try { await navigator.clipboard.writeText(lastHandoffText); } catch (e) {}
          showToast(st.meta || 'Couldn\'t auto-fill \u2014 copied to clipboard.', 'error');
        } else {
          showToast(st.label, 'success');
        }
        break;
      }
    }
    chrome.storage.local.remove('bgStatus');
    setLoading(btn, false);
  }

  sendToGPTBtn.addEventListener('click', function () {
    sendToService(
      sendToGPTBtn,
      ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
      'https://chatgpt.com/',
      'chatgpt.com',
      'GPT'
    );
  });

  sendToGeminiBtn.addEventListener('click', function () {
    sendToService(
      sendToGeminiBtn,
      ['https://gemini.google.com/*'],
      'https://gemini.google.com/',
      'gemini.google.com',
      'Gemini'
    );
  });

  sendToGrokBtn.addEventListener('click', function () {
    sendToService(
      sendToGrokBtn,
      ['https://grok.com/*'],
      'https://grok.com/',
      'grok.com',
      'Grok'
    );
  });

  // Fires SEND_TO_CLAUDE in background.js. Background handles logout,
  // Google sign-in, auth detection, navigation, and fill entirely on its own.
  sendToClaudeBtn.addEventListener('click', async function () {
    if (!lastHandoffText || !activeTab) {
      if (!lastHandoffText) showToast('Generate a handoff prompt first.', 'warning');
      return;
    }

    var proceed = await askLogoutConfirm();
    if (!proceed) return;

    setLoading(sendToClaudeBtn, true);
    setStatus('loading', 'Logging out of Claude\u2026');
    setMeta('');

    await new Promise(function (r) { chrome.storage.local.remove('bgStatus', r); });
    await new Promise(function (r) { chrome.storage.local.set({ pendingHandoff: lastHandoffText }, r); });

    chrome.runtime.sendMessage({
      action:           'SEND_TO_CLAUDE',
      tabId:            activeTab.id,
      text:             lastHandoffText,
      autoPaste:        prefs.autoPasteEnabled,
      autoGoogleSignIn: prefs.autoGoogleSignIn,
    });

    // Poll bgStatus — 130s to cover the full login wait
    var maxPoll = 130000;
    var elapsed = 0;
    while (elapsed < maxPoll) {
      await new Promise(function (r) { setTimeout(r, 800); });
      elapsed += 800;
      var result = await new Promise(function (r) { chrome.storage.local.get(['bgStatus'], r); });
      var st = result.bgStatus;
      if (!st) continue;
      setStatus(st.state, st.label);
      if (st.meta) setMeta(st.meta);
      if (st.state === 'success' || st.state === 'error' || st.state === 'warning') {
        if (st.state !== 'success') {
          try { await navigator.clipboard.writeText(lastHandoffText); } catch (e) {}
          showToast(st.meta || 'Claude handoff failed — copied to clipboard.', 'error');
        } else {
          showToast(st.label, 'success');
        }
        break;
      }
    }
    chrome.storage.local.remove('bgStatus');
    setLoading(sendToClaudeBtn, false);
  });

  // ── Options link ──────────────────────────────────────────────────────────────

  if (optionsLink) {
    optionsLink.addEventListener('click', function (e) {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }

});