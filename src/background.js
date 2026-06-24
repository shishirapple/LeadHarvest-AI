// LeadHarvest AI - Background Service Worker (v5.0.2)
// Handles queue management, tab control, and communication with content scripts

let currentTask = null;
let isProcessing = false;

// Initialize storage on extension install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    queue: [],
    leads: [],
    settings: {
      delayBetweenLeads: 2000,
      delayBetweenTasks: 3000
    }
  });
});

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // Keep message channel open for async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'ADD_TASK':
      return await addTask(message.task);
    
    case 'START_QUEUE':
      return await startQueue();
    
    case 'PAUSE_QUEUE':
      return await pauseQueue();
    
    case 'RESUME_QUEUE':
      return await resumeQueue();
    
    case 'STOP_QUEUE':
      return await stopQueue();
    
    case 'DELETE_TASK':
      return await deleteTask(message.taskId);
    
    case 'MOVE_TASK':
      return await moveTask(message.taskId, message.direction);
    
    case 'CLEAR_COMPLETED':
      return await clearCompleted();
    
    case 'CLEAR_ALL':
      return await clearAll();
    
    case 'UPDATE_PROGRESS':
      return await updateProgress(message.taskId, message.collected);
    
    case 'TASK_COMPLETE':
      return await taskComplete(message.taskId);
    
    case 'TASK_FAILED':
      return await taskFailed(message.taskId, message.error);
    
    case 'GET_QUEUE':
      return await getQueue();
    
    case 'EXPORT_LEADS':
      return await exportLeads(message.taskIds);
    
    default:
      console.error('Unknown message type:', message.type);
      return { success: false, error: 'Unknown message type' };
  }
}

// Add a new task to the queue
async function addTask(task) {
  try {
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    
    // Check for duplicates
    const exists = queue.some(t => t.query === task.query && t.source === task.source);
    if (exists) {
      return { success: false, error: 'Duplicate task: This query already exists in the queue' };
    }
    
    const newTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      query: task.query,
      source: task.source || 'maps',
      target: task.target || 100,
      collected: 0,
      priority: task.priority || 'medium',
      status: 'pending',
      startTime: null,
      endTime: null,
      sessionId: null
    };
    
    queue.push(newTask);
    await chrome.storage.local.set({ queue });
    
    return { success: true, task: newTask };
  } catch (error) {
    console.error('Error adding task:', error);
    return { success: false, error: error.message };
  }
}

// Start processing the queue
async function startQueue() {
  try {
    if (isProcessing) {
      return { success: false, error: 'Queue is already processing' };
    }
    
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    
    // Find first pending task
    const pendingTask = queue.find(t => t.status === 'pending');
    if (!pendingTask) {
      return { success: false, error: 'No pending tasks in queue' };
    }
    
    isProcessing = true;
    await processTask(pendingTask);
    
    return { success: true };
  } catch (error) {
    console.error('Error starting queue:', error);
    isProcessing = false;
    return { success: false, error: error.message };
  }
}

