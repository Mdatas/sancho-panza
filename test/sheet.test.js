'use strict';
/** Ficha de partida: the keyword parser, the sheet blocks and the build suggestions (pure data, no model), plus the screen reader's JSON parsing. */
const assert = require('assert');
const path = require('path');
const { GameData } = require('../src/main/engine/gamedata');
const { BuildOrders } = require('../src/main/engine/buildorders');
const { Knowledge } = require('../src/main/engine/knowledge');
const { Strategy } = require('../src/main/engine/strategy');
const { catalog } = require('../src/main/bocatalog');
const { parseCivStats } = require('../src/main/guideData');
const sheet = require('../src/main/engine/sheet');
const { parseReading, parseBox, DEFAULT_REGION } = require('../src/main/screenread');
const { sanitizePatch, DEFAULTS } = require('../src/main/settings');

const root = path.join(__dirname, '..', 'data');
const gd = new GameData(path.join(root, 'game')).load();
const buildOrders = new BuildOrders([path.join(root, 'build_orders', 'rtsbuilds'), path.join(root, 'build_orders', 'extracted')]).load();
const knowledge = new Knowledge([path.join(root, 'knowledge')]).load();
const strategy = new Strategy([path.join(root, 'knowledge')]).load();
const cat = catalog({ buildOrders, knowledge, gd });
const stats = parseCivStats([path.join(root, 'knowledge')]);
const empty = () => ({ myCiv: '', oppCiv: '', allies: [], enemies: [], age: 0, oppAge: 0, map: '', elo: '', myArmy: '', theirArmy: '', myEco: '', keyFacts: [], notes: '' });

// --- keyword parser (what runs without an API key)
let p = sheet.parseMessage({ gd, strategy, text: 'soy francos contra mayas en arabia, 1100 elo', state: empty() });
assert.deepStrictEqual(p.patch, { map: 'Arabia', my_civ: 'Franks', opp_civ: 'Mayans', elo: '1100' });
p = sheet.parseMessage({ gd, strategy, text: 'francos vs mayas en arena', state: empty() });
assert.strictEqual(p.patch.my_civ, 'Franks', '"X vs Y": X is mine');
assert.strictEqual(p.patch.opp_civ, 'Mayans');
assert.strictEqual(p.patch.map, 'Arena');
p = sheet.parseMessage({ gd, strategy, text: 'I am Britons vs Franks on Arena, in castle age', state: empty() });
assert.deepStrictEqual([p.patch.my_civ, p.patch.opp_civ, p.patch.map, p.patch.age], ['Britons', 'Franks', 'Arena', 3]);
p = sheet.parseMessage({ gd, strategy, text: 'me tira arqueros y skirms, estoy en feudal', state: { ...empty(), myCiv: 'Franks', oppCiv: 'Mayans' } });
assert.strictEqual(p.patch.age, 2);
assert.deepStrictEqual(
  p.units.map((u) => u.name_en),
  ['Archer', 'Skirmisher']
);
assert.strictEqual(p.patch.their_army, 'arqueros y skirms');
assert.strictEqual(p.focus, 'counters');
p = sheet.parseMessage({ gd, strategy, text: 'qué tiene mongoles?', state: { ...empty(), myCiv: 'Franks', oppCiv: 'Mayans' } });
assert.strictEqual(p.subjectCiv, 'Mongols', 'a civ asked about does not change the state');
assert.deepStrictEqual(p.patch, {});
p = sheet.parseMessage({ gd, strategy, text: 'wu vs tupi en nomad', state: empty() });
assert.deepStrictEqual([p.patch.my_civ, p.patch.opp_civ, p.patch.map], ['Wu', 'Tupi', 'Nomad'], 'short civ names count when they are the full name');
p = sheet.parseMessage({ gd, strategy, text: 'con los malos monos', state: empty() });
assert.deepStrictEqual(p.patch, {}, 'no civ from loose prefixes ("mal", "mon")');
assert.deepStrictEqual(p.units, []);
p = sheet.parseMessage({ gd, strategy, text: 'qué build abro?', state: { ...empty(), myCiv: 'Franks' } });
assert.strictEqual(p.focus, 'builds');
p = sheet.parseMessage({ gd, strategy, text: 'cómo es el mapa', state: empty() });
assert.strictEqual(p.focus, 'map');
p = sheet.parseMessage({ gd, strategy, text: 'cuántos aldeanos en madera?', state: empty() });
assert.strictEqual(p.focus, 'eco');
assert.deepStrictEqual(p.units, [], 'villagers are not a counter target');

