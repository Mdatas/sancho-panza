'use strict';
/** Coach brain: match state (extracted before every answer), conversation, provider tool loop, logging. */
const { TOOLS, makeDispatcher, applyStatePatch } = require('./tools');
const { OPP_SECTIONS } = require('../engine/strategy');
const { buildSystemBlocks, buildSystemPrompt, stateLine, AGE_NAMES } = require('./prompt');
const { complete, plainComplete } = require('./providers');
const { teamCounters, teamCountersText } = require('../engine/teamcounters');

const MAX_HISTORY = 10; // exchanges kept (text only)
const EMPTY_STATE = { myCiv: '', oppCiv: '', allies: [], enemies: [], age: 0, oppAge: 0, map: '', elo: '', myArmy: '', theirArmy: '', myEco: '', keyFacts: [], notes: '', questionType: '', source: '' };

const EXTRACT_SYSTEM = `You extract Age of Empires II match facts from one chat message a player typed mid-game (Spanish or English).
Return ONLY a JSON object, no prose, with any of these keys when the message states or clearly implies them (omit the rest):
my_civ (English civ name, e.g. "Franks"), opp_civ, allies (team games: array of my teammates' civs, not me), enemies (team games: array of ALL opponent civs; opp_civ = the first), age (my age: 1 Dark, 2 Feudal, 3 Castle, 4 Imperial), opp_age, map, elo,
my_army (what I have/make), their_army (what they have/make), my_eco (villagers, TCs, upgrades),
key_facts (array of short strings: every constraint in THIS message the answer must respect, in the player's words, e.g. "no gold left", "he has 2 castles", "don't want to switch comp"),
question_type (one of counter, eco, build_order, civ, timing, general), clear (true only if the player says a new game started).
"yo/soy X" or "I'm X" = my civ; "vs/contra/rival X" = opponent; "me tira/hace X" = their_army; "tengo/voy X" = my_army.
Never invent facts that are not in the message. Civ names in English.`;

class Brain {
  constructor({ gd, buildOrders, knowledge, strategy = null, getSettings, saveState = () => {}, log = () => {} }) {
    Object.assign(this, { gd, buildOrders, knowledge, strategy, getSettings, saveState, log });
    this.state = { ...EMPTY_STATE }; // every launch starts blank: the player tells the coach civ, ELO, map… for this session
    this.asked = new Set();
    this.history = [];
    this.totals = { cost: 0, input: 0, output: 0, calls: 0 };
    this.lastAnswerId = 0;
  }

  reset({ keepState = true } = {}) {
    this.history = [];
    if (!keepState) { this.state = { ...EMPTY_STATE }; this.saveState(this.state); }
  }

