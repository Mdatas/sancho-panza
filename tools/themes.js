#!/usr/bin/env node
'use strict';
/**
 * Topic summaries: one markdown file per theme (data/knowledge/temas_<slug>.md) that condenses what ALL the guides say about it —
 * the essentials, how it is done, alternatives where the sources disagree, typical mistakes — every line citing its source.
 * Sources are the project's own notes (video summaries with VIGENCIA checks); the model is given the notes with a tag [S1]..[Sn]
 * and may only cite those tags; citations are verified and rewritten to "[Autor año]" before saving. Nothing else is accepted.
 *
 *   SP_KEY=sk-ant-... node tools/themes.js [--only "regex on 'name slug'"] [--model claude-sonnet-5-5] [--dry]
 *
 * ~US$0.11 per theme with Sonnet (the sources are ~25k input tokens). maxTokens is 16000 because the model's reasoning counts
 * against it: with 4000 the answers came back cut, so a truncated answer (stop=max_tokens) is never saved. The raw model output
 * goes to $SP_RAW_DIR (default: <tmp>/sancho-themes-raw) for review.
 */
const fs = require('fs');
const path = require('path');
const { Knowledge } = require('../src/main/engine/knowledge');
const { BuildOrders } = require('../src/main/engine/buildorders');
const { GameData } = require('../src/main/engine/gamedata');
const bocatalog = require('../src/main/bocatalog');
const { plainComplete, estimateCost } = require('../src/main/brain/providers');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const PATCH = String(require('../package.json').reviewedPatch);
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const ONLY = opt('--only', '') ? new RegExp(opt('--only'), 'i') : null;
const MODEL = opt('--model', 'claude-sonnet-5-5');
const DRY = args.includes('--dry');
const KEY = process.env.SP_KEY;
if (!KEY && !DRY) {
  console.error('SP_KEY (Anthropic API key) is required; it is never written anywhere.');
  process.exit(2);
}
const MAX_CHARS = 95000; // ≈ 25k tokens of sources per theme
const RAW_DIR = process.env.SP_RAW_DIR || path.join(require('os').tmpdir(), 'sancho-themes-raw'); // raw model output, for review

