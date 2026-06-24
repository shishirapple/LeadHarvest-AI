/**
 * LeadHarvest AI — Website Intelligence Module
 * Runs in the background service worker (host_permissions grant CORS-free fetch reads).
 *
 * For every business website this:
 *   1. Fetches the homepage + a few likely contact/about pages, looking for emails.
 *   2. Falls back to a hidden background tab if direct fetch is blocked (JS-rendered sites).
 *   3. Fingerprints the CMS/platform (WordPress, Shopify, Wix, Squarespace, Webflow,
 *      GoDaddy builder, or Custom) from the same HTML it already downloaded — zero
 *      extra requests. This is genuinely useful beyond lead-gen: a business on a
 *      DIY builder or with no website at all is a much hotter prospect for web
 *      design/dev services than one already on a solid custom/WordPress stack.
 */

const FETCH_TIMEOUT_MS = 8000;
const TAB_TIMEOUT_MS = 12000;
const CANDIDATE_PATHS = ['/', '/contact', '/contact-us', '/about', '/about-us'];

const BLOCKLIST_PATTERNS = [
  /\.(png|jpe?g|gif|svg|webp|css|js)$/i,
  /sentry\.io/i,
  /wixpress\.com/i,
  /schema\.org/i,
  /godaddy\.com/i,
  /example\.com/i,
  /your-?email/i,
  /username@/i,
  /^\d+x\d+@/i,
];

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function isJunkEmail(email) {
  return BLOCKLIST_PATTERNS.some((re) => re.test(email));
}

function pickBestEmail(candidates, domain) {
  if (candidates.length === 0) return null;
  const clean = [...new Set(candidates.map((e) => e.toLowerCase()))].filter((e) => !isJunkEmail(e));
  if (clean.length === 0) return null;
  const sameDomain = clean.find((e) => domain && e.endsWith('@' + domain));
  if (sameDomain) return sameDomain;
  const preferredPrefixes = ['info', 'contact', 'hello', 'sales', 'support', 'office', 'admin'];
  for (const prefix of preferredPrefixes) {
    const match = clean.find((e) => e.startsWith(prefix + '@'));
    if (match) return match;
  }
  return clean[0];
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

function extractEmailsFromHtml(html) {
  const found = new Set();
  const mailtoMatches = html.matchAll(/href=["']mailto:([^"'?\s]+)/gi);
  for (const m of mailtoMatches) found.add(m[1]);
  const plainMatches = html.match(EMAIL_REGEX) || [];
  for (const e of plainMatches) found.add(e);
  return [...found];
}

/** Fingerprint the CMS/platform from raw HTML. Zero extra network cost. */
function detectPlatform(html) {
  if (!html) return null;
  const h = html.toLowerCase();
  if (h.includes('wp-content') || h.includes('wp-includes') || h.includes('/wp-json/')) return 'WordPress';
  if (h.includes('cdn.shopify.com') || h.includes('shopify.theme') || h.includes('myshopify.com')) return 'Shopify';
  if (h.includes('static.wixstatic.com') || h.includes('wix.com') || h.includes('_wixclientid')) return 'Wix';
  if (h.includes('static1.squarespace.com') || h.includes('squarespace-cdn.com')) return 'Squarespace';
  if (h.includes('webflow.com') || h.includes('.webflow.io') || h.includes('data-wf-site')) return 'Webflow';
  if (h.includes('godaddysites.com') || h.includes('godaddy.com/websitebuilder')) return 'GoDaddy Builder';
  if (h.includes('weebly.com') || h.includes('cdn2.editmysite.com')) return 'Weebly';
  return 'Custom/Other';
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function tryFetchStrategy(baseUrl) {
  let origin;
  try { origin = new URL(baseUrl).origin; }
  catch { return { ok: false, reason: 'invalid_url', platform: null }; }

  const domain = extractDomain(baseUrl);
  const collected = [];
  let anyPageLoaded = false;
  let homepageHtml = null;

  for (const path of CANDIDATE_PATHS) {
    const html = await fetchWithTimeout(origin + path, FETCH_TIMEOUT_MS);
    if (html === null) continue;
    anyPageLoaded = true;
    if (path === '/') homepageHtml = html;
    collected.push(...extractEmailsFromHtml(html));
    const best = pickBestEmail(collected, domain);
    if (best) return { ok: true, email: best, method: 'fetch', path, platform: detectPlatform(homepageHtml || html) };
  }

  return {
    ok: false,
    reason: anyPageLoaded ? 'no_email_found' : 'fetch_blocked',
    platform: detectPlatform(homepageHtml),
  };
}

async function tryHiddenTabStrategy(baseUrl) {
  let tab;
  try { tab = await chrome.tabs.create({ url: baseUrl, active: false }); }
  catch { return { ok: false, reason: 'tab_create_failed', platform: null }; }

  try {
    return await Promise.race([
      waitForTabAndScan(tab.id, baseUrl),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'timeout', platform: null }), TAB_TIMEOUT_MS)),
    ]);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabAndScan(tabId, baseUrl) {
  return new Promise((resolve) => {
    const onUpdated = async (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      await new Promise((r) => setTimeout(r, 1500));

      try {
        const injection = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const html = document.documentElement.outerHTML;
            const mailtos = [...document.querySelectorAll('a[href^="mailto:"]')].map((a) =>
              a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0]
            );
            return { html, mailtos };
          },
        });

        const data = injection?.[0]?.result;
        if (!data) return resolve({ ok: false, reason: 'inject_failed', platform: null });

        const domain = extractDomain(baseUrl);
        const found = new Set([...data.mailtos, ...extractEmailsFromHtml(data.html)]);
        const best = pickBestEmail([...found], domain);
        const platform = detectPlatform(data.html);

        if (best) resolve({ ok: true, email: best, method: 'hidden_tab', platform });
        else resolve({ ok: false, reason: 'no_email_found', platform });
      } catch {
        resolve({ ok: false, reason: 'scan_error', platform: null });
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/** Main entry point. email is null (not an error) when nothing could be found. */
export async function findEmailForWebsite(websiteUrl) {
  if (!websiteUrl) return { ok: true, email: null, method: null, platform: null };

  const fetchResult = await tryFetchStrategy(websiteUrl);
  if (fetchResult.ok) {
    return { ok: true, email: fetchResult.email, method: fetchResult.method, platform: fetchResult.platform };
  }

  let platform = fetchResult.platform || null;

  if (fetchResult.reason === 'fetch_blocked') {
    const tabResult = await tryHiddenTabStrategy(websiteUrl);
    if (tabResult.ok) return { ok: true, email: tabResult.email, method: tabResult.method, platform: tabResult.platform || platform };
    platform = tabResult.platform || platform;
  }

  return { ok: true, email: null, method: null, platform };
}
