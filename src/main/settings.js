'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  provider: 'anthropic', // 'anthropic' | 'openai'
  providerPreset: '', // UI preset id (claude, openai, gemini, groq, openrouter, nvidia, ollama, custom)
  anthropicApiKey: '',
  anthropicModel: 'claude-sonnet-5-5',
  anthropicBaseUrl: '',
  openaiBaseUrl: 'http://localhost:11434/v1',
  openaiApiKey: '',
  openaiModel: 'qwen2.5:14b',
  extractState: true, // extract match facts from each message (runs in parallel with the answer)
  extractModel: 'claude-haiku-5-5', // cheap model for that extraction step (Claude provider only)
  streaming: true, // stream the answer while the model writes it (falls back to one block when the server cannot)
  language: 'auto', // answer language: 'auto' | 'es' | 'en'
  uiLanguage: 'es', // interface language
  voiceOut: true, // read answers aloud
  ttsEngine: 'edge', // 'edge' | 'sapi' | 'off'
  ttsVoice: 'es-AR-ElenaNeural',
  ttsRate: 1.15,
  boSpeak: false, // read build-order steps aloud
  boTimer: true, // build-order clock: auto-advance steps by their time stamp
  hotkeys: { toggle: 'F9', ask: 'F10', boPrev: 'F7', boNext: 'F8', guide: 'F6' },
  focusReturn: 'blur', // after sending: 'blur' | 'minimize' | 'none'
  opacity: 0.94,
  alwaysOnTop: true,
  compact: true,
  compactBounds: null,
  fullBounds: null,
  match: {}, // persisted match state (see brain.js EMPTY_STATE); restored when less than a few hours old
  matchSavedAt: 0,
  lastBuildOrder: '',
  dataAutoSync: true,
  experimentalPrivacy: false, // ON enables: masked keys in the UI, amnesiac mode
  experimentalCache: true, // prompt cache: static rules / per-question notes in separate cached blocks (OFF = one block)
  rememberKey: true, // (experimentalPrivacy only) false = "modo amnésico": API keys live only in memory for this session
  logRetentionDays: 30, // delete conversation logs older than this many days (0 = keep forever)
  patchWatch: true, // check the official news feed for new AoE2 patches (once a day)
  matchDetect: false, // opt-in: read the player's current match from the aoe2companion public API
  profileId: '', // public AoE2 profile id (from the profile search in Settings)
  profileName: '',
  keyOk: false, // set after the first successful answer / key test (hides the welcome popup)
  welcomeHide: false, // "No mostrar más" in the welcome popup
  modelChosen: false, // the player picked a model himself (migrations leave it alone)
  voiceChosen: false, // the player picked a voice himself
};