// --- the sheet itself
let st = { ...empty(), myCiv: 'Franks', oppCiv: 'Mayans', map: 'Arabia', elo: '1100' };
let sh = sheet.buildSheet({ gd, strategy, catalog: cat, state: st, stats, lang: 'es', question: 'me tira arqueros' });
assert.strictEqual(sh.kind, 'sheet');
assert.strictEqual(sh.me.name, 'Francos');
assert.strictEqual(sh.me.style, 'caballería');
assert.ok(sh.me.bonuses.length >= 3 && sh.me.uniqueUnits[0].en === 'Throwing Axeman' && sh.me.uniqueTechs.length === 2);
assert.ok(sh.me.missingUnits.some((x) => /Arbalester/.test(x)) && sh.me.missingTechs.includes('Bracer'));
assert.ok(/scouts/i.test(sh.me.openingHere), 'Arabia → the "abiertos" opening line');
assert.deepStrictEqual(sh.me.openingPrimary, ['Scouts']);
assert.ok(sh.me.stats && sh.me.stats.wr > 40 && sh.me.stats.tier, 'win-rate stats attached');
assert.strictEqual(sh.opp.role, 'opp');
assert.ok(sh.opp.against.length > 20);
assert.strictEqual(sh.map.type, 'abierto');
assert.ok(sh.map.vsLine && /Mayas/.test(sh.map.vsLine), 'the map line about the rival civ: ' + sh.map.vsLine);
assert.strictEqual(sh.counters.from, 'question');
assert.strictEqual(sh.counters.rows[0].unit_en, 'Archer');
assert.ok(sh.counters.rows[0].options.length >= 2 && sh.counters.rows[0].options.every((o) => o.score >= 0.6));
assert.ok(sh.counters.rows[0].options.some((o) => /Skirmisher/.test(o.unit_en)));
assert.ok(sh.builds.steps.length === 3 && sh.builds.steps.every((b) => b.tier === 'meta' && b.kind === 'steps'));
assert.ok(sh.builds.steps[0].types.includes('Scouts') && sh.builds.steps[0].why.includes('opening'), JSON.stringify(sh.builds.steps.map((b) => b.title)));
assert.ok(sh.builds.guides.every((g) => g.tier === 'anti-meta'));
assert.deepStrictEqual(sh.missing, ['age']);
const text = sheet.sheetText(sh);
assert.ok(text.includes('## Mi civ: Francos') && text.includes('## Rival: Maya') && text.includes('## Mapa: Arabia') && text.includes('## Counters') && text.includes('## Builds sugeridos'));
const spoken = sheet.sheetSpoken(sh);
assert.ok(/^vs Arquero: /.test(spoken) && spoken.length < 600, spoken);
// english names / labels
sh = sheet.buildSheet({ gd, strategy, catalog: cat, state: st, stats, lang: 'en', question: 'what beats knights' });
assert.strictEqual(sh.me.name, 'Franks');
assert.strictEqual(sh.counters.rows[0].unit, 'Knight');
assert.ok(sheet.sheetText(sh).includes('## My civ: Franks'));
// a civ asked about shows as a subject block without touching the state; no counters invented
sh = sheet.buildSheet({ gd, strategy, catalog: cat, state: st, stats, lang: 'es', question: 'qué tiene mongoles?' });
assert.strictEqual(sh.subject.key, 'Mongols');
assert.strictEqual(sh.subject.role, 'subject');
assert.strictEqual(sh.state.myCiv, 'Franks');
// empty state: nothing invented, generic builds, the "missing" list tells what to register
sh = sheet.buildSheet({ gd, strategy, catalog: cat, state: empty(), stats, lang: 'es', question: 'hola' });
assert.strictEqual(sh.me, null);
assert.strictEqual(sh.counters, null);
assert.deepStrictEqual(sh.missing, ['myCiv', 'oppCiv', 'map', 'age', 'elo']);
assert.ok(sh.builds.steps.every((b) => b.civs.includes('Any')), 'no civ → only generic step builds');
assert.ok(sh.builds.guides.every((g) => !g.civs.length || g.civs.includes('Any')), 'no civ → only civ-agnostic guides');
// unit stats straight from the data when the question asks for them
sh = sheet.buildSheet({ gd, strategy, catalog: cat, state: { ...empty(), myCiv: 'Franks', oppCiv: 'Mongols', age: 3 }, stats, lang: 'es', question: 'cuánta vida tiene el piquero' });
assert.strictEqual(sh.focus, 'units');
assert.strictEqual(sh.units.length, 1);
assert.deepStrictEqual([sh.units[0].name, sh.units[0].hp, sh.units[0].attack, sh.units[0].armor, sh.units[0].cost, sh.units[0].age], ['Piquero', 55, 4, '0/0', { Food: 35, Wood: 25 }, 3]);
assert.ok(/^\+25 vs Elephants/.test(sh.units[0].bonusDamage[0]) && /^\+22 vs Mounted/.test(sh.units[0].bonusDamage[1]), 'biggest bonus first: ' + sh.units[0].bonusDamage.join(', '));
assert.strictEqual(sh.units[0].mineCan, true);
assert.ok(sheet.sheetText(sh).includes('## Unidades') && /^Piquero: 55 HP/.test(sheet.sheetSpoken(sh)));
sh = sheet.buildSheet({ gd, strategy, catalog: cat, state: { ...empty(), myCiv: 'Franks', oppCiv: 'Mongols' }, stats, lang: 'en', question: 'what does the mangudai cost' });
assert.strictEqual(sh.units[0].mineCan, false, 'Franks cannot make Mangudai');
assert.strictEqual(sh.units[0].theirsCan, true);
// opponent's typical units when nothing else is known; counters need my civ
sh = sheet.buildSheet({ gd, strategy, catalog: cat, state: { ...empty(), oppCiv: 'Mongols', age: 3 }, stats, lang: 'es', question: 'contra mongoles?' });
assert.strictEqual(sh.counters.from, 'threats');
assert.ok(sh.counters.rows.length >= 2 && sh.counters.rows.every((r) => r.noCiv));
// closed map → fast castle builds; feudal openings sink once in Castle Age
sh = sheet.buildSheet({ gd, strategy, catalog: cat, state: { ...empty(), myCiv: 'Franks', map: 'Arena', age: 3 }, stats, lang: 'es' });
assert.ok(sh.builds.steps.some((b) => b.types.includes('Fast Castle') || b.types.includes('Boom')), JSON.stringify(sh.builds.steps.map((b) => b.title)));
assert.ok(!sh.builds.steps.some((b) => b.types.includes('Drush')));
// memes only on request
sh = sheet.buildSheet({ gd, strategy, catalog: cat, state: { ...empty(), myCiv: 'Franks', map: 'Arabia' }, stats, lang: 'es', question: 'dame un meme' });
assert.ok(sh.builds.steps.some((b) => b.tier === 'meme') || sh.builds.guides.some((g) => g.tier === 'meme'));
// every civ builds a sheet (no profile breaks the blocks)
for (const key of Object.keys(gd.civs)) {
  const s = sheet.buildSheet({ gd, strategy, catalog: cat, state: { ...empty(), myCiv: key, map: 'Arabia' }, stats, lang: 'es' });
  assert.ok(s.me && s.me.strength && s.me.openings.length >= 2, key);
  assert.ok(s.builds.steps.length >= 1, key + ' has build suggestions');
}

