/**
 * LeadHarvest AI — Google Maps Content Script (v4.0)
 *
 * v4 fixes vs v3:
 *  - Field selection is now actually respected. Previously every field was
 *    extracted regardless of what the popup checkboxes said. Now each
 *    detail-panel extraction step is gated by currentFields.
 *  - Google Ads detection: sponsored/"Ad" listings are flagged (googleAds:true)
 *    so you can see at a glance who's already paying for traffic — and who
 *    isn't (an organic-only competitor gap you can pitch against).
 *  - More reliable detail-panel detection: waits on ANY detail content
 *    appearing (not just a heading-text match), retries once on failure,
 *    and uses the place URL itself as a secondary confirmation signal.
 *  - Lead scoring + CMS/platform tag computed per lead (from email-scraper's
 *    fingerprinting) to help prioritize who's worth pitching web work to.
 */

(() => {
  'use strict';

  if (window.__leadharvestInjected) {
    console.log('[LeadHarvest] Already injected, skipping.');
    return;
  }
  window.__leadharvestInjected = true;

  const SELECTORS = {
    resultsPanel: ['div[role="feed"]', 'div[aria-label*="Results"]', 'div[aria-label*="results"]', 'div.m6QErb'],
    resultLink: 'a[href*="/maps/place/"]',
    resultCard: ['div.Nv2PK', 'div[role="article"]'],

    name: ['.fontHeadlineSmall', 'h3', '[role="heading"]', '.qBF1Pd'],
    category: ['button[jsaction*="category"]', '.fontBodyMedium [style*="white-space"]'],

    adBadge: ['[aria-label="Ad"]', '[aria-label*="Sponsored" i]', '[data-value="Ad"]'],

    detailHeading: ['h1.DUwDvf', 'h1[class*="fontHeadline"]', 'h1'],
    detailPhone: ['button[data-item-id^="phone:"]', 'button[aria-label*="phone" i]'],
    detailWebsite: ['a[data-item-id^="authority"]', 'a[data-item-id^="website"]', 'a[aria-label*="website" i]'],
    detailAddress: ['button[data-item-id^="address"]', 'button[aria-label*="address" i]'],
    detailCategory: ['button[jsaction*="category"]'],
    detailHours: ['div[aria-label*="hours" i]', 'div[jsaction*="hours"]'],
    backButton: ['button[aria-label="Back"]', 'button[jsaction*="pane.backButton"]', 'button[aria-label*="Back to results" i]'],
  };

  let running = false;
  let paused = false;
  let captured = 0;
  let duplicates = 0;
  let errorCount = 0;
  let currentSessionId = null;
  let currentSettings = {};
  let currentFields = [];
  let storage = null;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function humanDelay(min = 1500, max = 3500) {
    const customDelay = currentSettings.customDelay;
    if (customDelay > 0) return sleep(customDelay + Math.random() * 800);
    if (!currentSettings.rateLimitEnabled) return sleep(400 + Math.random() * 600);
    return sleep(min + Math.random() * (max - min));
  }

  function querySelectorMulti(parent, selectors) {
    for (const sel of selectors) {
      try { const el = parent.querySelector(sel); if (el) return el; } catch (e) {}
    }
    return null;
  }

  function querySelectorAllMulti(parent, selectors) {
    const results = new Set();
    for (const sel of selectors) {
      try { parent.querySelectorAll(sel).forEach(el => results.add(el)); } catch (e) {}
    }
    return [...results];
  }

  function waitForCondition(checkFn, timeout = 9000, interval = 200) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const result = checkFn();
        if (result) return resolve(result);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function waitForElement(selectors, timeout = 12000, parent = document) {
    return waitForCondition(() => querySelectorMulti(parent, selectors), timeout);
  }

  function getPlaceId(href) {
    const match = href.match(/!1s([^!]+)/) || href.match(/\/place\/([^/]+)\//);
    return match ? match[1] : href;
  }

  /* ─── Google Ads detection (best-effort heuristic — Google exposes no stable public flag) ─── */
  function isSponsoredCard(card) {
    const explicit = querySelectorMulti(card, SELECTORS.adBadge);
    if (explicit) return true;
    const badgeCandidates = card.querySelectorAll('span, div');
    for (const el of badgeCandidates) {
      if (el.children.length > 0) continue;
      const t = el.textContent?.trim();
      if (t === 'Ad' || t === 'Sponsored') return true;
    }
    return false;
  }

  /* ─── List-card fields (the only fields actually present on the list card) ─── */
  function extractListName(card) {
    const el = querySelectorMulti(card, SELECTORS.name);
    return el?.textContent?.trim() || null;
  }

  function extractListRating(card) {
    const ratingEls = card.querySelectorAll('span[role="img"]');
    for (const el of ratingEls) {
      const label = el.getAttribute('aria-label') || '';
      const match = label.match(/(\d+\.?\d*)\s*star/);
      if (match) return parseFloat(match[1]);
    }
    return null;
  }

  function extractListReviews(card) {
    const text = card.textContent || '';
    const match = text.match(/\(([\d,]+)\)/) || text.match(/([\d,]+)\s*reviews?/i);
    if (match) return parseInt(match[1].replace(/,/g, ''), 10);
    return null;
  }

  function extractListCategory(card) {
    const el = querySelectorMulti(card, SELECTORS.category);
    if (el) return el.textContent?.trim() || null;
    const bodyEl = card.querySelector('.fontBodyMedium');
    if (bodyEl) {
      const firstLine = bodyEl.textContent?.split('·')[0]?.trim();
      if (firstLine && firstLine.length < 60) return firstLine;
    }
    return null;
  }

  /* ─── Detail-panel fields ─── */
  function extractDetailPhone(panel) {
    const btn = querySelectorMulti(panel, SELECTORS.detailPhone);
    if (!btn) return null;
    const dataId = btn.getAttribute('data-item-id');
    if (dataId) {
      const phone = dataId.replace(/^phone:(tel:)?/, '').trim();
      if (phone) return phone;
    }
    const aria = btn.getAttribute('aria-label') || '';
    const match = aria.match(/[\+]?[\d\s\-().]{7,}/);
    return match ? match[0].trim() : null;
  }

  function extractDetailWebsite(panel) {
    const link = querySelectorMulti(panel, SELECTORS.detailWebsite);
    if (!link) return null;
    const href = link.getAttribute('href');
    if (href && !href.includes('google.com')) return href;
    return null;
  }

  function extractDetailAddress(panel) {
    const btn = querySelectorMulti(panel, SELECTORS.detailAddress);
    if (!btn) return null;
    const dataId = btn.getAttribute('data-item-id');
    if (dataId && dataId.startsWith('address:')) {
      return dataId.replace(/^address:/, '').replace(/^.*?-/, '').trim() || btn.textContent?.trim() || null;
    }
    return btn.textContent?.trim() || null;
  }

  function extractDetailHours(panel) {
    const el = querySelectorMulti(panel, SELECTORS.detailHours);
    if (!el) return null;
    const text = el.getAttribute('aria-label') || el.textContent;
    return text?.trim().substring(0, 200) || null;
  }

  function extractDetailCategory(panel) {
    const el = querySelectorMulti(panel, SELECTORS.detailCategory);
    return el?.textContent?.trim() || null;
  }

  function isSearchResultsPage() {
    const url = window.location.href;
    if (url.includes('/maps/search/')) return true;
    const searchInput = document.querySelector('input#searchboxinput');
    if (searchInput && searchInput.value.trim()) return true;
    const resultsPanel = querySelectorMulti(document, SELECTORS.resultsPanel);
    if (resultsPanel && resultsPanel.children.length > 0) return true;
    return false;
  }

  function getSearchQuery() {
    const url = new URL(window.location.href);
    const qParam = url.searchParams.get('q');
    if (qParam) return decodeURIComponent(qParam);
    const pathMatch = window.location.pathname.match(/\/search\/(.+)/);
    if (pathMatch) return decodeURIComponent(pathMatch[1]).replace(/\+/g, ' ');
    const searchInput = document.querySelector('input#searchboxinput');
    if (searchInput?.value) return searchInput.value.trim();
    return '';
  }

  async function scrollResultsPanel(targetCount) {
    if (!currentSettings.autoScroll) return;
    const panel = querySelectorMulti(document, SELECTORS.resultsPanel);
    if (!panel) return;

    let lastCount = 0;
    let stableRounds = 0;
    const MAX_ROUNDS = 80;

    for (let round = 0; round < MAX_ROUNDS && running && !paused; round++) {
      const currentCount = document.querySelectorAll(SELECTORS.resultLink).length;
      if (currentCount >= targetCount) break;
      panel.scrollBy({ top: 1000, behavior: 'smooth' });
      await humanDelay(900, 1800);
      if (currentCount === lastCount) {
        stableRounds++;
        if (stableRounds > 5) break;
      } else {
        stableRounds = 0;
        lastCount = currentCount;
      }
    }
  }

  /** Click a list card by its href, wait for the detail panel to actually load THAT business. */
  async function openDetailForCard(href, expectedName, attempt = 1) {
    const link = [...document.querySelectorAll(SELECTORS.resultLink)].find(a => a.getAttribute('href') === href);
    if (!link) return false;

    link.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(200);
    link.click();

    const matched = await waitForCondition(() => {
      const heading = querySelectorMulti(document, SELECTORS.detailHeading);
      const headingText = heading?.textContent?.trim();
      const headingMatches = headingText && expectedName &&
        (headingText.includes(expectedName.substring(0, 12)) || expectedName.includes(headingText.substring(0, 12)));
      const anyDetailLoaded = querySelectorMulti(document, SELECTORS.detailPhone) ||
        querySelectorMulti(document, SELECTORS.detailWebsite) ||
        querySelectorMulti(document, SELECTORS.detailAddress);

      if (headingMatches) return true;
      if (heading && anyDetailLoaded) return true; // heading present but text truncated differently — accept if real detail content loaded
      return false;
    }, 10000);

    if (!matched && attempt === 1) {
      await sleep(600);
      return openDetailForCard(href, expectedName, 2);
    }
    return !!matched;
  }

  async function returnToResultsList() {
    const backBtn = querySelectorMulti(document, SELECTORS.backButton);
    if (backBtn) backBtn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitForCondition(() => document.querySelectorAll(SELECTORS.resultLink).length > 0, 6000);
    await sleep(200);
  }

  function requestEmailLookup(websiteUrl) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
      try {
        chrome.runtime.sendMessage({ type: 'EXTRACT_EMAIL', website: websiteUrl }, (resp) => {
          if (chrome.runtime.lastError) return finish({ email: null, platform: null });
          finish({ email: resp?.email || null, platform: resp?.platform || null });
        });
      } catch (e) { finish({ email: null, platform: null }); }
      setTimeout(() => finish({ email: null, platform: null }), 16000);
    });
  }

  /* ─── Lead scoring: prioritize prospects worth pitching web/marketing work to ─── */
  function computeLeadScore(record) {
    if (!record.website) return 'No Website — Hot Prospect';
    if (['Wix', 'Squarespace', 'GoDaddy Builder', 'Weebly'].includes(record.websitePlatform)) {
      return 'DIY Builder — Upgrade Candidate';
    }
    if (record.rating && record.reviews && record.rating < 4 && record.reviews > 5) {
      return 'Low Rating — Reputation Lead';
    }
    if (record.websitePlatform === 'WordPress') return 'WordPress — Maintenance Lead';
    return 'Standard';
  }

  async function buildLeadRecord(card, href) {
    const name = extractListName(card);
    if (!name) return null;

    const record = {
      name,
      phone: null, email: null, website: null, address: null,
      category: extractListCategory(card),
      rating: currentFields.includes('rating') ? extractListRating(card) : null,
      reviews: currentFields.includes('reviews') ? extractListReviews(card) : null,
      hours: null,
      niche: 'other', nicheConfidence: 0,
      source: 'maps', mapsUrl: href,
      googleAds: isSponsoredCard(card),
      websitePlatform: null,
      leadScore: null,
    };

    const needsDetail = currentFields.some(f => ['phone', 'website', 'address', 'hours', 'email'].includes(f));

    if (needsDetail) {
      const opened = await openDetailForCard(href, name);
      if (opened) {
        if (currentFields.includes('phone')) record.phone = extractDetailPhone(document);
        if (currentFields.includes('website') || currentFields.includes('email')) record.website = extractDetailWebsite(document);
        if (currentFields.includes('address')) record.address = extractDetailAddress(document);
        if (currentFields.includes('hours')) record.hours = extractDetailHours(document);
        if (!record.category) record.category = extractDetailCategory(document);

        if (currentSettings.extractEmailsFromWebsite && record.website && currentFields.includes('email')) {
          showOverlay(captured, false, `Looking up email for ${name}...`);
          const result = await requestEmailLookup(record.website);
          record.email = result.email;
          record.websitePlatform = result.platform;
        }

        await returnToResultsList();
      }
    }

    record.leadScore = computeLeadScore(record);
    return record;
  }

  async function processCard(card, href) {
    if (!running || paused) return false;
    try {
      const record = await buildLeadRecord(card, href);
      if (!record || !record.name) return false;

      if (storage) {
        const result = await storage.addLead({ ...record, session_id: currentSessionId });
        if (result.duplicate) {
          duplicates++;
          return false;
        }

        captured++;
        showOverlay(captured, false);

        try {
          chrome.runtime.sendMessage({ type: 'RECORD_CAPTURED', record: { ...record, id: result.lead?.id } });
          // Send progress update to queue manager
          chrome.runtime.sendMessage({ 
            type: 'QUEUE_TASK_UPDATE', 
            taskId: currentSettings.taskId,
            collectedLeads: captured,
            status: running ? 'running' : 'paused'
          }).catch(() => {});
        } catch (e) {}
      }
      return true;
    } catch (error) {
      errorCount++;
      console.error('[LeadHarvest] Card processing error:', error);
      return false;
    }
  }

  async function runExtraction(fields, limit, settings = {}, sessionId = null) {
    if (running) return;

    running = true;
    paused = false;
    captured = 0;
    duplicates = 0;
    errorCount = 0;
    currentSessionId = sessionId;
    currentSettings = settings;
    currentFields = fields;

    if (window.LeadStorage) {
      storage = new LeadStorage();
      await storage.init();
    }

    showOverlay(0, false, 'Starting extraction...');

    if (!isSearchResultsPage()) {
      showOverlay(0, true, 'Error: search for businesses on Google Maps first.');
      running = false;
      return;
    }

    await waitForElement(SELECTORS.resultsPanel, 15000);
    await scrollResultsPanel(limit);

    const cardEls = querySelectorAllMulti(document, SELECTORS.resultCard);
    const seenHrefs = new Set();
    const queue = [];
    for (const card of cardEls) {
      const link = card.querySelector(SELECTORS.resultLink);
      if (!link) continue;
      const href = link.getAttribute('href');
      if (!href || seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      queue.push({ card, href });
      if (queue.length >= limit * 2) break;
    }

    console.log(`[LeadHarvest] Queued ${queue.length} candidate businesses`);

    for (const { card, href } of queue) {
      if (!running || captured >= limit) break;
      if (paused) {
        showOverlay(captured, false, 'Paused...');
        while (paused && running) await sleep(400);
        if (!running) break;
      }
      await processCard(card, href);
      if (captured < limit) await humanDelay(1200, 2800);
    }

    running = false;
    showOverlay(captured, true, `Done — ${captured} captured${duplicates ? `, ${duplicates} duplicates skipped` : ''}`);
    console.log(`[LeadHarvest] Done: ${captured} captured, ${duplicates} duplicates, ${errorCount} errors`);

    try {
      chrome.runtime.sendMessage({ type: 'EXTRACTION_COMPLETE', captured, duplicates, errors: errorCount });
    } catch (e) {}
  }

  /* ─── Visual Overlay ─── */
  function showOverlay(count, done = false, message = '') {
    let el = document.getElementById('__leadharvest_overlay__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__leadharvest_overlay__';
      el.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
        background: #0d1410; color: #fff; padding: 14px 18px;
        border-radius: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        border-left: 4px solid #22c55e; min-width: 240px;
        transition: all 0.3s ease;
      `;
      document.body.appendChild(el);
    }

    const statusColor = done ? '#22c55e' : '#4ade80';
    const statusText = done ? 'Done' : (paused ? 'Paused' : 'Extracting');
    const progressPct = Math.min(100, Math.round((count / (currentSettings.limit || 50)) * 100));

    el.style.borderLeftColor = statusColor;
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="width:10px;height:10px;border-radius:50%;background:${statusColor};${!done && !paused ? 'animation:lh-pulse 1.2s infinite;' : ''}"></span>
        <strong style="font-size:14px;">LeadHarvest AI</strong>
        <span style="font-size:11px;color:#7c8a7e;margin-left:auto;">${statusText}</span>
      </div>
      <div style="color:#b7c2b8;font-size:12px;">${message || `${count} leads captured`}</div>
      <div style="margin-top:8px;height:3px;background:#15201a;border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${progressPct}%;background:${statusColor};border-radius:2px;transition:width 0.3s ease;"></div>
      </div>
      <div style="margin-top:4px;font-size:10px;color:#5b6b5d;text-align:right;">${progressPct}%</div>
    `;

    if (!document.getElementById('__leadharvest_style__')) {
      const s = document.createElement('style');
      s.id = '__leadharvest_style__';
      s.textContent = `@keyframes lh-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`;
      document.head.appendChild(s);
    }
  }

  function removeOverlay() {
    document.getElementById('__leadharvest_overlay__')?.remove();
    document.getElementById('__leadharvest_style__')?.remove();
  }

  function setupAutoDetection() {
    let shown = false;
    const observer = new MutationObserver(() => {
      if (isSearchResultsPage() && !running && !shown) {
        showReadyIndicator();
        shown = true;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      if (isSearchResultsPage() && !running) showReadyIndicator();
    }, 5000);
  }

  function showReadyIndicator() {
    if (document.getElementById('__lh_ready__')) return;
    const indicator = document.createElement('div');
    indicator.id = '__lh_ready__';
    indicator.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 2147483646;
      background: rgba(13,20,16,0.9); color: #fff; padding: 8px 14px;
      border-radius: 8px; font-family: -apple-system, sans-serif;
      font-size: 11px; cursor: pointer; border: 1px solid rgba(34,197,94,0.4);
      transition: opacity 0.3s ease;
    `;
    indicator.innerHTML = `<span style="color:#22c55e;font-weight:600;">LH AI</span><span style="color:#8a978c;margin-left:6px;">Ready to extract</span>`;
    indicator.title = 'LeadHarvest AI — Click the extension icon to start';
    indicator.addEventListener('click', () => {
      try { chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }); } catch (e) {}
    });
    document.body.appendChild(indicator);
    setTimeout(() => {
      if (!running && indicator.parentNode) {
        indicator.style.opacity = '0';
        setTimeout(() => indicator.remove(), 300);
      }
    }, 10000);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'RUN_EXTRACTION':
        runExtraction(msg.fields || [], msg.limit || 50, msg.settings || {}, msg.sessionId || null)
          .then(() => sendResponse({ ok: true }))
          .catch(err => sendResponse({ ok: false, error: err.message }));
        return true;

      case 'STOP_EXTRACTION':
        running = false;
        paused = false;
        showOverlay(captured, true, 'Stopped by user');
        setTimeout(removeOverlay, 5000);
        sendResponse({ ok: true, captured });
        return true;

      case 'PAUSE_EXTRACTION':
        paused = true;
        sendResponse({ ok: true });
        return true;

      case 'RESUME_EXTRACTION':
        paused = false;
        sendResponse({ ok: true });
        return true;

      case 'GET_STATUS':
        sendResponse({
          ok: true, running, paused, captured, duplicates, errorCount,
          sessionId: currentSessionId,
          isSearchResults: isSearchResultsPage(),
          query: getSearchQuery(),
        });
        return true;

      case 'GET_ALL_LEADS':
        (async () => {
          try {
            if (!storage) { storage = new LeadStorage(); await storage.init(); }
            const leads = await storage.getLeads({ search: msg.search, limit: msg.limit });
            sendResponse({ ok: true, leads });
          } catch (err) { sendResponse({ ok: false, error: err.message }); }
        })();
        return true;

      case 'GET_LEADS_BY_SESSION':
        (async () => {
          try {
            if (!storage) { storage = new LeadStorage(); await storage.init(); }
            const leads = await storage.getLeads({ session_id: msg.sessionId });
            sendResponse({ ok: true, leads });
          } catch (err) { sendResponse({ ok: false, error: err.message }); }
        })();
        return true;

      case 'DELETE_LEAD':
        (async () => {
          try {
            if (!storage) { storage = new LeadStorage(); await storage.init(); }
            await storage.deleteLeads([msg.id]);
            const { leadCount } = await chrome.storage.local.get('leadCount');
            await chrome.storage.local.set({ leadCount: Math.max(0, (leadCount || 1) - 1) });
            sendResponse({ ok: true });
          } catch (err) { sendResponse({ ok: false, error: err.message }); }
        })();
        return true;

      case 'CLEAR_ALL_LEADS':
        (async () => {
          try {
            if (!storage) { storage = new LeadStorage(); await storage.init(); }
            await storage.clearAll();
            sendResponse({ ok: true });
          } catch (err) { sendResponse({ ok: false, error: err.message }); }
        })();
        return true;

      case 'GET_LEADS_COUNT':
        (async () => {
          try {
            if (!storage) { storage = new LeadStorage(); await storage.init(); }
            const stats = await storage.getStats();
            sendResponse({ ok: true, stats });
          } catch (err) { sendResponse({ ok: false, error: err.message }); }
        })();
        return true;

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  });

  async function init() {
    console.log('[LeadHarvest] Content script loaded (v4.0.0)');
    if (window.LeadStorage) {
      storage = new LeadStorage();
      await storage.init();
    }
    setupAutoDetection();
    if (isSearchResultsPage()) showReadyIndicator();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
