# LeadHarvest AI — Chrome Extension v4.0

Fully self-contained Google Maps lead extractor. No Google Sheets, no OAuth,
no external accounts — everything runs locally in the browser.

## What changed in v4

**Removed: Google Sheets sync entirely.** It added an OAuth setup burden
or wasn't reliably testable. v4 drops it completely — local storage +
CSV/Excel export is now the only path, and it's instant and 100% offline.

**Fixed: field-selection bug.** Previously every field was extracted
regardless of which checkboxes you ticked. `maps-content.js` now gates each
detail-panel extraction step behind `currentFields.includes(...)`, so
unchecking "Hours" or "Email" actually skips that work and speeds up the run.

**Fixed: incomplete scraping.** The detail-panel wait logic now accepts a
match on either (a) the detail heading text or (b) real detail content
(phone/website/address) actually being present — and retries once if neither
shows up in time. This catches more businesses than the v3 heading-only match,
especially ones with unusual name formatting.

**New: Google Ads detection.** Sponsored/"Ad" listings in the Maps results
are flagged (`googleAds: true`) via a best-effort DOM heuristic (Google
doesn't expose a stable public flag for this, so this is pattern-matching on
the "Ad"/"Sponsored" badge — verify visually if it matters for your use case).
Useful for spotting who's already paying for traffic vs. who isn't.

**New: CMS/platform fingerprinting + lead scoring.** While checking a
business's website for an email, the same HTML is scanned for WordPress,
Shopify, Wix, Squarespace, Webflow, GoDaddy Builder, or Weebly signatures —
zero extra requests. Each lead gets a `leadScore`:
- **No Website — Hot Prospect** — no site at all
- **DIY Builder — Upgrade Candidate** — on Wix/Squarespace/GoDaddy/Weebly
- **Low Rating — Reputation Lead** — under 4★ with 5+ reviews
- **WordPress — Maintenance Lead** — already on WP (good for retainer work)
- **Standard** — everything else

This is genuinely aimed at your use case: businesses with no website or a
DIY-builder site are your best web-design prospects; this surfaces them
automatically instead of making you check each one by hand.

**New: full Records tab in the popup.** Browse every captured lead without
leaving the extension — search by name/email/phone/address, filter by
Has Email / No Website / Ads Only, see badges per lead, copy a lead's
details to clipboard, or delete one individually. Stats pills (Total, With
Email, No Website, Ads) update live.

**New: auto-detection banner.** The Scrape tab shows a live green
"✓ Google Maps detected" banner the moment you're on a Maps results page —
no need to guess whether the extension can see your tab.

**New: limit presets.** One-click 10/25/50/100 buttons instead of typing a
number every time (still editable manually).

**New: duplicate counter.** The run stats now show how many candidate
businesses were skipped as duplicates, separate from the captured count.

**Redesigned UI.** Full green-and-black theme across popup and options,
three-tab layout (Scrape / Records / Export), and a generally tighter,
more information-dense layout suited to actually working out of the popup
instead of just firing extraction and waiting.

**Dropped: LinkedIn and Instagram.** As before — those platforms actively
block/detect scraping in ways that can get a personal account suspended.
Maps + website intelligence is the focus.

## Installation (Developer Mode)

1. Unzip this folder
2. `chrome://extensions` → toggle **Developer mode** ON
3. **Load unpacked** → select this folder
4. Pin the LeadHarvest AI icon to your toolbar

**Permissions note:** this still requests access to all websites
(`http://*/*`, `https://*/*`) — required for the CORS-free email-lookup
fetch trick. It only ever visits the specific business sites it scrapes
from Maps results.

## Quick Start

1. Open Google Maps, search for businesses
2. Click the LeadHarvest AI icon — the Scrape tab shows a green "detected"
   banner once you're on results
3. Pick fields, pick a limit (or use a preset), hit **Start Extraction**
4. Switch to **Records** any time to search/filter what's been captured —
   even mid-run
5. **Export** tab → CSV or Excel whenever you're ready

## File Structure

```
leadharvest-ai-extension/
├── manifest.json
├── icons/icon128.png
├── src/
│   ├── background.js              # Service worker: quota, sessions, email queue
│   ├── content/maps-content.js    # Maps scraper: scroll → click-through → extract
│   ├── popup/{popup.html,popup.js}
│   ├── options/{options.html,options.js}
│   └── lib/
│       ├── storage.js             # IndexedDB, deduplication
│       └── email-scraper.js       # Email discovery + CMS fingerprinting
└── README.md
```

## Honest limitations

- **Google Ads flag is heuristic**, not an official API field — spot-check
  it against what you see on-screen for a given search before relying on it
  for outreach sequencing.
- **Click-through extraction is inherently slower** than a flat list read.
  Turning off Email lookup in Options is the single biggest speed win if you
  just need name/phone/address.
- **Some sites will never yield an email or a clean platform read** — no
  mailto link anywhere, contact-form-only, or heavily JS-obfuscated markup.
  That's expected; the field is correctly left blank rather than guessed.
- **Google's DOM changes periodically.** Selector fallback chains are
  defensive, but if Google ships a layout change, individual CSS selectors
  may need updates — the click → wait → extract architecture itself should
  stay valid.
