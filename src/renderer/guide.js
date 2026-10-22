'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
/* ---- language: same tables as the main window (i18n.js); profiles/notes stay in Spanish with an AI translate button */
let LANG = 'es',
  L = {};
const I18 = window.I18N || { es: {}, en: {} };
function setLang(code) {
  LANG = I18[code] ? code : 'es';
  L = Object.assign({}, I18.en, LANG === 'es' ? I18.es : {}, I18[LANG] || {});
}
function fill(str, vars = {}) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
function G(k, vars = {}, def) {
  const v = L[k] != null ? L[k] : I18.es[k] != null ? I18.es[k] : def != null ? def : k;
  return fill(v, vars);
}
const ES = () => LANG === 'es';
const ageName = (a) => G('g.age.' + a);
const BUILDING_KEY = {
  Barracks: 1,
  'Archery Range': 1,
  Stable: 1,
  'Siege Workshop': 1,
  Castle: 1,
  Monastery: 1,
  Dock: 1,
  Krepost: 1,
  Donjon: 1,
  Caravanserai: 1,
  'Town Center': 1,
  Blacksmith: 1,
};
const bName = (b) => (BUILDING_KEY[b] ? G('g.bld.' + b) : b);
const civLabel = (c) => (ES() ? c.name_es : c.name_en);
const unitLabel = (es, en) => (ES() ? es || en : en || es);
const missLabel = (x) => {
  const m = String(x).match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return m ? (ES() ? m[2] : m[1]) : x;
};
function applyGuideI18n() {
  const pick = (k, orig) => (L[k] != null ? L[k] : orig);
  $$('[data-i18n]').forEach((el) => {
    if (el.dataset.orig == null) el.dataset.orig = el.textContent;
    el.textContent = pick(el.dataset.i18n, el.dataset.orig);
  });
  $$('[data-i18n-html]').forEach((el) => {
    if (el.dataset.orig == null) el.dataset.orig = el.innerHTML;
    el.innerHTML = pick(el.dataset.i18nHtml, el.dataset.orig);
  });
  $$('[data-i18n-ph]').forEach((el) => {
    if (el.dataset.origPh == null) el.dataset.origPh = el.placeholder;
    el.placeholder = pick(el.dataset.i18nPh, el.dataset.origPh);
  });
  document.documentElement.lang = LANG;
  document.title = 'Sancho Panza — ' + G('g.title');
}

/** Tiny markdown: **bold**, "- " bullets, paragraphs. Everything escaped first. */
function md(text) {
  const lines = String(text || '').split('\n');
  let out = '',
    inList = false;
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const l = raw.trim();
    if (/^[-*•]\s+/.test(l)) {
      if (!inList) {
        out += '<ul>';
        inList = true;
      }
      out += '<li>' + inline(l.replace(/^[-*•]\s+/, '')) + '</li>';
    } else {
      if (inList) {
        out += '</ul>';
        inList = false;
      }
      if (l) out += '<p>' + inline(l) + '</p>';
    }
  }
  if (inList) out += '</ul>';
  return out;
}
const TR_CACHE = 'sp.tr.';
const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + s.length;
};
const TEXTS = new Map();
let textSeq = 0;
function trBtn(text) {
  if (ES() || !text) return '';
  const id = 't' + ++textSeq;
  TEXTS.set(id, text);
  return `<button class="trBtn" data-tid="${id}" title="${esc(G('g.translateTitle'))}">🌐 ${esc(G('g.translate'))}</button>`;
}
function cached(text) {
  try {
    return localStorage.getItem(TR_CACHE + LANG + '.' + hash(text));
  } catch {
    return null;
  }
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('.trBtn');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const text = TEXTS.get(b.dataset.tid);
  const body = b.closest('.card, .head + .card, details')?.querySelector('.body') || b.parentElement.nextElementSibling;
  if (!text || !body) return;
  const hit = cached(text);
  if (hit) {
    body.innerHTML = md(hit);
    b.remove();
    return;
  }
  b.disabled = true;
  b.textContent = '… ' + G('g.translating');
  const r = await window.coach.guide.translate({ text, lang: LANG });
  if (r && r.ok) {
    try {
      localStorage.setItem(TR_CACHE + LANG + '.' + hash(text), r.text);
    } catch {
      /* full */
    }
    body.innerHTML = md(r.text);
    b.remove();
  } else {
    b.disabled = false;
    b.textContent = '⚠ ' + G('g.trFail');
    b.title = (r && r.error) || '';
  }
});
const secName = (n) => G('g.sec.' + n, {}, n);
const sections = (secs, open = 3) =>
  secs
    .map((s, i) => {
      const hit = !ES() && cached(s.text);
      return `<details class="card" ${i < open ? 'open' : ''}><summary>${esc(secName(s.name))}${hit ? '' : trBtn(s.text)}</summary><div class="body">${md(hit || s.text)}</div></details>`;
    })
    .join('');

let IDX = null,
  STATS = null,
  STATE = {},
  curCiv = null,
  curMap = null,
  civStyle = '',
  mapType = '';

