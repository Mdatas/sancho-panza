'use strict';
/**
 * Ficha de partida ("match sheet"): the structured answer mode. Everything in it is read from the app's own data —
 * tech trees (what each civ has and lacks), the civ and map strategy profiles, the duel maths and the build catalog.
 * No model writes a line of it: with an API key the model only parses the player's message into the match state
 * (brain.extract); without a key parseMessage() below does a plain keyword parse. The free "consejo" answer is a
 * separate, explicit step (brain.ask in libre mode with the sheet as context).
 *
 * buildSheet() returns plain data; the renderer draws it and sheetText() flattens it for the voice, the logs and the
 * model prompt. Pure functions: no Electron, no network.
 */
const { civSummary } = require('./civs');
const combat = require('./combat');
const { threatsOf } = require('./teamcounters');

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const AGE_WORDS = { oscura: 1, dark: 1, feudal: 2, castillos: 3, castillo: 3, castle: 3, imperial: 4, imp: 4 };
const NOT_AN_ANSWER = /Trebuchet|Petard|Demolition|Fire Ship|Flaming Camel|Missionary/i;
// catalog build types that fit each map type (data/knowledge/maps frontmatter "type:")
const MAP_TYPES = {
  abierto: { good: ['Scouts', 'Arqueros', 'Hombres de armas', 'Drush'], ok: ['Caballeros', 'Torres'], bad: ['Agua', 'Boom', 'Castle drop'] },
  híbrido: { good: ['Scouts', 'Arqueros', 'Agua', 'Hombres de armas'], ok: ['Fast Castle', 'Drush'], bad: ['Castle drop'] },
  semicerrado: { good: ['Fast Castle', 'Scouts', 'Arqueros'], ok: ['Caballeros', 'Boom', 'Hombres de armas'], bad: ['Agua'] },
  cerrado: {
    good: ['Fast Castle', 'Boom', 'Castle drop', 'Monjes'],
    ok: ['Caballeros', 'Asedio', 'Elefantes'],
    bad: ['Scouts', 'Drush', 'Agua', 'Torres', 'Aldeanos'],
  },
  agua: { good: ['Agua'], ok: ['Arqueros', 'Fast Castle'], bad: ['Scouts', 'Caballeros', 'Drush', 'Castle drop', 'Torres'] },
  nomad: { good: ['Scouts', 'Agua', 'TC drop'], ok: ['Arqueros', 'Fast Castle'], bad: ['Drush', 'Castle drop'] },
  aleatorio: { good: [], ok: [], bad: [] },
};
// opening words in a civ profile's "Aperturas 1v1" line → catalog build types
const OPENING_TYPES = [
  ['Scouts', /\bscouts?\b|explorador|caballer[ií]a ligera/i],
  ['Arqueros', /arquer|archer|\bxbow|ballester|skirm|guerriller|emplumad|plumed/i],
  ['Hombres de armas', /men[- ]at[- ]arms|man[- ]at[- ]arms|\bm@a\b|\bmaa\b|hombres? de armas|milicia|militia/i],
  ['Drush', /\bdrush\b/i],
  ['Fast Castle', /\bfc\b|fast castle|castillos r[aá]pid/i],
  ['Caballeros', /\bknights?\b|caballeros?\b|lancero/i],
  ['Torres', /\btrush\b|torres?\b|towers?\b/i],
  ['Monjes', /\bmonks?\b|monjes?\b/i],
  ['Agua', /galera|galley|muelle|dock|agua\b/i],
  ['Boom', /\bboom\b|3 ?tc/i],
  ['Castle drop', /castle drop|castillo adelantado/i],
  ['Elefantes', /elefante|elephant/i],
  ['Aldeanos', /vill(ager)? rush|rush de aldeanos/i],
];

/* ------------------------------------------------------------------ message parsing without a model */
function ngrams(words, max = 3) {
  const out = [];
  for (let i = 0; i < words.length; i++) for (let n = Math.min(max, words.length - i); n >= 1; n--) out.push({ i, n, text: words.slice(i, i + n).join(' ') });
  return out;
}

/**
 * Keyword parse of one chat message (Spanish / English). Returns { patch, units, subjectCiv, focus }:
 *  patch — in the shape brain/tools applyStatePatch takes (my_civ, opp_civ, map, age, elo, their_army, key_facts)
 *  units — military units named in the message (for the counters block)
 *  subjectCiv — a civ asked about without "yo/vs" markers (the sheet shows it without changing the state)
 *  focus — which block the player is asking for: counters | me | opp | map | builds | eco | all
 */