/** name, slug, catalog types that belong to the theme, search queries for the rest of the knowledge base */
const THEMES = [
  {
    name: 'Apertura de exploradores (scouts)',
    slug: 'scouts',
    types: ['Scouts'],
    q: ['scouts apertura exploradores feudal', 'scout rush defensa lanceros', 'exploradores caballería ligera feudal'],
  },
  {
    name: 'Apertura de arqueros',
    slug: 'arqueros',
    types: ['Arqueros'],
    q: ['arqueros apertura feudal 22 pop', 'archers fletching arquería guerrilleros', 'ballesteros castillos arqueros masa'],
  },
  {
    name: 'Hombres de armas y drush',
    slug: 'maa_drush',
    types: ['Hombres de armas', 'Drush'],
    q: ['hombres de armas men-at-arms apertura', 'drush milicia oscura', 'maa arqueros transición'],
  },
  {
    name: 'Fast Castle y boom',
    slug: 'fast_castle_boom',
    types: ['Fast Castle', 'Boom'],
    q: ['fast castle 27 pop castillos rápido', 'boom 3 TC aldeanos granjas', 'subir a castillos seguro muros'],
  },
  {
    name: 'Caballeros en Castillos',
    slug: 'caballeros',
    types: ['Caballeros'],
    q: ['caballeros castillos establos', 'knights raids aldeanos', 'caballeros vs piqueros camellos respuesta'],
  },
  {
    name: 'Torres (trush): hacerlo y frenarlo',
    slug: 'torres',
    types: ['Torres'],
    q: ['tower rush trush torres piedra', 'defensa torre rush aldeanos pelear', 'torres feudal donjon'],
  },
  {
    name: 'TC drop y castillo adelantado',
    slug: 'tc_castle_drop',
    types: ['TC drop', 'Castle drop'],
    q: ['castillo adelantado castle drop piedra', 'tc drop centro urbano adelantado douche', 'defensa castillo adelantado'],
  },
  {
    name: 'Monjes y reliquias',
    slug: 'monjes',
    types: ['Monjes'],
    q: ['monjes conversión reliquias monasterio', 'monjes contra caballeros', 'reliquias oro imperial'],
  },
  {
    name: 'Asedio: arietes, mangoneles, escorpiones',
    slug: 'asedio',
    types: ['Asedio'],
    q: ['arietes mangonel asedio castillos', 'mangonel contra arqueros micro', 'escorpiones onagros trebuchet'],
  },
  {
    name: 'Agua: muelles, galeras y mapas con islas',
    slug: 'agua',
    types: ['Agua'],
    q: ['agua galeras muelle islands', 'naval fire ship galley control', 'desembarco transporte islas'],
  },
  {
    name: 'Elefantes',
    slug: 'elefantes',
    types: ['Elefantes'],
    q: ['elefantes de guerra batalla', 'elefantes contra monjes alabarderos', 'elefantes arqueros ballista'],
  },
  {
    name: 'Rush de aldeanos y agresión en Oscura',
    slug: 'rush_aldeanos',
    types: ['Aldeanos'],
    q: ['rush de aldeanos pelear aldeanos', 'agresión edad oscura explorador matar aldeanos'],
  },
  {
    name: 'Economía de Edad Oscura',
    slug: 'eco_oscura',
    types: [],
    q: [
      'edad oscura ovejas jabalí bayas aldeanos orden',
      'dark age perfecta telar casas',
      'ciervos atraer jabalí molino',
      'tiempo ocioso TC aldeanos constantes',
    ],
  },
  {
    name: 'Defensa contra rushes y all-ins',
    slug: 'defensa_rush',
    types: [],
    q: [
      'defensa rush feudal respuesta apertura',
      'defender all-in castillo adelantado',
      'quick wall casas defensa aldeanos',
      'respuesta contra scouts arqueros maa',
    ],
  },
  {
    name: 'Muros, casas y colocación de edificios',
    slug: 'muros',
    types: [],
    q: ['murallas empalizada muros feudal', 'colocación edificios casas muro', 'amurallar arabia huecos bosque'],
  },
  {
    name: 'Exploración y lectura del rival',
    slug: 'scouting',
    types: [],
    q: ['explorar scouting leer rival', 'qué está haciendo el rival edificios', 'explorador ovejas ciervos recursos'],
  },
  {
    name: 'Composiciones y transiciones',
    slug: 'composiciones',
    types: [],
    q: ['composición oro trash asedio', 'transición arqueros caballeros', 'cambiar de unidad contrarrestar', 'mejoras herrería orden'],
  },
  {
    name: 'Arena, Hideout y mapas cerrados',
    slug: 'mapas_cerrados',
    types: [],
    q: ['arena fast castle monjes asedio', 'hideout muros boom', 'mapas cerrados castillo adelantado boom'],
  },
  {
    name: 'Nomad y mapas híbridos',
    slug: 'nomad_hibridos',
    types: [],
    q: ['nomad TC inicio muelle', 'mapas híbridos agua tierra', 'megarandom aleatorio adaptarse'],
  },
  {
    name: 'Partidas por equipos',
    slug: 'equipos',
    types: [],
    q: ['partida por equipos flank pocket', 'bonus de equipo civs equipo', 'team game caballeros arqueros roles', 'tratar compartir recursos aliado'],
  },
  {
    name: 'Imperial y late game',
    slug: 'late_game',
    types: [],
    q: ['imperial trash guerra oro se acaba', '200 pop late game composición', 'trebuchet asedio imperial castillos', 'mercado comercio imperial'],
  },
  {
    name: 'Micro, formaciones y control',
    slug: 'micro',
    types: [],
    q: ['micro formaciones grupos de control', 'kiting arqueros patrulla ataque', 'hotkeys ciclo macro micro'],
  },
  {
    name: 'Errores típicos por nivel de ELO',
    slug: 'errores_elo',
    types: [],
    q: ['errores típicos elo 1000 1200 1400', 'por qué pierdo mejorar elo', 'revisión partida errores aldeanos ociosos'],
  },
  {
    name: 'Fundamentos de macro y benchmarks',
    slug: 'macro',
    types: [],
    q: ['benchmarks minuto 10 aldeanos', 'macro producción constante aldeanos', 'tiempos feudal castillos referencia', 'granjas por TC regla'],
  },
];

const SYSTEM = `You write a topic summary for Age of Empires II players, in rioplatense Spanish (voseo), from the SOURCE NOTES provided (each tagged [S1], [S2]…; they are summaries of videos/guides, some with a VIGENCIA block that corrects old numbers against the current patch — when a VIGENCIA says something CHANGED, use today's value).
Output markdown with EXACTLY these five sections, each heading starting with "## " followed by the theme name, " — " and the section name:
## <theme> — Lo esencial
  5 to 8 bullets: what to do, with numbers, as a player would need it during a game.
## <theme> — Cómo se hace
  concrete sequence / benchmarks / villager numbers when the sources give them (bullets).
## <theme> — Variantes y alternativas
  where the sources recommend different things, present them as alternatives: "A: … [S3] · B: … [S7] — cuándo conviene cada una". Also the META / ANTI-META / MEME tier when a source says so.
## <theme> — Errores típicos
  bullets.
## <theme> — Contra
  how to stop / punish this (when the theme is a strategy) or what it loses to.
Rules: every bullet ends with its citation tags like [S3] or [S3][S9]; ONLY tags that exist in the sources; never add facts, numbers or opinions that are not in the sources; keep each bullet under 30 words; no introduction, no conclusion, no "Fuentes" section (it is added automatically). Prefer newer and patch-checked sources; when old and new disagree, say which is current.`;