/* ------------------------------------------------------------ tabs */
function showTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'meta') renderMeta();
  if (name === 'notes' && !$('#noteList').children.length) renderNoteList();
  if (name === 'themes' && !$('#themeList').children.length) renderThemes();
}
let THEMES = null,
  curTheme = '';
async function renderThemes() {
  if (!THEMES) THEMES = await window.coach.guide.themes();
  const list = $('#themeList');
  list.innerHTML = THEMES.map(
    (t) =>
      `<div class="item ${t.id === curTheme ? 'sel' : ''}" data-id="${esc(t.id)}"><span>${esc(t.name)}</span><span class="sub">${t.sections.length}</span></div>`
  ).join('');
  $$('#themeList .item').forEach((el) => el.addEventListener('click', () => openTheme(el.dataset.id)));
  if (!THEMES.length) $('#themeView').innerHTML = `<p class="muted pad">${esc(G('g.themesNone'))}</p>`;
  else if (!curTheme) openTheme(THEMES[0].id);
}
function openTheme(id) {
  const t = (THEMES || []).find((x) => x.id === id);
  if (!t) return;
  curTheme = id;
  $$('#themeList .item').forEach((el) => el.classList.toggle('sel', el.dataset.id === id));
  $('#themeView').innerHTML =
    `<div class="head"><h2>${esc(t.name)}</h2></div>${t.intro ? `<p class="muted small pad">${md(t.intro)}</p>` : ''}${ES() ? '' : `<p class="muted small trnote">${esc(G('g.esNote'))}</p>`}${sections(t.sections, 2)}`;
  $('#themeView').scrollTop = 0;
}
$$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

function ctxLine() {
  const bits = [];
  if (STATE.myCiv || STATE.oppCiv) bits.push(`${nameOf(STATE.myCiv) || '?'} vs ${nameOf(STATE.oppCiv) || '?'}`);
  if (STATE.map) bits.push(STATE.map);
  if (STATE.elo) bits.push('ELO ' + STATE.elo);
  $('#ctx').textContent = bits.join(' · ');
}
let IMG = { base: '', civs: {}, units: {}, techs: {}, buildings: {} };
const ico = (kind, name, cls = 'ico') => {
  const f = IMG[kind] && IMG[kind][name];
  return f ? `<img class="${cls}" src="${esc(IMG.base + f)}" alt="" loading="lazy">` : '';
};
const nameOf = (key) => {
  const c = IDX && IDX.civs.find((x) => x.key === key);
  return c ? civLabel(c) : key || '';
};

