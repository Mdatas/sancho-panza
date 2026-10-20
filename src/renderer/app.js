'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const I18N = window.I18N; // src/renderer/i18n.js (es, en, de, pt, zh, vi, ko)
const LANGS = ['es', 'en', 'de', 'pt', 'zh', 'vi', 'ko'];
const DEFAULT_VOICE = { es: 'es-AR-ElenaNeural', en: 'en-US-AriaNeural', de: 'de-DE-KatjaNeural', pt: 'pt-BR-FranciscaNeural', zh: 'zh-CN-XiaoxiaoNeural', vi: 'vi-VN-HoaiMyNeural', ko: 'ko-KR-SunHiNeural' };
function langTable(code) { return Object.assign({}, I18N.en, code === 'es' ? I18N.es : {}, I18N[code] || {}, { err: Object.assign({}, I18N.en.err, (I18N[code] || {}).err || {}) }); }
let L = langTable('es');
let S = {};
let civs = [];
let state = {};
let bo = { current: null, step: 0, choices: [] };
let busy = false, speaking = false;
const player = $('#player');

/* ----------------------------------------------------------------- helpers */
const t = (k) => L[k] || I18N.en[k] || k;
/** Translate a key with {placeholders}; fallback = the key itself or `def`. */
function fill(str, vars = {}) { return String(str).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)); }
function tr(k, vars = {}, def) { const v = L[k] != null ? L[k] : (I18N.en[k] != null ? I18N.en[k] : (def != null ? def : k)); return fill(v, vars); }
/** Unit name in the UI language (game data has Spanish and English names). */
function uName(o) { return (L === undefined || S.uiLanguage === 'es' || !S.uiLanguage) ? (o.unit_es || o.unit) : o.unit; }
function applyI18n() {
  const pick = (k, orig) => (L[k] != null ? L[k] : (I18N.en[k] != null && S.uiLanguage !== 'es' ? I18N.en[k] : orig));
  $$('[data-i18n]').forEach(el => { if (el.dataset.orig == null) el.dataset.orig = el.textContent; el.textContent = pick(el.dataset.i18n, el.dataset.orig); });
  $$('[data-i18n-html]').forEach(el => { if (el.dataset.orig == null) el.dataset.orig = el.innerHTML; el.innerHTML = pick(el.dataset.i18nHtml, el.dataset.orig); });
  $$('[data-i18n-title]').forEach(el => { if (el.dataset.origTitle == null) el.dataset.origTitle = el.title; el.title = pick(el.dataset.i18nTitle, el.dataset.origTitle); });
  $$('[data-i18n-ph]').forEach(el => { if (el.dataset.origPh == null) el.dataset.origPh = el.placeholder; el.placeholder = pick(el.dataset.i18nPh, el.dataset.origPh); });
  document.documentElement.lang = S.uiLanguage || 'es';
  try { wireLinks(document); } catch { /* not yet defined */ }
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function md(s) {
  let h = esc(s);
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/(^|\n)((?:[-•*] .*(?:\n|$))+)/g, (m, pre, block) => pre + '<ul>' + block.trim().split('\n').map(l => '<li>' + l.replace(/^[-•*] /, '') + '</li>').join('') + '</ul>');
  h = h.replace(/(^|\n)((?:\d+[.)] .*(?:\n|$))+)/g, (m, pre, block) => pre + '<ol>' + block.trim().split('\n').map(l => '<li>' + l.replace(/^\d+[.)] /, '') + '</li>').join('') + '</ol>');
  return h.replace(/\n{2,}/g, '\n').replace(/\n/g, '<br>');
}
let toastTimer;
function toast(text, kind = '') { const el = $('#toast'); el.textContent = text; el.className = 'toast ' + kind; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 3500); }
function setBusy(text) { const b = $('#busy'); if (text) { b.classList.remove('hidden'); $('#busyText').textContent = text; } else b.classList.add('hidden'); }
function civName(key) { const c = civs.find(x => x.key === key); return c ? ((S.uiLanguage || "es") === "es" ? c.name_es : c.name_en) : key; }

/** Compact answer area: show one exchange (or a system notice). */
const SPOKEN = new Map(); let spokenSeq = 0;
/** 🔊 button that re-reads one specific answer (placed inside that answer's box). */
function replayBtn(text) { if (!text) return ''; const id = 'r' + (++spokenSeq); SPOKEN.set(id, text); if (SPOKEN.size > 60) SPOKEN.delete(SPOKEN.keys().next().value); return `<button class="replayIn" data-rid="${id}" title="${esc(tr('replay.title'))}">🔊</button>`; }
document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('.replayIn'); if (!b) return; e.preventDefault(); const txt = SPOKEN.get(b.dataset.rid); if (!txt) return; if (speaking && b.classList.contains('playing')) { stopSpeaking(); return; } $$('.replayIn.playing').forEach(x => x.classList.remove('playing')); b.classList.add('playing'); speak(txt).finally(() => setTimeout(() => b.classList.remove('playing'), 300)); });
function showAnswer({ q, html, cls = 'a', meta = '', speakText = '' }) {
  const box = $('#answer');
  box.innerHTML = (q ? `<div class="q">${esc(q)}</div>` : '') + `<div class="${cls}">${speakText ? replayBtn(speakText) : ''}${html}</div>` + (meta ? `<div class="meta">${esc(meta)}</div>` : '');
  box.scrollTop = 0;
}
function addMsg(kind, text, meta) {
  const el = document.createElement('div'); el.className = 'msg ' + kind;
  el.innerHTML = kind === 'assistant' ? replayBtn(text) + answerHtml(text) : kind === 'system' ? md(text) : esc(text);
  if (meta) { const m = document.createElement('span'); m.className = 'meta'; m.textContent = meta; el.appendChild(m); }
  const box = $('#messages'); box.appendChild(el); box.scrollTop = box.scrollHeight;
}
function sysNotice(html) {
  showAnswer({ html, cls: 'sys' });
  // full window / web: the compact answer box is hidden, so notices also go to the chat history
  if (document.body.classList.contains('full')) { const el = document.createElement('div'); el.className = 'msg system'; el.innerHTML = html; const box = $('#messages'); box.appendChild(el); box.scrollTop = box.scrollHeight; try { wireLinks(el); } catch { /* */ } }
}