// --- screen reader: tolerant JSON parsing with sanity checks
let r = parseReading('Sure: {"hud": true, "food": "1,204", "wood": 310, "gold": 120, "stone": 200, "pop": "34 / 40", "idle": 2, "villagers": {"food": 12, "wood": 9, "gold": 4, "stone": null}, "age": "Feudal", "time": "12:30", "confidence": 0.9}');
assert.deepStrictEqual([r.hud, r.food, r.wood, r.pop, r.idle, r.villagers.wood, r.villagers.stone, r.age, r.time], [true, 1204, 310, '34/40', 2, 9, null, 2, '12:30']);
assert.deepStrictEqual(parseReading('{"hud": false}'), { hud: false });
assert.strictEqual(parseReading('no json here'), null);
assert.strictEqual(parseReading('{"hud": true, "food": null, "wood": null, "gold": null, "stone": null}').hud, false, 'no numbers at all is not a HUD');
assert.strictEqual(parseReading('{"hud": true, "food": 100, "confidence": 0.1}').hud, false, 'low confidence is dropped');
assert.strictEqual(parseReading('{"hud": true, "food": 100, "time": "12:75"}').time, null);
assert.deepStrictEqual(parseBox('{"found": true, "x": 0.01, "y": 0, "w": 0.55, "h": 0.04}'), { x: 0.01, y: 0, w: 0.55, h: 0.04 });
assert.strictEqual(parseBox('{"found": false}'), null);
assert.strictEqual(parseBox('{"found": true, "x": 0.1, "y": 0.1, "w": 0.01, "h": 0.5}'), null, 'a sliver is not the bar');
assert.ok(DEFAULT_REGION.w > 0.5 && DEFAULT_REGION.h < 0.1);

// --- settings: the new keys validate, bad values are dropped
assert.strictEqual(DEFAULTS.answerMode, 'ficha');
assert.strictEqual(DEFAULTS.screenRead, false);
let sp = sanitizePatch({ answerMode: 'libre', screenRead: true, screenReadInterval: 30, screenReadRegion: { x: 0, y: 0, w: 0.6, h: 0.05 } });
assert.deepStrictEqual(sp.rejected, []);
assert.strictEqual(sp.patch.answerMode, 'libre');
sp = sanitizePatch({ answerMode: 'chaos', screenReadInterval: 1, screenReadRegion: { x: 2, y: 0, w: 0.6, h: 0.05 } });
assert.deepStrictEqual(sp.rejected.sort(), ['answerMode', 'screenReadInterval', 'screenReadRegion']);
assert.strictEqual(sanitizePatch({ screenReadRegion: null }).patch.screenReadRegion, null);
console.log('sheet tests passed: 56 civs, parser, builds, screen reader parsing');
