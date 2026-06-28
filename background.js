// background.js — Context Handoff service worker
//
// ALL async tab orchestration lives here. The popup fires one kick-off message
// then closes — the service worker owns everything from that point.
//
// Key design: NO sleep/polling loops. Everything is event-driven via
// chrome.tabs.onUpdated. This is the only approach that survives Manifest V3
// service worker suspension — a sleeping loop gets killed, an event listener
// does not.
//
// IMPORTANT: job state used to live in a plain `var jobs = {}` in-memory
// object. MV3 service workers are killed after ~30s idle and re-executed
// from the top on the next event, which silently wiped that object mid-flow
// (most visible on slow-loading targets like ChatGPT, which often takes
// longer than 30s to settle through redirects/auth checks). Jobs are now
// persisted in chrome.storage.session, which survives service worker
// restarts but still clears when the browser closes.
//
// Flow state is also mirrored to chrome.storage.local (bgStatus) so the
// popup can read status if it happens to be open, but the flow never
// depends on the popup being open.

'use strict';

// ── Port keepalive (not relied on for correctness, just a nice-to-have) ───────
var _ports = [];
chrome.runtime.onConnect.addListener(function (port) {
  _ports.push(port);
  port.onDisconnect.addListener(function () {
    _ports = _ports.filter(function (p) { return p !== port; });
  });
});

// ── Badge helpers ─────────────────────────────────────────────────────────────

function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text });
  chrome.action.setBadgeBackgroundColor({ color: color });
}
function clearBadge() { chrome.action.setBadgeText({ text: '' }); }

// ── Notification helper ───────────────────────────────────────────────────────

var NOTIF_ID = 'context-handoff-limit';
function showLimitNotification(phrase) {
  chrome.notifications.create(NOTIF_ID, {
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: 'Context Handoff — Limit reached',
    message: phrase
      ? 'Phrase detected: "' + phrase + '". Click to export.'
      : 'Usage limit detected. Click to export.',
    priority: 2, buttons: [{ title: 'Open & Export' }],
  });
}
chrome.notifications.onClicked.addListener(function (id) {
  if (id === NOTIF_ID) {
    chrome.notifications.clear(NOTIF_ID);
    if (chrome.action.openPopup) chrome.action.openPopup().catch(function () {});
  }
});
chrome.notifications.onButtonClicked.addListener(function (id, btnIdx) {
  if (id === NOTIF_ID && btnIdx === 0) {
    chrome.notifications.clear(NOTIF_ID);
    if (chrome.action.openPopup) chrome.action.openPopup().catch(function () {});
  }
});

// ── Status helpers ────────────────────────────────────────────────────────────

function writeStatus(state, label, meta) {
  chrome.storage.local.set({ bgStatus: { state: state, label: label, meta: meta || '', ts: Date.now() } });
}

// ── Tab messaging ─────────────────────────────────────────────────────────────

function msgTab(tabId, message) {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, message, function (resp) {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp || null);
      });
    } catch (e) { resolve(null); }
  });
}

// ── Job registry — persisted in chrome.storage.session ─────────────────────────
// Keyed by tabId (string, since storage keys are strings). Each job is an
// object describing what to do next. Survives service worker restarts;
// cleared automatically when the browser closes.

var JOBS_KEY = 'handoffJobs';

function getAllJobs() {
  return new Promise(function (resolve) {
    chrome.storage.session.get([JOBS_KEY], function (result) {
      resolve(result[JOBS_KEY] || {});
    });
  });
}

function getJob(tabId) {
  return getAllJobs().then(function (jobs) { return jobs[String(tabId)] || null; });
}

function setJob(tabId, job) {
  return getAllJobs().then(function (jobs) {
    jobs[String(tabId)] = job;
    return new Promise(function (resolve) {
      chrome.storage.session.set({ handoffJobs: jobs }, resolve);
    });
  });
}

function deleteJob(tabId) {
  return getAllJobs().then(function (jobs) {
    delete jobs[String(tabId)];
    return new Promise(function (resolve) {
      chrome.storage.session.set({ handoffJobs: jobs }, resolve);
    });
  });
}

