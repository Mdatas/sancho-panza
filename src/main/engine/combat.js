'use strict';
/**
 * Combat engine — per-hit damage, duel simulation and counter ranking, driven by the
 * attack/armour class tables in data.json.
 *
 * Damage rule (Genie engine, as documented on the AoE2 wiki "Armor class" article):
 *   for every attack class the attacker has that the defender also has as an armour class:
 *     term = attack - armour, floored at 0 when the attack value is >= 0
 *     (negative attack values — e.g. Hand Cannoneer -10 vs Condottiero — are allowed to subtract)
 *   damage = max(1, sum of terms)
 * Base melee is class 4, base pierce is class 3.
 */

// Blacksmith lines by English tech name (resolved to ids at runtime via GameData.findTech)
const BLACKSMITH = {
  meleeAttack: ['Forging', 'Iron Casting', 'Blast Furnace'],                 // +1 +1 +1 (cumulative 1/2/3)
  infantryArmor: ['Scale Mail Armor', 'Chain Mail Armor', 'Plate Mail Armor'], // +1/+1, +1/+1, +1/+2
  cavalryArmor: ['Scale Barding Armor', 'Chain Barding Armor', 'Plate Barding Armor'],
  archerAttack: ['Fletching', 'Bodkin Arrow', 'Bracer'],                     // +1 attack & +1 range each
  archerArmor: ['Padded Archer Armor', 'Leather Archer Armor', 'Ring Archer Armor'],
};
const ARMOR_STEPS = [[1, 1], [1, 1], [1, 2]]; // [melee, pierce] per tier

function hasClass(list, cls) { return list.some(a => a.cls === cls); }

function categoryOf(u) {
  const arm = u.armours;
  if (hasClass(arm, 20)) return 'siege';
  if (hasClass(arm, 25)) return 'monk';
  if (hasClass(arm, 28)) return 'cavalry archer';
  if (hasClass(arm, 23)) return 'gunpowder';
  if (hasClass(arm, 15)) return 'archer';
  if (hasClass(arm, 5)) return 'elephant';
  if (hasClass(arm, 30)) return 'camel';
  if (hasClass(arm, 8)) return 'cavalry';
  if (hasClass(arm, 29)) return 'shock infantry';
  if (hasClass(arm, 1)) return 'infantry';
  if (hasClass(arm, 16) || hasClass(arm, 34)) return 'ship';
  if (hasClass(arm, 11) || hasClass(arm, 21)) return 'building';
  return 'other';
}

/**
 * Apply blacksmith upgrades for a tier (0-3) the civ actually has, plus Bloodlines for mounted units.
 * Returns a shallow-copied unit with modified attacks/armours/hp and a list of applied tech names.
 */
function applyUpgrades(gd, u, civ, tier) {
  const out = { ...u, attacks: u.attacks.map(a => ({ ...a })), armours: u.armours.map(a => ({ ...a })), applied: [] };
  if (!tier || tier <= 0) return out;
  const cat = categoryOf(u);
  const civHas = (name) => { const t = gd.findTech(name); return !!(t && (!civ || t.civs.has(civ.key))); };
  const bump = (list, cls, n) => { const e = list.find(a => a.cls === cls); if (e) e.amount += n; };

  const melee = u.range === 0;
  if (cat === 'siege' || cat === 'monk' || cat === 'ship' || cat === 'building') return out;

  // attack
  if (melee && ['infantry', 'shock infantry', 'cavalry', 'camel', 'elephant'].includes(cat)) {
    for (let i = 0; i < tier; i++) if (civHas(BLACKSMITH.meleeAttack[i])) { bump(out.attacks, 4, 1); out.applied.push(BLACKSMITH.meleeAttack[i]); }
  } else if (!melee && ['archer', 'cavalry archer', 'elephant'].includes(cat)) {
    for (let i = 0; i < tier; i++) if (civHas(BLACKSMITH.archerAttack[i])) { bump(out.attacks, 3, 1); out.range += 1; out.applied.push(BLACKSMITH.archerAttack[i]); }
  }
  // armour
  let armorLine = null;
  if (['infantry', 'shock infantry'].includes(cat)) armorLine = BLACKSMITH.infantryArmor;
  else if (['cavalry', 'camel', 'elephant'].includes(cat) && melee) armorLine = BLACKSMITH.cavalryArmor;
  else if (['archer', 'cavalry archer', 'gunpowder'].includes(cat) || (cat === 'elephant' && !melee)) armorLine = BLACKSMITH.archerArmor;
  if (armorLine) {
    for (let i = 0; i < tier; i++) if (civHas(armorLine[i])) {
      bump(out.armours, 4, ARMOR_STEPS[i][0]); bump(out.armours, 3, ARMOR_STEPS[i][1]); out.applied.push(armorLine[i]);
    }
  }
  // Bloodlines (+20 HP mounted, from Feudal)
  if (['cavalry', 'camel', 'elephant', 'cavalry archer'].includes(cat) && civHas('Bloodlines')) { out.hp += 20; out.applied.push('Bloodlines'); }
  return out;
}

