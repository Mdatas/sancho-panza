'use strict';
/**
 * Build-order catalog for the Build orders tab: the structured, step-by-step builds (rtsbuilds + imports) plus every build/strategy
 * that lives in the video notes (Hera, El Biry, TaToH, Break the Meta, Poop Lord…), one entry per video, with friendly titles and filters.
 */
const TYPES = [
  ['Scouts', /\bscouts?\b|explorador|caballer[ií]a ligera|light cav/i],
  ['Arqueros', /\barcher|arquer|\bxbow|ballester|skirm|guerriller/i],
  ['Hombres de armas', /men[- ]at[- ]arms|man[- ]at[- ]arms|\bmaa\b|hombres? de armas|\bmilicia\b|militia|long ?sword|espadach/i],
  ['Drush', /\bdrush\b|dark age rush|rush de milicia|militia rush/i],
  ['Fast Castle', /fast castle|\bfc\b|castillos r[aá]pido|castle age r[aá]pid|10 minute castle/i],
  ['Caballeros', /\bknights?\b|caballeros?\b|cavalier|paladin|step lancer|lancero estepario|steppe lancer/i],
  ['Torres', /tower rush|\btrush\b|torres?\b|towers?\b|donjon/i],
  ['TC drop', /tc drop|town center drop|drop de tc|centro urbano adelantado|persian douche|\bdouche\b/i],
  ['Castle drop', /castle drop|castillo adelantado|krepost|fortified church/i],
  ['Monjes', /\bmonks?\b|monjes?\b|missionar|misioner/i],
  ['Elefantes', /elephant|elefante/i],
  ['Agua', /galley|galera|longboat|longship|fire ship|cannon galleon|naval|\bdock\b|muelle|islands?|islas/i],
  ['Aldeanos', /vill(ager)? rush|rush de aldeanos|aldeanos? (que )?pelean|villager fight/i],
  ['Boom', /\bboom\b|\b3 tc\b|tres tc|fast imp|imperial r[aá]pido/i],
  ['Asedio', /\brams?\b|ariete|scorpion|escorpi|mangonel|onagro|petard|siege/i],
];
const SOURCE_FILES = [
  [/^hera_builds/, 'Hera'],
  [/^hera_guia_2k/, 'Hera'],
  [/^hera_nuevos/, 'Hera'],
  [/^elbiry_curso/, 'El Biry'],
  [/^tatoh_/, 'TaToH'],
  [/^break_the_meta/, 'Break the Meta'],
  [/^poop_lord_/, 'Poop Lord'],
  [/^builds_pros_referencia/, 'Pros'],
  [/^respuestas_a_aperturas/, 'Respuestas'],
];
const tierOfFile = (f) => (/^poop_lord_/.test(f) ? 'meme' : /^break_the_meta/.test(f) ? 'anti-meta' : 'meta');
const fs = require('fs');
const path = require('path');
/** data/knowledge/resumen_guias.json: per-note "en la partida" summary + the id of the step-by-step build extracted from it (tools/condense.js). */
function loadCondensed(knowledge) {
  const out = {};
  for (const dir of knowledge.dirs || []) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'resumen_guias.json'), 'utf8'));
      Object.assign(out, j);
    } catch {
      /* none in this dir */
    }
  }
  return out;
}
const BUILDY = /\b\d{1,2}\s*(pop|aldeanos|vills?)\b|\bbuild\b|apertura|\brush\b|fast castle|\bfc\b|drush|scouts|arquer|archer|castle drop|tc drop|boom/i;

function typesOf(text) {
  return TYPES.filter(([, re]) => re.test(text)).map(([t]) => t);
}

/** "Poop Lord (meme) EU123 — New Khmer House Rush! (video publicado 2022-05-27)" → { title, date, code } */
function cleanTitle(stem) {
  let t = stem;
  const date = (t.match(/video publicado (\d{4}-\d{2}-\d{2})/) || t.match(/\((20\d\d)(?:-\d\d){0,2}\)/) || [])[1] || '';
  t = t.replace(/\s*\(video publicado [^)]*\)/, '');
  const code = (t.match(/\b([A-Z]{1,2}\d{2,3}|N[56]\d{2})\b/) || [])[1] || '';
  t = t
    .replace(/^(Poop Lord \([^)]*\)|Break the Meta \([^)]*\)|Break the Meta|El Biry|Hera \(\d{4}\)|TaToH[^—:]*)\s*/, '')
    .replace(/^[A-Z]{1,2}\d{2,3}\s+—\s+|^N[56]\d{2}\s+—\s+/, '');
  t = t
    .replace(/^Aoe2:?\s*"?Break the Meta"?\s*#?\d*:?\s*/i, '')
    .replace(/^Book of Memes Strategy Guide:\s*/i, '')
    .replace(/^Build:\s*/i, '')
    .replace(/^Build de principiante:\s*/i, '');
  t = t.replace(/^[:\s—-]+/, '').replace(/^Build( de principiante)?:\s*/i, '');
  t = t
    .replace(/\s*\[[A-Z]{2,4}\]\s*https?:\/\/\S+/g, '') // "Scouts: 21 pop [CIC] https://…" (reference builds)
    .replace(/^\d{1,2}\.\s+/, '');
  t = t
    .replace(/\s*\|\s*AoE2.*$/i, '')
    .replace(/[!?]{2,}/g, '!')
    .trim();
  return { title: t.charAt(0).toUpperCase() + t.slice(1), date, code };
}

