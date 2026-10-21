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
const { createCore } = require('./api');
const tts = require('./voice/tts');
const patchwatch = require('./patchwatch');
const matchwatch = require('./matchwatch');
const { pathToFileURL } = require('url');
const pkg = require('../../package.json');
const I18N = require('../renderer/i18n.js');
/** Main-process message in the UI language (toasts, tray, match errors). */
function mt(key, vars = {}) {
  const lang = (settings && settings.get().uiLanguage) || 'es';
  const v = (I18N[lang] && I18N[lang][key]) || (I18N.en && I18N.en[key]) || (I18N.es && I18N.es[key]) || key;
  return String(v).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const APP_NAME = 'Sancho Panza - Age of Empires 2 Fan Companion';
// Keep the user-data folder of earlier versions (%APPDATA%\\AoE2 Coach): settings, key, logs and imports survive the rename.
app.setName(APP_NAME);
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'AoE2 Coach'));
} catch {
  /* ignore */
}

// Resource roots: packaged (resources/data next to app.asar) or development checkout.
const RES = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'data')) ? process.resourcesPath : path.join(__dirname, '..', '..');
const BUNDLED_DATA = path.join(RES, 'data');
const COMPACT_SIZE = { width: 470, height: 262 };
const STARTUP = { dataSyncMs: 2500, patchCheckMs: 4000 }; // background work starts after the window is up
const FULL_SIZE = { width: 470, height: 680 };

let win = null,
  tray = null,
  guideWin = null,
  matchPoller = null;
let patchState = { reviewed: '', latest: '', seen: {}, lastCheck: null, error: null, newBuilds: [] };
let settings, gd, buildOrders, knowledge, strategy, brain, core;
let dataInfo = { dir: null, syncStatus: 'idle', lastSync: null, message: '' };
let imgIdx = null; // icon index derived from the data: dropped whenever loadData() runs

const single = app.requestSingleInstanceLock();
if (!single) app.quit();
app.on('second-instance', () => {
  if (win) {
    win.show();
    win.focus();
  }
});