/* ----------------------------------------------------------------- 3-line summary + detail */
function splitAnswer(text) {
  const t = String(text || '').trim()
    .replace(/^\s*\**(SUMMARY|RESUMEN|TL;?DR)\**\s*:?\**\s*\n/i, '')
    .replace(/(\n\s*-{3,}\s*\n)\s*\**(DETAIL|DETALLE|DETAILS)\**\s*:?\**\s*\n/i, '$1');
  const m = t.match(/^([\s\S]*?)\n\s*-{3,}\s*\n([\s\S]*)$/);
  let sum = '', det = t;
  if (m && /^\s*[•\-*]/.test(m[1])) { sum = m[1].trim(); det = m[2].trim(); }
  else { const lines = t.split('\n'); const head = []; while (lines.length && /^\s*•/.test(lines[0]) && head.length < 3) head.push(lines.shift()); if (head.length === 3) { sum = head.join('\n'); det = lines.join('\n').trim(); } }
  return { sum, det };
}
function answerHtml(text) {
  const { sum, det } = splitAnswer(text);
  if (!sum) return md(text || '…');
  const items = sum.split('\n').map(l => l.replace(/^\s*[•\-*]\s*/, '').trim()).filter(Boolean).slice(0, 3);
  return `<div class="tldr">${items.map(i => `<div>• ${md(i)}</div>`).join('')}</div>${det ? `<div class="detail">${md(det)}</div>` : ''}`;
}
function spokenText(text) { const { sum } = splitAnswer(text); return sum ? sum.replace(/^\s*[•\-*]\s*/gm, '').replace(/\*\*/g, '') : text; }

/* ----------------------------------------------------------------- team bar (4 v 4) */
let IMG = { base: '', civs: {}, units: {} }, TC = null, pickSlot = null;
const civIcon = (key, cls = 'cico') => (key && IMG.civs[key]) ? `<img class="${cls}" src="${esc(IMG.base + IMG.civs[key])}" alt="">` : '';
const unitIcon = (en) => (en && IMG.units[en]) ? `<img class="uico" src="${esc(IMG.base + IMG.units[en])}" alt="">` : '';
function teamSlots() {
  const mine = [state.myCiv || '', ...(state.allies || [])]; while (mine.length < 4) mine.push('');
  const en = (state.enemies && state.enemies.length) ? [...state.enemies] : (state.oppCiv ? [state.oppCiv] : []); while (en.length < 4) en.push('');
  return { mine: mine.slice(0, 4), theirs: en.slice(0, 4) };
}
async function renderTeam() {
  const { mine, theirs } = teamSlots();
  const slot = (side, i, key) => `<button class="slot ${key ? 'set' : ''} ${side === 'mine' && i === 0 ? 'me' : ''}" data-side="${side}" data-i="${i}" title="${esc(key ? civName(key) : (side === 'mine' ? (i === 0 ? tr('team.me') : tr('team.ally')) : tr('team.enemy')))}">${key ? civIcon(key) + `<span>${esc(civName(key))}</span>` : '<i>+</i>'}</button>`;
  $('#tbMine').innerHTML = mine.map((k, i) => slot('mine', i, k)).join('');
  $('#tbTheirs').innerHTML = theirs.map((k, i) => slot('theirs', i, k)).join('');
  $$('#teamBar .slot').forEach(b => b.addEventListener('click', (e) => openPick(b.dataset.side, Number(b.dataset.i), b)));
  TC = await window.coach.team.counters();
  $('#tbAge').textContent = (L.ages[TC.age] || '') + (TC.ageAssumed ? '?' : '');
  // tooltip per enemy slot + the full panel
  $$('#tbTheirs .slot').forEach(b => { const k = theirs[Number(b.dataset.i)]; const row = TC.rows.find(r => r.civ === k); if (row) b.title = civName(k) + '\n' + tcLines(row).join('\n'); });
  $('#tcPanel').innerHTML = tcHtml();
}
function tcLines(row) { return row.threats.map(t => `${uName(t)}${t.unique ? ` (${tr('team.unique')})` : ''} → ${t.answers.length ? t.answers.map(a => uName(a)).join(' / ') : tr('team.noAnswer')}`); }
function tcHtml() {
  if (!TC || !TC.rows.length) return `<span class="muted small">${tr('team.empty')}</span>`;
  if (!TC.myCiv) return `<span class="muted small">${tr('team.noCiv')}</span>`;
  return `<div class="tch">${tr('team.header', { civ: `<b>${esc(civName(TC.myCiv))}</b>`, age: esc(L.ages[TC.age] || '') })}${TC.ageAssumed ? ' ' + tr('team.ageAssumed') : ''} · ${tr('team.method')}</div>` +
    TC.rows.map(r => `<div class="tcrow">${civIcon(r.civ)}<b>${esc(civName(r.civ))}</b>${r.threats.map(t => `<span class="th">${unitIcon(t.unit)}${esc(uName(t))}${t.unique ? `<i>${tr('team.unique')}</i>` : ''} → ${t.answers.length ? t.answers.map(a => `${unitIcon(a.unit)}<b>${esc(uName(a))}</b>`).join(' / ') : `<span class="muted">${tr('team.noAnswer')}</span>`}</span>`).join('')}</div>`).join('');
}
function showCountersNotice() {
  if (!TC || !TC.rows.length || !TC.myCiv) { sysNotice(tcHtml()); return; }
  sysNotice(`<b>${tr('team.title', { civ: esc(civName(TC.myCiv)) })} (${esc(L.ages[TC.age] || '')}${TC.ageAssumed ? '?' : ''}):</b><br>` + TC.rows.map(r => `<b>${esc(civName(r.civ))}:</b> ${esc(tcLines(r).join(' · '))}`).join('<br>'));
}
function openPick(side, i, el) {
  pickSlot = { side, i };
  const box = $('#civPick'); box.classList.remove('hidden');
  const r = el.getBoundingClientRect(); box.style.top = Math.min(r.bottom + 2, window.innerHeight - 200) + 'px'; box.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 234)) + 'px';
  $('#cpSearch').value = ''; renderPick(); $('#cpSearch').focus();
}
function renderPick() {
  const q = norm($('#cpSearch').value);
  const list = civs.filter(c => !q || norm(c.name_es + ' ' + c.name_en).includes(q)).sort((a, b) => a.name_es.localeCompare(b.name_es));
  $('#cpList').innerHTML = list.map(c => `<div class="cpi" data-k="${esc(c.key)}">${civIcon(c.key)}<span>${esc(c.name_es)}</span></div>`).join('');
  $$('#cpList .cpi').forEach(d => d.addEventListener('click', () => pickCiv(d.dataset.k)));
}
async function pickCiv(key) {
  if (!pickSlot) return;
  const { mine, theirs } = teamSlots(); const { side, i } = pickSlot;
  const arr = side === 'mine' ? mine : theirs; arr[i] = key || '';
  const patch = side === 'mine' ? (i === 0 ? { myCiv: key || '' } : { allies: mine.slice(1).filter(Boolean) }) : { enemies: theirs.filter(Boolean) };
  $('#civPick').classList.add('hidden'); pickSlot = null;
  if (await setState(patch)) { await renderTeam(); if (side === 'theirs' || i === 0) showCountersNotice(); }
}

