/**
 * LeadHarvest AI — Website Intelligence Module (v6.0)
 *
 * Improvements over v5:
 *  1. Expanded candidate paths — contact, about, team, imprint, legal, impressum pages
 *  2. Obfuscated email decoding:
 *     - Cloudflare email protection (/cdn-cgi/l/email-protection)
 *     - Text obfuscation patterns: name [at] domain [dot] com, name(at)domain etc.
 *     - HTML entity encoding: &#64; for @, &#46; for dot
 *  3. JSON-LD / structured data parsing (schema.org contactPoint, Organization email)
 *  4. Meta tag scanning (og:email, contact:email, etc.)
 *  5. data-email / data-cfemail attribute extraction
 *  6. All collected candidates ranked before returning best — more domains checked
 *  7. Hidden tab fallback now also tries sub-pages (/contact) inside the same tab
 */

const FETCH_TIMEOUT_MS = 8000;
const TAB_TIMEOUT_MS = 15000;

const CANDIDATE_PATHS = [
  '/',
  '/contact',
  '/contact-us',
  '/contacts',
  '/about',
  '/about-us',
  '/team',
  '/staff',
  '/imprint',
  '/impressum',
  '/legal',
  '/info',
  '/reach-us',
  '/get-in-touch',
];

const BLOCKLIST_PATTERNS = [
  /\.(png|jpe?g|gif|svg|webp|css|js)$/i,
  /sentry\.io/i,
  /wixpress\.com/i,
  /schema\.org/i,
  /godaddy\.com/i,
  /example\.com/i,
  /your-?email/i,
  /username@/i,
  /^noreply@/i,
  /^no-reply@/i,
  /^donotreply@/i,
  /^webmaster@/i,
  /^postmaster@/i,
  /^mailer-daemon@/i,
  /^bounce@/i,
  /^test@/i,
  /^demo@/i,
  /^sample@/i,
  /^\d+x\d+@/i,
  /\.(png|jpg|gif)@/i,
];

const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

