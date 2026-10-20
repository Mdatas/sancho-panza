// Web build check: serves docs/ on a local port and drives the real page with Playwright (Chromium).
// Run: npm run build:web && npm run test:web   (CI runs it on every release; locally needs `npx playwright install chromium` once)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..', 'docs');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
};
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = path.join(docs, u === '/' ? 'index.html' : u);
  if (!f.startsWith(docs) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const fails = [];
const check = (cond, msg) => {
  if (!cond) fails.push(msg);
};
/** Launch Playwright's Chromium; when the exact revision is missing (sandboxes with a preinstalled build), fall back to any Chromium under PLAYWRIGHT_BROWSERS_PATH. */
async function launch() {
  if (process.env.PW_EXECUTABLE) return chromium.launch({ executablePath: process.env.PW_EXECUTABLE });
  try {
    return await chromium.launch();
  } catch (e) {
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!root || !fs.existsSync(root)) throw e;
    for (const d of fs
      .readdirSync(root)
      .filter((x) => /^chromium-\d+$/.test(x))
      .sort()
      .reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const exe = path.join(root, d, rel);
        if (fs.existsSync(exe)) return chromium.launch({ executablePath: exe });
      }
    }
    throw e;
  }
}
const browser = await launch();
try {
  for (const [label, viewport] of [
    ['desktop', { width: 1280, height: 860 }],
    ['phone', { width: 390, height: 844 }],
  ]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      // resource 404s are reported with their URL by the response listener below (the console line has no URL; the favicon is expected to be missing)
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) errors.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(base + 'index.html');
    await page.waitForSelector('#wSkip', { timeout: 15000 });
    await page.click('#wSkip'); // "use without AI": lands in the Guide
    await page.waitForTimeout(1500);
    check(await page.$eval('#btnGuide', (b) => b.classList.contains('active')), `${label}: guide tab active after welcome`);
    const frame = page.frameLocator('#guideFrame');
    await frame.locator('#civList .item').first().waitFor({ timeout: 20000 });
    check((await frame.locator('#civList .item').count()) === 56, `${label}: 56 civs listed`);
    // omnibox: a civ, a map, a unit
    await frame.locator('#omniQ').fill('arab');
    await page.waitForTimeout(600);
    check((await frame.locator('#omniOut .oi[data-kind="map"]').count()) >= 1, `${label}: omnibox finds maps`);
    await frame.locator('#omniOut .oi[data-kind="map"]').first().click();
    await page.waitForTimeout(600);
    check(/arabia/i.test(await frame.locator('#mapView h2').textContent()), `${label}: map opened from omnibox`);
    check((await frame.locator('#mapView .mapThumb.big').count()) === 1, `${label}: map picture shown`);
    // chat commands set the state without an API key; counters appear
    await page.click('#tabs button[data-tab="chat"]');
    for (const c of ['/civ francos', '/rivales mongoles, aztecas', '/edad castillos']) {
      await page.fill('#cmd', c);
      await page.press('#cmd', 'Enter');
      await page.waitForTimeout(300);
    }
    check((await page.$$eval('#tbTheirs .slot.set', (x) => x.length)) === 2, `${label}: two enemy shields set`);
    check((await page.$$eval('#tcPanel .tcrow', (x) => x.length)) === 2, `${label}: counters rows for both enemies`);
    // build orders: catalog, a step build, the clock
    await page.click('#tabs button[data-tab="bo"]');
    await page.waitForSelector('#boList .bocard', { timeout: 20000 });
    check((await page.$$eval('#boList .bocard', (x) => x.length)) > 100, `${label}: catalog cards`);
    await page.click('#boList .bocard.steps');
    await page.waitForTimeout(600);
    check(/1\//.test(await page.textContent('#boPos')), `${label}: step 1 loaded`);
    await page.click('#boClock');
    await page.waitForTimeout(1300);
    check(/❚❚ 0:0[1-3]/.test(await page.textContent('#boClock')), `${label}: clock running (${await page.textContent('#boClock')})`);
    await page.click('#boClock');
    check((await page.textContent('#boCivNotes')).length > 10, `${label}: civ start notes next to a generic build`);
    // asking without a key explains what is missing (no network)
    await page.click('#tabs button[data-tab="chat"]');
    await page.fill('#cmd', 'hola');
    await page.press('#cmd', 'Enter');
    await page.waitForTimeout(500);
    check(/API key/i.test(await page.textContent('#answer')), `${label}: missing-key explanation`);
    // settings: streaming toggle present and on by default, advanced folded
    await page.click('#tabs button[data-tab="settings"]');
    check(await page.$eval('#setStreaming', (e) => e.checked), `${label}: streaming on by default`);
    check(!(await page.$eval('#advanced', (e) => e.open)), `${label}: advanced section folded`);
    check(errors.length === 0, `${label}: console errors: ${errors.slice(0, 3).join(' | ')}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (fails.length) {
  console.error('WEB TEST FAILED\n - ' + fails.join('\n - '));
  process.exit(1);
}
console.log('web tests passed (desktop + phone)');
