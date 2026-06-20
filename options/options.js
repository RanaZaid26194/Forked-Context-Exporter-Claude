// options/options.js — Context Handoff settings page (Phase 2)
//
// Manages:
//   - autoDetectEnabled toggle (chrome.storage.local)
//   - limitPhrases phrase list editor (read/write/restore defaults)
//   - unrecognizedBanners review list (approve → add to phrases, dismiss → remove)

'use strict';

// ── Storage keys ──────────────────────────────────────────────────────────────
var KEY_PHRASES  = 'limitPhrases';
var KEY_AUTO     = 'autoDetectEnabled';
var KEY_BANNERS  = 'unrecognizedBanners';
var JSON_URL     = chrome.runtime.getURL('config/limit-signals.json');

// ── Element refs ──────────────────────────────────────────────────────────────
var autoToggle    = document.getElementById('autoDetectToggle');
var phraseEditor  = document.getElementById('phraseEditor');
var savePhrases   = document.getElementById('savePhrases');
var restoreBtn    = document.getElementById('restoreDefaults');
var saveStatus    = document.getElementById('saveStatus');
var bannerList    = document.getElementById('bannerList');
var bannerCount   = document.getElementById('bannerCount');

// ── Helpers ───────────────────────────────────────────────────────────────────

function storageGet(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, resolve);
  });
}

function storageSet(items) {
  return new Promise(function (resolve) {
    chrome.storage.local.set(items, resolve);
  });
}

function storageRemove(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.remove(keys, resolve);
  });
}

function showStatus(msg, type) {
  saveStatus.textContent = msg;
  saveStatus.className = 'save-status ' + (type || '');
  setTimeout(function () {
    saveStatus.textContent = '';
    saveStatus.className = 'save-status';
  }, 3000);
}

function phrasesFromEditor() {
  return phraseEditor.value
    .split('\n')
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0; });
}

async function fetchDefaultPhrases() {
  var r    = await fetch(JSON_URL);
  var data = await r.json();
  return data.phrases || [];
}

// ── Render banners ────────────────────────────────────────────────────────────

function renderBanners(banners) {
  banners = banners || [];

  if (banners.length === 0) {
    bannerList.innerHTML = '<p class="banner-empty">No unrecognized banners logged yet.</p>';
    bannerCount.style.display = 'none';
    return;
  }

  bannerCount.textContent = banners.length + ' pending';
  bannerCount.style.display = '';

  bannerList.innerHTML = '';
  banners.forEach(function (banner, idx) {
    var item = document.createElement('div');
    item.className = 'banner-item';

    var date = '';
    try { date = new Date(banner.timestamp).toLocaleString(); } catch (e) {}

    item.innerHTML =
      '<div class="banner-text">' + escapeHtml(banner.text) + '</div>' +
      '<div class="banner-meta">' + escapeHtml(date) + (banner.url ? ' · ' + escapeHtml(banner.url) : '') + '</div>' +
      '<div class="banner-actions">' +
        '<button class="btn-approve" data-idx="' + idx + '">✓ Approve &amp; add phrase</button>' +
        '<button class="btn-dismiss" data-idx="' + idx + '">Dismiss</button>' +
      '</div>';

    bannerList.appendChild(item);
  });

  // Approve: extract a short phrase from banner text, add to phrases list, remove banner
  bannerList.querySelectorAll('.btn-approve').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var idx     = parseInt(btn.dataset.idx, 10);
      var result  = await storageGet([KEY_BANNERS, KEY_PHRASES]);
      var banners = result[KEY_BANNERS] || [];
      var phrases = result[KEY_PHRASES] || [];
      var banner  = banners[idx];
      if (!banner) return;

      // Extract the first meaningful chunk of the banner as the new phrase (up to 60 chars)
      var phrase = banner.text.split(/[.!?\n]/)[0].trim().slice(0, 60);
      if (phrase && phrases.indexOf(phrase) === -1) {
        phrases.push(phrase);
        await storageSet({ [KEY_PHRASES]: phrases });
        phraseEditor.value = phrases.join('\n');
      }

      banners.splice(idx, 1);
      await storageSet({ [KEY_BANNERS]: banners });
      showStatus('Phrase added and banner dismissed.', 'ok');
      renderBanners(banners);
    });
  });

  // Dismiss: just remove from logged list
  bannerList.querySelectorAll('.btn-dismiss').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var idx     = parseInt(btn.dataset.idx, 10);
      var result  = await storageGet([KEY_BANNERS]);
      var banners = result[KEY_BANNERS] || [];
      banners.splice(idx, 1);
      await storageSet({ [KEY_BANNERS]: banners });
      renderBanners(banners);
    });
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init() {
  var result = await storageGet([KEY_AUTO, KEY_PHRASES, KEY_BANNERS]);

  // Toggle
  var autoEnabled = result[KEY_AUTO] !== false; // default true
  autoToggle.checked = autoEnabled;

  // Phrase editor
  var phrases = result[KEY_PHRASES];
  if (!phrases || phrases.length === 0) {
    // Seed from bundled JSON
    try {
      phrases = await fetchDefaultPhrases();
      await storageSet({ [KEY_PHRASES]: phrases });
    } catch (e) {
      phrases = [];
    }
  }
  phraseEditor.value = phrases.join('\n');

  // Banners
  renderBanners(result[KEY_BANNERS]);
})();

// ── Event handlers ────────────────────────────────────────────────────────────

autoToggle.addEventListener('change', async function () {
  await storageSet({ [KEY_AUTO]: autoToggle.checked });
  showStatus(autoToggle.checked ? 'Auto-detect enabled.' : 'Auto-detect disabled.', 'ok');
});

savePhrases.addEventListener('click', async function () {
  var phrases = phrasesFromEditor();
  if (phrases.length === 0) {
    showStatus('Phrase list cannot be empty.', 'error');
    return;
  }
  await storageSet({ [KEY_PHRASES]: phrases });
  showStatus('Phrases saved (' + phrases.length + ' total).', 'ok');
});

restoreBtn.addEventListener('click', async function () {
  restoreBtn.disabled = true;
  try {
    var defaults = await fetchDefaultPhrases();
    await storageSet({ [KEY_PHRASES]: defaults });
    phraseEditor.value = defaults.join('\n');
    showStatus('Defaults restored (' + defaults.length + ' phrases).', 'ok');
  } catch (e) {
    showStatus('Could not fetch defaults: ' + e.message, 'error');
  } finally {
    restoreBtn.disabled = false;
  }
});

// Live-update banner list when storage changes (e.g. new banner logged while options page is open)
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes[KEY_BANNERS]) {
    renderBanners(changes[KEY_BANNERS].newValue);
  }
});
