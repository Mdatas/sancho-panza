'use strict';
const path = require('path');
const assert = require('assert');
const { Strategy, OPP_SECTIONS } = require('../src/main/engine/strategy');
const { GameData } = require('../src/main/engine/gamedata');

const root = path.join(__dirname, '..', 'data');
const gd = new GameData(path.join(root, 'game')).load();
const st = new Strategy([path.join(root, 'knowledge')]).load();

const CIV_SECTIONS = [
  'Identidad',
  'Fuerza por edad',
  'Bonos clave',
  'Unidad única',
  'Tecnologías únicas',
  'Lo que NO tiene',
  'Aperturas 1v1',
  'Plan en Castillos',
  'Plan en Imperial',
  'Composiciones fuertes',
  'Jugando CONTRA esta civ',
  'Errores comunes',
  'Mapas',
];
const MAP_SECTIONS = [
  'Tipo y geografía',
  'Recursos iniciales',
  'Murallas',
  'Qué gana acá',
  'Aperturas estándar',
  'Civs fuertes',
  'Timings de referencia',
  'Errores comunes',
];
const has = (p, name) => Object.keys(p.sections).some((k) => k.toLowerCase().startsWith(name.toLowerCase().slice(0, 12)));

let problems = [];
for (const civ of Object.keys(gd.civs)) {
  const p = st.civ(civ);
  if (!p) {
    problems.push(`${civ}: no profile`);
    continue;
  }
  const words = p.body.split(/\s+/).length;
  if (words < 200) problems.push(`${civ}: only ${words} words`);
  for (const sname of CIV_SECTIONS) if (!has(p, sname)) problems.push(`${civ}: missing section ${sname}`);
  if (!p.meta.name_es) problems.push(`${civ}: no name_es`);
}
for (const [key, p] of Object.entries(st.maps)) {
  const words = p.body.split(/\s+/).length;
  if (words < 100) problems.push(`map ${key}: only ${words} words`);
  for (const sname of MAP_SECTIONS) if (!has(p, sname)) problems.push(`map ${key}: missing section ${sname}`);
  if (!Array.isArray(p.meta.aliases) || !p.meta.aliases.length) problems.push(`map ${key}: no aliases`);
}
assert.ok(Object.keys(st.maps).length >= 120, 'maps: ' + Object.keys(st.maps).length);
assert.ok(st.findMap('bosque negro') && st.findMap('bosque negro').meta.map === 'Black Forest', 'alias Bosque Negro');
assert.ok(st.findMap('arabia'), 'arabia');
assert.ok(st.findMap('escondite'), 'escondite');
const fr = st.civ('Franks');
const ex = st.excerpt(fr, OPP_SECTIONS, 2600);
assert.ok(ex.includes('Jugando CONTRA') && ex.length <= 2605, 'opp excerpt');
if (problems.length) {
  console.error('PROFILE PROBLEMS:\n' + problems.join('\n'));
  process.exitCode = 1;
}
console.log(
  `strategy tests passed: ${Object.keys(st.civs).length} civ profiles, ${Object.keys(st.maps).length} map profiles${problems.length ? ' (' + problems.length + ' problems)' : ''}`
);