/** What each key may hold. Anything else sent to settings.set is dropped (and reported) instead of stored. */
const T = {
  str: (v) => (typeof v === 'string' ? v.slice(0, 4000) : undefined),
  bool: (v) => (typeof v === 'boolean' ? v : undefined),
  num: (min, max) => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined),
  enumOf: (xs) => (v) => (xs.includes(v) ? v : undefined),
  bounds: (v) =>
    v === null
      ? null
      : v && typeof v === 'object' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(v[k]))
        ? { x: Math.round(v.x), y: Math.round(v.y), width: Math.round(v.width), height: Math.round(v.height) }
        : undefined,
  obj: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined),
  hotkeys: (v) => {
    if (!v || typeof v !== 'object') return undefined;
    const out = {};
    for (const k of ['toggle', 'ask', 'boPrev', 'boNext', 'guide']) if (k in v) out[k] = typeof v[k] === 'string' ? v[k].trim().slice(0, 40) : '';
    return out;
  },
};
const SCHEMA = {
  provider: T.enumOf(['anthropic', 'openai']),
  providerPreset: T.str,
  anthropicApiKey: T.str,
  anthropicModel: T.str,
  anthropicBaseUrl: T.str,
  openaiBaseUrl: T.str,
  openaiApiKey: T.str,
  openaiModel: T.str,
  extractState: T.bool,
  extractModel: T.str,
  streaming: T.bool,
  language: T.str,
  uiLanguage: T.enumOf(['es', 'en', 'de', 'pt', 'zh', 'vi', 'ko']),
  voiceOut: T.bool,
  ttsEngine: T.enumOf(['edge', 'sapi', 'off']),
  ttsVoice: T.str,
  ttsRate: T.num(0.5, 2),
  boSpeak: T.bool,
  boTimer: T.bool,
  hotkeys: T.hotkeys,
  focusReturn: T.enumOf(['blur', 'minimize', 'none']),
  opacity: T.num(0.2, 1),
  alwaysOnTop: T.bool,
  compact: T.bool,
  compactBounds: T.bounds,
  fullBounds: T.bounds,
  match: T.obj,
  matchSavedAt: T.num(0, 1e14),
  lastBuildOrder: T.str,
  dataAutoSync: T.bool,
  experimentalPrivacy: T.bool,
  experimentalCache: T.bool,
  rememberKey: T.bool,
  logRetentionDays: T.num(0, 3650),
  patchWatch: T.bool,
  matchDetect: T.bool,
  profileId: T.str,
  profileName: T.str,
  keyOk: T.bool,
  welcomeHide: T.bool,
  modelChosen: T.bool,
  voiceChosen: T.bool,
};

/** Keep only known keys with values of the right shape. Returns { patch, rejected }. */
function sanitizePatch(patch) {
  const out = {},
    rejected = [];
  if (!patch || typeof patch !== 'object') return { patch: out, rejected: ['(not an object)'] };
  for (const [k, v] of Object.entries(patch)) {
    const check = SCHEMA[k];
    if (!check) {
      rejected.push(k);
      continue;
    }
    const clean = check(v);
    if (clean === undefined) {
      rejected.push(k);
      continue;
    }
    out[k] = clean;
  }
  return { patch: out, rejected };
}

class Settings {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.load();
  }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw, hotkeys: { ...DEFAULTS.hotkeys, ...(raw.hotkeys || {}) }, match: { ...(raw.match || {}) } };
      // migrate v0.1 hotkey name
      if (raw.hotkeys && raw.hotkeys.talk && !raw.hotkeys.ask) this.data.hotkeys.ask = raw.hotkeys.talk;
      if (raw.anthropicModel === 'claude-haiku-5-5' && !raw.modelChosen) this.data.anthropicModel = DEFAULTS.anthropicModel;
      // v0.13: default voice is Elena (es-AR); move the old default unless the player picked a voice himself
      if ((!raw.ttsVoice || raw.ttsVoice === 'es-AR-TomasNeural') && !raw.voiceChosen) this.data.ttsVoice = DEFAULTS.ttsVoice;
    } catch (e) {
      // a missing file is normal (first run); a corrupt one is kept aside so the player can recover the key by hand
      if (e && e.code !== 'ENOENT') {
        try {
          fs.copyFileSync(this.file, this.file + '.corrupt');
        } catch {
          /* ignore */
        }
      }
      this.data = { ...DEFAULTS };
    }
    return this.data;
  }
  get() {
    return this.data;
  }
  /** Apply a patch (unknown keys / wrong types are dropped) and save atomically. Returns the new settings. */
  set(patch) {
    const { patch: p, rejected } = sanitizePatch(patch);
    this.lastRejected = rejected;
    this.data = { ...this.data, ...p };
    if (p.hotkeys) this.data.hotkeys = { ...this.data.hotkeys, ...p.hotkeys };
    if (p.anthropicModel) this.data.modelChosen = true;
    if (p.ttsVoice) this.data.voiceChosen = true;
    this.save();
    return this.data;
  }
  /** Write to a temp file and rename: a crash mid-write can never leave a truncated settings.json (that would lose the API key). */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings, DEFAULTS, SCHEMA, sanitizePatch };
