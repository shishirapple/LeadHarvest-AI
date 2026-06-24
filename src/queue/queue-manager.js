// LeadHarvest AI - Queue Manager UI (v5.0.2)
// Handles UI rendering, event delegation, and storage synchronization

let currentQueue = [];
let currentLeads = [];

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initializeUI();
  loadQueue();
  
  // Listen for storage changes to keep UI in sync
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if (changes.queue || changes.leads) {
        loadQueue();
      }
    }
  });
});

// Initialize UI event listeners using event delegation
function initializeUI() {
  // Form submission
  const addTaskForm = document.getElementById('addTaskForm');
  if (addTaskForm) {
    addTaskForm.addEventListener('submit', handleAddTask);
  }
  
  // Queue control buttons
  document.getElementById('btnStartQueue')?.addEventListener('click', handleStartQueue);
  document.getElementById('btnPauseQueue')?.addEventListener('click', handlePauseQueue);
  document.getElementById('btnResumeQueue')?.addEventListener('click', handleResumeQueue);
  document.getElementById('btnStopQueue')?.addEventListener('click', handleStopQueue);
  document.getElementById('btnClearCompleted')?.addEventListener('click', handleClearCompleted);
  document.getElementById('btnClearAll')?.addEventListener('click', handleClearAll);
  document.getElementById('btnExport')?.addEventListener('click', handleExport);
  
  // Task list actions (event delegation)
  const taskList = document.getElementById('taskList');
  if (taskList) {
    taskList.addEventListener('click', handleTaskActions);
  }
}

// Load queue from storage
async function loadQueue() {
  try {
    const response = await sendMessage({ type: 'GET_QUEUE' });
    
    if (response.success) {
      currentQueue = response.queue || [];
      currentLeads = response.leads || [];
      
      renderStats();
      renderTaskList();
      updateControlButtons();
    }
  } catch (error) {
    console.error('Error loading queue:', error);
    showToast('Failed to load queue', 'error');
  }
}

// Render statistics
function renderStats() {
  const total = currentQueue.length;
  const pending = currentQueue.filter(t => t.status === 'pending').length;
  const running = currentQueue.filter(t => t.status === 'running').length;
  const completed = currentQueue.filter(t => t.status === 'completed').length;
  const totalLeads = currentQueue.reduce((sum, t) => sum + (t.collected || 0), 0);
  
  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-pending').textContent = pending;
  document.getElementById('stat-running').textContent = running;
  document.getElementById('stat-completed').textContent = completed;
  document.getElementById('stat-leads').textContent = totalLeads;
}