function parseMessage({ gd, strategy, text, state = {} }) {
  const raw = String(text || '');
  const t = ' ' + norm(raw) + ' ';
  const words = t.trim().split(' ').filter(Boolean);
  const patch = {};
  const units = [];
  const seenUnits = new Set();
  const civHits = [];
  const taken = new Set(); // word positions already consumed by a longer match
  const grams = ngrams(words, 3).sort((a, b) => b.n - a.n || a.i - b.i);
  for (const g of grams) {
    if ([...Array(g.n).keys()].some((k) => taken.has(g.i + k))) continue;
    if (g.text.length < 3) continue;
    // maps: exact index key only (the fuzzy findMap is for commands; here a stray "arena" inside another word must not count)
    if (strategy && strategy.mapIndex && !patch.map && strategy.mapIndex.has(g.text)) {
      const mp = strategy.maps[strategy.mapIndex.get(g.text)];
      patch.map = mp.meta.map || mp.title;
      for (let k = 0; k < g.n; k++) taken.add(g.i + k);
      continue;
    }
    // civs: exact name / alias / unambiguous prefix (gd.findCiv), 1-2 words, not generic words
    if (g.n <= 2 && gd) {
      const c = gd.findCiv(g.text);
      // findCiv also takes unambiguous 3-4 letter prefixes ("mon" → Mongols): here only full names (any length), aliases and prefixes of 5+ letters count
      if (c && ([c.key, c.name_en, c.name_es].some((n) => norm(n) === g.text) || g.text.length >= 5)) {
        civHits.push({ key: c.key, i: g.i, n: g.n });
        for (let k = 0; k < g.n; k++) taken.add(g.i + k);
        continue;
      }
    }
    // units: exact index key (plural-trimmed), military only
    if (gd && gd.nameIndex) {
      const cands = [g.text, g.text.replace(/s$/, ''), g.text.replace(/es$/, '')];
      const key = cands.find((k) => gd.nameIndex.has(k));
      if (key) {
        let u = null;
        try {
          u = gd.findUnit(key, { civ: state.oppCiv || null });
        } catch {
          u = null;
        }
        if (u && u.attack > 0 && !/Villager|Trade|Fishing|Transport/i.test(u.name_en) && !seenUnits.has(u.line ? u.line[0] : u.id)) {
          seenUnits.add(u.line ? u.line[0] : u.id);
          units.push(u);
          for (let k = 0; k < g.n; k++) taken.add(g.i + k);
          continue;
        }
      }
    }
  }
  // who is who: markers before the civ word decide; two bare civs = me then rival (only onto an empty state)
  const MINE = /\b(soy|yo|juego|jugando|tengo|elegi|elijo|me toco|me tocaron|i am|i m|im|playing|i play|me|my civ|as)$/;
  const OPP = /\b(vs|versus|contra|rival|rivales|enemigo|enemigos|oponente|against|opp|opponent|enemy|enemies|they are|he is|es|son)$/;
  let subjectCiv = '';
  const mine = [],
    opp = [];
  for (const h of civHits.sort((a, b) => a.i - b.i)) {
    const before = words.slice(Math.max(0, h.i - 3), h.i).join(' ');
    const after = words[h.i + h.n] || '';
    if (OPP.test(before)) opp.push(h.key);
    else if (MINE.test(before) || /^(vs|versus|contra|against)$/.test(after))
      mine.push(h.key); // "francos vs mayas": the civ before "vs" is mine
    else if (!mine.length && !opp.length && civHits.length >= 2 && !state.myCiv && !state.oppCiv) mine.push(h.key);
    else if (mine.length === 1 && !opp.length && civHits.length >= 2 && !state.oppCiv) opp.push(h.key);
    else subjectCiv = subjectCiv || h.key;
  }
  if (mine.length) patch.my_civ = mine[0];
  if (opp.length) {
    patch.opp_civ = opp[0];
    if (opp.length > 1) patch.enemies = opp.slice(0, 4);
  }
  // age ("estoy en feudal", "ya en castillos", "in castle age", "llegué a imperial")
  const ageM =
    t.match(
      /\b(?:estoy|estamos|ya|llegu\w*|subi\w*|voy|pase|pasamos|entr\w+|hit|reached|going|now|in|at)\s+(?:en|a|al|la|the)?\s*(?:edad\s+)?(?:de\s+)?(oscura|dark|feudal|castillos|castle|imperial|imp)\b/
    ) ||
    t.match(/\b(feudal|castle|castillos|imperial|dark|oscura)\s+age\b/) ||
    t.match(/\bedad\s+(?:de\s+)?(?:los\s+)?(oscura|feudal|castillos|imperial)\b/);
  if (ageM && AGE_WORDS[ageM[1]]) patch.age = AGE_WORDS[ageM[1]];
  const eloM = t.match(/\b(\d{3,4})\s*(?:de\s+)?elo\b/) || t.match(/\belo\s*(?:de|es|is|:)?\s*(\d{3,4})\b/);
  if (eloM) patch.elo = eloM[1];
  // what they make → their army (only with a marker: "me tira / hace / viene con / they have")
  const theirM = raw.match(
    /\b(?:me (?:tira|hace|viene|manda|ataca con|est[aá] haciendo)|hace|hacen|tiene|tienen|viene con|vienen con|they (?:have|make|are making|go)|he (?:has|makes|is making|goes)|going)\s+(.{3,60}?)(?:[.,;?!]|$)/i
  );
  if (theirM && units.length) patch.their_army = theirM[1].trim();
  // focus
  let focus = 'all';
  if (
    units.length &&
    /\b(vida|hp|stats?|ataque|armadura|alcance|velocidad|cuesta|costo|cost|damage|da[nñ]o|attack|armou?r|range|speed|cu[aá]nt[oa]s?|how much|how many|what does .* do|qu[eé] (?:hace|es) (?:el|la|un|una)\b)/.test(
      t
    )
  )
    focus = 'units';
  else if (units.length || /\bcounter|contra\b|\bbeat|gana a\b|qu[eé] le hago|c[oó]mo (?:paro|freno|mato)|how do i (?:stop|beat|kill)/.test(t))
    focus = 'counters';
  else if (/\bbuild\b|\bbo\b|apertura|opening|orden de construccion|qu[eé] abro|como abro|how do i open/.test(t)) focus = 'builds';
  else if (/\bmapa\b|\bmap\b/.test(t)) focus = 'map';
  else if (/\brival\b|\boponente\b|\bopponent\b|\benemy\b|\bcontra\b/.test(t) && (opp.length || state.oppCiv)) focus = 'opp';
  else if (/\baldeanos?\b|\bvill(ager)?s?\b|\beco\b|econom|granjas?|farms?|\btc\b|boom/.test(t)) focus = 'eco';
  else if (subjectCiv || mine.length) focus = 'me';
  return { patch, units, subjectCiv, focus };
}