/* ------------------------------------------------------------ civs */
function renderCivList() {
  const q = norm($('#civSearch').value);
  const styles = [...new Set(IDX.civs.map((c) => c.style).filter(Boolean))].sort();
  $('#civChips').innerHTML = ['', ...styles]
    .map((s) => `<button class="chip ${civStyle === s ? 'on' : ''}" data-s="${esc(s)}">${esc(s ? G('g.style.' + s, {}, s) : G('g.all'))}</button>`)
    .join('');
  $$('#civChips .chip').forEach((b) =>
    b.addEventListener('click', () => {
      civStyle = b.dataset.s;
      renderCivList();
    })
  );
  const list = IDX.civs.filter((c) => (!civStyle || c.style === civStyle) && (!q || norm(c.name_es + ' ' + c.name_en).includes(q)));
  $('#civList').innerHTML = list
    .map(
      (c) =>
        `<div class="item ${curCiv === c.key ? 'sel' : ''} ${STATE.myCiv === c.key ? 'mine' : ''} ${STATE.oppCiv === c.key ? 'theirs' : ''}" data-k="${esc(c.key)}">${ico('civs', c.key, 'ico civ')}<span>${esc(civLabel(c))}</span>${STATE.myCiv === c.key ? `<span class="badge mine">${esc(G('g.mineBadge'))}</span>` : ''}${STATE.oppCiv === c.key ? `<span class="badge theirs">${esc(G('g.oppBadge'))}</span>` : ''}<span class="sub">${esc(c.style ? G('g.style.' + c.style, {}, c.style) : '')}</span></div>`
    )
    .join('');
  $$('#civList .item').forEach((el) => el.addEventListener('click', () => openCiv(el.dataset.k)));
}
async function openCiv(key) {
  const v = await window.coach.guide.civ(key);
  if (!v) return;
  curCiv = v.key;
  renderCivList();
  showTab('civs');
  try {
    const el = document.querySelector('#civList .item.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  } catch {}
  const st = v.stats;
  const ages = [1, 2, 3, 4].map((a) => `<span class="age ${v.bestAges.includes(a) ? 'on' : ''}">${esc(ageName(a))}</span>`).join('');
  const lineup = Object.entries(v.lineup)
    .map(
      ([b, us]) =>
        `<div class="lu"><b>${ico('buildings', b, 'ico sm')}${esc(bName(b))}</b>${us.map((u) => `<span class="u" title="${esc(u.en)}">${ico('units', u.en, 'ico sm')}${esc(unitLabel(u.name, u.en))}<i>${u.age ? esc(ageName(u.age)).slice(0, 1) : ''}</i></span>`).join('')}</div>`
    )
    .join('');
  const enOf = (x) => String(x).replace(/\s*\([^)]*\)\s*$/, '');
  const miss = [
    ...v.missingUnits.map((x) => `<span class="tech bad">${ico('units', enOf(x), 'ico sm')}${esc(G('g.without', { x: missLabel(x) }))}</span>`),
    ...v.missingTechs.map((x) => `<span class="tech bad">${ico('techs', x, 'ico sm')}${esc(G('g.without', { x }))}</span>`),
  ].join('');
  const uts = (v.uniqueTechs || [])
    .map(
      (t) =>
        `<span class="tech">${ico('techs', t.en, 'ico sm')}${esc(ES() ? t.es : t.en)}${t.age ? `<i class="muted small">${esc(ageName(t.age))}</i>` : ''}</span>`
    )
    .join('');
  $('#civView').innerHTML = `
    <div class="head">${ico('civs', v.key, 'ico big')}<h2>${esc(civLabel(v))}</h2><span class="muted">${esc(ES() ? v.name_en : v.name_es)}</span>
      ${v.style ? `<span class="tag gold">${esc(G('g.style.' + v.style, {}, v.style))}</span>` : ''}${v.derived ? `<span class="tag warn" title="${esc(G('g.derivedTitle'))}">${esc(G('g.derived'))}</span>` : ''}
      ${st ? `<span class="tag" title="${esc(G('g.games', { n: st.games }))}, ±${esc(st.err)}">WR ${esc(st.wr)}% · pick ${esc(st.pick)}% · <span class="tier ${esc(st.tier)}">${esc(st.tier)}</span></span>` : ''}</div>
    <div class="actions"><button class="small" data-act="my">${esc(G('g.isMine'))}</button><button class="small ghost" data-act="opp">${esc(G('g.isOpp'))}</button>${STATE.myCiv && STATE.myCiv !== v.key ? `<button class="small ghost" data-act="vs">${esc(G('g.vsBtn'))}</button>` : ''}<a class="small ext" data-url="https://aoe2techtree.net/#civ=${encodeURIComponent(v.key)}" href="#">${esc(G('g.techtree'))} ↗</a></div>
    ${ES() ? '' : `<p class="muted small trnote">${esc(G('g.esNote'))}</p>`}
    <h3 style="padding:0 18px">${esc(G('g.strongIn'))}</h3><div class="ages">${ages}</div>
    <h3 style="padding:4px 18px 0">${esc(G('g.lineup'))}</h3><div class="lineup">${lineup}</div>
    ${uts ? `<h3 style="padding:0 18px">${esc(G('g.techsHead'))}</h3><div class="techs">${uts}</div>` : ''}
    ${miss ? `<h3 style="padding:0 18px">${esc(G('g.lacks'))}</h3><div class="miss">${miss}</div>` : ''}
    ${sections(v.sections, 3)}`;
  $$('#civView a[data-url]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.coach.app.openExternal(a.dataset.url);
    })
  );
  $$('#civView [data-act]').forEach((b) =>
    b.addEventListener('click', async () => {
      const a = b.dataset.act;
      if (a === 'vs') {
        $('#uMy').value = STATE.myCiv;
        $('#uOpp').value = v.key;
        showTab('units');
        return;
      }
      const r = await window.coach.state.set(a === 'my' ? { myCiv: v.key } : { oppCiv: v.key });
      STATE = r.state || STATE;
      ctxLine();
      renderCivList();
    })
  );
}

