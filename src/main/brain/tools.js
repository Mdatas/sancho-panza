'use strict';
/**
 * Tool definitions exposed to the LLM + dispatcher that runs them against the engine.
 * Schemas are provider-neutral (JSON schema); providers.js adapts them to Anthropic / OpenAI shapes.
 */
const combat = require('../engine/combat');
const eco = require('../engine/eco');
const { civSummary, matchup } = require('../engine/civs');
const fs = require('fs');
const path = require('path');

const AGE_NAMES_SHORT = { 1: 'Dark Age', 2: 'Feudal Age', 3: 'Castle Age', 4: 'Imperial Age' };

const TOOLS = [
  {
    name: 'update_match_state',
    description:
      'Register or correct match facts (my civ, their civ, my age, map, armies, eco, constraints). The app already extracts them from each message; call this when the player corrects something or you learn a fact the state is missing. Only send fields that change; omitted fields keep their value.',
    input_schema: {
      type: 'object',
      properties: {
        my_civ: { type: 'string', description: 'Player civ, English name (Franks, Mongols...)' },
        opp_civ: { type: 'string', description: 'Opponent civ, English name' },
        allies: { type: 'array', items: { type: 'string' }, description: "Team games: my teammates' civs (not me), English names, max 3" },
        enemies: { type: 'array', items: { type: 'string' }, description: 'Team games: ALL opponent civs, English names, max 4 (opp_civ = the first)' },
        age: { type: 'integer', minimum: 1, maximum: 4, description: 'Player age: 1 Dark, 2 Feudal, 3 Castle, 4 Imperial' },
        opp_age: { type: 'integer', minimum: 1, maximum: 4, description: 'Opponent age if known' },
        map: { type: 'string' },
        elo: { type: 'string' },
        my_army: { type: 'string', description: 'What the player has/makes, e.g. "8 archers, 2 ranges"' },
        their_army: { type: 'string', description: 'What the opponent has/makes, e.g. "6 knights, mangonel coming"' },
        my_eco: { type: 'string', description: 'Villager count/distribution, TCs, upgrades if stated' },
        key_facts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Every constraint or detail in THIS message that must shape the answer, in the player\'s words (e.g. "no gold left", "walled", "he has 2 castles", "I don\'t want to switch comp")',
        },
        question_type: { type: 'string', enum: ['counter', 'eco', 'build_order', 'civ', 'timing', 'general'] },
        clear: { type: 'boolean', description: 'true when the player says a new game started: resets armies/eco/facts (keeps nothing)' },
      },
    },
  },
  {
    name: 'lookup_unit',
    description:
      'Get current-patch stats for a unit: HP, attack, armor, bonus damage, range, speed, cost, train time, age, building, upgrade line and which civs can train it. Accepts English or Spanish names and community slang (xbow, halbs, piqueros, caballeros...).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unit name, e.g. "Knight", "ballesteros", "eskirm"' },
        civ: { type: 'string', description: 'Optional civ to resolve ambiguous names / availability' },
      },
      required: ['name'],
    },
  },
  {
    name: 'compare_units',
    description:
      'Simulate a 1v1 stand-and-fight duel between two units: damage per hit (with the class-bonus breakdown), hits/time to kill both ways, cost efficiency. Optionally apply blacksmith upgrade tiers (0=none,1=Feudal,2=Castle,3=Imperial) that each civ actually has.',
    input_schema: {
      type: 'object',
      properties: {
        unit_a: { type: 'string' },
        unit_b: { type: 'string' },
        civ_a: { type: 'string', description: 'Civ of unit A (for upgrade availability)' },
        civ_b: { type: 'string' },
        upgrades_a: { type: 'integer', minimum: 0, maximum: 3 },
        upgrades_b: { type: 'integer', minimum: 0, maximum: 3 },
      },
      required: ['unit_a', 'unit_b'],
    },
  },
  {
    name: 'find_counters',
    description:
      'Rank the units MY civ can train (up to a given age) against a target enemy unit, using real attack/armor-class maths plus mobility (kiting) heuristics. Returns a shortlist with damage dealt/taken, bonus damage and cost efficiency. Always call this before recommending a counter.',
    input_schema: {
      type: 'object',
      properties: {
        target_unit: { type: 'string', description: 'Enemy unit to counter' },
        my_civ: { type: 'string' },
        age: { type: 'integer', minimum: 1, maximum: 4, description: 'My current age: 1 Dark, 2 Feudal, 3 Castle, 4 Imperial' },
        target_civ: { type: 'string', description: 'Enemy civ (for their upgrades)' },
        my_upgrades: { type: 'integer', minimum: 0, maximum: 3, description: 'Blacksmith tier I have (default = age-1)' },
        target_upgrades: { type: 'integer', minimum: 0, maximum: 3, description: 'Blacksmith tier they have (default = age-1)' },
      },
      required: ['target_unit', 'my_civ', 'age'],
    },
  },
  {
    name: 'civ_info',
    description: 'Civ bonuses, unique unit/techs, team bonus, regional units, and the key units/techs this civ is MISSING (e.g. no Bracer, no Paladin).',
    input_schema: { type: 'object', properties: { civ: { type: 'string' } }, required: ['civ'] },
  },
  {
    name: 'civ_matchup',
    description: 'Side-by-side comparison of my civ vs the opponent civ: bonuses, unique units, missing lines and which Imperial options each has.',
    input_schema: { type: 'object', properties: { my_civ: { type: 'string' }, opponent_civ: { type: 'string' } }, required: ['my_civ', 'opponent_civ'] },
  },
  {
    name: 'list_civ_units',
    description: 'List the military units a civ can train up to a given age (what my/their options actually are).',
    input_schema: { type: 'object', properties: { civ: { type: 'string' }, age: { type: 'integer', minimum: 1, maximum: 4 } }, required: ['civ', 'age'] },
  },
  {
    name: 'eco_plan',
    description:
      'Economy maths: villagers per resource needed to continuously produce a unit mix from N buildings, resource split, and gather rates. Use for "what eco do I need for X" and transition questions.',
    input_schema: {
      type: 'object',
      properties: {
        units: {
          type: 'array',
          items: { type: 'object', properties: { unit: { type: 'string' }, buildings: { type: 'integer', minimum: 1 } }, required: ['unit'] },
          description: 'Units and how many production buildings each',
        },
        upgrades: {
          type: 'object',
          properties: { farm: { type: 'integer' }, wood: { type: 'integer' }, gold: { type: 'integer' }, stone: { type: 'integer' } },
          description: 'Eco upgrade tiers: farm 0-2 (none/Wheelbarrow/Hand Cart), wood 0-3, gold 0-2, stone 0-2',
        },
      },
      required: ['units'],
    },
  },
  {
    name: 'list_build_orders',
    description: 'Search the stored build orders (bundled + user imports) by civ and keywords (scouts, archers, fast castle, drush, maa, boom...).',
    input_schema: { type: 'object', properties: { civ: { type: 'string' }, query: { type: 'string' } } },
  },
  {
    name: 'get_build_order',
    description: 'Get the full step list of a build order by id or exact name.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'civ_strategy',
    description:
      'Full strategy profile of a civ (Spanish): identity, strength by age, what each bonus implies, unique unit/techs, what it lacks, standard openings per map type, Castle/Imperial plans, compositions, how to play AGAINST it, common mistakes, maps. The profiles of my civ and the opponent are already in the system prompt; call this for a third civ or for the full text.',
    input_schema: { type: 'object', properties: { civ: { type: 'string' } }, required: ['civ'] },
  },
  {
    name: 'map_info',
    description:
      'Strategy profile of a ranked map (Spanish): geography, starting resources, walling, what wins, standard openings, strong/weak civs, timings, mistakes. The current map profile is already in the system prompt; call this for another map.',
    input_schema: { type: 'object', properties: { map: { type: 'string' } }, required: ['map'] },
  },
  {
    name: 'list_maps',
    description: 'List the maps that have a profile.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'benchmarks',
    description:
      'Graded timing benchmarks (A+ pro … E slow) for standard builds: Feudal/Castle click times and first-army milestones for scouts, archers, men-at-arms→archers, drush→archers, drush→fast castle, fast castle→boom, fast castle→knights. Use for "am I slow / what time should I hit Feudal" questions; say the grade the player is at. Not ELO-specific.',
    input_schema: {
      type: 'object',
      properties: { build: { type: 'string', description: 'Build keywords, e.g. "scouts", "archers", "fast castle knights"; empty = all' } },
    },
  },
  {
    name: 'search_notes',
    description:
      'Search the strategy notes (unit roles and counters, openings, timings/benchmarks, eco ratios, map notes, transitions). Use for the "why/when" of a decision; numbers always come from the other tools. The notes are written in Spanish with English unit/civ names: query with 3-6 keywords mixing Spanish terms and English game names (e.g. "defensa trush torres arqueros", "boom Arena Byzantines", "counter Mangudai Castle Age"), not full sentences.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

/** Merge an update_match_state-shaped patch into the state. Returns { reminders, unknown }. */
function applyStatePatch(gd, state, input) {
  if (input.clear) {
    for (const k of ['age', 'oppAge', 'myArmy', 'theirArmy', 'myEco', 'keyFacts', 'notes'])
      state[k] = Array.isArray(state[k]) ? [] : k === 'age' || k === 'oppAge' ? 0 : '';
  }
  const civ = (x) => {
    if (!x) return null;
    const c = gd.findCiv(x);
    return c ? c.key : null;
  };
  const unknown = [];
  if (input.my_civ) {
    const c = civ(input.my_civ);
    if (c) state.myCiv = c;
    else unknown.push(input.my_civ);
  }
  if (input.opp_civ) {
    const c = civ(input.opp_civ);
    if (c) {
      state.oppCiv = c;
      if (!Array.isArray(input.enemies)) {
        const e = [...(state.enemies || [])];
        e[0] = c;
        state.enemies = e.filter(Boolean);
      }
    } else unknown.push(input.opp_civ);
  }
  for (const [k, max] of [
    ['allies', 3],
    ['enemies', 4],
  ]) {
    if (!Array.isArray(input[k]) || !input[k].length) continue;
    const keys = [];
    for (const x of input[k]) {
      const c = civ(x);
      if (c) keys.push(c);
      else unknown.push(x);
    }
    if (keys.length) {
      state[k] = keys.slice(0, max);
      if (k === 'enemies') state.oppCiv = state[k][0];
    }
  }
  if (input.age) state.age = Number(input.age) || state.age;
  if (input.opp_age) state.oppAge = Number(input.opp_age) || state.oppAge;
  for (const [k, v] of [
    ['map', input.map],
    ['elo', input.elo],
    ['myArmy', input.my_army],
    ['theirArmy', input.their_army],
    ['myEco', input.my_eco],
  ])
    if (v) state[k] = String(v);
  if (Array.isArray(input.key_facts)) state.keyFacts = input.key_facts.filter(Boolean).map(String).slice(0, 8);
  if (input.question_type) state.questionType = input.question_type;
  const reminders = [];
  if (!state.myCiv) reminders.push('My civ is unknown: say which civ you assume in a few words, or ask (only if the answer changes with it).');
  if (!state.age) reminders.push('My age is unknown: assume from context and say so.');
  if (unknown.length) reminders.push('Unknown civ names: ' + unknown.join(', ') + ' (use English names).');
  return { reminders, unknown };
}

function makeDispatcher({ gd, buildOrders, knowledge, strategy = null, lang = 'en', state = null, onState = () => {} }) {
  const unitOrThrow = (name, civ) => {
    const u = gd.findUnit(name, { civ: civ ? (gd.findCiv(civ) || {}).key : null });
    if (!u) throw new Error(`Unknown unit "${name}". Try the English name.`);
    return u;
  };
  const civOrThrow = (name) => {
    const c = gd.findCiv(name);
    if (!c) throw new Error(`Unknown civ "${name}"`);
    return c;
  };

  const handlers = {
    update_match_state(input) {
      if (!state) return { error: 'no state' };
      const { reminders } = applyStatePatch(gd, state, input || {});
      onState(state);
      const summary = { ...state };
      if (state.myCiv) summary.myCivNote = `check civ_info/find_counters with my_civ="${state.myCiv}" — never recommend units/techs this civ lacks`;
      return {
        state: summary,
        reminders,
        next:
          'Now call the data tools you need (numbers never from memory), then answer. Address every key_fact explicitly and respect my age (' +
          (state.age ? AGE_NAMES_SHORT[state.age] : 'unknown') +
          ').',
      };
    },
    lookup_unit({ name, civ }) {
      const u = unitOrThrow(name, civ);
      const d = gd.describeUnit(u, lang);
      const up = gd.unitUpgrades[String(u.id)];
      if (up) d.upgradeCost = { cost: up.Cost, researchTime: up.ResearchTime };
      if (civ) {
        const c = gd.findCiv(civ);
        if (c) d.availableFor = { civ: c.key, available: u.civs.has(c.key), ageForCiv: gd.ageName((u.ageByCiv && u.ageByCiv[c.key]) || u.age, lang) };
      }
      if (d.civs.length > 20) d.civs = `${d.civs.length} civs (common unit)`;
      return d;
    },
    compare_units({ unit_a, unit_b, civ_a, civ_b, upgrades_a = 0, upgrades_b = 0 }) {
      return combat.duel(gd, unitOrThrow(unit_a, civ_a), unitOrThrow(unit_b, civ_b), { civA: civ_a, civB: civ_b, tierA: upgrades_a, tierB: upgrades_b });
    },
    find_counters({ target_unit, my_civ, age, target_civ, my_upgrades, target_upgrades }) {
      if (state) {
        my_civ = my_civ || state.myCiv;
        age = age || state.age;
        target_civ = target_civ || state.oppCiv;
      }
      const civ = civOrThrow(my_civ);
      const tgt = unitOrThrow(target_unit, target_civ);
      const tier = (x, def) => (typeof x === 'number' ? x : def);
      return combat.counters(gd, tgt, civ.key, age || 4, {
        targetCiv: target_civ,
        myTier: tier(my_upgrades, Math.max(0, (age || 4) - 1)),
        targetTier: tier(target_upgrades, Math.max(0, (age || 4) - 1)),
      });
    },
    civ_info({ civ }) {
      return civSummary(gd, civOrThrow(civ), lang);
    },
    civ_matchup({ my_civ, opponent_civ }) {
      return matchup(gd, civOrThrow(my_civ), civOrThrow(opponent_civ), lang);
    },
    list_civ_units({ civ, age }) {
      const c = civOrThrow(civ);
      const byB = {};
      for (const u of gd.militaryUnitsFor(c.key, age || 4))
        (byB[u.buildingName] = byB[u.buildingName] || []).push(
          `${u.name_en}${lang === 'es' && u.name_es ? ' (' + u.name_es + ')' : ''} [${gd.ageName((u.ageByCiv && u.ageByCiv[c.key]) || u.age).split(' ')[0]}]`
        );
      return { civ: c.key, upToAge: gd.ageName(age || 4), unitsByBuilding: byB };
    },
    eco_plan({ units, upgrades = {} }) {
      const items = (units || []).map((x) => ({ unit: unitOrThrow(x.unit), buildings: x.buildings || 1 }));
      const plan = eco.villagersForQueue(items, upgrades);
      plan.resourceSplitPercent = eco.resourceSplit(items.map((i) => ({ unit: i.unit, weight: i.buildings })));
      plan.gatherRates = Object.fromEntries(Object.entries(eco.RATES).map(([k, v]) => [k, `${v.rate.join(' → ')} /min (${v.tiers.join(' → ')})`]));
      plan.farmFood = eco.FARM_FOOD;
      plan.ratesReviewedPatch = eco.RATES_REVIEWED + ' (field-measured approximations: ±5-15% with walking distance and drop-off placement)';
      return plan;
    },
    list_build_orders({ civ, query }) {
      const c = civ ? gd.findCiv(civ) : null;
      const res = buildOrders.search({ civ: c ? c.key : null, query: query || '' });
      return {
        results: res,
        tip: res.length
          ? 'Call get_build_order with an id for the steps.'
          : 'No stored build matches; import one from buildorderguide.com (JSON) in the Build Orders panel.',
      };
    },
    get_build_order({ id }) {
      const bo = buildOrders.get(id);
      if (!bo) throw new Error('No build order ' + id);
      return { summary: buildOrders.summary(bo), text: buildOrders.toText(bo) };
    },
    benchmarks({ build } = {}) {
      const file = buildOrders && buildOrders.dirs && buildOrders.dirs[0] ? path.join(path.dirname(buildOrders.dirs[0]), 'benchmarks.json') : null;
      let doc = null;
      try {
        doc = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      } catch {
        doc = null;
      }
      if (!doc) return { error: 'no benchmark table available' };
      const q = String(build || '')
        .toLowerCase()
        .split(/[^a-z0-9+]+/)
        .filter(Boolean);
      const builds = doc.builds.filter((b) => !q.length || q.some((w) => b.build.toLowerCase().includes(w)));
      return { about: doc._about, grades: doc.grades, builds: builds.length ? builds : doc.builds };
    },
    search_notes({ query }) {
      return { results: knowledge.search(query) };
    },
    civ_strategy({ civ }) {
      const c = civOrThrow(civ);
      const p = strategy && strategy.civ(c.key);
      if (!p) return { civ: c.key, error: 'no strategy profile for this civ yet', fallback: civSummary(gd, c, lang) };
      return { civ: c.key, meta: p.meta, profile: p.body };
    },
    map_info({ map }) {
      const p = strategy && strategy.findMap(map);
      if (!p) return { error: `no profile for map "${map}"`, known: strategy ? strategy.mapNames() : [] };
      return { map: p.meta.map || p.title, type: p.meta.type, profile: p.body };
    },
    list_maps() {
      return { maps: strategy ? strategy.mapNames() : [] };
    },
  };

  return async function dispatch(name, input) {
    const h = handlers[name];
    if (!h) return { error: `unknown tool ${name}` };
    try {
      return h(input || {});
    } catch (e) {
      return { error: e.message };
    }
  };
}

module.exports = { TOOLS, makeDispatcher, applyStatePatch, AGE_NAMES_SHORT };
