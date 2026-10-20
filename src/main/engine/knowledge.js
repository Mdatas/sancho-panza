'use strict';
/**
 * Strategy knowledge base: markdown files split into sections and searched with an inverted index (BM25).
 * Bundled notes live in <data>/knowledge; the user can drop their own .md files into <userData>/knowledge.
 *
 * Retrieval: every section is tokenised once at load (lower-case, accents stripped, light Spanish/English stemming,
 * bilingual alias groups folded into one canonical term, multi-word aliases such as "hombres de armas" / "town center"
 * folded first). A query goes through the same pipeline, so "malienses contra arqueros" and "malians vs archers" hit the
 * same postings. Scoring = BM25 over the section text + a bonus per query term found in the title; meme / anti-meta notes
 * rank lower unless the player asks for them; at most `perVideo` chunks of one note are returned (diversity).
 */
const fs = require('fs');
const path = require('path');

const STOP = new Set(
  'tan tanto bueno buena buenos buenas good how are the is what and vale pena cuanto cuánto cuanta mejor peor sirve sirven conviene debo deberia debería puedo que qué hago hacer como cómo contra para con por los las del una uno unos unas este esta esto ese esa eso pero mas más muy sin sobre tengo tiene tienen estoy esta están mi mis su sus le les lo me se nos vos sos soy son era fue hay ahora cuando donde dónde cual cuál cuales the and for with what how should this that from have has are you your vs against make makes doing does'.split(
    ' '
  )
);
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Spelling/translation groups: every spelling in a group is indexed and searched as the same canonical term.
const ALIAS_GROUPS = [
  ['dravidas', 'dravidianos', 'dravidians', 'dravidian'],
  ['indostanies', 'hindustanis', 'hindustani', 'indostani', 'indios', 'indians'],
  ['malies', 'malienses', 'malians', 'malian', 'mali'],
  ['khmer', 'jemeres', 'jemer', 'camboyanos'],
  ['tupies', 'tupi', 'tupis'],
  ['khitanos', 'khitans', 'khitan', 'kitan'],
  ['jurchens', 'jurchen', 'yurchen', 'yurchenes'],
  ['varegos', 'varangians', 'varangian', 'varangios', 'varego'],
  ['sajones', 'saxons', 'saxon', 'sajon'],
  ['mapuches', 'mapuche'],
  ['muiscas', 'muisca'],
  ['magiares', 'magyars', 'magyar', 'hungaros'],
  ['bizantinos', 'byzantines', 'byzantine', 'bizantino'],
  ['bulgaros', 'bulgarians', 'bulgarian', 'bulgaro'],
  ['francos', 'franks', 'frank', 'franco'],
  ['britanos', 'britons', 'briton', 'britano', 'britanicos'],
  ['bereberes', 'berbers', 'berber', 'berebere'],
  ['bohemios', 'bohemians', 'bohemian', 'bohemio'],
  ['borgonones', 'borgoneses', 'burgundians', 'burgundian', 'borgonon'],
  ['birmanos', 'burmese', 'birmano'],
  ['celtas', 'celts', 'celt', 'celta'],
  ['chinos', 'chinese', 'chino'],
  ['cumanos', 'cumans', 'cuman', 'cumano'],
  ['etiopes', 'ethiopians', 'ethiopian', 'etiope'],
  ['godos', 'goths', 'goth', 'godo'],
  ['hunos', 'huns', 'hun', 'huno'],
  ['incas', 'inca', 'incaicos'],
  ['italianos', 'italians', 'italian', 'italiano'],
  ['japoneses', 'japanese', 'japones'],
  ['coreanos', 'koreans', 'korean', 'coreano'],
  ['lituanos', 'lithuanians', 'lithuanian', 'lituano'],
  ['malayos', 'malay', 'malays', 'malayo'],
  ['mayas', 'mayans', 'maya', 'mayan'],
  ['mongoles', 'mongols', 'mongol'],
  ['persas', 'persians', 'persian', 'persa'],
  ['polacos', 'poles', 'polish', 'polaco'],
  ['portugueses', 'portuguese', 'portugues'],
  ['sarracenos', 'saracens', 'saracen', 'sarraceno'],
  ['sicilianos', 'sicilians', 'sicilian', 'siciliano'],
  ['eslavos', 'slavs', 'slav', 'eslavo'],
  ['espanoles', 'spanish', 'espanol'],
  ['tartaros', 'tatars', 'tatar', 'tartaro'],
  ['teutones', 'teutons', 'teuton', 'teutonicos'],
  ['turcos', 'turks', 'turk', 'turco', 'otomanos'],
  ['vietnamitas', 'vietnamese', 'vietnamita'],
  ['vikingos', 'vikings', 'viking', 'vikingo'],
  ['georgianos', 'georgians', 'georgian', 'georgiano'],
  ['armenios', 'armenians', 'armenian', 'armenio'],
  ['romanos', 'romans', 'roman', 'romano'],
  ['daneses', 'danes', 'danish'],
  ['gurjaras', 'gurjara'],
  ['bengalies', 'bengalis', 'bengali'],
  ['aztecas', 'aztecs', 'aztec', 'azteca'],
  // units / buildings commonly asked in either language
  ['caballero', 'caballeros', 'knight', 'knights'],
  ['arquero', 'arqueros', 'archer', 'archers'],
  ['ballestero', 'ballesteros', 'crossbow', 'crossbowman', 'crossbowmen', 'xbow', 'xbows'],
  ['guerrillero', 'guerrilleros', 'skirmisher', 'skirmishers', 'skirm', 'skirms'],
  ['piquero', 'piqueros', 'lancero', 'lanceros', 'spearman', 'spearmen', 'spear', 'spears', 'pikeman', 'pikemen', 'pike', 'pikes'],
  ['alabardero', 'alabarderos', 'halberdier', 'halberdiers', 'halb', 'halbs'],
  ['camello', 'camellos', 'camel', 'camels'],
  ['explorador', 'exploradores', 'scout', 'scouts'],
  ['hombres de armas', 'hombre de armas', 'maa', 'man-at-arms', 'men-at-arms', 'milicia', 'militia'],
  ['monje', 'monjes', 'monk', 'monks'],
  ['mangonel', 'mangoneles', 'mangonels', 'onagro', 'onagros', 'onager', 'onagers'],
  ['ariete', 'arietes', 'ram', 'rams'],
  ['escorpion', 'escorpiones', 'scorpion', 'scorpions'],
  ['trebuchet', 'trebuchets', 'fundibulo', 'fundibulos', 'treb', 'trebs'],
  ['aguila', 'aguilas', 'eagle', 'eagles'],
  ['husar', 'husares', 'hussar', 'hussars', 'caballeria ligera', 'light cav', 'light cavalry'],
  ['paladin', 'paladines', 'paladins'],
  ['torre', 'torres', 'tower', 'towers', 'trush'],
  ['castillo', 'castillos', 'castle', 'castles'],
  ['muralla', 'murallas', 'muro', 'muros', 'wall', 'walls', 'walling', 'empalizada', 'palisade'],
  ['centro urbano', 'tc', 'town center', 'town centre'],
  ['aldeano', 'aldeanos', 'villager', 'villagers', 'vill', 'vills', 'aldea'],
  ['ciervo', 'ciervos', 'deer'],
  ['jabali', 'jabalies', 'boar', 'boars'],
  ['oveja', 'ovejas', 'sheep'],
  ['granja', 'granjas', 'farm', 'farms'],
  ['oro', 'gold'],
  ['madera', 'wood'],
  ['comida', 'food'],
  ['piedra', 'stone'],
  ['feudal', 'feudal age'],
  ['castillos', 'castle age'],
  ['imperial', 'imperial age'],
  ['oscura', 'dark age', 'drush'],
  ['apertura', 'aperturas', 'opening', 'openings', 'build', 'build order', 'bo'],
  ['contra', 'counter', 'counters', 'vs', 'contrarrestar', 'frenar', 'parar', 'defender', 'defensa', 'defend', 'stop'],
];
const CANON = new Map(); // normalised spelling → canonical term of its group
const PHRASES = []; // multi-word spellings, longest first, folded before tokenising
for (const g of ALIAS_GROUPS) {
  const canon = '_' + norm(g[0]).replace(/[^a-z0-9]+/g, '_');
  for (const w of g) {
    const k = norm(w);
    if (!CANON.has(k)) CANON.set(k, canon);
    if (/\s|-/.test(k)) PHRASES.push(k);
  }
}
PHRASES.sort((a, b) => b.length - a.length);
const PHRASE_RE = PHRASES.length
  ? new RegExp(
      '(^|[^a-z0-9])(' + PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+')).join('|') + ')(?=$|[^a-z0-9])',
      'g'
    )
  : null;

