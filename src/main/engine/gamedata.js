'use strict';
/**
 * GameData — loads the SiegeEngineers aoe2techtree dataset (data.json + per-civ trees + locale strings)
 * and builds the indexes the coach engine needs: units, techs, buildings, civs, names (en/es),
 * ages, upgrade lines and per-civ availability.
 *
 * Source of truth: https://github.com/SiegeEngineers/aoe2techtree (community-maintained, updated per patch).
 */
const fs = require('fs');
const path = require('path');

// Attack/armour class names, copied from aoe2techtree js/techtree.js (HTML abbreviations stripped).
const CLASS_NAMES = {
  0: 'Wonders',
  1: 'Infantry',
  2: 'Heavy Warships',
  3: 'Base Pierce',
  4: 'Base Melee',
  5: 'Elephants',
  8: 'Mounted Units (except Camels)',
  11: 'All Buildings',
  13: 'Stone Defense & Harbors (except Castles/Kreposts)',
  14: 'Predator Animals',
  15: 'All Archers',
  16: 'Ships',
  17: 'High Pierce Armor Siege Units',
  18: 'Trees',
  19: 'Unique Units',
  20: 'Siege Units',
  21: 'Standard Buildings',
  22: 'Walls & Gates',
  23: 'Gunpowder Units',
  24: 'Aggressive Huntable Animals',
  25: 'Monastery Units',
  26: 'Castles & Kreposts',
  27: 'Spearmen',
  28: 'Mounted Archers',
  29: 'Shock Infantry',
  30: 'Camels',
  31: 'Unblockable Melee',
  32: 'Condottieri',
  34: 'Fishing Ships',
  35: 'Mamelukes',
  36: 'Heroes & Kings',
  37: 'Heavy Siege',
  38: 'Skirmishers',
  39: 'Cavalry Resistance',
  40: 'Houses',
  41: 'Fire Ships',
  60: 'Long-Range Warships',
};

const AGE_NAMES = { 1: 'Dark Age', 2: 'Feudal Age', 3: 'Castle Age', 4: 'Imperial Age' };
const AGE_NAMES_ES = { 1: 'Alta Edad Media', 2: 'Edad Feudal', 3: 'Edad de los Castillos', 4: 'Edad Imperial' };

// Land military production buildings (by English name in the tree files).
const MILITARY_BUILDINGS = new Set(['Barracks', 'Archery Range', 'Stable', 'Siege Workshop', 'Castle', 'Krepost', 'Donjon']);
// Units that are military but useless as "counters" in a duel sim.
const NON_DUEL_UNITS = new Set([
  'Trebuchet',
  'Petard',
  'Flaming Camel',
  'Siege Tower',
  'Battering Ram',
  'Capped Ram',
  'Siege Ram',
  'Armored Elephant',
  'Siege Elephant',
  'Trade Cart',
  'Trade Cog',
  'Villager',
  'Monk',
  'Missionary',
  'Warrior Priest',
]);

