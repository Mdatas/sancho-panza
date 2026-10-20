'use strict';
/**
 * Economy maths: gather rates, villager allocation to sustain a production queue, resource splits.
 * Gather rates are effective rates per villager per minute (field measurements, as used in the
 * "Guía del Age" by Alexander the Conqueror and the aoe2 community). They are approximations:
 * walking distance, bumping and drop-off placement change real numbers by 5-15%.
 * RATES_REVIEWED: the patch these figures were last checked against; the eco_plan tool reports it so the coach can say so.
 */
const RATES_REVIEWED = '185872';

const RATES = {
  // resource -> [base, +tech1, +tech2, +tech3] in units/min per villager
  wood: { label: 'Wood (lumberjack)', tiers: ['base', 'Double-Bit Axe', 'Bow Saw', 'Two-Man Saw'], rate: [23.4, 28.08, 33.7, 37.07] },
  farm: { label: 'Food (farm)', tiers: ['base', 'Wheelbarrow', 'Hand Cart'], rate: [20.42, 22.73, 24.0] },
  gold: { label: 'Gold (mining)', tiers: ['base', 'Gold Mining', 'Gold Shaft Mining'], rate: [22.8, 26.22, 30.15] },
  stone: { label: 'Stone (mining)', tiers: ['base', 'Stone Mining', 'Stone Shaft Mining'], rate: [21.6, 24.84, 28.57] },
  hunt: { label: 'Food (hunting boar/deer)', tiers: ['base'], rate: [24.6] },
  sheep: { label: 'Food (sheep/herdables)', tiers: ['base'], rate: [19.8] },
  berries: { label: 'Food (berries)', tiers: ['base'], rate: [18.6] },
  shore_fish: { label: 'Food (villager shore fishing)', tiers: ['base'], rate: [25.8] },
  fishing_ship: { label: 'Food (fishing ship, deep fish)', tiers: ['base'], rate: [29.4] },
};

const FARM_FOOD = { base: 175, 'Horse Collar': 250, 'Heavy Plow': 375, 'Crop Rotation': 550 };

function rate(resource, tier = 0) {
  const r = RATES[resource];
  if (!r) throw new Error('unknown resource ' + resource);
  const i = Math.max(0, Math.min(tier, r.rate.length - 1));
  return { perMin: r.rate[i], perSec: +(r.rate[i] / 60).toFixed(3), tier: r.tiers[i], label: r.label };
}

/**
 * How many villagers per resource are needed to continuously produce `units` (array of {unit, buildings})
 * where unit is a GameData unit record and buildings the number of production buildings working non-stop.
 * tiers: { wood, farm, gold, stone } upgrade tiers (0..3)
 */
function villagersForQueue(items, tiers = {}) {
  const need = { Food: 0, Wood: 0, Gold: 0, Stone: 0 };
  const lines = [];
  for (const { unit, buildings } of items) {
    const perMin = (60 / unit.trainTime) * (buildings || 1);
    const l = { unit: unit.name_en, buildings: buildings || 1, unitsPerMin: +perMin.toFixed(2), perMinCost: {} };
    for (const [res, amt] of Object.entries(unit.cost)) {
      const r = amt * perMin;
      need[res] = (need[res] || 0) + r;
      l.perMinCost[res] = +r.toFixed(1);
    }
    lines.push(l);
  }
  const vills = {
    Food: need.Food / rate('farm', tiers.farm || 0).perMin,
    Wood: need.Wood / rate('wood', tiers.wood || 0).perMin,
    Gold: need.Gold / rate('gold', tiers.gold || 0).perMin,
    Stone: need.Stone / rate('stone', tiers.stone || 0).perMin,
  };
  const out = {};
  for (const k of Object.keys(vills)) if (need[k] > 0) out[k] = { perMinNeeded: +need[k].toFixed(1), villagers: Math.ceil(vills[k]) };
  const total = Object.values(out).reduce((s, v) => s + v.villagers, 0);
  return {
    items: lines,
    villagersByResource: out,
    totalVillagers: total,
    assumptions: `Farms at ${rate('farm', tiers.farm || 0).perMin}/min (${rate('farm', tiers.farm || 0).tier}), wood ${rate('wood', tiers.wood || 0).perMin}/min, gold ${rate('gold', tiers.gold || 0).perMin}/min, stone ${rate('stone', tiers.stone || 0).perMin}/min; buildings never idle.`,
  };
}

/** Resource split (%) implied by a unit composition, e.g. {Knight: 2, Pikeman: 1} meaning 2 knights per pike. */
function resourceSplit(items) {
  const tot = { Food: 0, Wood: 0, Gold: 0, Stone: 0 };
  for (const { unit, weight } of items) for (const [res, amt] of Object.entries(unit.cost)) tot[res] += amt * (weight || 1);
  const sum = Object.values(tot).reduce((a, b) => a + b, 0) || 1;
  const pct = {};
  for (const k of Object.keys(tot)) if (tot[k] > 0) pct[k] = Math.round((100 * tot[k]) / sum);
  return pct;
}

module.exports = { RATES, FARM_FOOD, RATES_REVIEWED, rate, villagersForQueue, resourceSplit };