/* ----------------------------------------------------------------- state line */
function renderState() {
  const parts = [];
  const al = state.allies || [], en = state.enemies || [];
  if (al.length || en.length > 1) parts.push(`${al.length + 1}v${Math.max(en.length, 1)}`);
  else if (state.myCiv || state.oppCiv) parts.push(`${state.myCiv ? civName(state.myCiv) : '?'} vs ${state.oppCiv ? civName(state.oppCiv) : '?'}`);
  if (state.age) parts.push(L.ages[state.age] + (state.oppAge ? ` (${L.ages[state.oppAge]})` : ''));
  if (state.map) parts.push(state.map);
  if (state.elo) parts.push('ELO ' + state.elo);
  const line = parts.join(' · ') + (state.source === 'detected' && parts.length ? ' · auto' : '');
  $('#stateLine').textContent = line; $('#stateLine').classList.toggle('hidden', !line); $('#stateEmpty').classList.toggle('hidden', !!line);
  const extra = [state.myArmy && ('yo: ' + state.myArmy), state.theirArmy && ('rival: ' + state.theirArmy), state.myEco && ('eco: ' + state.myEco), state.notes].filter(Boolean).join(' · ');
  $('#stateLine').title = (line + (extra ? '\n' + extra : '')).trim();
  renderTeam();
}
async function setState(patch) {
  const r = await window.coach.state.set(patch);
  if (!r.ok) { toast(r.error, 'err'); return false; }
  state = r.state; renderState(); return true;
}

/* ----------------------------------------------------------------- commands */
const AGES = { dark: 1, oscura: 1, alta: 1, '1': 1, feudal: 2, '2': 2, castle: 3, castillo: 3, castillos: 3, '3': 3, imperial: 4, imp: 4, '4': 4 };
async function runCommand(line) {
  const m = line.match(/^\/(\S+)\s*(.*)$/); if (!m) return false;
  const cmd = m[1].toLowerCase(), arg = m[2].trim();
  const ok = async (msg) => { sysNotice(`<b>${esc(msg)}</b>`); };
  switch (cmd) {
    case 'civ': case 'yo': case 'me': if (await setState({ myCiv: arg })) ok(L.stateSet); return true;
    case 'vs': case 'rival': case 'opp': case 'rivales': case 'enemigos': case 'enemies':
      if (await setState(/[,;/+]| y | and /.test(arg) || /rivales|enemigos|enemies/.test(cmd) ? { enemies: arg } : { oppCiv: arg })) { await renderTeam(); showCountersNotice(); } return true;
    case 'aliados': case 'aliado': case 'allies': case 'equipo': if (await setState({ allies: arg })) { await renderTeam(); ok(L.stateSet); } return true;
    case 'counters': case 'contras': await renderTeam(); showCountersNotice(); return true;
    case 'edad': case 'age': { const a = AGES[arg.toLowerCase()]; if (!a) { toast('dark/feudal/castle/imperial', 'warn'); return true; } if (await setState({ age: a })) ok(L.stateSet); return true; }
    case 'mapa': case 'map': if (await setState({ map: arg })) ok(L.stateSet); return true;
    case 'elo': if (await setState({ elo: arg })) ok(L.stateSet); return true;
    case 'nota': case 'note': case 'notes': if (await setState({ notes: arg })) ok(L.stateSet); return true;
    case 'nueva': case 'new': case 'newgame': { const r = await window.coach.chat.newGame(); state = r.state; renderState(); $('#messages').innerHTML = ''; ok(L.newGame); return true; }
    case 'reset': await window.coach.chat.reset(); $('#messages').innerHTML = ''; ok(L.resetMsg); return true;
    case 'bo': case 'build': await boCommand(arg); return true;
    case 'n': case 'next': boMove(1); return true;
    case 'p': case 'prev': case 'a': boMove(-1); return true;
    case 'voz': case 'voice': { const on = arg ? /^(on|si|sí|1|yes)$/i.test(arg) : !(S.voiceOut !== false); await save({ voiceOut: on }); $('#btnVoice').classList.toggle('on', on); if (!on) stopSpeaking(); ok(on ? L.voiceOn : L.voiceOff); return true; }
    case 'mal': case 'bad': case 'flag': await window.coach.chat.flag(arg); ok(L.flagged); return true;
    case 'full': case 'expandir': setMode(false); return true;
    case 'compact': case 'compacto': case 'mini': setMode(true); return true;
    case 'ayuda': case 'help': case '?': sysNotice(L.help.replace(/\n/g, '<br>')); return true;
    case 'log': case 'logs': window.coach.app.openLogs(); return true;
    case 'guia': case 'guía': case 'guide': {
      const a = (arg || '').trim(); let go = {};
      if (a) { const c = (await window.coach.civs()).find(x => [x.name_es, x.name_en, x.key].some(n => (n || '').toLowerCase() === a.toLowerCase())); go = c ? { tab: 'civs', civ: c.key } : { tab: 'maps', map: a }; }
      window.coach.guide.open(go); return true; }
    case 'mapas': case 'maps': { const ms = await window.coach.maps(); sysNotice('<b>Mapas:</b> ' + esc(ms.join(' · '))); return true; }
    case 'civ?': case 'perfil': case 'profile': { const r = await window.coach.profile('civ', arg); sysNotice(r ? md(r) : esc('—')); return true; }
    case 'mapa?': case 'map?': { const r = await window.coach.profile('map', arg || state.map); sysNotice(r ? md(r) : esc('—')); return true; }
    case 'repetir': case 'repeat': case 'r': if (lastAnswerText) speak(lastAnswerText); else toast(tr('replay.none')); return true;
    case 'partida': case 'match': await matchNow(/^(usar|use|aplicar)$/i.test(arg)); return true;
    case 'parche': case 'patch': { await window.coach.patch.check(); const p = await window.coach.patch.status(); sysNotice(esc(p.line)); renderPatch(); return true; }
    case 'salir': case 'quit': window.coach.window.quit(); return true;
    default: toast(L.unknownCmd, 'warn'); return true;
  }
}

/* ----------------------------------------------------------------- ask */
async function ask(text) {
  text = (text || '').trim(); if (!text || busy) return;
  if (text.startsWith('/')) { await runCommand(text); return; }
  if (S.provider === 'anthropic' && !S.anthropicApiKey) { showAnswer({ q: text, html: explainError('No Claude API key set'), cls: 'err' }); wireLinks($('#answer')); return; }
  busy = true; stopSpeaking();
  showAnswer({ q: text, html: `<span class="muted">${esc(L.busy.thinking)}</span>`, cls: 'a' });
  addMsg('user', text);
  setBusy(L.busy.thinking);
  const off = window.coach.chat.onEvent(ev => {
    if (ev.type === 'tool') setBusy((L.tool[ev.name] || ev.name) + '…');
    if (ev.type === 'state') { state = ev.state; renderState(); }
  });
  const r = await window.coach.chat.ask(text);
  off(); setBusy(''); busy = false;
  if (!r.ok) { const h = explainError(r.error); showAnswer({ q: text, html: h, cls: 'err' }); wireLinks($('#answer')); addMsg('error', r.error); return; }
  if (!S.keyOk) save({ keyOk: true });
  lastAnswerText = r.text || '';
  state = r.state; renderState();
  const tools = (r.tools || []).filter(n => n !== 'update_match_state').map(n => L.tool[n] || n).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  const meta = `${tools ? tools + ' · ' : ''}${(r.ms / 1000).toFixed(1)}s${r.cost ? ` · $${r.cost.toFixed(3)} (${tr('session')} $${r.totals.cost.toFixed(2)})` : ''}`;
  showAnswer({ q: text, html: answerHtml(r.text || '…'), meta, speakText: r.text || '' });
  addMsg('assistant', r.text || '…', meta);
  if (S.voiceOut !== false && S.ttsEngine !== 'off') speak(spokenText(r.text));
}

