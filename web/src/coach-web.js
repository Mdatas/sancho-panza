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
const { DEFAULTS } = require('../../src/main/settings');
const { createCore } = require('../../src/main/api');
const matchwatch = require('../../src/main/matchwatch');
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'web';
const REVIEWED_PATCH = typeof __PATCH__ !== 'undefined' ? __PATCH__ : '';

const LS = {
  get: (k, d) => {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* blocked */
    }
  },
};
/** UI string in the interface language (the i18n table is a plain script on the page). */
function tw(key, vars = {}) {
  const T = window.I18N || {};
  const lang = settingsGet().uiLanguage || 'es';
  const v = (T[lang] && T[lang][key]) || (T.en && T.en[key]) || (T.es && T.es[key]) || key;
  return String(v).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
const listeners = {};
const on = (ch) => (cb) => {
  (listeners[ch] = listeners[ch] || []).push(cb);
  return () => {
    listeners[ch] = listeners[ch].filter((x) => x !== cb);
  };
};
const emit = (ch, p) =>
  (listeners[ch] || []).forEach((cb) => {
    try {
      cb(p);
    } catch (e) {
      console.warn(e);
    }
  });

let gd,
  buildOrders,
  knowledge,
  strategy,
  brain,
  core,
  IMG = null,
  lastMatch = null;
const settingsGet = () => ({ ...DEFAULTS, ...LS.get('sp.settings', {}), compact: false });
const publicSettings = () => {
  const s = settingsGet();
  return { ...s, anthropicApiKeySet: !!s.anthropicApiKey, openaiApiKeySet: !!s.openaiApiKey, web: true };
};

/* Data files (built by web/build.mjs, versioned URLs so a new release is never served from an old cache):
 *   data/bundle.json    game data + civ/map strategy profiles + icon index  (needed before anything works)
 *   data/rtsbuilds.json step-by-step build orders (GPL-3.0, kept as its own file — see LICENSE §7)
 *   data/notes.json     the strategy notes (3 MB): loaded in parallel, parsed when it arrives; chat / notes search wait for it */
const DATA_URL = (name) => `data/${name}?v=${encodeURIComponent(VERSION)}`;
async function loadJson(name) {
  const res = await fetch(DATA_URL(name));
  if (!res.ok) throw new Error(tw('w.loadFail', { err: res.status }));
  const b = await res.json();
  if (b.version && b.version !== VERSION) {
    try {
      window.dispatchEvent(new CustomEvent('sp:stale'));
    } catch {
      /* */
    }
  }
  return b;
}
const notesLoaded = loadJson('notes.json');
const ready = (async () => {
  const [b, rb] = await Promise.all([loadJson('bundle.json'), loadJson('rtsbuilds.json')]);
  vfs._load(b.files);
  vfs._load(rb.files);
  IMG = b.imgIndex;
  IMG.base = 'img/';
  vfs._load(LS.get('sp.userFiles', {})); // user-imported builds
  gd = new GameData('/data/game').load();
  buildOrders = new BuildOrders(['/data/build_orders/rtsbuilds', '/data/build_orders/extracted', '/user/build_orders']).load();
  knowledge = new Knowledge(['/data/knowledge']).load(); // the notes arrive separately (see readyNotes)
  strategy = new Strategy(['/data/knowledge']).load();
  for (const c of Object.values(gd.civs)) IMG.civs[c.key] = 'Civs/' + c.key.toLowerCase() + '.png';
  brain = new Brain({
    gd,
    buildOrders,
    knowledge,
    strategy,
    getSettings: settingsGet,
    saveState: (st) => {
      LS.set('sp.state', st);
      LS.set('sp.stateAt', Date.now());
    },
    log: () => {},
  });
  // same match within the last hours (page reloaded, phone locked, guide opened in its own tab) → keep civs / map / age
  brain.restoreState(LS.get('sp.state', null), LS.get('sp.stateAt', 0));
  core = createCore({
    ctx: () => ({ gd, buildOrders, knowledge, strategy, brain }),
    userBuildDir: () => '/user/build_orders',
    knowledgeDirs: () => ['/data/knowledge'],
    uiLanguage: () => settingsGet().uiLanguage,
  });
})();
const readyNotes = (async () => {
  await ready;
  const n = await notesLoaded;
  vfs._load(n.files);
  knowledge.load();
  core.invalidate();
  try {
    window.dispatchEvent(new CustomEvent('sp:notes'));
  } catch {
    /* */
  }
})();
readyNotes.catch(() => {});
const R =
  (fn) =>
  async (...a) => {
    await ready;
    return fn(...a);
  };
const RN =
  (fn) =>
  async (...a) => {
    await readyNotes;
    return fn(...a);
  };

/* ---------- voice: the browser's own speech synthesis (Edge neural voices are not reachable from a web page) */
const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
const LANG_TAG = { es: 'es', en: 'en', de: 'de', pt: 'pt', zh: 'zh', vi: 'vi', ko: 'ko' };
function pickVoice(s) {
  if (!synth) return null;
  const vs = synth.getVoices();
  const named = vs.find((v) => v.name === s.ttsVoice);
  if (named) return named;
  const lang = LANG_TAG[s.uiLanguage || 'es'] || 'es';
  return vs.find((v) => /^es-AR/i.test(v.lang) && lang === 'es') || vs.find((v) => v.lang.toLowerCase().startsWith(lang)) || null;
}
function speakWeb(text) {
  return new Promise((resolve) => {
    if (!synth) return resolve({ ok: false, error: tw('w.noVoice') });
    const s = settingsGet();
    if (s.ttsEngine === 'off') return resolve({ ok: true, audio: null });
    const clean = String(text || '')
      .replace(/[*_#`>]/g, '')
      .replace(/\n-{3,}\n/g, '. ')
      .slice(0, 1500);
    synth.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    const v = pickVoice(s);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    } else u.lang = (s.uiLanguage || 'es') === 'es' ? 'es-AR' : s.uiLanguage || 'es';
    u.rate = Math.max(0.6, Math.min(1.8, Number(s.ttsRate) || 1.1));
    u.onend = u.onerror = () => {};
    synth.speak(u);
    resolve({ ok: true, audio: null, engine: 'browser' });
  });
}

function imgIndex() {
  return IMG;
}
function pickFile(accept) {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.multiple = true;
    i.onchange = async () => resolve(await Promise.all([...i.files].map((f) => f.text().then((t) => ({ name: f.name, text: t })))));
    i.click();
  });
}