function stripTags(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class GameData {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.loaded = false;
  }

  /** Load from disk. dataDir must contain data.json, strings_en.json, strings_es.json, trees/*.json */
  load() {
    const read = (f) => JSON.parse(fs.readFileSync(path.join(this.dataDir, f), 'utf8'));
    const raw = read('data.json');
    const strEn = read('strings_en.json');
    const strEs = (() => {
      try {
        return read('strings_es.json');
      } catch {
        return {};
      }
    })();
    const treesDir = path.join(this.dataDir, 'trees');
    const treeFiles = fs.existsSync(treesDir) ? fs.readdirSync(treesDir).filter((f) => f.endsWith('.json')) : [];

    this.raw = raw;
    this.strEn = strEn;
    this.strEs = strEs;
    this.sourceCommit = (() => {
      try {
        return fs.readFileSync(path.join(this.dataDir, 'SOURCE_COMMIT.txt'), 'utf8').trim();
      } catch {
        return 'unknown';
      }
    })();

    const units = {}; // id -> unit record
    const techs = {}; // id -> tech record
    const buildings = {}; // id -> building record
    const civs = {}; // name -> civ record

    // --- civs from data.json ---
    for (const [civName, c] of Object.entries(raw.civs)) {
      const helpEn = stripTags(strEn[String(c.help_string_id)] || '');
      const helpEs = stripTags(strEs[String(c.help_string_id)] || '');
      civs[civName] = {
        key: civName,
        name_en: strEn[String(c.name_string_id)] || civName,
        name_es: strEs[String(c.name_string_id)] || civName,
        internal: c.internal_name,
        help_en: helpEn,
        help_es: helpEs,
        ...parseCivHelp(helpEn),
        unitIds: new Set(c.Unit || []),
        techIds: new Set(c.Tech || []),
        buildingIds: new Set(c.Building || []),
        uniqueUnits: [], // filled from trees
        uniqueTechs: [], // filled from trees
        regionalUnits: [],
        missing: { units: [], techs: [] }, // filled from trees (NotAvailable)
      };
    }

    // --- units / techs / buildings base stats from data.json ---
    for (const [id, u] of Object.entries(raw.data.Unit)) {
      units[id] = {
        id: Number(id),
        internal: u.internal_name,
        name_en: null,
        name_es: null,
        age: null,
        building: null,
        buildingName: null,
        prev: null,
        next: [],
        type: null,
        civs: new Set(),
        civStatus: {},
        hp: u.HP,
        attack: u.Attack,
        meleeArmor: u.MeleeArmor,
        pierceArmor: u.PierceArmor,
        range: u.Range,
        minRange: u.MinRange,
        speed: u.Speed,
        reload: u.ReloadTime,
        attackDelay: u.AttackDelaySeconds,
        frameDelay: u.FrameDelay,
        accuracy: u.AccuracyPercent,
        los: u.LineOfSight,
        trainTime: u.TrainTime,
        cost: u.Cost || {},
        attacks: (u.Attacks || []).map((a) => ({ cls: a.Class, amount: a.Amount })),
        armours: (u.Armours || []).map((a) => ({ cls: a.Class, amount: a.Amount })),
        garrison: u.GarrisonCapacity,
        charge: u.MaxCharge ? { max: u.MaxCharge, rate: u.RechargeRate, type: u.ChargeType } : null,
      };
    }
    for (const [id, t] of Object.entries(raw.data.Tech)) {
      techs[id] = {
        id: Number(id),
        internal: t.internal_name,
        name_en: null,
        name_es: null,
        age: null,
        building: null,
        buildingName: null,
        cost: t.Cost || {},
        researchTime: t.ResearchTime,
        repeatable: !!t.Repeatable,
        type: null,
        civs: new Set(),
        civStatus: {},
      };
    }
    for (const [id, b] of Object.entries(raw.data.Building)) {
      buildings[id] = {
        id: Number(id),
        internal: b.internal_name,
        name_en: null,
        name_es: null,
        age: null,
        hp: b.HP,
        meleeArmor: b.MeleeArmor,
        pierceArmor: b.PierceArmor,
        attack: b.Attack,
        range: b.Range,
        los: b.LineOfSight,
        garrison: b.GarrisonCapacity,
        cost: b.Cost || {},
        buildTime: b.TrainTime,
        attacks: (b.Attacks || []).map((a) => ({ cls: a.Class, amount: a.Amount })),
        armours: (b.Armours || []).map((a) => ({ cls: a.Class, amount: a.Amount })),
        civs: new Set(),
      };
    }
    // unit upgrade techs (e.g. Crossbowman upgrade cost) keyed by target unit id
    this.unitUpgrades = raw.data.unit_upgrades || {};

    // --- per-civ trees: names, ages, buildings, lines, availability, unique/regional ---
    for (const f of treeFiles) {
      const civKey = f.replace('.json', '');
      const tree = read(path.join('trees', f));
      const civ = Object.values(civs).find((c) => c.internal.toUpperCase() === civKey.toUpperCase() || c.key.toUpperCase() === civKey.toUpperCase());
      if (!civ) continue;
      const bName = {};
      for (const b of tree.buildings || []) {
        bName[b.building_id] = b.name;
        const rec = buildings[b.building_id];
        if (rec) {
          rec.name_en = rec.name_en || b.name;
          rec.name_es = rec.name_es || strEs[String(b.name_string_id)] || null;
          rec.age = rec.age || b.age_id;
          if (b.node_status !== 'NotAvailable') rec.civs.add(civ.key);
        }
      }
      for (const n of tree.units_techs || []) {
        const available = n.node_status !== 'NotAvailable';
        if (n.use_type === 'Unit') {
          const rec = units[n.node_id];
          if (!rec) continue;
          rec.name_en = rec.name_en || n.name;
          rec.name_es = rec.name_es || strEs[String(n.name_string_id)] || null;
          (rec._ageVotes = rec._ageVotes || {})[n.age_id] = (rec._ageVotes[n.age_id] || 0) + 1;
          (rec.ageByCiv = rec.ageByCiv || {})[civ.key] = n.age_id;
          rec.building = rec.building || n.building_id;
          rec.buildingName = rec.buildingName || bName[n.building_id] || null;
          if (n.link_id && n.link_node_type !== 'BuildingTech' && n.link_node_type !== 'BuildingNonTech') rec.prev = rec.prev || n.link_id;
          rec.type = rec.type || n.node_type || 'Unit';
          rec.civStatus[civ.key] = n.node_status;
          if (available) rec.civs.add(civ.key);
          else civ.missing.units.push(n.name);
          if (n.node_type === 'UniqueUnit') civ.uniqueUnits.push(n.name);
          if (n.node_type === 'RegionalUnit' && available) civ.regionalUnits.push(n.name);
        } else {
          const rec = techs[n.node_id];
          if (!rec) continue;
          rec.name_en = rec.name_en || n.name;
          rec.name_es = rec.name_es || strEs[String(n.name_string_id)] || null;
          (rec._ageVotes = rec._ageVotes || {})[n.age_id] = (rec._ageVotes[n.age_id] || 0) + 1;
          (rec.ageByCiv = rec.ageByCiv || {})[civ.key] = n.age_id;
          rec.building = rec.building || n.building_id;
          rec.buildingName = rec.buildingName || bName[n.building_id] || null;
          rec.type = rec.type || n.node_type || 'Research';
          rec.civStatus[civ.key] = n.node_status;
          if (available) rec.civs.add(civ.key);
          else civ.missing.techs.push(n.name);
          if (n.node_type === 'UniqueTech') civ.uniqueTechs.push(n.name);
        }
      }
      civ.uniqueUnits = [...new Set(civ.uniqueUnits)];
      civ.uniqueTechs = [...new Set(civ.uniqueTechs)];
      civ.regionalUnits = [...new Set(civ.regionalUnits)];
      civ.missing.units = [...new Set(civ.missing.units)];
      civ.missing.techs = [...new Set(civ.missing.techs)];
    }

    // age = most common age across civ trees (civ bonuses like Armenians' early infantry upgrades are kept in ageByCiv)
    const modeAge = (rec) => {
      if (!rec._ageVotes) return;
      let best = null,
        n = -1;
      for (const [a, c] of Object.entries(rec._ageVotes))
        if (c > n) {
          n = c;
          best = Number(a);
        }
      rec.age = best;
      delete rec._ageVotes;
    };
    for (const u of Object.values(units)) modeAge(u);
    for (const t of Object.values(techs)) modeAge(t);
    // next links + lines
    for (const u of Object.values(units)) if (u.prev && units[u.prev]) units[u.prev].next.push(u.id);
    for (const u of Object.values(units)) u.line = this._lineOf(units, u);

    // tech name index
    this.techByName = {};
    for (const t of Object.values(techs)) if (t.name_en) this.techByName[normalize(t.name_en)] = t;

    this.units = units;
    this.techs = techs;
    this.buildings = buildings;
    this.civs = civs;
    const cleanName = (s) =>
      typeof s === 'string'
        ? s
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        : s;
    for (const group of [this.civs, this.units, this.techs, this.buildings])
      for (const r of Object.values(group || {})) {
        if (r) {
          r.name_en = cleanName(r.name_en);
          r.name_es = cleanName(r.name_es);
        }
      }
    this._buildNameIndex();
    this.loaded = true;
    return this;
  }

  _lineOf(units, u) {
    let first = u;
    const seen = new Set();
    while (first.prev && units[first.prev] && !seen.has(first.prev)) {
      seen.add(first.prev);
      first = units[first.prev];
    }
    const line = [first.id];
    let cur = first;
    while (cur.next && cur.next.length) {
      // follow the main line (first child that is a UnitUpgrade/ UniqueUnit elite)
      const nxt = cur.next.map((id) => units[id]).find((x) => x && x.type !== 'Unit') || units[cur.next[0]];
      if (!nxt || line.includes(nxt.id)) break;
      line.push(nxt.id);
      cur = nxt;
    }
    return line;
  }

  _buildNameIndex() {
    const idx = new Map(); // normalized name -> [unit ids]
    const add = (k, id) => {
      if (!k) return;
      const n = normalize(k);
      if (!n) return;
      if (!idx.has(n)) idx.set(n, []);
      if (!idx.get(n).includes(id)) idx.get(n).push(id);
    };
    for (const u of Object.values(this.units)) {
      if (!u.name_en) continue; // not in any tree (heroes, scenario units)
      add(u.name_en, u.id);
      add(u.name_es, u.id);
      // singular/plural helpers
      add(u.name_en + 's', u.id);
      add(u.name_en.replace(/man$/, 'men'), u.id);
      if (u.name_es) {
        add(u.name_es + 's', u.id);
        add(u.name_es + 'es', u.id);
      }
    }
    for (const [alias, target] of Object.entries(UNIT_ALIASES)) {
      const t = [...(idx.get(normalize(target)) || [])];
      if (t.length) add(alias, t[0]);
    }
    this.nameIndex = idx;
  }

  /** Find a unit by (fuzzy) name in English or Spanish. Returns the unit record or null. */
  findUnit(query, { civ = null, age = null } = {}) {
    if (query == null) return null;
    if (typeof query === 'number' || /^\d+$/.test(String(query))) return this.units[String(query)] || null;
    const q = normalize(query);
    if (!q) return null;
    let ids = this.nameIndex.get(q);
    if (!ids) {
      // try trimming plural 's' / 'es' and 'elite' prefix handling
      const variants = [q.replace(/s$/, ''), q.replace(/es$/, ''), q.replace(/^elite /, ''), q.replace(/^de elite /, ''), q.replace(/ de elite$/, '')];
      for (const v of variants) {
        if (this.nameIndex.has(v)) {
          ids = this.nameIndex.get(v);
          break;
        }
      }
    }
    if (!ids) {
      // substring / token match, prefer shortest name containing all tokens
      const toks = q.split(' ');
      const cands = [];
      for (const [name, list] of this.nameIndex) {
        if (toks.every((t) => name.includes(t))) cands.push({ name, list });
      }
      cands.sort((a, b) => a.name.length - b.name.length);
      if (cands.length) ids = cands[0].list;
    }
    if (!ids || !ids.length) return null;
    let recs = ids.map((id) => this.units[id]).filter(Boolean);
    if (civ && this.civs[civ]) {
      const avail = recs.filter((u) => u.civs.has(civ));
      if (avail.length) recs = avail;
    }
    if (age) {
      const byAge = recs.filter((u) => u.age <= age);
      if (byAge.length) recs = byAge;
    }
    // prefer the base (non-upgrade) unit when ambiguous
    recs.sort((a, b) => (a.age || 9) - (b.age || 9));
    return recs[0];
  }

  findCiv(query) {
    if (!query) return null;
    const q = normalize(query);
    for (const c of Object.values(this.civs)) {
      if (normalize(c.key) === q || normalize(c.name_en) === q || normalize(c.name_es) === q) return c;
    }
    const alias = CIV_ALIASES[q];
    if (alias) return this.civs[alias] || null;
    // a prefix only counts when it is unambiguous: "ma" could be Magyars, Malay, Malians, Mayans... → null, never a silent guess
    if (q.length >= 3) {
      const hits = Object.values(this.civs).filter(
        (c) => normalize(c.key).startsWith(q) || normalize(c.name_es).startsWith(q) || normalize(c.name_en).startsWith(q)
      );
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        const exact = hits.find((c) => [c.key, c.name_es, c.name_en].some((n) => normalize(n) === q));
        if (exact) return exact;
        return null;
      }
    }
    // "franksxyz" / a civ name with a suffix glued on ("Mongolsss"): accept when the whole key is a prefix of the query
    const glued = Object.values(this.civs).filter((c) => q.length >= 5 && q.startsWith(normalize(c.key)));
    return glued.length === 1 ? glued[0] : null;
  }

  findTech(query) {
    const q = normalize(query);
    if (this.techByName[q]) return this.techByName[q];
    for (const t of Object.values(this.techs)) if (t.name_es && normalize(t.name_es) === q) return t;
    for (const [k, t] of Object.entries(this.techByName)) if (k.includes(q)) return t;
    return null;
  }

  className(cls) {
    return CLASS_NAMES[cls] || 'class ' + cls;
  }
  ageName(age, lang = 'en') {
    return (lang === 'es' ? AGE_NAMES_ES : AGE_NAMES)[age] || '?';
  }

  /** All units a civ can train from land military buildings up to a given age (duel-capable only). */
  militaryUnitsFor(civKey, maxAge = 4) {
    const out = [];
    for (const u of Object.values(this.units)) {
      if (!u.name_en || !u.civs.has(civKey)) continue;
      if (!MILITARY_BUILDINGS.has(u.buildingName)) continue;
      if (NON_DUEL_UNITS.has(u.name_en)) continue;
      const ageForCiv = (u.ageByCiv && u.ageByCiv[civKey]) || u.age || 9;
      if (ageForCiv > maxAge) continue;
      if (!u.attack || u.attack <= 0) continue;
      out.push(u);
    }
    return out;
  }

  /** Human-readable summary of a unit (base stats). */
  describeUnit(u, lang = 'en') {
    const nm = lang === 'es' && u.name_es ? `${u.name_es} (${u.name_en})` : u.name_en;
    const bon = u.attacks
      .filter((a) => a.amount !== 0 && a.cls !== 3 && a.cls !== 4)
      .map((a) => `${a.amount > 0 ? '+' : ''}${a.amount} vs ${this.className(a.cls)}`);
    const arm = u.armours
      .filter((a) => a.cls !== 3 && a.cls !== 4 && a.amount !== 0)
      .map((a) => `${a.amount > 0 ? '+' : ''}${a.amount} vs ${this.className(a.cls)}`);
    const classes = u.armours.filter((a) => a.cls !== 3 && a.cls !== 4 && a.cls !== 31).map((a) => this.className(a.cls));
    return {
      id: u.id,
      name: nm,
      name_en: u.name_en,
      name_es: u.name_es,
      age: this.ageName(u.age, lang),
      ageNum: u.age,
      building: u.buildingName,
      line: u.line.map((id) => this.units[id]?.name_en).filter(Boolean),
      cost: u.cost,
      trainTime: u.trainTime,
      hp: u.hp,
      attack: u.attack,
      attackType: u.range > 0 ? 'pierce (ranged)' : 'melee',
      armor: `${u.meleeArmor}/${u.pierceArmor}`,
      range: u.range,
      minRange: u.minRange,
      speed: u.speed,
      reload: u.reload,
      accuracy: u.accuracy,
      los: u.los,
      armorClasses: classes,
      bonusDamage: bon,
      bonusArmor: arm,
      civs: [...u.civs].sort(),
    };
  }
}

