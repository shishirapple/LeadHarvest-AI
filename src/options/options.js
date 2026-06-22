/**
 * LeadHarvest AI — Options Page Script (v4.0)
 */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);

  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false });
      });
    });
  }

  function showStatus(id, type, html) {
    const el = $(`#${id}`);
    if (!el) return;
    el.className = `status-box ${type}`;
    el.innerHTML = html;
    el.style.display = 'flex';
  }
  function hideStatus(id) {
    const el = $(`#${id}`);
    if (el) el.style.display = 'none';
  }

  async function loadSettings() {
    const resp = await sendMsg({ type: 'GET_SETTINGS' });
    if (!resp?.ok) return;
    const s = resp.settings;
    $('#extractEmailsFromWebsite').checked = s.extractEmailsFromWebsite !== false;
    $('#rateLimitEnabled').checked = s.rateLimitEnabled !== false;
    $('#autoScroll').checked = s.autoScroll !== false;
    $('#customDelay').value = s.customDelay || 0;
    $('#exportFormat').value = s.exportFormat || 'csv';
  }

  $('#btnSaveSettings').addEventListener('click', async () => {
    const settings = {
      extractEmailsFromWebsite: $('#extractEmailsFromWebsite').checked,
      rateLimitEnabled: $('#rateLimitEnabled').checked,
      autoScroll: $('#autoScroll').checked,
      customDelay: parseInt($('#customDelay').value, 10) || 0,
      exportFormat: $('#exportFormat').value,
    };
    const resp = await sendMsg({ type: 'SAVE_SETTINGS', settings });
    if (resp?.ok) {
      showStatus('settingsStatus', 'success', '&#9989; Settings saved successfully!');
      setTimeout(() => hideStatus('settingsStatus'), 3000);
    } else {
      showStatus('settingsStatus', 'error', `&#10060; Failed to save: ${resp?.error || 'Unknown error'}`);
    }
  });

  $('#btnResetDefaults').addEventListener('click', async () => {
    const settings = { extractEmailsFromWebsite: true, rateLimitEnabled: true, autoScroll: true, customDelay: 0, exportFormat: 'csv' };
    await sendMsg({ type: 'SAVE_SETTINGS', settings });
    await loadSettings();
    showStatus('settingsStatus', 'info', '&#128260; Settings reset to defaults.');
    setTimeout(() => hideStatus('settingsStatus'), 3000);
  });

  async function refreshQuota() {
    const resp = await sendMsg({ type: 'GET_QUOTA' });
    if (resp?.ok) {
      const { count, cap, date } = resp.quota;
      $('#quotaCount').innerHTML = `${count} <span>/ ${cap}</span>`;
      const pct = cap > 0 ? Math.min(100, Math.round((count / cap) * 100)) : 0;
      $('#quotaBarFill').style.width = pct + '%';
      $('#quotaDate').textContent = `Last reset: ${date}`;
    }
  }

  $('#btnResetQuota').addEventListener('click', async () => {
    if (confirm("Reset today's quota to 0? This does not affect already captured leads.")) {
      await sendMsg({ type: 'RESET_QUOTA' });
      await refreshQuota();
      showStatus('settingsStatus', 'success', '&#9989; Quota reset for today.');
      setTimeout(() => hideStatus('settingsStatus'), 3000);
    }
  });

  $('#btnClearAll').addEventListener('click', async () => {
    if (confirm('This will permanently delete ALL captured leads and session history. Are you sure?')) {
      if (confirm('This action CANNOT be undone. Final confirmation?')) {
        await chrome.storage.local.clear();
        await sendMsg({ type: 'RESET_QUOTA' });
        const fresh = { date: new Date().toISOString().slice(0, 10), count: 0, cap: 500 };
        await chrome.storage.local.set({ quota: fresh });
        showStatus('settingsStatus', 'success', '&#128465; All data cleared.');
        await refreshQuota();
        setTimeout(() => hideStatus('settingsStatus'), 3000);
      }
    }
  });

  async function init() {
    await loadSettings();
    await refreshQuota();
  }
  init();
})();
