'use strict';
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, shell, nativeImage, dialog, screen, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const { Settings } = require('./settings');
const { GameData } = require('./engine/gamedata');
const { BuildOrders } = require('./engine/buildorders');
const { Knowledge } = require('./engine/knowledge');
const { Strategy } = require('./engine/strategy');
const { Brain } = require('./brain/brain');
const datasync = require('./datasync');
const guideData = require('./guideData');
const { makeDispatcher } = require('./brain/tools');
const tts = require('./voice/tts');
const patchwatch = require('./patchwatch');
const matchwatch = require('./matchwatch');
const bocatalog = require('./bocatalog');
const { pathToFileURL } = require('url');

const APP_NAME = 'Sancho Panza - AOE2 Squier';
// Keep the user-data folder of earlier versions (%APPDATA%\\AoE2 Coach): settings, key, logs and imports survive the rename.
app.setName(APP_NAME);
try { app.setPath('userData', path.join(app.getPath('appData'), 'AoE2 Coach')); } catch { /* ignore */ }

// Resource roots: packaged (resources/data next to app.asar) or development checkout.
const RES = (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'data'))) ? process.resourcesPath : path.join(__dirname, '..', '..');
const BUNDLED_DATA = path.join(RES, 'data');
const COMPACT_SIZE = { width: 470, height: 238 };
const FULL_SIZE = { width: 470, height: 680 };

let win = null, tray = null, guideWin = null, matchPoller = null;
let patchState = { reviewed: '', latest: '', seen: {}, lastCheck: null, error: null, newBuilds: [] };
let settings, gd, buildOrders, knowledge, strategy, brain;
let dataInfo = { dir: null, syncStatus: 'idle', lastSync: null, message: '' };

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

