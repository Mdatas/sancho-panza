// Builds the web version (PWA) into ../docs for GitHub Pages:  node web/build.mjs
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'), out = path.join(root, 'docs'), data = path.join(root, 'data');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(path.join(out, 'data'), { recursive: true });

// 1) data bundle: game data, build orders, knowledge notes (text files only)
const files = {};
const walk = (dir, rel) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f), r = rel + '/' + f; if (fs.statSync(p).isDirectory()) walk(p, r); else if (/\.(json|md|txt)$/.test(f)) files[r] = fs.readFileSync(p, 'utf8'); } };
walk(path.join(data, 'game'), '/data/game');
walk(path.join(data, 'build_orders', 'rtsbuilds'), '/data/build_orders/rtsbuilds');
walk(path.join(data, 'knowledge'), '/data/knowledge');
// icon index (same logic as the desktop app:imgIndex)
const img = { civs: {}, units: {}, techs: {}, buildings: {} };
const gameData = JSON.parse(files['/data/game/data.json']);
const civKeys = Object.keys(gameData.civ_names || {});
for (const f of Object.keys(files).filter(k => k.startsWith('/data/game/trees/'))) {
  const t = JSON.parse(files[f]); img.civs[path.basename(f, '.json')] = null;
  for (const n of [...(t.units_techs || []), ...(t.buildings || [])]) {
    const b = n.use_type === 'Unit' ? ['units', 'Unit'] : n.use_type === 'Tech' ? ['techs', 'Tech'] : n.use_type === 'Building' ? ['buildings', 'Building'] : null;
    if (b && n.picture_index != null && !(n.name in img[b[0]]) && fs.existsSync(path.join(data, 'img', b[1], n.picture_index + '.png'))) img[b[0]][n.name] = b[1] + '/' + n.picture_index + '.png';
  }
}
img.civs = {}; // civ keys are resolved at runtime from the game data (Civs/<key lowercase>.png)
fs.writeFileSync(path.join(out, 'data', 'bundle.json'), JSON.stringify({ version: pkg.version, files, imgIndex: img }));
fs.cpSync(path.join(data, 'img'), path.join(out, 'img'), { recursive: true });

// 2) bundle the engine + brain + browser shim
await esbuild.build({
  entryPoints: [path.join(here, 'src', 'coach-web.js')], bundle: true, outfile: path.join(out, 'coach-web.js'), format: 'iife', platform: 'browser', target: ['es2020'],
  alias: { fs: path.join(here, 'src', 'vfs.js'), path: 'path-browserify' },
  define: { __VERSION__: JSON.stringify(pkg.version), __PATCH__: JSON.stringify(pkg.reviewedPatch || '185872'), 'process.env.NODE_ENV': '"production"' },
  inject: [path.join(here, 'src', 'process-shim.js')], minify: true, legalComments: 'linked', logLevel: 'warning',
});

// 3) renderer pages, adapted for the web
const R = path.join(root, 'src', 'renderer');
for (const f of ['styles.css', 'guide.css', 'app.js', 'guide.js', 'i18n.js']) fs.copyFileSync(path.join(R, f), path.join(out, f));
fs.cpSync(path.join(R, 'assets'), path.join(out, 'assets'), { recursive: true });
const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data: blob:; script-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*";
const head = `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n  <meta name="theme-color" content="#16130f">\n  <link rel="manifest" href="manifest.webmanifest">\n  <link rel="apple-touch-icon" href="assets/icon-192.png">\n  <meta name="apple-mobile-web-app-capable" content="yes">\n  <link rel="stylesheet" href="web.css">`;
for (const page of ['index.html', 'guide.html']) {
  let h = fs.readFileSync(path.join(R, page), 'utf8');
  h = h.replace(/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${csp}">\n  ${head}`);
  h = h.replace(/<body class="([^"]*)"/, (m, c) => `<body class="${c.replace(/\bcompact\b/, '').trim()} web full"`).replace(/<body>/, '<body class="web">');
  h = h.replace(/(<script src="(?:i18n|app|guide)\.js"><\/script>)/, '<script src="coach-web.js"></script>\n$1');
  if (!h.includes(head.slice(0, 20))) throw new Error('CSP/head injection failed for ' + page);
  if (!h.includes('coach-web.js')) h = h.replace('</body>', '<script src="coach-web.js"></script>\n</body>');
  fs.writeFileSync(path.join(out, page), h);
}
for (const f of fs.readdirSync(path.join(here, 'static'))) fs.cpSync(path.join(here, 'static', f), path.join(out, f), { recursive: true });
const sw = fs.readFileSync(path.join(here, 'static', 'sw.js'), 'utf8').replace('__VERSION__', pkg.version);
fs.writeFileSync(path.join(out, 'sw.js'), sw);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('web build →', path.relative(root, out), 'version', pkg.version, 'files', Object.keys(files).length);
