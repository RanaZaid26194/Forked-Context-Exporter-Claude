// options/options.js — Context Handoff settings page
//
// Manages four toggles:
//   - autoDetectEnabled   — MutationObserver limit detection on/off
//   - autoPasteEnabled    — auto-fill the destination input on/off
//   - autoGoogleSignIn    — auto-click "Continue with Google" after logout
//   - skipLogoutConfirm   — skip the "Switch Claude Account?" modal
//
// Plus the phrase list editor and unrecognized banners review list.

'use strict';

// ── Storage keys ──────────────────────────────────────────────────────────────
var KEY_PHRASES       = 'limitPhrases';
var KEY_AUTO          = 'autoDetectEnabled';
var KEY_BANNERS       = 'unrecognizedBanners';
var KEY_AUTO_PASTE    = 'autoPasteEnabled';
var KEY_GOOGLE_SIGNIN = 'autoGoogleSignIn';
var KEY_SKIP_CONFIRM  = 'skipLogoutConfirm';
var JSON_URL          = chrome.runtime.getURL('config/limit-signals.json');

// ── Element refs ──────────────────────────────────────────────────────────────
var autoDetectEl        = document.getElementById('autoDetectToggle');
var autoPasteEl         = document.getElementById('autoPasteToggle');
var autoGoogleSignInEl  = document.getElementById('autoGoogleSignInToggle');
var skipLogoutConfirmEl = document.getElementById('skipLogoutConfirmToggle');
var phraseEditor        = document.getElementById('phraseEditor');
var savePhrases         = document.getElementById('savePhrases');
var restoreBtn          = document.getElementById('restoreDefaults');
var saveStatus          = document.getElementById('saveStatus');
var bannerList          = document.getElementById('bannerList');
var bannerCount         = document.getElementById('bannerCount');

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

  // Approve — extract a short phrase, add to list, remove the banner
  bannerList.querySelectorAll('.btn-approve').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var idx     = parseInt(btn.dataset.idx, 10);
      var result  = await storageGet([KEY_BANNERS, KEY_PHRASES]);
      var banners = result[KEY_BANNERS] || [];
      var phrases = result[KEY_PHRASES] || [];
      var banner  = banners[idx];
      if (!banner) return;

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

  // Dismiss — just remove from logged list
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
  var result = await storageGet([
    KEY_AUTO, KEY_AUTO_PASTE, KEY_GOOGLE_SIGNIN, KEY_SKIP_CONFIRM,
    KEY_PHRASES, KEY_BANNERS,
  ]);

  // General toggles
  autoDetectEl.checked       = result[KEY_AUTO]          !== false; // default true
  autoPasteEl.checked        = result[KEY_AUTO_PASTE]    !== false; // default true
  autoGoogleSignInEl.checked = result[KEY_GOOGLE_SIGNIN] !== false; // default true
  skipLogoutConfirmEl.checked = result[KEY_SKIP_CONFIRM] === true;  // default false

  // Phrase editor — seed from bundled JSON on first run
  var phrases = result[KEY_PHRASES];
  if (!phrases || phrases.length === 0) {
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

// ── Toggle handlers ───────────────────────────────────────────────────────────

autoDetectEl.addEventListener('change', async function () {
  await storageSet({ [KEY_AUTO]: autoDetectEl.checked });
  showStatus(
    autoDetectEl.checked ? 'Auto-detect enabled.' : 'Auto-detect disabled.',
    'ok'
  );
});

autoPasteEl.addEventListener('change', async function () {
  await storageSet({ [KEY_AUTO_PASTE]: autoPasteEl.checked });
  showStatus(
    autoPasteEl.checked
      ? 'Auto-paste enabled — handoff prompt will be filled automatically.'
      : 'Auto-paste disabled — tabs will open but nothing will be pasted.',
    'ok'
  );
});

autoGoogleSignInEl.addEventListener('change', async function () {
  await storageSet({ [KEY_GOOGLE_SIGNIN]: autoGoogleSignInEl.checked });
  showStatus(
    autoGoogleSignInEl.checked
      ? 'Will auto-click Continue with Google after logout.'
      : 'You\'ll need to click Continue with Google manually.',
    'ok'
  );
});

skipLogoutConfirmEl.addEventListener('change', async function () {
  await storageSet({ [KEY_SKIP_CONFIRM]: skipLogoutConfirmEl.checked });
  showStatus(
    skipLogoutConfirmEl.checked
      ? 'Logout confirmation skipped from now on.'
      : 'Logout confirmation re-enabled.',
    'ok'
  );
});

// ── Phrase editor handlers ────────────────────────────────────────────────────

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

// Live-update banner list when storage changes while the options page is open
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes[KEY_BANNERS]) renderBanners(changes[KEY_BANNERS].newValue);
  // Sync skip-confirm toggle if the popup's "never ask again" checkbox changed it
  if (changes[KEY_SKIP_CONFIRM]) {
    skipLogoutConfirmEl.checked = changes[KEY_SKIP_CONFIRM].newValue === true;
  }
});