// ── chrome.tabs.onUpdated — the heart of the event-driven approach ────────────
// Instead of polling in a loop, we register what we want to happen next
// and let Chrome call us when the tab reaches that state. Job lookups are
// async (storage-backed) so the listener itself is async.

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  (async function () {
    var job = await getJob(tabId);
    if (!job) return;
    if (changeInfo.status !== 'complete') return;

    var url = tab.url || '';

    // ── SEND_TO_SERVICE: tab has loaded the destination site ──────────────────
    if (job.type === 'fill' && url.indexOf(job.urlFragment) !== -1) {
      await deleteJob(tabId);
      writeStatus('loading', 'Filling ' + job.name + ' input\u2026');

      // Small delay — SPA editors initialise slightly after page load event
      setTimeout(function () {
        (async function () {
          // Ping to confirm content script is alive
          var attempts = 0;
          var pong = null;
          while (attempts++ < 10 && !pong) {
            await new Promise(function (r) { setTimeout(r, 500); });
            pong = await msgTab(tabId, { action: 'PING' });
          }

          if (!pong || !pong.ok) {
            writeStatus('error', 'Tab loaded but content script not ready',
              job.name + ' took too long. Try refreshing and sending again.');
            return;
          }

          if (!job.autoPaste) {
            writeStatus('success', job.name + ' opened', 'Auto-paste is off — paste manually.');
            return;
          }

          var fillResp = await msgTab(tabId, { action: 'FILL_INPUT', text: job.text });
          if (fillResp && fillResp.ok) {
            writeStatus('success', 'Filled \u2014 review and press Enter',
              job.name + ' input ready. Review and press Enter to send.');
          } else {
            writeStatus('warning', 'Auto-fill failed \u2014 paste manually',
              'Handoff prompt is in your clipboard.');
          }
        })();
      }, 600);
    }

    // ── SEND_TO_CLAUDE step 1: login page has loaded ──────────────────────────
    if (job.type === 'claude-login' && url.indexOf('claude.ai/login') !== -1) {
      writeStatus('loading', 'Login page ready\u2026',
        job.autoGoogleSignIn
          ? 'Clicking Continue with Google for you.'
          : 'Click Continue with Google to continue.');

      if (job.autoGoogleSignIn) {
        // Give the page a moment to fully render, then click
        setTimeout(function () {
          (async function () {
            // Ping first — confirm content script loaded on login page
            var attempts = 0;
            var pong = null;
            while (attempts++ < 15 && !pong) {
              await new Promise(function (r) { setTimeout(r, 400); });
              pong = await msgTab(tabId, { action: 'PING' });
            }

            if (!pong || !pong.ok) {
              writeStatus('loading', 'Waiting for you to sign in\u2026',
                'Content script not ready. Click Continue with Google manually.');
            } else {
              var gsResp = await msgTab(tabId, { action: 'CLICK_GOOGLE_SIGNIN' });
              if (!gsResp || !gsResp.ok) {
                writeStatus('loading', 'Waiting for you to sign in\u2026',
                  'Could not auto-click Google. Click Continue with Google manually.');
              } else {
                writeStatus('loading', 'Waiting for you to sign in\u2026',
                  'Pick your account on the Google screen.');
              }
            }

            // Transition to waiting-for-auth state
            await setJob(tabId, {
              type:      'claude-auth',
              text:      job.text,
              autoPaste: job.autoPaste,
              timeout:   Date.now() + 120000,
            });
          })();
        }, 800);
      } else {
        writeStatus('loading', 'Waiting for you to sign in\u2026',
          'Pick your account on the Google screen.');
        await setJob(tabId, {
          type:      'claude-auth',
          text:      job.text,
          autoPaste: job.autoPaste,
          timeout:   Date.now() + 120000,
        });
      }
    }

    // ── SEND_TO_CLAUDE step 2: user has authenticated, back on claude.ai ───────
    if (job.type === 'claude-auth' && url.indexOf('claude.ai') !== -1 &&
        url.indexOf('claude.ai/login') === -1 && url.indexOf('accounts.google') === -1) {

      if (Date.now() > job.timeout) {
        await deleteJob(tabId);
        writeStatus('error', 'Login timed out', 'Try again once you have signed in.');
        return;
      }

      // We're back on claude.ai — navigate to a fresh chat
      await deleteJob(tabId);
      writeStatus('loading', 'Opening a fresh chat\u2026');
      chrome.tabs.update(tabId, { url: 'https://claude.ai/new' });

      // Register the fill job for when /new loads
      await setJob(tabId, {
        type:        'fill',
        name:        'Claude',
        urlFragment: 'claude.ai/new',
        text:        job.text,
        autoPaste:   job.autoPaste,
      });
    }
  })();
});

// Clean up any orphaned job if its tab gets closed mid-flow.
chrome.tabs.onRemoved.addListener(function (tabId) {
  deleteJob(tabId);
});

// ── SEND_TO_SERVICE ───────────────────────────────────────────────────────────

