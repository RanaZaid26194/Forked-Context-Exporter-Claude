// lib/storage.js — shared storage helpers
//
// Thin wrappers around chrome.storage.local so call sites don't have to
// handle the callback/promise difference between browser environments.
// All data stays 100% local — nothing is ever sent to a remote server.

'use strict';

window.ContextHandoff = window.ContextHandoff || {};

/**
 * Read one or more keys from chrome.storage.local.
 * @param {string|string[]} keys
 * @returns {Promise<Object>}
 */
window.ContextHandoff.storageGet = function storageGet(keys) {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.get(keys, function (result) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
};

/**
 * Write an object of key→value pairs to chrome.storage.local.
 * @param {Object} items
 * @returns {Promise<void>}
 */
window.ContextHandoff.storageSet = function storageSet(items) {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.set(items, function () {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
};

/**
 * Remove keys from chrome.storage.local.
 * @param {string|string[]} keys
 * @returns {Promise<void>}
 */
window.ContextHandoff.storageRemove = function storageRemove(keys) {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.remove(keys, function () {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
};
