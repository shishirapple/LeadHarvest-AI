# LeadHarvest AI — Chrome Extension

**Google Maps lead scraper with advanced email extraction, queue-based batch scraping, and a side panel UI. No subscriptions. No external accounts. Runs entirely in your browser.**

---

## What It Does

LeadHarvest AI lets you extract business leads directly from Google Maps search results. Open Maps, run a search, and the extension collects the data you choose — names, phones, emails, websites, addresses, ratings — into a local database you can filter and export as CSV.

The email scraper goes beyond surface-level extraction. It visits each business website and tries multiple strategies to find a real contact email, including pages that hide their addresses behind Cloudflare protection, HTML encoding, or obfuscated text patterns.

---

## Features

### Scraping
- Queue multiple search tasks and run them sequentially
- Per-task lead limit (1–500)
- Human-like delays to avoid rate limiting
- Cross-task duplicate detection (same business won't appear twice)
- Google Ads detection — flags sponsored listings separately
- CMS/platform fingerprinting (WordPress, Shopify, Wix, Squarespace, Webflow, Framer, and more)

### Email Extraction
- Fetches homepage + contact, about, team, imprint, impressum, and other likely pages
- Decodes Cloudflare email protection (`data-cfemail` and `/cdn-cgi/l/email-protection`)
- Decodes HTML entity encoded emails (`info&#64;domain.com`)
- Catches obfuscated text patterns: `name [at] domain [dot] com`, `name(at)domain.com`
- Parses JSON-LD / schema.org structured data for `Organization.email`
- Reads `data-email` attributes used by some WordPress themes
- Scans meta tags (`contact:email`, `og:email`)
- Falls back to a hidden background tab for JavaScript-rendered sites
- Smart email ranking — prefers same-domain emails, then `info@`, `contact@`, `hello@`, etc.

### UI
- Chrome Side Panel — stays open while you browse Maps
- Selectable extract fields — toggle Name, Phone, Email, Website, Address, Rating, Reviews, Hours individually per task
- Queue controls: Start, Pause, Resume, Stop All, Skip Task
- Drag-to-reorder pending tasks
- Records tab with search, filter pills (Has Email, No Website, Google Ads, Hot Leads), and per-task filtering
- Export filtered results or all records as CSV
- Daily quota tracker

---

## Version History

### v6.0.0 — Current
- **Fixed:** Extract field chips were stuck — clicking toggled and immediately reverted due to a double-event bug from `<label>` wrapping a hidden checkbox. Rebuilt as plain `div` chip elements with a single JS handler. Now works correctly.
- **Improved:** UI contrast and readability — brighter text, stronger borders, green glow on focused inputs, weight/spacing improvements throughout.
- **Improved:** Email scraper now tries 14 candidate paths per site (up from 5), decodes Cloudflare email protection, HTML entities, obfuscated `[at]` patterns, JSON-LD structured data, `data-email` attributes, and meta tags. Junk filter extended to block `noreply`, `no-reply`, `donotreply`, `bounce`, `test`, `demo` prefixes.

### v5.0.0
- Migrated from popup to Chrome Side Panel
- Queue system with multiple tasks, pause/resume/stop, drag-to-reorder
- Cross-task duplicate detection via IndexedDB unique index
- Per-task progress tracking persisted through service worker restarts

### v4.0.0
- Field selection actually respected (previously all fields extracted regardless)
- Google Ads detection added
- More reliable detail-panel detection with retry logic
- Lead scoring and CMS fingerprinting

---

## Installation (Developer Mode)

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked**
5. Select the `leadharvest-v6` folder
6. Click the LeadHarvest AI icon in your toolbar to open the side panel

---

## How to Use

1. Open [Google Maps](https://www.google.com/maps) and search for businesses (e.g. *dentists in Chicago*)
2. Open the LeadHarvest AI side panel — it will auto-detect your search
3. Set your lead limit and select which fields to extract
4. Click **Add to Queue**, then **▶ Start**
5. Watch progress in the Queue tab; switch to Records when done
6. Filter, search, and **Export All** or **Export Filtered** as CSV

---

## File Structure

```
leadharvest-v6/
├── manifest.json
├── icons/
│   └── icon128.png
└── src/
    ├── background.js          # Service worker — queue orchestration, quota, settings
    ├── lib/
    │   ├── email-scraper.js   # Website email discovery (multi-strategy)
    │   └── storage.js         # IndexedDB wrapper for leads
    ├── content/
    │   └── maps-content.js    # Google Maps DOM scraper
    ├── sidepanel/
    │   ├── sidepanel.html     # Side panel UI
    │   └── sidepanel.js       # Side panel logic
    └── options/
        ├── options.html       # Settings page
        └── options.js
```

---

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Save queue state and leads locally |
| `scripting` | Inject content script into Maps and hidden tabs for email extraction |
| `tabs` | Detect active Maps tab; create hidden tabs for JS-rendered sites |
| `sidePanel` | Open the UI as a side panel |
| `alarms` | Keep the service worker alive during long scraping sessions |
| `host_permissions: http://* https://*` | Fetch business websites to find emails |

All data stays in your browser. Nothing is sent to any server.

---

## Notes

- The extension scrapes publicly visible data from Google Maps. Use responsibly and in accordance with Google's Terms of Service.
- Email extraction makes direct HTTP requests to business websites. Some sites may block automated requests — the extension falls back to a hidden tab for those cases.
- Daily quota defaults to 500 leads. Adjust in the Options page.

---

## License

MIT
