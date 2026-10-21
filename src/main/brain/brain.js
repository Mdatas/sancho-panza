'use strict';
/** Coach brain: match state (extracted before every answer), conversation, provider tool loop, logging. */
const { TOOLS, makeDispatcher, applyStatePatch } = require('./tools');
const { OPP_SECTIONS } = require('../engine/strategy');
const { buildSystemBlocks, buildSystemPrompt, stateLine, AGE_NAMES } = require('./prompt');
const { complete, plainComplete } = require('./providers');
const { teamCounters, teamCountersText } = require('../engine/teamcounters');
const combat = require('../engine/combat');
const { buildSheet, parseMessage, sheetText, sheetSpoken } = require('../engine/sheet');

const MAX_HISTORY = 6; // exchanges kept (text only): enough context for follow-ups, not a transcript re-sent every question
const EXTRACT_BUDGET_MS = 2500; // how long the answer waits for the (parallel) fact extraction before building the prompt without it
const SHEET_EXTRACT_MS = 8000; // ficha mode: the extraction is the only model call, so it may take a little longer before the keyword parse takes over
const SHEET_HISTORY_CHARS = 1500; // how much of a shown sheet is kept in the conversation history (context for a later "consejo")
const LIVE_MAX_AGE_MS = 90 * 1000; // a HUD reading older than this is not shown to the model
const RESTORE_MAX_AGE_MS = 3 * 3600 * 1000; // a match saved less than this long ago is restored at launch (same game, app restarted)
const EXCERPT = { mine: 3400, opp: 2200, map: 2200 }; // chars of each strategy profile injected per question
const NOTE_WINDOW = 1800; // chars of a note section injected into the prompt (sections are split at load so nothing is cut mid-note)
const EMPTY_STATE = {
  myCiv: '',
  oppCiv: '',
  allies: [],
  enemies: [],
  age: 0,
  oppAge: 0,
  map: '',
  elo: '',
  myArmy: '',
  theirArmy: '',
  myEco: '',
  keyFacts: [],
  notes: '',
  questionType: '',
  source: '',
};

const EXTRACT_SYSTEM = `You extract Age of Empires II match facts from one chat message a player typed mid-game (Spanish or English).
Return ONLY a JSON object, no prose, with any of these keys when the message states or clearly implies them (omit the rest):
my_civ (English civ name, e.g. "Franks"), opp_civ, allies (team games: array of my teammates' civs, not me), enemies (team games: array of ALL opponent civs; opp_civ = the first), age (my age: 1 Dark, 2 Feudal, 3 Castle, 4 Imperial), opp_age, map, elo,
my_army (what I have/make), their_army (what they have/make), my_eco (villagers, TCs, upgrades),
key_facts (array of short strings: every constraint in THIS message the answer must respect, in the player's words, e.g. "no gold left", "he has 2 castles", "don't want to switch comp"),
question_type (one of counter, eco, build_order, civ, timing, general), clear (true only if the player says a new game started),
search_terms (array of 3-6 keywords for the strategy-note search: Spanish strategy words plus English unit/civ/map names, e.g. ["defensa", "trush", "torres", "Incas", "Arabia"]).
"yo/soy X" or "I'm X" = my civ; "vs/contra/rival X" = opponent; "me tira/hace X" = their_army; "tengo/voy X" = my_army.
Never invent facts that are not in the message. Civ names in English.`;

class Brain {
  constructor({ gd, buildOrders, knowledge, strategy = null, getSettings, saveState = () => {}, log = () => {} }) {
    Object.assign(this, { gd, buildOrders, knowledge, strategy, getSettings, saveState, log });
    this.state = { ...EMPTY_STATE }; // starts blank unless restoreState() finds a recent match: the player tells the coach civ, ELO, map…
    this.live = null; // last HUD reading from the screen reader ({ food, wood, gold, stone, pop, idle, age, time, at }), desktop only
    this.history = [];
    this.totals = { cost: 0, input: 0, output: 0, calls: 0 };
    this.lastAnswerId = 0;
    this._queue = Promise.resolve(); // asks run one at a time (history and state are shared)
  }

