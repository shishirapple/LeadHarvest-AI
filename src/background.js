/**
 * LeadHarvest AI — Background Service Worker (MV3)
 * Fully self-contained: no external accounts, no OAuth, no third-party sync.
 * - Website email discovery (fetch + hidden-tab fallback) + CMS fingerprinting
 * - Daily quota management
 * - Session tracking
 * - Keepalive for long scraping sessions
 */

import { findEmailForWebsite } from './lib/email-scraper.js';

const CONFIG = {
  DEFAULT_QUOTA_CAP: 500,
  KEEPALIVE_INTERVAL_MIN: 0.5,
};

/* ─── Quota ─── */
async function getQuota() {
  const { quota } = await chrome.storage.local.get('quota');
  const today = new Date().toISOString().slice(0, 10);
  if (!quota || quota.date !== today) {
    const fresh = { date: today, count: 0, cap: CONFIG.DEFAULT_QUOTA_CAP };
    await chrome.storage.local.set({ quota: fresh });
    return fresh;
  }
  return quota;
}

async function bumpQuota(n = 1) {
  const q = await getQuota();
  q.count = Math.min(q.count + n, q.cap);
  await chrome.storage.local.set({ quota: q });
  return q;
}

async function resetQuota() {
  await chrome.storage.local.remove('quota');
  return await getQuota();
}

/* ─── Settings ─── */
async function getSettings() {
  const data = await chrome.storage.sync.get([
    'exportFormat', 'rateLimitEnabled', 'customDelay', 'autoScroll', 'extractEmailsFromWebsite',
  ]);
  return {
    exportFormat: data.exportFormat || 'csv',
    rateLimitEnabled: data.rateLimitEnabled !== false,
    customDelay: data.customDelay || 0,
    autoScroll: data.autoScroll !== false,
    extractEmailsFromWebsite: data.extractEmailsFromWebsite !== false,
  };
}

/* ─── Sessions ─── */
async function createSession(query, fields, limit) {
  const session = {
    id: crypto.randomUUID(), query, fields, limit,
    status: 'running', startedAt: new Date().toISOString(),
    capturedCount: 0, errorCount: 0,
  };
  await chrome.storage.local.set({ activeSession: session });
  return session;
}

async function updateSession(updates) {
  const { activeSession } = await chrome.storage.local.get('activeSession');
  if (activeSession) {
    const updated = { ...activeSession, ...updates };
    await chrome.storage.local.set({ activeSession: updated });
    return updated;
  }
  return null;
}

async function completeSession() {
  const { activeSession } = await chrome.storage.local.get('activeSession');
  if (activeSession) {
    activeSession.status = 'completed';
    activeSession.completedAt = new Date().toISOString();
    const { sessionHistory } = await chrome.storage.local.get('sessionHistory');
    const history = Array.isArray(sessionHistory) ? sessionHistory : [];
    history.unshift(activeSession);
    await chrome.storage.local.set({ sessionHistory: history.slice(0, 50) });
    await chrome.storage.local.remove('activeSession');
  }
}

async function incrementLeadCount() {
  const { leadCount } = await chrome.storage.local.get('leadCount');
  const newCount = (leadCount || 0) + 1;
  await chrome.storage.local.set({ leadCount: newCount });
  return newCount;
}

