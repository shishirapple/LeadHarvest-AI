/**
 * LeadHarvest AI — Background Service Worker (v5.0)
 *
 * New in v5:
 *  - Opens the side panel on toolbar click instead of a popup
 *  - Queue orchestration: runs tasks sequentially, never in parallel
 *  - Pause / resume / stop for the active task AND the whole queue
 *  - Cross-task duplicate detection (all leads share one IndexedDB dedup_key index)
 *  - Per-task progress tracking: captured, duplicates, status, startedAt, completedAt
 *  - Queue state persisted to chrome.storage.local so it survives service-worker restarts
 *
 * Unchanged from v4:
 *  - Email discovery (findEmailForWebsite) — untouched
 *  - Quota management — untouched
 *  - Daily settings via chrome.storage.sync — untouched
 *  - Keepalive alarm — untouched
 *  - All scraping messages forwarded to maps content script — untouched
 */

import { findEmailForWebsite } from './lib/email-scraper.js';

const CONFIG = {
  DEFAULT_QUOTA_CAP: 500,
  KEEPALIVE_INTERVAL_MIN: 0.5,
};

/* ─── Side panel: open on icon click ─── */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

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

/* ─── Lead count ─── */
async function incrementLeadCount() {
  const { leadCount } = await chrome.storage.local.get('leadCount');
  const newCount = (leadCount || 0) + 1;
  await chrome.storage.local.set({ leadCount: newCount });
  return newCount;
}

/* ─── Queue storage helpers ─── */
async function loadQueue() {
  const { taskQueue } = await chrome.storage.local.get('taskQueue');
  return Array.isArray(taskQueue) ? taskQueue : [];
}
async function saveQueue(queue) {
  await chrome.storage.local.set({ taskQueue: queue });
}
async function loadQueueMeta() {
  const { queueMeta } = await chrome.storage.local.get('queueMeta');
  return queueMeta || { status: 'idle', activeTaskId: null, queuePaused: false };
}
async function saveQueueMeta(meta) {
  await chrome.storage.local.set({ queueMeta: meta });
}

function broadcastQueueUpdate() {
  chrome.runtime.sendMessage({ type: 'QUEUE_UPDATED' }).catch(() => {});
}

/* ─── Queue runner ─── */
let _runnerActive = false;

async function runQueue() {
  if (_runnerActive) return;
  _runnerActive = true;

  try {
    while (true) {
      const meta = await loadQueueMeta();
      if (meta.status === 'stopped' || meta.queuePaused) break;

      const queue = await loadQueue();
      const nextTask = queue.find(t => t.status === 'pending');
      if (!nextTask) {
        // All tasks done or no pending
        const allDone = queue.every(t => t.status === 'completed' || t.status === 'stopped' || t.status === 'error');
        if (allDone && queue.length > 0) {
          await saveQueueMeta({ status: 'idle', activeTaskId: null, queuePaused: false });
          broadcastQueueUpdate();
        }
        break;
      }

      // Mark this task as the active one
      await saveQueueMeta({ status: 'running', activeTaskId: nextTask.id, queuePaused: false });
      await updateTask(nextTask.id, { status: 'running', startedAt: new Date().toISOString() });
      broadcastQueueUpdate();

      // Actually run it
      await executeTask(nextTask);

      // After task ends, check if queue was stopped/paused
      const metaAfter = await loadQueueMeta();
      if (metaAfter.status === 'stopped' || metaAfter.queuePaused) break;
    }
  } finally {
    _runnerActive = false;
  }
}