window.coach = {
  web: true,
  /** iframe guide: take the match state from the parent page (same browser storage, but each page has its own brain) */
  setStateFromParent: (st) => {
    if (brain && st) brain.state = { ...brain.state, ...st };
  },
  settings: {
    get: R(() => publicSettings()),
    set: R((patch) => {
      const cur = LS.get('sp.settings', {});
      const next = { ...cur, ...(patch || {}) };
      if ('ttsVoice' in (patch || {})) next.voiceChosen = true;
      LS.set('sp.settings', next);
      if (patch && patch.provider && patch.provider !== cur.provider) brain.reset();
      return publicSettings();
    }),
  },
  chat: {
    ask: RN((text) => core.ask(text, (ev) => emit('chat:event', ev))),
    advise: RN((text) => core.advise(text, (ev) => emit('chat:event', ev))),
    sheet: RN((question) => core.sheet(question || '')),
    reset: R(() => core.reset()),
    newGame: R(() => core.newGame()),
    flag: R((c) => core.flag(c)),
    onEvent: on('chat:event'),
  },
  state: { get: R(() => core.stateGet()), set: R((patch) => core.stateSet(patch)) },
  team: { counters: R(() => core.teamCounters()) },
  tts: {
    speak: (text) => speakWeb(text),
    stop: () => {
      try {
        synth && synth.cancel();
      } catch {
        /* */
      }
    },
    voices: async () => {
      const base = [{ id: '', label: tw('w.autoVoice') }];
      if (!synth) return base;
      let vs = synth.getVoices();
      if (!vs.length) {
        await new Promise((r) => setTimeout(r, 400));
        vs = synth.getVoices();
      }
      return base.concat(vs.filter((v) => /^(es|en|de|pt|zh|vi|ko)/i.test(v.lang)).map((v) => ({ id: v.name, label: `${v.name} (${v.lang})` })));
    },
  },
  bo: {
    list: R((q) => core.boList(q)),
    get: R((id) => core.boGet(id)),
    import: R((text) => core.boImport(text)), // vfs persists /user/ files to localStorage by itself
    importFile: R(async () => {
      const fs = await pickFile('.json,application/json');
      if (!fs.length) return { ok: false, canceled: true };
      return core.boImportFiles(fs);
    }),
    catalog: RN(() => core.boCatalog()),
    noteText: RN((a) => core.boNoteText(a || {})),
  },
  civs: R(() => core.civs()),
  maps: R(() => core.maps()),
  profile: R((kind, q) => core.profile({ kind, q })),
  data: {
    info: RN(() => ({ ...core.dataCounts(), lastSync: null, message: 'web', version: VERSION })),
    sync: async () => ({ ok: true, message: 'web' }),
    onStatus: on('data:status'),
  },
  app: {
    imgIndex: R(imgIndex),
    openUserDir: async () => false,
    openLogs: async () => false,
    openExternal: async (u) => {
      if (/^https?:/.test(u)) window.open(u, '_blank', 'noopener');
    },
  },
  window: { minimize: async () => {}, hide: async () => {}, quit: async () => {}, setCompact: async () => {}, release: async () => {} },
  guide: {
    open: async (arg) => {
      const q = new URLSearchParams();
      if (arg && arg.civ) q.set('civ', arg.civ);
      if (arg && arg.tab) q.set('tab', arg.tab);
      if (arg && arg.map) q.set('map', arg.map);
      LS.set('sp.state', brain ? brain.state : {});
      LS.set('sp.stateAt', Date.now());
      window.open('guide.html' + (q.toString() ? '?' + q : ''), '_blank');
      return true;
    },
    index: R(() => core.guideIndex()),
    civ: R((key) => core.guideCiv(key)),
    map: R((key) => core.guideMap(key)),
    stats: R(() => core.guideStats()),
    notes: RN((q) => core.guideNotes(q)),
    noteList: RN(() => core.guideNoteList()),
    noteText: RN((a) => core.guideNoteText(a || {})),
    translate: R((a) => core.guideTranslate(a || {})),
    themes: RN(() => core.guideThemes()),
    tool: R((name, input) => core.guideTool({ name, input })),
    onGoto: (cb) => {
      const off = on('guide:goto')(cb);
      const p = new URLSearchParams(location.search);
      const arg = {};
      for (const k of ['civ', 'tab', 'map']) if (p.get(k)) arg[k] = p.get(k);
      if (Object.keys(arg).length) setTimeout(() => cb(arg), 300);
      return off;
    },
  },
  patch: {
    status: async () => ({
      reviewed: REVIEWED_PATCH,
      latest: null,
      lastCheck: null,
      line: REVIEWED_PATCH ? 'Notas revisadas contra el parche ' + REVIEWED_PATCH : '',
    }),
    check: async () => ({ ok: true }),
    onStatus: on('patch:status'),
  },
  match: {
    searchProfile: async (n) => {
      try {
        return { ok: true, profiles: await matchwatch.searchProfiles(n) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    now: R(async () => {
      const s = settingsGet();
      if (!s.profileId) return { ok: false, error: tw('m.noProfile') };
      try {
        lastMatch = await matchwatch.latestMatch(s.profileId);
      } catch (e) {
        return { ok: false, error: tw('m.queryFail', { err: e.message }) };
      }
      if (!lastMatch) return { ok: false, error: tw('m.noMatches') };
      return { ok: true, match: lastMatch, text: matchwatch.describe(lastMatch) };
    }),
    apply: R(({ force } = {}) => core.matchApply(lastMatch, { force }) || { ok: false, error: tw('m.noMatch') }),
    onDetected: on('match:detected'),
  },
  logs: { clear: async () => true },
  screen: {
    test: async () => ({ ok: false, error: tw('screen.webOnly') }),
    calibrate: async () => ({ ok: false, error: tw('screen.webOnly') }),
    status: async () => null,
    onReading: on('screen:reading'),
  },
  onHotkey: on('hotkey'),
  onToast: on('toast'),
  onMode: on('mode'),
};
const showToast = (text, cls = 'toast err') => {
  const put = () => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 8000);
  };
  if (document.body) put();
  else document.addEventListener('DOMContentLoaded', put);
};
ready.catch((e) => showToast(String(e.message || e)));
let staleShown = false;
window.addEventListener('sp:stale', () => {
  if (!staleShown) {
    staleShown = true;
    showToast(tw('w.stale'), 'toast warn');
  }
});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
// Hide desktop-only settings (global hotkeys, window opacity / always-on-top, data folders) in the browser.
document.addEventListener('DOMContentLoaded', () => {
  const hide = (el) => {
    if (el) el.classList.add('desktopOnly');
  };
  ['set.hotkeys', 'set.hkHelp', 'set.window'].forEach((k) => hide(document.querySelector(`[data-i18n="${k}"]`)));
  hide(document.querySelector('#screenBox'));
  ['#hkAsk', '#setFocusReturn', '#setOpacity', '#setOnTop'].forEach((sel) => {
    const el = document.querySelector(sel);
    hide(el && (el.closest('.grid2') || el.closest('label')));
  });
  const sapi = document.querySelector('#setTtsEngine option[value="sapi"]');
  if (sapi) sapi.remove();
  const edge = document.querySelector('#setTtsEngine option[value="edge"]');
  if (edge) edge.textContent = tw('w.browserVoice');
});