// Process a single task
async function processTask(task) {
  try {
    // Update task status to running
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    const taskIndex = queue.findIndex(t => t.id === task.id);
    
    if (taskIndex === -1) {
      throw new Error('Task not found in queue');
    }
    
    queue[taskIndex].status = 'running';
    queue[taskIndex].startTime = Date.now();
    queue[taskIndex].sessionId = `session_${Date.now()}_${task.id}`;
    
    await chrome.storage.local.set({ queue });
    
    // Build Google Maps search URL
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(task.query)}`;
    
    // Create new tab for scraping
    const tab = await chrome.tabs.create({ url: searchUrl });
    
    // Store current task info
    currentTask = {
      ...queue[taskIndex],
      tabId: tab.id
    };
    
    // Wait for content script to be ready and send extraction command
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'BEGIN_EXTRACTION',
          taskId: task.id,
          sessionId: queue[taskIndex].sessionId,
          target: task.target,
          query: task.query
        });
      } catch (error) {
        console.error('Error sending message to content script:', error);
        await taskFailed(task.id, 'Failed to inject content script');
      }
    }, 2000);
    
  } catch (error) {
    console.error('Error processing task:', error);
    await taskFailed(task.id, error.message);
  }
}

// Pause the current task
async function pauseQueue() {
  try {
    if (!currentTask) {
      return { success: false, error: 'No active task to pause' };
    }
    
    await chrome.tabs.sendMessage(currentTask.tabId, { type: 'PAUSE' });
    
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    const taskIndex = queue.findIndex(t => t.id === currentTask.id);
    
    if (taskIndex !== -1) {
      queue[taskIndex].status = 'paused';
      await chrome.storage.local.set({ queue });
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error pausing queue:', error);
    return { success: false, error: error.message };
  }
}

// Resume the current task
async function resumeQueue() {
  try {
    if (!currentTask) {
      return { success: false, error: 'No paused task to resume' };
    }
    
    await chrome.tabs.sendMessage(currentTask.tabId, { type: 'RESUME' });
    
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    const taskIndex = queue.findIndex(t => t.id === currentTask.id);
    
    if (taskIndex !== -1) {
      queue[taskIndex].status = 'running';
      await chrome.storage.local.set({ queue });
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error resuming queue:', error);
    return { success: false, error: error.message };
  }
}

// Stop the current task
async function stopQueue() {
  try {
    if (currentTask && currentTask.tabId) {
      await chrome.tabs.sendMessage(currentTask.tabId, { type: 'STOP' });
      await chrome.tabs.remove(currentTask.tabId);
    }
    
    if (currentTask) {
      const data = await chrome.storage.local.get(['queue']);
      const queue = data.queue || [];
      const taskIndex = queue.findIndex(t => t.id === currentTask.id);
      
      if (taskIndex !== -1) {
        queue[taskIndex].status = 'cancelled';
        queue[taskIndex].endTime = Date.now();
        await chrome.storage.local.set({ queue });
      }
    }
    
    currentTask = null;
    isProcessing = false;
    
    return { success: true };
  } catch (error) {
    console.error('Error stopping queue:', error);
    return { success: false, error: error.message };
  }
}

// Delete a task from the queue
async function deleteTask(taskId) {
  try {
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    const filteredQueue = queue.filter(t => t.id !== taskId);
    
    await chrome.storage.local.set({ queue: filteredQueue });
    
    return { success: true };
  } catch (error) {
    console.error('Error deleting task:', error);
    return { success: false, error: error.message };
  }
}

// Move task up or down in the queue
async function moveTask(taskId, direction) {
  try {
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    const index = queue.findIndex(t => t.id === taskId);
    
    if (index === -1) {
      return { success: false, error: 'Task not found' };
    }
    
    if (direction === 'up' && index > 0) {
      [queue[index - 1], queue[index]] = [queue[index], queue[index - 1]];
    } else if (direction === 'down' && index < queue.length - 1) {
      [queue[index], queue[index + 1]] = [queue[index + 1], queue[index]];
    } else {
      return { success: false, error: 'Cannot move task in that direction' };
    }
    
    await chrome.storage.local.set({ queue });
    
    return { success: true };
  } catch (error) {
    console.error('Error moving task:', error);
    return { success: false, error: error.message };
  }
}

// Clear all completed tasks
async function clearCompleted() {
  try {
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    const filteredQueue = queue.filter(t => t.status !== 'completed' && t.status !== 'failed' && t.status !== 'cancelled');
    
    await chrome.storage.local.set({ queue: filteredQueue });
    
    return { success: true };
  } catch (error) {
    console.error('Error clearing completed tasks:', error);
    return { success: false, error: error.message };
  }
}

// Clear all tasks
async function clearAll() {
  try {
    await chrome.storage.local.set({ queue: [] });
    return { success: true };
  } catch (error) {
    console.error('Error clearing all tasks:', error);
    return { success: false, error: error.message };
  }
}

// Update progress for a task
async function updateProgress(taskId, collected) {
  try {
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    const taskIndex = queue.findIndex(t => t.id === taskId);
    
    if (taskIndex !== -1) {
      queue[taskIndex].collected = collected;
      await chrome.storage.local.set({ queue });
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error updating progress:', error);
    return { success: false, error: error.message };
  }
}

// Mark task as complete and start next task
async function taskComplete(taskId) {
  try {
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    const taskIndex = queue.findIndex(t => t.id === taskId);
    
    if (taskIndex !== -1) {
      queue[taskIndex].status = 'completed';
      queue[taskIndex].endTime = Date.now();
      await chrome.storage.local.set({ queue });
    }
    
    currentTask = null;
    isProcessing = false;
    
    // Start next pending task after delay
    const settings = (await chrome.storage.local.get(['settings'])).settings || {};
    const delay = settings.delayBetweenTasks || 3000;
    
    setTimeout(async () => {
      const nextData = await chrome.storage.local.get(['queue']);
      const nextQueue = nextData.queue || [];
      const nextTask = nextQueue.find(t => t.status === 'pending');
      
      if (nextTask) {
        await processTask(nextTask);
      }
    }, delay);
    
    return { success: true };
  } catch (error) {
    console.error('Error completing task:', error);
    return { success: false, error: error.message };
  }
}

// Mark task as failed
async function taskFailed(taskId, error) {
  try {
    const data = await chrome.storage.local.get(['queue']);
    const queue = data.queue || [];
    const taskIndex = queue.findIndex(t => t.id === taskId);
    
    if (taskIndex !== -1) {
      queue[taskIndex].status = 'failed';
      queue[taskIndex].endTime = Date.now();
      queue[taskIndex].errorMessage = error;
      await chrome.storage.local.set({ queue });
    }
    
    currentTask = null;
    isProcessing = false;
    
    return { success: true };
  } catch (error) {
    console.error('Error marking task as failed:', error);
    return { success: false, error: error.message };
  }
}

// Get current queue state
async function getQueue() {
  try {
    const data = await chrome.storage.local.get(['queue', 'leads']);
    return { 
      success: true, 
      queue: data.queue || [],
      leads: data.leads || []
    };
  } catch (error) {
    console.error('Error getting queue:', error);
    return { success: false, error: error.message };
  }
}

// Export leads to CSV
async function exportLeads(taskIds) {
  try {
    const data = await chrome.storage.local.get(['leads', 'queue']);
    let leads = data.leads || [];
    const queue = data.queue || [];
    
    // Filter by task IDs if provided
    if (taskIds && taskIds.length > 0) {
      leads = leads.filter(lead => taskIds.includes(lead.taskId));
    }
    
    // Get task queries for each lead
    const leadsWithTaskInfo = leads.map(lead => {
      const task = queue.find(t => t.id === lead.taskId);
      return {
        taskId: lead.taskId,
        query: task ? task.query : 'Unknown',
        source: task ? task.source : 'Unknown',
        name: lead.name || '',
        phone: lead.phone || '',
        email: lead.email || '',
        website: lead.website || '',
        address: lead.address || '',
        rating: lead.rating || '',
        reviews: lead.reviews || ''
      };
    });
    
    // Create CSV content
    const headers = ['Task ID', 'Search Query', 'Source', 'Name', 'Phone', 'Email', 'Website', 'Address', 'Rating', 'Reviews'];
    const csvRows = [headers.join(',')];
    
    leadsWithTaskInfo.forEach(lead => {
      const row = [
        `"${lead.taskId}"`,
        `"${lead.query.replace(/"/g, '""')}"`,
        `"${lead.source}"`,
        `"${(lead.name || '').replace(/"/g, '""')}"`,
        `"${(lead.phone || '').replace(/"/g, '""')}"`,
        `"${(lead.email || '').replace(/"/g, '""')}"`,
        `"${(lead.website || '').replace(/"/g, '""')}"`,
        `"${(lead.address || '').replace(/"/g, '""')}"`,
        `"${lead.rating}"`,
        `"${lead.reviews}"`
      ];
      csvRows.push(row.join(','));
    });
    
    const csvContent = csvRows.join('\n');
    
    // Create blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    
    const downloadId = await chrome.downloads.download({
      url: url,
      filename: `leadharvest_export_${Date.now()}.csv`,
      saveAs: true
    });
    
    return { success: true, downloadId };
  } catch (error) {
    console.error('Error exporting leads:', error);
    return { success: false, error: error.message };
  }
}

// Listen for storage changes to keep UI in sync
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    // Notify any open queue manager tabs about the changes
    chrome.runtime.sendMessage({ type: 'STORAGE_UPDATED', changes }).catch(() => {
      // Ignore errors if no listeners are available
    });
  }
});
