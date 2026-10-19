'use strict';
/**
 * Strategy knowledge base: markdown files split into sections, searched by keyword overlap.
 * Bundled notes live in <data>/knowledge; the user can drop their own .md files into <userData>/knowledge.
 */
const fs = require('fs');
const path = require('path');

const STOP = new Set('tan tanto bueno buena buenos buenas good how are the is what and vale pena cuanto cuánto cuanta mejor peor sirve sirven conviene debo deberia debería puedo que qué hago hacer como cómo contra para con por los las del una uno unos unas este esta esto ese esa eso pero mas más muy sin sobre tengo tiene tienen estoy esta están mi mis su sus le les lo me se nos vos sos soy son era fue hay ahora cuando donde dónde cual cuál cuales the and for with what how should this that from have has are you your vs against make makes doing does'.split(' '));
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

// Spelling/translation groups: a query token in one group also matches the other spellings (word-start).
const ALIAS_GROUPS = [
  ['dravidas', 'dravidianos', 'dravidians', 'dravidian'], ['indostanies', 'hindustanis', 'hindustani', 'indostani', 'indios', 'indians'],
  ['malies', 'malienses', 'malians', 'malian', 'mali'], ['khmer', 'jemeres', 'jemer', 'camboyanos'], ['tupies', 'tupi', 'tupis'],
  ['khitanos', 'khitans', 'khitan', 'kitan'], ['jurchens', 'jurchen', 'yurchen', 'yurchenes'], ['varegos', 'varangians', 'varangian', 'varangios', 'varego'],
  ['sajones', 'saxons', 'saxon', 'sajon'], ['mapuches', 'mapuche'], ['muiscas', 'muisca'], ['magiares', 'magyars', 'magyar', 'hungaros'],
  ['bizantinos', 'byzantines', 'byzantine', 'bizantino'], ['bulgaros', 'bulgarians', 'bulgarian', 'bulgaro'], ['francos', 'franks', 'frank', 'franco'],
  ['britanos', 'britons', 'briton', 'britano', 'britanicos'], ['bereberes', 'berbers', 'berber', 'berebere'], ['bohemios', 'bohemians', 'bohemian', 'bohemio'],
  ['borgonones', 'borgoneses', 'burgundians', 'burgundian', 'borgonon'], ['birmanos', 'burmese', 'birmano'], ['celtas', 'celts', 'celt', 'celta'],
  ['chinos', 'chinese', 'chino'], ['cumanos', 'cumans', 'cuman', 'cumano'], ['etiopes', 'ethiopians', 'ethiopian', 'etiope'], ['godos', 'goths', 'goth', 'godo'],
  ['hunos', 'huns', 'hun', 'huno'], ['incas', 'inca', 'incaicos'], ['italianos', 'italians', 'italian', 'italiano'], ['japoneses', 'japanese', 'japones'],
  ['coreanos', 'koreans', 'korean', 'coreano'], ['lituanos', 'lithuanians', 'lithuanian', 'lituano'], ['malayos', 'malay', 'malays', 'malayo'],
  ['mayas', 'mayans', 'maya', 'mayan'], ['mongoles', 'mongols', 'mongol'], ['persas', 'persians', 'persian', 'persa'], ['polacos', 'poles', 'polish', 'polaco'],
  ['portugueses', 'portuguese', 'portugues'], ['sarracenos', 'saracens', 'saracen', 'sarraceno'], ['sicilianos', 'sicilians', 'sicilian', 'siciliano'],
  ['eslavos', 'slavs', 'slav', 'eslavo'], ['espanoles', 'spanish', 'espanol'], ['tartaros', 'tatars', 'tatar', 'tartaro'], ['teutones', 'teutons', 'teuton', 'teuton', 'teutonicos'],
  ['turcos', 'turks', 'turk', 'turco', 'otomanos'], ['vietnamitas', 'vietnamese', 'vietnamita'], ['vikingos', 'vikings', 'viking', 'vikingo'],
  ['georgianos', 'georgians', 'georgian', 'georgiano'], ['armenios', 'armenians', 'armenian', 'armenio'], ['romanos', 'romans', 'roman', 'romano'],
  ['daneses', 'danes', 'danish', 'danes', 'danes'], ['gurjaras', 'gurjara'], ['bengalies', 'bengalis', 'bengali'], ['aztecas', 'aztecs', 'aztec', 'azteca'],
  // units / buildings commonly asked in either language
  ['caballero', 'caballeros', 'knight', 'knights'], ['arquero', 'arqueros', 'archer', 'archers'], ['ballestero', 'ballesteros', 'crossbow', 'crossbowman', 'crossbowmen', 'xbow', 'xbows'],
  ['guerrillero', 'guerrilleros', 'skirmisher', 'skirmishers', 'skirm', 'skirms'], ['piquero', 'piqueros', 'lancero', 'lanceros', 'spearman', 'spearmen', 'spear', 'spears', 'pikeman', 'pikemen', 'pike', 'pikes'],
  ['alabardero', 'alabarderos', 'halberdier', 'halberdiers', 'halb', 'halbs'], ['camello', 'camellos', 'camel', 'camels'], ['explorador', 'exploradores', 'scout', 'scouts'],
  ['hombres de armas', 'hombre de armas', 'maa', 'man-at-arms', 'men-at-arms', 'milicia', 'militia'], ['monje', 'monjes', 'monk', 'monks'], ['mangonel', 'mangoneles', 'mangonels', 'onagro', 'onagros', 'onager', 'onagers'],
  ['ariete', 'arietes', 'ram', 'rams'], ['escorpion', 'escorpiones', 'scorpion', 'scorpions'], ['trebuchet', 'trebuchets', 'fundibulo', 'fundibulos', 'treb', 'trebs'],
  ['aguila', 'aguilas', 'eagle', 'eagles'], ['husar', 'husares', 'hussar', 'hussars', 'caballeria ligera', 'light cav', 'light cavalry'], ['paladin', 'paladines', 'paladins'],
  ['torre', 'torres', 'tower', 'towers', 'trush'], ['castillo', 'castillos', 'castle', 'castles'], ['muralla', 'murallas', 'muro', 'muros', 'wall', 'walls', 'walling', 'empalizada', 'palisade'],
  ['centro urbano', 'tc', 'town center', 'town centre'], ['aldeano', 'aldeanos', 'villager', 'villagers', 'vill', 'vills', 'aldea'], ['ciervo', 'ciervos', 'deer'], ['jabali', 'jabalies', 'boar', 'boars'],
  ['oveja', 'ovejas', 'sheep'], ['granja', 'granjas', 'farm', 'farms'], ['oro', 'gold'], ['madera', 'wood'], ['comida', 'food'], ['piedra', 'stone'],
  ['feudal', 'feudal age'], ['castillos', 'castle age'], ['imperial', 'imperial age'], ['oscura', 'dark age', 'drush'], ['apertura', 'aperturas', 'opening', 'openings', 'build', 'build order', 'bo'],
  ['contra', 'counter', 'counters', 'vs', 'contrarrestar', 'frenar', 'parar', 'defender', 'defensa', 'defend', 'stop'],
];
const ALIAS = new Map();
for (const g of ALIAS_GROUPS) for (const w of g) { const k = norm(w); if (!ALIAS.has(k)) ALIAS.set(k, new Set()); for (const x of g) ALIAS.get(k).add(norm(x)); }
/** Files whose notes are off-meta; they rank lower unless the player asks for a meme/cheese or how to stop one. */
const TIER_FILE = [[/^poop_lord_/, 'meme'], [/^break_the_meta/, 'anti-meta']];
function tierOf(file) { for (const [re, t] of TIER_FILE) if (re.test(file)) return t; return 'meta'; }

