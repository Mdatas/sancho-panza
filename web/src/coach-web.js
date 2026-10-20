'use strict';
/**
 * Web build of Sancho Panza: implements window.coach (the API the desktop preload exposes) in the browser,
 * so the same renderer (index.html / app.js / guide.html / guide.js) runs on phones and any browser.
 * Data: data/bundle.json (game data, build orders, knowledge notes) loaded into an in-memory fs.
 * Keys and settings stay in this browser's localStorage; nothing goes to any server except the AI provider you choose.
 */
const vfs = require('fs'); // aliased to web/src/vfs.js by the bundler
const { GameData } = require('../../src/main/engine/gamedata');
const { BuildOrders } = require('../../src/main/engine/buildorders');
const { Knowledge } = require('../../src/main/engine/knowledge');
const { Strategy } = require('../../src/main/engine/strategy');
const { Brain } = require('../../src/main/brain/brain');
const { makeDispatcher } = require('../../src/main/brain/tools');
const { DEFAULTS } = require('../../src/main/settings');
const guideData = require('../../src/main/guideData');
const bocatalog = require('../../src/main/bocatalog');
const matchwatch = require('../../src/main/matchwatch');
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'web';
const REVIEWED_PATCH = typeof __PATCH__ !== 'undefined' ? __PATCH__ : '';

const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } } };
const listeners = {}; const on = (ch) => (cb) => { (listeners[ch] = listeners[ch] || []).push(cb); return () => { listeners[ch] = listeners[ch].filter(x => x !== cb); }; };
const emit = (ch, p) => (listeners[ch] || []).forEach(cb => { try { cb(p); } catch (e) { console.warn(e); } });

let gd, buildOrders, knowledge, strategy, brain, IMG = null, catCache = null, civStatsCache = null, lastMatch = null;
const settingsGet = () => ({ ...DEFAULTS, ...LS.get('sp.settings', {}), compact: false });
const publicSettings = () => { const s = settingsGet(); return { ...s, anthropicApiKeySet: !!s.anthropicApiKey, openaiApiKeySet: !!s.openaiApiKey, web: true }; };

const ready = (async () => {
  const res = await fetch('data/bundle.json', { cache: 'force-cache' });
  if (!res.ok) throw new Error('No pude cargar los datos (' + res.status + ')');
  const b = await res.json();
  vfs._load(b.files); IMG = b.imgIndex; IMG.base = 'img/';
  vfs._load(LS.get('sp.userFiles', {})); // user-imported builds
  gd = new GameData('/data/game').load();
  buildOrders = new BuildOrders(['/data/build_orders/rtsbuilds', '/user/build_orders']).load();
  knowledge = new Knowledge(['/data/knowledge']).load();
  strategy = new Strategy(['/data/knowledge']).load();
  for (const c of Object.values(gd.civs)) IMG.civs[c.key] = 'Civs/' + c.key.toLowerCase() + '.png';
  brain = new Brain({ gd, buildOrders, knowledge, strategy, getSettings: settingsGet, saveState: (st) => LS.set('sp.state', st), log: () => {} });
  if (/guide\.html/.test(location.pathname)) { const st = LS.get('sp.state', null); if (st) brain.state = { ...brain.state, ...st }; }
})();
const R = (fn) => async (...a) => { await ready; return fn(...a); };