function noteEntries(knowledge, gdCivNames = [], condensed = {}) {
  const groups = new Map();
  for (const s of knowledge.sections || []) {
    const src = SOURCE_FILES.find(([re]) => re.test(s.file));
    if (!src) continue;
    const stem = s.title.replace(/: (lecciones|VIGENCIA hoy).*$/, '').replace(/ \(\d+\/\d+\)$/, '');
    const key = s.file + '|' + stem;
    if (!groups.has(key)) groups.set(key, { file: s.file, stem, author: src[1], text: '', civTag: '' });
    const g = groups.get(key);
    g.text += '\n' + s.body;
    const tag = s.title.split(' — ').slice(-1)[0] || '';
    if (!g.civTag && / — /.test(s.title) && !/\(video publicado/.test(tag)) g.civTag = tag;
  }
  const out = [];
  for (const g of groups.values()) {
    const hay = g.stem + ' ' + g.text;
    if (!BUILDY.test(hay)) continue;
    const { title, date, code } = cleanTitle(g.stem);
    const civs = g.civTag
      ? g.civTag.split(', ').filter(Boolean).slice(0, 4)
      : gdCivNames.filter((n) => new RegExp('\\b' + n + '\\b', 'i').test(g.stem)).slice(0, 3);
    out.push({
      kind: 'note',
      id: 'note:' + g.file + '|' + g.stem,
      title,
      author: g.author,
      date,
      code,
      civs,
      types: (() => {
        const tt = typesOf(g.stem);
        return tt.length ? tt : typesOf(g.text.slice(0, 700)).slice(0, 3);
      })(),
      tier: tierOfFile(g.file),
      file: g.file,
      stem: g.stem,
      hasVigencia: /VIGENCIA/.test(g.text),
      pasos: (condensed[g.file + '|' + g.stem] || {}).pasos || null,
      gist: !!(condensed[g.file + '|' + g.stem] || {}).resumen,
    });
  }
  return out;
}

function structuredEntries(buildOrders) {
  return (buildOrders.list || []).map((bo) => {
    const notes = (bo.build_order || [])
      .slice(0, 12)
      .map((s) => (s.notes || []).join(' '))
      .join(' ');
    const lastAge = Math.max(...(bo.build_order || []).map((s) => Number(s.age) || 1));
    const pop = (bo.build_order || []).find((s) => Number(s.age) === 2);
    return {
      kind: 'steps',
      id: bo._id,
      title: bo.name,
      author: bo.author || '',
      date: '',
      civs: bo._civs || ['Any'],
      types: (() => {
        const tt = typesOf(bo.name);
        return tt.length ? tt : typesOf(notes).slice(0, 2);
      })(),
      tier: (bo.extracted_from && bo.extracted_from.tier) || 'meta',
      steps: (bo.build_order || []).length,
      upTo: lastAge,
      feudalPop: pop ? pop.villager_count : null,
      source: bo.source || '',
      extracted: !!bo.extracted_from,
      fromNote: bo.extracted_from ? bo.extracted_from.file + '|' + bo.extracted_from.stem : '',
    };
  });
}

function catalog({ buildOrders, knowledge, gd }) {
  const civNames = gd
    ? Object.values(gd.civs)
        .flatMap((c) => [c.name_en, c.name_es])
        .filter(Boolean)
    : [];
  const condensed = loadCondensed(knowledge);
  const steps = structuredEntries(buildOrders);
  const notes = noteEntries(knowledge, civNames, condensed);
  const types = TYPES.map(([t]) => t).filter((t) => steps.some((e) => e.types.includes(t)) || notes.some((e) => e.types.includes(t)));
  return { steps, notes, types, counts: { steps: steps.length, notes: notes.length } };
}

/** Full text of one note-build (all its chunks: VIGENCIA first, then lessons in order). */
function noteText(knowledge, file, stem) {
  const secs = (knowledge.sections || []).filter(
    (s) => s.file === file && s.title.replace(/: (lecciones|VIGENCIA hoy).*$/, '').replace(/ \(\d+\/\d+\)$/, '') === stem
  );
  const vig = secs.filter((s) => /VIGENCIA hoy/.test(s.title)),
    les = secs.filter((s) => !/VIGENCIA hoy/.test(s.title));
  const c = loadCondensed(knowledge)[file + '|' + stem] || {};
  return {
    title: cleanTitle(stem).title,
    lessons: les.map((s) => s.body).join('\n'),
    vigencia: vig.map((s) => s.body).join('\n'),
    resumen: c.resumen || null,
    pasos: c.pasos || null,
  };
}

module.exports = { catalog, noteText, cleanTitle, typesOf };