// Render task list
function renderTaskList() {
  const taskList = document.getElementById('taskList');
  if (!taskList) return;
  
  if (currentQueue.length === 0) {
    taskList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <div class="empty-state-text">No tasks in queue</div>
        <div class="empty-state-subtext">Add your first task to get started</div>
      </div>
    `;
    return;
  }
  
  taskList.innerHTML = currentQueue.map(task => {
    const progress = task.target > 0 ? Math.min(100, Math.round((task.collected / task.target) * 100)) : 0;
    const statusClass = `status-${task.status}`;
    const itemClass = `task-item ${task.status}`;
    
    let actionButtons = '';
    
    if (task.status === 'pending') {
      actionButtons = `
        <button class="btn btn-sm btn-danger" data-action="delete" data-task-id="${task.id}">🗑 Delete</button>
        <button class="btn btn-sm btn-secondary" data-action="moveUp" data-task-id="${task.id}">↑ Up</button>
        <button class="btn btn-sm btn-secondary" data-action="moveDown" data-task-id="${task.id}">↓ Down</button>
      `;
    } else if (task.status === 'running') {
      actionButtons = `
        <span style="font-size: 12px; color: var(--gray-500);">Processing...</span>
      `;
    } else if (task.status === 'paused') {
      actionButtons = `
        <button class="btn btn-sm btn-primary" data-action="resume" data-task-id="${task.id}">▶ Resume</button>
        <button class="btn btn-sm btn-danger" data-action="stop" data-task-id="${task.id}">⏹ Stop</button>
      `;
    } else if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      actionButtons = `
        <button class="btn btn-sm btn-secondary" data-action="retry" data-task-id="${task.id}">🔄 Retry</button>
        <button class="btn btn-sm btn-danger" data-action="delete" data-task-id="${task.id}">🗑 Delete</button>
      `;
    }
    
    const startTime = task.startTime ? new Date(task.startTime).toLocaleString() : '-';
    const endTime = task.endTime ? new Date(task.endTime).toLocaleString() : '-';
    
    return `
      <div class="${itemClass}" data-task-id="${task.id}">
        <div class="task-header">
          <div class="task-info">
            <div class="task-query">${escapeHtml(task.query)}</div>
            <div class="task-meta">
              📍 ${task.source === 'maps' ? 'Google Maps' : task.source} | 
              🎯 Target: ${task.target} | 
              ⏱ Started: ${startTime}
            </div>
          </div>
          <span class="task-status ${statusClass}">${task.status}</span>
        </div>
        
        <div class="progress-container">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progress}%"></div>
          </div>
          <div class="progress-text">${task.collected || 0} / ${task.target} leads collected (${progress}%)</div>
        </div>
        
        ${endTime !== '-' ? `<div class="task-meta" style="margin-bottom: 8px;">⏹ Ended: ${endTime}</div>` : ''}
        
        <div class="task-actions">
          ${actionButtons}
        </div>
      </div>
    `;
  }).join('');
}

// Handle task actions (event delegation)
function handleTaskActions(event) {
  const target = event.target.closest('button');
  if (!target) return;
  
  const action = target.dataset.action;
  const taskId = target.dataset.taskId;
  
  if (!action || !taskId) return;
  
  switch (action) {
    case 'delete':
      deleteTask(taskId);
      break;
    case 'moveUp':
      moveTask(taskId, 'up');
      break;
    case 'moveDown':
      moveTask(taskId, 'down');
      break;
    case 'resume':
      resumeTask(taskId);
      break;
    case 'stop':
      stopTask(taskId);
      break;
    case 'retry':
      retryTask(taskId);
      break;
  }
}

// Handle add task form submission
async function handleAddTask(event) {
  event.preventDefault();
  
  const query = document.getElementById('taskQuery').value.trim();
  const source = document.getElementById('taskSource').value;
  const target = parseInt(document.getElementById('taskTarget').value);
  const priority = document.getElementById('taskPriority').value;
  
  if (!query) {
    showToast('Please enter a search query', 'error');
    return;
  }
  
  const response = await sendMessage({
    type: 'ADD_TASK',
    task: { query, source, target, priority }
  });
  
  if (response.success) {
    showToast('Task added to queue', 'success');
    document.getElementById('taskQuery').value = '';
    document.getElementById('taskTarget').value = '100';
    document.getElementById('taskPriority').value = 'medium';
    loadQueue();
  } else {
    showToast(response.error || 'Failed to add task', 'error');
  }
}

// Handle queue controls
async function handleStartQueue() {
  const response = await sendMessage({ type: 'START_QUEUE' });
  if (response.success) {
    showToast('Queue started', 'success');
  } else {
    showToast(response.error || 'Failed to start queue', 'error');
  }
}

async function handlePauseQueue() {
  const response = await sendMessage({ type: 'PAUSE_QUEUE' });
  if (response.success) {
    showToast('Queue paused', 'success');
  } else {
    showToast(response.error || 'Failed to pause queue', 'error');
  }
}

async function handleResumeQueue() {
  const response = await sendMessage({ type: 'RESUME_QUEUE' });
  if (response.success) {
    showToast('Queue resumed', 'success');
  } else {
    showToast(response.error || 'Failed to resume queue', 'error');
  }
}

async function handleStopQueue() {
  const response = await sendMessage({ type: 'STOP_QUEUE' });
  if (response.success) {
    showToast('Queue stopped', 'success');
  } else {
    showToast(response.error || 'Failed to stop queue', 'error');
  }
}

async function handleClearCompleted() {
  const response = await sendMessage({ type: 'CLEAR_COMPLETED' });
  if (response.success) {
    showToast('Completed tasks cleared', 'success');
  } else {
    showToast(response.error || 'Failed to clear completed tasks', 'error');
  }
}

async function handleClearAll() {
  if (!confirm('Are you sure you want to clear all tasks? This cannot be undone.')) {
    return;
  }
  
  const response = await sendMessage({ type: 'CLEAR_ALL' });
  if (response.success) {
    showToast('All tasks cleared', 'success');
  } else {
    showToast(response.error || 'Failed to clear all tasks', 'error');
  }
}

async function handleExport() {
  const completedTasks = currentQueue.filter(t => t.status === 'completed');
  
  if (completedTasks.length === 0) {
    showToast('No completed tasks to export', 'warning');
    return;
  }
  
  const taskIds = completedTasks.map(t => t.id);
  const response = await sendMessage({ type: 'EXPORT_LEADS', taskIds });
  
  if (response.success) {
    showToast('Export started', 'success');
  } else {
    showToast(response.error || 'Failed to export leads', 'error');
  }
}

// Individual task actions
async function deleteTask(taskId) {
  if (!confirm('Are you sure you want to delete this task?')) {
    return;
  }
  
  const response = await sendMessage({ type: 'DELETE_TASK', taskId });
  if (response.success) {
    showToast('Task deleted', 'success');
  } else {
    showToast(response.error || 'Failed to delete task', 'error');
  }
}

async function moveTask(taskId, direction) {
  const response = await sendMessage({ type: 'MOVE_TASK', taskId, direction });
  if (response.success) {
    showToast(`Task moved ${direction}`, 'success');
  } else {
    showToast(response.error || 'Failed to move task', 'error');
  }
}

async function resumeTask(taskId) {
  const response = await sendMessage({ type: 'RESUME_QUEUE' });
  if (response.success) {
    showToast('Task resumed', 'success');
  } else {
    showToast(response.error || 'Failed to resume task', 'error');
  }
}

async function stopTask(taskId) {
  const response = await sendMessage({ type: 'STOP_QUEUE' });
  if (response.success) {
    showToast('Task stopped', 'success');
  } else {
    showToast(response.error || 'Failed to stop task', 'error');
  }
}

async function retryTask(taskId) {
  const task = currentQueue.find(t => t.id === taskId);
  if (!task) return;
  
  // Reset task status and collected count
  const data = await chrome.storage.local.get(['queue']);
  const queue = data.queue || [];
  const taskIndex = queue.findIndex(t => t.id === taskId);
  
  if (taskIndex !== -1) {
    queue[taskIndex].status = 'pending';
    queue[taskIndex].collected = 0;
    queue[taskIndex].startTime = null;
    queue[taskIndex].endTime = null;
    queue[taskIndex].sessionId = null;
    
    await chrome.storage.local.set({ queue });
    showToast('Task reset and ready to retry', 'success');
  }
}

// Update control button states
function updateControlButtons() {
  const hasRunning = currentQueue.some(t => t.status === 'running');
  const hasPaused = currentQueue.some(t => t.status === 'paused');
  const hasPending = currentQueue.some(t => t.status === 'pending');
  
  document.getElementById('btnStartQueue').disabled = !hasPending || hasRunning;
  document.getElementById('btnPauseQueue').disabled = !hasRunning;
  document.getElementById('btnResumeQueue').disabled = !hasPaused;
  document.getElementById('btnStopQueue').disabled = !hasRunning && !hasPaused;
}

// Send message to background script
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Show toast notification
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
