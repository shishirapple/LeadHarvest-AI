// LeadHarvest AI - Options Page (v5.0.2)
// Handles settings page functionality

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  
  const settingsForm = document.getElementById('settingsForm');
  if (settingsForm) {
    settingsForm.addEventListener('submit', handleSaveSettings);
  }
});

// Load current settings
async function loadSettings() {
  try {
    const data = await chrome.storage.local.get(['settings']);
    const settings = data.settings || {
      delayBetweenLeads: 2000,
      delayBetweenTasks: 3000
    };
    
    document.getElementById('delayBetweenLeads').value = settings.delayBetweenLeads;
    document.getElementById('delayBetweenTasks').value = settings.delayBetweenTasks;
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// Handle save settings
async function handleSaveSettings(event) {
  event.preventDefault();
  
  const delayBetweenLeads = parseInt(document.getElementById('delayBetweenLeads').value);
  const delayBetweenTasks = parseInt(document.getElementById('delayBetweenTasks').value);
  
  try {
    await chrome.storage.local.set({
      settings: {
        delayBetweenLeads,
        delayBetweenTasks
      }
    });
    
    showToast('Settings saved successfully');
  } catch (error) {
    console.error('Error saving settings:', error);
    alert('Failed to save settings');
  }
}

// Show toast notification
function showToast(message) {
  const existingToast = document.querySelector('.toast');
  if (existingToast) {
    existingToast.remove();
  }
  
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, 3000);
}
