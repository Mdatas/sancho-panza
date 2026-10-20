#!/usr/bin/env node
'use strict';
/**
 * Condense every build/strategy note into (a) a short "en la partida" summary and (b) a structured step-by-step build when the
 * note contains one. Output: data/knowledge/resumen_guias.json (summaries) and data/build_orders/extracted/<slug>.json (builds,
 * rtsbuilds format + provenance). Nothing is invented: every step carries a quote from the note, and a build is kept only when
 * every quote is found verbatim in the note; the model is told to return null when the note has no explicit sequence.
 *
 *   SP_KEY=sk-ant-... node tools/condense.js [--limit N] [--only "regex on title"] [--model claude-sonnet-5-5] [--force]
 *
 * Idempotent: notes already condensed (same text hash) are skipped unless --force.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Knowledge } = require('../src/main/engine/knowledge');
const { BuildOrders, validate } = require('../src/main/engine/buildorders');
const { GameData } = require('../src/main/engine/gamedata');
const bocatalog = require('../src/main/bocatalog');
const { plainComplete, estimateCost } = require('../src/main/brain/providers');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT_SUM = path.join(DATA, 'knowledge', 'resumen_guias.json');
const OUT_DIR = path.join(DATA, 'build_orders', 'extracted');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const LIMIT = Number(opt('--limit', 0)) || 0;
const ONLY = opt('--only', '') ? new RegExp(opt('--only'), 'i') : null;
const MODEL = opt('--model', 'claude-sonnet-5-5');
const FORCE = args.includes('--force');
const KEY = process.env.SP_KEY;
if (!KEY) {
  console.error('SP_KEY (Anthropic API key) is required in the environment; it is never written anywhere.');
  process.exit(2);
}

const SYSTEM = `You condense Age of Empires II strategy notes (Spanish summaries of videos) for a player who reads them DURING a game.
Return ONLY a JSON object with:
"resumen": array of 3 to 6 strings in rioplatense Spanish (voseo), imperative, each at most 18 words: the actions and numbers that matter in the game. Use ONLY facts in the note. If the VIGENCIA block says something CHANGED, use TODAY's value and never the old one. No preamble, no source names.
"pasos": null, or — ONLY when the note itself gives an explicit build sequence with villager assignments (e.g. "6 a ovejas, 4 a madera, 1 jabalí…") — an object:
  { "name": short build name (Spanish), "civilization": English civ name or "Generic", "build_order": [ { "villager_count": total villagers at the end of the step (integer), "age": 1 Dark / 2 Feudal / 3 Castle / 4 Imperial, "resources": { "wood": n, "food": n, "gold": n, "stone": n } (villagers on each resource at that point; a villager building something counts on the resource he came from), "notes": [one or two short Spanish instructions], "time": "m:ss" only if the note states it, "evidencia": a verbatim quote (20-80 characters, copied exactly) from the note that supports this step } ] }
Rules for "pasos": every number must come from the note (a step-by-step list, a "BUILD:" line with villager assignments, or a table with W/F/G/S columns — in a table each row is a step and villager_count is the sum of the columns at that row). Deriving a total by adding the note's own numbers is fine; inventing an assignment the note does not state is not — then return "pasos": null. At least 3 steps, otherwise null. The quote in "evidencia" must be copied character by character from the note text (a table row or a phrase).`;

/** The model answers with a JSON object, sometimes inside a ```json fence or with a trailing comma: parse tolerantly. */
function parseJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1];
  const a = t.indexOf('{'),
    b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no object');
  t = t.slice(a, b + 1);
  try {
    return JSON.parse(t);
  } catch {
    return JSON.parse(t.replace(/,\s*([}\]])/g, '$1'));
  }
}

function slug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 70);
}
const normQ = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

