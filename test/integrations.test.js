'use strict';
/** Patch watcher, match detection, prompt caching split, key transport guard. No network: fetch is stubbed. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pw = require('../src/main/patchwatch');
const mw = require('../src/main/matchwatch');
const { buildSystemBlocks } = require('../src/main/brain/prompt');
const { assertSafeKeyTransport } = require('../src/main/brain/providers');

(async () => {
  // --- prompt cache split: static block must not change with state / notes / patch info
  const a = buildSystemBlocks({ state: { myCiv: 'Franks' }, keyData: 'NOTES A', patchInfo: 'x' });
  const b = buildSystemBlocks({ state: { myCiv: 'Mongols', oppCiv: 'Huns', source: 'detected' }, keyData: 'NOTES B', patchInfo: 'y', dataVersion: 'abc1234' });
  assert.strictEqual(a[0], b[0], 'static system block must be identical across questions (prompt cache)');
  assert.ok(b[1].includes('NOTES B') && b[1].includes('source: detected') && b[1].includes('abc1234'));
  assert.ok(!a[0].includes('NOTES A'), 'retrieved notes must not leak into the cached block');

  // --- patch watcher with the real feed shape (RSS 2.0 + content:encoded)
  const feed = `<rss><channel><item><title>The Crucible Reforged in Age of Empires IV</title><link>https://www.ageofempires.com/news/the-crucible-reforged-in-aoe-iv/</link><pubDate>Fri, 16 Oct 2026 18:58:49 +0000</pubDate></item>
<item><title><![CDATA[Age of Empires II: Definitive Edition &#8211; Update 191234]]></title><link>https://www.ageofempires.com/news/age-of-empires-ii-definitive-edition-update-191234/</link><pubDate>Tue, 20 Oct 2026 17:00:00 +0000</pubDate><content:encoded><![CDATA[<h2>Civilizations</h2><h3>Franks</h3><ul><li>Throwing Axeman range 5 &rarr; 4.</li></ul><p>${'z'.repeat(600)}</p>]]></content:encoded></item></channel></rss>`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aoe2c-'));
  let pageFetches = 0;
  const r = await pw.check({
    cacheDir: tmp,
    knowledgeDir: tmp,
    reviewed: '185872',
    force: true,
    fetchText: async (u) => {
      if (/feed/.test(u)) return feed;
      pageFetches++;
      return '';
    },
  });
  assert.deepStrictEqual(
    r.newBuilds.map((x) => x.build),
    ['191234']
  );
  assert.strictEqual(pageFetches, 0, 'uses the feed full text');
  const note = fs.readFileSync(path.join(tmp, 'parches_auto_191234.md'), 'utf8');
  assert.ok(/## Parche 191234: Franks/.test(note) && note.includes('5 → 4'), 'note keeps headings and decodes arrows');
  const again = await pw.check({
    cacheDir: tmp,
    knowledgeDir: tmp,
    reviewed: '185872',
    force: false,
    fetchText: async () => {
      throw new Error('must not fetch');
    },
  });
  assert.ok(again.skipped, 'checks at most once a day');
  assert.ok(/NEW PATCH: Update 191234/.test(pw.statusLine({ reviewed: '185872', latest: '191234', seen: {} })));
  const offline = await pw.check({
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'aoe2c-')),
    knowledgeDir: tmp,
    reviewed: '185872',
    force: true,
    fetchText: async () => {
      throw new Error('offline');
    },
  });
  assert.ok(offline.error && !offline.newBuilds.length, 'offline never throws');

  // --- match detection with the verified aoe2companion shape
  const now = Date.parse('2026-10-18T20:00:00Z');
  const api = {
    matches: [
      {
        matchId: 1,
        started: '2026-10-18T19:40:00Z',
        finished: null,
        leaderboardName: '1v1 Random Map',
        mapName: 'Arabia',
        teams: [
          { teamId: 1, players: [{ profileId: 42, name: 'me', civ: 'franks', civName: 'Franks', rating: 1210, team: 1 }] },
          { teamId: 2, players: [{ profileId: 7, name: 'op', civ: 'mongols', civName: 'Mongols', rating: 1230, team: 2 }] },
        ],
      },
    ],
  };
  const fetchImpl = async () => ({ ok: true, json: async () => api });
  const m = await mw.latestMatch(42, { fetchImpl, now });
  assert.ok(m.live && m.me.civ === 'Franks' && m.opponents[0].civ === 'Mongols' && m.map === 'Arabia');
  assert.ok(/Franks \(1210\) vs Mongols \(1230\) · Arabia/.test(mw.describe(m)));
  const old = mw.normalise({ ...api.matches[0], finished: '2026-10-18T19:59:00Z' }, 42, now);
  assert.ok(!old.live, 'finished match is not live');
  assert.strictEqual(mw.normalise(api.matches[0], 999, now), null, 'match without the player is ignored');
  const seen = [];
  const poller = mw.createPoller({
    now: () => now,
    getProfileId: () => 42,
    enabled: () => true,
    onMatch: (x) => seen.push(x.id),
    fetchImpl: async () => ({ ok: true, json: async () => api }),
  });
  await poller.now();
  await poller.now();
  assert.deepStrictEqual(seen, [1], 'same live match reported once');
  const failing = mw.createPoller({
    getProfileId: () => 42,
    enabled: () => true,
    onMatch: () => assert.fail('no'),
    fetchImpl: async () => {
      throw new Error('down');
    },
  });
  assert.strictEqual(await failing.now(), null);
  assert.strictEqual(failing.status().lastError, 'down');

  // --- key transport guard
  assert.doesNotThrow(() => assertSafeKeyTransport('https://api.groq.com/openai/v1/chat/completions', 'k'));
  assert.doesNotThrow(() => assertSafeKeyTransport('http://localhost:11434/v1/chat/completions', 'k'));
  assert.doesNotThrow(() => assertSafeKeyTransport('http://100.88.1.2:11434/v1/chat/completions', 'k'));
  assert.throws(() => assertSafeKeyTransport('http://example.com/v1/chat/completions', 'k'));
  assert.doesNotThrow(() => assertSafeKeyTransport('http://example.com/v1/chat/completions', ''));
  // --- defaults (v0.19): prompt cache split ON, privacy extras and match detection opt-in, logs kept 30 days
  const { systemBlocks } = require('../src/main/brain/providers');
  const { DEFAULTS, Settings, sanitizePatch } = require('../src/main/settings');
  assert.strictEqual(DEFAULTS.experimentalCache, true);
  assert.strictEqual(DEFAULTS.experimentalPrivacy, false);
  assert.strictEqual(DEFAULTS.matchDetect, false);
  assert.strictEqual(Number(DEFAULTS.logRetentionDays), 30, 'logs are pruned after 30 days by default');
  assert.strictEqual(DEFAULTS.theme, 'taverna', 'the tavern look is the default appearance');
  assert.deepStrictEqual(sanitizePatch({ theme: 'taverna-night' }).patch, { theme: 'taverna-night' });
  assert.deepStrictEqual(sanitizePatch({ theme: 'neon' }).rejected, ['theme'], 'unknown themes are refused');
  const one = systemBlocks('RULES + NOTES');
  assert.strictEqual(one.length, 1);
  assert.ok(one[0].cache_control, 'a string = one cached system block');
  assert.strictEqual(systemBlocks(['A', 'B']).length, 2, 'split layout when passed an array');
  // --- settings: unknown keys and wrong types never reach the file; writes are atomic (tmp + rename)
  const sp = sanitizePatch({
    opacity: 0.8,
    uiLanguage: 'xx',
    bogus: 1,
    hotkeys: { ask: 'F10', nope: 'x' },
    logRetentionDays: '30',
    anthropicBaseUrl: 'https://x',
  });
  assert.deepStrictEqual(sp.patch, { opacity: 0.8, hotkeys: { ask: 'F10' }, anthropicBaseUrl: 'https://x' });
  assert.deepStrictEqual(sp.rejected.sort(), ['bogus', 'logRetentionDays', 'uiLanguage']);
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoe2s-'));
  const sfile = path.join(sdir, 'settings.json');
  const st = new Settings(sfile);
  st.set({ compact: false, junk: true });
  assert.ok(!fs.existsSync(sfile + '.tmp'));
  assert.strictEqual(JSON.parse(fs.readFileSync(sfile, 'utf8')).compact, false);
  assert.ok(!('junk' in JSON.parse(fs.readFileSync(sfile, 'utf8'))));
  fs.writeFileSync(sfile, '{"compact": fal');
  const broken = new Settings(sfile);
  assert.strictEqual(broken.get().compact, true, 'corrupt file → defaults');
  assert.ok(fs.existsSync(sfile + '.corrupt'), 'corrupt file kept aside');
  // --- patch notes only from the official site
  assert.ok(pw.officialLink('https://www.ageofempires.com/news/age-of-empires-ii-definitive-edition-update-191234/'));
  assert.ok(!pw.officialLink('https://evil.example.com/ageofempires.com/') && !pw.officialLink('http://www.ageofempires.com/x'));
  console.log('integration tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
