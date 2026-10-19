'use strict';
const path = require('path');
const assert = require('assert');
const { GameData } = require('../src/main/engine/gamedata');
const combat = require('../src/main/engine/combat');
const eco = require('../src/main/engine/eco');
const { civSummary, matchup } = require('../src/main/engine/civs');

const gd = new GameData(path.join(__dirname, '..', 'data', 'game')).load();
let pass = 0; const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, e.message); process.exitCode = 1; } };

t('56 civs loaded', () => assert.strictEqual(Object.keys(gd.civs).length, 56));
t('knight basics', () => { const k = gd.findUnit('knight'); assert.strictEqual(k.name_en, 'Knight'); assert.strictEqual(k.hp, 100); assert.strictEqual(k.age, 3); assert.strictEqual(k.buildingName, 'Stable'); });
t('spanish names + aliases', () => {
  assert.strictEqual(gd.findUnit('caballeros').name_en, 'Knight');
  assert.strictEqual(gd.findUnit('piqueros').name_en, 'Pikeman');
  assert.strictEqual(gd.findUnit('xbows').name_en, 'Crossbowman');
  assert.strictEqual(gd.findUnit('mangudai').name_en, 'Mangudai');
  assert.strictEqual(gd.findUnit('arqueros a caballo').name_en, 'Cavalry Archer');
  assert.ok(gd.findUnit('knight').name_es);
});
t('knight line', () => assert.deepStrictEqual(gd.findUnit('knight').line.map(id => gd.units[id].name_en), ['Knight', 'Cavalier', 'Paladin']));
t('availability: Franks no Arbalester, have Paladin', () => {
  const arb = gd.findUnit('Arbalester'), pal = gd.findUnit('Paladin');
  assert.ok(!arb.civs.has('Franks')); assert.ok(pal.civs.has('Franks')); assert.ok(!pal.civs.has('Britons'));
});
t('civ lookup es/en', () => { assert.strictEqual(gd.findCiv('francos').key, 'Franks'); assert.strictEqual(gd.findCiv('Mongols').key, 'Mongols'); assert.strictEqual(gd.findCiv('bizantinos').key, 'Byzantines'); });
t('franks bonuses parsed', () => { const f = gd.civs.Franks; assert.ok(f.bonuses.length >= 3); assert.ok(f.uniqueUnits.includes('Throwing Axeman')); assert.ok(f.teamBonus.length > 5); });

// damage rules
t('knight vs pikeman: 10-0=10 ; pike vs knight: 4-2 + 22 = 24', () => {
  const k = gd.findUnit('knight'), p = gd.findUnit('pikeman');
  assert.strictEqual(combat.hit(gd, k, p).damage, 10);
  assert.strictEqual(combat.hit(gd, p, k).damage, 24);
});
t('long swordsman vs cataphract: no negative bonus (clamp)', () => {
  const ls = gd.findUnit('Long Swordsman'), c = gd.findUnit('Cataphract');
  assert.strictEqual(combat.hit(gd, ls, c).damage, 9 - 2); // 9 attack, 2 melee armor
});
t('pikeman vs cataphract: bonus reduced by cavalry armour 12', () => {
  const p = gd.findUnit('pikeman'), c = gd.findUnit('Cataphract');
  assert.strictEqual(combat.hit(gd, p, c).damage, (4 - 2) + (22 - 12));
});
t('hand cannoneer vs condottiero: +10 infantry cancelled by -10', () => {
  const hc = gd.findUnit('Hand Cannoneer'), co = gd.findUnit('Condottiero');
  assert.strictEqual(combat.hit(gd, hc, co).damage, 17);
});
t('knight vs battering ram: negative armour adds damage', () => {
  const k = gd.findUnit('knight'), r = gd.findUnit('Battering Ram');
  assert.ok(combat.hit(gd, k, r).damage >= 13);
});
t('duel + upgrades', () => {
  const d = combat.duel(gd, gd.findUnit('knight'), gd.findUnit('pikeman'), { civA: 'Persians', civB: 'Byzantines', tierA: 2, tierB: 2 });
  assert.ok(d.A.applied.includes('Bloodlines')); assert.ok(d.A.hp === 120); assert.ok(d.B.applied.includes('Iron Casting'));
  assert.strictEqual(d.winner, 'A');            // a single upgraded knight beats a single pikeman...
  assert.ok(d.costEfficiency < 1);               // ...but the pikeman is far more cost-effective
  const f = combat.duel(gd, gd.findUnit('knight'), gd.findUnit('pikeman'), { civA: 'Franks', tierA: 1 });
  assert.ok(!f.A.applied.includes('Bloodlines')); // Franks have no Bloodlines in the tech tree
});
t('counters to mangudai for Franks in castle age', () => {
  const r = combat.counters(gd, gd.findUnit('mangudai'), 'Franks', 3, { targetCiv: 'Mongols' });
  assert.ok(r.candidates.length >= 5);
  const names = r.candidates.map(c => c.unit);
  assert.ok(names.includes('Skirmisher') || names.includes('Elite Skirmisher') || names.includes('Knight'), names.join(','));
});
t('eco: knights from 3 stables', () => {
  const r = eco.villagersForQueue([{ unit: gd.findUnit('knight'), buildings: 3 }], { farm: 1, gold: 1 });
  assert.ok(r.villagersByResource.Food.villagers > 10 && r.villagersByResource.Gold.villagers > 5);
});
t('civ summary + matchup', () => {
  const s = civSummary(gd, gd.civs.Franks); assert.ok(s.missingKeyUnits.includes('Arbalester')); assert.ok(s.missingKeyTechs.includes('Bracer'));
  const m = matchup(gd, gd.civs.Franks, gd.civs.Mongols); assert.ok(m.imperialOptions.length > 5);
});
console.log(`engine tests passed: ${pass}`);
