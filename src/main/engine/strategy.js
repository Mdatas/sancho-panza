'use strict';
/**
 * Strategy profiles: one markdown file per civ (data/knowledge/civs/<Civ>.md) and per map
 * (data/knowledge/maps/<Map>.md), with YAML-ish frontmatter and bold section headers ("**Identidad.** …").
 * User overrides/additions live in <userData>/knowledge/civs and /maps (same file names win).
 */
const fs = require('fs');
const path = require('path');

function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  if (!m) return { meta, body: text };
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z_]+):\s*(.*?)\s*(#.*)?$/); if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith('[')) v = v.slice(1, -1).split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else if (v === 'true' || v === 'false') v = v === 'true';
    else v = v.replace(/^["']|["']$/g, '');
    meta[mm[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Split a profile body into { title, sections: {name: text} } using "**Name.**" markers. */
function parseSections(body) {
  const title = (body.match(/^#\s+(.*)$/m) || [null, ''])[1].trim();
  const sections = {}; const order = [];
  const re = /\*\*([^*]+?)\.\*\*/g;
  let m, last = null, lastIdx = 0;
  while ((m = re.exec(body))) {
    if (last) sections[last] = body.slice(lastIdx, m.index).trim();
    last = m[1].trim(); order.push(last); lastIdx = m.index + m[0].length;
  }
  if (last) sections[last] = body.slice(lastIdx).trim();
  return { title, sections, order };
}

class Strategy {
  constructor(dirs) { this.dirs = dirs; this.civs = {}; this.maps = {}; }

  load() {
    this.civs = {}; this.maps = {};
    for (const root of this.dirs) {
      this._loadDir(path.join(root, 'civs'), this.civs, (meta, file) => meta.civ || path.basename(file, '.md'));
      this._loadDir(path.join(root, 'maps'), this.maps, (meta, file) => meta.map || path.basename(file, '.md'));
    }
    this.mapIndex = new Map();
    for (const [key, m] of Object.entries(this.maps)) {
      const names = [key, m.meta.map, ...(Array.isArray(m.meta.aliases) ? m.meta.aliases : [])].filter(Boolean);
      for (const n of names) this.mapIndex.set(norm(n), key);
    }
    return this;
  }
  _loadDir(dir, into, keyOf) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md'))) {
      try {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const { meta, body } = parseFrontmatter(text);
        const parsed = parseSections(body);
        into[keyOf(meta, f)] = { meta, body: body.trim(), file: path.join(dir, f), ...parsed };
      } catch (e) { console.warn('[strategy] bad profile', f, e.message); }
    }
  }

  civ(key) { return this.civs[key] || null; }
  findMap(query) {
    if (!query) return null;
    const q = norm(query);
    if (this.mapIndex.has(q)) return this.maps[this.mapIndex.get(q)];
    for (const [n, key] of this.mapIndex) if (n.startsWith(q) || q.startsWith(n)) return this.maps[key];
    for (const [n, key] of this.mapIndex) if (n.includes(q) || q.includes(n)) return this.maps[key];
    return null;
  }
  mapNames() { return Object.values(this.maps).map(m => m.meta.map || m.title).filter(Boolean); }

  /** Profile text limited to some sections (or all), trimmed to maxChars. */
  excerpt(profile, sectionNames = null, maxChars = 4000) {
    if (!profile) return '';
    const names = sectionNames || profile.order;
    const parts = [`# ${profile.title}`];
    for (const n of names) {
      const key = Object.keys(profile.sections).find(k => norm(k) === norm(n) || norm(k).startsWith(norm(n)));
      if (key && profile.sections[key]) parts.push(`**${key}.** ${profile.sections[key]}`);
    }
    let text = parts.join('\n');
    if (text.length > maxChars) text = text.slice(0, maxChars) + ' …';
    return text;
  }
}

// Sections shown for the OPPONENT's civ (what matters when playing against it)
const OPP_SECTIONS = ['Identidad', 'Fuerza por edad', 'Bonos clave', 'Unidad única', 'Lo que NO tiene', 'Jugando CONTRA esta civ'];

module.exports = { Strategy, parseFrontmatter, parseSections, OPP_SECTIONS };
