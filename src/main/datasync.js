'use strict';
/**
 * Keeps the game dataset current: downloads data.json, locale strings and the 56 per-civ tree files
 * from the SiegeEngineers/aoe2techtree repository into <userData>/game-data when upstream changed.
 * Falls back to the bundled snapshot (shipped with the app) when offline.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RAW = 'https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/';
const FILES = { 'data.json': 'data/data.json', 'strings_en.json': 'data/locales/en/strings.json', 'strings_es.json': 'data/locales/es/strings.json' };

async function get(url, timeoutMs = 20000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'aoe2coach' } });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(t); }
}

function sha(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

function isComplete(dir) {
  return ['data.json', 'strings_en.json', 'strings_es.json'].every(f => fs.existsSync(path.join(dir, f)))
    && fs.existsSync(path.join(dir, 'trees')) && fs.readdirSync(path.join(dir, 'trees')).filter(f => f.endsWith('.json')).length >= 40;
}

/** Pick the best data dir: cache if complete, else bundled. */
function chooseDataDir(cacheDir, bundledDir) { return isComplete(cacheDir) ? cacheDir : bundledDir; }

/**
 * Sync if upstream data.json differs from what we have. Returns { updated, reason, dir }.
 * onProgress(msg) for UI status.
 */
async function sync({ cacheDir, bundledDir, onProgress = () => {} }) {
  const current = chooseDataDir(cacheDir, bundledDir);
  const have = fs.existsSync(path.join(current, 'data.json')) ? sha(fs.readFileSync(path.join(current, 'data.json'))) : null;
  onProgress('Checking aoe2techtree for a newer dataset…');
  const dataBuf = await get(RAW + FILES['data.json']);
  if (sha(dataBuf) === have) return { updated: false, reason: 'already current', dir: current };
  const parsed = JSON.parse(dataBuf.toString('utf8'));
  const civs = Object.values(parsed.civs).map(c => c.internal_name.toUpperCase());
  const tmp = cacheDir + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'trees'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'data.json'), dataBuf);
  for (const [local, remote] of Object.entries(FILES)) {
    if (local === 'data.json') continue;
    onProgress(`Downloading ${local}…`);
    fs.writeFileSync(path.join(tmp, local), await get(RAW + remote));
  }
  let i = 0;
  // fetch trees 6 at a time
  const queue = [...civs];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const civ = queue.shift();
      const buf = await get(RAW + `data/trees/${civ}.json`);
      fs.writeFileSync(path.join(tmp, 'trees', `${civ}.json`), buf);
      onProgress(`Tech trees ${++i}/${civs.length}`);
    }
  });
  await Promise.all(workers);
  fs.writeFileSync(path.join(tmp, 'SOURCE_COMMIT.txt'), `synced ${new Date().toISOString()} sha1:${sha(dataBuf)}`);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.renameSync(tmp, cacheDir);
  return { updated: true, reason: 'downloaded new dataset', dir: cacheDir };
}

module.exports = { sync, chooseDataDir, isComplete };