function userPath(...p) {
  return path.join(app.getPath('userData'), ...p);
}
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const LOG_MAX_BYTES = 2 * 1024 * 1024;
function log(...a) {
  try {
    const f = userPath('coach.log');
    try {
      if (fs.statSync(f).size > LOG_MAX_BYTES) fs.renameSync(f, f + '.1');
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
  } catch {
    /* ignore */
  }
}
/** Structured conversation log: one JSON line per event, one file per day. */
function logEvent(entry) {
  try {
    fs.mkdirSync(userPath('logs'), { recursive: true });
    const f = userPath('logs', `coach-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* ignore */
  }
}

/* ----------------------------------------------------------------- secrets at rest */
// Default (experimentalPrivacy OFF) = exactly v0.11: keys encrypted with Windows DPAPI (safeStorage) in settings.json and shown in the settings field.
// experimentalPrivacy ON: the renderer only gets "••••" + last 4 characters, and rememberKey=false ("modo amnésico") keeps keys only in memory.
const SECRET_KEYS = ['anthropicApiKey', 'openaiApiKey'];
const volatileSecrets = {};
const MASK = '••••';
function encryptSecret(v) {
  if (!v || String(v).startsWith('enc:')) return v || '';
  try {
    return safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(String(v)).toString('base64') : v;
  } catch {
    return v;
  }
}
function decryptSecret(v) {
  if (!v || !String(v).startsWith('enc:')) return v || '';
  try {
    return safeStorage.decryptString(Buffer.from(String(v).slice(4), 'base64'));
  } catch {
    return '';
  }
}
const amnesiac = (raw) => raw.experimentalPrivacy === true && raw.rememberKey === false;
/** Full settings with real keys — main process only (brain, providers, TTS). */
function getSettings() {
  const raw = settings.get();
  const s = { ...raw };
  for (const k of SECRET_KEYS) s[k] = amnesiac(raw) ? volatileSecrets[k] || '' : decryptSecret(raw[k]);
  return s;
}
/** What the settings window receives: v0.11 behaviour unless experimentalPrivacy is ON. */
function publicSettings() {
  const s = getSettings();
  const out = { ...s };
  for (const k of SECRET_KEYS) {
    const v = s[k] || '';
    out[k + 'Set'] = !!v;
    if (s.experimentalPrivacy === true) out[k] = v ? MASK + v.slice(-4) : '';
  }
  return out;
}
function setSettings(patch) {
  const p = { ...patch };
  const before = settings.get();
  const next = { ...before, ...p };
  // moving between "remember" and "amnesiac" carries the current keys across, nothing is lost or left behind
  if (amnesiac(before) !== amnesiac(next)) {
    const cur = getSettings();
    for (const k of SECRET_KEYS) {
      if (amnesiac(next)) {
        volatileSecrets[k] = cur[k] || '';
        if (!(k in p)) p[k] = '';
      } else if (!(k in p)) p[k] = encryptSecret(cur[k] || '');
    }
  }
  for (const k of SECRET_KEYS) {
    if (!(k in p)) continue;
    const v = String(p[k] || '');
    if (v.startsWith(MASK)) {
      delete p[k];
      continue;
    } // the masked value came back from the UI: keep the stored key
    if (amnesiac(next)) {
      if (v) volatileSecrets[k] = v.trim();
      p[k] = '';
    } else p[k] = v.startsWith('enc:') ? v : encryptSecret(v.trim());
  }
  settings.set(p);
  return publicSettings();
}

/** Delete daily conversation logs older than the retention window (default 30 days; 0 = keep forever). */
function pruneLogs(days) {
  if (!days) return;
  try {
    const cut = Date.now() - days * 86400000;
    for (const f of fs.readdirSync(userPath('logs'))) {
      const fp = userPath('logs', f);
      if (/^coach-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && fs.statSync(fp).mtimeMs < cut) fs.unlinkSync(fp);
    }
  } catch {
    /* ignore */
  }
}

/* ----------------------------------------------------------------- data */
function loadData() {
  const cacheDir = userPath('game-data');
  const dir = datasync.chooseDataDir(cacheDir, path.join(BUNDLED_DATA, 'game'));
  gd = new GameData(dir).load();
  for (const d of ['build_orders', path.join('build_orders', 'rtsbuilds'), 'knowledge', 'logs']) fs.mkdirSync(userPath(d), { recursive: true });
  buildOrders = new BuildOrders([
    path.join(BUNDLED_DATA, 'build_orders', 'rtsbuilds'),
    path.join(BUNDLED_DATA, 'build_orders', 'extracted'), // step-by-step builds extracted from the video notes (tools/condense.js)
    userPath('build_orders', 'rtsbuilds'),
    userPath('build_orders'),
  ]).load();
  knowledge = new Knowledge([path.join(BUNDLED_DATA, 'knowledge'), userPath('knowledge')]).load();
  strategy = new Strategy([path.join(BUNDLED_DATA, 'knowledge'), userPath('knowledge')]).load();
  if (brain) {
    brain.gd = gd;
    brain.buildOrders = buildOrders;
    brain.strategy = strategy;
    brain.knowledge = knowledge;
  }
  if (core) core.invalidate();
  imgIdx = null;
  dataInfo.dir = dir;
  dataInfo.source = gd.sourceCommit;
  log('data loaded from', dir, 'civs', Object.keys(gd.civs).length, 'builds', buildOrders.list.length);
}

async function syncData(force = false) {
  if (dataInfo.syncStatus === 'running') return dataInfo;
  dataInfo.syncStatus = 'running';
  send('data:status', dataInfo);
  const msgs = [];
  try {
    const r = await datasync.sync({
      cacheDir: userPath('game-data'),
      bundledDir: path.join(BUNDLED_DATA, 'game'),
      onProgress: (m) => {
        dataInfo.message = m;
        send('data:status', dataInfo);
      },
    });
    if (r.updated || force) loadData();
    msgs.push(r.updated ? 'game data updated' : 'game data current');
  } catch (e) {
    msgs.push('game data sync failed (offline?)');
    log('sync error', e.message);
  }
  try {
    const r = await buildOrders.syncRtsBuilds(userPath('build_orders', 'rtsbuilds'), (m) => {
      dataInfo.message = m;
      send('data:status', dataInfo);
    });
    msgs.push(`builds: ${r.total} (${r.added} new, ${r.updated} updated)`);
    if (brain) brain.buildOrders = buildOrders;
  } catch (e) {
    msgs.push('builds sync failed');
    log('bo sync error', e.message);
  }
  dataInfo.syncStatus = 'ok';
  dataInfo.lastSync = new Date().toISOString();
  dataInfo.message = msgs.join(' · ');
  send('data:status', dataInfo);
  return dataInfo;
}

/* ----------------------------------------------------------------- patch watch (official news feed) */
function patchInfoLine() {
  return patchwatch.statusLine(patchState);
}
const PATCH_STATE_DIR = () => userPath('patchwatch');
function readPatchState() {
  const f = path.join(PATCH_STATE_DIR(), 'patchwatch.json');
  // v0.18 and earlier kept it inside game-data/, which the dataset sync replaces wholesale: migrate once
  if (!fs.existsSync(f)) {
    const old = userPath('game-data', 'patchwatch.json');
    if (fs.existsSync(old)) {
      try {
        fs.mkdirSync(PATCH_STATE_DIR(), { recursive: true });
        fs.copyFileSync(old, f);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}
async function checkPatches(force = false) {
  patchState.reviewed = String(pkg.reviewedPatch || patchwatch.reviewedBuild(path.join(BUNDLED_DATA, 'knowledge')) || '');
  const st = readPatchState();
  if (st) {
    patchState.seen = st.seen || {};
    patchState.latest = st.latestBuild || patchState.reviewed;
    patchState.lastCheck = st.lastCheck || null;
  } else patchState.latest = patchState.reviewed;
  if (brain) brain.patchInfo = patchInfoLine();
  if (settings.get().patchWatch === false && !force) return patchState;
  const r = await patchwatch.check({ cacheDir: PATCH_STATE_DIR(), knowledgeDir: userPath('knowledge'), reviewed: patchState.reviewed, force, log });
  patchState = {
    ...patchState,
    latest: r.latest || patchState.latest,
    error: r.error,
    newBuilds: r.newBuilds.map((b) => b.build),
    lastCheck: r.checked ? Date.now() : patchState.lastCheck,
  };
  const st2 = readPatchState();
  if (st2) patchState.seen = st2.seen || {};
  if (r.newBuilds.length) {
    loadData(); // pick up the new parches_auto_*.md notes
    send('toast', { kind: 'warn', text: mt('m.newPatch', { builds: r.newBuilds.map((b) => b.build).join(', ') }) });
  }
  if (brain) brain.patchInfo = patchInfoLine();
  send('patch:status', patchState);
  return patchState;
}

/* ----------------------------------------------------------------- match detection (optional, aoe2companion public API) */
function onDetectedMatch(m) {
  const filled = brain.applyDetected(m);
  const team = m.allies.length || m.opponents.length > 1;
  if (team) {
    try {
      brain.setState({
        notes: `partida por equipos: aliados ${m.allies.map((p) => p.civ).join(', ') || '—'}; rivales ${m.opponents.map((p) => p.civ).join(', ')}`,
        source: 'detected',
      });
    } catch {
      /* ignore */
    }
  }
  send('match:detected', { match: m, text: matchwatch.describe(m), filled, state: brain.state, line: brain.stateLine() });
}
function setupMatchWatch() {
  matchPoller = matchwatch.createPoller({
    getProfileId: () => settings.get().profileId || null,
    enabled: () => settings.get().matchDetect === true && !!settings.get().profileId && win && win.isVisible(),
    onMatch: onDetectedMatch,
    log,
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
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    minWidth: 340,
    minHeight: 120,
    frame: false,
    transparent: false,
    backgroundColor: '#16130f',
    resizable: true,
    show: false,
    alwaysOnTop: s.alwaysOnTop !== false,
    skipTaskbar: false,
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  if (s.alwaysOnTop !== false) win.setAlwaysOnTop(true, 'screen-saver');
  // macOS: stay visible over the game when it runs full screen (own Space)
  if (process.platform === 'darwin' && s.alwaysOnTop !== false) {
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* older macOS */
    }
  }
  win.setOpacity(Number(s.opacity) || 0.94);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { theme: settings.get().theme || 'taverna' } }); // first paint already in the chosen look
  win.once('ready-to-show', () => win.show());
  let boundsTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      try {
        if (win && !win.isDestroyed() && !win.isMinimized() && win.isVisible())
          settings.set({ [settings.get().compact ? 'compactBounds' : 'fullBounds']: win.getBounds() });
      } catch {
        /* ignore */
      }
    }, 400);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ----------------------------------------------------------------- visual guide window */
function openGuide(arg = {}) {
  if (!guideWin || guideWin.isDestroyed()) {
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const w = Math.min(1040, sw - 40),
      h = Math.min(740, sh - 60);
    guideWin = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 700,
      minHeight: 480,
      show: false,
      backgroundColor: '#16130f',
      autoHideMenuBar: true,
      title: APP_NAME + ' — Guía',
      icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    guideWin.setMenuBarVisibility(false);
    guideWin.setAlwaysOnTop(true, 'screen-saver');
    guideWin.loadFile(path.join(__dirname, '..', 'renderer', 'guide.html'), { query: { theme: settings.get().theme || 'taverna' } });
    guideWin.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    guideWin.webContents.on('will-navigate', (e) => e.preventDefault());
    guideWin.on('close', (e) => {
      if (!app.isQuiting) {
        e.preventDefault();
        guideWin.hide();
      }
    });
    guideWin.once('ready-to-show', () => {
      guideWin.show();
      guideWin.webContents.send('guide:goto', arg);
    });
    return;
  }
  guideWin.show();
  guideWin.focus();
  guideWin.webContents.send('guide:goto', arg);
}
function toggleGuide() {
  if (guideWin && !guideWin.isDestroyed() && guideWin.isVisible()) guideWin.hide();
  else openGuide({});
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
  let y = cur.y;
  if (y + height > area.y + area.height) y = Math.max(area.y, area.y + area.height - height);
  win.setBounds({ x: cur.x, y, width, height });
  send('mode', { compact });
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else win.showInactive();
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
  if (mode === 'minimize') {
    win.minimize();
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.showInactive();
    }, 150);
    return;
  }
  win.blur();
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = settings.get().hotkeys || {};
  const failed = [];
  const reg = (acc, fn) => {
    if (!acc) return;
    try {
      if (!globalShortcut.register(acc, fn)) failed.push(acc);
    } catch {
      failed.push(acc);
    }
  };
  reg(hk.toggle, toggleWindow);
  reg(hk.ask, askHotkey);
  reg(hk.boPrev, () => send('hotkey', { name: 'boPrev' }));
  reg(hk.boNext, () => send('hotkey', { name: 'boNext' }));
  reg(hk.guide, toggleGuide);
  if (failed.length) log('hotkeys failed', failed);
  return failed;
}

function createTrayMenu() {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: mt('tray.show'), click: toggleWindow },
      { label: mt('tray.data'), click: () => shell.openPath(app.getPath('userData')) },
      { label: mt('tray.logs'), click: () => shell.openPath(userPath('logs')) },
      { type: 'separator' },
      {
        label: mt('tray.quit'),
        click: () => {
          app.isQuiting = true;
          app.quit();
        },
      },
    ])
  );
}
function createTray() {
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, '..', 'renderer', 'assets', 'tray.png'));
    if (process.platform === 'darwin') img = img.resize({ width: 18, height: 18 }); // menu-bar size
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    createTrayMenu();
    tray.on('click', toggleWindow);
  } catch (e) {
    log('tray failed', e.message);
  }
}

/* ----------------------------------------------------------------- ipc */
function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return publicSettings();
    const before = settings.get();
    const after = setSettings(patch);
    if (settings.lastRejected && settings.lastRejected.length) log('settings:set rejected keys', settings.lastRejected);
    if (patch.hotkeys) {
      const failed = registerHotkeys();
      if (failed.length) send('toast', { kind: 'warn', text: mt('m.hotkeyFail', { keys: failed.join(', ') }) });
    }
    if (typeof patch.opacity === 'number' && win) win.setOpacity(patch.opacity);
    if (typeof patch.alwaysOnTop === 'boolean' && win) win.setAlwaysOnTop(patch.alwaysOnTop, 'screen-saver');
    if (patch.provider && patch.provider !== before.provider) brain.reset();
    if ('logRetentionDays' in patch) pruneLogs(Number(settings.get().logRetentionDays) || 0);
    if ('uiLanguage' in patch && tray) {
      try {
        createTrayMenu();
      } catch {
        /* ignore */
      }
    }
    if ('theme' in patch && guideWin && !guideWin.isDestroyed()) guideWin.webContents.send('settings:changed', { theme: after.theme });
    return after;
  });

  ipcMain.handle('chat:ask', (_e, { text }) => core.ask(text, (ev) => send('chat:event', ev)));
  ipcMain.handle('chat:reset', () => core.reset());
  ipcMain.handle('chat:newGame', () => core.newGame());
  ipcMain.handle('chat:flag', (_e, comment) => core.flag(comment));
  ipcMain.handle('team:counters', () => core.teamCounters());
  ipcMain.handle('state:get', () => core.stateGet());
  ipcMain.handle('state:set', (_e, patch) => core.stateSet(patch));

  ipcMain.handle('tts:speak', async (_e, text) => {
    try {
      const r = await tts.speak(text, getSettings());
      if (!r) return { ok: true, audio: null };
      return { ok: true, audio: r.audio.toString('base64'), mime: r.mime, engine: r.engine, fallbackReason: r.fallbackReason || null };
    } catch (e) {
      log('tts error', e.message);
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('tts:voices', () => tts.VOICES);

  ipcMain.handle('bo:list', (_e, q) => core.boList(q));
  ipcMain.handle('bo:get', (_e, id) => core.boGet(id));
  ipcMain.handle('bo:import', (_e, text) => core.boImport(text));
  ipcMain.handle('bo:importFile', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import build order JSON',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    return core.boImportFiles(r.filePaths.map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') })));
  });

  ipcMain.handle('civs:list', () => core.civs());
  ipcMain.handle('data:info', () => ({
    ...dataInfo,
    ...core.dataCounts(),
    userData: app.getPath('userData'),
    version: app.getVersion(),
    secureStorage: (() => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    })(),
  }));
  ipcMain.handle('maps:list', () => core.maps());
  ipcMain.handle('profile:get', (_e, a) => core.profile(a || {}));

  // ---- visual guide
  ipcMain.handle('guide:open', (_e, arg) => {
    openGuide(arg || {});
    return true;
  });
  ipcMain.handle('guide:index', () => core.guideIndex());
  ipcMain.handle('guide:civ', (_e, key) => core.guideCiv(key));
  ipcMain.handle('guide:map', (_e, key) => core.guideMap(key));
  ipcMain.handle('guide:stats', () => core.guideStats());
  ipcMain.handle('guide:translate', (_e, a) => core.guideTranslate(a || {}));
  ipcMain.handle('guide:notes', (_e, q) => core.guideNotes(q));
  ipcMain.handle('guide:noteList', () => core.guideNoteList());
  ipcMain.handle('guide:noteText', (_e, a) => core.guideNoteText(a || {}));
  ipcMain.handle('guide:tool', (_e, a) => core.guideTool(a || {}));
  ipcMain.handle('guide:themes', () => core.guideThemes());
  // ---- patches and match detection
  ipcMain.handle('patch:status', () => ({ ...patchState, line: patchInfoLine() }));
  ipcMain.handle('patch:check', () => checkPatches(true));
  ipcMain.handle('match:searchProfile', async (_e, name) => {
    try {
      return { ok: true, profiles: await matchwatch.searchProfiles(name) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('match:now', async () => {
    if (!settings.get().profileId) return { ok: false, error: mt('m.noProfile') };
    const m = await matchPoller.now();
    const st = matchPoller.status();
    if (!m) return { ok: false, error: st.lastError ? mt('m.queryFail', { err: st.lastError }) : mt('m.noMatches') };
    return { ok: true, match: m, text: matchwatch.describe(m) };
  });
  ipcMain.handle(
    'match:apply',
    (_e, { force } = {}) => core.matchApply(matchPoller && matchPoller.status().lastMatch, { force }) || { ok: false, error: mt('m.noMatch') }
  );
  ipcMain.handle('logs:clear', () => {
    try {
      for (const f of fs.readdirSync(userPath('logs'))) if (/\.jsonl$/.test(f)) fs.unlinkSync(userPath('logs', f));
      for (const f of ['coach.log', 'coach.log.1']) {
        try {
          fs.unlinkSync(userPath(f));
        } catch {
          /* none */
        }
      }
      return true;
    } catch {
      return false;
    }
  });
  // ---- build-order catalog and icons
  ipcMain.handle('bo:catalog', () => core.boCatalog());
  ipcMain.handle('bo:noteText', (_e, a) => core.boNoteText(a || {}));
  ipcMain.handle('app:imgIndex', () => {
    if (imgIdx) return imgIdx;
    const base = path.join(BUNDLED_DATA, 'img');
    const idx = { base: pathToFileURL(base).href + '/', civs: {}, units: {}, techs: {}, buildings: {}, maps: {} };
    try {
      for (const f of fs.readdirSync(path.join(base, 'Maps'))) if (/\.(webp|png)$/.test(f)) idx.maps[f.replace(/\.(webp|png)$/, '')] = 'Maps/' + f;
    } catch {
      /* no map icons yet */
    }
    try {
      for (const c of Object.values(gd.civs)) idx.civs[c.key] = 'Civs/' + c.key.toLowerCase() + '.png';
      const tdir = path.join(dataInfo.dir || path.join(BUNDLED_DATA, 'game'), 'trees');
      for (const f of fs.readdirSync(tdir)) {
        const t = JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf8'));
        for (const n of [...(t.units_techs || []), ...(t.buildings || [])]) {
          const bucket =
            n.use_type === 'Unit'
              ? ['units', 'Unit']
              : n.use_type === 'Tech'
                ? ['techs', 'Tech']
                : n.use_type === 'Building'
                  ? ['buildings', 'Building']
                  : null;
          if (bucket && n.picture_index != null && !(n.name in idx[bucket[0]]) && fs.existsSync(path.join(base, bucket[1], n.picture_index + '.png')))
            idx[bucket[0]][n.name] = bucket[1] + '/' + n.picture_index + '.png';
        }
      }
    } catch (e) {
      log('imgIndex', e.message);
    }
    return (imgIdx = idx);
  });
  ipcMain.handle('data:sync', () => syncData(true));

  ipcMain.handle('app:openUserDir', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:openLogs', () => shell.openPath(userPath('logs')));
  ipcMain.handle('app:uninstall', () => uninstallApp());
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('window:minimize', () => win && win.minimize());
  ipcMain.handle('window:hide', () => win && win.hide());
  ipcMain.handle('window:quit', () => {
    app.isQuiting = true;
    app.quit();
  });
  ipcMain.handle('window:setCompact', (_e, compact) => {
    setCompact(!!compact);
    return settings.get().compact;
  });
  ipcMain.handle('window:release', () => releaseFocus());
}

/**
 * Settings → Datos → Desinstalar. Windows: hands over to the uninstaller the installer left next to the executable
 * (uninstall.ps1: closes the app, removes the program folder, shortcuts and the Apps & features entry, asks about the
 * user data) and quits. Mac: shows the app in Finder to drag it to the Trash and offers to delete the user data folder.
 */
async function uninstallApp() {
  const { spawn } = require('child_process');
  const dataDir = app.getPath('userData');
  if (process.platform === 'win32') {
    const script = path.join(path.dirname(process.execPath), 'uninstall.ps1');
    if (!fs.existsSync(script)) {
      await dialog.showMessageBox(win, { type: 'info', message: mt('m.uninstallNoScript'), detail: path.dirname(process.execPath) });
      return { ok: false };
    }
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [mt('m.uninstallGo'), mt('m.cancel')],
      defaultId: 1,
      cancelId: 1,
      message: mt('m.uninstallTitle'),
      detail: mt('m.uninstallBody', { data: dataDir }),
    });
    if (r.response !== 0) return { ok: false };
    const child = spawn(
      'cmd.exe',
      ['/c', 'start', '"Sancho Panza - desinstalar"', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: app.getPath('temp'),
      }
    );
    child.unref();
    app.isQuiting = true;
    setTimeout(() => app.quit(), 300);
    return { ok: true };
  }
  if (process.platform === 'darwin') {
    const bundle = process.execPath.replace(/\/Contents\/MacOS\/.*$/, '');
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [mt('m.uninstallMacShow'), mt('m.uninstallMacData'), mt('m.cancel')],
      defaultId: 0,
      cancelId: 2,
      message: mt('m.uninstallTitle'),
      detail: mt('m.uninstallMacBody', { app: bundle, data: dataDir }),
    });
    if (r.response === 0) shell.showItemInFolder(bundle);
    else if (r.response === 1) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch (e) {
        log('uninstall: data dir', e.message);
      }
      shell.showItemInFolder(bundle);
      app.isQuiting = true;
      setTimeout(() => app.quit(), 300);
    }
    return { ok: r.response !== 2 };
  }
  await dialog.showMessageBox(win, { type: 'info', message: mt('m.uninstallTitle'), detail: mt('m.uninstallLinux', { data: dataDir }) });
  return { ok: false };
}

/* ----------------------------------------------------------------- app */
app.whenReady().then(async () => {
  // installer probe (setup.ps1 after flipping the Electron fuses): the runtime starts → exit 0, nothing else
  if (process.argv.includes('--fuse-probe')) {
    app.exit(0);
    return;
  }
  settings = new Settings(userPath('settings.json'));
  loadData();
  brain = new Brain({
    gd,
    buildOrders,
    knowledge,
    strategy,
    getSettings,
    saveState: (st) => settings.set({ match: st, matchSavedAt: Date.now() }),
    log: logEvent,
  });
  brain.restoreState(settings.get().match, settings.get().matchSavedAt); // same game within the last hours → keep civs/map/age
  core = createCore({
    ctx: () => ({ gd, buildOrders, knowledge, strategy, brain }),
    userBuildDir: () => userPath('build_orders'),
    knowledgeDirs: () => [path.join(BUNDLED_DATA, 'knowledge'), userPath('knowledge')],
    uiLanguage: () => settings.get().uiLanguage,
    log,
  });
  registerIpc();
  // macOS: without an app menu, Cmd+C / Cmd+V / Cmd+Q do not work in the text fields
  if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  createWindow();
  createTray();
  const failed = registerHotkeys();
  if (failed.length) setTimeout(() => send('toast', { kind: 'warn', text: mt('m.hotkeyFail', { keys: failed.join(', ') }) }), 1500);
  pruneLogs(Number(settings.get().logRetentionDays) || 0);
  const smoke = process.argv.includes('--smoke');
  if (settings.get().dataAutoSync !== false && !smoke) setTimeout(() => syncData(false), STARTUP.dataSyncMs);
  if (!smoke) {
    setTimeout(() => checkPatches(false).catch((e) => log('patch check', e.message)), STARTUP.patchCheckMs);
    setupMatchWatch();
  } else checkPatches(false).catch(() => {});
  if (smoke) {
    // the headless self-check is a dev/CI tool: it lives in test/ (not shipped inside the packaged app)
    try {
      require('../../test/smoke').run({ win, guideWin: () => guideWin, openGuide, brain, settings, getSettings, decryptSecret, log });
    } catch (e) {
      console.log('SMOKE_ERRORS', JSON.stringify(['smoke runner not available: ' + e.message]));
      app.isQuiting = true;
      app.exit(1);
    }
  }
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
  /* stay in tray */
});
app.on('activate', () => {
  if (win) win.show();
});
