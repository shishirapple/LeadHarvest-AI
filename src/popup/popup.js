/**
 * LeadHarvest AI — Popup Script (v4.0)
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  let isRunning = false;
  let capturedCount = 0;
  let dupesCount = 0;
  let adsCount = 0;
  let allLeads = [];
  let activeFilter = 'all';
  let searchTerm = '';

  const els = {
    detectBanner: $('#detectBanner'), detectText: $('#detectText'),
    statusBanner: $('#statusBanner'), statusDot: $('#statusDot'), statusText: $('#statusText'),
    query: $('#query'), limit: $('#limit'),
    btnRun: $('#btnRun'), btnStop: $('#btnStop'),
    statCaptured: $('#statCaptured'), statDupes: $('#statDupes'), statRunAds: $('#statRunAds'),
    progressFill: $('#progressFill'), quotaText: $('#quotaText'),
    recordsList: $('#recordsList'), recordSearch: $('#recordSearch'),
    recordsCountBadge: $('#recordsCountBadge'),
    pillTotal: $('#pillTotal'), pillEmail: $('#pillEmail'), pillNoSite: $('#pillNoSite'), pillAds: $('#pillAds'),
    exportStatus: $('#exportStatus'),
  };

  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false, error: 'No response' });
      });
    });
  }

  async function sendToMaps(msg) {
    const tabs = await chrome.tabs.query({ url: ['*://www.google.com/maps/*', '*://maps.google.com/*'] });
    if (tabs.length === 0) return { ok: false, error: 'No Google Maps tab found' };
    try {
      return await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => resolve(resp || { ok: false }));
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /* ─── Tabs ─── */
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#panel-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'records') loadRecords();
    });
  });

  $('#btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  /* ─── Limit presets ─── */
  $$('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      els.limit.value = btn.dataset.limit;
    });
  });
  els.limit.addEventListener('input', () => {
    $$('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.limit === els.limit.value));
  });

  /* ─── Auto-detection banner ─── */
  async function refreshDetectBanner() {
    const status = await sendToMaps({ type: 'GET_STATUS' });
    if (status?.ok && status.isSearchResults) {
      els.detectBanner.className = 'detect-banner detected';
      els.detectText.textContent = `\u2713 Google Maps detected${status.query ? ` — "${status.query}"` : ''}`;
      if (status.query && !els.query.value) els.query.value = status.query;
      els.btnRun.textContent = '\u25B6 Start Extraction';
    } else {
      els.detectBanner.className = 'detect-banner waiting';
      els.detectText.textContent = 'Open Google Maps and search for businesses to begin';
    }
  }

  /* ─── Status / stats ─── */
  function setStatus(type, text) {
    els.statusBanner.style.display = 'flex';
    els.statusBanner.className = `status-banner ${type}`;
    els.statusDot.className = `status-dot ${type}`;
    els.statusText.textContent = text;
  }

  async function refreshStats() {
    const resp = await sendMsg({ type: 'GET_STATS' });
    if (resp?.ok) {
      const { stats } = resp;
      els.quotaText.textContent = `${stats.quota?.count || 0} / ${stats.quota?.cap || 500}`;

      if (stats.activeSession) {
        setStatus('running', `Extracting... ${stats.activeSession.capturedCount || 0} leads`);
        isRunning = true;
        els.btnRun.disabled = true;
        els.btnStop.disabled = false;
      } else {
        const status = await sendToMaps({ type: 'GET_STATUS' });
        if (status?.ok && status.running) {
          setStatus('running', `Extracting... ${status.captured} leads captured`);
          isRunning = true;
          els.btnRun.disabled = true;
          els.btnStop.disabled = false;
          els.statCaptured.textContent = status.captured;
          els.statDupes.textContent = status.duplicates || 0;
        } else {
          els.statusBanner.style.display = 'none';
          isRunning = false;
          els.btnRun.disabled = false;
          els.btnStop.disabled = true;
        }
      }
    }
  }

  /* ─── Start / Stop ─── */
  els.btnRun.addEventListener('click', async () => {
    const query = els.query.value.trim();
    const limit = Math.min(parseInt(els.limit.value, 10) || 25, 500);
    const fields = Array.from($$('.field input:checked')).map(i => i.dataset.field);

    if (fields.length === 0) {
      setStatus('error', 'Select at least one field to extract');
      return;
    }

    setStatus('running', 'Starting extraction...');
    els.btnRun.disabled = true;
    els.btnStop.disabled = false;
    capturedCount = 0; dupesCount = 0; adsCount = 0;
    els.statCaptured.textContent = '0';
    els.statDupes.textContent = '0';
    els.statRunAds.textContent = '0';
    els.progressFill.style.width = '0%';

    const resp = await sendMsg({ type: 'START_SCRAPE', query, fields, limit });

    if (resp?.ok) {
      setStatus('running', resp.newTab
        ? 'Opened Google Maps. Extraction starts when results load...'
        : 'Extraction started — watch the on-page overlay.');
    } else {
      setStatus('error', resp?.error || 'Failed to start extraction');
      els.btnRun.disabled = false;
      els.btnStop.disabled = true;
    }
  });

  els.btnStop.addEventListener('click', async () => {
    setStatus('running', 'Stopping...');
    await sendToMaps({ type: 'STOP_EXTRACTION' });
    await sendMsg({ type: 'EXTRACTION_COMPLETE' });
    setStatus('ready', 'Stopped.');
    isRunning = false;
    els.btnRun.disabled = false;
    els.btnStop.disabled = true;
  });

  /* ─── Records tab ─── */
  function scoreToBadge(score) {
    if (!score || score === 'Standard') return null;
    if (score.startsWith('No Website')) return { cls: 'hot', label: 'No Website' };
    if (score.startsWith('DIY Builder')) return { cls: 'upgrade', label: score.split(' — ')[1] || 'Upgrade' };
    if (score.startsWith('Low Rating')) return { cls: 'upgrade', label: 'Low Rating' };
    if (score.startsWith('WordPress')) return { cls: 'upgrade', label: 'WordPress' };
    return null;
  }

  function matchesFilter(lead) {
    if (activeFilter === 'hasEmail' && !lead.email) return false;
    if (activeFilter === 'noWebsite' && lead.website) return false;
    if (activeFilter === 'ads' && !lead.googleAds) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const haystack = [lead.name, lead.email, lead.phone, lead.address, lead.website].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }

  function renderRecords() {
    const filtered = allLeads.filter(matchesFilter);
    els.recordsCountBadge.textContent = filtered.length;

    if (filtered.length === 0) {
      els.recordsList.innerHTML = `
        <div class="empty-state">
          <div class="icon">&#128203;</div>
          <div class="msg">${allLeads.length === 0 ? 'No leads captured yet. Run an extraction from the Scrape tab.' : 'No records match this filter.'}</div>
        </div>`;
      return;
    }

    els.recordsList.innerHTML = filtered.map(lead => {
      const badge = scoreToBadge(lead.leadScore);
      const adsBadge = lead.googleAds ? `<span class="badge ads">ADS</span>` : '';
      const scoreBadge = badge ? `<span class="badge ${badge.cls}">${badge.label}</span>` : '';

      const metaParts = [];
      metaParts.push(lead.phone ? `<span>&#128222; ${lead.phone}</span>` : `<span class="missing">no phone</span>`);
      metaParts.push(lead.email ? `<span>&#9993; ${lead.email}</span>` : `<span class="missing">no email</span>`);
      if (lead.website) metaParts.push(`<span>&#127760; ${lead.websitePlatform || 'site'}</span>`);

      return `
        <div class="record-card" data-id="${lead.id}">
          <div class="record-top">
            <div>
              <div class="record-name">${escapeHtml(lead.name)}</div>
              <div class="record-category">${escapeHtml(lead.category || lead.address || '')}</div>
            </div>
            <div class="record-badges">${adsBadge}${scoreBadge}</div>
          </div>
          <div class="record-meta">${metaParts.join('')}</div>
          <div class="record-actions">
            <button class="record-action-btn copy" title="Copy details" data-action="copy">&#128203;</button>
            <button class="record-action-btn delete" title="Delete" data-action="delete">&#10005;</button>
          </div>
        </div>`;
    }).join('');

    els.recordsList.querySelectorAll('.record-action-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const card = btn.closest('.record-card');
        const id = card.dataset.id;
        const lead = allLeads.find(l => l.id === id);
        if (btn.dataset.action === 'copy') {
          const text = [lead.name, lead.phone, lead.email, lead.website, lead.address].filter(Boolean).join(' | ');
          await navigator.clipboard.writeText(text);
          btn.innerHTML = '&#10003;';
          setTimeout(() => { btn.innerHTML = '&#128203;'; }, 1200);
        } else if (btn.dataset.action === 'delete') {
          await sendToMaps({ type: 'DELETE_LEAD', id });
          allLeads = allLeads.filter(l => l.id !== id);
          renderRecords();
          updatePills();
        }
      });
    });
  }

  function updatePills() {
    els.pillTotal.textContent = allLeads.length;
    els.pillEmail.textContent = allLeads.filter(l => l.email).length;
    els.pillNoSite.textContent = allLeads.filter(l => !l.website).length;
    els.pillAds.textContent = allLeads.filter(l => l.googleAds).length;
  }

  async function loadRecords() {
    const resp = await sendToMaps({ type: 'GET_ALL_LEADS' });
    if (resp?.ok) {
      allLeads = resp.leads || [];
      updatePills();
      renderRecords();
    }
  }

  els.recordSearch.addEventListener('input', () => {
    searchTerm = els.recordSearch.value.trim();
    renderRecords();
  });

  $$('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $$('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      renderRecords();
    });
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ─── Export tab ─── */
  function setExportStatus(type, text) {
    els.exportStatus.className = `export-status ${type}`;
    els.exportStatus.textContent = text;
  }

  $('#btnExportCSV').addEventListener('click', async () => {
    const data = await sendToMaps({ type: 'GET_ALL_LEADS' });
    if (data?.ok && data.leads?.length > 0) {
      const headers = ['Name', 'Phone', 'Email', 'Website', 'Address', 'Category', 'Rating', 'Reviews',
        'Google Ads', 'Website Platform', 'Lead Score', 'Hours', 'Source', 'Captured At'];
      const escape = (v) => {
        if (!v && v !== 0) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const rows = data.leads.map(l => [
        l.name, l.phone, l.email, l.website, l.address, l.category, l.rating, l.reviews,
        l.googleAds ? 'Yes' : 'No', l.websitePlatform, l.leadScore, l.hours, l.source, l.capturedAt,
      ].map(escape).join(','));
      const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n');
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `leadharvest-export-${ts()}.csv`);
      setExportStatus('success', `\u2705 Exported ${data.leads.length} leads as CSV`);
    } else {
      setExportStatus('error', data?.error || 'No leads to export. Run extraction first.');
    }
  });

  $('#btnExportXLSX').addEventListener('click', async () => {
    const data = await sendToMaps({ type: 'GET_ALL_LEADS' });
    if (data?.ok && data.leads?.length > 0) {
      const headers = ['Name', 'Phone', 'Email', 'Website', 'Address', 'Category', 'Rating', 'Reviews',
        'Google Ads', 'Website Platform', 'Lead Score', 'Hours', 'Source', 'Captured At'];
      const escape = (v) => {
        if (!v && v !== 0) return '';
        const s = String(v);
        return s.includes('\t') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const rows = data.leads.map(l => [
        l.name, l.phone, l.email, l.website, l.address, l.category, l.rating, l.reviews,
        l.googleAds ? 'Yes' : 'No', l.websitePlatform, l.leadScore, l.hours, l.source, l.capturedAt,
      ].map(escape).join('\t'));
      const tsv = '\uFEFF' + [headers.join('\t'), ...rows].join('\n');
      downloadBlob(new Blob([tsv], { type: 'application/vnd.ms-excel;charset=utf-8;' }), `leadharvest-export-${ts()}.xls`);
      setExportStatus('success', `\u2705 Exported ${data.leads.length} leads as Excel (.xls)`);
    } else {
      setExportStatus('error', data?.error || 'No leads to export. Run extraction first.');
    }
  });

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function ts() { return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19); }

  $('#btnClearAll').addEventListener('click', async () => {
    if (confirm('Delete all captured leads? This cannot be undone.')) {
      await sendToMaps({ type: 'CLEAR_ALL_LEADS' });
      await chrome.storage.local.set({ leadCount: 0 });
      allLeads = [];
      renderRecords();
      updatePills();
      setExportStatus('success', 'All data cleared.');
    }
  });

  /* ─── Live updates from background/content script ─── */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'LEAD_COUNT_UPDATE') {
      capturedCount = msg.count;
      els.statCaptured.textContent = capturedCount;
      const limit = parseInt(els.limit.value, 10) || 25;
      els.progressFill.style.width = Math.min(100, Math.round((capturedCount / limit) * 100)) + '%';
    }
    if (msg.type === 'EXTRACTION_COMPLETE') {
      isRunning = false;
      els.btnRun.disabled = false;
      els.btnStop.disabled = true;
      setStatus('ready', `Done — ${capturedCount} leads captured`);
      refreshStats();
    }
  });

  /* ─── Init ─── */
  async function init() {
    await refreshDetectBanner();
    await refreshStats();
    setInterval(refreshDetectBanner, 4000);
  }

  init();
})();