function userPath(...p) { return path.join(app.getPath('userData'), ...p); }
function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function log(...a) { try { fs.appendFileSync(userPath('coach.log'), `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`); } catch { /* ignore */ } }
/** Structured conversation log: one JSON line per event, one file per day. */
function logEvent(entry) {
  try {
    fs.mkdirSync(userPath('logs'), { recursive: true });
    const f = userPath('logs', `coach-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* ignore */ }
}

/* ----------------------------------------------------------------- secrets at rest */
// Default (experimentalPrivacy OFF) = exactly v0.11: keys encrypted with Windows DPAPI (safeStorage) in settings.json and shown in the settings field.
// experimentalPrivacy ON: the renderer only gets "••••" + last 4 characters, and rememberKey=false ("modo amnésico") keeps keys only in memory.
const SECRET_KEYS = ['anthropicApiKey', 'openaiApiKey'];
const volatileSecrets = {};
const MASK = '••••';
function encryptSecret(v) { if (!v || String(v).startsWith('enc:')) return v || ''; try { return safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(String(v)).toString('base64') : v; } catch { return v; } }
function decryptSecret(v) { if (!v || !String(v).startsWith('enc:')) return v || ''; try { return safeStorage.decryptString(Buffer.from(String(v).slice(4), 'base64')); } catch { return ''; } }
const amnesiac = (raw) => raw.experimentalPrivacy === true && raw.rememberKey === false;
/** Full settings with real keys — main process only (brain, providers, TTS). */
function getSettings() { const raw = settings.get(); const s = { ...raw }; for (const k of SECRET_KEYS) s[k] = amnesiac(raw) ? (volatileSecrets[k] || '') : decryptSecret(raw[k]); return s; }
/** What the settings window receives: v0.11 behaviour unless experimentalPrivacy is ON. */
function publicSettings() {
  const s = getSettings(); const out = { ...s };
  for (const k of SECRET_KEYS) { const v = s[k] || ''; out[k + 'Set'] = !!v; if (s.experimentalPrivacy === true) out[k] = v ? MASK + v.slice(-4) : ''; }
  return out;
}
function setSettings(patch) {
  const p = { ...patch };
  const before = settings.get();
  const next = { ...before, ...p };
  // moving between "remember" and "amnesiac" carries the current keys across, nothing is lost or left behind
  if (amnesiac(before) !== amnesiac(next)) {
    const cur = getSettings();
    for (const k of SECRET_KEYS) { if (amnesiac(next)) { volatileSecrets[k] = cur[k] || ''; if (!(k in p)) p[k] = ''; } else if (!(k in p)) p[k] = encryptSecret(cur[k] || ''); }
  }
  for (const k of SECRET_KEYS) {
    if (!(k in p)) continue;
    const v = String(p[k] || '');
    if (v.startsWith(MASK)) { delete p[k]; continue; } // the masked value came back from the UI: keep the stored key
    if (amnesiac(next)) { if (v) volatileSecrets[k] = v.trim(); p[k] = ''; } else p[k] = v.startsWith('enc:') ? v : encryptSecret(v.trim());
  }
  settings.set(p);
  return publicSettings();
}

/** Delete daily conversation logs older than the retention window (default 30 days; 0 = keep forever). */
function pruneLogs(days) {
  if (!days) return;
  try {
    const cut = Date.now() - days * 86400000;
    for (const f of fs.readdirSync(userPath('logs'))) { const fp = userPath('logs', f); if (/^coach-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && fs.statSync(fp).mtimeMs < cut) fs.unlinkSync(fp); }
  } catch { /* ignore */ }
}

/* ----------------------------------------------------------------- data */
function loadData() {
  const cacheDir = userPath('game-data');
  const dir = datasync.chooseDataDir(cacheDir, path.join(BUNDLED_DATA, 'game'));
  gd = new GameData(dir).load();
  for (const d of ['build_orders', path.join('build_orders', 'rtsbuilds'), 'knowledge', 'logs']) fs.mkdirSync(userPath(d), { recursive: true });
  buildOrders = new BuildOrders([path.join(BUNDLED_DATA, 'build_orders', 'rtsbuilds'), userPath('build_orders', 'rtsbuilds'), userPath('build_orders')]).load();
  knowledge = new Knowledge([path.join(BUNDLED_DATA, 'knowledge'), userPath('knowledge')]).load();
  strategy = new Strategy([path.join(BUNDLED_DATA, 'knowledge'), userPath('knowledge')]).load();
  if (brain) { brain.strategy = strategy; brain.knowledge = knowledge; }
  dataInfo.dir = dir; dataInfo.source = gd.sourceCommit;
  log('data loaded from', dir, 'civs', Object.keys(gd.civs).length, 'builds', buildOrders.list.length);
}

async function syncData(force = false) {
  if (dataInfo.syncStatus === 'running') return dataInfo;
  dataInfo.syncStatus = 'running'; send('data:status', dataInfo);
  const msgs = [];
  try {
    const r = await datasync.sync({ cacheDir: userPath('game-data'), bundledDir: path.join(BUNDLED_DATA, 'game'), onProgress: m => { dataInfo.message = m; send('data:status', dataInfo); } });
    if (r.updated || force) loadData();
    msgs.push(r.updated ? 'game data updated' : 'game data current');
  } catch (e) { msgs.push('game data sync failed (offline?)'); log('sync error', e.message); }
  try {
    const r = await buildOrders.syncRtsBuilds(userPath('build_orders', 'rtsbuilds'), m => { dataInfo.message = m; send('data:status', dataInfo); });
    msgs.push(`builds: ${r.total} (${r.added} new, ${r.updated} updated)`);
    if (brain) brain.buildOrders = buildOrders;
  } catch (e) { msgs.push('builds sync failed'); log('bo sync error', e.message); }
  dataInfo.syncStatus = 'ok'; dataInfo.lastSync = new Date().toISOString(); dataInfo.message = msgs.join(' · ');
  send('data:status', dataInfo);
  return dataInfo;
}

/* ----------------------------------------------------------------- patch watch (official news feed) */
function patchInfoLine() { return patchwatch.statusLine(patchState); }
async function checkPatches(force = false) {
  patchState.reviewed = patchwatch.reviewedBuild(path.join(BUNDLED_DATA, 'knowledge'));
  try { const st = JSON.parse(fs.readFileSync(userPath('game-data', 'patchwatch.json'), 'utf8')); patchState.seen = st.seen || {}; patchState.latest = st.latestBuild || patchState.reviewed; patchState.lastCheck = st.lastCheck || null; } catch { patchState.latest = patchState.reviewed; }
  if (brain) brain.patchInfo = patchInfoLine();
  if (settings.get().patchWatch === false && !force) return patchState;
  const r = await patchwatch.check({ cacheDir: userPath('game-data'), knowledgeDir: userPath('knowledge'), reviewed: patchState.reviewed, force, log });
  patchState = { ...patchState, latest: r.latest || patchState.latest, error: r.error, newBuilds: r.newBuilds.map(b => b.build), lastCheck: r.checked ? Date.now() : patchState.lastCheck };
  try { patchState.seen = JSON.parse(fs.readFileSync(userPath('game-data', 'patchwatch.json'), 'utf8')).seen || {}; } catch { /* ignore */ }
  if (r.newBuilds.length) {
    loadData(); // pick up the new parches_auto_*.md notes
    send('toast', { kind: 'warn', text: `Nuevo parche de AoE2: Update ${r.newBuilds.map(b => b.build).join(', ')}. El coach ya leyó las notas oficiales; las notas viejas pueden tener números desactualizados.` });
  }
  if (brain) brain.patchInfo = patchInfoLine();
  send('patch:status', patchState);
  return patchState;
}

/* ----------------------------------------------------------------- match detection (optional, aoe2companion public API) */
function onDetectedMatch(m) {
  const filled = brain.applyDetected(m);
  const team = m.allies.length || m.opponents.length > 1;
  if (team) { try { brain.setState({ notes: `partida por equipos: aliados ${m.allies.map(p => p.civ).join(', ') || '—'}; rivales ${m.opponents.map(p => p.civ).join(', ')}`, source: 'detected' }); } catch { /* ignore */ } }
  send('match:detected', { match: m, text: matchwatch.describe(m), filled, state: brain.state, line: brain.stateLine() });
}
function setupMatchWatch() {
  matchPoller = matchwatch.createPoller({
    getProfileId: () => settings.get().profileId || null,
    enabled: () => settings.get().matchDetect === true && !!settings.get().profileId && win && win.isVisible(),
    onMatch: onDetectedMatch, log,
  });
  matchPoller.start();
}

/* ----------------------------------------------------------------- window */
function createWindow() {
  const s = settings.get();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const size = s.compact ? COMPACT_SIZE : FULL_SIZE;
  const saved = s.compact ? s.compactBounds : s.fullBounds;
  const b = saved || { ...size, x: Math.round((sw - size.width) / 2), y: s.compact ? sh - size.height - 60 : Math.max(20, Math.round((sh - size.height) / 2)) };
  win = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y, minWidth: 340, minHeight: 120,
    frame: false, transparent: false, backgroundColor: '#16130f', resizable: true, show: false,
    alwaysOnTop: s.alwaysOnTop !== false, skipTaskbar: false, title: APP_NAME,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  if (s.alwaysOnTop !== false) win.setAlwaysOnTop(true, 'screen-saver');
  // macOS: stay visible over the game when it runs full screen (own Space)
  if (process.platform === 'darwin' && s.alwaysOnTop !== false) { try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* older macOS */ } }
  win.setOpacity(Number(s.opacity) || 0.94);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  const saveBounds = () => { if (!win.isMinimized() && win.isVisible()) settings.set({ [settings.get().compact ? 'compactBounds' : 'fullBounds']: win.getBounds() }); };
  win.on('resize', saveBounds); win.on('move', saveBounds);
  win.on('close', (e) => { if (!app.isQuiting) { e.preventDefault(); win.hide(); } });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}


/* ----------------------------------------------------------------- visual guide window */
function openGuide(arg = {}) {
  if (!guideWin || guideWin.isDestroyed()) {
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const w = Math.min(1040, sw - 40), h = Math.min(740, sh - 60);
    guideWin = new BrowserWindow({
      width: w, height: h, minWidth: 700, minHeight: 480, show: false, backgroundColor: '#16130f', autoHideMenuBar: true, title: APP_NAME + ' — Guía',
      icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    guideWin.setMenuBarVisibility(false);
    guideWin.setAlwaysOnTop(true, 'screen-saver');
    guideWin.loadFile(path.join(__dirname, '..', 'renderer', 'guide.html'));
    guideWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    guideWin.webContents.on('will-navigate', e => e.preventDefault());
    guideWin.on('close', (e) => { if (!app.isQuiting) { e.preventDefault(); guideWin.hide(); } });
    guideWin.once('ready-to-show', () => { guideWin.show(); guideWin.webContents.send('guide:goto', arg); });
    return;
  }
  guideWin.show(); guideWin.focus();
  guideWin.webContents.send('guide:goto', arg);
}
function toggleGuide() {
  if (guideWin && !guideWin.isDestroyed() && guideWin.isVisible()) guideWin.hide(); else openGuide({});
}

function setCompact(compact) {
  const s = settings.get();
  if (!!s.compact === !!compact) return;
  settings.set({ [s.compact ? 'compactBounds' : 'fullBounds']: win.getBounds(), compact });
  const saved = compact ? s.compactBounds : s.fullBounds;
  const cur = win.getBounds();
  // guard against stale saved sizes (e.g. a "full" size that is actually compact-high)
  let height = saved ? saved.height : (compact ? COMPACT_SIZE : FULL_SIZE).height;
  if (compact && (height > 320 || height < COMPACT_SIZE.height)) height = COMPACT_SIZE.height;
  if (!compact && height < 400) height = FULL_SIZE.height;
  const width = (saved && saved.width) || cur.width;
  // keep the bar on screen: grow upwards if the full view would run off the bottom
  const area = screen.getDisplayMatching(cur).workArea;
  let y = cur.y; if (y + height > area.y + area.height) y = Math.max(area.y, area.y + area.height - height);
  win.setBounds({ x: cur.x, y, width, height });
  send('mode', { compact });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) win.hide(); else win.showInactive();
}
function askHotkey() {
  if (!win) return;
  if (!win.isVisible() || win.isMinimized()) win.show();
  win.focus();
  send('hotkey', { name: 'ask' });
}
/** Give keyboard focus back to the game after the player hits Enter / Esc. */
function releaseFocus() {
  const mode = settings.get().focusReturn || 'blur';
  if (!win || mode === 'none') return;
  if (mode === 'minimize') { win.minimize(); setTimeout(() => { if (win && !win.isDestroyed()) win.showInactive(); }, 150); return; }
  win.blur();
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = settings.get().hotkeys || {};
  const failed = [];
  const reg = (acc, fn) => { if (!acc) return; try { if (!globalShortcut.register(acc, fn)) failed.push(acc); } catch { failed.push(acc); } };
  reg(hk.toggle, toggleWindow);
  reg(hk.ask, askHotkey);
  reg(hk.boPrev, () => send('hotkey', { name: 'boPrev' }));
  reg(hk.boNext, () => send('hotkey', { name: 'boNext' }));
  reg(hk.guide, toggleGuide);
  if (failed.length) log('hotkeys failed', failed);
  return failed;
}

function createTray() {
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, '..', 'renderer', 'assets', 'tray.png'));
    if (process.platform === 'darwin') img = img.resize({ width: 18, height: 18 }); // menu-bar size
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show / hide', click: toggleWindow },
      { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
      { label: 'Open logs', click: () => shell.openPath(userPath('logs')) },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } },
    ]));
    tray.on('click', toggleWindow);
  } catch (e) { log('tray failed', e.message); }
}

/* ----------------------------------------------------------------- ipc */
function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const before = settings.get();
    const after = setSettings(patch || {});
    if (patch.hotkeys) { const failed = registerHotkeys(); if (failed.length) send('toast', { kind: 'warn', text: 'Hotkey not available: ' + failed.join(', ') }); }
    if (typeof patch.opacity === 'number' && win) win.setOpacity(patch.opacity);
    if (typeof patch.alwaysOnTop === 'boolean' && win) win.setAlwaysOnTop(patch.alwaysOnTop, 'screen-saver');
    if (patch.provider && patch.provider !== before.provider) brain.reset();
    if ('logRetentionDays' in patch) pruneLogs(Number(patch.logRetentionDays) || 0);
    return after;
  });

  ipcMain.handle('chat:ask', async (_e, { text }) => {
    const t0 = Date.now();
    try {
      const r = await brain.ask(text, { onEvent: ev => send('chat:event', ev) });
      return { ok: true, id: r.id, text: r.text, model: r.model, cost: r.cost, totals: r.totals, tools: r.toolLog.map(t => t.name), state: r.state, stateLine: r.stateLine, ms: Date.now() - t0 };
    } catch (e) { log('ask error', e.message); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('chat:reset', () => { brain.reset(); return true; });
  ipcMain.handle('chat:newGame', () => ({ state: brain.newGame(), line: brain.stateLine() }));
  ipcMain.handle('chat:flag', (_e, comment) => { brain.flag(comment); return true; });
  ipcMain.handle('team:counters', () => { try { return brain.teamCounters(); } catch (e) { return { age: 3, rows: [], error: e.message }; } });
  ipcMain.handle('state:get', () => ({ state: brain.state, line: brain.stateLine() }));
  ipcMain.handle('state:set', (_e, patch) => { try { return { ok: true, state: brain.setState(patch), line: brain.stateLine() }; } catch (e) { return { ok: false, error: e.message }; } });

  ipcMain.handle('tts:speak', async (_e, text) => {
    try {
      const r = await tts.speak(text, getSettings());
      if (!r) return { ok: true, audio: null };
      return { ok: true, audio: r.audio.toString('base64'), mime: r.mime, engine: r.engine, fallbackReason: r.fallbackReason || null };
    } catch (e) { log('tts error', e.message); return { ok: false, error: e.message }; }
  });
  ipcMain.handle('tts:voices', () => tts.VOICES);

  ipcMain.handle('bo:list', (_e, q) => buildOrders.search({ ...(q || {}), limit: (q && q.limit) || 100 }));
  ipcMain.handle('bo:get', (_e, id) => { const bo = buildOrders.get(id); return bo ? { ...bo, text: buildOrders.toText(bo) } : null; });
  ipcMain.handle('bo:import', (_e, text) => { try { return { ok: true, bo: buildOrders.importJson(text, userPath('build_orders')) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('bo:importFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import build order JSON', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return { ok: false, canceled: true };
    const out = [];
    for (const f of r.filePaths) { try { out.push(buildOrders.importJson(fs.readFileSync(f, 'utf8'), userPath('build_orders'))); } catch (e) { out.push({ error: `${path.basename(f)}: ${e.message}` }); } }
    return { ok: true, imported: out };
  });

  ipcMain.handle('civs:list', () => Object.values(gd.civs).map(c => ({ key: c.key, name_en: c.name_en, name_es: c.name_es })).sort((a, b) => a.name_en.localeCompare(b.name_en)));
  ipcMain.handle('data:info', () => ({ ...dataInfo, civs: Object.keys(gd.civs).length, units: Object.values(gd.units).filter(u => u.name_en).length, buildOrders: buildOrders.list.length, notes: knowledge.sections.length, civProfiles: Object.keys(strategy.civs).length, mapProfiles: Object.keys(strategy.maps).length, userData: app.getPath('userData'), version: app.getVersion() }));
  ipcMain.handle('maps:list', () => strategy.mapNames());
  ipcMain.handle('profile:get', (_e, { kind, q }) => {
    if (kind === 'map') { const p = strategy.findMap(q); return p ? p.body : null; }
    const c = gd.findCiv(q); const p = c && strategy.civ(c.key); return p ? p.body : null;
  });

  // ---- visual guide
  let civStatsCache = null;
  const civStats = () => civStatsCache || (civStatsCache = guideData.parseCivStats([path.join(BUNDLED_DATA, 'knowledge'), userPath('knowledge')]));
  ipcMain.handle('guide:open', (_e, arg) => { openGuide(arg || {}); return true; });
  ipcMain.handle('guide:index', () => ({ ...guideData.index({ gd, strategy }), state: { ...brain.state } }));
  ipcMain.handle('guide:civ', (_e, key) => guideData.civView({ gd, strategy, key, stats: civStats() }));
  ipcMain.handle('guide:map', (_e, key) => guideData.mapView({ strategy, key }));
  ipcMain.handle('guide:stats', () => civStats());
  ipcMain.handle('guide:translate', async (_e, { text, lang }) => { try { return { ok: true, text: await brain.translate(text, lang) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('guide:notes', (_e, q) => guideData.searchNotes({ knowledge, q }));
  ipcMain.handle('guide:noteList', () => guideData.listNotes({ knowledge }));
  ipcMain.handle('guide:noteText', (_e, { file, title }) => guideData.noteText({ knowledge, file, title }));
  ipcMain.handle('guide:tool', (_e, { name, input }) => {
    if (!['lookup_unit', 'find_counters', 'civ_matchup', 'compare_units'].includes(name)) return { error: 'not allowed' };
    try { return makeDispatcher({ gd, buildOrders, knowledge, strategy, lang: 'es', state: { ...brain.state }, onState: () => {} })(name, input || {}); }
    catch (e) { return { error: e.message }; }
  });
  // ---- patches and match detection
  ipcMain.handle('patch:status', () => ({ ...patchState, line: patchInfoLine() }));
  ipcMain.handle('patch:check', () => checkPatches(true));
  ipcMain.handle('match:searchProfile', async (_e, name) => { try { return { ok: true, profiles: await matchwatch.searchProfiles(name) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('match:now', async () => {
    if (!settings.get().profileId) return { ok: false, error: 'Elegí tu perfil en Ajustes → Partida automática.' };
    const m = await matchPoller.now(); const st = matchPoller.status();
    if (!m) return { ok: false, error: st.lastError ? 'No se pudo consultar (' + st.lastError + ')' : 'No encontré partidas para ese perfil.' };
    return { ok: true, match: m, text: matchwatch.describe(m) };
  });
  ipcMain.handle('match:apply', (_e, { force } = {}) => {
    const m = matchPoller && matchPoller.status().lastMatch; if (!m) return { ok: false, error: 'Sin partida detectada.' };
    const filled = brain.applyDetected(m, { force: !!force });
    return { ok: true, filled, state: brain.state, line: brain.stateLine() };
  });
  ipcMain.handle('logs:clear', () => { try { for (const f of fs.readdirSync(userPath('logs'))) if (/\.jsonl$/.test(f)) fs.unlinkSync(userPath('logs', f)); return true; } catch { return false; } });
  // ---- build-order catalog and icons
  let catCache = null;
  ipcMain.handle('bo:catalog', () => (catCache && catCache.n === buildOrders.list.length + knowledge.sections.length) ? catCache.c : (catCache = { n: buildOrders.list.length + knowledge.sections.length, c: bocatalog.catalog({ buildOrders, knowledge, gd }) }).c);
  ipcMain.handle('bo:noteText', (_e, { file, stem }) => bocatalog.noteText(knowledge, file, stem));
  let imgIdx = null;
  ipcMain.handle('app:imgIndex', () => {
    if (imgIdx) return imgIdx;
    const base = path.join(BUNDLED_DATA, 'img'); const idx = { base: pathToFileURL(base).href + '/', civs: {}, units: {}, techs: {}, buildings: {} };
    try {
      for (const c of Object.values(gd.civs)) idx.civs[c.key] = 'Civs/' + c.key.toLowerCase() + '.png';
      const tdir = path.join(dataInfo.dir || path.join(BUNDLED_DATA, 'game'), 'trees');
      for (const f of fs.readdirSync(tdir)) {
        const t = JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf8'));
        for (const n of [...(t.units_techs || []), ...(t.buildings || [])]) {
          const bucket = n.use_type === 'Unit' ? ['units', 'Unit'] : n.use_type === 'Tech' ? ['techs', 'Tech'] : n.use_type === 'Building' ? ['buildings', 'Building'] : null;
          if (bucket && n.picture_index != null && !(n.name in idx[bucket[0]]) && fs.existsSync(path.join(base, bucket[1], n.picture_index + '.png'))) idx[bucket[0]][n.name] = bucket[1] + '/' + n.picture_index + '.png';
        }
      }
    } catch (e) { log('imgIndex', e.message); }
    return (imgIdx = idx);
  });
  ipcMain.handle('data:sync', () => syncData(true));

  ipcMain.handle('app:openUserDir', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:openLogs', () => shell.openPath(userPath('logs')));
  ipcMain.handle('app:openExternal', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
  ipcMain.handle('window:minimize', () => win && win.minimize());
  ipcMain.handle('window:hide', () => win && win.hide());
  ipcMain.handle('window:quit', () => { app.isQuiting = true; app.quit(); });
  ipcMain.handle('window:setCompact', (_e, compact) => { setCompact(!!compact); return settings.get().compact; });
  ipcMain.handle('window:release', () => releaseFocus());
}

/* ----------------------------------------------------------------- app */
app.whenReady().then(async () => {
  settings = new Settings(userPath('settings.json'));
  loadData();
  brain = new Brain({ gd, buildOrders, knowledge, strategy, getSettings, saveState: (st) => settings.set({ match: st }), log: logEvent });
  registerIpc();
  // macOS: without an app menu, Cmd+C / Cmd+V / Cmd+Q do not work in the text fields
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  createWindow();
  createTray();
  const failed = registerHotkeys();
  if (failed.length) setTimeout(() => send('toast', { kind: 'warn', text: 'Hotkey not available: ' + failed.join(', ') }), 1500);
  pruneLogs(Number(settings.get().logRetentionDays) || 0);
  const smoke = process.argv.includes('--smoke');
  if (settings.get().dataAutoSync !== false && !smoke) setTimeout(() => syncData(false), 2500);
  if (!smoke) { setTimeout(() => checkPatches(false).catch(e => log('patch check', e.message)), 4000); setupMatchWatch(); } else checkPatches(false).catch(() => {});
  if (process.argv.includes('--smoke')) smokeTest();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* stay in tray */ });
app.on('activate', () => { if (win) win.show(); });

/** Headless self-check used by the build: loads the UI, pokes the renderer, prints findings, exits. */
async function smokeTest() {
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  win.webContents.on('preload-error', (_e, p, err) => errors.push('preload: ' + err.message));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 2000));
  const js = (code) => win.webContents.executeJavaScript(code);
  const type = async (text) => { await js(`document.getElementById('cmd').value = ${JSON.stringify(text)}; document.getElementById('cmd').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));`); await new Promise(r => setTimeout(r, 500)); };
  const shotDir = process.argv[process.argv.indexOf('--shot') + 1];
  const shot = async (name) => { if (process.argv.includes('--shot')) { await new Promise(r => setTimeout(r, 300)); fs.writeFileSync(path.join(shotDir, `shot-${name}.png`), (await win.capturePage()).toPNG()); } };
  try {
    const probe = {};
    probe.welcome = await js(`!document.getElementById('welcome').classList.contains('hidden') + ' ' + document.body.classList.contains('full') + ' ' + (document.querySelector('#tabs button.active') || {}).dataset?.tab`);
    await shot('welcome');
    await js(`document.getElementById('wSkip').click()`); await type('/compact'); await new Promise(r => setTimeout(r, 400));
    probe.navCompact = await js(`(() => { const n = document.getElementById('tabs'); return getComputedStyle(n).display + ' ' + n.querySelectorAll('button').length + ' ' + n.querySelector('[data-tab="chat"]').textContent; })()`);
    await type('/civ francos'); await type('/vs mongoles'); await type('/edad castillos'); await type('/mapa Arabia');
    probe.stateLine = await js(`document.getElementById('stateLine').textContent`);
    await type('/aliados mayas, britanos'); await type('/rivales mongoles, aztecas, gurjaras, teutones'); await new Promise(r => setTimeout(r, 500));
    probe.team = await js(`document.querySelectorAll('#tbMine .slot.set').length + 'v' + document.querySelectorAll('#tbTheirs .slot.set').length + ' | ' + document.getElementById('answer').textContent.slice(0, 200)`);
    probe.teamState = JSON.stringify([brain.state.myCiv, brain.state.allies, brain.state.enemies, brain.state.oppCiv]);
    probe.teamPrompt = brain.teamCountersText().split('\n').length + ' lines';
    await shot('team-compact');
    probe.tldr = await js(`answerHtml('• Hacé piqueros\\n• 8 piqueros y seguí con arqueros\\n• Piquero: +22 vs caballería\\n---\\nDetalle acá.')`);
    probe.replayIn = await js(`(() => { showAnswer({ q: 'x', html: answerHtml('• a\\n• b\\n• c\\n---\\nd'), speakText: 'a b c d' }); addMsg('assistant', '• a\\n• b\\n• c\\n---\\nd'); return document.querySelectorAll('#answer .replayIn').length + ' ' + document.querySelectorAll('#messages .replayIn').length; })()`);
    await js(`document.querySelector('#tbTheirs .slot').click()`); await new Promise(r => setTimeout(r, 300));
    probe.picker = await js(`!document.getElementById('civPick').classList.contains('hidden') + ' ' + document.querySelectorAll('#cpList .cpi').length`);
    await js(`document.getElementById('cpClose').click()`);
    await type('/bo scouts'); probe.boList = await js(`document.getElementById('answer').textContent.slice(0, 160)`);
    await type('/bo 1'); await type('/n'); await type('/n');
    probe.boLine = await js(`document.getElementById('boLine').textContent.slice(0, 120)`);
    await shot('compact');
    await type('qué hago contra mangudai'); await new Promise(r => setTimeout(r, 1500));
    probe.answer = await js(`document.getElementById('answer').textContent.slice(0, 160)`);
    await type('/ayuda'); probe.help = (await js(`document.getElementById('answer').textContent`)).length;
    await type('/full'); await new Promise(r => setTimeout(r, 600));
    probe.full = await js(`document.body.classList.contains('full') + ' ' + document.querySelectorAll('#boSelect option').length + ' builds ' + document.querySelectorAll('.msg').length + ' msgs'`);
    probe.boundsFull = win.getBounds().height; probe.compactSetting = settings.get().compact;
    await shot('full');
    await js(`document.querySelector('#tabs button[data-tab="bo"]').click()`); await new Promise(r => setTimeout(r, 1500));
    probe.catalog = await js(`document.querySelectorAll('#boList .bocard').length + ' cards | ' + document.getElementById('boCount').textContent + ' | chips ' + document.querySelectorAll('#boTypes .chip').length`);
    await shot('bo-list');
    await js(`[...document.querySelectorAll('#boTypes .chip')].find(b => b.dataset.t === 'Drush').click()`); await new Promise(r => setTimeout(r, 500));
    probe.catalogDrush = await js(`document.getElementById('boCount').textContent`);
    await js(`document.querySelector('#boList .bocard.note').click()`); await new Promise(r => setTimeout(r, 800));
    probe.reader = await js(`document.getElementById('boReader').classList.contains('hidden') + ' ' + document.getElementById('boReader').textContent.length + ' chars ' + document.querySelectorAll('#boReader details').length + ' vig'`);
    await shot('bo-reader');
    await js(`[...document.querySelectorAll('#boTypes .chip')][0].click()`); await new Promise(r => setTimeout(r, 300));
    await js(`document.querySelector('#boList .bocard.steps').click()`); await new Promise(r => setTimeout(r, 600));
    probe.stepsLoaded = await js(`document.getElementById('boStep').textContent.slice(0, 80)`);
    await js(`document.querySelector('#tabs button[data-tab="settings"]').click()`); await shot('settings');
    await js(`(() => { const s = document.getElementById('setProvider'); s.value = 'groq'; s.dispatchEvent(new Event('change')); })()`); await new Promise(r => setTimeout(r, 600)); probe.groqPreset = JSON.stringify([settings.get().provider, settings.get().openaiBaseUrl, settings.get().openaiModel]); await shot('settings-groq'); await js(`(() => { const s = document.getElementById('setProvider'); s.value = 'claude'; s.dispatchEvent(new Event('change')); })()`); await new Promise(r => setTimeout(r, 300));
    await type('/compact'); await new Promise(r => setTimeout(r, 400));
    probe.compactAgain = await js(`!document.body.classList.contains('full')`);
    await js(`document.querySelector('#tabs button[data-tab="bo"]').click()`); await new Promise(r => setTimeout(r, 500));
    probe.navFromCompact = await js(`document.body.classList.contains('full') + ' ' + document.querySelector('#tabs button.active').dataset.tab`);
    await type('/compact'); await new Promise(r => setTimeout(r, 300));
    probe.errText = await js(`(() => { document.getElementById('cmd').value = 'hola'; document.getElementById('cmd').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); return new Promise(r => setTimeout(() => r(document.getElementById('answer').textContent.slice(0, 120)), 600)); })()`);
    await shot('nokey');
    // visual guide
    openGuide({ civ: 'Franks' });
    await new Promise(r => setTimeout(r, 2500));
    const gjs = (code) => guideWin.webContents.executeJavaScript(code);
    guideWin.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push('guide: ' + message); });
    const gshot = async (name) => { if (process.argv.includes('--shot')) { await new Promise(r => setTimeout(r, 400)); fs.writeFileSync(path.join(shotDir, `guide-${name}.png`), (await guideWin.webContents.capturePage()).toPNG()); } };
    probe.guideCiv = await gjs(`document.querySelector('#civView h2') && document.querySelector('#civView h2').textContent + ' | cards ' + document.querySelectorAll('#civView details').length + ' | list ' + document.querySelectorAll('#civList .item').length`);
    await gshot('civ');
    await gjs(`document.querySelector('[data-tab="maps"]').click(); document.querySelector('#mapList .item').click()`); await new Promise(r => setTimeout(r, 600));
    probe.guideMap = await gjs(`document.querySelector('#mapView h2').textContent + ' | list ' + document.querySelectorAll('#mapList .item').length`); await gshot('map');
    await gjs(`document.querySelector('[data-tab="units"]').click(); document.getElementById('uTarget').value = 'Knight'; document.getElementById('uGo').click()`); await new Promise(r => setTimeout(r, 1500));
    probe.guideUnits = await gjs(`document.querySelectorAll('#uOut tr').length + ' rows ' + document.getElementById('uOut').textContent.slice(0, 60)`); await gshot('units');
    await gjs(`document.querySelector('[data-tab="meta"]').click()`); await new Promise(r => setTimeout(r, 800));
    probe.guideMeta = await gjs(`document.querySelectorAll('#metaTable tr').length + ' rows'`); await gshot('meta');
    await gjs(`document.querySelector('[data-tab="notes"]').click(); const i = document.getElementById('noteSearch'); i.value = 'men-at-arms'; i.dispatchEvent(new Event('input'))`); await new Promise(r => setTimeout(r, 1200));
    probe.guideNotes = await gjs(`document.querySelectorAll('#noteView details').length + ' hits'`); await gshot('notes');
    { const prevLang = settings.get().uiLanguage; settings.set({ uiLanguage: 'en' }); guideWin.webContents.reload(); await new Promise(r => setTimeout(r, 2500));
      await gjs(`handleGoto({ civ: 'Franks' })`); await new Promise(r => setTimeout(r, 1200));
      probe.guideEn = await gjs(`document.querySelector('#civView h2').textContent + ' | ' + document.querySelectorAll('#civView .trBtn').length + ' translate buttons | tab ' + document.querySelector('#tabs button').textContent + ' | ' + document.querySelector('#civView summary').textContent.slice(0, 30)`);
      await gshot('civ-en'); settings.set({ uiLanguage: prevLang || 'es' }); }
    // key handling: default = v0.11 (plain in the settings field), experimental privacy = masked, amnesiac = nothing on disk, back = restored
    {
      const set = (p) => js(`window.coach.settings.set(${JSON.stringify(p)})`); const get = () => js('window.coach.settings.get()');
      const prev = settings.get();
      await set({ anthropicApiKey: 'sk-ant-smoke-test-1234', experimentalPrivacy: false, rememberKey: true });
      const a = await get(); const b1 = a.anthropicApiKey === 'sk-ant-smoke-test-1234';
      await set({ experimentalPrivacy: true }); const b = await get(); const b2 = b.anthropicApiKey === '••••1234' && b.anthropicApiKeySet === true;
      await set({ anthropicApiKey: '••••1234' }); const b3 = getSettings().anthropicApiKey === 'sk-ant-smoke-test-1234';
      await set({ rememberKey: false }); const b4 = !settings.get().anthropicApiKey && getSettings().anthropicApiKey === 'sk-ant-smoke-test-1234';
      await set({ rememberKey: true }); const b5 = String(settings.get().anthropicApiKey || '').length > 0 && getSettings().anthropicApiKey === 'sk-ant-smoke-test-1234';
      await set({ experimentalPrivacy: false, anthropicApiKey: prev.anthropicApiKey ? decryptSecret(prev.anthropicApiKey) : '' });
      probe.keys = [b1, b2, b3, b4, b5].join(',');
      if (![b1, b2, b3, b4, b5].every(Boolean)) errors.push('key handling: ' + probe.keys);
    }
    console.log('SMOKE', JSON.stringify(probe, null, 1));
  } catch (e) { errors.push('probe: ' + e.message); }
  console.log('SMOKE_ERRORS', JSON.stringify(errors));
  app.isQuiting = true; app.exit(errors.length ? 1 : 0);
}
