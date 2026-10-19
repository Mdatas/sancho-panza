'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const AGE_ES = ['', 'Oscura', 'Feudal', 'Castillos', 'Imperial'];
const BUILDING_ES = { Barracks: 'Cuartel', 'Archery Range': 'Campo de tiro', Stable: 'Establo', 'Siege Workshop': 'Taller de asedio', Castle: 'Castillo', Monastery: 'Monasterio', Dock: 'Puerto', Krepost: 'Krepost', Donjon: 'Torreón', Caravanserai: 'Caravasar', 'Town Center': 'Centro urbano', Blacksmith: 'Herrería' };

/** Tiny markdown: **bold**, "- " bullets, paragraphs. Everything escaped first. */
function md(text) {
  const lines = String(text || '').split('\n'); let out = '', inList = false;
  const inline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const l = raw.trim();
    if (/^[-*•]\s+/.test(l)) { if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + inline(l.replace(/^[-*•]\s+/, '')) + '</li>'; }
    else { if (inList) { out += '</ul>'; inList = false; } if (l) out += '<p>' + inline(l) + '</p>'; }
  }
  if (inList) out += '</ul>';
  return out;
}
const sections = (secs, open = 3) => secs.map((s, i) => `<details class="card" ${i < open ? 'open' : ''}><summary>${esc(s.name)}</summary><div class="body">${md(s.text)}</div></details>`).join('');

let IDX = null, STATS = null, STATE = {}, curCiv = null, curMap = null, civStyle = '', mapType = '';

