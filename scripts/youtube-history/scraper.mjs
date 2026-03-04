/**
 * Scrapes YouTube watch history from /feed/history using Playwright.
 * Expects YOUTUBE_COOKIES env: JSON array of { name, value, domain, path }.
 * Writes to stdout a JSON array of { id, title, author, thumbnailUrl }.
 */

import { chromium } from 'playwright';

const HISTORY_URL = 'https://www.youtube.com/feed/history';
const MAX_ENTRIES = 100;
const SCROLL_PAUSE_MS = 1500;
const VIDEO_ID_RE = /(?:watch\?v=)([a-zA-Z0-9_-]{11})/;

/**
 * Playwright only accepts: name, value, domain, path, expires, httpOnly, secure, sameSite.
 * Chromium can reject cookies if optional fields are present with wrong types. We build
 * a minimal object with only allowed keys and correct types.
 */
function parseCookies(jsonStr) {
  if (!jsonStr || !jsonStr.trim()) return [];
  try {
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const c of arr) {
      const name = c.name != null ? String(c.name) : '';
      const value = c.value != null ? String(c.value) : '';
      if (!name) continue;
      const domain = (c.domain && String(c.domain).trim()) || '.youtube.com';
      const path = (c.path != null && String(c.path).trim()) || '/';
      const cookie = { name, value };
      const isYoutube = domain === '.youtube.com' || domain === 'www.youtube.com' || domain.endsWith('.youtube.com');
      if (isYoutube) {
        cookie.url = 'https://www.youtube.com/';
      } else {
        cookie.domain = domain;
        cookie.path = path;
      }
      const expires = c.expires != null ? Number(c.expires) : c.expirationDate != null ? Number(c.expirationDate) : NaN;
      if (Number.isFinite(expires) && expires > 0) cookie.expires = Math.floor(expires);
      if (c.httpOnly === true || c.httpOnly === 'true') cookie.httpOnly = true;
      if (c.secure === true || c.secure === 'true' || name.startsWith('__Secure-') || name.startsWith('__Host-')) cookie.secure = true;
      const ss = c.sameSite;
      if (ss === 'Strict' || ss === 'Lax' || ss === 'None') {
        cookie.sameSite = ss;
      } else if (cookie.secure) {
        cookie.sameSite = 'None';
      } else {
        cookie.sameSite = 'Lax';
      }
      out.push(cookie);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Returns true if the page shows a signed-in YouTube session, false otherwise.
 * Checks for Sign in CTA (logged out) and for avatar/account button (logged in).
 */
async function ensureLoggedIn(page) {
  const signInLink = page.locator('a[href*="ServiceLogin"], a[href*="SignIn"], ytd-button-renderer a[href*="accounts.google.com"]').first();
  const signInVisible = await signInLink.isVisible().catch(() => false);

  const signInPromptText = page.getByText(/sign in to (see|view) your (watch )?history/i);
  const promptVisible = await signInPromptText.isVisible().catch(() => false);

  if (signInVisible || promptVisible) {
    return false;
  }

  const avatarOrAccount = page.locator('#avatar-btn, button[aria-label*="Google Account"], button[aria-label*="Account"], #account-button').first();
  const hasAvatar = await avatarOrAccount.isVisible().catch(() => false);

  if (hasAvatar) {
    return true;
  }

  const currentUrl = page.url();
  if (!currentUrl.includes('youtube.com')) {
    return false;
  }

  const mastheadSignIn = page.locator('ytd-masthead a[href*="ServiceLogin"], ytd-masthead a[href*="SignIn"]').first();
  const mastheadSignInVisible = await mastheadSignIn.isVisible().catch(() => false);

  return !mastheadSignInVisible;
}

async function scrape() {
  const cookiesJson = process.env.YOUTUBE_COOKIES || '[]';
  const cookies = parseCookies(cookiesJson);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    ignoreHTTPSErrors: false,
  });

  const page = await context.newPage();

  if (cookies.length > 0) {
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await context.addCookies(cookies);
  }

  try {
    await page.goto(HISTORY_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    await browser.close();
    throw new Error(`Failed to load history page: ${e.message}`);
  }

  const loggedIn = await ensureLoggedIn(page);
  if (!loggedIn) {
    await browser.close();
    throw new Error(
      'YouTube login failed: session cookies did not result in a signed-in session. ' +
        'Re-export cookies (youtube.com and optionally .google.com) and try again.'
    );
  }

  const entries = [];
  const seenIds = new Set();

  const extractFromPage = async () => {
    const links = await page.$$('ytd-section-list-renderer[page-subtype="history"] yt-lockup-view-model a[href*="watch?v="]');
    for (const link of links) {
      if (entries.length >= MAX_ENTRIES) break;

      const href = (await link.getAttribute('href')) || '';
      const match = href.match(VIDEO_ID_RE);
      const id = match ? match[1] : null;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const lockup = await link.evaluate((el) => {
        const lock = el.closest('yt-lockup-view-model');
        if (!lock) return { title: '', author: '' };
        const titleEl = lock.querySelector('a.yt-lockup-metadata-view-model__title, .yt-lockup-metadata-view-model__title');
        const title = (titleEl?.textContent?.trim() || titleEl?.closest('h3')?.getAttribute('title') || '').slice(0, 200);
        const firstMetaRow = lock.querySelector('.yt-content-metadata-view-model__metadata-row');
        const authorSpan = firstMetaRow?.querySelector('.yt-content-metadata-view-model__metadata-text');
        let author = authorSpan?.textContent?.trim() || '';
        if (!author) {
          const avatar = lock.querySelector('[aria-label*="canal"], [aria-label*="channel"]');
          const label = avatar?.getAttribute('aria-label') || '';
          const m = label.match(/(?:canal|channel)\s+(.+)$/i);
          author = m ? m[1].trim() : '';
        }
        return { title, author };
      }).catch(() => ({ title: '', author: '' }));

      const title = (lockup?.title || '').trim() || (await link.getAttribute('aria-label')) || '';
      const author = (lockup?.author || '').trim();

      const thumbnailUrl = `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
      entries.push({ id, title, author, thumbnailUrl });
    }
  };

  await extractFromPage();

  for (let i = 0; i < 25 && entries.length < MAX_ENTRIES; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(SCROLL_PAUSE_MS);
    await extractFromPage();
  }

  await browser.close();
  return entries;
}

scrape()
  .then((entries) => {
    process.stdout.write(JSON.stringify(entries, null, 0));
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