async function main() {
  const kn = new Knowledge([path.join(DATA, 'knowledge')]).load();
  const bo = new BuildOrders([path.join(DATA, 'build_orders', 'rtsbuilds')]).load();
  const gd = new GameData(path.join(DATA, 'game')).load();
  const cat = bocatalog.catalog({ buildOrders: bo, knowledge: kn, gd });
  const civNames = Object.values(gd.civs).map((c) => c.name_en);
  let sums = {};
  try {
    sums = JSON.parse(fs.readFileSync(OUT_SUM, 'utf8'));
  } catch {
    sums = {};
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let notes = cat.notes.filter((n) => !ONLY || ONLY.test(n.title + ' ' + n.stem));
  // meta first (Hera, El Biry, TaToH, pros, responses), then anti-meta, then memes
  const rank = { meta: 0, 'anti-meta': 1, meme: 2 };
  notes.sort((a, b) => rank[a.tier] - rank[b.tier] || a.title.localeCompare(b.title));
  if (LIMIT) notes = notes.slice(0, LIMIT);
  let done = 0,
    skipped = 0,
    builds = 0,
    rejected = 0,
    cost = 0;
  for (const n of notes) {
    const key = n.file + '|' + n.stem;
    const t = bocatalog.noteText(kn, n.file, n.stem);
    const text = (t.lessons || '') + (t.vigencia ? '\n\nVIGENCIA (revisado contra el parche actual; manda sobre la lección):\n' + t.vigencia : '');
    const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
    if (!FORCE && sums[key] && sums[key].hash === hash) {
      skipped++;
      continue;
    }
    let r;
    try {
      r = await plainComplete('anthropic', {
        apiKey: KEY,
        model: MODEL,
        system: SYSTEM,
        user: `TITLE: ${n.title}\nAUTHOR: ${n.author}${n.date ? ' (' + n.date + ')' : ''}\nCIVS: ${n.civs.join(', ') || 'any'}\n\nNOTE:\n${text.slice(0, 14000)}`,
        maxTokens: 3000,
        timeoutMs: 120000,
      });
    } catch (e) {
      console.error('API error on', n.title, e.message);
      continue;
    }
    cost += r.cost || estimateCost(MODEL, r.usage) || 0;
    let j;
    try {
      j = parseJson(r.text);
    } catch (e) {
      console.error('bad JSON for', n.title, '→', e.message, '| raw:', r.text.slice(0, 300).replace(/\n/g, ' '));
      continue;
    }
    const resumen = Array.isArray(j.resumen) ? j.resumen.filter((x) => typeof x === 'string' && x.trim()).slice(0, 6) : [];
    if (!resumen.length) {
      console.error('no summary for', n.title, '| raw:', r.text.slice(0, 300).replace(/\n/g, ' '));
      continue;
    }
    const entry = {
      hash,
      resumen,
      title: n.title,
      author: n.author,
      date: n.date,
      tier: n.tier,
      pasos: null,
      model: MODEL,
      at: new Date().toISOString().slice(0, 10),
    };
    // step-by-step build: validate shape, verify every quote against the note, then store in rtsbuilds format
    if (j.pasos && typeof j.pasos === 'object' && Array.isArray(j.pasos.build_order) && j.pasos.build_order.length >= 3) {
      const textN = normQ(text);
      const quotesOk = j.pasos.build_order.every((s) => s.evidencia && String(s.evidencia).length >= 15 && textN.includes(normQ(s.evidencia)));
      const civ = civNames.includes(j.pasos.civilization) ? j.pasos.civilization : 'Generic';
      const build = {
        name: String(j.pasos.name || n.title).slice(0, 80),
        civilization: civ,
        author: n.author,
        source: (text.match(/https?:\/\/\S+/) || [''])[0].replace(/[.,)]+$/, ''),
        description: `Pasos extraídos por IA de la nota «${n.title}» (${n.author}${n.date ? ', ' + n.date : ''}); cada paso cita la frase de la nota que lo respalda. Tier: ${n.tier}.`,
        extracted_from: { file: n.file, stem: n.stem, tier: n.tier, date: n.date },
        build_order: j.pasos.build_order.map((s) => ({
          villager_count: Number(s.villager_count),
          age: Number(s.age),
          resources: {
            wood: Number((s.resources || {}).wood) || 0,
            food: Number((s.resources || {}).food) || 0,
            gold: Number((s.resources || {}).gold) || 0,
            stone: Number((s.resources || {}).stone) || 0,
          },
          notes: (Array.isArray(s.notes) ? s.notes : [String(s.notes || '')]).map(String).filter(Boolean),
          ...(s.time && /^\d+:\d\d$/.test(String(s.time)) ? { time: String(s.time) } : {}),
          evidencia: String(s.evidencia || ''),
        })),
      };
      const errs = validate(build);
      const monotone = build.build_order.every((s, i, a) => i === 0 || s.villager_count >= a[i - 1].villager_count - 1);
      if (quotesOk && !errs.length && monotone) {
        const id = 'x_' + slug(n.author + '_' + n.title);
        fs.writeFileSync(path.join(OUT_DIR, id + '.json'), JSON.stringify(build, null, 1));
        entry.pasos = id;
        builds++;
      } else {
        rejected++;
        console.error('build rejected for', n.title, quotesOk ? '' : '(quote not found)', errs.join('; '), monotone ? '' : '(villagers not monotone)');
      }
    }
    sums[key] = entry;
    done++;
    if (done % 10 === 0) fs.writeFileSync(OUT_SUM, JSON.stringify(sums, null, 1));
    console.log(`${done}/${notes.length} ${n.tier} · ${n.title.slice(0, 50)} · ${entry.pasos ? 'BUILD' : '—'} · $${cost.toFixed(3)}`);
  }
  fs.writeFileSync(OUT_SUM, JSON.stringify(sums, null, 1));
  console.log(`done ${done}, skipped ${skipped}, builds ${builds}, rejected ${rejected}, cost $${cost.toFixed(3)}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