/* ------------------------------------------------------------ tabs */
function showTab(name) {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'meta') renderMeta();
  if (name === 'notes' && !$('#noteList').children.length) renderNoteList();
}
$$('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

function ctxLine() {
  const bits = [];
  if (STATE.myCiv || STATE.oppCiv) bits.push(`${nameOf(STATE.myCiv) || '?'} vs ${nameOf(STATE.oppCiv) || '?'}`);
  if (STATE.map) bits.push(STATE.map);
  if (STATE.elo) bits.push('ELO ' + STATE.elo);
  $('#ctx').textContent = bits.join(' · ');
}
let IMG = { base: '', civs: {}, units: {}, techs: {}, buildings: {} };
const ico = (kind, name, cls = 'ico') => { const f = IMG[kind] && IMG[kind][name]; return f ? `<img class="${cls}" src="${esc(IMG.base + f)}" alt="" loading="lazy">` : ''; };
const nameOf = (key) => { const c = IDX && IDX.civs.find(x => x.key === key); return c ? c.name_es : key || ''; };

/* ------------------------------------------------------------ civs */
function renderCivList() {
  const q = norm($('#civSearch').value);
  const styles = [...new Set(IDX.civs.map(c => c.style).filter(Boolean))].sort();
  $('#civChips').innerHTML = ['', ...styles].map(s => `<button class="chip ${civStyle === s ? 'on' : ''}" data-s="${esc(s)}">${esc(s || 'todas')}</button>`).join('');
  $$('#civChips .chip').forEach(b => b.addEventListener('click', () => { civStyle = b.dataset.s; renderCivList(); }));
  const list = IDX.civs.filter(c => (!civStyle || c.style === civStyle) && (!q || norm(c.name_es + ' ' + c.name_en).includes(q)));
  $('#civList').innerHTML = list.map(c => `<div class="item ${curCiv === c.key ? 'sel' : ''} ${STATE.myCiv === c.key ? 'mine' : ''} ${STATE.oppCiv === c.key ? 'theirs' : ''}" data-k="${esc(c.key)}">${ico('civs', c.key, 'ico civ')}<span>${esc(c.name_es)}</span><span class="sub">${esc(c.style)}</span></div>`).join('');
  $$('#civList .item').forEach(el => el.addEventListener('click', () => openCiv(el.dataset.k)));
}
async function openCiv(key) {
  const v = await window.coach.guide.civ(key); if (!v) return;
  curCiv = v.key; renderCivList(); showTab('civs');
  const st = v.stats;
  const ages = [1, 2, 3, 4].map(a => `<span class="age ${v.bestAges.includes(a) ? 'on' : ''}">${AGE_ES[a]}</span>`).join('');
  const lineup = Object.entries(v.lineup).map(([b, us]) => `<div class="lu"><b>${esc(BUILDING_ES[b] || b)}</b>${us.map(u => `<span class="u" title="${esc(u.en)}">${ico('units', u.en, 'ico sm')}${esc(u.name)}<i>${AGE_ES[u.age] ? AGE_ES[u.age][0] : ''}</i></span>`).join('')}</div>`).join('');
  const miss = [...v.missingUnits.map(x => `<span class="tag bad">sin ${esc(x)}</span>`), ...v.missingTechs.map(x => `<span class="tag bad">sin ${esc(x)}</span>`)].join('');
  $('#civView').innerHTML = `
    <div class="head">${ico('civs', v.key, 'ico big')}<h2>${esc(v.name_es)}</h2><span class="muted">${esc(v.name_en)}</span>
      ${v.style ? `<span class="tag gold">${esc(v.style)}</span>` : ''}${v.derived ? '<span class="tag warn" title="Civ nueva o muy cambiada: perfil derivado de los bonos, sin meta asentada">derivado de bonos</span>' : ''}
      ${st ? `<span class="tag" title="${esc(st.games)} partidas, ±${esc(st.err)}">WR ${esc(st.wr)}% · pick ${esc(st.pick)}% · <span class="tier ${esc(st.tier)}">${esc(st.tier)}</span></span>` : ''}</div>
    <div class="actions"><button class="small" data-act="my">Es mi civ</button><button class="small ghost" data-act="opp">Es el rival</button>${STATE.myCiv && STATE.myCiv !== v.key ? '<button class="small ghost" data-act="vs">Ver counters míos vs esta civ</button>' : ''}</div>
    <h3 style="padding:0 18px">Fuerte en…</h3><div class="ages">${ages}</div>
    <h3 style="padding:4px 18px 0">Unidades militares (la mejor de cada línea · inicial = edad)</h3><div class="lineup">${lineup}</div>
    ${miss ? `<h3 style="padding:0 18px">Lo que NO tiene</h3><div class="miss">${miss}</div>` : ''}
    ${sections(v.sections, 3)}`;
  $$('#civView [data-act]').forEach(b => b.addEventListener('click', async () => {
    const a = b.dataset.act;
    if (a === 'vs') { $('#uMy').value = STATE.myCiv; $('#uOpp').value = v.key; showTab('units'); return; }
    const r = await window.coach.state.set(a === 'my' ? { myCiv: v.key } : { oppCiv: v.key }); STATE = r.state || STATE; ctxLine(); renderCivList();
  }));
}

/* ------------------------------------------------------------ maps */
function renderMapList() {
  const q = norm($('#mapSearch').value);
  const types = [...new Set(IDX.maps.map(m => m.type).filter(Boolean))].sort();
  $('#mapChips').innerHTML = ['', ...types].map(s => `<button class="chip ${mapType === s ? 'on' : ''}" data-s="${esc(s)}">${esc(s || 'todos')}</button>`).join('');
  $$('#mapChips .chip').forEach(b => b.addEventListener('click', () => { mapType = b.dataset.s; renderMapList(); }));
  const list = IDX.maps.filter(m => (!mapType || m.type === mapType) && (!q || norm(m.name + ' ' + m.aliases.join(' ')).includes(q)));
  $('#mapList').innerHTML = list.map(m => `<div class="item ${curMap === m.name ? 'sel' : ''} ${norm(STATE.map) === norm(m.name) ? 'mine' : ''}" data-k="${esc(m.name)}"><span>${esc(m.name)}</span><span class="sub">${esc(m.type)}</span></div>`).join('');
  $$('#mapList .item').forEach(el => el.addEventListener('click', () => openMap(el.dataset.k)));
}
async function openMap(key) {
  const v = await window.coach.guide.map(key); if (!v) return;
  curMap = v.name; renderMapList(); showTab('maps');
  $('#mapView').innerHTML = `<div class="head"><h2>${esc(v.name)}</h2>${v.type ? `<span class="tag gold">${esc(v.type)}</span>` : ''}</div>
    <div class="actions"><button class="small" data-act="set">Estoy jugando este mapa</button></div>${sections(v.sections, 4)}`;
  $('#mapView [data-act]').addEventListener('click', async () => { const r = await window.coach.state.set({ map: v.name }); STATE = r.state || STATE; ctxLine(); renderMapList(); });
}

/* ------------------------------------------------------------ units & counters */
function fillSelects() {
  const opts = (blank) => (blank ? '<option value="">(cualquiera)</option>' : '') + IDX.civs.map(c => `<option value="${esc(c.key)}">${esc(c.name_es)}</option>`).join('');
  $('#uOpp').innerHTML = opts(true); $('#uMy').innerHTML = opts(false);
  if (STATE.myCiv) $('#uMy').value = STATE.myCiv; if (STATE.oppCiv) $('#uOpp').value = STATE.oppCiv;
  if (STATE.age >= 2) $('#uAge').value = String(Math.min(4, STATE.age));
  $('#unitList').innerHTML = IDX.units.map(u => `<option value="${esc(u)}">`).join('');
}
async function runCounters() {
  const target = $('#uTarget').value.trim(); if (!target) return;
  const out = $('#uOut'); out.innerHTML = '<p class="muted">Calculando…</p>';
  const opp = $('#uOpp').value || undefined;
  const [info, res] = await Promise.all([
    window.coach.guide.tool('lookup_unit', { name: target, civ: opp }),
    window.coach.guide.tool('find_counters', { target_unit: target, my_civ: $('#uMy').value, age: Number($('#uAge').value), target_civ: opp }),
  ]);
  if (info && info.error) { out.innerHTML = `<p class="err">${esc(info.error)}</p>`; return; }
  const bon = (info.bonusDamage || []).join(', ') || '—', arm = (info.bonusArmor || []).join(', ') || '—';
  let html = `<div class="ucard"><h3>${ico('units', info.en || ((String(info.name).match(/\(([^)]+)\)$/) || [])[1]) || info.name, 'ico big')}${esc(info.name)}</h3><div class="stats">
    <span>Costo <b>${esc(Object.entries(info.cost || {}).filter(([, v]) => v).map(([k, v]) => v + ' ' + k[0]).join(' '))}</b></span><span>HP <b>${esc(info.hp)}</b></span><span>Ataque <b>${esc(info.attack)}</b> (${esc(info.attackType)})</span>
    <span>Armadura <b>${esc(info.armor)}</b></span><span>Alcance <b>${esc(info.range)}</b></span><span>Velocidad <b>${esc(info.speed)}</b></span><span>Edad <b>${esc(info.age)}</b></span><span>Se hace en <b>${esc(BUILDING_ES[info.building] || info.building)}</b></span></div>
    <p class="small"><b>Bonus de ataque:</b> ${esc(bon)}<br><b>Bonus de armadura:</b> ${esc(arm)}<br><b>Clases:</b> ${esc((info.armorClasses || []).join(', '))}</p></div>`;
  if (res && res.error) html += `<p class="err">${esc(res.error)}</p>`;
  else if (res && res.candidates) {
    const max = Math.max(...res.candidates.map(c => c.score), 1);
    html += `<h3>Mejores respuestas de ${esc(nameOf($('#uMy').value))} en edad ${esc(AGE_ES[Number($('#uAge').value)])}</h3><table><tr><th>Unidad</th><th>Costo</th><th>Daño/golpe</th><th>Golpes para matarla</th><th>Eficiencia</th><th></th><th>Notas</th></tr>` +
      res.candidates.map(c => `<tr><td>${ico('units', c.unit, 'ico')}<b>${esc(c.unit_es || c.unit)}</b><br><span class="muted small">${esc(c.unit)}</span></td><td>${esc(c.costTotal)}</td><td>${esc(c.dmgToTarget)} <span class="muted">(recibe ${esc(c.dmgTaken)})</span></td><td>${esc(c.hitsToKill)}</td><td>${esc(c.score)}</td>
        <td><div class="bar"><i style="width:${Math.round(100 * c.score / max)}%"></i></div></td><td class="small">${esc([...(c.bonusVsTarget || []), ...(c.mobility || [])].join(' · '))}</td></tr>`).join('') + '</table>';
  }
  out.innerHTML = html;
}

/* ------------------------------------------------------------ meta */
async function renderMeta() {
  if (!STATS) STATS = await window.coach.guide.stats();
  $('#metaSrc').textContent = STATS.rows.length ? `· ${STATS.source} · ${STATS.sample} partidas` : '';
  const q = norm($('#metaSearch').value), sort = $('#metaSort').value;
  let rows = STATS.rows.filter(r => !q || norm(r.civ).includes(q));
  rows = [...rows].sort((a, b) => sort === 'name' ? a.civ.localeCompare(b.civ) : sort === 'pick' ? b.pick - a.pick : b.wr - a.wr);
  if (!rows.length) { $('#metaTable').innerHTML = '<p class="muted">Sin datos.</p>'; return; }
  const lo = 45, hi = 56;
  $('#metaTable').innerHTML = '<table><tr><th>#</th><th>Civ</th><th>Win rate</th><th></th><th>Popularidad</th><th>Partidas</th><th>ELO medio</th><th>Tier</th></tr>' + rows.map((r, i) => {
    const c = IDX.civs.find(x => norm(x.name_en) === norm(r.civ));
    return `<tr class="click" data-k="${esc(c ? c.key : '')}"><td>${i + 1}</td><td><b>${esc(c ? c.name_es : r.civ)}</b></td><td>${r.wr}% <span class="muted small">±${r.err}</span></td><td><div class="bar"><i style="width:${Math.max(2, Math.min(100, 100 * (r.wr - lo) / (hi - lo)))}%"></i></div></td><td>${r.pick}%</td><td>${r.games}</td><td>${r.elo}</td><td><span class="tier ${esc(r.tier)}">${esc(r.tier)}</span></td></tr>`;
  }).join('') + '</table>';
  $$('#metaTable tr.click').forEach(tr => tr.addEventListener('click', () => tr.dataset.k && openCiv(tr.dataset.k)));
}

/* ------------------------------------------------------------ notes */
async function renderNoteList() {
  const byFile = await window.coach.guide.noteList();
  $('#noteList').innerHTML = Object.entries(byFile).sort().map(([f, titles]) => `<div class="group">${esc(f.replace(/\.md$/, '').replace(/_/g, ' '))}</div>` + titles.map(t => `<div class="item" data-f="${esc(f)}" data-t="${esc(t)}"><span>${esc(t)}</span></div>`).join('')).join('');
  $$('#noteList .item').forEach(el => el.addEventListener('click', async () => {
    const text = await window.coach.guide.noteText({ file: el.dataset.f, title: el.dataset.t });
    $('#noteView').innerHTML = `<div class="head"><h2>${esc(el.dataset.t)}</h2><span class="tag">${esc(el.dataset.f)}</span></div><div class="card" style="margin-top:8px"><div class="body">${md(text)}</div></div>`;
  }));
}
let noteTimer = null;
async function searchNotes() {
  const q = $('#noteSearch').value.trim();
  if (!q) { renderNoteList(); return; }
  const hits = await window.coach.guide.notes(q);
  $('#noteList').innerHTML = '';
  $('#noteView').innerHTML = hits.length ? `<div class="pad"><h3>${hits.length} resultado(s) para "${esc(q)}"</h3></div>` + hits.map((h, i) => `<details class="card" ${i < 2 ? 'open' : ''}><summary>${esc(h.title)} <span class="muted small">· ${esc(h.file)}</span></summary><div class="body">${md(h.text)}</div></details>`).join('') : '<p class="muted pad">Sin resultados.</p>';
}

/* ------------------------------------------------------------ boot */
async function boot() {
  try { IMG = await window.coach.app.imgIndex(); } catch {}
  IDX = await window.coach.guide.index(); STATE = IDX.state || {};
  ctxLine(); renderCivList(); renderMapList(); fillSelects();
  $('#civSearch').addEventListener('input', renderCivList); $('#mapSearch').addEventListener('input', renderMapList);
  $('#uGo').addEventListener('click', runCounters); $('#uTarget').addEventListener('keydown', e => { if (e.key === 'Enter') runCounters(); });
  $('#metaSearch').addEventListener('input', renderMeta); $('#metaSort').addEventListener('change', renderMeta);
  $('#noteSearch').addEventListener('input', () => { clearTimeout(noteTimer); noteTimer = setTimeout(searchNotes, 250); });
  window.coach.guide.onGoto(async (arg) => {
    IDX = await window.coach.guide.index(); STATE = IDX.state || {}; ctxLine(); renderCivList(); renderMapList(); fillSelects();
    if (arg && arg.civ) openCiv(arg.civ);
    else if (arg && arg.tab === 'maps' && arg.map) { const m = IDX.maps.find(x => norm(x.name) === norm(arg.map) || x.aliases.some(a => norm(a) === norm(arg.map))) || IDX.maps.find(x => norm(x.name).includes(norm(arg.map))); if (m) openMap(m.name); else showTab('maps'); }
    else if (arg && arg.tab) showTab(arg.tab);
    else if (STATE.oppCiv && !curCiv) openCiv(STATE.oppCiv);
  });
}
boot();
