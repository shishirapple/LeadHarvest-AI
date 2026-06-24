/**
 * LeadHarvest AI — Queue Manager (v5.0)
 * Professional lead-generation pipeline with scheduling, recovery, and bulk export
 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // Queue state
  let queueTasks = [];
  let currentTaskId = null;
  let queueStatus = 'idle'; // idle, running, paused, scheduled, stopped
  let scheduleTime = null;
  let totalLeadsCollected = 0;

  // DOM Elements
  const els = {
    // Stats
    statTotal: $('#statTotal'),
    statPending: $('#statPending'),
    statRunning: $('#statRunning'),
    statCompleted: $('#statCompleted'),
    statFailed: $('#statFailed'),
    statLeadsCollected: $('#statLeadsCollected'),
    
    // Form
    taskQuery: $('#taskQuery'),
    taskSource: $('#taskSource'),
    taskLimit: $('#taskLimit'),
    taskPriority: $('#taskPriority'),
    btnAddTask: $('#btnAddTask'),
    duplicateWarning: $('#duplicateWarning'),
    
    // Controls
    btnStartQueue: $('#btnStartQueue'),
    btnPauseQueue: $('#btnPauseQueue'),
    btnResumeQueue: $('#btnResumeQueue'),
    btnStopQueue: $('#btnStopQueue'),
    btnClearCompleted: $('#btnClearCompleted'),
    btnClearAll: $('#btnClearAll'),
    
    // Task List
    taskList: $('#taskList'),
    
    // Schedule
    scheduleModeRadios: $$('input[name="scheduleMode"]'),
    datetimeInput: $('#datetimeInput'),
    scheduleDateTime: $('#scheduleDateTime'),
    estimatedTime: $('#estimatedTime'),
    estimatedTasks: $('#estimatedTasks'),
    
    // Export
    btnExportCurrent: $('#btnExportCurrent'),
    btnExportAll: $('#btnExportAll'),
    btnExportFullQueue: $('#btnExportFullQueue'),
    
    // Navigation
    btnBackToOptions: $('#btnBackToOptions'),
    btnPopup: $('#btnPopup'),
    
    // Toasts
    toastContainer: $('#toastContainer'),
  };

  /* ─── Utility Functions ─── */
  function generateId() {
    return 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  function ts() {
    return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) return '--:--:--';
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  function formatDateTime(isoString) {
    if (!isoString) return '--';
    const date = new Date(isoString);
    return date.toLocaleString();
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false });
      });
    });
  }

  /* ─── Storage Functions ─── */
  async function loadQueue() {
    const data = await chrome.storage.local.get(['queueTasks', 'queueStatus', 'currentTaskId', 'totalLeadsCollected']);
    queueTasks = data.queueTasks || [];
    queueStatus = data.queueStatus || 'idle';
    currentTaskId = data.currentTaskId || null;
    totalLeadsCollected = data.totalLeadsCollected || 0;
    
    // Check for scheduled task that should run now
    if (queueStatus === 'scheduled' && scheduleTime) {
      const now = new Date();
      const scheduleDate = new Date(scheduleTime);
      if (now >= scheduleDate) {
        queueStatus = 'idle';
        startQueue();
      }
    }
    
    renderTaskList();
    updateStats();
    updateControls();
  }

  async function saveQueue() {
    await chrome.storage.local.set({
      queueTasks,
      queueStatus,
      currentTaskId,
      totalLeadsCollected,
    });
  }

  /* ─── Task Management ─── */
  function checkDuplicate(query) {
    return queueTasks.some(t => t.query.toLowerCase() === query.toLowerCase() && t.status !== 'completed' && t.status !== 'failed');
  }

  function addTask() {
    const query = els.taskQuery.value.trim();
    const source = els.taskSource.value;
    const limit = parseInt(els.taskLimit.value, 10) || 100;
    const priority = els.taskPriority.value;

    if (!query) {
      showToast('Please enter a search query', 'error');
      return;
    }

    if (checkDuplicate(query)) {
      els.duplicateWarning.classList.add('visible');
      showToast('This query already exists in the queue', 'error');
      return;
    }

    const task = {
      id: generateId(),
      query,
      source,
      targetLeads: Math.min(limit, 5000),
      priority,
      status: 'pending',
      collectedLeads: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      duration: 0,
      sessionId: null,
      errorMessage: null,
    };

    queueTasks.push(task);
    saveQueue();
    renderTaskList();
    updateStats();
    updateControls();
    updateEstimatedTime();

    els.taskQuery.value = '';
    els.taskLimit.value = '100';
    els.taskPriority.value = 'medium';
    els.duplicateWarning.classList.remove('visible');
    showToast('Task added to queue', 'success');
  }

  function removeTask(taskId) {
    const index = queueTasks.findIndex(t => t.id === taskId);
    if (index === -1) return;
    
    const task = queueTasks[index];
    if (task.status === 'running') {
      showToast('Cannot remove a running task', 'error');
      return;
    }

    queueTasks.splice(index, 1);
    saveQueue();
    renderTaskList();
    updateStats();
    updateControls();
    updateEstimatedTime();
    showToast('Task removed from queue', 'info');
  }

  function clearCompleted() {
    queueTasks = queueTasks.filter(t => t.status !== 'completed');
    saveQueue();
    renderTaskList();
    updateStats();
    updateControls();
    showToast('Completed tasks cleared', 'info');
  }

  function clearAll() {
    if (queueStatus === 'running' || queueStatus === 'paused') {
      showToast('Stop the queue first before clearing all', 'error');
      return;
    }
    if (confirm('Remove all tasks from the queue? This cannot be undone.')) {
      queueTasks = [];
      queueStatus = 'idle';
      currentTaskId = null;
      saveQueue();
      renderTaskList();
      updateStats();
      updateControls();
      showToast('All tasks cleared', 'info');
    }
  }

  /* ─── Queue Execution ─── */
  async function startQueue() {
    const pendingTasks = queueTasks.filter(t => t.status === 'pending');
    if (pendingTasks.length === 0) {
      showToast('No pending tasks in queue', 'error');
      return;
    }

    queueStatus = 'running';
    await saveQueue();
    updateControls();
    processNextTask();
  }

  async function processNextTask() {
    const pendingTask = queueTasks.find(t => t.status === 'pending');
    if (!pendingTask) {
      queueStatus = 'idle';
      currentTaskId = null;
      await saveQueue();
      updateControls();
      showToast('Queue completed! All tasks finished.', 'success');
      return;
    }

    currentTaskId = pendingTask.id;
    pendingTask.status = 'running';
    pendingTask.startedAt = new Date().toISOString();
    await saveQueue();
    renderTaskList();
    updateStats();
    updateControls();

    // Start the actual scraping
    try {
      const fields = ['name', 'phone', 'website', 'email', 'address', 'rating', 'reviews'];
      const resp = await sendMsg({
        type: 'START_SCRAPE',
        query: pendingTask.query,
        fields,
        limit: pendingTask.targetLeads,
        taskId: pendingTask.id,
      });

      if (resp?.ok) {
        pendingTask.sessionId = resp.sessionId;
        await saveQueue();
        showToast(`Started: ${pendingTask.query}`, 'info');
      } else {
        throw new Error(resp?.error || 'Failed to start task');
      }
    } catch (err) {
      pendingTask.status = 'failed';
      pendingTask.errorMessage = err.message;
      pendingTask.completedAt = new Date().toISOString();
      await saveQueue();
      renderTaskList();
      showToast(`Task failed: ${err.message}`, 'error');
      processNextTask();
    }
  }

  async function pauseQueue() {
    if (queueStatus !== 'running') return;
    queueStatus = 'paused';
    await saveQueue();
    
    // Send pause signal to content script
    const tabs = await chrome.tabs.query({ url: ['*://www.google.com/maps/*', '*://maps.google.com/*'] });
    if (tabs.length > 0) {
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { type: 'PAUSE_EXTRACTION' });
      } catch (e) {}
    }
    
    updateControls();
    showToast('Queue paused', 'info');
  }

  async function resumeQueue() {
    if (queueStatus !== 'paused') return;
    queueStatus = 'running';
    await saveQueue();
    
    // Send resume signal to content script
    const tabs = await chrome.tabs.query({ url: ['*://www.google.com/maps/*', '*://maps.google.com/*'] });
    if (tabs.length > 0) {
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { type: 'RESUME_EXTRACTION' });
      } catch (e) {}
    }
    
    updateControls();
    showToast('Queue resumed', 'info');
  }

  async function stopQueue() {
    if (queueStatus !== 'running' && queueStatus !== 'paused') return;
    queueStatus = 'stopped';
    
    // Send stop signal to content script
    const tabs = await chrome.tabs.query({ url: ['*://www.google.com/maps/*', '*://maps.google.com/*'] });
    if (tabs.length > 0) {
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_EXTRACTION' });
      } catch (e) {}
    }
    
    // Mark current task as cancelled
    if (currentTaskId) {
      const task = queueTasks.find(t => t.id === currentTaskId);
      if (task && task.status === 'running') {
        task.status = 'cancelled';
        task.completedAt = new Date().toISOString();
      }
    }
    
    currentTaskId = null;
    await saveQueue();
    renderTaskList();
    updateStats();
    updateControls();
    showToast('Queue stopped', 'info');
  }

  async function scheduleQueue() {
    const selectedMode = Array.from(els.scheduleModeRadios).find(r => r.checked)?.value;
    if (selectedMode === 'scheduled') {
      const dateTimeValue = els.scheduleDateTime.value;
      if (!dateTimeValue) {
        showToast('Please select a date and time', 'error');
        return;
      }
      scheduleTime = new Date(dateTimeValue).toISOString();
      
      // Set browser alarm
      const alarmTime = new Date(dateTimeValue).getTime();
      const now = Date.now();
      if (alarmTime <= now) {
        showToast('Scheduled time must be in the future', 'error');
        return;
      }
      
      await chrome.alarms.create('queueAlarm', { when: alarmTime });
      queueStatus = 'scheduled';
      await saveQueue();
      updateControls();
      showToast(`Queue scheduled for ${formatDateTime(scheduleTime)}`, 'success');
    } else {
      startQueue();
    }
  }

  /* ─── Rendering ─── */
  function renderTaskList() {
    if (queueTasks.length === 0) {
      els.taskList.innerHTML = `
        <div class="empty-state">
          <div class="icon">&#128197;</div>
          <div class="msg">No tasks in queue. Add your first task above.</div>
        </div>`;
      return;
    }

    // Sort by priority (high > medium > low) then by creation time
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const sortedTasks = [...queueTasks].sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    els.taskList.innerHTML = sortedTasks.map(task => {
      const progress = task.targetLeads > 0 
        ? Math.round((task.collectedLeads / task.targetLeads) * 100) 
        : 0;
      
      const duration = task.startedAt 
        ? (task.completedAt ? new Date(task.completedAt) - new Date(task.startedAt) : Date.now() - new Date(task.startedAt))
        : 0;

      return `
        <div class="task-item ${task.status}" data-id="${task.id}">
          <div class="task-header">
            <span class="task-id">${task.id.substring(0, 12)}</span>
            <span class="task-status status-${task.status}">${task.status}</span>
          </div>
          <div class="task-query" title="${escapeHtml(task.query)}">${escapeHtml(task.query)}</div>
          <div class="task-meta">
            <span>&#128269; ${task.source === 'maps' ? 'Google Maps' : 'LinkedIn'}</span>
            <span>&#127919; ${task.collectedLeads} / ${task.targetLeads} leads</span>
            <span class="priority-badge priority-${task.priority}">${task.priority.toUpperCase()}</span>
          </div>
          <div class="task-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${progress}%"></div>
            </div>
            <div class="progress-text">
              <span>${progress}% complete</span>
              <span>${formatDuration(duration)}</span>
            </div>
          </div>
          ${task.startedAt ? `
          <div class="task-timing">
            <span>Started: ${formatDateTime(task.startedAt)}</span>
            ${task.completedAt ? `<span>Ended: ${formatDateTime(task.completedAt)}</span>` : ''}
          </div>` : ''}
          ${task.errorMessage ? `<div style="font-size:11px;color:var(--red);margin-bottom:8px;">⚠️ ${escapeHtml(task.errorMessage)}</div>` : ''}
          <div class="task-actions">
            ${task.status === 'pending' ? `
              <button class="btn btn-sm btn-danger" data-action="remove" data-task-id="${task.id}">&#10005; Remove</button>
            ` : ''}
            ${task.status === 'completed' ? `
              <button class="btn btn-sm btn-secondary" data-action="export" data-task-id="${task.id}">&#128190; Export</button>
            ` : ''}
            ${task.status === 'failed' ? `
              <button class="btn btn-sm btn-secondary" data-action="retry" data-task-id="${task.id}">&#128260; Retry</button>
            ` : ''}
          </div>
        </div>`;
    }).join('');
  }

  function updateStats() {
    const stats = {
      total: queueTasks.length,
      pending: queueTasks.filter(t => t.status === 'pending').length,
      running: queueTasks.filter(t => t.status === 'running').length,
      completed: queueTasks.filter(t => t.status === 'completed').length,
      failed: queueTasks.filter(t => t.status === 'failed').length,
    };

    els.statTotal.textContent = stats.total;
    els.statPending.textContent = stats.pending;
    els.statRunning.textContent = stats.running;
    els.statCompleted.textContent = stats.completed;
    els.statFailed.textContent = stats.failed;
    els.statLeadsCollected.textContent = totalLeadsCollected;

    // Update export button states
    const hasCompleted = stats.completed > 0;
    const currentTask = queueTasks.find(t => t.id === currentTaskId);
    els.btnExportCurrent.disabled = !(currentTask && currentTask.status === 'running' && currentTask.collectedLeads > 0);
    els.btnExportAll.disabled = !hasCompleted;
  }

  function updateControls() {
    const hasPending = queueTasks.some(t => t.status === 'pending');
    const isRunning = queueStatus === 'running';
    const isPaused = queueStatus === 'paused';

    els.btnStartQueue.disabled = !hasPending || isRunning || isPaused;
    els.btnPauseQueue.disabled = !isRunning;
    els.btnResumeQueue.disabled = !isPaused;
    els.btnStopQueue.disabled = !(isRunning || isPaused);
  }

  function updateEstimatedTime() {
    const pendingTasks = queueTasks.filter(t => t.status === 'pending');
    const totalTargetLeads = pendingTasks.reduce((sum, t) => sum + t.targetLeads, 0);
    
    // Estimate: ~3 seconds per lead average
    const estimatedMs = totalTargetLeads * 3000;
    els.estimatedTime.textContent = formatDuration(estimatedMs);
    els.estimatedTasks.textContent = `${pendingTasks.length} tasks, ~${totalTargetLeads} leads`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ─── Export Functions ─── */
  async function exportTask(taskId) {
    const task = queueTasks.find(t => t.id === taskId);
    if (!task) {
      showToast('Task not found', 'error');
      return;
    }

    try {
      const resp = await sendMsg({ type: 'GET_LEADS_BY_SESSION', sessionId: task.sessionId });
      if (!resp?.ok || !resp.leads?.length) {
        showToast('No leads found for this task', 'error');
        return;
      }

      const filename = `leadharvest-${task.query.replace(/[^a-z0-9]/gi, '-')}-${ts()}.csv`;
      downloadCSV(resp.leads, filename);
      showToast(`Exported ${resp.leads.length} leads`, 'success');
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'error');
    }
  }

  async function exportAllCompleted() {
    const completedTasks = queueTasks.filter(t => t.status === 'completed');
    if (completedTasks.length === 0) {
      showToast('No completed tasks to export', 'error');
      return;
    }

    try {
      const allLeads = [];
      for (const task of completedTasks) {
        const resp = await sendMsg({ type: 'GET_LEADS_BY_SESSION', sessionId: task.sessionId });
        if (resp?.ok && resp.leads?.length) {
          allLeads.push(...resp.leads.map(lead => ({
            ...lead,
            taskId: task.id,
            taskQuery: task.query,
            taskSource: task.source,
          })));
        }
      }

      if (allLeads.length === 0) {
        showToast('No leads found in completed tasks', 'error');
        return;
      }

      const filename = `leadharvest-bulk-export-${ts()}.xlsx`;
      downloadExcel(allLeads, filename);
      showToast(`Exported ${allLeads.length} leads from ${completedTasks.length} tasks`, 'success');
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'error');
    }
  }

  async function exportFullQueue() {
    try {
      const resp = await sendMsg({ type: 'GET_ALL_LEADS' });
      if (!resp?.ok || !resp.leads?.length) {
        showToast('No leads to export', 'error');
        return;
      }

      const filename = `leadharvest-full-export-${ts()}.xlsx`;
      downloadExcel(resp.leads, filename);
      showToast(`Exported ${resp.leads.length} leads`, 'success');
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'error');
    }
  }

  function downloadCSV(leads, filename) {
    const headers = ['Name', 'Phone', 'Email', 'Website', 'Address', 'Category', 'Rating', 'Reviews',
      'Google Ads', 'Website Platform', 'Lead Score', 'Hours', 'Source', 'Captured At'];
    const escape = (v) => {
      if (!v && v !== 0) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = leads.map(l => [
      l.name, l.phone, l.email, l.website, l.address, l.category, l.rating, l.reviews,
      l.googleAds ? 'Yes' : 'No', l.websitePlatform, l.leadScore, l.hours, l.source, l.capturedAt,
    ].map(escape).join(','));
    const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), filename);
  }

  function downloadExcel(leads, filename) {
    const headers = ['Task ID', 'Search Query', 'Source', 'Name', 'Phone', 'Email', 'Website', 'Address', 
      'Category', 'Rating', 'Reviews', 'Google Ads', 'Website Platform', 'Lead Score', 'Hours', 'Captured At'];
    const escape = (v) => {
      if (!v && v !== 0) return '';
      const s = String(v);
      return s.includes('\t') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = leads.map(l => [
      l.taskId || '', l.taskQuery || '', l.taskSource || l.source || '',
      l.name, l.phone, l.email, l.website, l.address, l.category, l.rating, l.reviews,
      l.googleAds ? 'Yes' : 'No', l.websitePlatform, l.leadScore, l.hours, l.capturedAt,
    ].map(escape).join('\t'));
    const tsv = '\uFEFF' + [headers.join('\t'), ...rows].join('\n');
    downloadBlob(new Blob([tsv], { type: 'application/vnd.ms-excel;charset=utf-8;' }), filename);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ─── Event Listeners ─── */
  els.btnAddTask.addEventListener('click', addTask);
  
  els.taskQuery.addEventListener('input', () => {
    const query = els.taskQuery.value.trim();
    if (query && checkDuplicate(query)) {
      els.duplicateWarning.classList.add('visible');
    } else {
      els.duplicateWarning.classList.remove('visible');
    }
  });

  els.btnStartQueue.addEventListener('click', scheduleQueue);
  els.btnPauseQueue.addEventListener('click', pauseQueue);
  els.btnResumeQueue.addEventListener('click', resumeQueue);
  els.btnStopQueue.addEventListener('click', stopQueue);
  els.btnClearCompleted.addEventListener('click', clearCompleted);
  els.btnClearAll.addEventListener('click', clearAll);

  // Event delegation for task list actions (remove, export, retry)
  els.taskList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    
    const action = btn.getAttribute('data-action');
    const taskId = btn.getAttribute('data-task-id');
    
    if (!taskId) return;
    
    if (action === 'remove') {
      removeTask(taskId);
    } else if (action === 'export') {
      exportTask(taskId);
    } else if (action === 'retry') {
      retryTask(taskId);
    }
  });

  els.scheduleModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      const isScheduled = radio.value === 'scheduled' && radio.checked;
      els.datetimeInput.style.display = isScheduled ? 'block' : 'none';
      if (radio.checked) {
        $$('.schedule-option').forEach(opt => opt.classList.remove('selected'));
        radio.closest('.schedule-option').classList.add('selected');
      }
    });
  });

  els.btnExportCurrent.addEventListener('click', () => {
    if (currentTaskId) exportTask(currentTaskId);
  });
  els.btnExportAll.addEventListener('click', exportAllCompleted);
  els.btnExportFullQueue.addEventListener('click', exportFullQueue);

  els.btnBackToOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  els.btnPopup.addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('src/popup/popup.html'),
      type: 'popup',
      width: 420,
      height: 600,
    });
  });

  /* ─── Message Listener ─── */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'QUEUE_TASK_UPDATE' && msg.taskId) {
      const task = queueTasks.find(t => t.id === msg.taskId);
      if (task) {
        task.collectedLeads = msg.collectedLeads || task.collectedLeads;
        if (msg.status) task.status = msg.status;
        if (msg.completedAt) task.completedAt = msg.completedAt;
        saveQueue();
        renderTaskList();
        updateStats();
      }
    }
    
    if (msg.type === 'LEAD_COUNT_UPDATE') {
      totalLeadsCollected = msg.count || totalLeadsCollected;
      updateStats();
    }
    
    if (msg.type === 'EXTRACTION_COMPLETE') {
      // Current task completed, process next
      if (currentTaskId) {
        const task = queueTasks.find(t => t.id === currentTaskId);
        if (task && task.status === 'running') {
          task.status = 'completed';
          task.completedAt = new Date().toISOString();
          saveQueue();
        }
        currentTaskId = null;
        renderTaskList();
        updateStats();
        updateControls();
      }
      processNextTask();
    }
  });

  /* ─── Alarm Listener for Scheduled Tasks ─── */
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'queueAlarm') {
      queueStatus = 'idle';
      startQueue();
    }
  });

  /* ─── Initialization ─── */
  async function init() {
    await loadQueue();
    
    // Set minimum datetime to now
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    els.scheduleDateTime.min = now.toISOString().slice(0, 16);
    
    // Update estimated time periodically
    setInterval(updateEstimatedTime, 5000);
    
    // Define retryTask function (used by event delegation)
    window.retryTask = async (taskId) => {
      const task = queueTasks.find(t => t.id === taskId);
      if (task) {
        task.status = 'pending';
        task.errorMessage = null;
        task.startedAt = null;
        task.completedAt = null;
        await saveQueue();
        renderTaskList();
        updateStats();
        showToast('Task queued for retry', 'info');
      }
    };
  }

  init();
})();