/** Damage per hit from att to def. Returns {damage, terms:[{cls, name, attack, armour, term}]} */
function hit(gd, att, def) {
  const terms = [];
  let sum = 0;
  for (const a of att.attacks) {
    const d = def.armours.find(x => x.cls === a.cls);
    if (!d) continue;
    let term = a.amount - d.amount;
    if (a.amount >= 0 && term < 0) term = 0;
    if (term !== 0 || a.cls === 3 || a.cls === 4) terms.push({ cls: a.cls, name: gd.className(a.cls), attack: a.amount, armour: d.amount, term });
    sum += term;
  }
  return { damage: Math.max(1, sum), terms };
}

function totalCost(cost) { return (cost.Food || 0) + (cost.Wood || 0) + (cost.Gold || 0) + (cost.Stone || 0); }

/**
 * Simulate a 1v1 stand-and-fight duel (no micro, no range kiting, no hills).
 * opts: { civA, civB, tierA, tierB } tiers 0-3 blacksmith level.
 */
function duel(gd, A, B, opts = {}) {
  const civA = opts.civA ? gd.findCiv(opts.civA) : null;
  const civB = opts.civB ? gd.findCiv(opts.civB) : null;
  const a = applyUpgrades(gd, A, civA, opts.tierA || 0);
  const b = applyUpgrades(gd, B, civB, opts.tierB || 0);
  const ab = hit(gd, a, b), ba = hit(gd, b, a);
  const htkAB = Math.ceil(b.hp / ab.damage), htkBA = Math.ceil(a.hp / ba.damage);
  const reloadA = a.reload || 2, reloadB = b.reload || 2;
  // time to kill: first hit lands after the attack delay, then one hit per reload
  const ttkAB = +Math.max(0.5, (htkAB - 1) * reloadA + (a.attackDelay || 0.5)).toFixed(1); // time for A to kill B
  const ttkBA = +Math.max(0.5, (htkBA - 1) * reloadB + (b.attackDelay || 0.5)).toFixed(1);
  const costA = totalCost(a.cost), costB = totalCost(b.cost);
  const winner = ttkAB < ttkBA ? 'A' : (ttkBA < ttkAB ? 'B' : 'tie');
  // value ratio: how many of B one A "is worth" in a straight fight, scaled by cost
  const fightRatio = Math.min(20, Math.max(0.05, ttkBA / Math.max(0.5, ttkAB)));
  const costRatio = costB / Math.max(1, costA);
  return {
    A: { id: a.id, name: a.name_en, hp: a.hp, applied: a.applied, cost: a.cost, costTotal: costA, dmgPerHit: ab.damage, hitsToKill: htkAB, timeToKill: ttkAB, dps: +(ab.damage / reloadA).toFixed(2), terms: ab.terms, range: a.range, speed: a.speed },
    B: { id: b.id, name: b.name_en, hp: b.hp, applied: b.applied, cost: b.cost, costTotal: costB, dmgPerHit: ba.damage, hitsToKill: htkBA, timeToKill: ttkBA, dps: +(ba.damage / reloadB).toFixed(2), terms: ba.terms, range: b.range, speed: b.speed },
    winner,
    fightRatio: +fightRatio.toFixed(2),        // >1 means A wins the 1v1 (time-to-kill ratio)
    costEfficiency: +(fightRatio * costRatio).toFixed(2), // >1 means A is cost-effective vs B
    notes: duelNotes(a, b),
  };
}