/* ------------------------------------------------------------------ civ / map / counters blocks */
function sectionOf(profile, name) {
  if (!profile) return '';
  const k = Object.keys(profile.sections).find((x) => norm(x) === norm(name) || norm(x).startsWith(norm(name)));
  return k ? profile.sections[k] : '';
}
/** The "Aperturas 1v1" line that matches the map type (abiertos / cerrados / agua-híbridos-nomad). */
function openingFor(profile, mapType) {
  const sec = sectionOf(profile, 'Aperturas 1v1');
  const lines = sec
    .split('\n')
    .map((l) => l.replace(/^-\s*/, '').trim())
    .filter(Boolean);
  const pick = (re) => lines.find((l) => re.test(l.split(':')[0]));
  const byType = {
    abierto: pick(/abiert|arabia/i),
    semicerrado: pick(/abiert|arabia/i),
    cerrado: pick(/cerrad|arena/i),
    agua: pick(/agua|h[ií]brid|nomad/i),
    híbrido: pick(/agua|h[ií]brid|nomad/i),
    nomad: pick(/agua|h[ií]brid|nomad/i),
  };
  const line = (mapType && byType[mapType]) || null;
  const body = line ? line.split(':').slice(1).join(':') : '';
  // "scouts a 19-20 pop …. Alternativa: hombres de armas → scouts": the main opening comes before the alternative
  const [primary, ...rest] = body.split(/\b(?:alternativa|alternative|opci[oó]n b|o bien|also|tambi[eé]n)\b/i);
  const typesIn = (txt) => OPENING_TYPES.filter(([, re]) => re.test(txt)).map(([x]) => x);
  const primaryTypes = typesIn(primary || '');
  return {
    all: lines,
    line: line || '',
    types: line ? typesIn(body) : [],
    primaryTypes,
    altTypes: typesIn(rest.join(' ')).filter((t) => !primaryTypes.includes(t)),
  };
}