  /** Screen reader (OCR) result: kept apart from the match state (it changes every few seconds and is never typed by the player). */
  setLive(reading) {
    this.live = reading ? { ...reading, at: reading.at || Date.now() } : null;
    // the age read on the HUD only ever moves the registered age forward (a misread must not send the player back to Feudal)
    if (this.live && this.live.age && Number(this.live.age) > (Number(this.state.age) || 0)) {
      this.state.age = Number(this.live.age);
      this.saveState(this.state);
      return true;
    }
    return false;
  }
  liveLine() {
    const l = this.live;
    if (!l || Date.now() - l.at > LIVE_MAX_AGE_MS) return '';
    const n = (v) => (v == null || v === '' ? '?' : v);
    const parts = [`food ${n(l.food)}`, `wood ${n(l.wood)}`, `gold ${n(l.gold)}`, `stone ${n(l.stone)}`];
    if (l.pop) parts.push(`pop ${l.pop}`);
    if (l.idle != null) parts.push(`idle villagers ${l.idle}`);
    if (l.villagers) parts.push(`villagers on food/wood/gold/stone ${['food', 'wood', 'gold', 'stone'].map((k) => n(l.villagers[k])).join('/')}`);
    if (l.age) parts.push(`age ${AGE_NAMES[l.age] || l.age}`);
    if (l.time) parts.push(`game time ${l.time}`);
    return `LIVE HUD (read from the player's screen ${Math.round((Date.now() - l.at) / 1000)} s ago; trust these numbers over what the player remembers): ${parts.join(', ')}`;
  }

  /** Bring back the match saved by a previous run when it is recent (the app was restarted mid-game). Returns true when restored. */
  restoreState(saved, savedAt) {
    if (!saved || typeof saved !== 'object' || !savedAt || Date.now() - Number(savedAt) > RESTORE_MAX_AGE_MS) return false;
    const st = { ...EMPTY_STATE };
    for (const k of Object.keys(EMPTY_STATE))
      if (k in saved && saved[k] != null) st[k] = Array.isArray(EMPTY_STATE[k]) ? (Array.isArray(saved[k]) ? saved[k].slice() : []) : saved[k];
    if (!(st.myCiv || st.oppCiv || st.map || (st.enemies || []).length)) return false;
    this.state = st;
    return true;
  }

  reset({ keepState = true } = {}) {
    this.history = [];
    if (!keepState) {
      this.state = { ...EMPTY_STATE };
      this.saveState(this.state);
    }
  }