/** Short source name for a knowledge file: "hera_coaching.md" → "Hera", "sotl_civs.md" → "SotL"… (+ year from the section title when present). */
const FILE_LABEL = [
  [/^hera_/, 'Hera'],
  [/^elbiry/, 'El Biry'],
  [/^tatoh/, 'TaToH'],
  [/^sotl/, 'SotL'],
  [/^break_the_meta/, 'Break the Meta'],
  [/^poop_lord/, 'Poop Lord'],
  [/^builds_pros/, 'Pros'],
  [/^respuestas_a_aperturas/, 'Respuestas'],
  [/^economy/, 'Economía'],
  [/^fundamentos/, 'Fundamentos'],
  [/^aoecoach/, 'aoecoach'],
  [/^aoe2matchup/, 'aoe2matchup'],
  [/^meta_y_tips/, 'Meta'],
  [/^parches/, 'Parches'],
  [/^alexander/, 'Alexander'],
  [/^lectura_y_scouting/, 'Scouting'],
  [/^counters_detallados/, 'Counters'],
  [/^estrategias_jugadores/, 'Jugadores'],
  [/^mapas_catalogo/, 'Mapas'],
  [/^stats_civs/, 'Stats'],
];
function labelFor(file, title) {
  const base = (FILE_LABEL.find(([re]) => re.test(file)) || [null, file.replace(/\.md$/, '')])[1];
  const year = (title.match(/\b(20\d\d)\b/) || [])[1];
  return `${base}${year ? ' ' + year : ''}: ${title}`;
}

