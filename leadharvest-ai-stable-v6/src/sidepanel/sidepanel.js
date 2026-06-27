/**
 * LeadHarvest AI — Side Panel Script (v6.0)
 *
 * Changes vs v5:
 *  - Extract Fields: switched from <label> wrappers (caused double-toggle bug) to
 *    div.field-chip elements. Chips are toggled with a single JS click handler,
 *    no native checkbox involvement. Works correctly now.
 *  - Field chips built programmatically (single source-of-truth array).
 *  - Contrast/visibility improvements inherited from sidepanel.html.
 *  - escHtml moved to top so it is available everywhere.
 *  - Everything else (queue, records, export, drag-drop) unchanged from v5.
 */
(() => {
  'use strict';

  /* ─── Helpers ─── */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function sendMsg(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false });
      });
    });
  }

  async function sendToMaps(msg) {
    const tabs = await chrome.tabs.query({ url: ['*://www.google.com/maps/*', '*://maps.google.com/*'] });
    if (!tabs.length) return { ok: false, error: 'No Maps tab' };
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false });
        else resolve(resp || { ok: false });
      });
    });
  }

  /* ─── Field definitions ─── */
  const ALL_FIELDS = [
    { id: 'name',    label: 'Name',    defaultOn: true  },
    { id: 'phone',   label: 'Phone',   defaultOn: true  },
    { id: 'email',   label: 'Email',   defaultOn: true  },
    { id: 'website', label: 'Website', defaultOn: true  },
    { id: 'address', label: 'Address', defaultOn: true  },
    { id: 'rating',  label: 'Rating',  defaultOn: false },
    { id: 'reviews', label: 'Reviews', defaultOn: false },
    { id: 'hours',   label: 'Hours',   defaultOn: false },
  ];

  /**
   * Build a fields-grid into the given container.
   * @param {HTMLElement} container
   * @param {string[]} selectedIds  — which fields start ON
   * @returns getter function: () => string[]
   */
  function buildFieldGrid(container, selectedIds) {
    container.innerHTML = '';
    ALL_FIELDS.forEach(({ id, label }) => {
      const chip = document.createElement('div');
      chip.className = 'field-chip' + (selectedIds.includes(id) ? ' on' : '');
      chip.dataset.field = id;
      chip.innerHTML = `<span class="field-dot"></span>${label}`;

      // Single click handler — no checkbox, no double-fire
      chip.addEventListener('click', () => chip.classList.toggle('on'));

      container.appendChild(chip);
    });

    return () => [...container.querySelectorAll('.field-chip.on')].map(el => el.dataset.field);
  }

  /* ─── Build Add-Task field grid ─── */
  const defaultOn = ALL_FIELDS.filter(f => f.defaultOn).map(f => f.id);
  const getAddFields = buildFieldGrid($('#addFieldsGrid'), defaultOn);

  /* ─── State ─── */
  let queue = [];
  let queueMeta = { status: 'idle', activeTaskId: null, queuePaused: false };
  let allLeads = [];
  let activeFilter = 'all';
  let searchTerm = '';
  let activeTaskFilter = '';
  let expandedTasks = new Set();
  let editingTasks = new Set();

  /* ─── Tab switching ─── */
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

  /* ─── Detect banner ─── */
  async function refreshDetectBanner() {
    const status = await sendToMaps({ type: 'GET_STATUS' });
    const banner = $('#detectBanner');
    const text = $('#detectText');
    if (status?.ok && status.isSearchResults) {
      banner.className = 'detect-banner detected';
      text.textContent = `✓ Google Maps detected${status.query ? ` — "${status.query}"` : ''}`;
      if (status.query && !$('#addQuery').value) $('#addQuery').value = status.query;
    } else {
      banner.className = 'detect-banner waiting';
      text.textContent = 'Open Google Maps and search for businesses';
    }
  }

  /* ─── Quota badge ─── */
  async function refreshQuota() {
    const resp = await sendMsg('GET_QUOTA');
    if (resp?.ok) {
      $('#quotaBadge').textContent = `${resp.quota.count}/${resp.quota.cap}`;
    }
  }

  /* ─── Queue rendering ─── */
  function statusLabel(s) {
    const map = { pending: 'Pending', running: 'Running', paused: 'Paused', completed: 'Done', stopped: 'Stopped', cancelled: 'Cancelled', error: 'Error' };
    return map[s] || s;
  }

  function buildTaskCard(task) {
    const isActive = task.id === queueMeta.activeTaskId;
    const isEditing = editingTasks.has(task.id);
    const isExpanded = expandedTasks.has(task.id) || isEditing;
    const canEdit = task.status === 'pending';
    const pct = task.limit > 0 ? Math.min(100, Math.round((task.captured / task.limit) * 100)) : 0;

    const statusClass = isActive ? (queueMeta.queuePaused ? 'paused' : 'active') : task.status;
    const dotClass = isActive ? (queueMeta.queuePaused ? 'paused' : 'running') : task.status;

    const div = document.createElement('div');
    div.className = `task-card ${statusClass}`;
    div.dataset.id = task.id;
    div.draggable = canEdit;

    div.innerHTML = `
      <div class="task-header">
        ${canEdit ? '<span class="drag-handle" title="Drag to reorder">⠿</span>' : '<span style="width:18px"></span>'}
        <span class="task-status-dot ${dotClass}"></span>
        <div class="task-info">
          <div class="task-query">${escHtml(task.query || '(no query)')}<span class="tag-badge">${escHtml(task.tag || '')}</span></div>
          <div class="task-meta">
            Limit: ${task.limit} · ${statusLabel(isActive && queueMeta.queuePaused ? 'paused' : (isActive ? 'running' : task.status))}
            ${task.captured > 0 ? ` · ${task.captured} captured` : ''}
            ${task.duplicates > 0 ? ` · ${task.duplicates} dupes` : ''}
            ${task.errorMsg ? ` · ⚠ ${escHtml(task.errorMsg)}` : ''}
          </div>
        </div>
        <div class="task-actions">
          ${canEdit ? `<button class="btn btn-ghost btn-xs btn-edit-task" data-id="${task.id}" title="Edit">✏</button>` : ''}
          <button class="btn btn-ghost btn-xs btn-toggle-task" data-id="${task.id}" title="Expand">
            ${isExpanded ? '▲' : '▼'}
          </button>
          ${canEdit ? `<button class="btn btn-danger btn-xs btn-delete-task" data-id="${task.id}" title="Delete">✕</button>` : ''}
          ${task.status === 'completed' || task.status === 'stopped' ? `<button class="btn btn-ghost btn-xs btn-export-task" data-id="${task.id}" title="Export this task">↓</button>` : ''}
        </div>
      </div>
      <div class="task-progress-bar">
        <div class="task-progress-fill" style="width:${pct}%"></div>
      </div>
      ${isExpanded ? `<div class="task-body">${buildTaskBody(task, isEditing)}</div>` : ''}
    `;

    return div;
  }

  function buildTaskBody(task, editing) {
    const fields = task.fields || [];

    if (!editing) {
      return `
        <div style="font-size:11px; color:var(--text-dim); display:flex; flex-direction:column; gap:4px;">
          <div><span style="color:var(--text-mute);font-size:10px;text-transform:uppercase;letter-spacing:.8px;font-weight:700;">Fields</span><br>${fields.length ? fields.map(f => `<span style="display:inline-block;margin:2px 3px 0 0;padding:1px 6px;border-radius:3px;background:var(--bg);border:1px solid var(--border-hi);font-size:10px;color:var(--green)">${escHtml(f)}</span>`).join('') : '<span style="color:var(--text-mute)">—</span>'}</div>
          ${task.startedAt ? `<div><span style="color:var(--text-mute)">Started:</span> ${new Date(task.startedAt).toLocaleTimeString()}</div>` : ''}
          ${task.completedAt ? `<div><span style="color:var(--text-mute)">Completed:</span> ${new Date(task.completedAt).toLocaleTimeString()}</div>` : ''}
        </div>
      `;
    }

    // Edit form — field chips built after insertion via bindTaskCardEvents
    return `
      <div class="task-edit-form">
        <div class="form-row">
          <label>Query</label>
          <input type="text" class="edit-query" value="${escHtml(task.query || '')}" />
        </div>
        <div class="form-row-inline">
          <div>
            <label>Limit</label>
            <input type="number" class="edit-limit" value="${task.limit}" min="1" max="500" />
          </div>
          <div>
            <label>Tag</label>
            <input type="text" class="edit-tag" value="${escHtml(task.tag || '')}" />
          </div>
        </div>
        <div class="form-row">
          <label>Fields <span style="font-weight:400;color:var(--text-mute);font-size:10px;">(click to toggle)</span></label>
          <div class="fields-grid edit-fields-grid" data-task-id="${task.id}"></div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-primary btn-sm btn-save-edit" data-id="${task.id}">Save</button>
          <button class="btn btn-ghost btn-sm btn-cancel-edit" data-id="${task.id}">Cancel</button>
        </div>
      </div>
    `;
  }

  // Map from task.id → getFields() fn for edit grids
  const editFieldGetters = new Map();

  function renderQueue() {
    const list = $('#taskList');
    list.innerHTML = '';
    editFieldGetters.clear();

    if (queue.length === 0) {
      list.innerHTML = `<div class="empty-state">
        <div class="icon">📋</div>
        <div class="title">Queue is empty</div>
        <div class="sub">Fill in the form above and add your first task.<br>Each task is one search query.</div>
      </div>`;
      return;
    }

    queue.forEach(task => {
      const card = buildTaskCard(task);
      list.appendChild(card);
    });

    // Build edit-field grids (must be done after DOM insertion)
    $$('.edit-fields-grid').forEach(container => {
      const taskId = container.dataset.taskId;
      const task = queue.find(t => t.id === taskId);
      const selected = task?.fields || defaultOn;
      const getter = buildFieldGrid(container, selected);
      editFieldGetters.set(taskId, getter);
    });

    bindTaskCardEvents();
    bindDragDrop();
  }

  function bindTaskCardEvents() {
    $$('.btn-toggle-task').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (expandedTasks.has(id)) expandedTasks.delete(id);
        else expandedTasks.add(id);
        renderQueue();
      });
    });

    $$('.btn-edit-task').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        editingTasks.add(id);
        expandedTasks.add(id);
        renderQueue();
      });
    });

    $$('.btn-delete-task').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const resp = await sendMsg('QUEUE_DELETE_TASK', { taskId: btn.dataset.id });
        if (!resp.ok) alert(resp.error || 'Cannot delete');
        else await refreshQueue();
      });
    });

    $$('.btn-export-task').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await exportTaskLeads(btn.dataset.id);
      });
    });

    $$('.btn-save-edit').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const body = btn.closest('.task-body');
        const query = body.querySelector('.edit-query').value.trim();
        const limit = parseInt(body.querySelector('.edit-limit').value, 10) || 25;
        const tag = body.querySelector('.edit-tag').value.trim();
        const getFields = editFieldGetters.get(id);
        const fields = getFields ? getFields() : defaultOn;
        if (fields.length === 0) { alert('Select at least one field'); return; }
        await sendMsg('QUEUE_UPDATE_TASK', { taskId: id, query, limit, tag, fields });
        editingTasks.delete(id);
        await refreshQueue();
      });
    });

    $$('.btn-cancel-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        editingTasks.delete(btn.dataset.id);
        renderQueue();
      });
    });
  }

  /* ─── Drag & drop reorder ─── */
  let dragSrcId = null;

  function bindDragDrop() {
    $$('.task-card[draggable="true"]').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        dragSrcId = card.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        card.style.opacity = '0.5';
      });
      card.addEventListener('dragend', () => { card.style.opacity = ''; });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        $$('.task-card').forEach(c => c.classList.remove('drag-over'));
        card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', async (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const targetId = card.dataset.id;
        if (!dragSrcId || dragSrcId === targetId) return;
        const order = queue.map(t => t.id);
        const srcIdx = order.indexOf(dragSrcId);
        const tgtIdx = order.indexOf(targetId);
        if (srcIdx === -1 || tgtIdx === -1) return;
        order.splice(srcIdx, 1);
        order.splice(tgtIdx, 0, dragSrcId);
        await sendMsg('QUEUE_REORDER', { order });
        await refreshQueue();
      });
    });
  }

  /* ─── Queue control buttons ─── */
  $('#btnAddTask').addEventListener('click', async () => {
    const query = $('#addQuery').value.trim();
    const limit = parseInt($('#addLimit').value, 10) || 25;
    const tag = $('#addTag').value.trim();
    const fields = getAddFields();
    if (!query) { alert('Enter a search query'); return; }
    if (fields.length === 0) { alert('Select at least one field to extract'); return; }
    await sendMsg('QUEUE_ADD_TASK', { query, limit, tag, fields });
    $('#addQuery').value = '';
    $('#addTag').value = '';
    await refreshQueue();
  });

  $('#btnQueueStart').addEventListener('click', async () => {
    const pending = queue.filter(t => t.status === 'pending');
    if (pending.length === 0) { alert('No pending tasks in queue'); return; }
    await sendMsg('QUEUE_START');
    await refreshQueue();
  });

  $('#btnQueuePause').addEventListener('click', async () => {
    await sendMsg('QUEUE_PAUSE');
    await refreshQueue();
  });

  $('#btnQueueResume').addEventListener('click', async () => {
    await sendMsg('QUEUE_RESUME');
    await refreshQueue();
  });

  $('#btnQueueStop').addEventListener('click', async () => {
    if (!confirm('Stop the entire queue? All pending tasks will be cancelled.')) return;
    await sendMsg('QUEUE_STOP');
    await refreshQueue();
  });

  $('#btnStopTask').addEventListener('click', async () => {
    await sendMsg('TASK_STOP');
    await refreshQueue();
  });

  $('#btnClearDone').addEventListener('click', async () => {
    await sendMsg('QUEUE_CLEAR_DONE');
    await refreshQueue();
  });

  /* ─── Queue button states ─── */
  function updateQueueButtons() {
    const running = queueMeta.status === 'running' && !queueMeta.queuePaused;
    const paused = queueMeta.queuePaused;
    const idle = queueMeta.status === 'idle' || queueMeta.status === 'stopped';
    const hasActive = !!queueMeta.activeTaskId;

    $('#btnQueueStart').disabled = running || paused;
    $('#btnQueuePause').disabled = !running;
    $('#btnQueueResume').disabled = !paused;
    $('#btnQueueStop').disabled = idle && !hasActive;
    $('#btnStopTask').disabled = !hasActive;

    const dot = $('#queueStatusDot');
    const text = $('#queueStatusText');
    const count = $('#queueCountText');

    const pending = queue.filter(t => t.status === 'pending').length;
    const done = queue.filter(t => t.status === 'completed').length;
    const total = queue.length;

    count.textContent = total > 0 ? `${done}/${total} done` : '';

    if (running) {
      dot.className = 'status-dot running';
      const activeTask = queue.find(t => t.id === queueMeta.activeTaskId);
      text.textContent = `Running: "${activeTask?.query || '...'}" (${activeTask?.captured || 0} leads)`;
    } else if (paused) {
      dot.className = 'status-dot paused';
      text.textContent = `Paused — ${pending} pending`;
    } else if (queueMeta.status === 'stopped') {
      dot.className = 'status-dot error';
      text.textContent = 'Queue stopped';
    } else {
      dot.className = 'status-dot';
      text.textContent = pending > 0 ? `${pending} task${pending !== 1 ? 's' : ''} pending` : 'Queue idle';
    }
  }

  async function refreshQueue() {
    const resp = await sendMsg('GET_QUEUE');
    if (resp?.ok) {
      queue = resp.queue || [];
      queueMeta = resp.meta || { status: 'idle', activeTaskId: null, queuePaused: false };
    }
    renderQueue();
    updateQueueButtons();
    refreshQuota();
    refreshDetectBanner();
  }

  /* ─── Background messages ─── */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'QUEUE_UPDATED' || msg.type === 'LEAD_COUNT_UPDATE' || msg.type === 'EXTRACTION_COMPLETE') {
      refreshQueue();
      if ($('#panel-records').classList.contains('active')) loadRecords();
    }
  });

  /* ─── Records tab ─── */
  async function loadRecords() {
    const resp = await sendToMaps({ type: 'GET_ALL_LEADS', limit: 2000 });
    allLeads = resp?.ok ? (resp.leads || []) : [];
    updateStats();
    buildTaskFilterOptions();
    renderRecords();
  }

  function updateStats() {
    $('#statTotal').textContent = allLeads.length;
    $('#statEmail').textContent = allLeads.filter(l => l.email).length;
    $('#statNoSite').textContent = allLeads.filter(l => !l.website).length;
    $('#statAds').textContent = allLeads.filter(l => l.googleAds).length;
  }

  function buildTaskFilterOptions() {
    const sel = $('#taskFilter');
    const prev = sel.value;
    const ids = [...new Set(allLeads.map(l => l.session_id).filter(Boolean))];
    sel.innerHTML = '<option value="">All tasks</option>';
    ids.forEach(id => {
      const task = queue.find(t => t.id === id);
      const label = task ? `${task.query || id} (${task.tag || 'task'})` : id.slice(0, 12) + '…';
      sel.innerHTML += `<option value="${escHtml(id)}">${escHtml(label)}</option>`;
    });
    sel.value = prev;
  }

  function matchesLead(lead) {
    if (activeTaskFilter && lead.session_id !== activeTaskFilter) return false;
    if (activeFilter === 'hasEmail' && !lead.email) return false;
    if (activeFilter === 'noWebsite' && lead.website) return false;
    if (activeFilter === 'ads' && !lead.googleAds) return false;
    if (activeFilter === 'hot' && lead.leadScore === 'Standard') return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const hay = [lead.name, lead.email, lead.phone, lead.address, lead.website].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function badgeForScore(score) {
    if (!score || score === 'Standard') return '';
    if (score.startsWith('No Website')) return `<span class="record-badge badge-hot">No Website</span>`;
    if (score.startsWith('DIY Builder')) return `<span class="record-badge badge-cms">DIY Builder</span>`;
    if (score.startsWith('Low Rating')) return `<span class="record-badge badge-hot">Low Rating</span>`;
    if (score.startsWith('WordPress')) return `<span class="record-badge badge-cms">WordPress</span>`;
    return '';
  }

  function renderRecords() {
    const list = $('#recordsList');
    const filtered = allLeads.filter(matchesLead);
    list.innerHTML = '';

    if (filtered.length === 0) {
      list.innerHTML = `<div class="empty-state">
        <div class="icon">🔍</div>
        <div class="title">No records found</div>
        <div class="sub">Run a task to start capturing leads.</div>
      </div>`;
      return;
    }

    filtered.forEach(lead => {
      const div = document.createElement('div');
      div.className = 'record-card';
      div.innerHTML = `
        <div class="record-name">${escHtml(lead.name)}</div>
        <div class="record-details">
          ${lead.phone   ? `<div class="record-row"><span class="record-icon">📞</span>${escHtml(lead.phone)}</div>` : ''}
          ${lead.email   ? `<div class="record-row"><span class="record-icon">✉</span>${escHtml(lead.email)}</div>` : ''}
          ${lead.website ? `<div class="record-row"><span class="record-icon">🌐</span><span style="word-break:break-all">${escHtml(lead.website)}</span></div>` : ''}
          ${lead.address ? `<div class="record-row"><span class="record-icon">📍</span>${escHtml(lead.address)}</div>` : ''}
          ${lead.category? `<div class="record-row"><span class="record-icon">🏷</span>${escHtml(lead.category)}</div>` : ''}
          ${lead.rating  ? `<div class="record-row"><span class="record-icon">⭐</span>${lead.rating}${lead.reviews ? ` (${lead.reviews})` : ''}</div>` : ''}
        </div>
        <div>
          ${lead.googleAds ? `<span class="record-badge badge-ads">Google Ads</span>` : ''}
          ${lead.websitePlatform ? `<span class="record-badge badge-cms">${escHtml(lead.websitePlatform)}</span>` : ''}
          ${badgeForScore(lead.leadScore)}
        </div>
        <div class="record-actions">
          <button class="btn btn-danger btn-xs" data-del="${escHtml(lead.id)}">Delete</button>
        </div>
      `;
      list.appendChild(div);
    });

    $$('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await sendToMaps({ type: 'DELETE_LEAD', id: btn.dataset.del });
        await loadRecords();
      });
    });
  }

  $$('.filter-pills .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      $$('.filter-pills .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeFilter = pill.dataset.filter;
      renderRecords();
    });
  });

  $('#taskFilter').addEventListener('change', () => {
    activeTaskFilter = $('#taskFilter').value;
    renderRecords();
  });

  $('#recordSearch').addEventListener('input', () => {
    searchTerm = $('#recordSearch').value.trim();
    renderRecords();
  });

  /* ─── Export ─── */
  function leadsToCSV(leads) {
    const headers = ['name','phone','email','website','address','category','rating','reviews','hours','googleAds','websitePlatform','leadScore','mapsUrl','capturedAt'];
    const rows = [headers.join(',')];
    leads.forEach(lead => {
      const row = headers.map(h => {
        const v = lead[h];
        if (v === null || v === undefined) return '';
        const s = String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
        return s;
      });
      rows.push(row.join(','));
    });
    return rows.join('\n');
  }

  function downloadCSV(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    $('#exportMsg').textContent = `✓ Exported ${filename}`;
    setTimeout(() => { $('#exportMsg').textContent = ''; }, 4000);
  }

  async function exportTaskLeads(taskId) {
    const resp = await sendToMaps({ type: 'GET_ALL_LEADS', limit: 5000 });
    if (!resp?.ok) { alert('Could not fetch leads'); return; }
    const leads = (resp.leads || []).filter(l => l.session_id === taskId);
    if (leads.length === 0) { alert('No leads for this task'); return; }
    const task = queue.find(t => t.id === taskId);
    const slug = (task?.query || taskId).replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 30);
    downloadCSV(leadsToCSV(leads), `leadharvest-task-${slug}.csv`);
  }

  $('#btnExportFiltered').addEventListener('click', async () => {
    const resp = await sendToMaps({ type: 'GET_ALL_LEADS', limit: 5000 });
    if (!resp?.ok) { alert('Could not fetch leads'); return; }
    allLeads = resp.leads || [];
    const filtered = allLeads.filter(matchesLead);
    if (filtered.length === 0) { alert('No leads match current filter'); return; }
    downloadCSV(leadsToCSV(filtered), `leadharvest-filtered-${Date.now()}.csv`);
  });

  $('#btnExportAll').addEventListener('click', async () => {
    const resp = await sendToMaps({ type: 'GET_ALL_LEADS', limit: 5000 });
    if (!resp?.ok) { alert('Could not fetch leads'); return; }
    const leads = resp.leads || [];
    if (leads.length === 0) { alert('No leads to export'); return; }
    downloadCSV(leadsToCSV(leads), `leadharvest-all-${Date.now()}.csv`);
  });

  /* ─── Init ─── */
  async function init() {
    await refreshQueue();
    setInterval(refreshQueue, 3000);
    setInterval(refreshDetectBanner, 5000);
  }

  init();
})();
