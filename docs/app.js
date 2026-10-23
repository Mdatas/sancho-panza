'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const I18N = window.I18N; // src/renderer/i18n.js (es, en, de, pt, zh, vi, ko)
/* Appearance: taverna (day, default) · taverna-night · classic-dark · classic-light — theme.css keys everything off <html data-theme>. */
const THEMES = ['taverna', 'taverna-night', 'classic-dark', 'classic-light'];
const THEME_BAR = { taverna: '#4b321d', 'taverna-night': '#141a26', 'classic-dark': '#16130f', 'classic-light': '#e6dcc4' }; // phone browser chrome (web)
function applyTheme(t) {
  const theme = THEMES.includes(t) ? t : 'taverna';
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_BAR[theme]);
  $$('#setTheme button').forEach((b) => b.classList.toggle('on', b.dataset.v === theme));
  const f = $('#guideFrame');
  if (f && f.dataset.loaded) {
    try {
      f.contentWindow.postMessage({ type: 'sp:theme', theme }, location.origin === 'null' ? '*' : location.origin);
    } catch {
      /* */
    }
  }
  return theme;
}
// desktop: the main process passes the saved theme in the URL so the first paint is already right (settings load a moment later)
try {
  const early = new URLSearchParams(location.search).get('theme');
  if (early && THEMES.includes(early)) document.documentElement.dataset.theme = early;
} catch {
  /* */
}
const DEFAULT_VOICE = {
  es: 'es-AR-ElenaNeural',
  en: 'en-US-AriaNeural',
  de: 'de-DE-KatjaNeural',
  pt: 'pt-BR-FranciscaNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  vi: 'vi-VN-HoaiMyNeural',
  ko: 'ko-KR-SunHiNeural',
};
function langTable(code) {
  return Object.assign({}, I18N.en, code === 'es' ? I18N.es : {}, I18N[code] || {}, { err: Object.assign({}, I18N.en.err, (I18N[code] || {}).err || {}) });
}
let L = langTable('es');
let S = {};
let civs = [];
let state = {};
let bo = { current: null, step: 0, choices: [] };
let busy = false,
  speaking = false;
const player = $('#player');

/* ----------------------------------------------------------------- helpers */
/** Translate a key with {placeholders}; fallback = the key itself or `def`. */
function fill(str, vars = {}) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
function tr(k, vars = {}, def) {
  const v = L[k] != null ? L[k] : I18N.en[k] != null ? I18N.en[k] : def != null ? def : k;
  return fill(v, vars);
}
/** Unit name in the UI language (game data has Spanish and English names). */
function uName(o) {
  return L === undefined || S.uiLanguage === 'es' || !S.uiLanguage ? o.unit_es || o.unit : o.unit;
}
function applyI18n() {
  const pick = (k, orig) => (L[k] != null ? L[k] : I18N.en[k] != null && S.uiLanguage !== 'es' ? I18N.en[k] : orig);
  $$('[data-i18n]').forEach((el) => {
    if (el.dataset.orig == null) el.dataset.orig = el.textContent;
    el.textContent = pick(el.dataset.i18n, el.dataset.orig);
  });
  $$('[data-i18n-html]').forEach((el) => {
    if (el.dataset.orig == null) el.dataset.orig = el.innerHTML;
    el.innerHTML = pick(el.dataset.i18nHtml, el.dataset.orig);
  });
  $$('[data-i18n-title]').forEach((el) => {
    if (el.dataset.origTitle == null) el.dataset.origTitle = el.title;
    el.title = pick(el.dataset.i18nTitle, el.dataset.origTitle);
  });
  $$('[data-i18n-ph]').forEach((el) => {
    if (el.dataset.origPh == null) el.dataset.origPh = el.placeholder;
    el.placeholder = pick(el.dataset.i18nPh, el.dataset.origPh);
  });
  document.documentElement.lang = S.uiLanguage || 'es';
  try {
    wireLinks(document);
  } catch {
    /* not yet defined */
  }
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function md(s) {
  let h = esc(s);
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(
    /(^|\n)((?:[-•*] .*(?:\n|$))+)/g,
    (m, pre, block) =>
      pre +
      '<ul>' +
      block
        .trim()
        .split('\n')
        .map((l) => '<li>' + l.replace(/^[-•*] /, '') + '</li>')
        .join('') +
      '</ul>'
  );
  h = h.replace(
    /(^|\n)((?:\d+[.)] .*(?:\n|$))+)/g,
    (m, pre, block) =>
      pre +
      '<ol>' +
      block
        .trim()
        .split('\n')
        .map((l) => '<li>' + l.replace(/^\d+[.)] /, '') + '</li>')
        .join('') +
      '</ol>'
  );
  return h.replace(/\n{2,}/g, '\n').replace(/\n/g, '<br>');
}
let toastTimer;
function toast(text, kind = '') {
  const el = $('#toast');
  el.textContent = text;
  el.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}
function setBusy(text) {
  const b = $('#busy');
  if (text) {
    b.classList.remove('hidden');
    $('#busyText').textContent = text;
  } else b.classList.add('hidden');
}
function civName(key) {
  const c = civs.find((x) => x.key === key);
  return c ? ((S.uiLanguage || 'es') === 'es' ? c.name_es : c.name_en) : key;
}