async function speak(text) {
  if (!text) return;
  stopSpeaking(); speaking = true; setBusy(L.busy.speaking);
  const r = await window.coach.tts.speak(text);
  if (!speaking) return;
  if (!r.ok) { toast('TTS: ' + r.error, 'warn'); speaking = false; setBusy(''); return; }
  if (r.fallbackReason) toast(tr('tts.fallback'), 'warn');
  if (!r.audio) { speaking = false; setBusy(''); return; }
  player.src = `data:${r.mime};base64,${r.audio}`;
  player.onended = player.onerror = () => { speaking = false; setBusy(''); };
  try { await player.play(); } catch { speaking = false; setBusy(''); }
}
function stopSpeaking() { speaking = false; try { player.pause(); player.currentTime = 0; } catch { /* ignore */ } try { window.coach.tts.stop && window.coach.tts.stop(); } catch { /* desktop has no stop */ } if ($('#busyText').textContent === L.busy.speaking) setBusy(''); }

/* ----------------------------------------------------------------- build orders */
async function boCommand(arg) {
  if (!arg) { if (bo.current) renderBo(true); else sysNotice(esc(L.boNone)); return; }
  if (/^(off|no|quitar|none)$/i.test(arg)) { bo.current = null; bo.step = 0; save({ lastBuildOrder: '' }); renderBo(); sysNotice(`<b>${esc(L.boOffMsg)}</b>`); return; }
  if (/^\d+$/.test(arg) && bo.choices.length) { const c = bo.choices[Number(arg) - 1]; if (c) { await selectBo(c.id); return; } }
  const list = await window.coach.bo.list({ civ: state.myCiv || null, query: arg, limit: 6 });
  if (!list.length) { sysNotice(esc(L.noBo)); return; }
  if (list.length === 1 || (list[0].name.toLowerCase() === arg.toLowerCase())) { await selectBo(list[0].id); return; }
  bo.choices = list;
  sysNotice(`${L.boPick}<ol>${list.map(b => `<li>${esc(b.name)} <span class="muted">· ${esc(b.civilization.join('/'))} · ${esc(b.author || '')}</span></li>`).join('')}</ol>`);
}
async function selectBo(id, announce = true) {
  bo.current = await window.coach.bo.get(id); bo.step = 0; bo.choices = [];
  if (!bo.current) return;
  save({ lastBuildOrder: id });
  $('#boMeta').textContent = `${bo.current.author ? bo.current.author + ' · ' : ''}${bo.current.source || ''}`;
  if (announce) sysNotice(`<b>${esc(L.boLoaded)}:</b> ${esc(bo.current.name)} · ${esc(bo.current._civs.join('/'))}${bo.current.author ? ' · ' + esc(bo.current.author) : ''}`);
  renderBo(false);
}
function renderBo(announce = false) {
  const b = bo.current; const line = $('#boLine');
  $('#boLoaded').classList.toggle('hidden', !b);
  if (!b) { line.classList.add('hidden'); line.innerHTML = ''; $('#boPos').textContent = '—'; $('#boAge').textContent = ''; $('#boTime').textContent = ''; $('#boRes').innerHTML = ''; $('#boNotes').innerHTML = ''; return; }
  const s = b.build_order[bo.step]; const r = s.resources;
  const res = `👤${s.villager_count} 🍖${r.food} 🪵${r.wood} 🪙${r.gold} 🪨${r.stone}${r.builder ? ' 🔨' + r.builder : ''}`;
  line.classList.remove('hidden');
  line.innerHTML = `<b>${esc(b.name)}</b> ${bo.step + 1}/${b.build_order.length} · ${esc(L.ages[s.age] || '')}${s.time ? ' @' + esc(s.time) : ''} · ${res} — ${esc(s.notes.join(' | '))}`;
  line.title = s.notes.join('\n');
  $('#boPos').textContent = `${L.step} ${bo.step + 1}/${b.build_order.length}`;
  const ag = $('#boAge'); ag.textContent = L.ages[s.age] || '?'; ag.className = 'agetag a' + s.age;
  $('#boTime').textContent = s.time ? '@' + s.time : '';
  const chips = [['vill', '👤', s.villager_count], ['food', '🍖', r.food], ['wood', '🪵', r.wood], ['gold', '🪙', r.gold], ['stone', '🪨', r.stone]];
  if (r.builder) chips.push(['builder', '🔨', r.builder]);
  $('#boRes').innerHTML = chips.map(([k, ic, v]) => `<span class="res ${k}">${ic}<b>${v}</b></span>`).join('');
  $('#boNotes').innerHTML = s.notes.map(n => `<li>${esc(n)}</li>`).join('');
  if (announce && ($('#boSpeak').checked || S.boSpeak)) speak(`${L.step} ${bo.step + 1}. ${s.notes.join('. ')}`);
}
function boMove(d) {
  if (!bo.current) { sysNotice(esc(L.boNone)); return; }
  const n = bo.step + d; if (n < 0 || n >= bo.current.build_order.length) return;
  bo.step = n; renderBo(true);
}
async function loadBoList(keepId) {
  const list = await window.coach.bo.list({});
  const sel = $('#boSelect');
  sel.innerHTML = '<option value="">—</option>' + list.map(b => `<option value="${esc(b.id)}">${esc(b.name)} · ${esc(b.civilization.join('/'))}${b.author ? ' · ' + esc(b.author) : ''}</option>`).join('');
  const id = keepId || (bo.current && bo.current._id) || S.lastBuildOrder;
  if (id && list.find(b => b.id === id)) { sel.value = id; if (!bo.current) await selectBo(id, false); }
}

/* ----------------------------------------------------------------- mode / focus */
function setMode(compact) { if (compact) { $$('#tabs button[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === 'chat')); $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-chat')); } document.body.classList.toggle('full', !compact); document.body.classList.toggle('compact', compact); window.coach.window.setCompact(compact); if (!compact) { renderHistoryScroll(); } }
function renderHistoryScroll() { const b = $('#messages'); b.scrollTop = b.scrollHeight; }
function focusInput() { const i = $('#cmd'); i.focus(); i.select(); document.body.classList.add('focused'); }
function release() { $('#cmd').blur(); document.body.classList.remove('focused'); window.coach.window.release(); }