/* Map-type emblems (drawn for this app; the game's map images are not bundled) */
const EMB = {
  abierto: '<path d="M4 28 Q12 18 20 24 T36 22" /><path d="M4 33 Q14 27 22 31 T36 30" />',
  semicerrado: '<path d="M5 30h30" /><path d="M8 30V18m5 12V16m5 14V18" /><path d="M24 30V18m5 12V16m5 14V18" />',
  cerrado: '<path d="M6 32V14h6v5h5v-5h6v5h5v-5h6v18z" />',
  agua: '<path d="M4 18q4-4 8 0t8 0 8 0 8 0" /><path d="M4 25q4-4 8 0t8 0 8 0 8 0" /><path d="M4 32q4-4 8 0t8 0 8 0 8 0" />',
  híbrido: '<path d="M10 22q10-12 20 0" /><path d="M4 28q4-4 8 0t8 0 8 0 8 0" /><path d="M4 34q4-4 8 0t8 0 8 0 8 0" />',
  aleatorio:
    '<rect x="9" y="9" width="22" height="22" rx="3" /><circle cx="15" cy="15" r="1.6" /><circle cx="25" cy="25" r="1.6" /><circle cx="20" cy="20" r="1.6" />',
  nomad: '<path d="M6 32L20 10l14 22z" /><path d="M20 10v22" /><path d="M16 32l4-8 4 8" />',
};
const mkey = (n) =>
  String(n || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
/** In-game map icon when we have it (data/img/Maps, from Liquipedia), else the drawn emblem of the map type. */
function mapPic(m, cls = 'mapEmblem') {
  const maps = (IMG && IMG.maps) || {};
  const k = [m.name, ...(m.aliases || [])].map(mkey).find((x) => x && maps[x]);
  if (k) return `<img class="${cls} mapThumb" src="${esc(IMG.base + maps[k])}" alt="" loading="lazy">`;
  return mapEmblem(m.type);
}
function mapEmblem(type) {
  const p = EMB[type] || EMB.abierto;
  return `<svg class="mapEmblem" viewBox="0 0 40 40" fill="none" stroke="#caa24c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
/* ------------------------------------------------------------ maps */
function renderMapList() {
  const q = norm($('#mapSearch').value);
  const types = [...new Set(IDX.maps.map((m) => m.type).filter(Boolean))].sort();
  $('#mapChips').innerHTML = ['', ...types]
    .map((s) => `<button class="chip ${mapType === s ? 'on' : ''}" data-s="${esc(s)}">${esc(s ? G('g.mtype.' + s, {}, s) : G('g.allM'))}</button>`)
    .join('');
  $$('#mapChips .chip').forEach((b) =>
    b.addEventListener('click', () => {
      mapType = b.dataset.s;
      renderMapList();
    })
  );
  const list = IDX.maps.filter((m) => (!mapType || m.type === mapType) && (!q || norm(m.name + ' ' + m.aliases.join(' ')).includes(q)));
  $('#mapList').innerHTML = list
    .map(
      (m) =>
        `<div class="item ${curMap === m.name ? 'sel' : ''} ${norm(STATE.map) === norm(m.name) ? 'mine' : ''}" data-k="${esc(m.name)}">${mapPic(m)}<span>${esc(m.name)}</span><span class="sub">${esc(m.type ? G('g.mtype.' + m.type, {}, m.type) : '')}</span></div>`
    )
    .join('');
  $$('#mapList .item').forEach((el) => el.addEventListener('click', () => openMap(el.dataset.k)));
}
async function openMap(key) {
  const v = await window.coach.guide.map(key);
  if (!v) return;
  curMap = v.name;
  renderMapList();
  showTab('maps');
  const pic = mapPic(v, 'mapEmblem big');
  $('#mapView').innerHTML =
    `<div class="head"><h2>${esc(v.name)}</h2>${v.type ? `<span class="tag gold">${esc(G('g.mtype.' + v.type, {}, v.type))}</span>` : ''}${pic.includes('mapThumb') ? `<div class="mapPicWrap">${pic}<span class="picNote">${esc(G('g.mapZoom'))}</span></div>` : pic}</div>
    <div class="actions"><button class="small" data-act="set">${esc(G('g.playingMap'))}</button></div>${ES() ? '' : `<p class="muted small trnote">${esc(G('g.esNote'))}</p>`}${sections(v.sections, 4)}`;
  $('#mapView [data-act]').addEventListener('click', async () => {
    const r = await window.coach.state.set({ map: v.name });
    STATE = r.state || STATE;
    ctxLine();
    renderMapList();
  });
  const big = $('#mapView .mapThumb.big');
  if (big) {
    big.title = G('g.mapZoom');
    big.addEventListener('click', () => big.classList.toggle('zoom'));
  }
}

/* ------------------------------------------------------------ units & counters */
function fillSelects() {
  const opts = (blank) =>
    (blank ? `<option value="">${esc(G('g.any'))}</option>` : '') + IDX.civs.map((c) => `<option value="${esc(c.key)}">${esc(civLabel(c))}</option>`).join('');
  $('#uOpp').innerHTML = opts(true);
  $('#uMy').innerHTML = opts(false);
  if (STATE.myCiv) $('#uMy').value = STATE.myCiv;
  if (STATE.oppCiv) $('#uOpp').value = STATE.oppCiv;
  if (STATE.age >= 2) $('#uAge').value = String(Math.min(4, STATE.age));
  $('#unitList').innerHTML = IDX.units.map((u) => `<option value="${esc(u)}">`).join('');
}
async function runCounters() {
  const target = $('#uTarget').value.trim();
  if (!target) return;
  const out = $('#uOut');
  out.innerHTML = `<p class="muted">${esc(G('g.calculating'))}</p>`;
  const opp = $('#uOpp').value || undefined;
  const [info, res] = await Promise.all([
    window.coach.guide.tool('lookup_unit', { name: target, civ: opp }),
    window.coach.guide.tool('find_counters', { target_unit: target, my_civ: $('#uMy').value, age: Number($('#uAge').value), target_civ: opp }),
  ]);
  if (info && info.error) {
    out.innerHTML = `<p class="err">${esc(info.error)}</p>`;
    return;
  }
  const bon = (info.bonusDamage || []).join(', ') || '—',
    arm = (info.bonusArmor || []).join(', ') || '—';
  let html = `<div class="ucard"><h3>${ico('units', info.en || (String(info.name).match(/\(([^)]+)\)$/) || [])[1] || info.name, 'ico big')}${esc(info.name)}</h3><div class="stats">
    <span>${esc(G('g.cost'))} <b>${esc(
      Object.entries(info.cost || {})
        .filter(([, v]) => v)
        .map(([k, v]) => v + ' ' + k[0])
        .join(' ')
    )}</b></span><span>HP <b>${esc(info.hp)}</b></span><span>${esc(G('g.attack'))} <b>${esc(info.attack)}</b> (${esc(info.attackType)})</span>
    <span>${esc(G('g.armor'))} <b>${esc(info.armor)}</b></span><span>${esc(G('g.range'))} <b>${esc(info.range)}</b></span><span>${esc(G('g.speed'))} <b>${esc(info.speed)}</b></span><span>${esc(G('g.ageL'))} <b>${esc(info.age)}</b></span><span>${esc(G('g.madeAt'))} <b>${ico('buildings', info.building, 'ico sm')}${esc(bName(info.building))}</b></span></div>
    <p class="small"><b>${esc(G('g.atkBonus'))}:</b> ${esc(bon)}<br><b>${esc(G('g.armBonus'))}:</b> ${esc(arm)}<br><b>${esc(G('g.classes'))}:</b> ${esc((info.armorClasses || []).join(', '))}</p></div>`;
  if (res && res.error) html += `<p class="err">${esc(res.error)}</p>`;
  else if (res && res.candidates) {
    const max = Math.max(...res.candidates.map((c) => c.score), 1);
    html +=
      `<h3>${esc(G('g.bestAnswers', { civ: nameOf($('#uMy').value), age: ageName(Number($('#uAge').value)) }))}</h3><table><tr><th>${esc(G('g.unit'))}</th><th>${esc(G('g.cost'))}</th><th>${esc(G('g.dmgHit'))}</th><th>${esc(G('g.hitsKill'))}</th><th>${esc(G('g.eff'))}</th><th></th><th>${esc(G('g.notes'))}</th></tr>` +
      res.candidates
        .map(
          (
            c
          ) => `<tr><td>${ico('units', c.unit, 'ico')}<b>${esc(unitLabel(c.unit_es, c.unit))}</b>${ES() ? `<br><span class="muted small">${esc(c.unit)}</span>` : ''}</td><td>${esc(c.costTotal)}</td><td>${esc(c.dmgToTarget)} <span class="muted">(${esc(G('g.takes', { n: c.dmgTaken }))})</span></td><td>${esc(c.hitsToKill)}</td><td>${esc(c.score)}</td>
        <td><div class="bar"><i style="width:${Math.round((100 * c.score) / max)}%"></i></div></td><td class="small">${esc([...(c.bonusVsTarget || []), ...(c.mobility || [])].join(' · '))}</td></tr>`
        )
        .join('') +
      '</table>' +
      `<p class="muted small assume">${esc(G('g.unitsAssume'))}</p>`;
  }
  out.innerHTML = html;
}

/* ------------------------------------------------------------ meta */
/* ------------------------------------------------------------ meta by civ */
let curMeta = '';
const TIER_LABEL = { meta: 'META', 'anti-meta': 'ANTI-META', meme: 'MEME' };
/** Left list: every civ with its patch win rate, sorted by win rate / pick / name; the right side is the chosen civ's meta page. */
async function renderMeta() {
  if (!STATS) STATS = await window.coach.guide.stats();
  const q = norm($('#metaSearch').value),
    sort = $('#metaSort').value;
  const rowOf = (c) => STATS.rows.find((r) => norm(r.civ) === norm(c.name_en));
  const civs = IDX.civs
    .filter((c) => !q || norm(c.name_es + ' ' + c.name_en).includes(q))
    .map((c) => ({ c, st: rowOf(c) }))
    .sort((a, b) =>
      sort === 'name'
        ? civLabel(a.c).localeCompare(civLabel(b.c))
        : sort === 'pick'
          ? ((b.st || {}).pick || 0) - ((a.st || {}).pick || 0)
          : ((b.st || {}).wr || 0) - ((a.st || {}).wr || 0)
    );
  $('#metaList').innerHTML = civs
    .map(
      ({ c, st }) =>
        `<div class="item ${curMeta === c.key ? 'sel' : ''} ${STATE.myCiv === c.key ? 'mine' : ''} ${STATE.oppCiv === c.key ? 'theirs' : ''}" data-k="${esc(c.key)}">${ico('civs', c.key, 'ico civ')}<span>${esc(civLabel(c))}</span>${
          st ? `<span class="sub"><span class="tier ${esc(st.tier)}">${esc(st.tier)}</span> ${st.wr}%</span>` : ''
        }</div>`
    )
    .join('');
  $$('#metaList .item').forEach((el) => el.addEventListener('click', () => openMeta(el.dataset.k)));
  if (!curMeta) {
    const first = STATE.myCiv || (civs[0] && civs[0].c.key);
    if (first) openMeta(first);
  }
}
function buildCard(b, { loadable = true } = {}) {
  const why = (b.why || []).length ? '' : ` <span class="muted small">(${esc(G('g.generic', {}, 'genérico'))})</span>`;
  const btn =
    b.kind === 'steps' && loadable
      ? `<button class="small" data-load="${esc(b.id)}">${esc(G('g.metaLoad'))}</button>`
      : `<button class="small ghost" data-open="${esc(b.id)}">${esc(G('g.metaOpenGuide'))}</button>`;
  return `<div class="bcard tier-${esc(b.tier)}"><div class="t">${esc(b.title)}${b.tier !== 'meta' ? ` <span class="tag ${b.tier === 'meme' ? 'bad' : 'warn'}">${TIER_LABEL[b.tier]}</span>` : ''}${why}</div><div class="s"><span class="muted small">${esc(
    [(b.types || []).slice(0, 2).join(', '), b.author, b.feudalPop ? `${b.feudalPop} pop` : '', b.date ? String(b.date).slice(0, 7) : '']
      .filter(Boolean)
      .join(' · ')
  )}</span>${btn}</div></div>`;
}
async function openMeta(key) {
  const r = await window.coach.guide.meta(key);
  if (!r || !r.civ) return;
  const v = r.civ,
    m = r.meta;
  curMeta = v.key;
  $$('#metaList .item').forEach((el) => el.classList.toggle('sel', el.dataset.k === key));
  showTab('meta');
  const st = v.stats;
  const sec = (name) => {
    const x = (v.sections || []).find((s) => s.name === name || s.name.startsWith(name));
    return x ? x.text : '';
  };
  const openingBlock = (label, o) => {
    const steps = (o.steps || []).filter((b) => (b.why || []).length);
    const list = steps.length
      ? steps.map((b) => buildCard(b)).join('')
      : (o.guides || []).length
        ? `<p class="muted small">${esc(G('g.metaNoBuilds'))}</p>` + o.guides.map((g) => buildCard(g)).join('')
        : '';
    return `<details class="card" open><summary>${esc(label)}</summary><div class="body">${o.line ? `<p>${md(o.line.replace(/^[^:]+:\s*/, ''))}</p>` : ''}${list ? `<div class="bh">${esc(G('g.metaBuilds'))}</div><div class="bcards">${list}</div>` : ''}</div></details>`;
  };
  const guideList = (label, arr, open = false) =>
    arr && arr.length
      ? `<details class="card" ${open ? 'open' : ''}><summary>${esc(label)} <span class="muted small">· ${arr.length}</span></summary><div class="body bcards">${arr.map((g) => buildCard(g)).join('')}</div></details>`
      : '';
  const plan = ['Plan en Castillos', 'Plan en Imperial', 'Composiciones fuertes', 'Errores comunes']
    .map((n) => (sec(n) ? `<div class="pl"><b>${esc(secName(n))}:</b> ${md(sec(n))}</div>` : ''))
    .join('');
  $('#metaView').innerHTML = `
    <div class="head">${ico('civs', v.key, 'ico big')}<h2>${esc(G('g.metaOf', { civ: civLabel(v) }))}</h2>${v.style ? `<span class="tag gold">${esc(G('g.style.' + v.style, {}, v.style))}</span>` : ''}
      ${st ? `<span class="tag" title="${esc(G('g.games', { n: st.games }))}, ±${esc(st.err)}"><span class="tier ${esc(st.tier)}">${esc(st.tier)}</span> ${esc(G('g.metaRank', { rank: st.rank, wr: st.wr, pick: st.pick, tier: st.tier }))}</span>` : ''}</div>
    <div class="actions"><button class="small ghost" data-civ="${esc(v.key)}">${esc(civLabel(v))} →</button></div>
    ${ES() ? '' : `<p class="muted small trnote">${esc(G('g.esNote'))}</p>`}
    <h3 style="padding:0 18px">${esc(G('g.metaOpenings'))}</h3>
    ${openingBlock(G('g.metaOpen'), m.open)}${openingBlock(G('g.metaClosed'), m.closed)}${openingBlock(G('g.metaWater'), m.water)}
    ${plan ? `<details class="card" open><summary>${esc(G('g.metaPlan'))}</summary><div class="body">${plan}</div></details>` : ''}
    ${sec('Jugando CONTRA') ? `<details class="card"><summary>${esc(G('g.metaAgainst'))}</summary><div class="body">${md(sec('Jugando CONTRA'))}</div></details>` : ''}
    ${sec('Mapas') ? `<details class="card"><summary>${esc(G('g.metaMaps'))}</summary><div class="body">${md(sec('Mapas'))}</div></details>` : ''}
    <h3 style="padding:8px 18px 0">${esc(G('g.metaGuides'))} <span class="muted small">· ${m.counts.guides}</span></h3>
    ${guideList('META', m.guides.meta, true)}${guideList(G('g.metaAnti'), m.guides.antiMeta)}${guideList(G('g.metaMeme'), m.guides.meme)}
    <details class="card" id="metaTableBox"><summary>${esc(G('g.metaTable'))} <span class="muted small" id="metaSrc"></span></summary><div class="body"><div id="metaTable"></div><p class="muted small">${esc(G('g.h.p.23'))}</p></div></details>`;
  $('#metaView').scrollTop = 0;
  $$('#metaView [data-civ]').forEach((b) => b.addEventListener('click', () => openCiv(b.dataset.civ)));
  $$('#metaView [data-load]').forEach((b) =>
    b.addEventListener('click', async () => {
      await window.coach.guide.loadBuild(b.dataset.load);
      b.textContent = '✓ ' + G('g.metaLoaded');
    })
  );
  $$('#metaView [data-open]').forEach((b) => b.addEventListener('click', () => window.coach.guide.openCatalog(b.dataset.open)));
  renderMetaTable();
}
/** The patch win-rate table (every civ), folded under the meta page. */
function renderMetaTable() {
  if (!STATS || !$('#metaTable')) return;
  $('#metaSrc').textContent = STATS.rows.length ? `· ${G('g.metaSrc')} · ${G('g.games', { n: STATS.sample })}` : '';
  const rows = [...STATS.rows].sort((a, b) => b.wr - a.wr);
  if (!rows.length) {
    $('#metaTable').innerHTML = `<p class="muted">${esc(G('g.noData'))}</p>`;
    return;
  }
  const lo = 45,
    hi = 56;
  $('#metaTable').innerHTML =
    `<table><tr><th>#</th><th>Civ</th><th>Win rate</th><th></th><th>${esc(G('g.pop'))}</th><th>${esc(G('g.gamesH'))}</th><th>${esc(G('g.avgElo'))}</th><th>Tier</th></tr>` +
    rows
      .map((r, i) => {
        const c = IDX.civs.find((x) => norm(x.name_en) === norm(r.civ));
        return `<tr class="click" data-k="${esc(c ? c.key : '')}"><td>${i + 1}</td><td><b>${esc(c ? civLabel(c) : r.civ)}</b></td><td>${r.wr}% <span class="muted small">±${r.err}</span></td><td><div class="bar"><i style="width:${Math.max(2, Math.min(100, (100 * (r.wr - lo)) / (hi - lo)))}%"></i></div></td><td>${r.pick}%</td><td>${r.games}</td><td>${r.elo}</td><td><span class="tier ${esc(r.tier)}">${esc(r.tier)}</span></td></tr>`;
      })
      .join('') +
    '</table>';
  $$('#metaTable tr.click').forEach((tr) => tr.addEventListener('click', () => tr.dataset.k && openMeta(tr.dataset.k)));
}