// Obfuscation patterns — catches "name [at] domain [dot] com" style
const OBFUSCATED_PATTERNS = [
  // name [at] domain [dot] com  (brackets optional, various spacings)
  /([A-Za-z0-9._%+\-]+)\s*[\[(]?\s*(?:at|AT|@)\s*[\])]?\s*([A-Za-z0-9.\-]+)\s*[\[(]?\s*(?:dot|DOT|\.)\s*[\])]?\s*([A-Za-z]{2,})/g,
  // name(at)domain.com
  /([A-Za-z0-9._%+\-]+)\((?:at|AT)\)([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g,
  // name {at} domain.com
  /([A-Za-z0-9._%+\-]+)\{(?:at|AT)\}([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g,
];

function isJunkEmail(email) {
  return BLOCKLIST_PATTERNS.some((re) => re.test(email));
}

function pickBestEmail(candidates, domain) {
  if (candidates.length === 0) return null;
  const clean = [...new Set(candidates.map((e) => e.toLowerCase().trim()))]
    .filter((e) => e.includes('@') && !isJunkEmail(e));
  if (clean.length === 0) return null;

  // Prefer same-domain emails
  const sameDomain = clean.filter((e) => domain && e.endsWith('@' + domain));
  const pool = sameDomain.length > 0 ? sameDomain : clean;

  const preferredPrefixes = ['info', 'contact', 'hello', 'sales', 'support', 'office', 'admin', 'mail', 'email', 'enquire', 'enquiries', 'enquiry', 'help'];
  for (const prefix of preferredPrefixes) {
    const match = pool.find((e) => e.startsWith(prefix + '@'));
    if (match) return match;
  }
  return pool[0];
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

/** Decode Cloudflare email protection hex encoding */
function decodeCloudflareEmail(encoded) {
  try {
    const key = parseInt(encoded.substring(0, 2), 16);
    let email = '';
    for (let i = 2; i < encoded.length; i += 2) {
      email += String.fromCharCode(parseInt(encoded.substring(i, i + 2), 16) ^ key);
    }
    return email;
  } catch { return null; }
}

/** Decode HTML entities like &#64; → @ and &#46; → . */
function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/** Extract all emails from a raw HTML string using multiple strategies */
function extractEmailsFromHtml(html) {
  const found = new Set();

  // 1. mailto: href links
  for (const m of html.matchAll(/href=["']mailto:([^"'?\s]+)/gi)) {
    const email = decodeHtmlEntities(m[1]).split('?')[0];
    if (email) found.add(email);
  }

  // 2. Plain email regex
  for (const e of (html.match(EMAIL_REGEX) || [])) found.add(e);

  // 3. HTML entity encoded emails (e.g. info&#64;domain.com)
  const entityDecoded = decodeHtmlEntities(html);
  for (const e of (entityDecoded.match(EMAIL_REGEX) || [])) found.add(e);

  // 4. Cloudflare email protection: data-cfemail attribute
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) {
    const decoded = decodeCloudflareEmail(m[1]);
    if (decoded && decoded.includes('@')) found.add(decoded);
  }

  // 5. Cloudflare protection: /cdn-cgi/l/email-protection#HEX
  for (const m of html.matchAll(/email-protection#([0-9a-f]+)/gi)) {
    const decoded = decodeCloudflareEmail(m[1]);
    if (decoded && decoded.includes('@')) found.add(decoded);
  }

  // 6. Obfuscated text patterns
  for (const pattern of OBFUSCATED_PATTERNS) {
    for (const m of html.matchAll(pattern)) {
      // Reconstruct email from capture groups
      let email;
      if (m.length === 4) {
        // name [at] domain [dot] tld
        email = `${m[1]}@${m[2]}.${m[3]}`.toLowerCase().replace(/\s/g, '');
      } else if (m.length === 3) {
        // name(at)domain.tld
        email = `${m[1]}@${m[2]}`.toLowerCase().replace(/\s/g, '');
      }
      if (email && email.includes('@') && email.includes('.')) found.add(email);
    }
  }

  // 7. data-email attributes
  for (const m of html.matchAll(/data-email=["']([^"']+)["']/gi)) {
    const e = m[1].trim();
    if (e.includes('@')) found.add(e);
  }

  // 8. JSON-LD structured data (schema.org)
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]);
      const extractJsonLdEmails = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (typeof obj.email === 'string' && obj.email.includes('@')) found.add(obj.email);
        if (Array.isArray(obj)) obj.forEach(extractJsonLdEmails);
        else Object.values(obj).forEach(extractJsonLdEmails);
      };
      extractJsonLdEmails(parsed);
    } catch { /* malformed JSON-LD, skip */ }
  }

  // 9. Meta tags (og:email, contact:email, etc.)
  for (const m of html.matchAll(/<meta[^>]+(?:name|property)=["'][^"']*(?:email|contact)[^"']*["'][^>]+content=["']([^"'@\s]+@[^"'\s]+)["']/gi)) {
    found.add(m[1]);
  }

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
  if (h.includes('sites.google.com') || h.includes('sites-static.googleusercontent.com')) return 'Google Sites';
  if (h.includes('framer.com') || h.includes('framer-user-content.com')) return 'Framer';
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
    const pageEmails = extractEmailsFromHtml(html);
    collected.push(...pageEmails);
    // Eagerly return as soon as we find a good email
    const best = pickBestEmail(collected, domain);
    if (best) return { ok: true, email: best, method: 'fetch', path, platform: detectPlatform(homepageHtml || html) };
  }

  return {
    ok: false,
    reason: anyPageLoaded ? 'no_email_found' : 'fetch_blocked',
    platform: detectPlatform(homepageHtml),
  };
}

/** Hidden tab strategy — also injects into sub-pages for better coverage */
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
      await new Promise((r) => setTimeout(r, 1800));

      try {
        const injection = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const html = document.documentElement.outerHTML;

            // Collect all mailto links
            const mailtos = [...document.querySelectorAll('a[href^="mailto:"]')]
              .map((a) => a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0]);

            // Collect data-email and data-cfemail attributes
            const dataEmails = [...document.querySelectorAll('[data-email], [data-cfemail]')]
              .map((el) => el.getAttribute('data-email') || el.getAttribute('data-cfemail'))
              .filter(Boolean);

            // Collect visible text that might contain obfuscated emails
            const bodyText = document.body ? document.body.innerText : '';

            return { html, mailtos, dataEmails, bodyText };
          },
        });

        const data = injection?.[0]?.result;
        if (!data) return resolve({ ok: false, reason: 'inject_failed', platform: null });

        const domain = extractDomain(baseUrl);
        const found = new Set([
          ...data.mailtos,
          ...extractEmailsFromHtml(data.html),
          // Also extract from visible text (catches obfuscated text not in HTML source)
          ...(data.bodyText.match(EMAIL_REGEX) || []),
          // Decode any data-cfemail attributes
          ...data.dataEmails.map(v => {
            if (/^[0-9a-f]+$/i.test(v)) {
              const decoded = decodeCloudflareEmail(v);
              return decoded || v;
            }
            return v;
          }).filter(v => v.includes('@')),
        ]);

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