function tagText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const kn = new Knowledge([path.join(DATA, 'knowledge')]).load();
  const bo = new BuildOrders([path.join(DATA, 'build_orders', 'rtsbuilds')]).load();
  const gd = new GameData(path.join(DATA, 'game')).load();
  const cat = bocatalog.catalog({ buildOrders: bo, knowledge: kn, gd });
  let condensed = {};
  try {
    condensed = JSON.parse(fs.readFileSync(path.join(DATA, 'knowledge', 'resumen_guias.json'), 'utf8'));
  } catch {
    condensed = {};
  }
  let cost = 0;
  for (const th of THEMES) {
    if (ONLY && !ONLY.test(th.name + ' ' + th.slug)) continue;
    // 1) sources: catalog notes of the theme's types (meta/anti-meta in full, memes condensed) + BM25 hits across the whole knowledge base
    const sources = [];
    const seen = new Set();
    const add = (label, text, tier) => {
      if (!text || seen.has(label)) return;
      seen.add(label);
      sources.push({ label, text: tagText(text), tier });
    };
    const notes = cat.notes.filter((n) => n.types.some((t) => th.types.includes(t)));
    const rank = { meta: 0, 'anti-meta': 1, meme: 2 };
    notes.sort((a, b) => rank[a.tier] - rank[b.tier] || String(b.date).localeCompare(String(a.date)));
    // (a) guides of the theme's types: meta/anti-meta in full (newest first, capped so the search hits below keep room), memes condensed
    const stemsAdded = new Set();
    for (const n of notes.filter((n) => n.tier !== 'meme').slice(0, 22)) {
      const t = bocatalog.noteText(kn, n.file, n.stem);
      const c = condensed[n.file + '|' + n.stem];
      const body =
        (c && c.resumen ? 'RESUMEN: ' + c.resumen.join(' ') + ' DETALLE: ' : '') +
        t.lessons.slice(0, 2600) +
        (t.vigencia ? ' VIGENCIA: ' + t.vigencia.slice(0, 1000) : '');
      add(`${n.author}${n.date ? ' ' + String(n.date).slice(0, 4) : ''}: ${n.title}`, body, n.tier);
      stemsAdded.add(n.file + '|' + n.stem);
    }
    for (const n of notes.filter((n) => n.tier === 'meme').slice(0, 10)) {
      const c = condensed[n.file + '|' + n.stem];
      const t = bocatalog.noteText(kn, n.file, n.stem);
      add(
        `${n.author}${n.date ? ' ' + String(n.date).slice(0, 4) : ''} (meme): ${n.title}`,
        c && c.resumen ? c.resumen.join(' ') : t.lessons.slice(0, 700),
        'meme'
      );
      stemsAdded.add(n.file + '|' + n.stem);
    }
    // (b) what the rest of the knowledge base says (coaching reviews, SotL, fundamentals, responses…): BM25 hits, memes excluded
    const hitLabels = new Set();
    for (const q of th.q) {
      for (const h of kn.search(q, { limit: 14, maxChars: 1800 })) {
        if (/^temas_/.test(h.file) || h.tier === 'meme') continue;
        const stem = h.file + '|' + h.title.replace(/: (lecciones|VIGENCIA hoy).*$/, '').replace(/ \(\d+\/\d+\)$/, '');
        if (stemsAdded.has(stem)) continue; // already in full from (a)
        const label = labelFor(h.file, h.title);
        hitLabels.add(label);
        add(label, h.text, h.tier);
      }
    }
    // budget: the guides may take at most ~55 % of it, so the broader notes always get in
    let total = 0;
    const kept = [];
    const guideCap = Math.round(MAX_CHARS * 0.55);
    let guideChars = 0;
    for (const s of sources) {
      const isGuide = !hitLabels.has(s.label);
      if (isGuide && guideChars + s.text.length > guideCap) continue;
      if (total + s.text.length > MAX_CHARS) continue;
      total += s.text.length;
      if (isGuide) guideChars += s.text.length;
      kept.push(s);
    }
    const tagged = kept.map((s, i) => ({ ...s, tag: `S${i + 1}` }));
    console.log(`\n== ${th.name}: ${tagged.length} sources (${Math.round(total / 1000)}k chars) · notes ${notes.length}`);
    if (DRY) continue;
    const user =
      `THEME: ${th.name}\nCURRENT PATCH: ${PATCH}\n\nSOURCE NOTES:\n` + tagged.map((s) => `[${s.tag}] (${s.tier}) ${s.label}\n${s.text}`).join('\n\n');
    let r;
    try {
      r = await plainComplete('anthropic', { apiKey: KEY, model: MODEL, system: SYSTEM, user, maxTokens: 16000, timeoutMs: 300000 });
    } catch (e) {
      console.error('API error', th.name, e.message);
      continue;
    }
    cost += r.cost || estimateCost(MODEL, r.usage) || 0;
    let md = String(r.text || '').trim();
    console.log(`   answer: ${md.length} chars · stop=${r.stop} · out tokens=${r.usage && r.usage.output_tokens}`);
    try {
      fs.mkdirSync(RAW_DIR, { recursive: true });
      fs.writeFileSync(path.join(RAW_DIR, `${th.slug}.txt`), md);
    } catch {
      /* no raw log */
    }
    // the model's reasoning tokens count against maxTokens: a cut answer would save a theme missing its last sections
    if (r.stop === 'max_tokens') {
      console.error(`truncated answer for ${th.name} (stop=max_tokens): not saved — raise maxTokens and run again with --only`);
      continue;
    }
    // normalise citation spellings the model sometimes uses: "[S3, S5]" / "[S3; S5]" / "(S3)" → "[S3][S5]"; "•" bullets → "- "
    md = md
      .replace(/\[(S\d+(?:\s*[,;/]\s*S\d+)+)\]/g, (m, inner) =>
        inner
          .split(/\s*[,;/]\s*/)
          .map((t) => `[${t}]`)
          .join('')
      )
      .replace(/\((S\d+)\)/g, '[$1]')
      .replace(/^\s*[•*]\s+/gm, '- ');
    // 2) verify citations: every [Sn] must exist; bullets without any valid tag are dropped
    const valid = new Set(tagged.map((s) => s.tag));
    const used = new Set();
    const lines = md.split('\n').filter((line) => {
      if (!/^\s*[-*•]\s/.test(line)) return true;
      const tags = [...line.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]);
      const ok = tags.filter((t) => valid.has(t));
      if (!ok.length) return false;
      ok.forEach((t) => used.add(t));
      return !tags.some((t) => !valid.has(t));
    });
    md = lines.join('\n');
    // 3) rewrite tags to short source names and append the sources list
    const short = (s) => s.label.split(':')[0].replace(/ \(meme\)$/, ' meme');
    for (const s of tagged) md = md.split(`[${s.tag}]`).join(`[${short(s)}]`);
    const fuentes = tagged.filter((s) => used.has(s.tag)).map((s) => `- ${s.label}${s.tier !== 'meta' ? ` (${s.tier})` : ''}`);
    const out =
      `# Tema: ${th.name}\n\n_Resumen por tema generado por IA a partir de ${fuentes.length} notas del proyecto (lista al final); cada línea cita su fuente; revisado contra el parche ${PATCH}. ` +
      `Cuando las fuentes recomiendan cosas distintas aparecen como alternativas._\n\n${md}\n\n## ${th.name} — Fuentes\n${fuentes.join('\n')}\n`;
    const file = path.join(DATA, 'knowledge', `temas_${th.slug}.md`);
    fs.writeFileSync(file, out);
    console.log(
      `saved ${path.relative(ROOT, file)} · ${lines.filter((l) => /^\s*[-*•]\s/.test(l)).length} bullets · ${fuentes.length} sources cited · $${cost.toFixed(3)}`
    );
  }
  console.log(`total cost $${cost.toFixed(3)}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
