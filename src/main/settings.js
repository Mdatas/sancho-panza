'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  provider: 'anthropic',            // 'anthropic' | 'openai'
  anthropicApiKey: '',
  anthropicModel: 'claude-sonnet-5-5',
  anthropicBaseUrl: '',
  openaiBaseUrl: 'http://localhost:11434/v1',
  openaiApiKey: '',
  openaiModel: 'qwen2.5:14b',
  extractState: true,               // extract match facts from each message before answering
  extractModel: 'claude-haiku-5-5', // cheap model for that extraction step (Claude provider only)
  language: 'auto',                 // answer language: 'auto' | 'es' | 'en'
  uiLanguage: 'es',                 // interface language
  voiceOut: true,                   // read answers aloud
  ttsEngine: 'edge',                // 'edge' | 'sapi' | 'off'
  ttsVoice: 'es-AR-ElenaNeural',
  ttsRate: 1.15,
  boSpeak: false,                   // read build-order steps aloud
  hotkeys: { toggle: 'F9', ask: 'F10', boPrev: 'F7', boNext: 'F8', guide: 'F6' },
  focusReturn: 'blur',              // after sending: 'blur' | 'minimize' | 'none'
  opacity: 0.94,
  alwaysOnTop: true,
  compact: true,
  compactBounds: null,
  fullBounds: null,
  match: {},                        // persisted match state (see brain.js EMPTY_STATE)
  lastBuildOrder: '',
  dataAutoSync: true,
  experimentalPrivacy: false,       // OFF = v0.11 behaviour. ON enables: masked keys in the UI, amnesiac mode, refusing keys over public http
  experimentalCache: false,         // OFF = v0.11 behaviour (one cached system block). ON = static/dynamic split + per-round cache breakpoints
  rememberKey: true,                // (experimentalPrivacy only) false = "modo amnésico": API keys live only in memory for this session
  logRetentionDays: 0,              // delete conversation logs older than this many days (0 = keep, default)
  patchWatch: true,                 // check the official news feed for new AoE2 patches (once a day)
  matchDetect: false,               // opt-in: read the player's current match from the aoe2companion public API
  profileId: '',                    // public AoE2 profile id (from the profile search in Settings)
  profileName: '',
  keyOk: false,                     // set after the first successful answer / key test (hides the welcome popup)
  welcomeHide: false,               // "No mostrar más" in the welcome popup
};

class Settings {
  constructor(file) { this.file = file; this.data = { ...DEFAULTS }; this.load(); }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw, hotkeys: { ...DEFAULTS.hotkeys, ...(raw.hotkeys || {}) }, match: { ...(raw.match || {}) } };
      // migrate v0.1 hotkey name
      if (raw.hotkeys && raw.hotkeys.talk && !raw.hotkeys.ask) this.data.hotkeys.ask = raw.hotkeys.talk;
      if (raw.anthropicModel === 'claude-haiku-5-5' && !raw.modelChosen) this.data.anthropicModel = DEFAULTS.anthropicModel;
      // v0.13: default voice is Elena (es-AR); move the old default unless the player picked a voice himself
      if ((!raw.ttsVoice || raw.ttsVoice === 'es-AR-TomasNeural') && !raw.voiceChosen) this.data.ttsVoice = DEFAULTS.ttsVoice;
    } catch { this.data = { ...DEFAULTS }; }
    return this.data;
  }
  get() { return this.data; }
  set(patch) {
    this.data = { ...this.data, ...patch };
    if (patch.hotkeys) this.data.hotkeys = { ...this.data.hotkeys, ...patch.hotkeys };
    if (patch.anthropicModel) this.data.modelChosen = true;
    if (patch.ttsVoice) this.data.voiceChosen = true;
    this.save();
    return this.data;
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
}

module.exports = { Settings, DEFAULTS };