function civBlock({ gd, strategy, key, stats, lang, mapType, role }) {
  const civ = gd.findCiv(key);
  if (!civ) return null;
  const p = strategy ? strategy.civ(civ.key) : null;
  const sum = civSummary(gd, civ, lang === 'es' ? 'es' : 'en');
  const nameOf = (u) => (lang === 'es' && u.name_es ? u.name_es : u.name_en);
  // best unit of each line by building (same grouping as the guide)
  const bestOfLine = new Map();
  for (const u of gd.militaryUnitsFor(civ.key, 4)) {
    const k = u.line[0];
    const cur = bestOfLine.get(k);
    if (!cur || (u.age || 0) > (cur.age || 0) || (u.age === cur.age && u.id > cur.id)) bestOfLine.set(k, u);
  }
  const lineup = {};
  for (const u of bestOfLine.values())
    (lineup[u.buildingName] = lineup[u.buildingName] || []).push({ name: nameOf(u), en: u.name_en, age: (u.ageByCiv && u.ageByCiv[civ.key]) || u.age || 0 });
  for (const g of Object.values(lineup)) g.sort((a, b) => a.age - b.age);
  const st = stats && stats.rows ? stats.rows.find((r) => norm(r.civ) === norm(civ.name_en)) : null;
  const opening = openingFor(p, mapType);
  const uu = (civ.uniqueUnits || []).filter((n) => !/^Elite /.test(n));
  return {
    role, // 'me' | 'opp' | 'subject'
    key: civ.key,
    name: lang === 'es' ? civ.name_es : civ.name_en,
    name_en: civ.name_en,
    trait: civ.trait || '',
    style: p ? p.meta.style || '' : '',
    bestAges: p && Array.isArray(p.meta.best_ages) ? p.meta.best_ages.map(Number) : [],
    strength: sectionOf(p, 'Fuerza por edad'),
    identity: sectionOf(p, 'Identidad'),
    bonuses: civ.bonuses || [],
    teamBonus: civ.teamBonus || '',
    uniqueUnits: uu.map((n) => {
      const u = gd.findUnit(n);
      return { en: n, name: u ? nameOf(u) : n, cost: u ? u.cost : null, age: u ? (u.ageByCiv && u.ageByCiv[civ.key]) || u.age || 3 : 3 };
    }),
    uniqueUnitText: sectionOf(p, 'Unidad única') || (civ.uniqueUnitText || []).join(' · '),
    uniqueTechs: (civ.uniqueTechs || []).map((n, i) => {
      const t = gd.findTech(n);
      return {
        en: n,
        name: t && lang === 'es' && t.name_es ? t.name_es : n,
        age: t ? (t.ageByCiv && t.ageByCiv[civ.key]) || t.age || 0 : 0,
        text: (civ.uniqueTechText || [])[i] || '',
      };
    }),
    uniqueTechText: sectionOf(p, 'Tecnologías únicas'),
    missingUnits: sum.missingKeyUnits,
    missingTechs: sum.missingKeyTechs,
    missingText: sectionOf(p, 'Lo que NO tiene'),
    blacksmith: sum.fullBlacksmith,
    lineup,
    openings: opening.all,
    openingHere: opening.line,
    openingTypes: opening.types,
    openingPrimary: opening.primaryTypes,
    castlePlan: sectionOf(p, 'Plan en Castillos'),
    imperialPlan: sectionOf(p, 'Plan en Imperial'),
    compositions: sectionOf(p, 'Composiciones fuertes'),
    against: sectionOf(p, 'Jugando CONTRA esta civ'),
    mistakes: sectionOf(p, 'Errores comunes'),
    maps: sectionOf(p, 'Mapas'),
    derived: !!(p && p.meta.derived === true),
    stats: st ? { wr: st.wr, pick: st.pick, tier: st.tier, rank: st.rank } : null,
  };
}

function mapBlock({ strategy, name, oppCiv, gd }) {
  const m = strategy && name ? strategy.findMap(name) : null;
  if (!m) return null;
  const vs = sectionOf(m, 'Jugadas vs el rival');
  let vsLine = '';
  if (oppCiv && gd) {
    const c = gd.findCiv(oppCiv);
    const names = c ? [c.name_en, c.name_es].map(norm) : [];
    vsLine = vs.split(/(?<=\.)\s+(?=Vs\b)/i).find((l) => names.some((n) => norm(l).includes(n))) || '';
  }
  return {
    name: m.meta.map || m.title,
    type: m.meta.type || '',
    aliases: Array.isArray(m.meta.aliases) ? m.meta.aliases : [],
    geography: sectionOf(m, 'Tipo y geografía'),
    resources: sectionOf(m, 'Recursos iniciales'),
    walls: sectionOf(m, 'Murallas'),
    wins: sectionOf(m, 'Qué gana acá'),
    openings: sectionOf(m, 'Aperturas estándar'),
    civs: sectionOf(m, 'Civs fuertes'),
    timings: sectionOf(m, 'Timings de referencia'),
    mistakes: sectionOf(m, 'Errores comunes'),
    vsCiv: vs,
    vsLine,
  };
}

/** Counters my civ has to each unit (duel maths, roster and upgrades filtered for my civ and age). */
function counterRows({ gd, myCiv, oppCiv, age, units, lang }) {
  const me = myCiv && gd.findCiv(myCiv);
  const a = Math.min(4, Math.max(2, Number(age) || 3));
  const rows = [];
  for (const u of units.slice(0, 4)) {
    const row = { unit: lang === 'es' && u.name_es ? u.name_es : u.name_en, unit_en: u.name_en, options: [], noCiv: !me };
    if (me) {
      try {
        const r = combat.counters(gd, u, me.key, a, { targetCiv: oppCiv || null, myTier: Math.max(0, a - 1), targetTier: Math.max(0, a - 1), limit: 8 });
        row.options = r.candidates
          .filter((c) => c.score >= 0.6 && !NOT_AN_ANSWER.test(c.unit))
          .slice(0, 4)
          .map((c) => ({
            unit: lang === 'es' ? c.unit_es || c.unit : c.unit,
            unit_en: c.unit,
            score: c.score,
            cost: c.cost || null,
            note: (c.bonusVsTarget || [])[0] || '',
            kited: (c.mobility || []).some((m) => /gets kited/.test(m)),
          }));
      } catch {
        /* unknown unit for this roster */
      }
    }
    rows.push(row);
  }
  return { age: a, ageAssumed: !Number(age), rows };
}