function duelNotes(a, b) {
  const notes = [];
  const ca = categoryOf(a), cb = categoryOf(b);
  if (a.range > 0 && b.range === 0) notes.push(`${a.name_en} is ranged vs melee: gets free shots while ${b.name_en} closes in${a.speed >= b.speed ? ' and can kite' : ''}.`);
  if (b.range > 0 && a.range === 0) notes.push(`${b.name_en} is ranged vs melee: gets free shots while ${a.name_en} closes in${b.speed >= a.speed ? ' and can kite' : ''}.`);
  if (ca === 'siege' || cb === 'siege') notes.push('Siege: splash/projectile behaviour not modelled; mangonel-line damage depends on clumping and ballistics.');
  if (ca === 'monk' || cb === 'monk') notes.push('Monks convert instead of fighting; the duel maths does not apply.');
  notes.push('Stand-and-fight maths only (no micro, hills, numbers or civ bonuses beyond blacksmith/Bloodlines).');
  return notes;
}

/**
 * Rank the units `civKey` can make (<= age) against a target unit.
 * targetOpts: { civ, tier }  myOpts: { tier }
 */
function counters(gd, target, civKey, age = 4, { targetCiv = null, targetTier = 0, myTier = 0, limit = 8 } = {}) {
  const civ = gd.findCiv(civKey);
  if (!civ) throw new Error('unknown civ ' + civKey);
  const cands = gd.militaryUnitsFor(civ.key, age);
  // only the best unit of each line available at this age
  const bestOfLine = new Map();
  for (const u of cands) {
    const key = u.line[0];
    const cur = bestOfLine.get(key);
    if (!cur || (u.age || 0) > (cur.age || 0) || (u.age === cur.age && u.id > cur.id)) bestOfLine.set(key, u);
  }
  const results = [];
  for (const u of bestOfLine.values()) {
    const d = duel(gd, u, target, { civA: civ.key, civB: targetCiv, tierA: myTier, tierB: targetTier });
    const cat = categoryOf(u);
    let score = d.costEfficiency;
    const flags = [];
    // mobility realism: ranged vs melee gets free shots / kiting; melee chasing a faster ranged unit gets kited
    if (u.range > 0 && target.range === 0) { if (u.speed >= target.speed) { score *= 1.3; flags.push('can kite'); } else { score *= 1.05; flags.push('free shots while they close'); } }
    if (u.range === 0 && target.range > 0) {
      if (target.speed >= u.speed + 0.2) { score *= 0.3; flags.push('gets kited: cannot catch it in the open'); }
      else if (target.speed > u.speed) { score *= 0.75; flags.push('slightly slower: catches it only with numbers/terrain'); }
      else { score *= 0.95; flags.push('can catch it'); }
    }
    if (cat === 'siege') { score *= 0.9; flags.push('siege: needs protection'); }
    const bonus = d.A.terms.filter(t => t.cls !== 3 && t.cls !== 4 && t.term > 0).map(t => `+${t.term} vs ${t.name}`);
    results.push({ unit: u.name_en, unit_es: u.name_es, id: u.id, age: gd.ageName(u.age), category: cat, cost: u.cost, costTotal: d.A.costTotal,
      dmgToTarget: d.A.dmgPerHit, dmgTaken: d.B.dmgPerHit, hitsToKill: d.A.hitsToKill, hitsToDie: d.B.hitsToKill,
      fightRatio: d.fightRatio, costEfficiency: d.costEfficiency, score: +score.toFixed(2), bonusVsTarget: bonus, mobility: flags, applied: d.A.applied });
  }
  results.sort((x, y) => y.score - x.score);
  return { target: target.name_en, targetHp: target.hp, civ: civ.key, age: gd.ageName(age), candidates: results.slice(0, limit), consideredCount: results.length,
    method: 'Stand-and-fight duel maths from data.json attack/armour classes; score = cost-adjusted time-to-kill ratio with a kiting bump for ranged vs melee. Use as a shortlist, not gospel.' };
}

module.exports = { hit, duel, counters, applyUpgrades, categoryOf, totalCost };
