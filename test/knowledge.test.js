'use strict';
/** Knowledge-base integrity: what the coach reads must be searchable, not truncated, and consistent about the current patch. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Knowledge, tierOf } = require('../src/main/engine/knowledge');
const { validate } = require('../src/main/engine/buildorders');
const CURRENT_PATCH = '185872';
const KDIR = path.join(__dirname, '..', 'data', 'knowledge');
const k = new Knowledge([KDIR]).load();
assert.ok(k.sections.length > 1000, 'knowledge loaded');
const tooLong = k.sections.filter(s => s.body.length > 1800);
assert.deepStrictEqual(tooLong.map(s => `${s.file}: ${s.title}`), [], 'sections longer than the 1800-char search window');
const seen = new Map(); const dups = [];
for (const s of k.sections) { const key = s.file + '|' + s.title; if (seen.has(key)) dups.push(key); seen.set(key, 1); }
assert.deepStrictEqual(dups, [], 'duplicate section titles inside one file (ambiguous for retrieval)');
// every "current patch" claim in the notes names the same build
const claims = new Set();
for (const f of fs.readdirSync(KDIR).filter(x => x.endsWith('.md'))) for (const m of fs.readFileSync(path.join(KDIR, f), 'utf8').matchAll(/parche actual[^\d\n;:,.]{0,12}(\d{5,6})/g)) claims.add(m[1]);
assert.deepStrictEqual([...claims], [CURRENT_PATCH], 'notes disagree about the current patch');
// the current patch is the newest one in the patch history
const hist = fs.readFileSync(path.join(KDIR, 'parches_historial.md'), 'utf8');
const builds = [...hist.matchAll(/- (\d{4}-\d{2}-\d{2}) — (?:Update|Hotfix) (\d{5,6})/g)].map(m => [m[1], m[2]]);
assert.strictEqual(builds[builds.length - 1][1], CURRENT_PATCH, 'parches_historial does not end at the current patch');
for (let i = 1; i < builds.length; i++) assert.ok(builds[i][0] >= builds[i - 1][0], 'patch history out of order at ' + builds[i][1]);
// tiers and aliases
assert.strictEqual(tierOf('poop_lord_book_of_memes.md'), 'meme'); assert.strictEqual(tierOf('break_the_meta.md'), 'anti-meta'); assert.strictEqual(tierOf('hera_builds.md'), 'meta');
const top = (q) => k.search(q, { limit: 5 });
assert.ok(top('malienses contra arqueros').some(h => /mal[ií]/i.test(h.title + h.text)), 'alias malienses→malíes/malians');
assert.ok(top('como defender rush de torres')[0].tier === 'meta', 'a normal defensive question ranks meta notes first');
assert.ok(top('meme con daneses').some(h => h.tier === 'meme'), 'asking for a meme surfaces meme notes');
const perVideo = top('build order arqueros contra scouts').map(h => h.title.replace(/: (lecciones|VIGENCIA hoy).*$/, ''));
assert.ok(new Set(perVideo).size >= 3, 'search returns different notes, not three chunks of one video');
// bundled rtsbuilds all validate
const bdir = path.join(__dirname, '..', 'data', 'build_orders', 'rtsbuilds');
for (const f of fs.readdirSync(bdir).filter(x => x.endsWith('.json'))) { const errs = validate(JSON.parse(fs.readFileSync(path.join(bdir, f), 'utf8'))); assert.deepStrictEqual(errs, [], f); }
console.log(`knowledge tests passed: ${k.sections.length} sections, ${builds.length} patches, current ${CURRENT_PATCH}`);