/** Compact answer area: show one exchange (or a system notice). */
const SPOKEN = new Map();
let spokenSeq = 0;
/** 🔊 button that re-reads one specific answer (placed inside that answer's box). */
function replayBtn(text) {
  if (!text) return '';
  const id = 'r' + ++spokenSeq;
  SPOKEN.set(id, text);
  if (SPOKEN.size > 60) SPOKEN.delete(SPOKEN.keys().next().value);
  return `<button class="replayIn" data-rid="${id}" title="${esc(tr('replay.title'))}">🔊</button>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.replayIn');
  if (!b) return;
  e.preventDefault();
  const txt = SPOKEN.get(b.dataset.rid);
  if (!txt) return;
  if (speaking && b.classList.contains('playing')) {
    stopSpeaking();
    return;
  }
  $$('.replayIn.playing').forEach((x) => x.classList.remove('playing'));
  b.classList.add('playing');
  speak(txt).finally(() => setTimeout(() => b.classList.remove('playing'), 300));
});
function showAnswer({ q, html, cls = 'a', meta = '', speakText = '' }) {
  const box = $('#answer');
  box.innerHTML =
    (q ? `<div class="q">${esc(q)}</div>` : '') +
    `<div class="${cls}">${speakText ? replayBtn(speakText) : ''}${html}</div>` +
    (meta ? `<div class="meta">${esc(meta)}</div>` : '');
  box.scrollTop = 0;
}
function addMsg(kind, text, meta) {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.innerHTML = kind === 'assistant' ? replayBtn(text) + answerHtml(text) : kind === 'system' ? md(text) : esc(text);
  if (meta) {
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta;
    el.appendChild(m);
  }
  const box = $('#messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
/** Buttons for the things people do most, shown with the welcome and after /nueva (they cost no permanent space in the overlay). */
function quickChips() {
  const items = [
    ['sheet', 'chip.sheet'],
    ['counters', 'chip.counters'],
    ['bo', 'chip.bo'],
    ['guide', 'chip.guide'],
    ['new', 'chip.new'],
    ['help', 'chip.help'],
  ];
  return `<div class="qchips">${items.map(([a, k]) => `<button data-act="${a}">${esc(tr(k))}</button>`).join('')}</div>`;
}
function sysNotice(html) {
  showAnswer({ html, cls: 'sys' });
  // full window / web: the compact answer box is hidden, so notices also go to the chat history
  if (document.body.classList.contains('full')) {
    const el = document.createElement('div');
    el.className = 'msg system';
    el.innerHTML = html;
    const box = $('#messages');
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    try {
      wireLinks(el);
    } catch {
      /* */
    }
  }
}

/* ----------------------------------------------------------------- 3-line summary + detail */
function splitAnswer(text) {
  const t = String(text || '')
    .trim()
    .replace(/^\s*\**(SUMMARY|RESUMEN|TL;?DR)\**\s*:?\**\s*\n/i, '')
    .replace(/(\n\s*-{3,}\s*\n)\s*\**(DETAIL|DETALLE|DETAILS)\**\s*:?\**\s*\n/i, '$1');
  const m = t.match(/^([\s\S]*?)\n\s*-{3,}\s*\n([\s\S]*)$/);
  let sum = '',
    det = t;
  if (m && /^\s*[•\-*]/.test(m[1])) {
    sum = m[1].trim();
    det = m[2].trim();
  } else {
    const lines = t.split('\n');
    const head = [];
    while (lines.length && /^\s*•/.test(lines[0]) && head.length < 3) head.push(lines.shift());
    if (head.length === 3) {
      sum = head.join('\n');
      det = lines.join('\n').trim();
    }
  }
  return { sum, det };
}
function answerHtml(text) {
  const { sum, det } = splitAnswer(text);
  if (!sum) return md(text || '…');
  const items = sum
    .split('\n')
    .map((l) => l.replace(/^\s*[•\-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
  return `<div class="tldr">${items.map((i) => `<div>• ${md(i)}</div>`).join('')}</div>${det ? `<div class="detail">${md(det)}</div>` : ''}`;
}
function spokenText(text) {
  const { sum } = splitAnswer(text);
  return sum ? sum.replace(/^\s*[•\-*]\s*/gm, '').replace(/\*\*/g, '') : text;
}

/* ----------------------------------------------------------------- team bar (4 v 4) */
let IMG = { base: '', civs: {}, units: {} },
  TC = null,
  pickSlot = null;
const civIcon = (key, cls = 'cico') => (key && IMG.civs[key] ? `<img class="${cls}" src="${esc(IMG.base + IMG.civs[key])}" alt="">` : '');
const unitIcon = (en) => (en && IMG.units[en] ? `<img class="uico" src="${esc(IMG.base + IMG.units[en])}" alt="">` : '');
function teamSlots() {
  const mine = [state.myCiv || '', ...(state.allies || [])];
  while (mine.length < 4) mine.push('');
  const en = state.enemies && state.enemies.length ? [...state.enemies] : state.oppCiv ? [state.oppCiv] : [];
  while (en.length < 4) en.push('');
  return { mine: mine.slice(0, 4), theirs: en.slice(0, 4) };
}
async function renderTeam() {
  const { mine, theirs } = teamSlots();
  const slot = (side, i, key) => {
    const role = side === 'mine' ? (i === 0 ? tr('team.me') : tr('team.ally')) : tr('team.enemy');
    const title = key ? `${civName(key)} — ${role}` : `${role}: ${tr('team.pick')}`;
    return `<button class="slot ${key ? 'set' : 'empty'} ${side === 'mine' && i === 0 ? 'me' : ''}" data-side="${side}" data-i="${i}" title="${esc(title)}" aria-label="${esc(title)}">
      <span class="sh"><i>${key ? civIcon(key) : '<em>+</em>'}</i></span><span class="nm">${key ? esc(civName(key)) : esc(side === 'mine' && i === 0 ? tr('team.slotMe') : role)}</span></button>`;
  };
  $('#tbMine').innerHTML = mine.map((k, i) => slot('mine', i, k)).join('');
  $('#tbTheirs').innerHTML = theirs.map((k, i) => slot('theirs', i, k)).join('');
  $$('#teamBar .slot').forEach((b) => b.addEventListener('click', () => openPick(b.dataset.side, Number(b.dataset.i), b)));
  TC = await window.coach.team.counters();
  const anySet = mine.some(Boolean) || theirs.some(Boolean);
  const hint = $('#tbHint');
  if (hint) hint.classList.toggle('off', !!(state.myCiv && theirs.some(Boolean)));
  $$('#tbTheirs .slot').forEach((b) => {
    const k = theirs[Number(b.dataset.i)];
    const row = TC.rows.find((r) => r.civ === k);
    if (row) b.title = civName(k) + '\n' + tcLines(row).join('\n');
  });
  $('#tcPanel').innerHTML = tcHtml();
  $('#tcPanel').classList.toggle('off', !anySet);
}
function tcLines(row) {
  return row.threats.map(
    (t) => `${uName(t)}${t.unique ? ` (${tr('team.unique')})` : ''} → ${t.answers.length ? t.answers.map((a) => uName(a)).join(' / ') : tr('team.noAnswer')}`
  );
}
function tcHtml() {
  if (!TC || !TC.rows.length) return `<span class="muted small">${tr('team.empty')}</span>`;
  if (!TC.myCiv) return `<span class="muted small">${tr('team.noCiv')}</span>`;
  const unit = (u, cls) => `<span class="unit ${cls}">${unitIcon(u.unit)}<span>${esc(uName(u))}</span>${u.unique ? `<i>${tr('team.unique')}</i>` : ''}</span>`;
  return (
    `<div class="tch">${tr('team.header', { civ: `<b>${esc(civName(TC.myCiv))}</b>`, age: esc(L.ages[TC.age] || '') })}${TC.ageAssumed ? ' ' + tr('team.ageAssumed') : ''} <span class="muted">· ${tr('team.method')}</span></div>
    <div class="tclegend"><span class="lg enemy">${esc(tr('team.theyMake'))}</span><span class="arr">→</span><span class="lg mine">${esc(tr('team.youAnswer'))}</span></div>` +
    TC.rows
      .map(
        (r) =>
          `<div class="tcrow"><div class="tcciv">${civIcon(r.civ)}<b>${esc(civName(r.civ))}</b></div><div class="tcpairs">${r.threats.map((t) => `<div class="pair">${unit(t, 'enemy')}<span class="arr">→</span>${t.answers.length ? t.answers.map((a) => unit(a, 'mine')).join('') : `<span class="muted small">${tr('team.noAnswer')}</span>`}</div>`).join('')}</div></div>`
      )
      .join('')
  );
}
function showCountersNotice() {
  if (!TC || !TC.rows.length || !TC.myCiv) {
    sysNotice(tcHtml());
    return;
  }
  sysNotice(
    `<b>${tr('team.title', { civ: esc(civName(TC.myCiv)) })} (${esc(L.ages[TC.age] || '')}${TC.ageAssumed ? '?' : ''}):</b><br>` +
      TC.rows.map((r) => `<b>${esc(civName(r.civ))}:</b> ${esc(tcLines(r).join(' · '))}`).join('<br>')
  );
}
function openPick(side, i, el) {
  pickSlot = { side, i };
  const box = $('#civPick');
  box.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  box.style.top = Math.min(r.bottom + 2, window.innerHeight - 200) + 'px';
  box.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 234)) + 'px';
  $('#cpSearch').value = '';
  renderPick();
  $('#cpSearch').focus();
}
function renderPick() {
  const q = norm($('#cpSearch').value);
  const list = civs.filter((c) => !q || norm(c.name_es + ' ' + c.name_en).includes(q)).sort((a, b) => a.name_es.localeCompare(b.name_es));
  $('#cpList').innerHTML = list.map((c) => `<div class="cpi" data-k="${esc(c.key)}">${civIcon(c.key)}<span>${esc(c.name_es)}</span></div>`).join('');
  $$('#cpList .cpi').forEach((d) => d.addEventListener('click', () => pickCiv(d.dataset.k)));
}
async function pickCiv(key) {
  if (!pickSlot) return;
  const { mine, theirs } = teamSlots();
  const { side, i } = pickSlot;
  const arr = side === 'mine' ? mine : theirs;
  arr[i] = key || '';
  const patch = side === 'mine' ? (i === 0 ? { myCiv: key || '' } : { allies: mine.slice(1).filter(Boolean) }) : { enemies: theirs.filter(Boolean) };
  $('#civPick').classList.add('hidden');
  pickSlot = null;
  if (await setState(patch)) {
    await renderTeam();
    if (side === 'theirs' || i === 0) showCountersNotice();
  }
}

/* ----------------------------------------------------------------- state line */
function renderState() {
  const parts = [];
  const al = state.allies || [],
    en = state.enemies || [];
  if (al.length || en.length > 1) parts.push(`${al.length + 1}v${Math.max(en.length, 1)}`);
  else if (state.myCiv || state.oppCiv) parts.push(`${state.myCiv ? civName(state.myCiv) : '?'} vs ${state.oppCiv ? civName(state.oppCiv) : '?'}`);
  if (state.age) parts.push(L.ages[state.age] + (state.oppAge ? ` (${L.ages[state.oppAge]})` : ''));
  if (state.map) parts.push(state.map);
  if (state.elo) parts.push('ELO ' + state.elo);
  const line = parts.join(' · ') + (state.source === 'detected' && parts.length ? ' · auto' : '');
  $('#stateLine').textContent = line;
  $('#stateLine').classList.toggle('hidden', !line);
  $('#stateEmpty').classList.toggle('hidden', !!line);
  const extra = [
    state.myArmy && tr('tip.me') + ': ' + state.myArmy,
    state.theirArmy && tr('tip.rival') + ': ' + state.theirArmy,
    state.myEco && tr('tip.eco') + ': ' + state.myEco,
    state.notes,
  ]
    .filter(Boolean)
    .join(' · ');
  $('#stateLine').title = (line + (extra ? '\n' + extra : '')).trim();
  renderTeam();
  renderBoCivNotes();
  if (CAT && $('#tab-bo').classList.contains('active')) renderCatalog(); // "Para tu partida" follows the registered civ / map
}
async function setState(patch) {
  const r = await window.coach.state.set(patch);
  if (!r.ok) {
    toast(r.error, 'err');
    return false;
  }
  state = r.state;
  renderState();
  return true;
}

/* ----------------------------------------------------------------- commands */
const AGES = { dark: 1, oscura: 1, alta: 1, 1: 1, feudal: 2, 2: 2, castle: 3, castillo: 3, castillos: 3, 3: 3, imperial: 4, imp: 4, 4: 4 };
async function runCommand(line) {
  const m = line.match(/^\/(\S+)\s*(.*)$/);
  if (!m) return false;
  const cmd = m[1].toLowerCase(),
    arg = m[2].trim();
  const ok = async (msg) => {
    sysNotice(`<b>${esc(msg)}</b>`);
  };
  switch (cmd) {
    case 'civ':
    case 'yo':
    case 'me':
      if (await setState({ myCiv: arg })) ok(L.stateSet);
      return true;
    case 'vs':
    case 'rival':
    case 'opp':
    case 'rivales':
    case 'enemigos':
    case 'enemies':
      if (await setState(/[,;/+]| y | and /.test(arg) || /rivales|enemigos|enemies/.test(cmd) ? { enemies: arg } : { oppCiv: arg })) {
        await renderTeam();
        showCountersNotice();
      }
      return true;
    case 'aliados':
    case 'aliado':
    case 'allies':
    case 'equipo':
      if (await setState({ allies: arg })) {
        await renderTeam();
        ok(L.stateSet);
      }
      return true;
    case 'counters':
    case 'contras':
      await renderTeam();
      showCountersNotice();
      return true;
    case 'edad':
    case 'age': {
      const a = AGES[arg.toLowerCase()];
      if (!a) {
        toast('dark/feudal/castle/imperial', 'warn');
        return true;
      }
      if (await setState({ age: a })) ok(L.stateSet);
      return true;
    }
    case 'mapa':
    case 'map':
      if (await setState({ map: arg })) ok(L.stateSet);
      return true;
    case 'elo':
      if (await setState({ elo: arg })) ok(L.stateSet);
      return true;
    case 'nota':
    case 'note':
    case 'notes':
      if (await setState({ notes: arg })) ok(L.stateSet);
      return true;
    case 'nueva':
    case 'new':
    case 'newgame': {
      const r = await window.coach.chat.newGame();
      state = r.state;
      renderState();
      $('#messages').innerHTML = '';
      sysNotice(`<b>${esc(L.newGame)}</b>` + quickChips());
      return true;
    }
    case 'reset':
      await window.coach.chat.reset();
      $('#messages').innerHTML = '';
      ok(L.resetMsg);
      return true;
    case 'bo':
    case 'build':
      await boCommand(arg);
      return true;
    case 'n':
    case 'next':
      boMove(1);
      return true;
    case 'p':
    case 'prev':
    case 'a':
      boMove(-1);
      return true;
    case 'voz':
    case 'voice': {
      const on = arg ? /^(on|si|sí|1|yes)$/i.test(arg) : !(S.voiceOut !== false);
      await save({ voiceOut: on });
      $('#btnVoice').classList.toggle('on', on);
      if (!on) stopSpeaking();
      ok(on ? L.voiceOn : L.voiceOff);
      return true;
    }
    case 'mal':
    case 'bad':
    case 'flag':
      await window.coach.chat.flag(arg);
      ok(L.flagged);
      return true;
    case 'full':
    case 'expandir':
      setMode(false);
      return true;
    case 'compact':
    case 'compacto':
    case 'mini':
      setMode(true);
      return true;
    case 'ayuda':
    case 'help':
    case '?':
      sysNotice(L.help.replace(/\n/g, '<br>') + '<br>' + tr('help.sheet'));
      return true;
    case 'ficha':
    case 'sheet': {
      const r = await window.coach.chat.sheet(arg);
      if (!r.ok) {
        toast(r.error, 'err');
        return true;
      }
      state = r.state;
      renderState();
      showSheet(arg || tr('sheet.title'), r);
      return true;
    }
    case 'consejo':
    case 'advice':
    case 'advise':
      await ask(arg, { advise: true });
      return true;
    case 'modo':
    case 'mode': {
      const v = /^(libre|free|ia|ai|coach)$/i.test(arg)
        ? 'libre'
        : /^(ficha|sheet|datos|data)$/i.test(arg)
          ? 'ficha'
          : /^(local|offline|sin ia|no ai)$/i.test(arg)
            ? 'local'
            : answerMode() === 'local'
              ? 'ficha'
              : answerMode() === 'ficha'
                ? 'libre'
                : 'local';
      await save({ answerMode: v, modeChosen: true });
      renderAnswerMode();
      ok(tr('mode.changed', { mode: tr('mode.' + v) }));
      return true;
    }
    case 'log':
    case 'logs':
      window.coach.app.openLogs();
      return true;
    case 'guia':
    case 'guía':
    case 'guide': {
      const a = (arg || '').trim();
      let go = {};
      if (a) {
        const c = (await window.coach.civs()).find((x) => [x.name_es, x.name_en, x.key].some((n) => (n || '').toLowerCase() === a.toLowerCase()));
        go = c ? { tab: 'civs', civ: c.key } : { tab: 'maps', map: a };
      }
      openGuide(go);
      return true;
    }
    case 'mapas':
    case 'maps': {
      const ms = await window.coach.maps();
      sysNotice(`<b>${esc(tr('maps.title'))}</b> ` + esc(ms.join(' · ')));
      return true;
    }
    case 'civ?':
    case 'perfil':
    case 'profile': {
      const r = await window.coach.profile('civ', arg);
      sysNotice(r ? md(r) : esc('—'));
      return true;
    }
    case 'mapa?':
    case 'map?': {
      const r = await window.coach.profile('map', arg || state.map);
      sysNotice(r ? md(r) : esc('—'));
      return true;
    }
    case 'repetir':
    case 'repeat':
    case 'r':
      if (lastAnswerText) speak(lastAnswerText);
      else toast(tr('replay.none'));
      return true;
    case 'partida':
    case 'match':
      await matchNow(/^(usar|use|aplicar)$/i.test(arg));
      return true;
    case 'parche':
    case 'patch': {
      await window.coach.patch.check();
      const p = await window.coach.patch.status();
      sysNotice(esc(p.line));
      renderPatch();
      return true;
    }
    case 'salir':
    case 'quit':
      window.coach.window.quit();
      return true;
    default:
      toast(L.unknownCmd, 'warn');
      return true;
  }
}

/* ----------------------------------------------------------------- ficha (structured answer built from the data) */
const RES_ICON = { food: '🍖', wood: '🪵', gold: '🪙', stone: '🪨' };
const SHEETS = new Map(); // sheet id → sheet data (the buttons inside a rendered sheet look their data up here)
let sheetSeq = 0;
const answerMode = () => S.answerMode || 'local';
const sheetMode = () => answerMode() !== 'libre'; // local and ficha both answer with the sheet
const localMode = () => answerMode() === 'local'; // no AI at all
/** The "missing key" banner only matters when the chosen mode uses an AI. */
const keyBanner = () => $('#setupBanner').classList.toggle('hidden', localMode() || !(S.provider === 'anthropic' && !S.anthropicApiKey));
/** Spanish profile text gets a marker so one click can translate every such span in a sheet (guide.translate). */
const shtr = (text) => `<span class="shtr">${md(text)}</span>`;
function sheetCivHtml(c, sh) {
  const uiEs = (S.uiLanguage || 'es') === 'es';
  const rows = [];
  const row = (label, body) => body && rows.push(`<div class="shl"><b>${esc(label)}:</b> ${body}</div>`);
  row(tr('sheet.strength'), c.strength ? shtr(c.strength) : '');
  if (c.bonuses.length) row(tr('sheet.bonuses'), `<ul>${c.bonuses.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
  row(tr('sheet.teamBonus'), c.teamBonus ? esc(c.teamBonus) : '');
  if (c.uniqueUnits.length)
    row(
      tr('sheet.uu'),
      c.uniqueUnits
        .map(
          (u) =>
            `${unitIcon(u.en)} <b>${esc(u.name)}</b>${
              u.cost
                ? ` <span class="muted small">${esc(
                    Object.entries(u.cost)
                      .map(([k, v]) => `${v}${RES_ICON[k.toLowerCase()] || k[0]}`)
                      .join(' ')
                  )}</span>`
                : ''
            }`
        )
        .join(', ') + (c.uniqueUnitText ? ' — ' + shtr(c.uniqueUnitText) : '')
    );
  if (c.uniqueTechs.length)
    row(
      tr('sheet.ut'),
      c.uniqueTechs
        .map((t) => `<b>${esc(t.name)}</b>${t.text ? ` <span class="muted">(${esc(t.text.replace(/^[^(]*\((.*)\)$/, '$1'))})</span>` : ''}`)
        .join(' · ')
    );
  const miss = [...c.missingUnits.map((x) => (uiEs ? x : x.replace(/\s*\(.*\)$/, ''))), ...c.missingTechs];
  if (miss.length) row(tr('sheet.missing'), esc(miss.slice(0, 10).join(', ')) + (miss.length > 10 ? ` <span class="muted">+${miss.length - 10}</span>` : ''));
  if (c.openingHere) row(tr('sheet.opening'), shtr(c.openingHere));
  else if (c.openings.length) row(tr('sheet.opening'), `<ul>${c.openings.map((o) => `<li>${shtr(o)}</li>`).join('')}</ul>`);
  if (c.role === 'opp' && c.against) row(tr('sheet.against'), shtr(c.against));
  const more = [];
  const mrow = (label, body) => body && more.push(`<div class="shl"><b>${esc(label)}:</b> ${shtr(body)}</div>`);
  if (c.role !== 'opp') {
    mrow(tr('sheet.compositions'), c.compositions);
    mrow(tr('sheet.castle'), c.castlePlan);
    mrow(tr('sheet.imperial'), c.imperialPlan);
  } else mrow(tr('sheet.compositions'), c.compositions);
  mrow(tr('sheet.mistakes'), c.mistakes);
  const lineup = Object.entries(c.lineup || {})
    .map(([b, us]) => `<li><b>${esc(b)}</b>: ${us.map((u) => `${unitIcon(u.en)}${esc(u.name)}`).join(', ')}</li>`)
    .join('');
  if (lineup) more.push(`<div class="shl"><b>${esc(tr('sheet.lineup'))}:</b><ul>${lineup}</ul></div>`);
  const stats = c.stats ? ` <span class="muted small">· ${esc(tr('sheet.stats', { wr: c.stats.wr, tier: c.stats.tier }))}</span>` : '';
  const title = `${civIcon(c.key)} ${esc(tr('sheet.' + (c.role === 'subject' ? 'civ' : c.role)))}: <b>${esc(c.name)}</b>${c.style ? ` <i class="muted">(${esc(c.style)})</i>` : ''}${stats}`;
  return {
    title,
    body:
      rows.join('') +
      (c.derived ? `<div class="muted small">${esc(tr('sheet.derived'))}</div>` : '') +
      (more.length ? `<details class="shm"><summary>${esc(tr('sheet.more'))}</summary>${more.join('')}</details>` : ''),
  };
}
function sheetMapHtml(m, sh) {
  const rows = [];
  const row = (label, body) => body && rows.push(`<div class="shl"><b>${esc(label)}:</b> ${shtr(body)}</div>`);
  row(tr('sheet.mapWins'), m.wins);
  row(tr('sheet.mapOpenings'), m.openings);
  row(tr('sheet.mapTimings'), m.timings);
  if (m.vsLine && sh.opp) row(tr('sheet.mapVs', { civ: sh.opp.name }), m.vsLine);
  const more = [];
  const mrow = (label, body) => body && more.push(`<div class="shl"><b>${esc(label)}:</b> ${shtr(body)}</div>`);
  mrow(tr('sheet.mapWalls'), m.walls);
  mrow(tr('sheet.mapRes'), m.resources);
  mrow(tr('sheet.mapCivs'), m.civs);
  mrow(tr('sheet.mistakes'), m.mistakes);
  if (!m.vsLine) mrow(tr('sheet.mapVs', { civ: '…' }).replace(' …', ''), m.vsCiv);
  // the map pictures are keyed by the lower-case name without accents or spaces (same rule as the guide)
  const mk = (n) =>
    String(n || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  const mapKey = IMG.maps ? [m.name, ...(m.aliases || [])].map(mk).find((x) => x && IMG.maps[x]) : '';
  const pic = mapKey ? `<img class="shmap" src="${esc(IMG.base + IMG.maps[mapKey])}" alt="">` : '';
  return {
    title: `${esc(tr('sheet.map'))}: <b>${esc(m.name)}</b>${m.type ? ` <i class="muted">(${esc(m.type)})</i>` : ''}`,
    body: pic + rows.join('') + (more.length ? `<details class="shm"><summary>${esc(tr('sheet.more'))}</summary>${more.join('')}</details>` : ''),
  };
}
function sheetCountersHtml(c, sh) {
  const src = c.from === 'threats' && sh.opp ? tr('sheet.fromThreats', { civ: sh.opp.name }) : c.from === 'army' ? tr('sheet.fromArmy') : '';
  const note = [src, c.ageAssumed ? tr('sheet.ageAssumed', { age: L.ages[c.age] }) : L.ages[c.age]].filter(Boolean).join(' · ');
  const rows = c.rows
    .map(
      (r) =>
        `<div class="shc">${esc(tr('sheet.vs', {}, 'vs'))} ${unitIcon(r.unit_en)}<b>${esc(r.unit)}</b> → ${
          r.noCiv
            ? `<span class="muted">${esc(tr('sheet.noCiv'))}</span>`
            : r.options.length
              ? r.options
                  .map(
                    (o) =>
                      `<span class="opt" title="${esc(o.note || '')}${o.kited ? ' (kited)' : ''}">${unitIcon(o.unit_en)}${esc(o.unit)} <i>${o.score}</i>${o.note ? `<small>${esc(o.note)}</small>` : ''}</span>`
                  )
                  .join(' · ')
              : `<span class="muted">${esc(tr('sheet.noAnswer'))}</span>`
        }</div>`
    )
    .join('');
  return { title: `${esc(tr('sheet.counters'))} <span class="muted small">· ${esc(note)}</span>`, body: rows };
}
function sheetUnitsHtml(units, sh) {
  const fmtCost = (c) =>
    Object.entries(c || {})
      .map(([k, v]) => `${v}${RES_ICON[k.toLowerCase()] || k[0]}`)
      .join(' ');
  const rows = units
    .map(
      (u) =>
        `<div class="shu"><div class="t">${unitIcon(u.name_en)}<b>${esc(u.name)}</b> <span class="muted">· ${esc(L.ages[u.age] || '')} · ${esc(fmtCost(u.cost))}${u.trainTime ? ' · ' + esc(tr('sheet.train', { s: u.trainTime })) : ''}</span>${
          u.mineCan === false ? ` <span class="tag bad">${esc(tr('sheet.mineNo'))}</span>` : ''
        }${u.theirsCan === false && sh.opp ? ` <span class="tag warn">${esc(tr('sheet.theirsNo'))}</span>` : ''}</div><div class="s">${esc(tr('sheet.hp'))} <b>${u.hp}</b> · ${esc(tr('g.attack'))} <b>${u.attack}</b>${
          u.range ? ` (${esc(tr('g.range'))} ${u.range})` : ''
        } · ${esc(tr('g.armor'))} <b>${esc(u.armor)}</b> · ${esc(tr('g.speed'))} <b>${u.speed}</b>${u.bonusDamage.length ? `<br>${esc(tr('sheet.bonus'))}: ${esc(u.bonusDamage.join(' · '))}` : ''}</div></div>`
    )
    .join('');
  return { title: esc(tr('sheet.units')), body: rows };
}
function sheetBuildsHtml(b, sh) {
  const civKeyOf = (n) => {
    const c = civs.find((x) => x.name_en === n || x.name_es === n || x.key === n);
    return c ? c.key : '';
  };
  const why = (x) =>
    x.why.length
      ? x.why
          .map((w) => tr(w === 'civ' ? 'sheet.whyCiv' : w === 'map' ? 'sheet.whyMap' : 'sheet.whyOpening'))
          .filter((v, i, a) => a.indexOf(v) === i)
          .join(', ')
      : tr('sheet.generic');
  const card = (x) =>
    `<div class="shb tier-${esc(x.tier)}"><div class="t">${x.civs
      .filter((c) => c !== 'Any')
      .slice(0, 2)
      .map((c) => civIcon(civKeyOf(c), 'cico sm'))
      .join(
        ''
      )}${esc(x.title)}${x.tier !== 'meta' ? ` <span class="tag ${x.tier === 'meme' ? 'bad' : 'warn'}">${TIER_LABEL[x.tier]}</span>` : ''}</div><div class="s"><span class="muted">${esc(
      [x.types.slice(0, 2).join(', '), x.author, x.feudalPop ? `${x.feudalPop} pop` : x.steps ? `${x.steps} ${tr('bo.steps')}` : ''].filter(Boolean).join(' · ')
    )} · <i>${esc(why(x))}</i></span>${
      x.kind === 'steps'
        ? `<button class="small" data-shbo="${esc(x.id)}">${esc(tr('sheet.load'))}</button>`
        : `<button class="ghost small" data-shguide="${esc(x.id)}">${esc(tr('sheet.open'))}</button>`
    }</div></div>`;
  return {
    title: esc(tr('sheet.builds')),
    body: b.steps.map(card).join('') + (b.guides.length ? `<div class="shg">${esc(tr('sheet.guides'))}</div>${b.guides.map(card).join('')}` : ''),
  };
}
function sheetHtml(sh, { compact = false, extracted = false } = {}) {
  const id = 's' + ++sheetSeq;
  SHEETS.set(id, sh);
  if (SHEETS.size > 30) SHEETS.delete(SHEETS.keys().next().value);
  const head = [];
  if (sh.me) head.push(`${civIcon(sh.me.key)}${esc(sh.me.name)}`);
  if (sh.opp) head.push(`vs ${civIcon(sh.opp.key)}${esc(sh.opp.name)}`);
  if (sh.map) head.push(esc(sh.map.name));
  if (sh.state.age) head.push(esc(L.ages[sh.state.age] || ''));
  if (sh.state.elo) head.push('ELO ' + esc(sh.state.elo));
  const missing = sh.missing.filter((k) => k !== 'elo' || !sh.me).map((k) => tr('sheet.missing.' + k));
  const blocks = [];
  const add = (key, b) => b && blocks.push({ key, ...b });
  const order =
    sh.focus === 'counters'
      ? ['counters', 'units', 'subject', 'opp', 'me', 'map', 'builds']
      : sh.focus === 'units'
        ? ['units', 'counters', 'me', 'opp', 'map', 'builds']
        : sh.focus === 'opp'
          ? ['opp', 'counters', 'units', 'me', 'map', 'builds']
          : sh.focus === 'map'
            ? ['map', 'me', 'opp', 'counters', 'units', 'builds']
            : sh.focus === 'builds'
              ? ['builds', 'me', 'map', 'opp', 'counters', 'units']
              : sh.subject
                ? ['subject', 'me', 'opp', 'map', 'counters', 'units', 'builds']
                : ['me', 'opp', 'map', 'counters', 'units', 'builds'];
  for (const k of order) {
    if (k === 'units' && sh.units && sh.units.length) add('units', sheetUnitsHtml(sh.units, sh));
    if (k === 'me' && sh.me) add('me', sheetCivHtml(sh.me, sh));
    if (k === 'opp' && sh.opp) add('opp', sheetCivHtml(sh.opp, sh));
    if (k === 'subject' && sh.subject) add('subject', sheetCivHtml(sh.subject, sh));
    if (k === 'map' && sh.map) add('map', sheetMapHtml(sh.map, sh));
    if (k === 'counters' && sh.counters && sh.counters.rows.length) add('counters', sheetCountersHtml(sh.counters, sh));
    if (k === 'builds' && sh.builds && !sh.builds.none) add('builds', sheetBuildsHtml(sh.builds, sh));
  }
  const canAdvise = hasKey() && !localMode();
  const canTranslate = (S.uiLanguage || 'es') !== 'es' && hasKey();
  return (
    `<div class="sheet" data-sheet="${id}">` +
    `<div class="shh"><span class="shtag">${esc(tr('sheet.title'))}</span> ${head.join(' · ') || `<span class="muted">${esc(tr('sheet.hint'))}</span>`}${
      missing.length && head.length ? ` <span class="muted small">· ${esc(tr('sheet.missingState', { list: missing.join(', ') }))}</span>` : ''
    }</div>` +
    blocks
      .map(
        (b, i) =>
          `<details class="shd ${b.key}"${i === 0 || (!compact && i === 1) ? ' open' : ''}><summary>${b.title}</summary><div class="shb-body">${b.body}</div></details>`
      )
      .join('') +
    `<div class="shf">${
      canAdvise
        ? `<button class="small" data-shadvise="${id}">💡 ${esc(tr('sheet.advise'))}</button>`
        : localMode()
          ? `<button class="ghost small" data-shsettings="1">💡 ${esc(tr('sheet.adviseLocal'))}</button>`
          : `<span class="muted small">${esc(tr('sheet.adviseNoKey'))}</span>`
    }${
      canTranslate ? `<button class="ghost small" data-shtr="${id}">🌐 ${esc(tr('g.translate'))}</button>` : ''
    }<span class="muted small shmode">${esc(extracted ? tr('sheet.extracted') : localMode() ? tr('sheet.modeLocal') : tr('sheet.mode'))}</span></div></div>`
  );
}
/** Show a sheet as the answer to `q` (compact box + chat history) and read its summary aloud. */
function showSheet(q, r, meta = '') {
  lastAnswerText = r.spoken || '';
  const extracted = /^ficha\+/.test(r.model || '');
  showAnswer({ q, html: sheetHtml(r.sheet, { compact: true, extracted }), cls: 'a', meta, speakText: r.spoken || '' });
  const el = document.createElement('div');
  el.className = 'msg assistant sheetMsg';
  el.innerHTML = (r.spoken ? replayBtn(r.spoken) : '') + sheetHtml(r.sheet, { extracted });
  if (meta) {
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta;
    el.appendChild(m);
  }
  const box = $('#messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  if (r.spoken && S.voiceOut !== false && S.ttsEngine !== 'off') speak(r.spoken);
}
// buttons inside a sheet: load a build into the panel, open a guide in the catalog, ask the AI, translate the Spanish bits
document.addEventListener('click', async (e) => {
  const t = e.target.closest && e.target.closest('[data-shbo],[data-shguide],[data-shadvise],[data-shtr],[data-shsettings]');
  if (!t) return;
  e.preventDefault();
  if (t.dataset.shsettings) {
    setMode(false);
    showTab('settings');
    const el = $('#setAnswerMode');
    if (el) el.scrollIntoView({ block: 'center' });
  } else if (t.dataset.shbo) {
    await selectBo(t.dataset.shbo);
    if (document.body.classList.contains('full')) {
      showTab('bo');
      $('#boStep').scrollIntoView({ block: 'nearest' });
    }
  } else if (t.dataset.shguide) {
    setMode(false);
    showTab('bo');
    await renderCatalog();
    openCatalogEntry(t.dataset.shguide);
    const r = $('#boReader');
    if (r) r.scrollIntoView({ block: 'nearest' });
  } else if (t.dataset.shadvise) {
    ask('', { advise: true });
  } else if (t.dataset.shtr) {
    const root = t.closest('.sheet');
    const spans = [...root.querySelectorAll('.shtr')];
    if (!spans.length) return;
    t.disabled = true;
    t.textContent = '… ' + tr('g.translating');
    const SEP = '\n@@@\n';
    const r = await window.coach.guide.translate({ text: spans.map((s) => s.textContent).join(SEP), lang: S.uiLanguage || 'en' });
    const parts = r && r.ok ? r.text.split(/\n?@@@\n?/) : [];
    if (parts.length === spans.length) {
      spans.forEach((s, i) => (s.innerHTML = md(parts[i].trim())));
      t.remove();
    } else {
      t.disabled = false;
      t.textContent = '⚠ ' + tr('g.trFail');
      t.title = (r && r.error) || '';
    }
  }
});

/* ----------------------------------------------------------------- ask */
/** One message to the coach. opts.advise: "pedir consejo" (free answer built on the sheet, needs an AI provider). */
async function ask(text, { advise = false } = {}) {
  text = (text || '').trim();
  if ((!text && !advise) || busy) return;
  if (!advise && text.startsWith('/')) {
    await runCommand(text);
    return;
  }
  const ficha = !advise && sheetMode();
  if (!ficha && S.provider === 'anthropic' && !S.anthropicApiKey) {
    showAnswer({ q: text, html: explainError('No Claude API key set'), cls: 'err' });
    wireLinks($('#answer'));
    return;
  }
  const shown = advise ? '💡 ' + (text || tr('sheet.consejoQ')) : text;
  busy = true;
  stopSpeaking();
  showAnswer({ q: shown, html: `<span class="muted">${esc(L.busy.thinking)}</span>`, cls: 'a' });
  addMsg('user', shown);
  setBusy(L.busy.thinking);
  // live view: the answer is shown (and the 3-line summary read aloud) while the model is still writing the detail
  let live = '';
  let spokeEarly = false;
  let liveEl = null;
  const paintLive = () => {
    const html = answerHtml(live);
    showAnswer({ q: shown, html, cls: 'a' });
    if (document.body.classList.contains('full')) {
      if (!liveEl) {
        liveEl = document.createElement('div');
        liveEl.className = 'msg assistant live';
        $('#messages').appendChild(liveEl);
      }
      liveEl.innerHTML = html;
      renderHistoryScroll();
    }
    if (!spokeEarly && S.voiceOut !== false && S.ttsEngine !== 'off' && /\n\s*-{3,}\s*\n/.test(live)) {
      spokeEarly = true;
      speak(spokenText(live));
    }
  };
  const off = window.coach.chat.onEvent((ev) => {
    if (ev.type === 'tool') setBusy((L.tool[ev.name] || tr('tool.' + ev.name, {}, ev.name)) + '…');
    if (ev.type === 'round') {
      live = ''; // a new round starts (tool results are in): whatever text the model wrote before was not the answer
    }
    if (ev.type === 'delta') {
      live += ev.text;
      setBusy(L.busy.writing || L.busy.thinking);
      paintLive();
    }
    if (ev.type === 'state') {
      state = ev.state;
      renderState();
    }
  });
  const r = advise ? await window.coach.chat.advise(text) : await window.coach.chat.ask(text);
  off();
  if (liveEl) liveEl.remove();
  setBusy('');
  busy = false;
  if (!r.ok) {
    const h = explainError(r.error);
    showAnswer({ q: shown, html: h, cls: 'err' });
    wireLinks($('#answer'));
    addMsg('error', r.error);
    return;
  }
  state = r.state;
  renderState();
  const tools = (r.tools || [])
    .filter((n) => n !== 'update_match_state')
    .map((n) => L.tool[n] || n)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(', ');
  const fmtCost = (c) => (c < 0.001 ? c.toFixed(4) : c.toFixed(3)); // a sheet costs a fraction of a cent (the extraction only)
  const meta = `${tools ? tools + ' · ' : ''}${(r.ms / 1000).toFixed(1)}s${r.cost ? ` · $${fmtCost(r.cost)} (${tr('session')} $${r.totals.cost.toFixed(2)})` : ''}`;
  if (r.kind === 'sheet') {
    if (r.cost && !S.keyOk) save({ keyOk: true }); // the extraction worked: the key is good
    showSheet(shown, r, meta);
    return;
  }
  if (!S.keyOk) save({ keyOk: true });
  lastAnswerText = r.text || '';
  showAnswer({ q: shown, html: answerHtml(r.text || '…'), meta, speakText: r.text || '' });
  addMsg('assistant', r.text || '…', meta);
  if (!spokeEarly && S.voiceOut !== false && S.ttsEngine !== 'off') speak(spokenText(r.text));
}

async function speak(text) {
  if (!text) return;
  stopSpeaking();
  speaking = true;
  setBusy(L.busy.speaking);
  const r = await window.coach.tts.speak(text);
  if (!speaking) return;
  if (!r.ok) {
    toast('TTS: ' + r.error, 'warn');
    speaking = false;
    setBusy('');
    return;
  }
  if (r.fallbackReason) toast(tr('tts.fallback'), 'warn');
  if (!r.audio) {
    speaking = false;
    setBusy('');
    return;
  }
  player.src = `data:${r.mime};base64,${r.audio}`;
  player.onended = player.onerror = () => {
    speaking = false;
    setBusy('');
  };
  try {
    await player.play();
  } catch {
    speaking = false;
    setBusy('');
  }
}
function stopSpeaking() {
  speaking = false;
  try {
    player.pause();
    player.currentTime = 0;
  } catch {
    /* ignore */
  }
  try {
    window.coach.tts.stop && window.coach.tts.stop();
  } catch {
    /* desktop has no stop */
  }
  if ($('#busyText').textContent === L.busy.speaking) setBusy('');
}

/* ----------------------------------------------------------------- build orders */
async function boCommand(arg) {
  if (!arg) {
    if (bo.current) renderBo(true);
    else sysNotice(esc(L.boNone));
    return;
  }
  if (/^(off|no|quitar|none)$/i.test(arg)) {
    bo.current = null;
    bo.step = 0;
    save({ lastBuildOrder: '' });
    renderBo();
    sysNotice(`<b>${esc(L.boOffMsg)}</b>`);
    return;
  }
  if (/^\d+$/.test(arg) && bo.choices.length) {
    const c = bo.choices[Number(arg) - 1];
    if (c) {
      await selectBo(c.id);
      return;
    }
  }
  const list = await window.coach.bo.list({ civ: state.myCiv || null, query: arg, limit: 6 });
  if (!list.length) {
    sysNotice(esc(L.noBo));
    return;
  }
  if (list.length === 1 || list[0].name.toLowerCase() === arg.toLowerCase()) {
    await selectBo(list[0].id);
    return;
  }
  bo.choices = list;
  sysNotice(
    `${L.boPick}<ol>${list.map((b) => `<li>${esc(b.name)} <span class="muted">· ${esc(b.civilization.join('/'))} · ${esc(b.author || '')}</span></li>`).join('')}</ol>`
  );
}
async function selectBo(id, announce = true) {
  bo.current = await window.coach.bo.get(id);
  bo.step = 0;
  bo.choices = [];
  if (!bo.current) return;
  save({ lastBuildOrder: id });
  $('#boMeta').textContent = `${bo.current.author ? bo.current.author + ' · ' : ''}${bo.current.source || ''}`;
  renderBoCivNotes();
  if (announce)
    sysNotice(
      `<b>${esc(L.boLoaded)}:</b> ${esc(bo.current.name)} · ${esc(bo.current._civs.join('/'))}${bo.current.author ? ' · ' + esc(bo.current.author) : ''}`
    );
  renderBo(false);
}
function renderBo(announce = false) {
  const b = bo.current;
  const line = $('#boLine');
  $('#boLoaded').classList.toggle('hidden', !b);
  if (!b) {
    line.classList.add('hidden');
    line.innerHTML = '';
    $('#boPos').textContent = '—';
    $('#boAge').textContent = '';
    $('#boTime').textContent = '';
    $('#boRes').innerHTML = '';
    $('#boNotes').innerHTML = '';
    return;
  }
  const s = b.build_order[bo.step];
  const r = s.resources;
  const res = `👤${s.villager_count} 🍖${r.food} 🪵${r.wood} 🪙${r.gold} 🪨${r.stone}${r.builder ? ' 🔨' + r.builder : ''}`;
  // compact overlay: a step card you can read mid-game — position, age, time, resources, the notes big, the next step small
  const next = b.build_order[bo.step + 1];
  const mini = S.boMini === true;
  line.classList.remove('hidden');
  line.classList.toggle('mini', mini);
  line.innerHTML =
    `<div class="bl1"><button class="bnav" data-d="-1" title="${esc(tr('t.boPrev.95', {}, 'F7'))}">‹</button>` +
    `<span class="bpos"><b>${bo.step + 1}/${b.build_order.length}</b> <span class="agetag a${s.age}">${esc(L.ages[s.age] || '')}</span>${s.time ? ` <span class="bt">@${esc(s.time)}</span>` : ''}</span>` +
    `<span class="bname" title="${esc(b.name)}">${esc(b.name)}</span>` +
    `<button class="bclock" title="${esc(tr('bo.clockTitle'))}">${clock.running ? '❚❚' : '▶'} ${fmtTime(clockElapsed())}<i></i></button>` +
    `<button class="bnav" data-d="1" title="${esc(tr('t.boNext.96', {}, 'F8'))}">›</button><button class="bfold" title="${esc(tr('bo.fold', {}, ''))}">${mini ? '▸' : '▾'}</button></div>` +
    (mini
      ? `<div class="bl3 one">${esc(s.notes[0] || '')}</div>`
      : `<div class="bl2">${res}</div><div class="bl3">${s.notes.map((n) => `<div>• ${esc(n)}</div>`).join('')}</div>` +
        (next ? `<div class="bl4">▸ ${next.time ? `<b>${esc(next.time)}</b> · ` : ''}${esc((next.notes || [])[0] || '')}</div>` : ''));
  line.title = s.notes.join('\n');
  $('#boPos').textContent = `${L.step} ${bo.step + 1}/${b.build_order.length}`;
  const ag = $('#boAge');
  ag.textContent = L.ages[s.age] || '?';
  ag.className = 'agetag a' + s.age;
  $('#boTime').textContent = s.time ? '@' + s.time : '';
  const chips = [
    ['vill', '👤', s.villager_count],
    ['food', '🍖', r.food],
    ['wood', '🪵', r.wood],
    ['gold', '🪙', r.gold],
    ['stone', '🪨', r.stone],
  ];
  if (r.builder) chips.push(['builder', '🔨', r.builder]);
  $('#boRes').innerHTML = chips.map(([k, ic, v]) => `<span class="res ${k}">${ic}<b>${v}</b></span>`).join('');
  $('#boNotes').innerHTML = s.notes.map((n) => `<li>${esc(n)}</li>`).join('');
  // the whole build as a list (full window): click a row to jump there
  const list = $('#boStepsList');
  if (list) {
    list.innerHTML = b.build_order
      .map(
        (st, i) =>
          `<li class="${i === bo.step ? 'cur' : ''}" data-i="${i}"><span class="agetag a${st.age}">${esc((L.ages[st.age] || '?').slice(0, 3))}</span><span class="tm">${esc(st.time || '')}</span><span class="vc">👤${st.villager_count}</span><span class="nt">${esc((st.notes || []).join(' · '))}</span></li>`
      )
      .join('');
    const cur = list.querySelector('.cur');
    if (cur && $('#boStepsList').closest('details').open) cur.scrollIntoView({ block: 'nearest' });
  }
  if (announce && ($('#boSpeak').checked || S.boSpeak)) speak(`${L.step} ${bo.step + 1}. ${s.notes.join('. ')}`);
}
document.addEventListener('click', (e) => {
  const li = e.target.closest && e.target.closest('#boStepsList li');
  if (!li || !bo.current) return;
  bo.step = Number(li.dataset.i) || 0;
  if (clock.running) clock.manual = true;
  renderBo(true);
  renderClock();
});
function boMove(d) {
  if (!bo.current) {
    sysNotice(esc(L.boNone));
    return;
  }
  const n = bo.step + d;
  if (n < 0 || n >= bo.current.build_order.length) return;
  bo.step = n;
  if (clock.running) clock.manual = true; // the player is telling us where he really is: compare with the build's time stamps
  renderBo(true);
  renderClock();
}

/** A generic build with a civ registered: show the civ's start / eco bonuses the build does not know about (straight from the game data). */
const START_BONUS_RE =
  /start|inicio|comienz|aldean|villager|food|comida|wood|madera|sheep|oveja|farm|granja|town cent|centro urbano|boar|jabal|berr|baya|dark age|edad oscura|feudal|lumber|mill|molino|gather|recolec|eco|drop|house|casa|scout|explorador/i;
let boNotesKey = '';
async function renderBoCivNotes() {
  const el = $('#boCivNotes');
  if (!el) return;
  const b = bo.current;
  const key = b ? `${b._id || b.name}|${state.myCiv || ''}` : '';
  if (key === boNotesKey) return; // same build + same civ: nothing to recompute
  boNotesKey = key;
  el.classList.add('hidden');
  if (!b || !state.myCiv || !(b._civs || []).some((c) => /^any$/i.test(c))) return;
  try {
    const info = await window.coach.guide.tool('civ_info', { civ: state.myCiv });
    const notes = (info && info.bonuses ? info.bonuses : []).filter((x) => START_BONUS_RE.test(x)).slice(0, 4);
    if (!notes.length) return;
    el.textContent = tr('bo.civNotes', { civ: civName(state.myCiv), notes: notes.join(' · ') });
    el.classList.remove('hidden');
  } catch {
    /* no data: stay hidden */
  }
}

// the compact step card's buttons: previous / next, clock, fold
document.addEventListener('click', (e) => {
  const t = e.target.closest && e.target.closest('#boLine .bnav, #boLine .bclock, #boLine .bfold');
  if (!t) return;
  e.preventDefault();
  if (t.classList.contains('bnav')) boMove(Number(t.dataset.d));
  else if (t.classList.contains('bclock')) clockToggle();
  else {
    save({ boMini: S.boMini !== true }).then(() => renderBo(false));
  }
});

/* ----------------------------------------------------------------- build clock (steps advance by their time stamp) */
const clock = { running: false, startedAt: 0, base: 0, manual: false, timer: null };
const parseTime = (t) => {
  const m = String(t || '').match(/^(\d+):(\d{1,2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const clockElapsed = () => clock.base + (clock.running ? (Date.now() - clock.startedAt) / 1000 : 0);
function renderClock() {
  const btn = $('#boClock'),
    delta = $('#boDelta');
  if (!btn) return;
  const el = clockElapsed();
  btn.textContent = `${clock.running ? '❚❚' : '▶'} ${fmtTime(el)}`;
  btn.classList.toggle('on', clock.running);
  let txt = '';
  if (bo.current && clock.manual && (clock.running || clock.base)) {
    const target = parseTime(bo.current.build_order[bo.step].time);
    if (target != null) {
      const d = Math.round(el - target);
      txt = d > 5 ? tr('bo.late', { s: d }) : d < -5 ? tr('bo.early', { s: -d }) : '';
    }
  }
  delta.textContent = txt;
  // the compact card: same clock, plus the countdown to the next step's time stamp
  const cb = $('#boLine .bclock');
  if (cb && bo.current) {
    const next = bo.current.build_order[bo.step + 1];
    const nt = next ? parseTime(next.time) : null;
    const left = nt != null && clock.running ? Math.round(nt - el) : null;
    cb.firstChild.textContent = `${clock.running ? '❚❚' : '▶'} ${fmtTime(el)}`;
    cb.querySelector('i').textContent = txt ? ` ${txt}` : left != null && left > 0 ? ` · ${tr('bo.nextIn', { t: fmtTime(left) })}` : '';
    cb.classList.toggle('on', clock.running);
  }
}
function clockTick() {
  if (!clock.running) return;
  const el = clockElapsed();
  // auto-advance (never backwards): the step whose time stamp has just passed
  if (bo.current && S.boTimer !== false && !clock.manual) {
    let idx = bo.step;
    bo.current.build_order.forEach((st, i) => {
      const t = parseTime(st.time);
      if (t != null && t <= el && i > idx) idx = i;
    });
    if (idx !== bo.step) {
      bo.step = idx;
      renderBo(true);
    }
  }
  renderClock();
}
function clockToggle() {
  if (!bo.current) {
    sysNotice(esc(L.boNone));
    return;
  }
  if (clock.running) {
    clock.base = clockElapsed();
    clock.running = false;
    clearInterval(clock.timer);
  } else {
    clock.startedAt = Date.now();
    clock.running = true;
    clock.timer = setInterval(clockTick, 500);
  }
  renderClock();
}
function clockReset() {
  clock.base = 0;
  clock.manual = false;
  clock.startedAt = Date.now();
  if (bo.current) {
    bo.step = 0;
    renderBo(false);
  }
  renderClock();
}
async function loadBoList(keepId) {
  const list = await window.coach.bo.list({});
  const sel = $('#boSelect');
  sel.innerHTML =
    '<option value="">—</option>' +
    list.map((b) => `<option value="${esc(b.id)}">${esc(b.name)} · ${esc(b.civilization.join('/'))}${b.author ? ' · ' + esc(b.author) : ''}</option>`).join('');
  const id = keepId || (bo.current && bo.current._id) || S.lastBuildOrder;
  if (id && list.find((b) => b.id === id)) {
    sel.value = id;
    if (!bo.current) await selectBo(id, false);
  }
}

/* ----------------------------------------------------------------- mode / focus */
function setMode(compact) {
  if (compact) {
    $$('#tabs button[data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'chat'));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-chat'));
  }
  document.body.classList.toggle('full', !compact);
  document.body.classList.toggle('compact', compact);
  window.coach.window.setCompact(compact);
  if (!compact) {
    renderHistoryScroll();
  }
}
function renderHistoryScroll() {
  const b = $('#messages');
  b.scrollTop = b.scrollHeight;
}
function focusInput() {
  const i = $('#cmd');
  i.focus();
  i.select();
  document.body.classList.add('focused');
}
function release() {
  $('#cmd').blur();
  document.body.classList.remove('focused');
  window.coach.window.release();
}

/* ----------------------------------------------------------------- providers (presets + info) */
const PRESETS = {
  claude: { kind: 'anthropic', name: 'Claude (Anthropic)', keyUrl: 'https://console.anthropic.com/settings/keys', info: 'prov.claude' },
  openai: { kind: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', model: '', keyUrl: 'https://platform.openai.com/api-keys', info: 'prov.openai' },
  gemini: {
    kind: 'openai',
    name: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    info: 'prov.gemini',
  },
  groq: {
    kind: 'openai',
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys',
    info: 'prov.groq',
  },
  openrouter: {
    kind: 'openai',
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1',
    model: 'nvidia/nemotron-3-super-120b-a12b:free',
    keyUrl: 'https://openrouter.ai/keys',
    info: 'prov.openrouter',
  },
  nvidia: {
    kind: 'openai',
    name: 'NVIDIA NIM',
    url: 'https://integrate.api.nvidia.com/v1',
    model: 'openai/gpt-oss-20b',
    keyUrl: 'https://build.nvidia.com/',
    info: 'prov.nvidia',
  },
  ollama: {
    kind: 'openai',
    name: 'Local (Ollama / LM Studio / llama.cpp)',
    url: 'http://localhost:11434/v1',
    model: 'qwen2.5:14b',
    keyUrl: '',
    info: 'prov.ollama',
  },
  custom: { kind: 'openai', name: 'Other OpenAI-compatible', url: '', model: '', keyUrl: '', info: 'prov.custom' },
};
function presetOf(S) {
  return S.providerPreset && PRESETS[S.providerPreset] ? S.providerPreset : S.provider === 'openai' ? 'custom' : 'claude';
}
function renderProvInfo() {
  const id = $('#setProvider').value,
    P = PRESETS[id];
  $('#provInfo').innerHTML =
    `<div><b>${P.name}</b></div><div>${tr(P.info)}</div>` +
    (P.keyUrl ? `<div><a data-url="${P.keyUrl}">${tr('prov.getKey')} → ${P.keyUrl.replace(/^https?:\/\//, '')}</a></div>` : '') +
    (id !== 'claude' ? `<div class="muted small">${tr('prov.note')}</div>` : '');
  $$('#provInfo a[data-url]').forEach((a) => a.addEventListener('click', () => window.coach.app.openExternal(a.dataset.url)));
  $('#provAnthropic').classList.toggle('hidden', P.kind !== 'anthropic');
  $('#provOpenai').classList.toggle('hidden', P.kind !== 'openai');
}

/* ----------------------------------------------------------------- settings */
async function loadSettings() {
  S = await window.coach.settings.get();
  L = langTable(S.uiLanguage || 'es');
  applyI18n();
  applyTheme(S.theme);
  $('#setProvider').value = presetOf(S);
  onProviderChange();
  const masked = S.experimentalPrivacy === true;
  if (masked) {
    $('#setAnthropicKey').value = '';
    $('#setAnthropicKey').placeholder = S.anthropicApiKeySet ? tr('key.saved', { k: S.anthropicApiKey }) : 'sk-ant-…';
  } else {
    $('#setAnthropicKey').value = S.anthropicApiKey || '';
    $('#setAnthropicKey').placeholder = 'sk-ant-…';
  }
  const ms = $('#setAnthropicModel');
  if (![...ms.options].some((o) => o.value === S.anthropicModel)) ms.add(new Option(S.anthropicModel, S.anthropicModel));
  ms.value = S.anthropicModel;
  $('#setOpenaiUrl').value = S.openaiBaseUrl || '';
  $('#setOpenaiModel').value = S.openaiModel || '';
  if (masked) {
    $('#setOpenaiKey').value = '';
    $('#setOpenaiKey').placeholder = S.openaiApiKeySet ? tr('key.saved', { k: S.openaiApiKey }) : tr('key.optional');
  } else {
    $('#setOpenaiKey').value = S.openaiApiKey || '';
    $('#setOpenaiKey').placeholder = '';
  }
  urlWarn();
  $('#setLanguage').value = S.language || 'auto';
  $('#setTtsEngine').value = S.ttsEngine || 'edge';
  $('#setTtsRate').value = S.ttsRate || 1.15;
  $('#ttsRateVal').textContent = (S.ttsRate || 1.15) + 'x';
  $('#hkAsk').value = S.hotkeys.ask || '';
  $('#hkToggle').value = S.hotkeys.toggle || '';
  $('#hkPrev').value = S.hotkeys.boPrev || '';
  $('#hkNext').value = S.hotkeys.boNext || '';
  renderHkWarn();
  $('#setFocusReturn').value = S.focusReturn || 'blur';
  $('#setOpacity').value = S.opacity || 0.94;
  $('#opacityVal').textContent = Math.round((S.opacity || 0.94) * 100) + '%';
  $('#setOnTop').checked = S.alwaysOnTop !== false;
  $('#setUiLang').value = S.uiLanguage || 'es';
  $('#boSpeak').checked = !!S.boSpeak;
  $('#btnVoice').classList.toggle('on', S.voiceOut !== false);
  $('#setExpPrivacy').checked = S.experimentalPrivacy === true;
  $('#setExpCache').checked = S.experimentalCache !== false;
  $('#setStreaming').checked = S.streaming !== false;
  renderAnswerMode();
  if ($('#setScreenRead')) {
    $('#setScreenRead').checked = S.screenRead === true;
    $('#setScreenInterval').value = String(Number(S.screenReadInterval) || 15);
    renderOcrEngine();
  }
  $('#expPrivacyBox').classList.toggle('hidden', S.experimentalPrivacy !== true);
  $('#setMatchDetect').checked = S.matchDetect === true;
  $('#setPatchWatch').checked = S.patchWatch !== false;
  $('#setLogDays').value = String(Number(S.logRetentionDays) || 0);
  $('#profileCur').textContent = S.profileId ? tr('profile.cur', { name: S.profileName || '', id: S.profileId }) : tr('profile.none');
  keyBanner();
  document.body.classList.toggle('full', S.compact === false);
  document.body.classList.toggle('compact', S.compact !== false);
}
async function save(patch) {
  S = await window.coach.settings.set(patch);
  return S;
}
function renderOcrEngine() {
  const eng = S.ocrEngine === 'ai' ? 'ai' : 'local';
  $$('#setOcrEngine button').forEach((b) => b.classList.toggle('on', b.dataset.v === eng));
}
let showAiAnyway = false;
function renderAnswerMode() {
  const mode = answerMode();
  $$('#setAnswerMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
  const info = $('#modeInfo');
  if (info) {
    info.innerHTML = tr('mode.' + mode + '.info') + (mode !== 'local' && !hasKey() ? `<br><b>${esc(tr('mode.needsKey'))}</b>` : '');
    wireLinks(info);
  }
  const local = mode === 'local';
  if ($('#aiBox')) $('#aiBox').classList.toggle('hidden', local && !showAiAnyway);
  if ($('#aiLocalRow')) $('#aiLocalRow').classList.toggle('hidden', !local || showAiAnyway);
  $$('#wModes .modecard').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  keyBanner();
}
function onProviderChange() {
  renderProvInfo();
}
function bindSettings() {
  const bind = (sel, key, map = (v) => v, evt = 'change') =>
    $(sel).addEventListener(evt, async (e) => {
      await save({ [key]: map(e.target.value) });
      keyBanner();
    });
  $('#setProvider').addEventListener('change', async (e) => {
    const id = e.target.value,
      P = PRESETS[id],
      patch = { provider: P.kind, providerPreset: id };
    if (P.kind === 'openai') {
      patch.openaiBaseUrl = P.url;
      patch.openaiModel = P.model;
      if (presetOf(S) !== id) patch.openaiApiKey = '';
      $('#setOpenaiUrl').value = P.url;
      $('#setOpenaiModel').value = P.model;
      if ('openaiApiKey' in patch) $('#setOpenaiKey').value = '';
    }
    await save(patch);
    onProviderChange();
    keyBanner();
  });
  const keyInput = (sel, key) => {
    // plain mode: save once typing pauses (not on every keystroke → one encrypted write, not thirty); change/blur flushes at once
    let timer = null;
    const flush = async (v) => {
      clearTimeout(timer);
      timer = null;
      await save({ [key]: v.trim() });
      keyBanner();
    };
    $(sel).addEventListener('input', (e) => {
      if (S.experimentalPrivacy === true) return;
      clearTimeout(timer);
      timer = setTimeout(() => flush(e.target.value), 600);
    });
    $(sel).addEventListener('change', async (e) => {
      if (S.experimentalPrivacy !== true) {
        if (timer) await flush(e.target.value);
        return;
      }
      const v = e.target.value.trim();
      if (!v) return;
      await save({ [key]: v });
      e.target.value = '';
      loadSettings();
    });
  };
  keyInput('#setAnthropicKey', 'anthropicApiKey');
  bind('#setAnthropicModel', 'anthropicModel');
  bind('#setOpenaiUrl', 'openaiBaseUrl', (v) => v.trim());
  $('#setOpenaiUrl').addEventListener('input', urlWarn);
  bind('#setOpenaiModel', 'openaiModel', (v) => v.trim());
  keyInput('#setOpenaiKey', 'openaiApiKey');
  bind('#setLanguage', 'language');
  $$('#setTheme button').forEach((b) =>
    b.addEventListener('click', async () => {
      await save({ theme: b.dataset.v });
      applyTheme(S.theme);
    })
  );
  $$('#setAnswerMode button').forEach((b) =>
    b.addEventListener('click', async () => {
      await save({ answerMode: b.dataset.v, modeChosen: true });
      renderAnswerMode();
    })
  );
  if ($('#btnShowAi'))
    $('#btnShowAi').addEventListener('click', () => {
      showAiAnyway = true;
      renderAnswerMode();
    });
  bind('#setTtsEngine', 'ttsEngine');
  bind('#setTtsVoice', 'ttsVoice');
  bind('#setFocusReturn', 'focusReturn');
  $('#setTtsRate').addEventListener('input', (e) => {
    $('#ttsRateVal').textContent = e.target.value + 'x';
  });
  bind('#setTtsRate', 'ttsRate', Number);
  $('#setOpacity').addEventListener('input', (e) => {
    $('#opacityVal').textContent = Math.round(e.target.value * 100) + '%';
  });
  bind('#setOpacity', 'opacity', Number);
  $('#setOnTop').addEventListener('change', (e) => save({ alwaysOnTop: e.target.checked }));
  $('#boSpeak').addEventListener('change', (e) => save({ boSpeak: e.target.checked }));
  $('#setUiLang').addEventListener('change', async (e) => {
    const lang = e.target.value;
    const patch = { uiLanguage: lang };
    if (
      !S.voiceChosen ||
      !String(S.ttsVoice || '')
        .toLowerCase()
        .startsWith(lang === 'zh' ? 'zh' : lang)
    )
      patch.ttsVoice = DEFAULT_VOICE[lang] || 'es-AR-ElenaNeural';
    await save(patch);
    L = langTable(lang);
    applyI18n();
    try {
      await loadVoices();
    } catch {
      /* */
    }
    renderState();
    renderBo();
    refreshData();
  });
  const hk = async () => {
    await save({
      hotkeys: { ask: $('#hkAsk').value.trim(), toggle: $('#hkToggle').value.trim(), boPrev: $('#hkPrev').value.trim(), boNext: $('#hkNext').value.trim() },
    });
    renderHkWarn();
  };
  ['#hkAsk', '#hkToggle', '#hkPrev', '#hkNext'].forEach((s) => $(s).addEventListener('change', hk));
  $('#toggleKey').addEventListener('click', () => {
    const i = $('#setAnthropicKey');
    i.type = i.type === 'password' ? 'text' : 'password';
  });
  $('#btnTestBrain').addEventListener('click', async () => {
    const m = $('#testBrainMsg');
    m.textContent = '…';
    const r = await window.coach.chat.advise('Reply with exactly: OK');
    if (r.ok) {
      m.textContent = `${L.testOk} (${r.model}, ${r.ms} ms${r.cost ? ', $' + r.cost.toFixed(4) : ''})`;
      save({ keyOk: true });
    } else {
      m.innerHTML = explainError(r.error);
      wireLinks(m);
    }
    await window.coach.chat.reset();
  });
  $('#btnTestTts').addEventListener('click', () => speak(tr('tts.test')));
  $('#btnSync').addEventListener('click', async () => {
    $('#btnSync').disabled = true;
    await window.coach.data.sync();
    $('#btnSync').disabled = false;
    refreshData();
    loadBoList();
  });
  $('#btnOpenDir').addEventListener('click', () => window.coach.app.openUserDir());
  if ($('#btnUninstall')) $('#btnUninstall').addEventListener('click', () => window.coach.app.uninstall && window.coach.app.uninstall());
  $('#btnOpenLogs').addEventListener('click', () => window.coach.app.openLogs());
  $('#btnQuit').addEventListener('click', () => window.coach.window.quit());
  window.coach.data.onStatus(() => refreshData());
}
async function refreshData() {
  const i = await window.coach.data.info();
  const kp = $('#keyPlainWarn');
  if (kp) kp.classList.toggle('hidden', i.secureStorage !== false);
  $('#dataInfo').textContent = tr('dataset', {
    civs: i.civs,
    units: i.units,
    civProfiles: i.civProfiles || 0,
    mapProfiles: i.mapProfiles || 0,
    buildOrders: i.buildOrders,
    notes: i.notes,
    source: (i.source || '?').slice(0, 24),
    lastSync: i.lastSync ? new Date(i.lastSync).toLocaleString() : '—',
    message: i.message || '',
    version: i.version,
  });
}
async function loadVoices() {
  const vs = await window.coach.tts.voices();
  const sel = $('#setTtsVoice');
  sel.innerHTML = vs.map((v) => `<option value="${v.id}">${esc(v.label)}</option>`).join('');
  sel.value = S.ttsVoice || vs[0].id;
}

/** Warn when an API key would travel in clear text to a public host (main blocks it anyway). */
function urlWarn() {
  const v = ($('#setOpenaiUrl').value || '').trim();
  let msg = '';
  try {
    const u = new URL(v);
    const priv =
      /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(u.hostname) ||
      /\.(local|lan|internal|ts\.net)$/.test(u.hostname);
    if (u.protocol === 'http:' && !priv) msg = S.experimentalPrivacy === true ? tr('url.httpBlocked') : tr('url.http');
    else if (u.protocol === 'http:') msg = tr('url.local');
  } catch {
    if (v) msg = tr('url.bad');
  }
  $('#urlWarn').textContent = msg;
  $('#urlWarn').classList.toggle('hidden', !msg);
}
/** AoE2 DE binds these keys by default; a global hotkey on one of them takes it away from the game. */
const GAME_KEYS = { F3: 'hk.use.pause', F10: 'hk.use.menu', F11: 'hk.use.stats', F12: 'hk.use.shot' };
function renderHkWarn() {
  const el = $('#hkWarn');
  if (!el) return;
  const msgs = [];
  for (const k of Object.values(S.hotkeys || {})) {
    const key = String(k || '').trim();
    if (GAME_KEYS[key]) msgs.push(tr('hk.conflict', { key, use: tr(GAME_KEYS[key]), alt: 'Ctrl+' + key }));
  }
  el.textContent = msgs.join(' ');
  el.classList.toggle('hidden', !msgs.length);
}
/* ----------------------------------------------------------------- live HUD (screen reader, desktop opt-in) */
let hud = null;
function hudText(r) {
  const n = (v) => (v == null ? '?' : v);
  const parts = [`🍖${n(r.food)}`, `🪵${n(r.wood)}`, `🪙${n(r.gold)}`, `🪨${n(r.stone)}`];
  if (r.pop) parts.push(`👤${r.pop}`);
  if (r.idle) parts.push(tr('hud.idle', { n: r.idle }));
  if (r.age) parts.push(L.ages[r.age] || '');
  if (r.time) parts.push('⏱' + r.time);
  return parts.filter(Boolean).join(' · ');
}
function renderHud() {
  const el = $('#hudLine');
  if (!el) return;
  if (!hud || Date.now() - hud.at > 120000) {
    el.classList.add('hidden');
    return;
  }
  const n = (v) => (v == null ? '?' : v);
  const parts = ['food', 'wood', 'gold', 'stone'].map(
    (k) =>
      `<span>${RES_ICON[k]}<b>${n(hud[k])}</b>${hud.villagers && hud.villagers[k] != null ? `<small class="muted">·${hud.villagers[k]}</small>` : ''}</span>`
  );
  if (hud.pop) parts.push(`<span>👤<b>${esc(hud.pop)}</b>${hud.villagersTotal != null ? `<small class="muted">·${hud.villagersTotal}</small>` : ''}</span>`);
  if (hud.idle) parts.push(`<span class="idle">${esc(tr('hud.idle', { n: hud.idle }))}</span>`);
  // the loaded build's current step: villagers per resource still missing (rtsbuilds "resources" = villagers on each resource)
  if (bo.current && hud.villagers) {
    const r = bo.current.build_order[bo.step].resources || {};
    const need = ['food', 'wood', 'gold', 'stone']
      .filter((k) => Number(r[k]) > 0 && hud.villagers[k] != null && Number(r[k]) > hud.villagers[k])
      .map((k) => `+${Number(r[k]) - hud.villagers[k]}${RES_ICON[k]}`);
    parts.push(`<span class="need">${esc(need.length ? tr('hud.needs', { list: need.join(' ') }) : tr('hud.onTrack'))}</span>`);
  }
  if (hud.age) parts.push(`<span>${esc(L.ages[hud.age] || '')}</span>`);
  if (hud.time) parts.push(`<span>⏱<b>${esc(hud.time)}</b></span>`);
  el.innerHTML = parts.join('');
  el.title = tr('hud.title', { s: Math.round((Date.now() - hud.at) / 1000) });
  el.classList.remove('hidden');
}
/** The game clock read from the HUD drives the build clock: start it (or re-sync it) at that time. */
function syncClockTo(timeStr, at) {
  const sec = parseTime(timeStr);
  if (sec == null || !bo.current) return;
  const now = sec + (Date.now() - at) / 1000;
  const drift = Math.abs(clockElapsed() - now);
  if (clock.running && drift < 4) return;
  clock.base = now;
  clock.startedAt = Date.now();
  if (!clock.running) {
    clock.running = true;
    clock.timer = setInterval(clockTick, 500);
  }
  renderClock();
}
setInterval(renderHud, 15000);

function bindExtras() {
  $('#setMatchDetect').addEventListener('change', (e) => save({ matchDetect: e.target.checked }));
  if ($('#setScreenRead')) {
    $('#setScreenRead').addEventListener('change', async (e) => {
      await save({ screenRead: e.target.checked });
      if (e.target.checked && S.ocrEngine === 'ai' && !hasKey()) toast(tr('screen.noKey'), 'warn');
      else toast(e.target.checked ? tr('screen.on', { n: Number(S.screenReadInterval) || 15 }) : tr('screen.off'));
    });
    $('#setScreenInterval').addEventListener('change', (e) => save({ screenReadInterval: Number(e.target.value) || 15 }));
    $$('#setOcrEngine button').forEach((b) =>
      b.addEventListener('click', async () => {
        await save({ ocrEngine: b.dataset.v });
        renderOcrEngine();
        if (b.dataset.v === 'ai' && !hasKey()) toast(tr('screen.noKey'), 'warn');
      })
    );
    const screenButtons = (on) => ['#btnScreenTest', '#btnScreenCalibrate', '#btnScreenManual'].forEach((sel) => ($(sel).disabled = !on));
    /** Show the crop the reader used and, when the local engine reports them, the words it found (boxes + text). */
    const showCrop = (r) => {
      const prev = $('#screenPreview');
      if (!r || !r.crop) return;
      prev.classList.remove('pick');
      prev.innerHTML = `<img src="data:image/jpeg;base64,${r.crop}" alt="">`;
      prev.classList.remove('hidden');
      const words = r.debug && r.debug.words;
      if (words && r.cropSize && r.cropSize.width) {
        const img = prev.querySelector('img');
        const place = () => {
          const k = img.clientWidth / r.cropSize.width;
          prev.querySelectorAll('.obox').forEach((x) => x.remove());
          for (const w of words) {
            const b = document.createElement('div');
            b.className = 'obox';
            b.style.cssText = `left:${w.x0 * k}px;top:${w.y0 * k}px;width:${(w.x1 - w.x0) * k}px;height:${(w.y1 - w.y0) * k}px`;
            b.innerHTML = `<span>${esc(w.text || '?')}</span>`;
            prev.appendChild(b);
          }
        };
        if (img.complete) place();
        else img.onload = place;
      }
    };
    const screenRun = async (fn) => {
      const out = $('#screenTestOut');
      out.textContent = tr('screen.reading');
      $('#screenPreview').classList.add('hidden');
      screenButtons(false);
      const r = await fn();
      screenButtons(true);
      showCrop(r);
      const eng =
        r && r.engine
          ? ` · ${tr('screen.engineUsed', { e: r.engine === 'ai' ? tr('ocr.ai') : tr('ocr.local'), ms: r.debug && r.debug.ms != null ? r.debug.ms : '?' })}`
          : '';
      if (!r || !r.ok) {
        out.textContent = '✗ ' + (r && (r.notHud || r.notFound) ? (r.region ? tr('screen.savedNoRead') : tr('screen.notHud')) : (r && r.error) || '?') + eng;
        return;
      }
      const line = hudText(r.reading);
      out.textContent = (r.region ? tr('screen.calibrated', { w: r.rect.width, h: r.rect.height, line }) : '✓ ' + line) + eng;
    };
    $('#btnScreenTest').addEventListener('click', () => screenRun(() => window.coach.screen.test()));
    $('#btnScreenCalibrate').addEventListener('click', () => screenRun(() => window.coach.screen.calibrate()));
    // manual calibration: a screenshot, two clicks (top-left, bottom-right of the bar) → region in screen fractions
    $('#btnScreenManual').addEventListener('click', async () => {
      const out = $('#screenTestOut'),
        prev = $('#screenPreview');
      out.textContent = tr('screen.reading');
      screenButtons(false);
      const snap = await window.coach.screen.snapshot();
      screenButtons(true);
      if (!snap || !snap.ok) {
        out.textContent = '✗ ' + ((snap && snap.error) || '?');
        return;
      }
      prev.innerHTML = `<img src="data:image/jpeg;base64,${snap.jpeg}" alt="">`;
      prev.classList.remove('hidden');
      prev.classList.add('pick');
      out.textContent = tr('screen.manualHint');
      const img = prev.querySelector('img');
      let first = null;
      const onClick = async (e) => {
        const rect = img.getBoundingClientRect();
        const fx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
          fy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        if (!first) {
          first = { fx, fy };
          out.textContent = tr('screen.manualNext');
          return;
        }
        img.removeEventListener('click', onClick);
        prev.classList.remove('pick');
        const box = { x: Math.min(first.fx, fx), y: Math.min(first.fy, fy), w: Math.abs(fx - first.fx), h: Math.abs(fy - first.fy) };
        const rb = document.createElement('div');
        rb.className = 'rbox';
        rb.style.cssText = `left:${box.x * rect.width}px;top:${box.y * rect.height}px;width:${box.w * rect.width}px;height:${box.h * rect.height}px`;
        prev.appendChild(rb);
        await screenRun(() => window.coach.screen.calibrateManual(box));
      };
      img.addEventListener('click', onClick);
    });
    if (window.coach.screen && window.coach.screen.onReading)
      window.coach.screen.onReading((ev) => {
        hud = ev.reading;
        if (ev.state) {
          state = ev.state;
          renderState();
        }
        renderHud();
        if (hud && hud.time && S.boTimer !== false) syncClockTo(hud.time, hud.at);
      });
  }
  $('#setExpPrivacy').addEventListener('change', async (e) => {
    await save({ experimentalPrivacy: e.target.checked });
    loadSettings();
  });
  $('#setExpCache').addEventListener('change', (e) => save({ experimentalCache: e.target.checked }));
  $('#setStreaming').addEventListener('change', (e) => save({ streaming: e.target.checked }));
  $('#setPatchWatch').addEventListener('change', (e) => save({ patchWatch: e.target.checked }));
  $('#setLogDays').addEventListener('change', (e) => save({ logRetentionDays: Number(e.target.value) }));
  $('#btnClearLogs').addEventListener('click', async () => {
    await window.coach.logs.clear();
    toast(tr('logs.cleared'));
  });
  $('#profileSearch').addEventListener('click', async () => {
    const out = $('#profileResults');
    out.textContent = tr('profile.searching');
    const r = await window.coach.match.searchProfile($('#profileQuery').value);
    if (!r.ok) {
      out.textContent = '✗ ' + r.error;
      return;
    }
    if (!r.profiles.length) {
      out.textContent = tr('profile.noResults');
      return;
    }
    out.innerHTML = r.profiles
      .map(
        (p) =>
          `<div class="item"><button class="ghost small" data-id="${esc(p.profileId)}" data-n="${esc(p.name)}">${esc(tr('profile.me'))}</button> ${esc(p.name)} <span class="muted">· ${esc(p.country.toUpperCase())} · ${p.games} ${esc(tr('profile.games'))}${p.verified ? ' · ' + esc(tr('profile.verified')) : ''}</span></div>`
      )
      .join('');
    $$('#profileResults button').forEach((b) =>
      b.addEventListener('click', async () => {
        await save({ profileId: b.dataset.id, profileName: b.dataset.n, matchDetect: true });
        out.textContent = '';
        loadSettings();
        toast(tr('profile.chosen', { name: b.dataset.n }));
      })
    );
  });
  $('#btnMatchNow').addEventListener('click', () => matchNow());
  $('#btnPatchCheck').addEventListener('click', async () => {
    $('#patchInfo').textContent = tr('profile.searching');
    await window.coach.patch.check();
    renderPatch();
  });
  window.coach.patch.onStatus(() => renderPatch());
  window.coach.match.onDetected(async (ev) => {
    state = ev.state;
    renderState();
    sysNotice(`<b>${tr('match.detected')}:</b> ${esc(ev.text)}${ev.filled.length ? '' : ` <span class="muted">${tr('match.kept')}</span>`}`);
    if (ev.filled.length && sheetMode()) {
      const r = await window.coach.chat.sheet('');
      if (r.ok) showSheet(tr('sheet.title'), r);
    }
  });
}
async function renderPatch() {
  const p = await window.coach.patch.status();
  const newer = p.latest && p.reviewed && Number(p.latest) > Number(p.reviewed);
  $('#patchInfo').textContent = newer
    ? tr('patch.newer', { latest: p.latest, reviewed: p.reviewed })
    : tr('patch.ok', { reviewed: p.reviewed || '?' }) +
      (p.lastCheck ? ' · ' + tr('patch.last') + ' ' + new Date(p.lastCheck).toLocaleString() : '') +
      (p.error ? ' · ' + tr('patch.offline') : '');
  $('#patchBadge').classList.toggle('hidden', !newer);
  $('#patchBadge').title = newer ? tr('patch.badge', { latest: p.latest }) : '';
}
async function matchNow(apply = false) {
  if (apply) {
    const r = await window.coach.match.apply(true);
    if (r.ok) {
      state = r.state;
      renderState();
      sysNotice(`<b>${tr('match.using')}</b>`);
    } else toast(r.error, 'warn');
    return;
  }
  const r = await window.coach.match.now();
  if (!r.ok) {
    sysNotice(esc(r.error));
    return;
  }
  sysNotice(
    `<b>${r.match.live ? tr('match.live') : tr('match.last')}:</b> ${esc(r.text)}<br><span class="muted">${r.match.live ? tr('match.filled') + ' ' : ''}${tr('match.useHint')}</span>`
  );
  if (r.match.live) {
    const a = await window.coach.match.apply(false);
    if (a.ok) {
      state = a.state;
      renderState();
    }
  }
}

/* ----------------------------------------------------------------- friendly errors */
let lastAnswerText = '';
function explainError(msg) {
  const m = String(msg || '');
  const keyLink = '<a data-url="https://console.anthropic.com/settings/keys">console.anthropic.com → API Keys</a>';
  const billLink = '<a data-url="https://console.anthropic.com/settings/billing">console.anthropic.com → Billing</a>';
  const steps = (k, vars = {}) => {
    const e = L.err[k] || I18N.en.err[k];
    return `<b>${fill(e.t, vars)}</b><ol class="small">${e.s.map((i) => `<li>${fill(i, vars)}</li>`).join('')}</ol>`;
  };
  const v = { keyLink, billLink, msg: esc(m) };
  if (/No Claude API key|Falta la API key|api key set/i.test(m)) return steps('missing', v);
  if (/401|invalid x-api-key|authentication|unauthori[sz]ed|invalid api key|incorrect api key/i.test(m)) return steps('invalid', v);
  if (/credit balance|billing|insufficient|quota|payment/i.test(m)) return steps('billing', v);
  if (/403|permission|forbidden/i.test(m)) return steps('perm', v);
  if (/429|rate.?limit|too many requests/i.test(m)) return steps('rate', v);
  if (/529|overloaded|503|502|500/i.test(m)) return steps('down', v);
  if (/404|not[_ ]found|model/i.test(m) && /model/i.test(m)) return steps('model', v);
  if (/fetch failed|ENOTFOUND|ECONN|network|timeout|timed out|abort|Failed to fetch|NetworkError/i.test(m)) return steps('net', v);
  if (/http:\/\//i.test(m)) return steps('http', v);
  return `<b>${tr('err.generic')}</b> <span class="small">${esc(m)}</span><br><span class="small muted">${tr('err.genericHint')}</span>`;
}
function wireLinks(root) {
  (root || document).querySelectorAll('a[data-url]').forEach((a) => {
    if (a._w) return;
    a._w = 1;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.coach.app.openExternal(a.dataset.url);
    });
  });
}

/* ----------------------------------------------------------------- welcome popup (API key) */
function hasKey() {
  return S.provider === 'openai' ? !!S.openaiBaseUrl : !!S.anthropicApiKey;
}
function maybeWelcome() {
  if (S.welcomeHide || S.modeChosen || (hasKey() && S.keyOk)) return;
  $('#welcome').classList.remove('hidden');
  setMode(false);
  showTab('settings');
  renderAnswerMode();
  wireLinks($('#welcome'));
}
/** A mode card in the welcome: local closes the popup; the AI modes reveal the key field (unless a key already works). */
async function welcomePick(mode) {
  await save({ answerMode: mode, modeChosen: true });
  renderAnswerMode();
  if (mode === 'local' || (hasKey() && S.keyOk)) {
    closeWelcome();
    return;
  }
  $('#wKeyBox').classList.remove('hidden');
  setTimeout(() => $('#wKey').focus(), 50);
}
function closeWelcome() {
  $('#welcome').classList.add('hidden');
  if ($('#wNoMore').checked) save({ welcomeHide: true });
  landAfterWelcome();
}
async function welcomeTest() {
  const v = $('#wKey').value.trim(),
    msg = $('#wMsg');
  if (!/^sk-ant-/.test(v)) {
    msg.innerHTML = `<span class="warn">${tr('w.notKey')}</span>`;
    return;
  }
  msg.textContent = tr('w.testing');
  await save({ provider: 'anthropic', providerPreset: 'claude', anthropicApiKey: v });
  const r = await window.coach.chat.advise('Reply with exactly: OK');
  await window.coach.chat.reset();
  if (r.ok) {
    await save({ keyOk: true, modeChosen: true });
    msg.innerHTML = `<span class="ok">${tr('w.ok')}</span>`;
    loadSettings();
    setTimeout(() => {
      closeWelcome();
    }, 1200);
  } else {
    msg.innerHTML = explainError(r.error);
    wireLinks(msg);
  }
}

/* ----------------------------------------------------------------- tabs */
function showTab(name) {
  $$('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name || (name === 'guide' && x.id === 'btnGuide')));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  if (name === 'bo') renderCatalog();
  if (name === 'guide') loadGuideFrame();
  // the counters table matters most while chatting; fold it elsewhere to leave room (click its title to unfold)
  if (tcUserToggled == null) $('#tcPanel').classList.toggle('collapsed', name !== 'chat');
}
let tcUserToggled = null;
document.addEventListener('click', (e) => {
  const h = e.target.closest && e.target.closest('#tcPanel .tch');
  if (!h) return;
  const p = $('#tcPanel');
  p.classList.toggle('collapsed');
  tcUserToggled = p.classList.contains('collapsed');
});
/** Web only: the guide lives in an iframe inside the Guide tab (desktop opens it as its own window). */
function loadGuideFrame(arg) {
  const f = $('#guideFrame');
  if (!f) return;
  const q = new URLSearchParams();
  if (arg && arg.civ) q.set('civ', arg.civ);
  if (arg && arg.tab) q.set('tab', arg.tab);
  if (arg && arg.map) q.set('map', arg.map);
  if (f.dataset.loaded) {
    try {
      f.contentWindow.postMessage({ type: 'sp:goto', arg: arg || {}, state }, location.origin === 'null' ? '*' : location.origin);
    } catch {
      /* */
    }
    return;
  }
  f.src = 'guide.html' + (q.toString() ? '?' + q : '');
  f.dataset.loaded = '1';
}
function openGuide(arg) {
  if (window.coach.web) {
    setMode(false);
    showTab('guide');
    loadGuideFrame(arg);
  } else window.coach.guide.open(arg || {});
}
function landAfterWelcome() {
  openGuide({});
}

/* ----------------------------------------------------------------- build-order catalog (list, not a drop-down) */
let CAT = null,
  boType = '';
let RECO = { key: '', data: null };
/** The sheet's build recommender for the registered match (local, no model); cached per civ / map / age. */
async function recommendedBuilds() {
  const key = `${state.myCiv || ''}|${state.map || ''}|${state.age || 0}`;
  if (RECO.key === key) return RECO.data;
  try {
    const r = await window.coach.chat.sheet('');
    RECO = { key, data: r && r.ok && r.sheet ? r.sheet.builds : null };
  } catch {
    RECO = { key, data: null };
  }
  return RECO.data;
}
const TIER_LABEL = { meta: 'META', 'anti-meta': 'ANTI-META', meme: 'MEME' };
async function renderCatalog(force = false) {
  if (!CAT || force) CAT = await window.coach.bo.catalog();
  if (!$('#boTypes').children.length) {
    $('#boTypes').innerHTML = ['', ...CAT.types]
      .map((t) => `<button class="chip ${boType === t ? 'on' : ''}" data-t="${esc(t)}">${esc(t ? tr('type.' + t, {}, t) : tr('bo.allTypes'))}</button>`)
      .join('');
    $$('#boTypes .chip').forEach((b) =>
      b.addEventListener('click', () => {
        boType = b.dataset.t;
        $$('#boTypes .chip').forEach((x) => x.classList.toggle('on', x === b));
        renderCatalog();
      })
    );
    const civSel = $('#boCiv');
    (await window.coach.civs()).forEach((c) => civSel.add(new Option(c.name_es, c.key)));
  }
  const q = norm($('#boSearch').value),
    src = $('#boSrc').value,
    tier = $('#boTier').value;
  let civ = $('#boCiv').value;
  if (civ === '__mine') civ = state.myCiv || '';
  const civNames = civ ? (await window.coach.civs()).filter((c) => c.key === civ).flatMap((c) => [c.name_en, c.name_es]) : [];
  const match = (e) =>
    (!src || e.kind === src) &&
    (!tier || e.tier === tier) &&
    (!boType || e.types.includes(boType)) &&
    (!civ || e.civs.includes('Any') || e.civs.some((c) => civNames.some((n) => norm(n) === norm(c)))) &&
    (!q || norm([e.title, e.author, e.civs.join(' '), e.types.join(' '), e.date].join(' ')).includes(q));
  // relevance: my civ's builds first, then generic ones, then the rest; meta before anti-meta before meme; a title hit before a tag hit
  const myNames = state.myCiv
    ? civs
        .filter((c) => c.key === state.myCiv)
        .flatMap((c) => [c.name_en, c.name_es, c.key])
        .map(norm)
    : [];
  const tierRank = (e) => (e.tier === 'meta' ? 0 : e.tier === 'anti-meta' ? 1 : 2);
  const civRank = (e) => (myNames.length && e.civs.some((c) => myNames.includes(norm(c))) ? 0 : e.civs.includes('Any') || !e.civs.length ? 1 : 2);
  const hitRank = (e) => (q && norm(e.title).includes(q) ? 0 : 1);
  const steps = CAT.steps
      .filter(match)
      .sort((a, b) => hitRank(a) - hitRank(b) || civRank(a) - civRank(b) || tierRank(a) - tierRank(b) || a.title.localeCompare(b.title)),
    notes = CAT.notes
      .filter(match)
      .sort((a, b) => hitRank(a) - hitRank(b) || civRank(a) - civRank(b) || tierRank(a) - tierRank(b) || String(b.date).localeCompare(String(a.date)));
  // "Para tu partida": what the sheet's recommender picks for the registered civ / map (only on the unfiltered list)
  let reco = null;
  if (!q && !src && !tier && !boType && !civ && (state.myCiv || state.map)) reco = await recommendedBuilds();
  $('#boCount').textContent = tr('bo.count', { s: steps.length, n: notes.length, t: CAT.counts.steps + CAT.counts.notes });
  const civKeyOf = (n) => {
    const c = civs.find((x) => x.name_en === n || x.name_es === n || x.key === n);
    return c ? c.key : '';
  };
  const card = (e) =>
    `<div class="bocard ${e.kind} tier-${e.tier}" data-id="${esc(e.id)}"><div class="t"><span class="kind" title="${esc(e.kind === 'steps' ? tr('bo.stepTag') : tr('bo.grpNotesShort'))}">${e.kind === 'steps' ? '≡' : '▶'}</span>${e.civs
      .filter((c) => c !== 'Any')
      .slice(0, 3)
      .map((c) => civIcon(civKeyOf(c), 'cico sm'))
      .join(
        ''
      )}${esc(e.title)}</div><div class="s">${e.kind === 'steps' ? `<span class="tag gold">${tr('bo.stepTag')}</span>${e.extracted ? `<span class="tag" title="${esc(tr('bo.extracted'))}">${esc(tr('bo.extractedTag'))}</span>` : ''}` : e.pasos ? `<span class="tag gold">${esc(tr('bo.hasSteps'))}</span>` : ''}${e.tier !== 'meta' ? `<span class="tag ${e.tier === 'meme' ? 'bad' : 'warn'}">${TIER_LABEL[e.tier]}</span>` : ''}<span>${esc(e.civs.map((c) => (c === 'Any' ? tr('bo.anyCiv') : c)).join(', ') || tr('bo.anyCiv'))}</span>${e.types.length ? `<span class="muted">· ${esc(e.types.slice(0, 3).join(', '))}</span>` : ''}<span class="muted">· ${esc(e.author || '')}${e.date ? ' ' + esc(String(e.date).slice(0, 7)) : ''}${e.steps ? ` · ${e.steps} ${tr('bo.steps')}` : ''}</span></div></div>`;
  const recoHtml =
    reco && (reco.steps.length || reco.guides.length)
      ? `<div class="grp">${tr('bo.forMatch')} <span class="muted" style="text-transform:none;letter-spacing:0">· ${esc(tr('bo.forMatchHint'))}</span></div>${[
          ...reco.steps,
          ...reco.guides,
        ]
          .map((r) => CAT.steps.find((x) => x.id === r.id) || CAT.notes.find((x) => x.id === r.id))
          .filter(Boolean)
          .map(card)
          .join('')}`
      : '';
  $('#boList').innerHTML =
    recoHtml +
      (steps.length ? `<div class="grp">${tr('bo.grpSteps')}</div>${steps.map(card).join('')}` : '') +
      (notes.length
        ? `<div class="grp">${tr('bo.grpNotes')}</div>${notes.slice(0, 300).map(card).join('')}${notes.length > 300 ? `<div class="muted small">${tr('bo.more', { n: notes.length - 300 })}</div>` : ''}`
        : '') || `<p class="muted">${tr('bo.none')}</p>`;
  $$('#boList .bocard').forEach((el) => el.addEventListener('click', () => openCatalogEntry(el.dataset.id)));
}
async function openCatalogEntry(id) {
  const e = CAT.steps.find((x) => x.id === id) || CAT.notes.find((x) => x.id === id);
  if (!e) return;
  $$('#boList .bocard').forEach((x) => x.classList.toggle('sel', x.dataset.id === id));
  if (e.kind === 'steps') {
    $('#boReader').classList.add('hidden');
    await selectBo(e.id);
    $('#boStep').scrollIntoView({ block: 'nearest' });
    return;
  }
  const t = await window.coach.bo.noteText({ file: e.file, stem: e.stem });
  // condensed first ("en la partida": 3-6 lines), the full lessons folded underneath; a build extracted from the note loads into the panel
  const gist =
    t.resumen && t.resumen.length
      ? `<div class="gist"><div class="gh">${esc(tr('bo.gist'))}</div><ul>${t.resumen.map((x) => `<li>${md(x)}</li>`).join('')}</ul></div>`
      : '';
  $('#boReader').innerHTML =
    `<div class="rh"><b>${esc(t.title)}</b> <span class="muted small">${esc(e.author)} ${esc(e.date || '')}</span>${e.tier !== 'meta' ? ` <span class="tag ${e.tier === 'meme' ? 'bad' : 'warn'}">${TIER_LABEL[e.tier]}</span>` : ''}${t.pasos ? `<button class="small" id="boReaderSteps" data-bo="${esc(t.pasos)}">${esc(tr('bo.loadSteps'))}</button>` : ''}${(S.uiLanguage || 'es') !== 'es' ? `<button class="ghost small" id="boReaderTr">🌐 ${tr('g.translate')}</button>` : ''}<button class="ghost small" id="boReaderAsk">${tr('bo.ask')}</button><button class="ghost small" id="boReaderClose">✕</button></div>
    ${gist}${gist ? `<details><summary>${esc(tr('bo.full'))}</summary><div class="rb">${md(t.lessons)}</div></details>` : `<div class="rb">${md(t.lessons)}</div>`}${t.vigencia ? `<details ${gist ? '' : 'open'}><summary>${tr('bo.vig')}</summary><div class="rb">${md(t.vigencia)}</div></details>` : ''}`;
  $('#boReader').classList.remove('hidden');
  $('#boReader').scrollTop = 0;
  $('#boReaderClose').addEventListener('click', () => $('#boReader').classList.add('hidden'));
  const stepsBtn = $('#boReaderSteps');
  if (stepsBtn)
    stepsBtn.addEventListener('click', async () => {
      await selectBo(stepsBtn.dataset.bo);
      $('#boStep').scrollIntoView({ block: 'nearest' });
    });
  const trb = $('#boReaderTr');
  if (trb)
    trb.addEventListener('click', async () => {
      trb.disabled = true;
      trb.textContent = '… ' + tr('g.translating');
      const lang = S.uiLanguage || 'en';
      const parts = [t.lessons, t.vigencia].filter(Boolean);
      const out = await Promise.all(parts.map((x) => window.coach.guide.translate({ text: x, lang })));
      if (out.every((r) => r && r.ok)) {
        const bodies = $$('#boReader .rb');
        out.forEach((r, i) => {
          if (bodies[i]) bodies[i].innerHTML = md(r.text);
        });
        trb.remove();
      } else {
        trb.disabled = false;
        trb.textContent = '⚠ ' + tr('g.trFail');
        const e = out.find((r) => !r || !r.ok);
        trb.title = (e && e.error) || '';
      }
    });
  $('#boReaderAsk').addEventListener('click', () => {
    const c = $('#cmd');
    c.value = tr('bo.askText', { t: t.title });
    showTab('chat');
    focusInput();
  });
}
function bindBo() {
  $('#boSelect').addEventListener('change', (e) => {
    if (e.target.value) selectBo(e.target.value);
  });
  ['#boSearch'].forEach((sel) => $(sel).addEventListener('input', () => renderCatalog()));
  ['#boCiv', '#boSrc', '#boTier'].forEach((sel) => $(sel).addEventListener('change', () => renderCatalog()));
  $('#boReload').addEventListener('click', () => {
    loadBoList();
    renderCatalog(true);
  });
  $('#boPrev').addEventListener('click', () => boMove(-1));
  $('#boNext').addEventListener('click', () => boMove(1));
  $('#boOff').addEventListener('click', () => boCommand('off'));
  $('#boClock').addEventListener('click', clockToggle);
  $('#boClockReset').addEventListener('click', clockReset);
  $('#boImportBtn').addEventListener('click', async () => {
    const txt = $('#boImportText').value.trim();
    if (!txt) return;
    const r = await window.coach.bo.import(txt);
    const m = $('#boImportMsg');
    if (r.ok) {
      m.textContent = L.imported + r.bo.name;
      $('#boImportText').value = '';
      loadBoList(r.bo.id);
    } else m.textContent = '✗ ' + r.error;
  });
  $('#boImportFile').addEventListener('click', async () => {
    const r = await window.coach.bo.importFile();
    if (!r.ok) return;
    $('#boImportMsg').textContent = r.imported.map((x) => (x.error ? '✗ ' + x.error : L.imported + x.name)).join(' · ');
    const ok = r.imported.find((x) => !x.error);
    loadBoList(ok ? ok.id : undefined);
  });
}

/* ----------------------------------------------------------------- init */
window.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  civs = await window.coach.civs();
  try {
    IMG = await window.coach.app.imgIndex();
  } catch {}
  $('#cpSearch').addEventListener('input', renderPick);
  $('#cpSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('#civPick').classList.add('hidden');
    if (e.key === 'Enter') {
      const f = $('#cpList .cpi');
      if (f) pickCiv(f.dataset.k);
    }
  });
  $('#cpClear').addEventListener('click', () => pickCiv(''));
  $('#cpClose').addEventListener('click', () => {
    $('#civPick').classList.add('hidden');
    pickSlot = null;
  });
  $('#tbVs').addEventListener('click', async () => {
    await renderTeam();
    if (document.body.classList.contains('full')) {
      $('#tcPanel').classList.remove('off');
      $('#tcPanel').scrollIntoView({ block: 'nearest' });
    } else showCountersNotice();
  });
  const st = await window.coach.state.get();
  state = st.state;
  renderState();
  await loadVoices();
  bindSettings();
  bindBo();
  bindExtras();
  renderPatch();
  refreshData();
  loadBoList();
  maybeWelcome();
  $$('#tabs button[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      const t = b.dataset.tab,
        compact = !document.body.classList.contains('full');
      if (compact && t !== 'chat') setMode(false);
      showTab(t);
    })
  );
  $('#wTest').addEventListener('click', welcomeTest);
  $('#wKey').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') welcomeTest();
  });
  $('#wSkip').addEventListener('click', () => welcomePick('local'));
  $$('#wModes .modecard').forEach((b) => b.addEventListener('click', () => welcomePick(b.dataset.mode)));
  $('#btnHide').addEventListener('click', () => window.coach.window.hide());
  $('#btnMode').addEventListener('click', () => setMode(document.body.classList.contains('full')));
  $('#btnGuide').addEventListener('click', () => openGuide(window.coach.web ? {} : { civ: state.myCiv || '', map: state.map || '' }));
  $('#btnVoice').addEventListener('click', () => runCommand('/voz'));
  // quick actions offered in the welcome / new-game notice
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.qchips button');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'counters') runCommand('/counters');
    else if (act === 'sheet') runCommand('/ficha');
    else if (act === 'bo') {
      setMode(false);
      showTab('bo');
    } else if (act === 'guide') openGuide(window.coach.web ? {} : { civ: state.myCiv || '', map: state.map || '' });
    else if (act === 'new') runCommand('/nueva');
    else if (act === 'help') runCommand('/ayuda');
  });
  const cmd = $('#cmd');
  cmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = cmd.value;
      cmd.value = '';
      const wasCommand = v.trim().startsWith('/');
      ask(v);
      if (!wasCommand && S.focusReturn !== 'none') release();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cmd.value = '';
      release();
    }
  });
  cmd.addEventListener('focus', () => document.body.classList.add('focused'));
  cmd.addEventListener('blur', () => document.body.classList.remove('focused'));
  window.coach.onHotkey(({ name }) => {
    if (name === 'ask') focusInput();
    else if (name === 'boPrev') boMove(-1);
    else if (name === 'boNext') boMove(1);
  });
  window.coach.onToast(({ kind, text }) => toast(text, kind));
  // the guide (own window on desktop, iframe / own tab on the web) can load a build into the panel or open a catalog entry
  const loadFromGuide = async (id) => {
    if (!id) return;
    await selectBo(id, false);
    toast(tr('g.metaLoaded', {}, 'Build cargado'));
    if (document.body.classList.contains('full') && $('#tabs button.active') && $('#tabs button.active').id !== 'btnGuide') showTab('bo');
    else if (document.body.classList.contains('full') && !window.coach.web) showTab('bo');
  };
  const openFromGuide = async (id) => {
    if (!id) return;
    setMode(false);
    showTab('bo');
    await renderCatalog();
    openCatalogEntry(id);
  };
  if (window.coach.bo.onLoad) window.coach.bo.onLoad((p) => loadFromGuide(p && p.id));
  if (window.coach.bo.onOpen) window.coach.bo.onOpen((p) => openFromGuide(p && p.id));
  window.addEventListener('message', (e) => {
    if (/^https?:$/.test(location.protocol) && e.origin !== location.origin) return;
    const d = e.data || {};
    if (d.type === 'sp:loadBuild') loadFromGuide(d.id);
    else if (d.type === 'sp:openCatalog') openFromGuide(d.id);
  });
  window.coach.onMode(({ compact }) => {
    document.body.classList.toggle('full', !compact);
    document.body.classList.toggle('compact', compact);
  });
  showAnswer({ html: L.welcome + quickChips(), cls: 'sys' });
});
