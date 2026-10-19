'use strict';
/** In-memory stand-in for Node's `fs` in the web build. Files come from data/bundle.json (fetched once) plus user files in localStorage. */
const files = new Map();
const norm = (p) => '/' + String(p).replace(/\\/g, '/').split('/').filter(Boolean).join('/');
function load(map) { for (const [k, v] of Object.entries(map)) files.set(norm(k), v); }
function isDir(p) { const d = norm(p) + '/'; for (const k of files.keys()) if (k.startsWith(d)) return true; return false; }
const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
module.exports = {
  _load: load, _files: files,
  existsSync: (p) => files.has(norm(p)) || isDir(p),
  readFileSync: (p) => { const k = norm(p); if (!files.has(k)) throw enoent(p); return files.get(k); },
  readdirSync: (p) => { const d = norm(p) + '/'; const out = new Set(); for (const k of files.keys()) if (k.startsWith(d)) out.add(k.slice(d.length).split('/')[0]); if (!out.size && !isDir(p)) throw enoent(p); return [...out]; },
  writeFileSync: (p, data) => { files.set(norm(p), String(data)); try { if (norm(p).startsWith('/user/')) { const u = JSON.parse(localStorage.getItem('sp.userFiles') || '{}'); u[norm(p)] = String(data); localStorage.setItem('sp.userFiles', JSON.stringify(u)); } } catch { /* storage full or blocked */ } },
  mkdirSync: () => {}, unlinkSync: (p) => { files.delete(norm(p)); },
  statSync: (p) => ({ isDirectory: () => isDir(p), isFile: () => files.has(norm(p)), mtimeMs: 0, size: (files.get(norm(p)) || '').length }),
  promises: {},
};
