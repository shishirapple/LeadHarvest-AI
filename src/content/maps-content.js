// LeadHarvest AI - Content Script for Google Maps (v5.0.2)
// Handles data extraction from Google Maps search results

let isExtracting = false;
let isPaused = false;
let currentTaskId = null;
let currentSessionId = null;
let targetLeads = 0;
let collectedLeads = 0;
let extractionInterval = null;
let processedUrls = new Set();

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'BEGIN_EXTRACTION':
      return await beginExtraction(message);
    
    case 'PAUSE':
      return pauseExtraction();
    
    case 'RESUME':
      return resumeExtraction();
    
    case 'STOP':
      return stopExtraction();
    
    default:
      return { success: false, error: 'Unknown message type' };
  }
}

// Begin extraction process
async function beginExtraction(message) {
  try {
    if (isExtracting) {
      return { success: false, error: 'Extraction already in progress' };
    }
    
    currentTaskId = message.taskId;
    currentSessionId = message.sessionId;
    targetLeads = message.target;
    collectedLeads = 0;
    isExtracting = true;
    isPaused = false;
    processedUrls.clear();
    
    // Start the extraction loop
    startExtractionLoop();
    
    return { success: true };
  } catch (error) {
    console.error('Error beginning extraction:', error);
    return { success: false, error: error.message };
  }
}

// Start the extraction loop
function startExtractionLoop() {
  extractionInterval = setInterval(async () => {
    if (isPaused || !isExtracting) return;
    
    try {
      // Check if we've reached the target
      if (collectedLeads >= targetLeads) {
        await completeExtraction();
        return;
      }
      
      // Extract leads from current page
      const leads = extractLeadsFromPage();
      
      // Save each lead
      for (const lead of leads) {
        if (collectedLeads >= targetLeads) break;
        
        await saveLead(lead);
        collectedLeads++;
        
        // Update progress
        await updateProgress();
      }
      
      // Try to scroll and load more results
      await scrollToLoadMore();
      
    } catch (error) {
      console.error('Error in extraction loop:', error);
    }
  }, 2000); // Run every 2 seconds
}

// Extract leads from the current page
function extractLeadsFromPage() {
  const leads = [];
  
  // Find all business listings on the page
  const listings = document.querySelectorAll('div[role="article"], div[jsaction]');
  
  listings.forEach(listing => {
    try {
      // Skip if we've already processed this listing
      const listingId = listing.getAttribute('data-item-id') || listing.innerHTML.substring(0, 50);
      if (processedUrls.has(listingId)) return;
      
      // Extract business information
      const name = listing.querySelector('h2, h3, .fontHeadlineSmall, .qBF1Pd')?.textContent?.trim() || '';
      const address = listing.querySelector('.Io9YTe, .fzrMMd, .llHfXHe')?.textContent?.trim() || '';
      const ratingText = listing.querySelector('.F4lsmb, .kP92rc, span[aria-label*="rating"]')?.getAttribute('aria-label') || 
                         listing.querySelector('.F4lsmb, .kP92rc')?.textContent?.trim() || '';
      const rating = parseFloat(ratingText.match(/[\d.]+/)?.[0]) || 0;
      const reviews = listing.querySelector('.OdT41c, .Rat4bc')?.textContent?.replace(/[^\d]/g, '') || '0';
      
      // Only add if we have at least a name
      if (name) {
        processedUrls.add(listingId);
        leads.push({
          taskId: currentTaskId,
          sessionId: currentSessionId,
          name: name,
          address: address,
          rating: rating.toString(),
          reviews: reviews,
          phone: '',
          email: '',
          website: '',
          extractedAt: Date.now()
        });
      }
    } catch (error) {
      console.error('Error extracting listing:', error);
    }
  });
  
  return leads;
}

// Save a lead to storage
async function saveLead(lead) {
  try {
    const data = await chrome.storage.local.get(['leads']);
    const leads = data.leads || [];
    leads.push(lead);
    await chrome.storage.local.set({ leads });
  } catch (error) {
    console.error('Error saving lead:', error);
  }
}

// Update progress in background
async function updateProgress() {
  try {
    await chrome.runtime.sendMessage({
      type: 'UPDATE_PROGRESS',
      taskId: currentTaskId,
      collected: collectedLeads
    });
  } catch (error) {
    console.error('Error updating progress:', error);
  }
}

// Scroll to load more results
async function scrollToLoadMore() {
  try {
    const scrollContainer = document.querySelector('div[role="feed"]') || 
                           document.querySelector('.m6QErb.DxyBCb.kA9KIf.d9WPPe') ||
                           document.body;
    
    const scrollHeight = scrollContainer.scrollHeight;
    
    // Scroll down
    scrollContainer.scrollTop = scrollHeight;
    
    // Wait for content to load
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Scroll back up slightly
    scrollContainer.scrollTop = Math.max(0, scrollHeight - 500);
    
  } catch (error) {
    console.error('Error scrolling:', error);
  }
}

// Pause extraction
function pauseExtraction() {
  isPaused = true;
  return { success: true };
}

// Resume extraction
function resumeExtraction() {
  isPaused = false;
  return { success: true };
}

// Stop extraction
async function stopExtraction() {
  isExtracting = false;
  isPaused = false;
  
  if (extractionInterval) {
    clearInterval(extractionInterval);
    extractionInterval = null;
  }
  
  try {
    await chrome.runtime.sendMessage({
      type: 'TASK_COMPLETE',
      taskId: currentTaskId
    });
  } catch (error) {
    console.error('Error sending completion message:', error);
  }
  
  return { success: true };
}

// Complete extraction (target reached)
async function completeExtraction() {
  isExtracting = false;
  
  if (extractionInterval) {
    clearInterval(extractionInterval);
    extractionInterval = null;
  }
  
  try {
    await chrome.runtime.sendMessage({
      type: 'TASK_COMPLETE',
      taskId: currentTaskId
    });
  } catch (error) {
    console.error('Error sending completion message:', error);
  }
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (extractionInterval) {
    clearInterval(extractionInterval);
  }
});

console.log('LeadHarvest AI Content Script loaded');
