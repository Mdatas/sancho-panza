'use strict';
/** Data views for the visual guide window (civs, maps, meta table, notes search). Pure functions, no Electron. */
const fs = require('fs');
const path = require('path');
const { civSummary } = require('./engine/civs');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Parse the first markdown table of the civ win-rate section: [{civ, wr, err, elo, games, pick, tier}] */
function parseCivStats(knowledgeDirs) {
  for (const dir of knowledgeDirs) {
    const f = path.join(dir, 'stats_civs_parche185872.md');
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const start = text.indexOf('## 1.');
    const end = text.indexOf('\n## 2.');
    const block = text.slice(start < 0 ? 0 : start, end < 0 ? undefined : end);
    const rows = [];
    for (const line of block.split('\n')) {
      const c = line.split('|').map(x => x.trim());
      if (c.length < 9 || !/^\d+$/.test(c[1])) continue;
      rows.push({ rank: +c[1], civ: c[2], wr: parseFloat(c[3]), err: parseFloat(c[4]), elo: parseInt(c[5], 10), games: parseInt(String(c[6]).replace(/,/g, ''), 10), pick: parseFloat(c[7]), tier: c[8] });
    }
    const sample = (block.match(/Sample:\s*([\d,]+)/) || [])[1] || '';
    return { rows, sample, source: 'ageofnotes.com · parche 185872 · 1v1 mapa aleatorio · todos los ELO' };
  }
  return { rows: [], sample: '', source: '' };
}

function index({ gd, strategy }) {
  const civs = Object.values(gd.civs).map(c => {
    const p = strategy.civ(c.key);
    return { key: c.key, name_en: c.name_en, name_es: c.name_es, style: p ? p.meta.style || '' : '', bestAges: p && Array.isArray(p.meta.best_ages) ? p.meta.best_ages.map(Number) : [], derived: !!(p && p.meta.derived === true) };
  }).sort((a, b) => a.name_es.localeCompare(b.name_es, 'es'));
  const maps = Object.entries(strategy.maps).map(([key, m]) => ({ key, name: m.meta.map || m.title, type: m.meta.type || '', aliases: Array.isArray(m.meta.aliases) ? m.meta.aliases : [] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const units = [...new Set(Object.values(gd.units).filter(u => u.name_en && u.attack > 0 && u.line && u.line.length).map(u => u.name_en))].sort();
  return { civs, maps, units, ages: ['Dark', 'Feudal', 'Castle', 'Imperial'] };
}

function civView({ gd, strategy, key, stats }) {
  const civ = gd.findCiv(key); if (!civ) return null;
  const p = strategy.civ(civ.key);
  const sum = civSummary(gd, civ, 'es');
  // best unit of each line, grouped by building
  const bestOfLine = new Map();
  for (const u of gd.militaryUnitsFor(civ.key, 4)) {
    const k = u.line[0]; const cur = bestOfLine.get(k);
    if (!cur || (u.age || 0) > (cur.age || 0) || (u.age === cur.age && u.id > cur.id)) bestOfLine.set(k, u);
  }
  const groups = {};
  for (const u of bestOfLine.values()) (groups[u.buildingName] = groups[u.buildingName] || []).push({ name: u.name_es || u.name_en, en: u.name_en, age: (u.ageByCiv && u.ageByCiv[civ.key]) || u.age || 0 });
  for (const g of Object.values(groups)) g.sort((a, b) => a.age - b.age);
  const st = stats && stats.rows.find(r => norm(r.civ) === norm(civ.name_en));
  return {
    key: civ.key, name_en: civ.name_en, name_es: civ.name_es, trait: civ.trait,
    style: p ? p.meta.style || '' : '', bestAges: p && Array.isArray(p.meta.best_ages) ? p.meta.best_ages.map(Number) : [], derived: !!(p && p.meta.derived === true),
    sections: p ? p.order.map(n => ({ name: n, text: p.sections[n] })).filter(s => s.text) : [],
    lineup: groups, missingUnits: sum.missingKeyUnits, missingTechs: sum.missingKeyTechs,
    blacksmith: sum.fullBlacksmith, bonuses: sum.bonuses, teamBonus: sum.teamBonus, stats: st || null,
  };
}

function mapView({ strategy, key }) {
  const m = strategy.findMap(key); if (!m) return null;
  return { key: m.meta.map || m.title, name: m.meta.map || m.title, type: m.meta.type || '', aliases: m.meta.aliases || [], sections: m.order.map(n => ({ name: n, text: m.sections[n] })).filter(s => s.text) };
}

function searchNotes({ knowledge, q, limit = 8 }) {
  if (!q || !q.trim()) return [];
  return knowledge.search(q, { limit, maxChars: 2500 });
}

function listNotes({ knowledge }) {
  const byFile = {};
  for (const s of knowledge.sections) (byFile[s.file] = byFile[s.file] || []).push(s.title);
  return byFile;
}

function noteText({ knowledge, file, title }) {
  const s = knowledge.sections.find(x => x.file === file && x.title === title);
  return s ? s.body : '';
}

module.exports = { parseCivStats, index, civView, mapView, searchNotes, listNotes, noteText, norm };