/* ------------------------------------------------------------ notes */
async function renderNoteList() {
  const byFile = await window.coach.guide.noteList();
  $('#noteList').innerHTML = Object.entries(byFile)
    .sort()
    .map(
      ([f, titles]) =>
        `<div class="group">${esc(f.replace(/\.md$/, '').replace(/_/g, ' '))}</div>` +
        titles.map((t) => `<div class="item" data-f="${esc(f)}" data-t="${esc(t)}"><span>${esc(t)}</span></div>`).join('')
    )
    .join('');
  $$('#noteList .item').forEach((el) =>
    el.addEventListener('click', async () => {
      const text = await window.coach.guide.noteText({ file: el.dataset.f, title: el.dataset.t });
      const hit = !ES() && cached(text);
      $('#noteView').innerHTML =
        `<div class="head"><h2>${esc(el.dataset.t)}</h2><span class="tag">${esc(el.dataset.f)}</span></div><div class="card" style="margin-top:8px"><div class="cardbar">${hit ? '' : trBtn(text)}</div><div class="body">${md(hit || text)}</div></div>`;
    })
  );
}
let noteTimer = null;
async function searchNotes() {
  const q = $('#noteSearch').value.trim();
  if (!q) {
    renderNoteList();
    return;
  }
  const hits = await window.coach.guide.notes(q);
  $('#noteList').innerHTML = '';
  $('#noteView').innerHTML = hits.length
    ? `<div class="pad"><h3>${esc(G('g.results', { n: hits.length, q }))}</h3></div>` +
      hits
        .map((h, i) => {
          const hit = !ES() && cached(h.text);
          return `<details class="card" ${i < 2 ? 'open' : ''}><summary>${esc(h.title)} <span class="muted small">· ${esc(h.file)}</span>${hit ? '' : trBtn(h.text)}</summary><div class="body">${md(hit || h.text)}</div></details>`;
        })
        .join('')
    : `<p class="muted pad">${esc(G('g.none'))}</p>`;
}