/** light Spanish/English stemming so "catafractas" finds "catafracta", "jinetes" finds "jinete" */
function stem(w) {
  if (w.length > 6 && /(ciones|siones)$/.test(w)) return w.slice(0, -2);
  if (w.length > 5 && /es$/.test(w) && !/[aeiou]es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && /s$/.test(w)) return w.slice(0, -1);
  return w;
}
/** Text → canonical terms (stop words removed, aliases folded, the rest stemmed). */
function terms(text) {
  let t = norm(text);
  if (PHRASE_RE) t = t.replace(PHRASE_RE, (m, pre, ph) => pre + (CANON.get(ph.replace(/[\s-]+/g, ' ')) || CANON.get(ph) || ph.replace(/[\s-]+/g, '_')));
  const out = [];
  for (const w of t.split(/[^a-z0-9@_]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.push(CANON.get(w) || (w.startsWith('_') ? w : stem(w)));
  }
  return out;
}

/** Files whose notes are off-meta; they rank lower unless the player asks for a meme/cheese or how to stop one. */
const TIER_FILE = [
  [/^poop_lord_/, 'meme'],
  [/^break_the_meta/, 'anti-meta'],
];
function tierOf(file) {
  for (const [re, t] of TIER_FILE) if (re.test(file)) return t;
  return 'meta';
}

const SECTION_MAX = 1600; // longer sections are split at line boundaries so the search never truncates the tail of a note
const BM25_K1 = 1.2,
  BM25_B = 0.75,
  TITLE_BONUS = 2.2;

function splitLong(body, max) {
  if (body.length <= max + 200) return [body];
  const out = [];
  let cur = '';
  for (const line of body.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) {
      out.push(cur.trim());
      cur = '';
    }
    cur += (cur ? '\n' : '') + line;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

class Knowledge {
  constructor(dirs) {
    this.dirs = dirs;
    this.sections = [];
    this.index = null;
  }

  load() {
    this.sections = [];
    this.index = null;
    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const parts = text.split(/\n(?=#{1,3} )/);
        for (const p of parts) {
          const title = (p.match(/^#{1,3} (.*)/) || [null, path.basename(f, '.md')])[1].trim();
          const body = p.replace(/^#{1,3} .*\n?/, '').trim();
          if (!body) continue;
          const chunks = splitLong(body, SECTION_MAX);
          chunks.forEach((c, i) => {
            const t = chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title;
            this.sections.push({ file: f, title: t, body: c, _n: norm(t + ' ' + c), _tier: tierOf(f) });
          });
        }
      }
    }
    return this;
  }

  /** Inverted index, built on first use (≈3,000 sections → a few tens of ms) and dropped by load(). */
  _buildIndex() {
    const postings = new Map(); // term → Map(sectionIdx → tf)
    const titleTerms = []; // sectionIdx → Set(term)
    const len = new Float32Array(this.sections.length);
    let total = 0;
    this.sections.forEach((s, i) => {
      const tt = new Set(terms(s.title));
      titleTerms.push(tt);
      const body = terms(s.body);
      len[i] = body.length + tt.size;
      total += len[i];
      const seen = new Map();
      for (const t of body) seen.set(t, (seen.get(t) || 0) + 1);
      for (const t of tt) seen.set(t, (seen.get(t) || 0) + 1);
      for (const [t, tf] of seen) {
        let m = postings.get(t);
        if (!m) postings.set(t, (m = new Map()));
        m.set(i, tf);
      }
    });
    this.index = { postings, titleTerms, len, avgLen: total / Math.max(1, this.sections.length) };
    return this.index;
  }

  search(query, { limit = 4, maxChars = 1800, perVideo = 2 } = {}) {
    const q = [...new Set(terms(query))];
    if (!q.length || !this.sections.length) return [];
    const idx = this.index || this._buildIndex();
    const N = this.sections.length;
    const nq = norm(query);
    // meme/cheese notes rank lower unless the player asks for memes, cheese, surprises or how to stop one
    const wantsMeme = /meme|cheese|troll|poop|break the meta|anti ?meta|fuera de( la)? meta|off[- ]?meta|loc[oa]s?\b|raro|sorpres|trampa|divertid|fun\b/.test(
      nq
    );
    const scores = new Map();
    for (const t of q) {
      const post = idx.postings.get(t);
      if (!post) continue;
      const df = post.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [i, tf] of post) {
        const bm = idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * idx.len[i]) / idx.avgLen)));
        scores.set(i, (scores.get(i) || 0) + bm + (idx.titleTerms[i].has(t) ? TITLE_BONUS * idf : 0));
      }
    }
    const scored = [];
    for (const [i, sc] of scores) {
      const s = this.sections[i];
      let score = sc;
      if (!wantsMeme && s._tier === 'meme') score *= 0.6;
      else if (!wantsMeme && s._tier === 'anti-meta') score *= 0.8;
      scored.push({ s, score });
    }
    scored.sort((a, b) => b.score - a.score);
    // diversity: at most `perVideo` chunks of the same note (same file + same title stem before ": lecciones" / ": VIGENCIA")
    const out = [];
    const seen = new Map();
    for (const x of scored) {
      const key = x.s.file + '|' + x.s.title.replace(/: (lecciones|VIGENCIA hoy).*$/, '').replace(/ \(\d+\/\d+\)$/, '');
      const n = seen.get(key) || 0;
      if (n >= perVideo) continue;
      seen.set(key, n + 1);
      out.push(x);
      if (out.length >= limit) break;
    }
    return out.map(({ s, score }) => ({
      file: s.file,
      title: s.title,
      score: +score.toFixed(3),
      tier: s._tier,
      text: s.body.length > maxChars ? s.body.slice(0, maxChars) + ' …' : s.body,
    }));
  }

  titles() {
    return this.sections.map((s) => `${s.file}: ${s.title}`);
  }
}

module.exports = { Knowledge, tierOf, ALIAS_GROUPS, terms, SECTION_MAX };