/* Sequential email-lookup queue — gentle on target sites, avoids tab pile-ups */
let emailQueueTail = Promise.resolve();
function queueEmailLookup(website) {
  const task = emailQueueTail.then(() => findEmailForWebsite(website));
  emailQueueTail = task.catch(() => {});
  return task;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    console.error('[LeadHarvest] Message handler error:', err);
    sendResponse({ ok: false, error: err.message });
  });
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'START_SCRAPE': {
      const quota = await getQuota();
      if (quota.count >= quota.cap) {
        return { ok: false, error: `Daily quota reached (${quota.count}/${quota.cap}). Reset in Options or wait until tomorrow.` };
      }

      const tabs = await chrome.tabs.query({});
      let mapsTab = tabs.find(t => t.url && (t.url.includes('google.com/maps') || t.url.includes('maps.google.com')));

      if (!mapsTab) {
        const query = msg.query || '';
        const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
        const newTab = await chrome.tabs.create({ url: searchUrl, active: true });
        return { ok: true, newTab: true, tabId: newTab.id };
      }

      const settings = await getSettings();
      const effectiveLimit = Math.min(msg.limit || 50, quota.cap - quota.count);
      await chrome.alarms.create('keepalive', { periodInMinutes: CONFIG.KEEPALIVE_INTERVAL_MIN });
      const session = await createSession(msg.query || '', msg.fields || [], effectiveLimit);

      const extractionSettings = {
        extractEmailsFromWebsite: settings.extractEmailsFromWebsite,
        customDelay: settings.customDelay,
        rateLimitEnabled: settings.rateLimitEnabled,
        autoScroll: settings.autoScroll,
        limit: effectiveLimit,
      };

      try {
        await chrome.tabs.sendMessage(mapsTab.id, {
          type: 'RUN_EXTRACTION', fields: msg.fields || [], limit: effectiveLimit,
          settings: extractionSettings, sessionId: session.id,
        });
        return { ok: true, tabId: mapsTab.id, sessionId: session.id };
      } catch (err) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: mapsTab.id },
            files: ['src/lib/storage.js', 'src/content/maps-content.js'],
          });
          await new Promise(r => setTimeout(r, 1000));
          await chrome.tabs.sendMessage(mapsTab.id, {
            type: 'RUN_EXTRACTION', fields: msg.fields || [], limit: effectiveLimit,
            settings: extractionSettings, sessionId: session.id,
          });
          return { ok: true, tabId: mapsTab.id, sessionId: session.id };
        } catch (injectErr) {
          return { ok: false, error: `Cannot reach Maps tab. Refresh the Maps page and try again. (${injectErr.message})` };
        }
      }
    }

    case 'EXTRACT_EMAIL': {
      if (!msg.website) return { ok: true, email: null, platform: null };
      try {
        const result = await queueEmailLookup(msg.website);
        return { ok: true, email: result.email, method: result.method, platform: result.platform };
      } catch (err) {
        return { ok: true, email: null, platform: null, error: err.message };
      }
    }

    case 'RECORD_CAPTURED': {
      const newCount = await incrementLeadCount();
      await bumpQuota(1);
      const { activeSession } = await chrome.storage.local.get('activeSession');
      await updateSession({ capturedCount: (activeSession?.capturedCount || 0) + 1 });
      chrome.runtime.sendMessage({ type: 'LEAD_COUNT_UPDATE', count: newCount }).catch(() => {});
      return { ok: true, totalCaptured: newCount };
    }

    case 'EXTRACTION_COMPLETE': {
      await completeSession();
      await chrome.alarms.clear('keepalive');
      chrome.runtime.sendMessage({ type: 'EXTRACTION_COMPLETE' }).catch(() => {});
      return { ok: true };
    }

    case 'GET_QUOTA': {
      return { ok: true, quota: await getQuota() };
    }

    case 'RESET_QUOTA': {
      return { ok: true, quota: await resetQuota() };
    }

    case 'GET_SETTINGS': {
      return { ok: true, settings: await getSettings() };
    }

    case 'SAVE_SETTINGS': {
      await chrome.storage.sync.set(msg.settings);
      return { ok: true };
    }

    case 'GET_SESSION_HISTORY': {
      const { sessionHistory } = await chrome.storage.local.get('sessionHistory');
      return { ok: true, history: sessionHistory || [] };
    }

    case 'GET_LEADS_BY_SESSION': {
      if (!msg.sessionId) return { ok: false, error: 'Session ID required' };
      try {
        const tabs = await chrome.tabs.query({ url: ['*://www.google.com/maps/*', '*://maps.google.com/*'] });
        if (tabs.length === 0) return { ok: false, error: 'No Maps tab found' };
        const result = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_LEADS_BY_SESSION', sessionId: msg.sessionId }, resolve);
        });
        return result || { ok: false, error: 'No response from content script' };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case 'GET_STATS': {
      const { leadCount } = await chrome.storage.local.get('leadCount');
      const quota = await getQuota();
      const { activeSession } = await chrome.storage.local.get('activeSession');
      return { ok: true, stats: { leadCount: leadCount || 0, quota, activeSession } };
    }

    default:
      return { ok: false, error: `Unknown message type: ${msg.type}` };
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    chrome.runtime.sendMessage({ type: 'KEEPALIVE_PING' }).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[LeadHarvest] Extension ${details.reason}: v${chrome.runtime.getManifest().version}`);
  if (details.reason === 'install') {
    chrome.storage.sync.set({
      exportFormat: 'csv',
      rateLimitEnabled: true,
      autoScroll: true,
      extractEmailsFromWebsite: true,
      customDelay: 0,
    });
  }
});

console.log('[LeadHarvest] Background service worker ready (v4.0.0)');