/* ------------------------------------------------------------ omnibox (civs, maps, units, notes in one place) */
let omniTimer = null;
function omniClose() {
  $('#omniOut').classList.add('hidden');
}
async function omniSearch() {
  const q = $('#omniQ').value.trim();
  const out = $('#omniOut');
  if (q.length < 2) {
    omniClose();
    return;
  }
  const nq = norm(q);
  const civs = IDX.civs.filter((c) => norm(civLabel(c) + ' ' + c.name_en + ' ' + c.name_es + ' ' + c.key).includes(nq)).slice(0, 5);
  const maps = IDX.maps.filter((m) => norm([m.name, ...(m.aliases || [])].join(' ')).includes(nq)).slice(0, 5);
  const units = (IDX.units || []).filter((u) => norm(u).includes(nq)).slice(0, 5);
  const notes = q.length >= 3 ? (await window.coach.guide.notes(q)).slice(0, 5) : [];
  const row = (kind, label, sub, data) =>
    `<div class="oi" data-kind="${kind}" data-v="${esc(data)}">${label}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>`;
  let html = '';
  if (civs.length)
    html +=
      `<div class="og">${esc(G('g.omniCivs'))}</div>` +
      civs.map((c) => row('civ', `${ico('civs', c.key, 'ico')}${esc(civLabel(c))}`, c.style ? G('g.style.' + c.style, {}, c.style) : '', c.key)).join('');
  if (maps.length)
    html +=
      `<div class="og">${esc(G('g.omniMaps'))}</div>` +
      maps.map((m) => row('map', `${mapPic(m, 'mapEmblem')}${esc(m.name)}`, m.type ? G('g.mtype.' + m.type, {}, m.type) : '', m.name)).join('');
  if (units.length)
    html += `<div class="og">${esc(G('g.omniUnits'))}</div>` + units.map((u) => row('unit', `${ico('units', u, 'ico')}${esc(u)}`, '', u)).join('');
  if (notes.length)
    html +=
      `<div class="og">${esc(G('g.omniNotes'))}</div>` + notes.map((h) => row('note', esc(h.title.slice(0, 70)), h.file.replace(/\.md$/, ''), q)).join('');
  out.innerHTML = html || `<div class="none">${esc(G('g.omniNone'))}</div>`;
  out.classList.remove('hidden');
  $$('#omniOut .oi').forEach((el) =>
    el.addEventListener('click', () => {
      const k = el.dataset.kind,
        v = el.dataset.v;
      omniClose();
      $('#omniQ').value = '';
      if (k === 'civ') openCiv(v);
      else if (k === 'map') openMap(v);
      else if (k === 'unit') {
        $('#uTarget').value = v;
        showTab('units');
        runCounters();
      } else if (k === 'note') {
        $('#noteSearch').value = v;
        showTab('notes');
        searchNotes();
      }
    })
  );
}
function bindOmni() {
  const q = $('#omniQ');
  if (!q) return;
  q.addEventListener('input', () => {
    clearTimeout(omniTimer);
    omniTimer = setTimeout(omniSearch, 180);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      omniClose();
      q.blur();
    } else if (e.key === 'Enter') {
      const first = $('#omniOut .oi');
      if (first && !$('#omniOut').classList.contains('hidden')) first.click();
    }
  });
  q.addEventListener('focus', () => {
    if (q.value.trim().length >= 2) omniSearch();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#omni')) omniClose();
  });
}