/** Parse the civ help text (English) into bonuses / unique unit / unique techs / team bonus. */
function parseCivHelp(txt) {
  const lines = txt
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const out = { trait: lines[0] || '', bonuses: [], uniqueUnitText: [], uniqueTechText: [], teamBonus: '' };
  let section = 'bonuses';
  for (const l of lines.slice(1)) {
    if (/^unique unit/i.test(l)) {
      section = 'uu';
      continue;
    }
    if (/^unique tech/i.test(l)) {
      section = 'ut';
      continue;
    }
    if (/^team bonus/i.test(l)) {
      section = 'team';
      continue;
    }
    const clean = l.replace(/^•\s*/, '');
    if (section === 'bonuses') out.bonuses.push(clean);
    else if (section === 'uu') out.uniqueUnitText.push(clean);
    else if (section === 'ut') out.uniqueTechText.push(clean);
    else out.teamBonus = (out.teamBonus ? out.teamBonus + ' ' : '') + clean;
  }
  return out;
}

// Community slang / Spanish shortcuts → canonical English unit names.
const UNIT_ALIASES = {
  // English slang
  xbow: 'Crossbowman',
  xbows: 'Crossbowman',
  crossbow: 'Crossbowman',
  crossbows: 'Crossbowman',
  arb: 'Arbalester',
  arbs: 'Arbalester',
  arbalest: 'Arbalester',
  scout: 'Scout Cavalry',
  scouts: 'Scout Cavalry',
  lc: 'Light Cavalry',
  'light cav': 'Light Cavalry',
  hussars: 'Hussar',
  knights: 'Knight',
  kts: 'Knight',
  cavs: 'Cavalier',
  pally: 'Paladin',
  pallies: 'Paladin',
  paladins: 'Paladin',
  pike: 'Pikeman',
  pikes: 'Pikeman',
  spear: 'Spearman',
  spears: 'Spearman',
  halb: 'Halberdier',
  halbs: 'Halberdier',
  skirm: 'Skirmisher',
  skirms: 'Skirmisher',
  eskirm: 'Elite Skirmisher',
  eskirms: 'Elite Skirmisher',
  'elite skirms': 'Elite Skirmisher',
  ca: 'Cavalry Archer',
  'cav archer': 'Cavalry Archer',
  'cav archers': 'Cavalry Archer',
  hca: 'Heavy Cavalry Archer',
  maa: 'Man-at-Arms',
  'm@a': 'Man-at-Arms',
  'men at arms': 'Man-at-Arms',
  militia: 'Militia',
  longsword: 'Long Swordsman',
  longswords: 'Long Swordsman',
  ls: 'Long Swordsman',
  '2hs': 'Two-Handed Swordsman',
  ths: 'Two-Handed Swordsman',
  champ: 'Champion',
  champs: 'Champion',
  mango: 'Mangonel',
  mangos: 'Mangonel',
  onagers: 'Onager',
  so: 'Siege Onager',
  sos: 'Siege Onager',
  scorp: 'Scorpion',
  scorps: 'Scorpion',
  bbc: 'Bombard Cannon',
  bbcs: 'Bombard Cannon',
  hc: 'Hand Cannoneer',
  hcs: 'Hand Cannoneer',
  'hand cannons': 'Hand Cannoneer',
  'hand cannon': 'Hand Cannoneer',
  camel: 'Camel Rider',
  camels: 'Camel Rider',
  'heavy camel': 'Heavy Camel Rider',
  'heavy camels': 'Heavy Camel Rider',
  'imp camel': 'Imperial Camel Rider',
  eagle: 'Eagle Warrior',
  eagles: 'Eagle Warrior',
  'eagle scout': 'Eagle Scout',
  'elite eagles': 'Elite Eagle Warrior',
  'ele archer': 'Elephant Archer',
  'ele archers': 'Elephant Archer',
  'battle ele': 'Battle Elephant',
  'battle eles': 'Battle Elephant',
  'steppe lancer': 'Steppe Lancer',
  lancers: 'Steppe Lancer',
  monks: 'Monk',
  treb: 'Trebuchet (Packed)',
  trebs: 'Trebuchet (Packed)',
  trebuchet: 'Trebuchet (Packed)',
  trebuchets: 'Trebuchet (Packed)',
  ram: 'Battering Ram',
  rams: 'Battering Ram',
  vill: 'Villager',
  vills: 'Villager',
  villagers: 'Villager',
  tk: 'Teutonic Knight',
  tks: 'Teutonic Knight',
  conq: 'Conquistador',
  conqs: 'Conquistador',
  jans: 'Janissary',
  janis: 'Janissary',
  cata: 'Cataphract',
  catas: 'Cataphract',
  wb: 'Woad Raider',
  ta: 'Throwing Axeman',
  tas: 'Throwing Axeman',
  mangudais: 'Mangudai',
  longbows: 'Longbowman',
  longbow: 'Longbowman',
  plumes: 'Plumed Archer',
  'plumed archers': 'Plumed Archer',
  'war wagons': 'War Wagon',
  ww: 'War Wagon',
  huskarls: 'Huskarl',
  husk: 'Huskarl',
  husks: 'Huskarl',
  genitours: 'Genitour',
  kipchaks: 'Kipchak',
  cks: 'Chu Ko Nu',
  ckn: 'Chu Ko Nu',
  chukonu: 'Chu Ko Nu',
  'organ gun': 'Organ Gun',
  organs: 'Organ Gun',
  obuch: 'Obuch',
  serjeant: 'Serjeant',
  serjeants: 'Serjeant',
  coustillier: 'Coustillier',
  leitis: 'Leitis',
  boyars: 'Boyar',
  kamayuks: 'Kamayuk',
  slingers: 'Slinger',
  ghulams: 'Ghulam',
  ratha: 'Ratha',
  urumi: 'Urumi Swordsman',
  chakram: 'Chakram Thrower',
  shrivamsha: 'Shrivamsha Rider',
  monaspa: 'Monaspa',
  'composite bowman': 'Composite Bowman',
  legionary: 'Legionary',
  centurion: 'Centurion',
  // Spanish slang / common names
  caballero: 'Knight',
  caballeros: 'Knight',
  paladin: 'Paladin',
  paladines: 'Paladin',
  piquero: 'Pikeman',
  piqueros: 'Pikeman',
  lancero: 'Spearman',
  lanceros: 'Spearman',
  alabardero: 'Halberdier',
  alabarderos: 'Halberdier',
  arquero: 'Archer',
  arqueros: 'Archer',
  ballestero: 'Crossbowman',
  ballesteros: 'Crossbowman',
  arbalestero: 'Arbalester',
  arbalesteros: 'Arbalester',
  guerrillero: 'Skirmisher',
  guerrilleros: 'Skirmisher',
  hostigador: 'Skirmisher',
  hostigadores: 'Skirmisher',
  escaramuzador: 'Skirmisher',
  escaramuzadores: 'Skirmisher',
  explorador: 'Scout Cavalry',
  exploradores: 'Scout Cavalry',
  'caballeria ligera': 'Light Cavalry',
  husar: 'Hussar',
  husares: 'Hussar',
  'arquero a caballo': 'Cavalry Archer',
  'arqueros a caballo': 'Cavalry Archer',
  'arqueros montados': 'Cavalry Archer',
  milicia: 'Militia',
  milicias: 'Militia',
  'hombre de armas': 'Man-at-Arms',
  'hombres de armas': 'Man-at-Arms',
  'espada larga': 'Long Swordsman',
  'espadas largas': 'Long Swordsman',
  mandoble: 'Two-Handed Swordsman',
  mandobles: 'Two-Handed Swordsman',
  campeon: 'Champion',
  campeones: 'Champion',
  mangonel: 'Mangonel',
  mangoneles: 'Mangonel',
  onagro: 'Onager',
  onagros: 'Onager',
  'onagro de asedio': 'Siege Onager',
  escorpion: 'Scorpion',
  escorpiones: 'Scorpion',
  bombarda: 'Bombard Cannon',
  bombardas: 'Bombard Cannon',
  'canon de bombardeo': 'Bombard Cannon',
  cañonero: 'Hand Cannoneer',
  canonero: 'Hand Cannoneer',
  canoneros: 'Hand Cannoneer',
  cañoneros: 'Hand Cannoneer',
  arcabucero: 'Hand Cannoneer',
  arcabuceros: 'Hand Cannoneer',
  camello: 'Camel Rider',
  camellos: 'Camel Rider',
  'camello pesado': 'Heavy Camel Rider',
  'camellos pesados': 'Heavy Camel Rider',
  aguila: 'Eagle Warrior',
  aguilas: 'Eagle Warrior',
  'guerrero aguila': 'Eagle Warrior',
  'guerreros aguila': 'Eagle Warrior',
  'elefante de batalla': 'Battle Elephant',
  elefantes: 'Battle Elephant',
  monje: 'Monk',
  monjes: 'Monk',
  ariete: 'Battering Ram',
  arietes: 'Battering Ram',
  trabuquete: 'Trebuchet (Packed)',
  trabuquetes: 'Trebuchet (Packed)',
  fundibulo: 'Trebuchet (Packed)',
  fundibulos: 'Trebuchet (Packed)',
  aldeano: 'Villager',
  aldeanos: 'Villager',
  'caballero teutonico': 'Teutonic Knight',
  'caballeros teutonicos': 'Teutonic Knight',
  conquistador: 'Conquistador',
  conquistadores: 'Conquistador',
  jenizaro: 'Janissary',
  jenizaros: 'Janissary',
  catafracto: 'Cataphract',
  catafractos: 'Cataphract',
  'lanzador de hachas': 'Throwing Axeman',
  'arquero de tiro largo': 'Longbowman',
  'arqueros de tiro largo': 'Longbowman',
  'lancero de la estepa': 'Steppe Lancer',
  'lanceros de la estepa': 'Steppe Lancer',
  'carro de guerra': 'War Wagon',
  'carros de guerra': 'War Wagon',
  'guardia varega': 'Varangian Guard',
  'guardias varegas': 'Varangian Guard',
  'lancero de fuego': 'Fire Lancer',
  'lanceros de fuego': 'Fire Lancer',
};

