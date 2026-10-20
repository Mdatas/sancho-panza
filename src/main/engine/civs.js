'use strict';
/** Civ summaries and matchups built from data.json help texts + tech-tree availability. */

const KEY_UNITS = [
  'Paladin',
  'Cavalier',
  'Hussar',
  'Halberdier',
  'Pikeman',
  'Champion',
  'Two-Handed Swordsman',
  'Arbalester',
  'Crossbowman',
  'Elite Skirmisher',
  'Heavy Cavalry Archer',
  'Cavalry Archer',
  'Hand Cannoneer',
  'Heavy Camel Rider',
  'Camel Rider',
  'Siege Onager',
  'Onager',
  'Siege Ram',
  'Capped Ram',
  'Heavy Scorpion',
  'Bombard Cannon',
  'Elite Eagle Warrior',
  'Elite Battle Elephant',
  'Elite Steppe Lancer',
  'Monk',
  'Trebuchet (Packed)',
];
const KEY_TECHS = [
  'Bloodlines',
  'Husbandry',
  'Thumb Ring',
  'Bracer',
  'Blast Furnace',
  'Plate Barding Armor',
  'Plate Mail Armor',
  'Ring Archer Armor',
  'Parthian Tactics',
  'Squires',
  'Arson',
  'Supplies',
  'Siege Engineers',
  'Chemistry',
  'Redemption',
  'Atonement',
  'Block Printing',
  'Heresy',
  'Faith',
  'Crop Rotation',
  'Two-Man Saw',
  'Gold Shaft Mining',
  'Stone Shaft Mining',
  'Guilds',
  'Treadmill Crane',
  'Architecture',
  'Masonry',
  'Hoardings',
  'Keep',
  'Bombard Tower',
  'Heated Shot',
  'Murder Holes',
];

function civSummary(gd, civ, lang = 'en') {
  const unitName = (n) => {
    const u = gd.findUnit(n);
    return u && lang === 'es' && u.name_es ? `${n} (${u.name_es})` : n;
  };
  const hasUnit = (n) => {
    const u = Object.values(gd.units).find((x) => x.name_en === n);
    return u ? u.civs.has(civ.key) : null;
  };
  const hasTech = (n) => {
    const t = gd.findTech(n);
    return t ? t.civs.has(civ.key) : null;
  };
  const missingUnits = KEY_UNITS.filter((n) => hasUnit(n) === false);
  const missingTechs = KEY_TECHS.filter((n) => hasTech(n) === false);
  return {
    civ: civ.key,
    name: lang === 'es' ? civ.name_es : civ.name_en,
    trait: civ.trait,
    bonuses: civ.bonuses,
    uniqueUnits: civ.uniqueUnits,
    uniqueUnitText: civ.uniqueUnitText,
    uniqueTechs: civ.uniqueTechs,
    uniqueTechText: civ.uniqueTechText,
    teamBonus: civ.teamBonus,
    regionalUnits: civ.regionalUnits,
    missingKeyUnits: missingUnits.map(unitName),
    missingKeyTechs: missingTechs,
    fullBlacksmith: {
      meleeAttack: hasTech('Blast Furnace'),
      infantryArmor: hasTech('Plate Mail Armor'),
      cavalryArmor: hasTech('Plate Barding Armor'),
      archerAttack: hasTech('Bracer'),
      archerArmor: hasTech('Ring Archer Armor'),
    },
    help_es: lang === 'es' ? civ.help_es : undefined,
  };
}

function matchup(gd, a, b, lang = 'en') {
  const A = civSummary(gd, a, lang),
    B = civSummary(gd, b, lang);
  const lineCheck = (names) =>
    names.map((n) => {
      const u = Object.values(gd.units).find((x) => x.name_en === n);
      return { unit: n, [a.key]: u ? u.civs.has(a.key) : null, [b.key]: u ? u.civs.has(b.key) : null };
    });
  return {
    me: A,
    opponent: B,
    imperialOptions: lineCheck([
      'Paladin',
      'Hussar',
      'Halberdier',
      'Champion',
      'Arbalester',
      'Elite Skirmisher',
      'Heavy Cavalry Archer',
      'Hand Cannoneer',
      'Heavy Camel Rider',
      'Siege Onager',
      'Siege Ram',
      'Bombard Cannon',
    ]),
    note: 'Use the bonuses, unique units and missing lines to pick a composition the opponent cannot answer efficiently; combine with find_counters for the specific units they are making.',
  };
}

module.exports = { civSummary, matchup, KEY_UNITS, KEY_TECHS };