/** Stats of the units named in the question, straight from the current-patch data (what lookup_unit gives the model). */
function unitCards({ gd, units, lang, myCiv, oppCiv }) {
  const out = [];
  for (const u of units.slice(0, 4)) {
    let d;
    try {
      d = gd.describeUnit(u, lang === 'es' ? 'es' : 'en');
    } catch {
      continue;
    }
    const avail = (civ) => (civ && gd.findCiv(civ) ? u.civs.has(gd.findCiv(civ).key) : null);
    out.push({
      name: lang === 'es' && u.name_es ? u.name_es : u.name_en,
      name_en: u.name_en,
      age: d.ageNum || u.age || 0,
      building: d.building || u.buildingName || '',
      line: d.line || [],
      cost: d.cost || u.cost || {},
      trainTime: d.trainTime,
      hp: d.hp,
      attack: d.attack,
      attackType: d.attackType,
      armor: d.armor,
      range: d.range,
      speed: d.speed,
      reload: d.reload,
      // biggest bonus first ("+22 vs Mounted Units" before "+1 vs Shock Infantry")
      bonusDamage: (d.bonusDamage || [])
        .filter((b) => !/\+0 /.test(b))
        .sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0))
        .slice(0, 6),
      mineCan: avail(myCiv),
      theirsCan: avail(oppCiv),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ build suggestions */
/**
 * Preloaded builds that fit this match, from the catalog: step-by-step builds (loadable into the panel) ranked by tier,
 * civ, map type and the civ profile's own opening for that map type; plus anti-meta guides (notes) for the same civ.
 */
function suggestBuilds({ catalog, gd, myCiv, mapType, openingTypes = [], openingPrimary = [], age = 0, wantMeme = false, limit = { meta: 3, anti: 2 } }) {
  if (!catalog) return { steps: [], guides: [], none: true };
  const me = myCiv && gd ? gd.findCiv(myCiv) : null;
  const myNames = me ? [me.key, me.name_en, me.name_es].map(norm) : [];
  const fit = MAP_TYPES[mapType] || MAP_TYPES.aleatorio;
  const score = (e) => {
    let s = 0;
    const reasons = [];
    const forMe = e.civs.some((c) => myNames.includes(norm(c)));
    const generic = !e.civs.length || e.civs.some((c) => /^any$/i.test(c));
    if (me && !forMe && !generic) return null; // another civ's build
    if (forMe) {
      s += 4;
      reasons.push('civ');
    } else if (generic) s += 1;
    if (e.tier === 'meta') s += 3;
    else if (e.tier === 'anti-meta') s += 1;
    else if (!wantMeme) return null;
    const types = e.types || [];
    if (types.some((t) => openingPrimary.includes(t))) {
      s += 4; // the civ profile's main opening for this kind of map
      reasons.push('opening');
    } else if (types.some((t) => openingTypes.includes(t))) {
      s += 2; // the profile's alternative opening
      reasons.push('opening-alt');
    }
    if (types.some((t) => fit.good.includes(t))) {
      s += 2;
      reasons.push('map');
    } else if (types.some((t) => fit.ok.includes(t))) s += 1;
    if (types.some((t) => fit.bad.includes(t))) s -= 3;
    if (age >= 3 && types.some((t) => /Scouts|Drush|Hombres de armas|Torres/.test(t))) s -= 2; // feudal plays after Castle Age
    if (e.kind === 'steps' && e.feudalPop) s += 0.5; // a real step build with pop numbers
    return { s, reasons };
  };
  const rank = (list) =>
    list
      .map((e) => {
        const r = score(e);
        return r ? { e, ...r } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.s - a.s || String(b.e.date || '').localeCompare(String(a.e.date || '')));
  const steps = rank(catalog.steps || []);
  const meta = steps.filter((x) => x.e.tier === 'meta').slice(0, limit.meta);
  const memes = wantMeme ? steps.filter((x) => x.e.tier === 'meme').slice(0, 2) : [];
  const notes = catalog.notes || [];
  // without a registered civ only civ-agnostic guides make sense (a "Mass Cataphracts" guide is not a suggestion for everyone)
  const generalEnough = (n) => me || !n.civs.length || n.civs.every((c) => /^any$/i.test(c));
  // anti-meta: guides for my civ (or generic) from the notes, newest first among the best scores
  let guides = rank(notes.filter((n) => n.tier === 'anti-meta' && generalEnough(n))).slice(0, limit.anti);
  // no step build matches the opening / map type (water, nomad…): the meta guides that do, so the block is never empty-handed
  if (mapType && !meta.some((x) => x.reasons.includes('opening') || x.reasons.includes('map')))
    guides = rank(notes.filter((n) => n.tier === 'meta' && generalEnough(n)))
      .filter((x) => x.reasons.includes('opening') || x.reasons.includes('map'))
      .slice(0, 2)
      .concat(guides);
  if (wantMeme) guides = guides.concat(rank(notes.filter((n) => n.tier === 'meme' && generalEnough(n))).slice(0, 2));
  const pack = (x) => ({
    id: x.e.id,
    kind: x.e.kind,
    title: x.e.title,
    civs: x.e.civs,
    types: x.e.types,
    tier: x.e.tier,
    author: x.e.author || '',
    date: x.e.date || '',
    steps: x.e.steps || 0,
    feudalPop: x.e.feudalPop || null,
    file: x.e.file || '',
    stem: x.e.stem || '',
    pasos: x.e.pasos || null,
    why: x.reasons,
  });
  return { steps: meta.concat(memes).map(pack), guides: guides.map(pack), none: !meta.length && !guides.length };
}

/* ------------------------------------------------------------------ the sheet */
/**
 * @param {object} a
 * @param a.gd GameData  @param a.strategy Strategy  @param a.catalog bocatalog.catalog() result (or null)
 * @param a.state brain match state  @param a.stats parsed civ stats (guideData.parseCivStats) or null
 * @param a.lang 'es' | 'en' (profile text stays Spanish; names and labels follow lang)
 * @param a.question the player's message (optional)  @param a.parsed parseMessage() result (optional)
 */
function buildSheet({ gd, strategy, catalog = null, state = {}, stats = null, lang = 'es', question = '', parsed = null }) {
  const p = parsed || parseMessage({ gd, strategy, text: question, state });
  const map = mapBlock({ strategy, name: state.map, oppCiv: state.oppCiv, gd });
  const mapType = map ? map.type : '';
  const me = state.myCiv ? civBlock({ gd, strategy, key: state.myCiv, stats, lang, mapType, role: 'me' }) : null;
  const opp = state.oppCiv ? civBlock({ gd, strategy, key: state.oppCiv, stats, lang, mapType, role: 'opp' }) : null;
  const subject =
    p.subjectCiv && p.subjectCiv !== state.myCiv && p.subjectCiv !== state.oppCiv
      ? civBlock({ gd, strategy, key: p.subjectCiv, stats, lang, mapType, role: 'subject' })
      : null;
  // units to counter: the ones named in the question, else the opponent's registered army, else the rival civ's likely threats
  let units = p.units.slice();
  let unitsFrom = units.length ? 'question' : '';
  if (!units.length && state.theirArmy) {
    units = armyUnits(gd, state.theirArmy, state.oppCiv);
    if (units.length) unitsFrom = 'army';
  }
  if (!units.length && state.oppCiv && (p.focus === 'counters' || p.focus === 'opp' || p.focus === 'all')) {
    try {
      const t = threatsOf(gd, strategy, state.oppCiv, Math.min(4, Math.max(2, Number(state.age) || 3)));
      units = (t.units || []).map((x) => x.u);
      if (units.length) unitsFrom = 'threats';
    } catch {
      /* no profile */
    }
  }
  const counters = units.length ? { ...counterRows({ gd, myCiv: state.myCiv, oppCiv: state.oppCiv, age: state.age, units, lang }), from: unitsFrom } : null;
  const unitStats = p.units.length ? unitCards({ gd, units: p.units, lang, myCiv: state.myCiv, oppCiv: state.oppCiv }) : [];
  const wantMeme = /\bmeme|cheese|troll|cheesy|rara|sorpresa|surprise|loca\b/i.test(question || '');
  const builds = suggestBuilds({
    catalog,
    gd,
    myCiv: state.myCiv,
    mapType,
    openingTypes: me ? me.openingTypes : [],
    openingPrimary: me ? me.openingPrimary : [],
    age: Number(state.age) || 0,
    wantMeme,
  });
  const missing = [];
  if (!state.myCiv) missing.push('myCiv');
  if (!state.oppCiv) missing.push('oppCiv');
  if (!state.map) missing.push('map');
  if (!state.age) missing.push('age');
  if (!state.elo) missing.push('elo');
  const teamGame = (state.allies || []).length > 0 || (state.enemies || []).length > 1;
  return {
    kind: 'sheet',
    lang,
    at: Date.now(),
    question: question || '',
    focus: p.focus,
    parsed: { patch: p.patch, units: p.units.map((u) => u.name_en), subjectCiv: p.subjectCiv },
    state: { ...state },
    missing,
    teamGame,
    me,
    opp,
    subject,
    map,
    counters,
    units: unitStats,
    builds,
  };
}

/** Units named in the registered army text ("6 knights, mangonel coming" → Knight, Mangonel). Same rule as the brain's. */
function armyUnits(gd, text, oppCiv) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/[,;/+]| y | and |\n/)) {
    const phrase = raw
      .replace(/\d+|\b(coming|viniendo|llegando|masa|mass|of|de|the|el|la|los|las|unos|some|con|with|en|in|y)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!phrase) continue;
    let u = null;
    try {
      u = gd.findUnit(phrase, { civ: oppCiv || null });
      if (!u) for (const w of phrase.split(' ')) if (w.length > 3 && (u = gd.findUnit(w, { civ: oppCiv || null }))) break;
    } catch {
      u = null;
    }
    if (u && u.attack > 0 && !seen.has(u.id)) {
      seen.add(u.id);
      out.push(u);
    }
    if (out.length >= 3) break;
  }
  return out;
}