function splitLong(body, max) {
  if (body.length <= max + 200) return [body];
  const out = []; let cur = '';
  for (const line of body.split('\n')) {
    if (cur && (cur.length + line.length + 1) > max) { out.push(cur.trim()); cur = ''; }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

class Knowledge {
  constructor(dirs) { this.dirs = dirs; this.sections = []; }

  load() {
    this.sections = [];
    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const parts = text.split(/\n(?=#{1,3} )/);
        for (const p of parts) {
          const title = (p.match(/^#{1,3} (.*)/) || [null, path.basename(f, '.md')])[1].trim();
          const body = p.replace(/^#{1,3} .*\n?/, '').trim();
          if (!body) continue;
          // long sections are split at line boundaries so the search never truncates the tail of a note
          const chunks = splitLong(body, 1600);
          chunks.forEach((c, i) => { const t = chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title; this.sections.push({ file: f, title: t, body: c, _n: norm(t + ' ' + c) }); });
        }
      }
    }
    return this;
  }

  search(query, { limit = 4, maxChars = 1800, perVideo = 2 } = {}) {
    // light Spanish/English stemming so "catafractas" finds "catafracta", "jinetes" finds "jinete"
    const stem = (w) => { if (w.length > 6 && /(ciones|siones)$/.test(w)) return w.slice(0, -2); if (w.length > 5 && /es$/.test(w) && !/[aeiou]es$/.test(w)) return w.slice(0, -2); if (w.length > 4 && /s$/.test(w)) return w.slice(0, -1); return w; };
    const nq = norm(query);
    const raw = [...new Set(nq.split(/[^a-z0-9@]+/).filter(t => t.length > 2 && !STOP.has(t)))];
    if (!raw.length) return [];
    // each query word becomes a group of alternatives: its stem plus every alias spelling (ES/EN); a section scores the best alternative
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const groups = raw.map(t => { const alts = new Set([stem(t)]); for (const a of (ALIAS.get(t) || [])) alts.add(a); return [...alts].map(a => [new RegExp('(^|[^a-z0-9])' + esc(a)), new RegExp('(^|[^a-z0-9])' + esc(a), 'g')]); });
    // meme/cheese notes rank lower unless the player asks for memes, cheese, surprises or how to stop one
    const wantsMeme = /meme|cheese|troll|poop|break the meta|anti ?meta|fuera de( la)? meta|off[- ]?meta|loc[oa]s?\b|raro|sorpres|trampa|divertid|fun\b/.test(nq);
    const scored = this.sections.map(s => {
      let score = 0;
      const nt = s._t || (s._t = norm(s.title));
      for (const alts of groups) {
        let best = 0;
        for (const [r1, rg] of alts) { const v = (r1.test(nt) ? 5 : 0) + Math.min((s._n.match(rg) || []).length, 5); if (v > best) best = v; }
        score += best;
      }
      const tier = s._tier || (s._tier = tierOf(s.file));
      if (!wantsMeme && tier === 'meme') score *= 0.6; else if (!wantsMeme && tier === 'anti-meta') score *= 0.8;
      return { s, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    // diversity: at most `perVideo` chunks of the same note (same file + same title stem before ": lecciones" / ": VIGENCIA")
    const out = []; const seen = new Map();
    for (const x of scored) {
      const key = x.s.file + '|' + x.s.title.replace(/: (lecciones|VIGENCIA hoy).*$/, '').replace(/ \(\d+\/\d+\)$/, '');
      const n = seen.get(key) || 0; if (n >= perVideo) continue; seen.set(key, n + 1);
      out.push(x); if (out.length >= limit) break;
    }
    return out.map(({ s, score }) => ({ file: s.file, title: s.title, score, tier: s._tier, text: s.body.length > maxChars ? s.body.slice(0, maxChars) + ' …' : s.body }));
  }

  titles() { return this.sections.map(s => `${s.file}: ${s.title}`); }
}

module.exports = { Knowledge, tierOf, ALIAS_GROUPS };