/* ----------------------------------------------------------------- providers (presets + info) */
const PRESETS = {
  claude: { kind: 'anthropic', name: 'Claude (Anthropic)', keyUrl: 'https://console.anthropic.com/settings/keys', info: 'prov.claude' },
  openai: { kind: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', model: '', keyUrl: 'https://platform.openai.com/api-keys', info: 'prov.openai' },
  gemini: { kind: 'openai', name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey', info: 'prov.gemini' },
  groq: { kind: 'openai', name: 'Groq', url: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', keyUrl: 'https://console.groq.com/keys', info: 'prov.groq' },
  openrouter: { kind: 'openai', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'nvidia/nemotron-3-super-120b-a12b:free', keyUrl: 'https://openrouter.ai/keys', info: 'prov.openrouter' },
  nvidia: { kind: 'openai', name: 'NVIDIA NIM', url: 'https://integrate.api.nvidia.com/v1', model: 'openai/gpt-oss-20b', keyUrl: 'https://build.nvidia.com/', info: 'prov.nvidia' },
  ollama: { kind: 'openai', name: 'Local (Ollama / LM Studio / llama.cpp)', url: 'http://localhost:11434/v1', model: 'qwen2.5:14b', keyUrl: '', info: 'prov.ollama' },
  custom: { kind: 'openai', name: 'Other OpenAI-compatible', url: '', model: '', keyUrl: '', info: 'prov.custom' },
};
function presetOf(S) { return S.providerPreset && PRESETS[S.providerPreset] ? S.providerPreset : (S.provider === 'openai' ? 'custom' : 'claude'); }
function renderProvInfo() {
  const id = $('#setProvider').value, P = PRESETS[id];
  $('#provInfo').innerHTML = `<div><b>${P.name}</b></div><div>${tr(P.info)}</div>` + (P.keyUrl ? `<div><a data-url="${P.keyUrl}">${tr('prov.getKey')} → ${P.keyUrl.replace(/^https?:\/\//, '')}</a></div>` : '') +
    (id !== 'claude' ? `<div class="muted small">${tr('prov.note')}</div>` : '');
  $$('#provInfo a[data-url]').forEach(a => a.addEventListener('click', () => window.coach.app.openExternal(a.dataset.url)));
  $('#provAnthropic').classList.toggle('hidden', P.kind !== 'anthropic'); $('#provOpenai').classList.toggle('hidden', P.kind !== 'openai');
}

/* ----------------------------------------------------------------- settings */
async function loadSettings() {
  S = await window.coach.settings.get();
  L = langTable(S.uiLanguage || 'es'); applyI18n();
  $('#setProvider').value = presetOf(S); onProviderChange();
  const masked = S.experimentalPrivacy === true;
  if (masked) { $('#setAnthropicKey').value = ''; $('#setAnthropicKey').placeholder = S.anthropicApiKeySet ? tr('key.saved', { k: S.anthropicApiKey }) : 'sk-ant-…'; }
  else { $('#setAnthropicKey').value = S.anthropicApiKey || ''; $('#setAnthropicKey').placeholder = 'sk-ant-…'; }
  const ms = $('#setAnthropicModel'); if (![...ms.options].some(o => o.value === S.anthropicModel)) ms.add(new Option(S.anthropicModel, S.anthropicModel)); ms.value = S.anthropicModel;
  $('#setOpenaiUrl').value = S.openaiBaseUrl || ''; $('#setOpenaiModel').value = S.openaiModel || ''; if (masked) { $('#setOpenaiKey').value = ''; $('#setOpenaiKey').placeholder = S.openaiApiKeySet ? `guardada (${S.openaiApiKey})` : '(opcional)'; } else { $('#setOpenaiKey').value = S.openaiApiKey || ''; $('#setOpenaiKey').placeholder = ''; } urlWarn();
  $('#setLanguage').value = S.language || 'auto'; $('#setTtsEngine').value = S.ttsEngine || 'edge'; $('#setTtsRate').value = S.ttsRate || 1.15; $('#ttsRateVal').textContent = (S.ttsRate || 1.15) + 'x';
  $('#hkAsk').value = S.hotkeys.ask || ''; $('#hkToggle').value = S.hotkeys.toggle || ''; $('#hkPrev').value = S.hotkeys.boPrev || ''; $('#hkNext').value = S.hotkeys.boNext || '';
  $('#setFocusReturn').value = S.focusReturn || 'blur';
  $('#setOpacity').value = S.opacity || 0.94; $('#opacityVal').textContent = Math.round((S.opacity || 0.94) * 100) + '%'; $('#setOnTop').checked = S.alwaysOnTop !== false;
  $('#setUiLang').value = S.uiLanguage || 'es'; $('#boSpeak').checked = !!S.boSpeak;
  $('#btnVoice').classList.toggle('on', S.voiceOut !== false);
  $('#setExpPrivacy').checked = S.experimentalPrivacy === true; $('#setExpCache').checked = S.experimentalCache === true; $('#expPrivacyBox').classList.toggle('hidden', S.experimentalPrivacy !== true);
  $('#setMatchDetect').checked = S.matchDetect === true; $('#setPatchWatch').checked = S.patchWatch !== false;
  $('#setLogDays').value = String(Number(S.logRetentionDays) || 0);
  $('#profileCur').textContent = S.profileId ? `Perfil: ${S.profileName || ''} (#${S.profileId})` : 'Sin perfil elegido';
  $('#setupBanner').classList.toggle('hidden', !(S.provider === 'anthropic' && !S.anthropicApiKey));
  document.body.classList.toggle('full', S.compact === false); document.body.classList.toggle('compact', S.compact !== false);
}
async function save(patch) { S = await window.coach.settings.set(patch); return S; }
function onProviderChange() { renderProvInfo(); }
function bindSettings() {
  const bind = (sel, key, map = v => v, evt = 'change') => $(sel).addEventListener(evt, async (e) => { await save({ [key]: map(e.target.value) }); $('#setupBanner').classList.toggle('hidden', !(S.provider === 'anthropic' && !S.anthropicApiKey)); });
  $('#setProvider').addEventListener('change', async (e) => {
    const id = e.target.value, P = PRESETS[id], patch = { provider: P.kind, providerPreset: id };
    if (P.kind === 'openai') {
      patch.openaiBaseUrl = P.url; patch.openaiModel = P.model; if (presetOf(S) !== id) patch.openaiApiKey = '';
      $('#setOpenaiUrl').value = P.url; $('#setOpenaiModel').value = P.model; if ('openaiApiKey' in patch) $('#setOpenaiKey').value = '';
    }
    await save(patch); onProviderChange(); $('#setupBanner').classList.toggle('hidden', !(S.provider === 'anthropic' && !S.anthropicApiKey));
  });
  const keyInput = (sel, key) => {
    $(sel).addEventListener('input', async e => { if (S.experimentalPrivacy === true) return; await save({ [key]: e.target.value.trim() }); $('#setupBanner').classList.toggle('hidden', !(S.provider === 'anthropic' && !S.anthropicApiKey)); });
    $(sel).addEventListener('change', async e => { if (S.experimentalPrivacy !== true) return; const v = e.target.value.trim(); if (!v) return; await save({ [key]: v }); e.target.value = ''; loadSettings(); });
  };
  keyInput('#setAnthropicKey', 'anthropicApiKey'); bind('#setAnthropicModel', 'anthropicModel');
  bind('#setOpenaiUrl', 'openaiBaseUrl', v => v.trim()); $('#setOpenaiUrl').addEventListener('input', urlWarn); bind('#setOpenaiModel', 'openaiModel', v => v.trim()); keyInput('#setOpenaiKey', 'openaiApiKey');
  bind('#setLanguage', 'language'); bind('#setTtsEngine', 'ttsEngine'); bind('#setTtsVoice', 'ttsVoice'); bind('#setFocusReturn', 'focusReturn');
  $('#setTtsRate').addEventListener('input', e => { $('#ttsRateVal').textContent = e.target.value + 'x'; }); bind('#setTtsRate', 'ttsRate', Number);
  $('#setOpacity').addEventListener('input', e => { $('#opacityVal').textContent = Math.round(e.target.value * 100) + '%'; }); bind('#setOpacity', 'opacity', Number);
  $('#setOnTop').addEventListener('change', e => save({ alwaysOnTop: e.target.checked }));
  $('#boSpeak').addEventListener('change', e => save({ boSpeak: e.target.checked }));
  $('#setUiLang').addEventListener('change', async e => { const lang = e.target.value; const patch = { uiLanguage: lang }; if (!S.voiceChosen || !String(S.ttsVoice || '').toLowerCase().startsWith(lang === 'zh' ? 'zh' : lang)) patch.ttsVoice = DEFAULT_VOICE[lang] || 'es-AR-ElenaNeural'; await save(patch); L = langTable(lang); applyI18n(); try { await loadVoices(); } catch { /* */ } renderState(); renderBo(); refreshData(); });
  const hk = () => save({ hotkeys: { ask: $('#hkAsk').value.trim(), toggle: $('#hkToggle').value.trim(), boPrev: $('#hkPrev').value.trim(), boNext: $('#hkNext').value.trim() } });
  ['#hkAsk', '#hkToggle', '#hkPrev', '#hkNext'].forEach(s => $(s).addEventListener('change', hk));
  $('#toggleKey').addEventListener('click', () => { const i = $('#setAnthropicKey'); i.type = i.type === 'password' ? 'text' : 'password'; });
  $('#btnTestBrain').addEventListener('click', async () => {
    const m = $('#testBrainMsg'); m.textContent = '…';
    const r = await window.coach.chat.ask('Reply with exactly: OK');
    if (r.ok) { m.textContent = `${L.testOk} (${r.model}, ${r.ms} ms${r.cost ? ', $' + r.cost.toFixed(4) : ''})`; save({ keyOk: true }); } else { m.innerHTML = explainError(r.error); wireLinks(m); }
    await window.coach.chat.reset();
  });
  $('#btnTestTts').addEventListener('click', () => speak(tr('tts.test')));
  $('#btnSync').addEventListener('click', async () => { $('#btnSync').disabled = true; await window.coach.data.sync(); $('#btnSync').disabled = false; refreshData(); loadBoList(); });
  $('#btnOpenDir').addEventListener('click', () => window.coach.app.openUserDir());
  $('#btnOpenLogs').addEventListener('click', () => window.coach.app.openLogs());
  $('#btnQuit').addEventListener('click', () => window.coach.window.quit());
  window.coach.data.onStatus(() => refreshData());
}
async function refreshData() { const i = await window.coach.data.info(); $('#dataInfo').textContent = tr('dataset', { civs: i.civs, units: i.units, civProfiles: i.civProfiles || 0, mapProfiles: i.mapProfiles || 0, buildOrders: i.buildOrders, notes: i.notes, source: (i.source || '?').slice(0, 24), lastSync: i.lastSync ? new Date(i.lastSync).toLocaleString() : '—', message: i.message || '', version: i.version }); }
async function loadVoices() { const vs = await window.coach.tts.voices(); const sel = $('#setTtsVoice'); sel.innerHTML = vs.map(v => `<option value="${v.id}">${esc(v.label)}</option>`).join(''); sel.value = S.ttsVoice || vs[0].id; }

/** Warn when an API key would travel in clear text to a public host (main blocks it anyway). */
function urlWarn() {
  const v = ($('#setOpenaiUrl').value || '').trim(); let msg = '';
  try { const u = new URL(v); const priv = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(u.hostname) || /\.(local|lan|internal|ts\.net)$/.test(u.hostname);
    if (u.protocol === 'http:' && !priv) msg = S.experimentalPrivacy === true ? tr('url.httpBlocked') : tr('url.http');
    else if (u.protocol === 'http:') msg = tr('url.local'); } catch { if (v) msg = tr('url.bad'); }
  $('#urlWarn').textContent = msg; $('#urlWarn').classList.toggle('hidden', !msg);
}
function bindExtras() {
  $('#setMatchDetect').addEventListener('change', e => save({ matchDetect: e.target.checked }));
  $('#setExpPrivacy').addEventListener('change', async e => { await save({ experimentalPrivacy: e.target.checked }); loadSettings(); });
  $('#setExpCache').addEventListener('change', e => save({ experimentalCache: e.target.checked }));
  $('#setPatchWatch').addEventListener('change', e => save({ patchWatch: e.target.checked }));
  $('#setLogDays').addEventListener('change', e => save({ logRetentionDays: Number(e.target.value) }));
  $('#btnClearLogs').addEventListener('click', async () => { await window.coach.logs.clear(); toast('Logs borrados.'); });
  $('#profileSearch').addEventListener('click', async () => {
    const out = $('#profileResults'); out.textContent = 'Buscando…';
    const r = await window.coach.match.searchProfile($('#profileQuery').value);
    if (!r.ok) { out.textContent = '✗ ' + r.error; return; }
    if (!r.profiles.length) { out.textContent = 'Sin resultados.'; return; }
    out.innerHTML = r.profiles.map(p => `<div class="item"><button class="ghost small" data-id="${esc(p.profileId)}" data-n="${esc(p.name)}">Soy yo</button> ${esc(p.name)} <span class="muted">· ${esc(p.country.toUpperCase())} · ${p.games} partidas${p.verified ? ' · verificado' : ''}</span></div>`).join('');
    $$('#profileResults button').forEach(b => b.addEventListener('click', async () => { await save({ profileId: b.dataset.id, profileName: b.dataset.n, matchDetect: true }); out.textContent = ''; loadSettings(); toast('Perfil elegido: ' + b.dataset.n); }));
  });
  $('#btnMatchNow').addEventListener('click', () => matchNow());
  $('#btnPatchCheck').addEventListener('click', async () => { $('#patchInfo').textContent = 'Buscando…'; await window.coach.patch.check(); renderPatch(); });
  window.coach.patch.onStatus(() => renderPatch());
  window.coach.match.onDetected(ev => { state = ev.state; renderState(); sysNotice(`<b>${tr('match.detected')}:</b> ${esc(ev.text)}${ev.filled.length ? '' : ` <span class="muted">${tr('match.kept')}</span>`}`); });
}
async function renderPatch() {
  const p = await window.coach.patch.status();
  const newer = p.latest && p.reviewed && Number(p.latest) > Number(p.reviewed);
  $('#patchInfo').textContent = newer ? tr('patch.newer', { latest: p.latest, reviewed: p.reviewed }) : tr('patch.ok', { reviewed: p.reviewed || '?' }) + (p.lastCheck ? ' · ' + tr('patch.last') + ' ' + new Date(p.lastCheck).toLocaleString() : '') + (p.error ? ' · ' + tr('patch.offline') : '');
  $('#patchBadge').classList.toggle('hidden', !newer); $('#patchBadge').title = newer ? tr('patch.badge', { latest: p.latest }) : '';
}
async function matchNow(apply = false) {
  if (apply) { const r = await window.coach.match.apply(true); if (r.ok) { state = r.state; renderState(); sysNotice(`<b>${tr('match.using')}</b>`); } else toast(r.error, 'warn'); return; }
  const r = await window.coach.match.now();
  if (!r.ok) { sysNotice(esc(r.error)); return; }
  sysNotice(`<b>${r.match.live ? tr('match.live') : tr('match.last')}:</b> ${esc(r.text)}<br><span class="muted">${r.match.live ? tr('match.filled') + ' ' : ''}${tr('match.useHint')}</span>`);
  if (r.match.live) { const a = await window.coach.match.apply(false); if (a.ok) { state = a.state; renderState(); } }
}

/* ----------------------------------------------------------------- friendly errors */
let lastAnswerText = '';
function explainError(msg) {
  const m = String(msg || '');
  const keyLink = '<a data-url="https://console.anthropic.com/settings/keys">console.anthropic.com → API Keys</a>';
  const billLink = '<a data-url="https://console.anthropic.com/settings/billing">console.anthropic.com → Billing</a>';
  const steps = (k, vars = {}) => { const e = L.err[k] || I18N.en.err[k]; return `<b>${fill(e.t, vars)}</b><ol class="small">${e.s.map(i => `<li>${fill(i, vars)}</li>`).join('')}</ol>`; };
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
function wireLinks(root) { (root || document).querySelectorAll('a[data-url]').forEach(a => { if (a._w) return; a._w = 1; a.addEventListener('click', (e) => { e.preventDefault(); window.coach.app.openExternal(a.dataset.url); }); }); }

/* ----------------------------------------------------------------- welcome popup (API key) */
function hasKey() { return S.provider === 'openai' ? !!(S.openaiBaseUrl) : !!S.anthropicApiKey; }
function maybeWelcome() {
  if (S.welcomeHide || (hasKey() && S.keyOk)) return;
  if (!hasKey()) { setMode(false); showTab('settings'); }
  $('#welcome').classList.remove('hidden'); setMode(false); wireLinks($('#welcome'));
  setTimeout(() => $('#wKey').focus(), 50);
}
function closeWelcome() { $('#welcome').classList.add('hidden'); if ($('#wNoMore').checked) save({ welcomeHide: true }); }
async function welcomeTest() {
  const v = $('#wKey').value.trim(), msg = $('#wMsg');
  if (!/^sk-ant-/.test(v)) { msg.innerHTML = `<span class="warn">${tr('w.notKey')}</span>`; return; }
  msg.textContent = tr('w.testing');
  await save({ provider: 'anthropic', providerPreset: 'claude', anthropicApiKey: v });
  const r = await window.coach.chat.ask('Reply with exactly: OK'); await window.coach.chat.reset();
  if (r.ok) { await save({ keyOk: true }); msg.innerHTML = `<span class="ok">${tr('w.ok')}</span>`; loadSettings(); setTimeout(() => { closeWelcome(); showTab('chat'); }, 1200); }
  else { msg.innerHTML = explainError(r.error); wireLinks(msg); }
}

/* ----------------------------------------------------------------- tabs */
function showTab(name) {
  $$('#tabs button[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + name));
  if (name === 'bo') renderCatalog();
}

/* ----------------------------------------------------------------- build-order catalog (list, not a drop-down) */
let CAT = null, boType = '';
const TIER_LABEL = { meta: 'META', 'anti-meta': 'ANTI-META', meme: 'MEME' };
async function renderCatalog(force = false) {
  if (!CAT || force) CAT = await window.coach.bo.catalog();
  if (!$('#boTypes').children.length) {
    $('#boTypes').innerHTML = ['', ...CAT.types].map(t => `<button class="chip ${boType === t ? 'on' : ''}" data-t="${esc(t)}">${esc(t ? tr('type.' + t, {}, t) : tr('bo.allTypes'))}</button>`).join('');
    $$('#boTypes .chip').forEach(b => b.addEventListener('click', () => { boType = b.dataset.t; $$('#boTypes .chip').forEach(x => x.classList.toggle('on', x === b)); renderCatalog(); }));
    const civSel = $('#boCiv'); (await window.coach.civs()).forEach(c => civSel.add(new Option(c.name_es, c.key)));
  }
  const q = norm($('#boSearch').value), src = $('#boSrc').value, tier = $('#boTier').value;
  let civ = $('#boCiv').value; if (civ === '__mine') civ = state.myCiv || '';
  const civNames = civ ? (await window.coach.civs()).filter(c => c.key === civ).flatMap(c => [c.name_en, c.name_es]) : [];
  const match = (e) => (!src || e.kind === src) && (!tier || e.tier === tier) && (!boType || e.types.includes(boType))
    && (!civ || e.civs.includes('Any') || e.civs.some(c => civNames.some(n => norm(n) === norm(c))))
    && (!q || norm([e.title, e.author, e.civs.join(' '), e.types.join(' '), e.date].join(' ')).includes(q));
  const steps = CAT.steps.filter(match), notes = CAT.notes.filter(match).sort((a, b) => (a.tier === 'meta' ? 0 : a.tier === 'anti-meta' ? 1 : 2) - (b.tier === 'meta' ? 0 : b.tier === 'anti-meta' ? 1 : 2) || String(b.date).localeCompare(String(a.date)));
  $('#boCount').textContent = tr('bo.count', { s: steps.length, n: notes.length, t: CAT.counts.steps + CAT.counts.notes });
  const card = (e) => `<div class="bocard ${e.kind}" data-id="${esc(e.id)}"><div class="t">${esc(e.title)}</div><div class="s">${e.kind === 'steps' ? `<span class="tag gold">${tr('bo.stepTag')}</span>` : ''}${e.tier !== 'meta' ? `<span class="tag ${e.tier === 'meme' ? 'bad' : 'warn'}">${TIER_LABEL[e.tier]}</span>` : ''}<span>${esc(e.civs.map(c => c === 'Any' ? tr('bo.anyCiv') : c).join(', ') || tr('bo.anyCiv'))}</span>${e.types.length ? `<span class="muted">· ${esc(e.types.slice(0, 3).join(', '))}</span>` : ''}<span class="muted">· ${esc(e.author || '')}${e.date ? ' ' + esc(String(e.date).slice(0, 7)) : ''}${e.steps ? ` · ${e.steps} ${tr('bo.steps')}` : ''}</span></div></div>`;
  $('#boList').innerHTML = (steps.length ? `<div class="grp">${tr('bo.grpSteps')}</div>${steps.map(card).join('')}` : '') + (notes.length ? `<div class="grp">${tr('bo.grpNotes')}</div>${notes.slice(0, 300).map(card).join('')}${notes.length > 300 ? `<div class="muted small">${tr('bo.more', { n: notes.length - 300 })}</div>` : ''}` : '') || `<p class="muted">${tr('bo.none')}</p>`;
  $$('#boList .bocard').forEach(el => el.addEventListener('click', () => openCatalogEntry(el.dataset.id)));
}
async function openCatalogEntry(id) {
  const e = CAT.steps.find(x => x.id === id) || CAT.notes.find(x => x.id === id); if (!e) return;
  $$('#boList .bocard').forEach(x => x.classList.toggle('sel', x.dataset.id === id));
  if (e.kind === 'steps') { $('#boReader').classList.add('hidden'); await selectBo(e.id); $('#boStep').scrollIntoView({ block: 'nearest' }); return; }
  const t = await window.coach.bo.noteText({ file: e.file, stem: e.stem });
  $('#boReader').innerHTML = `<div class="rh"><b>${esc(t.title)}</b> <span class="muted small">${esc(e.author)} ${esc(e.date || '')}</span>${e.tier !== 'meta' ? ` <span class="tag ${e.tier === 'meme' ? 'bad' : 'warn'}">${TIER_LABEL[e.tier]}</span>` : ''}${(S.uiLanguage || 'es') !== 'es' ? `<button class="ghost small" id="boReaderTr">🌐 ${tr('g.translate')}</button>` : ''}<button class="ghost small" id="boReaderAsk">${tr('bo.ask')}</button><button class="ghost small" id="boReaderClose">✕</button></div>
    <div class="rb">${md(t.lessons)}</div>${t.vigencia ? `<details open><summary>${tr('bo.vig')}</summary><div class="rb">${md(t.vigencia)}</div></details>` : ''}`;
  $('#boReader').classList.remove('hidden'); $('#boReader').scrollTop = 0;
  $('#boReaderClose').addEventListener('click', () => $('#boReader').classList.add('hidden'));
  const trb = $('#boReaderTr');
  if (trb) trb.addEventListener('click', async () => {
    trb.disabled = true; trb.textContent = '… ' + tr('g.translating');
    const lang = S.uiLanguage || 'en'; const parts = [t.lessons, t.vigencia].filter(Boolean);
    const out = await Promise.all(parts.map(x => window.coach.guide.translate({ text: x, lang })));
    if (out.every(r => r && r.ok)) { const bodies = $$('#boReader .rb'); out.forEach((r, i) => { if (bodies[i]) bodies[i].innerHTML = md(r.text); }); trb.remove(); }
    else { trb.disabled = false; trb.textContent = '⚠ ' + tr('g.trFail'); const e = out.find(r => !r || !r.ok); trb.title = (e && e.error) || ''; }
  });
  $('#boReaderAsk').addEventListener('click', () => { const c = $('#cmd'); c.value = tr('bo.askText', { t: t.title }); showTab('chat'); focusInput(); });
}
function bindBo() {
  $('#boSelect').addEventListener('change', e => { if (e.target.value) selectBo(e.target.value); });
  ['#boSearch'].forEach(sel => $(sel).addEventListener('input', () => renderCatalog()));
  ['#boCiv', '#boSrc', '#boTier'].forEach(sel => $(sel).addEventListener('change', () => renderCatalog()));
  $('#boReload').addEventListener('click', () => { loadBoList(); renderCatalog(true); });
  $('#boPrev').addEventListener('click', () => boMove(-1)); $('#boNext').addEventListener('click', () => boMove(1));
  $('#boOff').addEventListener('click', () => boCommand('off'));
  $('#boImportBtn').addEventListener('click', async () => {
    const txt = $('#boImportText').value.trim(); if (!txt) return;
    const r = await window.coach.bo.import(txt); const m = $('#boImportMsg');
    if (r.ok) { m.textContent = L.imported + r.bo.name; $('#boImportText').value = ''; loadBoList(r.bo.id); } else m.textContent = '✗ ' + r.error;
  });
  $('#boImportFile').addEventListener('click', async () => {
    const r = await window.coach.bo.importFile(); if (!r.ok) return;
    $('#boImportMsg').textContent = r.imported.map(x => x.error ? '✗ ' + x.error : L.imported + x.name).join(' · ');
    const ok = r.imported.find(x => !x.error); loadBoList(ok ? ok.id : undefined);
  });
}

/* ----------------------------------------------------------------- init */
window.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  civs = await window.coach.civs();
  try { IMG = await window.coach.app.imgIndex(); } catch {}
  $('#cpSearch').addEventListener('input', renderPick); $('#cpSearch').addEventListener('keydown', e => { if (e.key === 'Escape') $('#civPick').classList.add('hidden'); if (e.key === 'Enter') { const f = $('#cpList .cpi'); if (f) pickCiv(f.dataset.k); } });
  $('#cpClear').addEventListener('click', () => pickCiv('')); $('#cpClose').addEventListener('click', () => { $('#civPick').classList.add('hidden'); pickSlot = null; });
  $('#tbVs').addEventListener('click', async () => { await renderTeam(); if (document.body.classList.contains('full')) $('#tcPanel').scrollIntoView({ block: 'nearest' }); else showCountersNotice(); });
  const st = await window.coach.state.get(); state = st.state; renderState();
  await loadVoices(); bindSettings(); bindBo(); bindExtras(); renderPatch();
  refreshData(); loadBoList(); maybeWelcome();
  $$('#tabs button[data-tab]').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.tab, compact = !document.body.classList.contains('full');
    if (compact && t !== 'chat') setMode(false);
    showTab(t);
  }));
  $('#wTest').addEventListener('click', welcomeTest); $('#wKey').addEventListener('keydown', e => { if (e.key === 'Enter') welcomeTest(); });
  $('#wSkip').addEventListener('click', closeWelcome);
  $('#btnHide').addEventListener('click', () => window.coach.window.hide());
  $('#btnMode').addEventListener('click', () => setMode(document.body.classList.contains('full')));
  $('#btnGuide').addEventListener('click', () => window.coach.guide.open({ civ: state.myCiv || '', map: state.map || '' }));
  $('#btnVoice').addEventListener('click', () => runCommand('/voz'));
  const cmd = $('#cmd');
  cmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = cmd.value; cmd.value = ''; const wasCommand = v.trim().startsWith('/'); ask(v); if (!wasCommand && S.focusReturn !== 'none') release(); }
    else if (e.key === 'Escape') { e.preventDefault(); cmd.value = ''; release(); }
  });
  cmd.addEventListener('focus', () => document.body.classList.add('focused'));
  cmd.addEventListener('blur', () => document.body.classList.remove('focused'));
  window.coach.onHotkey(({ name }) => { if (name === 'ask') focusInput(); else if (name === 'boPrev') boMove(-1); else if (name === 'boNext') boMove(1); });
  window.coach.onToast(({ kind, text }) => toast(text, kind));
  window.coach.onMode(({ compact }) => { document.body.classList.toggle('full', !compact); document.body.classList.toggle('compact', compact); });
  showAnswer({ html: L.welcome, cls: 'sys' });
});
