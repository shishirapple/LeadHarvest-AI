# LeadHarvest AI - Chrome Extension (v5.0.2)

## Overview
LeadHarvest AI is a professional Chrome extension for automated lead generation from Google Maps with advanced queue management, scheduling, and bulk export capabilities.

## Features

### Queue & Workflow Management
- **Multi-Task Queue**: Add multiple search tasks to a single list
- **Task Parameters**: Define search query, source, and target lead quantity
- **Sequential Execution**: Tasks run one-by-one automatically
- **Queue Controls**: Start, Pause, Resume, Stop, Clear Completed, Clear All
- **Task Editing**: Edit, reorder (up/down), and delete tasks before execution

### Persistence & Recovery
- **Crash Recovery**: Queue state persists across browser restarts
- **Progress Resumption**: Resume from where you left off (e.g., 347/500 leads)
- **Data Durability**: Leads saved continuously to chrome.storage.local

### Progress Tracking & Dashboard
- **Real-time Stats**: Total tasks, Pending, Running, Completed, Total Leads
- **Task Details**: Task ID, Query, Target vs. Collected with progress bars
- **Status Lifecycle**: Pending → Running → (Paused ↔ Resumed) → Completed/Failed/Cancelled

### Export Capabilities
- **Single Task Export**: Individual CSV files per task
- **Bulk Export**: All completed tasks in a single CSV with Task Metadata columns

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" in the top right
3. Click "Load unpacked"
4. Select the folder containing this extension
5. The extension icon should appear in your toolbar

## Usage

### Adding Tasks
1. Click the extension icon to open the Queue Manager
2. Fill in the task details:
   - **Search Query**: e.g., "Restaurants in Dubai"
   - **Source**: Google Maps (LinkedIn coming soon)
   - **Target Leads**: Number of leads to collect
   - **Priority**: High, Medium, or Low
3. Click "Add to Queue"

### Managing the Queue
- **Start**: Begin processing pending tasks
- **Pause**: Temporarily halt the current task
- **Resume**: Continue a paused task
- **Stop**: Terminate the current task
- **Clear Completed**: Remove finished tasks
- **Clear All**: Remove all tasks from the queue

### Reordering Tasks
- Use the **Up** and **Down** buttons to change task priority
- Only pending tasks can be reordered

### Exporting Leads
1. Wait for tasks to complete
2. Click "Export Leads" to download all collected data
3. The CSV includes: Task ID, Search Query, Source, Name, Phone, Email, Website, Address, Rating, Reviews

## File Structure

```
/LeadHarvest-AI
├── manifest.json              # Extension configuration
├── icons/                     # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── src/
│   ├── background.js          # Service worker (queue logic, tab management)
│   ├── content/
│   │   └── maps-content.js    # Content script for Google Maps scraping
│   ├── queue/
│   │   ├── queue-manager.html # Main UI dashboard
│   │   └── queue-manager.js   # UI logic and event handlers
│   └── options/
│       ├── options.html       # Settings page
│       └── options.js         # Settings logic
└── README.md                  # This file
```

## Technical Details

### Architecture
- **Manifest V3**: Uses Service Workers instead of persistent background pages
- **Storage-First State**: Source of truth is chrome.storage.local
- **Event-Driven Communication**: Uses chrome.runtime.sendMessage and chrome.storage.onChanged

### Data Structure
Each task object:
```json
{
  "id": "task_timestamp_uniqueID",
  "query": "Restaurants in Dubai",
  "source": "maps",
  "target": 500,
  "collected": 347,
  "priority": "high",
  "status": "running",
  "startTime": 1719123456789,
  "endTime": null,
  "sessionId": "session_1719123456789_abc123"
}
```

### CSP Compliance
- No inline event handlers (onclick, onload, etc.)
- All JavaScript in external files
- Event delegation for dynamic elements

## Troubleshooting

### Extension not loading
- Check that all file paths in manifest.json are correct
- Ensure icons exist in the icons folder
- Look for errors in chrome://extensions/

### Tasks not starting
- Make sure you have pending tasks in the queue
- Check that the background service worker is active
- Look for errors in the extension console

### Progress not updating
- Ensure the content script is injected properly
- Check chrome.storage.local for data
- Verify the Google Maps tab is still open

### Export not working
- Ensure you have completed tasks with collected leads
- Check that the downloads permission is granted

## Development

### Debugging
1. Go to `chrome://extensions/`
2. Find LeadHarvest AI
3. Click "Inspect views: background page" for background script debugging
4. Open DevTools on the Google Maps tab for content script debugging

### Testing
1. Add a test task with a small target (e.g., 10 leads)
2. Start the queue and monitor progress
3. Test pause/resume functionality
4. Verify data persistence by closing and reopening the queue manager

## Version History

### v5.0.2 (Current)
- Fixed CSP violations (removed inline handlers)
- Fixed icon loading issues
- Fixed queue execution logic failures
- Implemented proper event delegation
- Added storage synchronization for real-time updates
- Improved error handling throughout

### v5.0.1
- Initial queue management implementation
- Basic progress tracking
- CSV export functionality

### v5.0.0
- Initial release with core scraping functionality

## License
Proprietary - All rights reserved

## Support
For issues and feature requests, please contact the development team.