/* ------------------------------------------------------------ boot */
const THEME_IDS = ['taverna', 'taverna-night', 'classic-dark', 'classic-light'];
function applyTheme(t) {
  document.documentElement.dataset.theme = THEME_IDS.includes(t) ? t : 'taverna';
}
try {
  const early = new URLSearchParams(location.search).get('theme'); // desktop passes it in the URL for a correct first paint
  if (early && THEME_IDS.includes(early)) applyTheme(early);
} catch {
  /* */
}
async function boot() {
  try {
    const S = await window.coach.settings.get();
    setLang(S.uiLanguage || 'es');
    applyTheme(S.theme);
  } catch {
    setLang('es');
  }
  if (window.coach.settings.onChange) window.coach.settings.onChange((s) => s && s.theme && applyTheme(s.theme)); // desktop: the main window changed it
  applyGuideI18n();
  try {
    IMG = await window.coach.app.imgIndex();
  } catch {}
  IDX = await window.coach.guide.index();
  STATE = IDX.state || {};
  ctxLine();
  renderCivList();
  renderMapList();
  fillSelects();
  $('#civSearch').addEventListener('input', renderCivList);
  $('#mapSearch').addEventListener('input', renderMapList);
  $('#uGo').addEventListener('click', runCounters);
  $('#uTarget').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runCounters();
  });
  $('#metaSearch').addEventListener('input', renderMeta);
  $('#metaSort').addEventListener('change', renderMeta);
  bindOmni();
  $('#noteSearch').addEventListener('input', () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(searchNotes, 250);
  });
  booted = true;
  if (pendingGoto) {
    const a = pendingGoto;
    pendingGoto = null;
    handleGoto(a);
  }
}
async function handleGoto(arg) {
  IDX = await window.coach.guide.index();
  STATE = IDX.state || {};
  ctxLine();
  renderCivList();
  renderMapList();
  fillSelects();
  if (arg && arg.civ) openCiv(arg.civ);
  else if (arg && arg.tab === 'maps' && arg.map) {
    const m =
      IDX.maps.find((x) => norm(x.name) === norm(arg.map) || x.aliases.some((a) => norm(a) === norm(arg.map))) ||
      IDX.maps.find((x) => norm(x.name).includes(norm(arg.map)));
    if (m) openMap(m.name);
    else showTab('maps');
  } else if (arg && arg.tab) showTab(arg.tab);
  else if (!curCiv) {
    const c = STATE.oppCiv || (STATE.enemies || [])[0] || STATE.myCiv;
    if (c) openCiv(c);
  }
}
// register before boot awaits anything, so a goto sent while loading is not lost
let booted = false,
  pendingGoto = null;
window.coach.guide.onGoto((arg) => {
  if (booted) handleGoto(arg);
  else pendingGoto = arg;
});
window.addEventListener('message', (e) => {
  if (/^https?:$/.test(location.protocol) && e.origin !== location.origin) return;
  /* web: only our own page may drive the guide */ const d = e.data || {};
  if (d.type === 'sp:theme') {
    applyTheme(d.theme);
    return;
  }
  if (d.type !== 'sp:goto') return;
  if (window.coach.setStateFromParent) window.coach.setStateFromParent(d.state || {});
  const arg = d.arg || {};
  if (booted) handleGoto(arg);
  else pendingGoto = arg;
});
boot();