  /** Direct state edits from slash commands. Returns the new state. */
  setState(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in EMPTY_STATE)) continue;
      if (k === 'map' && v && this.strategy) { const mp = this.strategy.findMap(v); this.state.map = mp ? (mp.meta.map || mp.title) : String(v); continue; }
      if (k === 'myCiv' || k === 'oppCiv') { const c = v ? this.gd.findCiv(v) : null; if (v && !c) throw new Error('Unknown civ: ' + v); this.state[k] = c ? c.key : ''; if (k === 'oppCiv' && !('enemies' in patch)) { const e = [...(this.state.enemies || [])]; if (c) e[0] = c.key; else e.shift(); this.state.enemies = e.filter(Boolean); } }
      else if (k === 'age' || k === 'oppAge') this.state[k] = Number(v) || 0;
      else if (k === 'keyFacts') this.state[k] = Array.isArray(v) ? v : [];
      else if (k === 'allies' || k === 'enemies') {
        const list = (Array.isArray(v) ? v : String(v || '').split(/[,;/+]| y | and /)).map(x => String(x || '').trim()).filter(Boolean);
        const keys = list.map(x => { const c = this.gd.findCiv(x); if (!c) throw new Error('Unknown civ: ' + x); return c.key; }).slice(0, k === 'allies' ? 3 : 4);
        this.state[k] = keys;
        if (k === 'enemies') this.state.oppCiv = keys[0] || '';
      }
      else this.state[k] = v == null ? '' : String(v);
    }
    if (patch && (patch.myCiv || patch.oppCiv || patch.map || patch.allies || patch.enemies) && !patch.source) this.state.source = '';
    this.saveState(this.state);
    return this.state;
  }
  /** Fill the fields the player has not set from an automatically detected match. Never overwrites manual values unless force. Returns the keys it changed. */
  applyDetected(match, { force = false } = {}) {
    if (!match) return [];
    const changed = [];
    const put = (k, v) => { if (!v || (Array.isArray(v) && !v.length)) return; const cur = this.state[k]; if (!force && (Array.isArray(cur) ? cur.length : cur)) return; try { this.setState({ [k]: v }); changed.push(k); } catch { /* unknown civ/map name: skip */ } };
    put('myCiv', match.me && match.me.civ);
    const civs = (ps) => (ps || []).map(p => p && p.civ).filter(Boolean);
    if (match.opponents && match.opponents.length > 1 && !this.state.oppCiv) put('enemies', civs(match.opponents));
    else put('oppCiv', match.opponents && match.opponents[0] && match.opponents[0].civ);
    if (match.allies && match.allies.length) put('allies', civs(match.allies));
    put('map', match.map);
    if (changed.length) { this.state.source = 'detected'; this.saveState(this.state); }
    return changed;
  }
  newGame() { const keep = { elo: this.state.elo }; this.state = { ...EMPTY_STATE, ...keep }; this.history = []; this.saveState(this.state); return this.state; }
  stateLine() { return stateLine(this.state); }

  _providerArgs(s, { extraction = false } = {}) {
    const provider = s.provider || 'anthropic';
    const model = provider === 'openai' ? (s.openaiModel || 'qwen2.5:14b')
      : extraction ? (s.extractModel || 'claude-haiku-5-5') : (s.anthropicModel || 'claude-sonnet-5-5');
    return { provider, apiKey: provider === 'openai' ? s.openaiApiKey : s.anthropicApiKey, model, baseUrl: provider === 'openai' ? s.openaiBaseUrl : s.anthropicBaseUrl, strictTransport: s.experimentalPrivacy === true };
  }

  /** Step 1: extract match facts from the message into the state (cheap model, JSON only). Never blocks the answer. */
  async extract(userText, s) {
    if (s.extractState === false) return { ok: false, skipped: true };
    const a = this._providerArgs(s, { extraction: true });
    try {
      const maps = this.strategy ? this.strategy.mapNames() : [];
      const system = EXTRACT_SYSTEM + (maps.length ? `\nKnown map names (use exactly one of these for "map" when the message names a map): ${maps.join(', ')}.` : '');
      const r = await plainComplete(a.provider, { ...a, system, user: `Current state: ${stateLine(this.state) || '(empty)'}\nMessage: ${userText}`, maxTokens: 350 });
      const m = r.text.match(/\{[\s\S]*\}/);
      const patch = m ? JSON.parse(m[0]) : {};
      if (patch.map && this.strategy) { const mp = this.strategy.findMap(patch.map); if (mp) patch.map = mp.meta.map || mp.title; }
      applyStatePatch(this.gd, this.state, patch);
      this.saveState(this.state);
      if (r.cost) this.totals.cost += r.cost;
      return { ok: true, patch, usage: r.usage, cost: r.cost };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async ask(userText, { onEvent } = {}) {
    const s = this.getSettings();
    const lang = s.language || 'auto';
    const t0 = Date.now();
    const stateBefore = { ...this.state };
    onEvent && onEvent({ type: 'tool', name: 'update_match_state' });
    const ex = await this.extract(userText, s);
    onEvent && onEvent({ type: 'state', state: this.state, line: stateLine(this.state) });

    const dispatch = makeDispatcher({ gd: this.gd, buildOrders: this.buildOrders, knowledge: this.knowledge, strategy: this.strategy, lang: lang === 'es' ? 'es' : 'en',
      state: this.state, onState: (st) => { this.saveState(st); onEvent && onEvent({ type: 'state', state: st, line: stateLine(st) }); } });
    const promptArgs = { state: this.state, lang, dataVersion: this.gd.sourceCommit.slice(0, 7), keyData: this.keyData(userText), patchInfo: this.patchInfo || '' };
    // experimentalCache ON: [static, dynamic] blocks with separate cache breakpoints; OFF (default): one string, exactly as v0.11
    const system = s.experimentalCache === true ? buildSystemBlocks(promptArgs) : buildSystemPrompt(promptArgs);
    const header = [];
    const line = stateLine(this.state); if (line) header.push(`match state: ${line}`);
    if (this.state.keyFacts && this.state.keyFacts.length) header.push(`constraints to respect: ${this.state.keyFacts.join(' | ')}`);
    const content = (header.length ? `[${header.join(' ; ')}]\n` : '') + userText;
    const messages = [...this.history, { role: 'user', content }];
    const a = this._providerArgs(s);
    const args = { ...a, maxTokens: 1200, system, messages, tools: TOOLS, dispatch, onEvent, forceTool: null };
    let res;
    try { res = await complete(a.provider, args); }
    catch (e) { this.log({ type: 'error', q: userText, error: e.message, ms: Date.now() - t0, state: this.state, extraction: ex }); throw e; }
    this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: res.text || '(no answer)' });
    if (this.history.length > MAX_HISTORY * 2) this.history = this.history.slice(-MAX_HISTORY * 2);
    this.totals.calls++;
    this.totals.input += res.usage.input_tokens || 0; this.totals.output += res.usage.output_tokens || 0;
    if (res.cost) this.totals.cost += res.cost;
    const id = ++this.lastAnswerId;
    const cost = (res.cost || 0) + ((ex && ex.cost) || 0);
    this.log({ type: 'ask', id, q: userText, stateBefore, extraction: ex, stateAfter: { ...this.state }, tools: res.toolLog, answer: res.text, model: res.model, usage: res.usage, cost, ms: Date.now() - t0 });
    return { ...res, cost: cost || res.cost, id, state: { ...this.state }, stateLine: stateLine(this.state), totals: { ...this.totals, cost: +this.totals.cost.toFixed(4) } };
  }

  /** Strategy profiles relevant to the current state: my civ (full), opponent civ (how to play against), map. */
  keyData(question = '') {
    const parts = [];
    if (!this.strategy) return this.relevantNotes(question);
    const mine = this.state.myCiv && this.strategy.civ(this.state.myCiv);
    if (mine) parts.push(`## MY CIV — ${this.state.myCiv}\n` + this.strategy.excerpt(mine, null, 3800));
    const opp = this.state.oppCiv && this.strategy.civ(this.state.oppCiv);
    if (opp) parts.push(`## OPPONENT CIV — ${this.state.oppCiv}\n` + this.strategy.excerpt(opp, OPP_SECTIONS, 2600));
    const map = this.state.map && this.strategy.findMap(this.state.map);
    if (map) parts.push(`## MAP — ${map.meta.map || map.title}\n` + this.strategy.excerpt(map, null, 2600));
    const tc = this.teamCountersText();
    if (tc) parts.push(tc);
    const notes = this.relevantNotes(question);
    if (notes) parts.push(notes);
    return parts.join('\n\n');
  }

  /** 4v4 bar data: what each enemy civ fields and my civ's answers (duel maths). */
  teamCounters() {
    const st = this.state; const enemies = (st.enemies && st.enemies.length) ? st.enemies : (st.oppCiv ? [st.oppCiv] : []);
    return teamCounters(this.gd, this.strategy, { myCiv: st.myCiv, enemies, age: st.age });
  }
  teamCountersText() {
    const st = this.state; if (!((st.enemies || []).length > 1 || (st.allies || []).length)) return '';
    try { return teamCountersText(this.teamCounters()); } catch { return ''; }
  }

  /** Top strategy-note sections for this question + state (meta, patches, fundamentals, counters, Alexander guide…). */
  relevantNotes(question) {
    if (!this.knowledge || !question) return '';
    const st = this.state;
    const civWords = (key) => { const c = key && this.gd && this.gd.civs && this.gd.civs[key]; return c ? [c.name_en, c.name_es].filter(Boolean).join(' ') : (key || ''); };
    const q = [question, st.theirArmy, st.myArmy, (st.keyFacts || []).join(' '), st.map, civWords(st.myCiv), civWords(st.oppCiv)].filter(Boolean).join(' ');
    const hits = this.knowledge.search(q, { limit: 3, maxChars: 1800 });
    if (!hits.length) return '';
    // Old civ guides: never show their lessons without the current-patch VIGENCIA check that goes with them.
    for (const h of hits.slice()) {
      if (!/\[ver VIGENCIA\]/.test(h.title)) continue;
      const base = h.title.split(': lecciones')[0];
      const qn = q.toLowerCase();
      const vig = (this.knowledge.sections || [])
        .filter(s => s.file === h.file && s.title.startsWith(base) && /VIGENCIA hoy/.test(s.title) && !hits.some(x => x.title === s.title))
        .map(s => ({ s, score: (s.title.split(' — ')[1] || '').split(', ').filter(c => c && qn.includes(c.toLowerCase().slice(0, 5))).length + (s._n.includes(qn.split(' ')[0]) ? 0 : 0) }))
        .sort((a, b) => b.score - a.score).slice(0, 2);
      for (const { s } of vig) hits.unshift({ file: s.file, title: s.title, text: s.body.length > 1800 ? s.body.slice(0, 1800) + ' …' : s.body });
    }
    // ...and the reverse: a VIGENCIA hit brings the first lessons chunk of its video.
    for (const h of hits.slice()) {
      const m = h.title.match(/^(.*): VIGENCIA hoy/);
      if (!m || hits.some(x => x.title.startsWith(m[1] + ': lecciones'))) continue;
      const s = (this.knowledge.sections || []).find(x => x.file === h.file && x.title.startsWith(m[1] + ': lecciones (1/'));
      if (s) hits.push({ file: s.file, title: s.title, text: s.body.length > 1800 ? s.body.slice(0, 1800) + ' …' : s.body });
    }
    hits.splice(7);
    return '## RELEVANT NOTES\n' + hits.map(h => `### ${h.title} (${h.file})\n${h.text}`).join('\n');
  }

  flag(comment) { this.log({ type: 'flag', answerId: this.lastAnswerId, comment: comment || '', state: { ...this.state } }); }
}

module.exports = { Brain, EMPTY_STATE, AGE_NAMES };