/* ------------------------------------------------------------------ text version (voice, logs, model context) */
const AGE_LABEL = { es: { 1: 'Oscura', 2: 'Feudal', 3: 'Castillos', 4: 'Imperial' }, en: { 1: 'Dark', 2: 'Feudal', 3: 'Castle', 4: 'Imperial' } };
const LABELS = {
  es: {
    units: 'Unidades',
    attack: 'ataque',
    range: 'alcance',
    armor: 'armadura',
    speed: 'velocidad',
    me: 'Mi civ',
    opp: 'Rival',
    subject: 'Civ',
    map: 'Mapa',
    counters: 'Counters',
    builds: 'Builds sugeridos',
    strength: 'Fuerza por edad',
    bonuses: 'Bonos',
    team: 'Bono de equipo',
    uu: 'Unidad única',
    ut: 'Tecnologías únicas',
    missing: 'No tiene',
    opening: 'Apertura según el perfil',
    against: 'Cómo se le juega',
    vs: 'vs',
    assumed: 'edad supuesta',
    none: 'sin respuesta eficiente en mi roster',
    noCiv: 'registrá tu civ para ver con qué contestar',
    guides: 'Guías anti-meta',
    missingState: 'Falta',
    missingKeys: { myCiv: 'tu civ', oppCiv: 'la civ rival', map: 'el mapa', age: 'tu edad', elo: 'tu ELO' },
    stats: 'Stats',
  },
  en: {
    units: 'Units',
    attack: 'attack',
    range: 'range',
    armor: 'armor',
    speed: 'speed',
    me: 'My civ',
    opp: 'Opponent',
    subject: 'Civ',
    map: 'Map',
    counters: 'Counters',
    builds: 'Suggested builds',
    strength: 'Strength by age',
    bonuses: 'Bonuses',
    team: 'Team bonus',
    uu: 'Unique unit',
    ut: 'Unique techs',
    missing: 'Lacks',
    opening: 'Opening per the profile',
    against: 'How to play against it',
    vs: 'vs',
    assumed: 'age assumed',
    none: 'no efficient answer in my roster',
    noCiv: 'register your civ to see what to answer with',
    guides: 'Anti-meta guides',
    missingState: 'Missing',
    missingKeys: { myCiv: 'your civ', oppCiv: 'the rival civ', map: 'the map', age: 'your age', elo: 'your ELO' },
    stats: 'Stats',
  },
};
function sheetText(sheet, { full = false } = {}) {
  const L = LABELS[sheet.lang === 'es' ? 'es' : 'en'];
  const out = [];
  const civ = (c) => {
    if (!c) return;
    const lines = [
      `## ${L[c.role] || L.subject}: ${c.name}${c.style ? ` (${c.style})` : ''}${c.stats ? ` — ${L.stats}: ${c.stats.wr}% WR · tier ${c.stats.tier}` : ''}`,
    ];
    if (c.strength) lines.push(`${L.strength}: ${c.strength}`);
    if (c.bonuses.length) lines.push(`${L.bonuses}: ${c.bonuses.join(' · ')}`);
    if (c.teamBonus) lines.push(`${L.team}: ${c.teamBonus}`);
    if (c.uniqueUnits.length) lines.push(`${L.uu}: ${c.uniqueUnits.map((u) => u.name).join(', ')}${full && c.uniqueUnitText ? ' — ' + c.uniqueUnitText : ''}`);
    if (c.uniqueTechs.length)
      lines.push(`${L.ut}: ${c.uniqueTechs.map((t) => `${t.name}${t.text ? ` (${t.text.replace(/^[^(]*\(/, '').replace(/\)$/, '')})` : ''}`).join(' · ')}`);
    if (c.missingUnits.length || c.missingTechs.length) lines.push(`${L.missing}: ${[...c.missingUnits, ...c.missingTechs].join(', ')}`);
    if (c.openingHere) lines.push(`${L.opening}: ${c.openingHere}`);
    else if (c.openings.length) lines.push(`${L.opening}: ${c.openings.join(' | ')}`);
    if (c.role === 'opp' && c.against) lines.push(`${L.against}: ${c.against}`);
    if (full) {
      if (c.compositions) lines.push(`Composiciones: ${c.compositions}`);
      if (c.castlePlan) lines.push(`Castillos: ${c.castlePlan}`);
      if (c.imperialPlan) lines.push(`Imperial: ${c.imperialPlan}`);
      if (c.mistakes) lines.push(`Errores comunes: ${c.mistakes}`);
    }
    out.push(lines.join('\n'));
  };
  civ(sheet.me);
  civ(sheet.opp);
  civ(sheet.subject);
  if (sheet.map) {
    const m = sheet.map;
    const lines = [`## ${L.map}: ${m.name}${m.type ? ` (${m.type})` : ''}`];
    if (m.wins) lines.push(m.wins);
    if (m.openings) lines.push(m.openings);
    if (m.timings) lines.push(m.timings);
    if (m.vsLine) lines.push(m.vsLine);
    if (full) {
      if (m.walls) lines.push(m.walls);
      if (m.civs) lines.push(m.civs);
      if (m.mistakes) lines.push(m.mistakes);
    }
    out.push(lines.join('\n'));
  }
  if (sheet.units && sheet.units.length) {
    const fmtCost = (c) =>
      Object.entries(c || {})
        .map(([k, v]) => `${v}${k[0]}`)
        .join(' ');
    out.push(
      `## ${L.units}\n` +
        sheet.units
          .map(
            (u) =>
              `- ${u.name}: ${u.hp} HP · ${L.attack} ${u.attack}${u.range ? ` (${L.range} ${u.range})` : ''} · ${L.armor} ${u.armor} · ${L.speed} ${u.speed} · ${fmtCost(u.cost)} · ${AGE_LABEL[sheet.lang === 'es' ? 'es' : 'en'][u.age] || ''}${u.bonusDamage.length ? ' · ' + u.bonusDamage.join(', ') : ''}`
          )
          .join('\n')
    );
  }
  if (sheet.counters && sheet.counters.rows.length) {
    const c = sheet.counters;
    out.push(
      `## ${L.counters} (${c.age}${c.ageAssumed ? ', ' + L.assumed : ''})\n` +
        c.rows
          .map(
            (r) =>
              `- ${L.vs} ${r.unit}: ${r.noCiv ? L.noCiv : r.options.length ? r.options.map((o) => `${o.unit} (${o.score}${o.note ? ', ' + o.note : ''}${o.kited ? ', kited' : ''})`).join(' / ') : L.none}`
          )
          .join('\n')
    );
  }
  if (sheet.builds && !sheet.builds.none) {
    const b = sheet.builds;
    const line = (x) =>
      `- ${x.title} — ${x.civs.join('/')}${x.types.length ? ' · ' + x.types.join(', ') : ''} · ${x.tier.toUpperCase()}${x.author ? ' · ' + x.author : ''}`;
    out.push(`## ${L.builds}\n${b.steps.map(line).join('\n')}${b.guides.length ? `\n${L.guides}:\n${b.guides.map(line).join('\n')}` : ''}`);
  }
  if (sheet.missing.length) out.push(`${L.missingState}: ${sheet.missing.map((k) => L.missingKeys[k]).join(', ')}`);
  return out.join('\n\n');
}

