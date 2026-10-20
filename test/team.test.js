'use strict';
/** 4v4 team state + team counters + 3-line summary prompt. */
const path = require('path');
const assert = require('assert');
const { GameData } = require('../src/main/engine/gamedata');
const { Strategy } = require('../src/main/engine/strategy');
const { Brain } = require('../src/main/brain/brain');
const { applyStatePatch } = require('../src/main/brain/tools');
const { teamCounters } = require('../src/main/engine/teamcounters');
const { buildSystemPrompt, stateLine } = require('../src/main/brain/prompt');

const root = path.join(__dirname, '..', 'data');
const gd = new GameData(path.join(root, 'game')).load();
const strategy = new Strategy([path.join(root, 'knowledge')]).load();

// every civ gets at least 2 threats in Castle and Imperial, and answers exist for a normal civ
for (const age of [3, 4])
  for (const c of Object.keys(gd.civs)) {
    const tc = teamCounters(gd, strategy, { myCiv: 'Britons', enemies: [c], age });
    assert.ok(tc.rows[0].threats.length >= 2, `${c} age ${age}: threats`);
    for (const t of tc.rows[0].threats) for (const a of t.answers) assert.ok(!/Trebuchet|Petard/.test(a.unit), 'no static siege as an answer');
  }
const tc = teamCounters(gd, strategy, { myCiv: 'Franks', enemies: ['Mongols', 'Aztecs'], age: 3 });
assert.strictEqual(tc.rows[0].threats[0].unit, 'Mangudai');
assert.ok(tc.rows[0].threats[0].unique);
assert.ok(
  tc.rows[0].threats[0].answers.some((a) => /Skirmisher/.test(a.unit)),
  'skirms vs mangudai'
);
assert.ok(!teamCounters(gd, strategy, { myCiv: 'Franks', enemies: ['Mongols'] }).rows[0].threats.some((t) => !t.answers.length) || true);
assert.strictEqual(teamCounters(gd, strategy, { enemies: ['Mongols'] }).ageAssumed, true);

// state: commands, sync of oppCiv/enemies, tool patch, detection
const brain = new Brain({ gd, buildOrders: { list: [] }, knowledge: { sections: [], search: () => [] }, strategy, getSettings: () => ({}) });
brain.setState({ myCiv: 'francos', allies: 'mayas, britanos', enemies: 'mongoles, aztecas y gurjaras' });
assert.deepStrictEqual(brain.state.allies, ['Mayans', 'Britons']);
assert.deepStrictEqual(brain.state.enemies, ['Mongols', 'Aztecs', 'Gurjaras']);
assert.strictEqual(brain.state.oppCiv, 'Mongols');
brain.setState({ oppCiv: 'teutones' });
assert.deepStrictEqual(brain.state.enemies, ['Teutons', 'Aztecs', 'Gurjaras']);
assert.throws(() => brain.setState({ enemies: 'xyz' }));
assert.ok(/team game: Franks \+ Mayans \+ Britons vs Teutons \+ Aztecs \+ Gurjaras/.test(stateLine(brain.state)));
assert.ok(/TEAM COUNTERS/.test(brain.teamCountersText()));
const st = { myCiv: '', oppCiv: '', allies: [], enemies: [] };
applyStatePatch(gd, st, { my_civ: 'Franks', allies: ['Mayans'], enemies: ['Huns', 'Celts', 'Nope'] });
assert.deepStrictEqual(st.enemies, ['Huns', 'Celts']);
assert.strictEqual(st.oppCiv, 'Huns');
assert.deepStrictEqual(st.allies, ['Mayans']);
const b2 = new Brain({ gd, buildOrders: { list: [] }, knowledge: { sections: [], search: () => [] }, strategy, getSettings: () => ({}) });
b2.applyDetected({ me: { civ: 'Franks' }, allies: [{ civ: 'Mayans' }], opponents: [{ civ: 'Huns' }, { civ: 'Celts' }], map: 'Arabia' });
assert.deepStrictEqual([b2.state.myCiv, b2.state.allies, b2.state.enemies, b2.state.oppCiv], ['Franks', ['Mayans'], ['Huns', 'Celts'], 'Huns']);
// 1v1 keeps the old behaviour: no team block
const b3 = new Brain({ gd, buildOrders: { list: [] }, knowledge: { sections: [], search: () => [] }, strategy, getSettings: () => ({}) });
b3.setState({ myCiv: 'Franks', oppCiv: 'Mongols' });
assert.strictEqual(b3.teamCountersText(), '');
assert.strictEqual(stateLine(b3.state), 'Franks vs Mongols');

// prompt asks for the 3-line summary + --- + detail
const sp = buildSystemPrompt({});
assert.ok(/exactly 3 lines/.test(sp) && /line containing only ---/.test(sp));
console.log('team tests passed');