/* ---------- voice: the browser's own speech synthesis (Edge neural voices are not reachable from a web page) */
const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
const LANG_TAG = { es: 'es', en: 'en', de: 'de', pt: 'pt', zh: 'zh', vi: 'vi', ko: 'ko' };
function pickVoice(s) {
  if (!synth) return null; const vs = synth.getVoices();
  const named = vs.find(v => v.name === s.ttsVoice); if (named) return named;
  const lang = LANG_TAG[s.uiLanguage || 'es'] || 'es';
  return vs.find(v => /^es-AR/i.test(v.lang) && lang === 'es') || vs.find(v => v.lang.toLowerCase().startsWith(lang)) || null;
}
function speakWeb(text) {
  return new Promise((resolve) => {
    if (!synth) return resolve({ ok: false, error: 'Este navegador no tiene voz (speechSynthesis).' });
    const s = settingsGet(); if (s.ttsEngine === 'off') return resolve({ ok: true, audio: null });
    const clean = String(text || '').replace(/[*_#`>]/g, '').replace(/\n-{3,}\n/g, '. ').slice(0, 1500);
    synth.cancel(); const u = new SpeechSynthesisUtterance(clean); const v = pickVoice(s);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = (s.uiLanguage || 'es') === 'es' ? 'es-AR' : (s.uiLanguage || 'es');
    u.rate = Math.max(0.6, Math.min(1.8, Number(s.ttsRate) || 1.1));
    u.onend = u.onerror = () => {}; synth.speak(u); resolve({ ok: true, audio: null, engine: 'browser' });
  });
}

function imgIndex() { return IMG; }
function pickFile(accept) { return new Promise(resolve => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.multiple = true; i.onchange = async () => resolve(await Promise.all([...i.files].map(f => f.text().then(t => ({ name: f.name, text: t }))))); i.click(); }); }

window.coach = {
  web: true,
  /** iframe guide: take the match state from the parent page (same browser storage, but each page has its own brain) */
  setStateFromParent: (st) => { if (brain && st) brain.state = { ...brain.state, ...st }; },
  settings: {
    get: R(() => publicSettings()),
    set: R((patch) => { const cur = LS.get('sp.settings', {}); const next = { ...cur, ...(patch || {}) }; if ('ttsVoice' in (patch || {})) next.voiceChosen = true; LS.set('sp.settings', next); if (patch && patch.provider && patch.provider !== cur.provider) brain.reset(); return publicSettings(); }),
  },
  chat: {
    ask: R(async (text) => { const t0 = Date.now(); try { const r = await brain.ask(text, { onEvent: ev => emit('chat:event', ev) }); return { ok: true, id: r.id, text: r.text, model: r.model, cost: r.cost, totals: r.totals, tools: r.toolLog.map(t => t.name), state: r.state, stateLine: r.stateLine, ms: Date.now() - t0 }; } catch (e) { return { ok: false, error: e.message }; } }),
    reset: R(() => { brain.reset(); return true; }), newGame: R(() => ({ state: brain.newGame(), line: brain.stateLine() })), flag: R(() => true), onEvent: on('chat:event'),
  },
  state: { get: R(() => ({ state: brain.state, line: brain.stateLine() })), set: R((patch) => { try { return { ok: true, state: brain.setState(patch), line: brain.stateLine() }; } catch (e) { return { ok: false, error: e.message }; } }) },
  team: { counters: R(() => { try { return brain.teamCounters(); } catch (e) { return { age: 3, rows: [], error: e.message }; } }) },
  tts: {
    speak: (text) => speakWeb(text), stop: () => { try { synth && synth.cancel(); } catch { /* */ } },
    voices: async () => { const base = [{ id: '', label: 'Automática (voz del sistema según el idioma)' }]; if (!synth) return base; let vs = synth.getVoices(); if (!vs.length) { await new Promise(r => setTimeout(r, 400)); vs = synth.getVoices(); } return base.concat(vs.filter(v => /^(es|en|de|pt|zh|vi|ko)/i.test(v.lang)).map(v => ({ id: v.name, label: `${v.name} (${v.lang})` }))); },
  },
  bo: {
    list: R((q) => buildOrders.search({ ...(q || {}), limit: (q && q.limit) || 100 })),
    get: R((id) => { const bo = buildOrders.get(id); return bo ? { ...bo, text: buildOrders.toText(bo) } : null; }),
    import: R((text) => { try { const bo = buildOrders.importJson(text, '/user/build_orders'); catCache = null; return { ok: true, bo }; } catch (e) { return { ok: false, error: e.message }; } }),
    importFile: R(async () => { const fs = await pickFile('.json,application/json'); if (!fs.length) return { ok: false, canceled: true }; const out = fs.map(f => { try { return buildOrders.importJson(f.text, '/user/build_orders'); } catch (e) { return { error: `${f.name}: ${e.message}` }; } }); catCache = null; return { ok: true, imported: out }; }),
    catalog: R(() => catCache || (catCache = bocatalog.catalog({ buildOrders, knowledge, gd }))),
    noteText: R(({ file, stem }) => bocatalog.noteText(knowledge, file, stem)),
  },
  civs: R(() => Object.values(gd.civs).map(c => ({ key: c.key, name_en: c.name_en, name_es: c.name_es })).sort((a, b) => a.name_en.localeCompare(b.name_en))),
  maps: R(() => strategy.mapNames()),
  profile: R((kind, q) => { if (kind === 'map') { const p = strategy.findMap(q); return p ? p.body : null; } const c = gd.findCiv(q); const p = c && strategy.civ(c.key); return p ? p.body : null; }),
  data: {
    info: R(() => ({ civs: Object.keys(gd.civs).length, units: Object.values(gd.units).filter(u => u.name_en).length, buildOrders: buildOrders.list.length, notes: knowledge.sections.length, civProfiles: Object.keys(strategy.civs).length, mapProfiles: Object.keys(strategy.maps).length, source: gd.sourceCommit, lastSync: null, message: 'web', version: VERSION })),
    sync: async () => ({ ok: true, message: 'web' }), onStatus: on('data:status'),
  },
  app: {
    imgIndex: R(imgIndex), openUserDir: async () => false, openLogs: async () => false,
    openExternal: async (u) => { if (/^https?:/.test(u)) window.open(u, '_blank', 'noopener'); },
  },
  window: { minimize: async () => {}, hide: async () => {}, quit: async () => {}, setCompact: async () => {}, release: async () => {} },
  guide: {
    open: async (arg) => { const q = new URLSearchParams(); if (arg && arg.civ) q.set('civ', arg.civ); if (arg && arg.tab) q.set('tab', arg.tab); if (arg && arg.map) q.set('map', arg.map); LS.set('sp.state', brain ? brain.state : {}); window.open('guide.html' + (q.toString() ? '?' + q : ''), '_blank'); return true; },
    index: R(() => ({ ...guideData.index({ gd, strategy }), state: { ...brain.state } })),
    civ: R((key) => guideData.civView({ gd, strategy, key, stats: civStatsCache || (civStatsCache = guideData.parseCivStats(['/data/knowledge'])) })),
    map: R((key) => guideData.mapView({ strategy, key })),
    stats: R(() => civStatsCache || (civStatsCache = guideData.parseCivStats(['/data/knowledge']))),
    notes: R((q) => guideData.searchNotes({ knowledge, q })), noteList: R(() => guideData.listNotes({ knowledge })),
    noteText: R(({ file, title }) => guideData.noteText({ knowledge, file, title })),
    translate: R(async ({ text, lang }) => { try { return { ok: true, text: await brain.translate(text, lang) }; } catch (e) { return { ok: false, error: e.message }; } }),
    tool: R((name, input) => { if (!['lookup_unit', 'find_counters', 'civ_matchup', 'compare_units'].includes(name)) return { error: 'not allowed' }; try { return makeDispatcher({ gd, buildOrders, knowledge, strategy, lang: 'es', state: { ...brain.state }, onState: () => {} })(name, input || {}); } catch (e) { return { error: e.message }; } }),
    onGoto: (cb) => { const off = on('guide:goto')(cb); const p = new URLSearchParams(location.search); const arg = {}; for (const k of ['civ', 'tab', 'map']) if (p.get(k)) arg[k] = p.get(k); if (Object.keys(arg).length) setTimeout(() => cb(arg), 300); return off; },
  },
  patch: {
    status: async () => ({ reviewed: REVIEWED_PATCH, latest: null, lastCheck: null, line: REVIEWED_PATCH ? 'Notas revisadas contra el parche ' + REVIEWED_PATCH : '' }),
    check: async () => ({ ok: true }), onStatus: on('patch:status'),
  },
  match: {
    searchProfile: async (n) => { try { return { ok: true, profiles: await matchwatch.searchProfiles(n) }; } catch (e) { return { ok: false, error: e.message }; } },
    now: R(async () => { const s = settingsGet(); if (!s.profileId) return { ok: false, error: 'Elegí tu perfil en Ajustes → Partida automática.' }; try { lastMatch = await matchwatch.latestMatch(s.profileId); } catch (e) { return { ok: false, error: 'No se pudo consultar (' + e.message + ')' }; } if (!lastMatch) return { ok: false, error: 'No encontré partidas para ese perfil.' }; return { ok: true, match: lastMatch, text: matchwatch.describe(lastMatch) }; }),
    apply: R(({ force } = {}) => { if (!lastMatch) return { ok: false, error: 'Sin partida detectada.' }; const filled = brain.applyDetected(lastMatch, { force: !!force }); return { ok: true, filled, state: brain.state, line: brain.stateLine() }; }),
    onDetected: on('match:detected'),
  },
  logs: { clear: async () => true },
  onHotkey: on('hotkey'), onToast: on('toast'), onMode: on('mode'),
};
ready.catch(e => { document.addEventListener('DOMContentLoaded', () => { const d = document.createElement('div'); d.className = 'toast err'; d.textContent = String(e.message || e); document.body.appendChild(d); }); });
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
// Hide desktop-only settings (global hotkeys, window opacity / always-on-top, data folders) in the browser.
document.addEventListener('DOMContentLoaded', () => {
  const hide = (el) => { if (el) el.classList.add('desktopOnly'); };
  ['set.hotkeys', 'set.hkHelp', 'set.window'].forEach(k => hide(document.querySelector(`[data-i18n="${k}"]`)));
  ['#hkAsk', '#setFocusReturn', '#setOpacity', '#setOnTop'].forEach(sel => { const el = document.querySelector(sel); hide(el && (el.closest('.grid2') || el.closest('label'))); });
  const sapi = document.querySelector('#setTtsEngine option[value="sapi"]'); if (sapi) sapi.remove();
  const edge = document.querySelector('#setTtsEngine option[value="edge"]'); if (edge) edge.textContent = 'Voz del navegador / sistema';
});
