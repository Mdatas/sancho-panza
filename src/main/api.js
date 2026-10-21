'use strict';
/**
 * The app's API, independent of the transport: the desktop main process exposes it over IPC (main.js) and the web build
 * exposes the same functions on window.coach (web/src/coach-web.js). One implementation, two front doors — a handler
 * added here works on Windows, Mac and the web at once.
 *
 * ctx() returns the live engine objects ({ gd, buildOrders, knowledge, strategy, brain }); it is a function because the
 * desktop reloads them when the dataset or the notes change.
 */
const guideData = require('./guideData');
const bocatalog = require('./bocatalog');
const { makeDispatcher } = require('./brain/tools');

const GUIDE_TOOLS = ['lookup_unit', 'find_counters', 'civ_matchup', 'compare_units', 'civ_info']; // read-only engine tools the UI may call directly

function createCore({ ctx, userBuildDir, knowledgeDirs, uiLanguage = () => 'es', log = () => {} }) {
  let civStatsCache = null,
    catCache = null;
  const lang = () => ((uiLanguage() || 'es') === 'es' ? 'es' : 'en');
  const civStats = () => civStatsCache || (civStatsCache = guideData.parseCivStats(knowledgeDirs()));
  const sortedCivs = (gd) =>
    Object.values(gd.civs)
      .map((c) => ({ key: c.key, name_en: c.name_en, name_es: c.name_es }))
      .sort((a, b) => a.name_en.localeCompare(b.name_en));

  /** Lazy data for the sheet (ficha): the build catalog and the civ stats, both cached. */
  const sheetArgs = () => ({ getCatalog: () => api.boCatalog(), getStats: () => civStats() });
  const packAnswer = (r, t0) => ({
    ok: true,
    kind: r.kind || 'answer',
    id: r.id,
    text: r.text,
    sheet: r.sheet || null,
    spoken: r.spoken || '',
    model: r.model,
    cost: r.cost,
    totals: r.totals,
    tools: (r.toolLog || []).map((t) => t.name),
    state: r.state,
    stateLine: r.stateLine,
    ms: Date.now() - t0,
  });

  const api = {
    /** Drop everything derived from the data (after a dataset sync, a new patch note or a build import). */
    invalidate() {
      civStatsCache = null;
      catCache = null;
    },

    // ---- chat
    /** One message → the sheet (answerMode 'ficha', default) or the coach answer ('libre'); opts.mode forces one. */
    async ask(text, onEvent, opts = {}) {
      const { brain } = ctx();
      const t0 = Date.now();
      try {
        const r = await brain.ask(text, { onEvent, ...sheetArgs(), ...opts });
        return packAnswer(r, t0);
      } catch (e) {
        log('ask error', e.message);
        return { ok: false, error: e.message };
      }
    },
    /** "Pedir consejo": the free coach answer, built on the sheet the player just saw (needs an AI provider). */
    advise(text, onEvent) {
      const { brain } = ctx();
      const s = brain.getSettings();
      const q =
        (text && String(text).trim()) ||
        ((s.language && s.language !== 'auto' ? s.language : s.uiLanguage) === 'es'
          ? 'Dame un consejo concreto para esta partida a partir de la ficha: qué hacer en los próximos 2 minutos.'
          : 'Give me concrete advice for this match from the sheet: what to do in the next 2 minutes.');
      return api.ask(q, onEvent, { mode: 'libre', withSheet: true });
    },
    /** The sheet for the current state without a question (new game, detected match, /ficha). */
    sheet(question = '') {
      const { brain } = ctx();
      try {
        return { ok: true, ...brain.sheetNow({ question, ...sheetArgs() }) };
      } catch (e) {
        log('sheet error', e.message);
        return { ok: false, error: e.message };
      }
    },
    reset() {
      ctx().brain.reset();
      return true;
    },
    newGame() {
      const { brain } = ctx();
      return { state: brain.newGame(), line: brain.stateLine() };
    },
    flag(comment) {
      ctx().brain.flag(comment);
      return true;
    },
    teamCounters() {
      try {
        return ctx().brain.teamCounters();
      } catch (e) {
        return { age: 3, rows: [], error: e.message };
      }
    },
    stateGet() {
      const { brain } = ctx();
      return { state: brain.state, line: brain.stateLine() };
    },
    stateSet(patch) {
      const { brain } = ctx();
      try {
        return { ok: true, state: brain.setState(patch), line: brain.stateLine() };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // ---- build orders
    boList(q) {
      return ctx().buildOrders.search({ ...(q || {}), limit: (q && q.limit) || 100 });
    },
    boGet(id) {
      const { buildOrders } = ctx();
      const bo = buildOrders.get(id);
      return bo ? { ...bo, text: buildOrders.toText(bo) } : null;
    },
    boImport(text) {
      try {
        const bo = ctx().buildOrders.importJson(text, userBuildDir());
        catCache = null;
        return { ok: true, bo };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    /** files: [{ name, text }] already read by the front door (file dialog on desktop, <input type=file> on the web). */
    boImportFiles(files) {
      const { buildOrders } = ctx();
      const out = [];
      for (const f of files) {
        try {
          out.push(buildOrders.importJson(f.text, userBuildDir()));
        } catch (e) {
          out.push({ error: `${f.name}: ${e.message}` });
        }
      }
      catCache = null;
      return { ok: true, imported: out };
    },
    boCatalog() {
      const { buildOrders, knowledge, gd } = ctx();
      const n = buildOrders.list.length + knowledge.sections.length;
      if (catCache && catCache.n === n) return catCache.c;
      catCache = { n, c: bocatalog.catalog({ buildOrders, knowledge, gd }) };
      return catCache.c;
    },
    boNoteText({ file, stem }) {
      return bocatalog.noteText(ctx().knowledge, file, stem);
    },

    // ---- lists / profiles
    civs() {
      return sortedCivs(ctx().gd);
    },
    maps() {
      return ctx().strategy.mapNames();
    },
    profile({ kind, q }) {
      const { gd, strategy } = ctx();
      if (kind === 'map') {
        const p = strategy.findMap(q);
        return p ? p.body : null;
      }
      const c = gd.findCiv(q);
      const p = c && strategy.civ(c.key);
      return p ? p.body : null;
    },
    dataCounts() {
      const { gd, buildOrders, knowledge, strategy } = ctx();
      return {
        civs: Object.keys(gd.civs).length,
        units: Object.values(gd.units).filter((u) => u.name_en).length,
        buildOrders: buildOrders.list.length,
        notes: knowledge.sections.length,
        civProfiles: Object.keys(strategy.civs).length,
        mapProfiles: Object.keys(strategy.maps).length,
        source: gd.sourceCommit,
      };
    },

    // ---- visual guide
    guideIndex() {
      const { gd, strategy, brain } = ctx();
      return { ...guideData.index({ gd, strategy }), state: { ...brain.state } };
    },
    guideCiv(key) {
      const { gd, strategy } = ctx();
      return guideData.civView({ gd, strategy, key, stats: civStats() });
    },
    guideMap(key) {
      return guideData.mapView({ strategy: ctx().strategy, key });
    },
    guideStats() {
      return civStats();
    },
    async guideTranslate({ text, lang: target }) {
      try {
        return { ok: true, text: await ctx().brain.translate(text, target) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    guideNotes(q) {
      return guideData.searchNotes({ knowledge: ctx().knowledge, q });
    },
    guideNoteList() {
      return guideData.listNotes({ knowledge: ctx().knowledge });
    },
    guideNoteText({ file, title }) {
      return guideData.noteText({ knowledge: ctx().knowledge, file, title });
    },
    /** Topic summaries (data/knowledge/temas_*.md, written by tools/themes.js): [{ id, name, intro, sections:[{name,text}] }]. */
    guideThemes() {
      const { knowledge } = ctx();
      const byFile = new Map();
      for (const sec of knowledge.sections || []) {
        if (!/^temas_/.test(sec.file)) continue;
        let t = byFile.get(sec.file);
        if (!t) byFile.set(sec.file, (t = { id: sec.file, name: sec.file.replace(/^temas_|\.md$/g, ''), intro: '', sections: [] }));
        const m = sec.title.match(/^Tema:\s*(.+)$/);
        if (m) {
          t.name = m[1].trim();
          t.intro = sec.body;
        } else t.sections.push({ name: sec.title.replace(/^.*? — /, ''), text: sec.body });
      }
      return [...byFile.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    guideTool({ name, input }) {
      if (!GUIDE_TOOLS.includes(name)) return { error: 'not allowed' };
      const { gd, buildOrders, knowledge, strategy, brain } = ctx();
      try {
        return makeDispatcher({ gd, buildOrders, knowledge, strategy, lang: lang(), state: { ...brain.state }, onState: () => {} })(name, input || {});
      } catch (e) {
        return { error: e.message };
      }
    },

    // ---- match detection
    matchApply(lastMatch, { force = false } = {}) {
      const { brain } = ctx();
      if (!lastMatch) return null;
      const filled = brain.applyDetected(lastMatch, { force: !!force });
      return { ok: true, filled, state: brain.state, line: brain.stateLine() };
    },
  };
  return api;
}

module.exports = { createCore, GUIDE_TOOLS };