/** Short spoken summary: the three most useful lines for this question. */
function sheetSpoken(sheet) {
  const L = LABELS[sheet.lang === 'es' ? 'es' : 'en'];
  const lines = [];
  if (sheet.focus === 'units' && sheet.units && sheet.units.length) {
    const u = sheet.units[0];
    lines.push(`${u.name}: ${u.hp} HP, ${L.attack} ${u.attack}, ${L.armor} ${u.armor}${u.bonusDamage.length ? ', ' + u.bonusDamage[0] : ''}`);
  }
  if (sheet.counters && sheet.counters.rows.length && sheet.counters.rows[0].options.length) {
    const r = sheet.counters.rows[0];
    lines.push(
      `${L.vs} ${r.unit}: ${r.options
        .slice(0, 3)
        .map((o) => o.unit)
        .join(', ')}`
    );
  }
  const c = sheet.subject || (sheet.focus === 'opp' ? sheet.opp : sheet.me) || sheet.opp;
  if (c && c.strength) lines.push(`${c.name}: ${c.strength}`);
  if (sheet.map && sheet.map.wins) lines.push(`${sheet.map.name}: ${sheet.map.wins}`);
  if (!lines.length && sheet.builds && sheet.builds.steps.length) lines.push(`${L.builds}: ${sheet.builds.steps.map((b) => b.title).join(', ')}`);
  // spoken, so short: cut each line at a sentence / clause end once it passes ~170 chars
  const clip = (t) => {
    if (t.length <= 170) return t;
    const cut = t.slice(0, 170);
    const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(' · '), cut.lastIndexOf(', '));
    return (at > 60 ? cut.slice(0, at) : cut).replace(/[,;· ]+$/, '');
  };
  return lines.slice(0, 3).map(clip).join('. ');
}

module.exports = { buildSheet, parseMessage, sheetText, sheetSpoken, suggestBuilds, openingFor, MAP_TYPES, armyUnits };