async function handleSendToService(message) {
  var name        = message.name;
  var launchUrl   = message.launchUrl;
  var queryUrls   = message.queryUrls || [];
  var urlFragment = message.urlFragment || '';
  var text        = message.text;
  var autoPaste   = message.autoPaste !== false;

  console.log('[Context Handoff] handleSendToService start', { name: name, launchUrl: launchUrl, queryUrls: queryUrls, urlFragment: urlFragment, autoPaste: autoPaste });

  writeStatus('loading', 'Opening ' + name + '\u2026');

  try {
    var tabs = queryUrls.length > 0 ? await chrome.tabs.query({ url: queryUrls }) : [];
    var targetTab;
    console.log('[Context Handoff] matched existing tabs:', tabs.length);

    if (tabs.length > 0) {
      targetTab = tabs[0];
      console.log('[Context Handoff] focusing existing tab', targetTab.id, targetTab.url);
      await chrome.tabs.update(targetTab.id, { active: true });
      try { await chrome.windows.update(targetTab.windowId, { focused: true }); } catch (e) {}
      // Tab already loaded — register fill job and trigger it immediately
      await setJob(targetTab.id, { type: 'fill', name: name, urlFragment: urlFragment, text: text, autoPaste: autoPaste });
      console.log('[Context Handoff] fill job registered for tab', targetTab.id);
      // Fake an onUpdated-style call since the tab won't fire another complete event
      setTimeout(function () {
        (async function () {
          console.log('[Context Handoff] existing-tab fill flow starting for tab', targetTab.id);
          writeStatus('loading', 'Filling ' + name + ' input\u2026');
          await new Promise(function (r) { setTimeout(r, 600); });
          var pong = await msgTab(targetTab.id, { action: 'PING' });
          console.log('[Context Handoff] PING result:', pong);
          if (!pong || !pong.ok) {
            writeStatus('error', 'Tab not responding', 'Refresh ' + name + ' and try again.');
            await deleteJob(targetTab.id);
            return;
          }
          if (!autoPaste) {
            writeStatus('success', name + ' opened', 'Auto-paste is off — paste manually.');
            await deleteJob(targetTab.id);
            return;
          }
          var fillResp = await msgTab(targetTab.id, { action: 'FILL_INPUT', text: text });
          console.log('[Context Handoff] FILL_INPUT result:', fillResp);
          await deleteJob(targetTab.id);
          if (fillResp && fillResp.ok) {
            writeStatus('success', 'Filled \u2014 review and press Enter', name + ' input ready.');
          } else {
            writeStatus('warning', 'Auto-fill failed \u2014 paste manually', '');
          }
        })();
      }, 0);
    } else {
      // New tab — register fill job BEFORE creating tab so onUpdated catches it
      var newTab = await chrome.tabs.create({ url: launchUrl, active: true });
      await setJob(newTab.id, { type: 'fill', name: name, urlFragment: urlFragment, text: text, autoPaste: autoPaste });
    }
  } catch (err) {
    writeStatus('error', 'Failed to open ' + name, err.message);
  }
}

// ── SEND_TO_CLAUDE ────────────────────────────────────────────────────────────

async function handleSendToClaude(message) {
  var claudeTabId      = message.tabId;
  var text             = message.text;
  var autoPaste        = message.autoPaste !== false;
  var autoGoogleSignIn = message.autoGoogleSignIn !== false;

  writeStatus('loading', 'Logging out of Claude\u2026');

  // Save handoff text before logout wipes page state
  await new Promise(function (r) { chrome.storage.local.set({ pendingHandoff: text }, r); });

  // Register login-page listener BEFORE sending logout — tab may navigate fast
  await setJob(claudeTabId, {
    type:            'claude-login',
    text:            text,
    autoPaste:       autoPaste,
    autoGoogleSignIn: autoGoogleSignIn,
  });

  var logoutResp = await msgTab(claudeTabId, { action: 'LOGOUT' });
  if (!logoutResp || !logoutResp.ok) {
    await deleteJob(claudeTabId);
    writeStatus('error', 'Logout failed', (logoutResp && logoutResp.error) || 'Could not log out automatically.');
  }
  // From here, onUpdated drives everything
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

  if (message.action === 'LOG') {
    console.log('[Context Handoff BG]', message.data);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'LIMIT_DETECTED') {
    setBadge('!', '#ef4444');
    showLimitNotification(message.phrase);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'UNRECOGNIZED_BANNER') {
    setBadge('?', '#f59e0b');
    chrome.storage.local.get(['unrecognizedBanners'], function (result) {
      var banners = result.unrecognizedBanners || [];
      banners.push({ text: message.text, url: message.url,
        timestamp: message.timestamp || new Date().toISOString(), approved: false });
      if (banners.length > 20) banners = banners.slice(-20);
      chrome.storage.local.set({ unrecognizedBanners: banners });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'POPUP_OPENED') {
    clearBadge();
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === 'SEND_TO_SERVICE') {
    handleSendToService(message).catch(function (e) {
      writeStatus('error', 'Failed', e.message);
    });
    sendResponse({ ok: true, queued: true });
    return true;
  }

  if (message.action === 'SEND_TO_CLAUDE') {
    handleSendToClaude(message).catch(function (e) {
      writeStatus('error', 'Claude handoff failed', e.message);
    });
    sendResponse({ ok: true, queued: true });
    return true;
  }
});

console.log('[Context Handoff] Background service worker started.');