  /** Direct state edits from slash commands. Returns the new state. */
  setState(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in EMPTY_STATE)) continue;
      if (k === 'map' && v && this.strategy) {
        const mp = this.strategy.findMap(v);
        this.state.map = mp ? mp.meta.map || mp.title : String(v);
        continue;
      }
      if (k === 'myCiv' || k === 'oppCiv') {
        const c = v ? this.gd.findCiv(v) : null;
        if (v && !c) throw new Error('Unknown civ: ' + v);
        this.state[k] = c ? c.key : '';
        if (k === 'oppCiv' && !('enemies' in patch)) {
          const e = [...(this.state.enemies || [])];
          if (c) e[0] = c.key;
          else e.shift();
          this.state.enemies = e.filter(Boolean);
        }
      } else if (k === 'age' || k === 'oppAge') this.state[k] = Number(v) || 0;
      else if (k === 'keyFacts') this.state[k] = Array.isArray(v) ? v : [];
      else if (k === 'allies' || k === 'enemies') {
        const list = (Array.isArray(v) ? v : String(v || '').split(/[,;/+]| y | and /)).map((x) => String(x || '').trim()).filter(Boolean);
        const keys = list
          .map((x) => {
            const c = this.gd.findCiv(x);
            if (!c) throw new Error('Unknown civ: ' + x);
            return c.key;
          })
          .slice(0, k === 'allies' ? 3 : 4);
        this.state[k] = keys;
        if (k === 'enemies') this.state.oppCiv = keys[0] || '';
      } else this.state[k] = v == null ? '' : String(v);
    }
    if (patch && (patch.myCiv || patch.oppCiv || patch.map || patch.allies || patch.enemies) && !patch.source) this.state.source = '';
    this.saveState(this.state);
    return this.state;
  }
  /** Fill the fields the player has not set from an automatically detected match. Never overwrites manual values unless force. Returns the keys it changed. */
  applyDetected(match, { force = false } = {}) {
    if (!match) return [];
    const changed = [];
    const put = (k, v) => {
      if (!v || (Array.isArray(v) && !v.length)) return;
      const cur = this.state[k];
      if (!force && (Array.isArray(cur) ? cur.length : cur)) return;
      try {
        this.setState({ [k]: v });
        changed.push(k);
      } catch {
        /* unknown civ/map name: skip */
      }
    };
    put('myCiv', match.me && match.me.civ);
    const civs = (ps) => (ps || []).map((p) => p && p.civ).filter(Boolean);
    if (match.opponents && match.opponents.length > 1 && !this.state.oppCiv) put('enemies', civs(match.opponents));
    else put('oppCiv', match.opponents && match.opponents[0] && match.opponents[0].civ);
    if (match.allies && match.allies.length) put('allies', civs(match.allies));
    put('map', match.map);
    if (changed.length) {
      this.state.source = 'detected';
      this.saveState(this.state);
    }
    return changed;
  }
  newGame() {
    const keep = { elo: this.state.elo };
    this.state = { ...EMPTY_STATE, ...keep };
    this.history = [];
    this.saveState(this.state);
    return this.state;
  }
  stateLine() {
    return stateLine(this.state);
  }

  _providerArgs(s, { extraction = false } = {}) {
    const provider = s.provider || 'anthropic';
    const model =
      provider === 'openai' ? s.openaiModel || 'qwen2.5:14b' : extraction ? s.extractModel || 'claude-haiku-5-5' : s.anthropicModel || 'claude-sonnet-5-5';
    return {
      provider,
      apiKey: provider === 'openai' ? s.openaiApiKey : s.anthropicApiKey,
      model,
      baseUrl: provider === 'openai' ? s.openaiBaseUrl : s.anthropicBaseUrl,
      strictTransport: s.experimentalPrivacy === true,
    };
  }

  /** Step 1: extract match facts from the message into the state (cheap model, JSON only). Never blocks the answer. */
  async extract(userText, s, isLate = () => false) {
    if (s.extractState === false) return { ok: false, skipped: true };
    const a = this._providerArgs(s, { extraction: true });
    try {
      const maps = this.strategy ? this.strategy.mapNames() : [];
      const system =
        EXTRACT_SYSTEM + (maps.length ? `\nKnown map names (use exactly one of these for "map" when the message names a map): ${maps.join(', ')}.` : '');
      const r = await plainComplete(a.provider, {
        ...a,
        system,
        user: `Current state: ${stateLine(this.state) || '(empty)'}\nMessage: ${userText}`,
        maxTokens: 350,
        timeoutMs: 12000, // a slow extraction must never hold the answer for long
      });
      const m = r.text.match(/\{[\s\S]*\}/);
      const patch = m ? JSON.parse(m[0]) : {};
      if (patch.map && this.strategy) {
        const mp = this.strategy.findMap(patch.map);
        if (mp) patch.map = mp.meta.map || mp.title;
      }
      if (isLate()) {
        // the answer already started: apply onto a copy, the caller fills only the fields still empty
        const copy = { ...this.state };
        delete patch.clear;
        applyStatePatch(this.gd, copy, patch);
        if (r.cost) this.totals.cost += r.cost;
        return { ok: true, patch, state: copy, usage: r.usage, cost: r.cost, late: true };
      }
      applyStatePatch(this.gd, this.state, patch);
      this.saveState(this.state);
      if (r.cost) this.totals.cost += r.cost;
      return { ok: true, patch, state: { ...this.state }, usage: r.usage, cost: r.cost };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * One question → one answer. Serialised: a second ask waits for the first (same history/state).
   * opts: { onEvent, mode: 'ficha' | 'libre' (default: settings.answerMode), getCatalog, getStats, withSheet }
   *  - ficha: the structured sheet built from the data (no model answer; the model only parses the message when there is a key)
   *  - libre: the coach answer (v0.21 behaviour); withSheet adds the sheet the player just saw to the prompt ("consejo")
   */
  ask(userText, opts = {}) {
    const run = this._queue.then(() => this._ask(userText, opts));
    this._queue = run.catch(() => {});
    return run;
  }

  /** Language of the sheet's names/labels: the answer language when fixed, else the interface language. */
  _sheetLang(s) {
    const l = s.language && s.language !== 'auto' ? s.language : s.uiLanguage || 'es';
    return l === 'es' ? 'es' : 'en';
  }
  _canExtract(s) {
    const a = this._providerArgs(s, { extraction: true });
    return s.extractState !== false && (a.provider === 'openai' || !!a.apiKey);
  }

  /** The sheet for the current state, without touching it (new game, match detected, /ficha). */
  sheetNow({ question = '', getCatalog, getStats } = {}) {
    const s = this.getSettings();
    const lang = this._sheetLang(s);
    const safe = (f) => {
      try {
        return f ? f() : null;
      } catch {
        return null;
      }
    };
    const sheet = buildSheet({ gd: this.gd, strategy: this.strategy, catalog: safe(getCatalog), state: this.state, stats: safe(getStats), lang, question });
    return { kind: 'sheet', sheet, text: sheetText(sheet), spoken: sheetSpoken(sheet), state: { ...this.state }, stateLine: stateLine(this.state) };
  }

  /** Ficha mode: parse the message into the state (model when there is a key, keywords otherwise) and build the sheet. */
  async _askSheet(userText, { onEvent, getCatalog, getStats, s }) {
    const t0 = Date.now();
    const stateBefore = { ...this.state };
    onEvent && onEvent({ type: 'tool', name: 'update_match_state' });
    const parsed = parseMessage({ gd: this.gd, strategy: this.strategy, text: userText, state: this.state });
    let ex = { ok: false, skipped: true };
    if (this._canExtract(s)) {
      let timer = null;
      ex = await Promise.race([this.extract(userText, s), new Promise((r) => (timer = setTimeout(() => r({ ok: false, timeout: true }), SHEET_EXTRACT_MS)))]);
      clearTimeout(timer);
    }
    // the keyword parse fills what the model did not (or everything, without a key); it never overwrites a value the model set
    const local = { ...parsed.patch };
    if (ex.ok) {
      const has = (k) => (Array.isArray(this.state[k]) ? this.state[k].length : !!this.state[k]);
      for (const [k, sk] of [
        ['my_civ', 'myCiv'],
        ['opp_civ', 'oppCiv'],
        ['map', 'map'],
        ['age', 'age'],
        ['elo', 'elo'],
        ['their_army', 'theirArmy'],
      ])
        if (has(sk)) delete local[k];
      if (!stateBefore.oppCiv && this.state.oppCiv) delete local.enemies;
    }
    if (Object.keys(local).length) {
      if (local.map && this.strategy) {
        const mp = this.strategy.findMap(local.map);
        if (mp) local.map = mp.meta.map || mp.title;
      }
      applyStatePatch(this.gd, this.state, local);
      this.saveState(this.state);
    }
    onEvent && onEvent({ type: 'state', state: this.state, line: stateLine(this.state) });
    const r = this.sheetNow({ question: userText, getCatalog, getStats });
    // re-parse units against the (possibly new) rival civ so the counters block uses the right roster
    if (parsed.units.length && this.state.oppCiv !== stateBefore.oppCiv) {
      const p2 = parseMessage({ gd: this.gd, strategy: this.strategy, text: userText, state: this.state });
      const lang = this._sheetLang(s);
      const safe = (f) => {
        try {
          return f ? f() : null;
        } catch {
          return null;
        }
      };
      r.sheet = buildSheet({
        gd: this.gd,
        strategy: this.strategy,
        catalog: safe(getCatalog),
        state: this.state,
        stats: safe(getStats),
        lang,
        question: userText,
        parsed: p2,
      });
      r.text = sheetText(r.sheet);
      r.spoken = sheetSpoken(r.sheet);
    }
    this.history.push(
      { role: 'user', content: userText },
      { role: 'assistant', content: `[ficha shown to the player]\n${r.text.slice(0, SHEET_HISTORY_CHARS)}` }
    );
    if (this.history.length > MAX_HISTORY * 2) this.history = this.history.slice(-MAX_HISTORY * 2);
    const id = ++this.lastAnswerId;
    const cost = (ex && ex.cost) || 0; // extract() already added it to the session total
    this.log({
      type: 'sheet',
      id,
      q: userText,
      stateBefore,
      extraction: ex,
      parsed: r.sheet.parsed,
      focus: r.sheet.focus,
      stateAfter: { ...this.state },
      cost,
      ms: Date.now() - t0,
    });
    return {
      ...r,
      id,
      toolLog: [],
      usage: (ex && ex.usage) || {},
      cost,
      model: ex.ok ? 'ficha+' + this._providerArgs(s, { extraction: true }).model : 'ficha',
      totals: { ...this.totals, cost: +this.totals.cost.toFixed(4) },
    };
  }

  async _ask(userText, { onEvent, mode, getCatalog, getStats, withSheet = false } = {}) {
    const s = this.getSettings();
    const answerMode = mode || s.answerMode || 'ficha';
    if (answerMode === 'ficha') return this._askSheet(userText, { onEvent, getCatalog, getStats, s });
    const lang = s.language || 'auto';
    const t0 = Date.now();
    const stateBefore = { ...this.state };
    onEvent && onEvent({ type: 'tool', name: 'update_match_state' });
    // The cheap fact extraction runs in parallel with the answer. The prompt waits for it only briefly (it usually takes ~1 s);
    // when it is slower, the answer goes ahead (the model has update_match_state itself) and the late result only fills gaps.
    let extractLate = false;
    let budgetTimer = null;
    const exPromise = this.extract(userText, s, () => extractLate);
    let ex = await Promise.race([
      exPromise,
      new Promise((r) => {
        budgetTimer = setTimeout(() => r({ ok: false, pending: true }), EXTRACT_BUDGET_MS);
      }),
    ]);
    clearTimeout(budgetTimer);
    if (ex && ex.pending) {
      extractLate = true;
      const snapshot = JSON.stringify(this.state);
      exPromise
        .then((late) => {
          if (!late || !late.ok || !late.state) return;
          // identity fields (civs, map) are filled only when still empty; what the player says about armies / eco / facts in
          // THIS message overrides the previous turn unless the main call already updated that field meanwhile
          const before = JSON.parse(snapshot);
          const VOLATILE = new Set(['theirArmy', 'myArmy', 'myEco', 'keyFacts', 'questionType', 'age', 'oppAge', 'elo']);
          let changed = false;
          for (const k of Object.keys(EMPTY_STATE)) {
            const cur = this.state[k];
            const v = late.state[k];
            const has = Array.isArray(v) ? v.length > 0 : !!v;
            if (!has || JSON.stringify(v) === JSON.stringify(cur)) continue;
            const empty = Array.isArray(cur) ? !cur.length : !cur;
            const untouched = JSON.stringify(cur) === JSON.stringify(before[k]);
            if (empty || (VOLATILE.has(k) && untouched)) {
              this.state[k] = v;
              changed = true;
            }
          }
          if (changed) {
            this.saveState(this.state);
            onEvent && onEvent({ type: 'state', state: this.state, line: stateLine(this.state) });
          }
        })
        .catch(() => {});
    }
    onEvent && onEvent({ type: 'state', state: this.state, line: stateLine(this.state) });

    const dispatch = makeDispatcher({
      gd: this.gd,
      buildOrders: this.buildOrders,
      knowledge: this.knowledge,
      strategy: this.strategy,
      lang: lang === 'es' ? 'es' : 'en',
      state: this.state,
      onState: (st) => {
        this.saveState(st);
        onEvent && onEvent({ type: 'state', state: st, line: stateLine(st) });
      },
    });
    // the extraction's keywords (Spanish + English game names) make the note search work in every input language
    const extraTerms =
      ex && ex.ok && ex.patch && Array.isArray(ex.patch.search_terms)
        ? ex.patch.search_terms
            .filter((x) => typeof x === 'string')
            .slice(0, 8)
            .join(' ')
        : '';
    let keyData = this.keyData(extraTerms ? `${userText} ${extraTerms}` : userText);
    if (withSheet) {
      // "consejo" after a sheet: the model builds on what the player already saw (same data), it does not start over
      const sh = this.sheetNow({ question: userText, getCatalog, getStats });
      keyData =
        `## FICHA (the structured sheet the app already showed the player for this match — built from the same data. Your advice must follow from it and cite it: name the bonus, the missing tech, the map property or the counter you rely on. Never contradict it; if it lacks something you need, say so.)\n${sheetText(sh.sheet, { full: true }).slice(0, 7000)}\n\n` +
        keyData;
    }
    const promptArgs = {
      state: this.state,
      lang,
      dataVersion: this.gd.sourceCommit.slice(0, 7),
      keyData,
      patchInfo: this.patchInfo || '',
    };
    // default: [static, dynamic] blocks with separate cache breakpoints (rules cached across questions, notes across the tool rounds);
    // experimentalCache === false: one string, as in v0.11
    const system = s.experimentalCache === false ? buildSystemPrompt(promptArgs) : buildSystemBlocks(promptArgs);
    const header = [];
    const line = stateLine(this.state);
    if (line) header.push(`match state: ${line}`);
    if (this.state.keyFacts && this.state.keyFacts.length) header.push(`constraints to respect: ${this.state.keyFacts.join(' | ')}`);
    const content = (header.length ? `[${header.join(' ; ')}]\n` : '') + userText;
    const messages = [...this.history, { role: 'user', content }];
    const a = this._providerArgs(s);
    const args = { ...a, maxTokens: 1200, system, messages, tools: TOOLS, dispatch, onEvent, forceTool: null, stream: s.streaming !== false };
    let res;
    try {
      res = await complete(a.provider, args);
    } catch (e) {
      this.log({ type: 'error', q: userText, error: e.message, ms: Date.now() - t0, state: this.state, extraction: ex });
      throw e;
    }
    if (ex && ex.pending) ex = { ok: false, pending: true, note: 'extraction slower than the answer; merged afterwards' };
    this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: res.text || '(no answer)' });
    if (this.history.length > MAX_HISTORY * 2) this.history = this.history.slice(-MAX_HISTORY * 2);
    this.totals.calls++;
    this.totals.input += res.usage.input_tokens || 0;
    this.totals.output += res.usage.output_tokens || 0;
    if (res.cost) this.totals.cost += res.cost;
    const id = ++this.lastAnswerId;
    const cost = (res.cost || 0) + ((ex && ex.cost) || 0);
    this.log({
      type: 'ask',
      id,
      q: userText,
      stateBefore,
      extraction: ex,
      stateAfter: { ...this.state },
      tools: res.toolLog,
      answer: res.text,
      model: res.model,
      usage: res.usage,
      cost,
      ms: Date.now() - t0,
    });
    return {
      ...res,
      kind: 'answer',
      cost: cost || res.cost,
      id,
      state: { ...this.state },
      stateLine: stateLine(this.state),
      totals: { ...this.totals, cost: +this.totals.cost.toFixed(4) },
    };
  }

  /** Strategy profiles relevant to the current state: my civ (full), opponent civ (how to play against), map. */
  keyData(question = '') {
    const parts = [];
    const live = this.liveLine();
    if (live) parts.push(live);
    if (!this.strategy) return [...parts, this.relevantNotes(question)].filter(Boolean).join('\n\n');
    const mine = this.state.myCiv && this.strategy.civ(this.state.myCiv);
    if (mine) parts.push(`## MY CIV — ${this.state.myCiv}\n` + this.strategy.excerpt(mine, null, EXCERPT.mine));
    const opp = this.state.oppCiv && this.strategy.civ(this.state.oppCiv);
    if (opp) parts.push(`## OPPONENT CIV — ${this.state.oppCiv}\n` + this.strategy.excerpt(opp, OPP_SECTIONS, EXCERPT.opp));
    const map = this.state.map && this.strategy.findMap(this.state.map);
    if (map) parts.push(`## MAP — ${map.meta.map || map.title}\n` + this.strategy.excerpt(map, null, EXCERPT.map));
    const tc = this.teamCountersText();
    if (tc) parts.push(tc);
    const ac = this.armyCountersText();
    if (ac) parts.push(ac);
    const notes = this.relevantNotes(question);
    if (notes) parts.push(notes);
    return parts.join('\n\n');
  }

  /** Translate a Spanish strategy note into the UI language (guide / build-order reader). Uses the cheap model. */
  async translate(text, lang) {
    const NAMES = { en: 'English', de: 'German', pt: 'Brazilian Portuguese', zh: 'Simplified Chinese', vi: 'Vietnamese', ko: 'Korean', es: 'Spanish' };
    const target = NAMES[lang] || 'English';
    const s = this.getSettings();
    const a = this._providerArgs(s, { extraction: true });
    if (!a.apiKey && a.provider !== 'openai') throw new Error('No Claude API key set');
    const system = `Translate the user's Age of Empires II strategy note from Spanish to ${target}. Keep the markdown exactly (lines starting with "- ", **bold**), keep numbers, dates, URLs, patch numbers and the words META / ANTI-META / MEME / VIGENCIA as they are. Use the official in-game ${target} names for units, civs, buildings and technologies when you know them, otherwise the English game names. Output ONLY the translation, nothing before or after.`;
    const r = await plainComplete(a.provider, { ...a, system, user: String(text).slice(0, 12000), maxTokens: 3000 });
    if (r.cost) this.totals.cost += r.cost;
    return String(r.text || '').trim();
  }
  /** 4v4 bar data: what each enemy civ fields and my civ's answers (duel maths). */
  teamCounters() {
    const st = this.state;
    const enemies = st.enemies && st.enemies.length ? st.enemies : st.oppCiv ? [st.oppCiv] : [];
    return teamCounters(this.gd, this.strategy, { myCiv: st.myCiv, enemies, age: st.age });
  }
  teamCountersText() {
    const st = this.state;
    if (!((st.enemies || []).length > 1 || (st.allies || []).length)) return '';
    try {
      return teamCountersText(this.teamCounters());
    } catch {
      return '';
    }
  }

  /** Units named in the opponent's registered army ("6 knights, mangonel coming" → Knight, Mangonel). */
  armyUnits(text) {
    const out = [];
    const seen = new Set();
    for (const raw of String(text || '').split(/[,;/+]| y | and |\n/)) {
      const phrase = raw
        .replace(/\d+|\b(coming|viniendo|llegando|masa|mass|of|de|the|el|la|los|las|unos|some|con|with|en|in|y)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!phrase) continue;
      let u = null;
      try {
        u = this.gd.findUnit(phrase, { civ: this.state.oppCiv || null });
        if (!u) for (const w of phrase.split(' ')) if (w.length > 3 && (u = this.gd.findUnit(w, { civ: this.state.oppCiv || null }))) break;
      } catch {
        u = null;
      }
      if (u && !seen.has(u.id)) {
        seen.add(u.id);
        out.push(u);
      }
      if (out.length >= 3) break;
    }
    return out;
  }
  /** Counters to the opponent's registered army, computed before the model answers: usually saves a whole tool round. */
  armyCountersText() {
    const st = this.state;
    if (!st.myCiv || !st.theirArmy) return '';
    const me = this.gd.findCiv(st.myCiv);
    if (!me) return '';
    const age = Math.min(4, Math.max(2, Number(st.age) || 3));
    const units = this.armyUnits(st.theirArmy);
    if (!units.length) return '';
    const lines = [];
    for (const u of units) {
      try {
        const r = combat.counters(this.gd, u, me.key, age, {
          targetCiv: st.oppCiv || null,
          myTier: Math.max(0, age - 1),
          targetTier: Math.max(0, age - 1),
          limit: 6,
        });
        const top = r.candidates.filter((c) => c.score >= 0.6 && !/Trebuchet|Petard|Demolition|Fire Ship|Flaming Camel|Missionary/i.test(c.unit)).slice(0, 3);
        if (!top.length) continue;
        lines.push(
          `- vs ${u.name_en}: ` +
            top
              .map(
                (c) =>
                  `${c.unit} (score ${c.score}${(c.bonusVsTarget || [])[0] ? ', ' + c.bonusVsTarget[0] : ''}${(c.mobility || []).some((m) => /gets kited/.test(m)) ? ', gets kited' : ''})`
              )
              .join(' / ')
        );
      } catch {
        /* unknown unit: skip */
      }
    }
    if (!lines.length) return '';
    return `PRECOMPUTED COUNTERS (same duel maths as find_counters; my civ ${me.key} at age ${age}${st.age ? '' : ' assumed'}, their army: "${st.theirArmy}"; roster and upgrades already filtered for my civ):\n${lines.join('\n')}`;
  }

  /** Top strategy-note sections for this question + state (meta, patches, fundamentals, counters, Alexander guide…). */
  relevantNotes(question) {
    if (!this.knowledge || !question) return '';
    const st = this.state;
    const civWords = (key) => {
      const c = key && this.gd && this.gd.civs && this.gd.civs[key];
      return c ? [c.name_en, c.name_es].filter(Boolean).join(' ') : key || '';
    };
    const q = [question, st.theirArmy, st.myArmy, (st.keyFacts || []).join(' '), st.map, civWords(st.myCiv), civWords(st.oppCiv)].filter(Boolean).join(' ');
    const hits = this.knowledge.search(q, { limit: 3, maxChars: NOTE_WINDOW });
    if (!hits.length) return '';
    // Old civ guides: never show their lessons without the current-patch VIGENCIA check that goes with them.
    for (const h of hits.slice()) {
      if (!/\[ver VIGENCIA\]/.test(h.title)) continue;
      const base = h.title.split(': lecciones')[0];
      const qn = q.toLowerCase();
      const vig = (this.knowledge.sections || [])
        .filter((s) => s.file === h.file && s.title.startsWith(base) && /VIGENCIA hoy/.test(s.title) && !hits.some((x) => x.title === s.title))
        .map((s) => ({ s, score: (s.title.split(' — ')[1] || '').split(', ').filter((c) => c && qn.includes(c.toLowerCase().slice(0, 5))).length }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      for (const { s } of vig) hits.unshift({ file: s.file, title: s.title, text: s.body.length > NOTE_WINDOW ? s.body.slice(0, NOTE_WINDOW) + ' …' : s.body });
    }
    // ...and the reverse: a VIGENCIA hit brings the first lessons chunk of its video.
    for (const h of hits.slice()) {
      const m = h.title.match(/^(.*): VIGENCIA hoy/);
      if (!m || hits.some((x) => x.title.startsWith(m[1] + ': lecciones'))) continue;
      const s = (this.knowledge.sections || []).find((x) => x.file === h.file && x.title.startsWith(m[1] + ': lecciones (1/'));
      if (s) hits.push({ file: s.file, title: s.title, text: s.body.length > NOTE_WINDOW ? s.body.slice(0, NOTE_WINDOW) + ' …' : s.body });
    }
    hits.splice(7);
    return '## RELEVANT NOTES\n' + hits.map((h) => `### ${h.title} (${h.file})\n${h.text}`).join('\n');
  }

  flag(comment) {
    this.log({ type: 'flag', answerId: this.lastAnswerId, comment: comment || '', state: { ...this.state } });
  }
}

module.exports = { Brain, EMPTY_STATE, AGE_NAMES };
