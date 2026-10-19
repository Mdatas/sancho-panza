'use strict';
/**
 * Team counters for the 4v4 bar: for every enemy civ, its likely main units at the current age
 * (unique unit + the lines its style is known for) and the best answers MY civ has to each one,
 * from the same duel maths as find_counters. Deterministic, no AI call.
 */
const { counters } = require('./combat');

// Base unit of each line (English data names) by civ style tag in the strategy profiles.
const STYLE_LINES = {
  'caballería': ['Knight', 'Scout Cavalry'],
  'arqueros': ['Archer', 'Cavalry Archer'],
  'infantería': ['Militia', 'Spearman'],
  'infantería-asedio': ['Militia', 'Mangonel'],
  'asedio': ['Mangonel', 'Knight'],
  'mixta': ['Knight', 'Archer'],
  'agua': ['Archer', 'Knight'],
};
const DEFAULT_LINES = ['Knight', 'Archer'];
// units that win the duel maths but are not a field answer to an army (static siege, suicide units)
const NOT_AN_ANSWER = /Trebuchet|Petard|Demolition|Fire Ship|Flaming Camel|Missionary/i;

/** Best unit of `lineBaseName`'s line that `civ` can make at `age` (or null). */
function bestOfLine(gd, civKey, age, lineBaseName) {
  const base = gd.findUnit(lineBaseName); if (!base || !base.line) return null;
  const lineKey = base.line[0];
  const pool = gd.militaryUnitsFor(civKey, age).filter(u => u.line && u.line[0] === lineKey);
  if (!pool.length) return null;
  return pool.sort((a, b) => ((b.ageByCiv && b.ageByCiv[civKey]) || b.age || 0) - ((a.ageByCiv && a.ageByCiv[civKey]) || a.age || 0) || b.id - a.id)[0];
}

/** Castle unique unit (best version for the age), skipping scouts/regional units that are not the civ's signature. */
function uniqueUnit(gd, civ, age) {
  if (age < 3) return null;
  const avail = gd.militaryUnitsFor(civ.key, age);
  const names = (civ.uniqueUnits || []).filter(n => !/scout/i.test(n));
  const found = names.map(n => avail.find(u => u.name_en === n)).filter(Boolean);
  if (!found.length) return null;
  // prefer the first named unique unit (the castle one), elite version when available
  const firstLine = found[0].line ? found[0].line[0] : null;
  const same = found.filter(u => !firstLine || (u.line && u.line[0] === firstLine));
  return same.sort((a, b) => (b.age || 0) - (a.age || 0) || b.id - a.id)[0];
}

/** The 2-3 units an enemy civ most likely fields at this age. */
function threatsOf(gd, strategy, civKey, age) {
  const civ = gd.findCiv(civKey); if (!civ) return [];
  const prof = strategy && strategy.civ(civ.key);
  const style = prof && prof.meta && prof.meta.style;
  const out = []; const seen = new Set();
  const add = (u, unique = false) => { if (!u || seen.has(u.line ? u.line[0] : u.id)) return; seen.add(u.line ? u.line[0] : u.id); out.push({ u, unique }); };
  add(uniqueUnit(gd, civ, age), true);
  for (const line of (STYLE_LINES[style] || DEFAULT_LINES)) add(bestOfLine(gd, civ.key, age, line));
  if (out.length < 2) for (const line of DEFAULT_LINES) add(bestOfLine(gd, civ.key, age, line));
  return { style: style || '', units: out.slice(0, 3) };
}

/**
 * @returns {{ age, myCiv, rows: [{ civ, name_es, name_en, style, threats: [{ unit, unit_es, unique, answers: [{ unit, unit_es, score, note }] }] }] }}
 */
function teamCounters(gd, strategy, { myCiv, enemies = [], age = 0 } = {}) {
  const a = Math.min(4, Math.max(2, Number(age) || 3));
  const me = myCiv && gd.findCiv(myCiv);
  const rows = [];
  for (const key of enemies.filter(Boolean)) {
    const civ = gd.findCiv(key); if (!civ) continue;
    const t = threatsOf(gd, strategy, civ.key, a);
    const threats = t.units.map(({ u, unique }) => {
      let answers = [];
      if (me) {
        try {
          const r = counters(gd, u, me.key, a, { targetCiv: civ.key, limit: 6 });
          answers = r.candidates.filter(c => c.score >= 0.6 && !NOT_AN_ANSWER.test(c.unit) && !(c.mobility || []).some(m => /gets kited/.test(m))).slice(0, 2).map(c => ({ unit: c.unit, unit_es: c.unit_es || c.unit, score: c.score, note: (c.bonusVsTarget || [])[0] || (c.mobility || [])[0] || '' }));
        } catch { /* unknown unit/civ: leave empty */ }
      }
      return { unit: u.name_en, unit_es: u.name_es || u.name_en, unique, answers };
    });
    rows.push({ civ: civ.key, name_es: civ.name_es, name_en: civ.name_en, style: t.style, threats });
  }
  return { age: a, ageAssumed: !Number(age), myCiv: me ? me.key : '', rows };
}

/** Compact text version for the system prompt (team games). */
function teamCountersText(tc, nameOf = (k) => k) {
  if (!tc.rows.length) return '';
  return `TEAM COUNTERS (computed by the app from duel maths, age ${tc.age}${tc.ageAssumed ? ' assumed' : ''}; my civ ${tc.myCiv || 'unknown'}):\n` +
    tc.rows.map(r => `- ${nameOf(r.civ)}: ` + r.threats.map(t => `${t.unit}${t.unique ? ' (UU)' : ''} → ${t.answers.length ? t.answers.map(x => x.unit).join(' / ') : 'no efficient answer in my roster'}`).join('; ')).join('\n');
}

module.exports = { teamCounters, teamCountersText, threatsOf, STYLE_LINES };