const CIV_ALIASES = {
  francos: 'Franks',
  britanos: 'Britons',
  bizantinos: 'Byzantines',
  chinos: 'Chinese',
  celtas: 'Celts',
  godos: 'Goths',
  japoneses: 'Japanese',
  mongoles: 'Mongols',
  persas: 'Persians',
  sarracenos: 'Saracens',
  teutones: 'Teutons',
  turcos: 'Turks',
  vikingos: 'Vikings',
  aztecas: 'Aztecs',
  mayas: 'Mayans',
  hunos: 'Huns',
  coreanos: 'Koreans',
  espanoles: 'Spanish',
  italianos: 'Italians',
  incas: 'Incas',
  indios: 'Hindustanis',
  indostanies: 'Hindustanis',
  magiares: 'Magyars',
  eslavos: 'Slavs',
  portugueses: 'Portuguese',
  etiopes: 'Ethiopians',
  malienses: 'Malians',
  bereberes: 'Berbers',
  jemeres: 'Khmer',
  malayos: 'Malay',
  birmanos: 'Burmese',
  vietnamitas: 'Vietnamese',
  bulgaros: 'Bulgarians',
  cumanos: 'Cumans',
  lituanos: 'Lithuanians',
  tartaros: 'Tatars',
  borgonones: 'Burgundians',
  sicilianos: 'Sicilians',
  polacos: 'Poles',
  bohemios: 'Bohemians',
  bengalies: 'Bengalis',
  dravidas: 'Dravidians',
  guyaras: 'Gurjaras',
  gurjaras: 'Gurjaras',
  romanos: 'Romans',
  armenios: 'Armenians',
  georgianos: 'Georgians',
  daneses: 'Danes',
  sajones: 'Saxons',
  varegos: 'Varangians',
  mapuches: 'Mapuche',
  muiscas: 'Muisca',
  tupies: 'Tupi',
  tupis: 'Tupi',
  yurchen: 'Jurchens',
  yurchenes: 'Jurchens',
  kitan: 'Khitans',
  kitanes: 'Khitans',
};

module.exports = { GameData, CLASS_NAMES, AGE_NAMES, normalize, MILITARY_BUILDINGS };