async function executeTask(task) {
  const quota = await getQuota();
  if (quota.count >= quota.cap) {
    await updateTask(task.id, { status: 'error', errorMsg: `Daily quota reached (${quota.count}/${quota.cap})` });
    broadcastQueueUpdate();
    return;
  }

  const settings = await getSettings();
  const effectiveLimit = Math.min(task.limit || 50, quota.cap - quota.count);

  // Ensure a Maps tab exists
  const tabs = await chrome.tabs.query({});
  let mapsTab = tabs.find(t => t.url && (t.url.includes('google.com/maps') || t.url.includes('maps.google.com')));

  if (!mapsTab) {
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(task.query || '')}`;
    mapsTab = await chrome.tabs.create({ url: searchUrl, active: true });
    // Wait for tab to load
    await new Promise(resolve => {
      const listener = (tabId, info) => {
        if (tabId === mapsTab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(resolve, 8000);
    });
  }

  await chrome.alarms.create('keepalive', { periodInMinutes: CONFIG.KEEPALIVE_INTERVAL_MIN });

  const extractionSettings = {
    extractEmailsFromWebsite: settings.extractEmailsFromWebsite,
    customDelay: settings.customDelay,
    rateLimitEnabled: settings.rateLimitEnabled,
    autoScroll: settings.autoScroll,
    limit: effectiveLimit,
  };

  // Tell content script to navigate to the right query if needed
  try {
    await chrome.tabs.sendMessage(mapsTab.id, {
      type: 'SET_QUERY_IF_NEEDED',
      query: task.query,
    });
  } catch (e) {
    // Content script may not be loaded yet; try injecting
    try {
      await chrome.scripting.executeScript({
        target: { tabId: mapsTab.id },
        files: ['src/lib/storage.js', 'src/content/maps-content.js'],
      });
      await new Promise(r => setTimeout(r, 1200));
    } catch (injectErr) {
      await updateTask(task.id, { status: 'error', errorMsg: `Cannot reach Maps tab: ${injectErr.message}` });
      broadcastQueueUpdate();
      await chrome.alarms.clear('keepalive');
      return;
    }
  }

  // Run extraction and wait for it to finish
  await new Promise(async (resolve) => {
    const completionListener = (msg) => {
      if (msg.type === 'EXTRACTION_COMPLETE' || msg.type === 'TASK_STOPPED') {
        chrome.runtime.onMessage.removeListener(completionListener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(completionListener);

    try {
      await chrome.tabs.sendMessage(mapsTab.id, {
        type: 'RUN_EXTRACTION',
        fields: task.fields || [],
        limit: effectiveLimit,
        settings: extractionSettings,
        sessionId: task.id, // use task id as session id for cross-task dedup via storage
      });
    } catch (err) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: mapsTab.id },
          files: ['src/lib/storage.js', 'src/content/maps-content.js'],
        });
        await new Promise(r => setTimeout(r, 1000));
        await chrome.tabs.sendMessage(mapsTab.id, {
          type: 'RUN_EXTRACTION',
          fields: task.fields || [],
          limit: effectiveLimit,
          settings: extractionSettings,
          sessionId: task.id,
        });
      } catch (injectErr) {
        chrome.runtime.onMessage.removeListener(completionListener);
        await updateTask(task.id, { status: 'error', errorMsg: `Injection failed: ${injectErr.message}` });
        broadcastQueueUpdate();
        await chrome.alarms.clear('keepalive');
        resolve();
        return;
      }
    }

    // Safety timeout: 30 min max per task
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(completionListener);
      resolve();
    }, 30 * 60 * 1000);
  });

  await chrome.alarms.clear('keepalive');
}

async function updateTask(taskId, updates) {
  const queue = await loadQueue();
  const idx = queue.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  queue[idx] = { ...queue[idx], ...updates };
  await saveQueue(queue);
}

/* ─── Sequential email-lookup queue ─── */
let emailQueueTail = Promise.resolve();
function queueEmailLookup(website) {
  const task = emailQueueTail.then(() => findEmailForWebsite(website));
  emailQueueTail = task.catch(() => {});
  return task;
}

/* ─── Message handler ─── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    console.error('[LeadHarvest] Message handler error:', err);
    sendResponse({ ok: false, error: err.message });
  });
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {

    /* ── Queue management ── */
    case 'QUEUE_ADD_TASK': {
      const queue = await loadQueue();
      const task = {
        id: crypto.randomUUID(),
        query: msg.query || '',
        limit: Math.max(1, Math.min(msg.limit || 25, 500)),
        fields: msg.fields || [],
        tag: msg.tag || '',
        status: 'pending',
        captured: 0,
        duplicates: 0,
        errors: 0,
        startedAt: null,
        completedAt: null,
        errorMsg: null,
        createdAt: new Date().toISOString(),
      };
      queue.push(task);
      await saveQueue(queue);
      broadcastQueueUpdate();
      return { ok: true, task };
    }

    case 'QUEUE_UPDATE_TASK': {
      // Edit a pending task (query, limit, fields, tag)
      const queue = await loadQueue();
      const idx = queue.findIndex(t => t.id === msg.taskId);
      if (idx === -1) return { ok: false, error: 'Task not found' };
      if (queue[idx].status !== 'pending') return { ok: false, error: 'Can only edit pending tasks' };
      if (msg.query !== undefined) queue[idx].query = msg.query;
      if (msg.limit !== undefined) queue[idx].limit = Math.max(1, Math.min(msg.limit, 500));
      if (msg.fields !== undefined) queue[idx].fields = msg.fields;
      if (msg.tag !== undefined) queue[idx].tag = msg.tag;
      await saveQueue(queue);
      broadcastQueueUpdate();
      return { ok: true };
    }

    case 'QUEUE_DELETE_TASK': {
      const queue = await loadQueue();
      const meta = await loadQueueMeta();
      if (meta.activeTaskId === msg.taskId) return { ok: false, error: 'Cannot delete the running task. Stop it first.' };
      const filtered = queue.filter(t => t.id !== msg.taskId);
      await saveQueue(filtered);
      broadcastQueueUpdate();
      return { ok: true };
    }

    case 'QUEUE_REORDER': {
      // msg.order = array of task IDs in desired order
      const queue = await loadQueue();
      const idMap = Object.fromEntries(queue.map(t => [t.id, t]));
      const reordered = msg.order.map(id => idMap[id]).filter(Boolean);
      // Append any tasks not in the order array (safety)
      queue.forEach(t => { if (!msg.order.includes(t.id)) reordered.push(t); });
      await saveQueue(reordered);
      broadcastQueueUpdate();
      return { ok: true };
    }

    case 'QUEUE_START': {
      const meta = await loadQueueMeta();
      if (meta.status === 'running') return { ok: false, error: 'Queue already running' };
      await saveQueueMeta({ status: 'running', activeTaskId: null, queuePaused: false });
      broadcastQueueUpdate();
      runQueue(); // fire and forget
      return { ok: true };
    }

    case 'QUEUE_PAUSE': {
      // Pause current task in content script + mark queue paused
      const meta = await loadQueueMeta();
      await saveQueueMeta({ ...meta, queuePaused: true });
      if (meta.activeTaskId) {
        const tabs = await chrome.tabs.query({ url: ['*://www.google.com/maps/*', '*://maps.google.com/*'] });
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, { type: 'PAUSE_EXTRACTION' }).catch(() => {});
        }
        await updateTask(meta.activeTaskId, { status: 'paused' });
      }
      broadcastQueueUpdate();
      return { ok: true };
    }

    case 'QUEUE_RESUME': {
      const meta = await loadQueueMeta();
      await saveQueueMeta({ ...meta, queuePaused: false, status: 'running' });
      // Resume active task in content script
      if (meta.activeTaskId) {
        const queue = await loadQueue();
        const task = queue.find(t => t.id === meta.activeTaskId);
        if (task && task.status === 'paused') {
          await updateTask(meta.activeTaskId, { status: 'running' });
          const tabs = await chrome.tabs.query({ url: ['*://www.google.com/maps/*', '*://maps.google.com/*'] });
          for (const t of tabs) {
            chrome.tabs.sendMessage(t.id, { type: 'RESUME_EXTRACTION' }).catch(() => {});
          }
        }
      }
      broadcastQueueUpdate();
      runQueue(); // re-enter runner
      return { ok: true };
    }

    case 'QUEUE_STOP': {
      // Stop the whole queue
      const meta = await loadQueueMeta();
      await saveQueueMeta({ status: 'stopped', activeTaskId: null, queuePaused: false });
      if (meta.activeTaskId) {
        const tabs = await chrome.tabs.query({ url: ['*://www.google.com/maps/*', '*://maps.google.com/*'] });
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, { type: 'STOP_EXTRACTION' }).catch(() => {});
        }
        await updateTask(meta.activeTaskId, { status: 'stopped', completedAt: new Date().toISOString() });
      }
      // Mark all pending tasks as cancelled
      const queue = await loadQueue();
      for (const task of queue) {
        if (task.status === 'pending') await updateTask(task.id, { status: 'cancelled' });
      }
      broadcastQueueUpdate();
      chrome.runtime.sendMessage({ type: 'TASK_STOPPED' }).catch(() => {});
      return { ok: true };
    }

    case 'TASK_STOP': {
      // Stop only the current task; remaining queue stays pending
      const meta = await loadQueueMeta();
      if (!meta.activeTaskId) return { ok: false, error: 'No active task' };
      const tabs = await chrome.tabs.query({ url: ['*://www.google.com/maps/*', '*://maps.google.com/*'] });
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, { type: 'STOP_EXTRACTION' }).catch(() => {});
      }
      await updateTask(meta.activeTaskId, { status: 'stopped', completedAt: new Date().toISOString() });
      await saveQueueMeta({ ...meta, activeTaskId: null });
      broadcastQueueUpdate();
      chrome.runtime.sendMessage({ type: 'TASK_STOPPED' }).catch(() => {});
      return { ok: true };
    }

    case 'QUEUE_CLEAR_DONE': {
      const queue = await loadQueue();
      const filtered = queue.filter(t => t.status === 'pending' || t.status === 'running' || t.status === 'paused');
      await saveQueue(filtered);
      broadcastQueueUpdate();
      return { ok: true };
    }

    case 'QUEUE_RESET': {
      await saveQueue([]);
      await saveQueueMeta({ status: 'idle', activeTaskId: null, queuePaused: false });
      broadcastQueueUpdate();
      return { ok: true };
    }

    case 'GET_QUEUE': {
      const queue = await loadQueue();
      const meta = await loadQueueMeta();
      return { ok: true, queue, meta };
    }

    /* ── Content script events (from maps-content.js) ── */
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

      // Update the active task's captured count
      const meta = await loadQueueMeta();
      if (meta.activeTaskId) {
        const queue = await loadQueue();
        const task = queue.find(t => t.id === meta.activeTaskId);
        if (task) {
          await updateTask(meta.activeTaskId, { captured: (task.captured || 0) + 1 });
        }
      }

      chrome.runtime.sendMessage({ type: 'LEAD_COUNT_UPDATE', count: newCount }).catch(() => {});
      broadcastQueueUpdate();
      return { ok: true, totalCaptured: newCount };
    }

    case 'RECORD_DUPLICATE': {
      const meta = await loadQueueMeta();
      if (meta.activeTaskId) {
        const queue = await loadQueue();
        const task = queue.find(t => t.id === meta.activeTaskId);
        if (task) await updateTask(meta.activeTaskId, { duplicates: (task.duplicates || 0) + 1 });
      }
      broadcastQueueUpdate();
      return { ok: true };
    }

    case 'EXTRACTION_COMPLETE': {
      await chrome.alarms.clear('keepalive');
      const meta = await loadQueueMeta();
      if (meta.activeTaskId) {
        await updateTask(meta.activeTaskId, { status: 'completed', completedAt: new Date().toISOString() });
        await saveQueueMeta({ ...meta, activeTaskId: null });
      }
      broadcastQueueUpdate();
      chrome.runtime.sendMessage({ type: 'EXTRACTION_COMPLETE' }).catch(() => {});
      // Continue queue
      runQueue();
      return { ok: true };
    }

    /* ── Legacy / shared ── */
    case 'GET_QUOTA':
      return { ok: true, quota: await getQuota() };

    case 'RESET_QUOTA':
      return { ok: true, quota: await resetQuota() };

    case 'GET_SETTINGS':
      return { ok: true, settings: await getSettings() };

    case 'SAVE_SETTINGS':
      await chrome.storage.sync.set(msg.settings);
      return { ok: true };

    case 'GET_STATS': {
      const { leadCount } = await chrome.storage.local.get('leadCount');
      const quota = await getQuota();
      const meta = await loadQueueMeta();
      return { ok: true, stats: { leadCount: leadCount || 0, quota, queueMeta: meta } };
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

console.log('[LeadHarvest] Background service worker ready (v5.0.0)');
