'use strict';
/**
 * Build order store. Format = RTS Overlay / buildorderguide.com / rtsbuilds JSON:
 * { name, civilization: "Any"|"Generic"|"Franks"|["Franks","Huns"], author, source,
 *   build_order: [ { villager_count, age (1-4), resources: {wood, food, gold, stone, builder?}, notes: [..], time? } ] }
 *
 * Sources, in priority order (same id → later wins):
 *   <data>/build_orders/rtsbuilds (bundled snapshot of github.com/CraftySalamander/rtsbuilds)
 *   <userData>/build_orders/rtsbuilds (re-synced from GitHub)
 *   <userData>/build_orders (user imports)
 */
const fs = require('fs');
const path = require('path');

const AGE = { 1: 'Dark', 2: 'Feudal', 3: 'Castle', 4: 'Imperial' };
const RTSBUILDS_API = 'https://api.github.com/repos/CraftySalamander/rtsbuilds/contents/docs/api/builds/aoe2';

// Image tokens used in rtsbuilds / RTS Overlay notes → words
const TOKEN_WORDS = {
  'resource/MaleVillDE': 'villager', 'resource/MaleVillDE_alpha': 'villager', 'resource/villager': 'villager',
  'resource/Aoe2de_wood': 'wood', 'resource/Aoe2de_food': 'food', 'resource/Aoe2de_gold': 'gold', 'resource/Aoe2de_stone': 'stone',
  'resource/Aoe2de_hammer': 'builder', 'resource/BerryBushDE': 'berries', 'resource/tree': 'straggler tree',
  'other/House_aoe2DE': 'House', 'other/MuleCart': 'Mule Cart', 'animal/Wild_Chicken': 'chickens',
  'age/FeudalAgeIconDE': 'Feudal Age', 'age/FeudalAgeIconDE_alpha': 'Feudal Age', 'age/CastleAgeIconDE': 'Castle Age', 'age/CastleAgeIconDE_alpha': 'Castle Age',
  'age/ImperialAgeIconDE': 'Imperial Age', 'age/DarkAgeIconDE': 'Dark Age', 'mill/FarmDE': 'Farm', 'town_center/LoomDE': 'Loom',
  'town_center/Towncenter_aoe2DE': 'Town Center', 'lumber_camp/DoubleBitAxe_aoe2DE': 'Double-Bit Axe', 'lumber_camp/BowSawDE': 'Bow Saw',
  'mill/HorseCollarDE': 'Horse Collar', 'mill/HeavyPlowDE': 'Heavy Plow', 'blacksmith/FletchingDE': 'Fletching', 'blacksmith/BodkinArrowDE': 'Bodkin Arrow',
  'stable/BloodlinesDE': 'Bloodlines', 'stable/HusbandryDE': 'Husbandry', 'stable/Scoutcavalry_aoe2DE': 'Scout Cavalry', 'stable/Knight_aoe2DE': 'Knight',
  'stable/Steppelancericon': 'Steppe Lancer', 'stable/Battle_elephant_aoe2DE': 'Battle Elephant', 'barracks/MilitiaDE': 'Militia',
  'barracks/ManAtArmsUpgDE': 'Man-at-Arms upgrade', 'barracks/Eaglescout_aoe2DE': 'Eagle Scout', 'barracks/Eaglewarrior_aoe2DE': 'Eagle Warrior',
  'barracks/Fire_Lancer': 'Fire Lancer', 'town_center/WheelbarrowDE': 'Wheelbarrow', 'town_center/HandcartDE': 'Hand Cart',
  'archery_range/Archer_aoe2DE': 'Archer', 'archery_range/Crossbowman_aoe2DE': 'Crossbowman', 'archery_range/Hand_cannoneer_aoe2DE': 'Hand Cannoneer',
  'archery_range/Cavalryarcher_aoe2DE': 'Cavalry Archer', 'archery_range/ThumbRingDE': 'Thumb Ring', 'university/BallisticsDE': 'Ballistics',
  'university/ChemistryDE': 'Chemistry', 'monastery/RedemptionDE': 'Redemption', 'mining_camp/GoldMiningDE': 'Gold Mining',
  'blacksmith/Forging_aoe2de': 'Forging', 'blacksmith/ScaleBardingArmorDE': 'Scale Barding Armor', 'siege_workshop/Rocket_Cart': 'Rocket Cart',
  'unique_unit/Aoe2-icon-flemish-militia': 'Flemish Militia', 'unique_unit/OrganGunIcon-DE': 'Organ Gun', 'unique_unit/Aoe2de_ratha_ranged': 'Ratha',
  'unique_unit/Aoe2-icon-hussite-wagon': 'Hussite Wagon', 'defensive_structures/Palisade_wall_aoe2de': 'Palisade Wall', 'defensive_structures/Tower_aoe2de': 'Tower',
};

function tokenToWord(tok) {
  const key = tok.replace(/\.(webp|png|jpg)$/i, '');
  if (TOKEN_WORDS[key]) return TOKEN_WORDS[key];
  let base = key.split('/').pop().replace(/^Aoe2de_|^Aoe2-icon-/i, '');
  for (let i = 0; i < 3; i++) base = base.replace(/[_-]?(aoe2[_-]?de|de|icon|alpha)$/i, '');
  base = base.replace(/[_-]+/g, ' ').trim();
  return base.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^\w/, c => c.toUpperCase());
}
function cleanNote(n) { return String(n).replace(/@([^@]+)@/g, (_m, t) => tokenToWord(t)).replace(/\s+/g, ' ').trim(); }

function validate(bo) {
  const errors = [];
  if (!bo || typeof bo !== 'object') return ['not an object'];
  if (!bo.name) errors.push('missing name');
  if (!Array.isArray(bo.build_order) || !bo.build_order.length) errors.push('missing build_order steps');
  else bo.build_order.forEach((s, i) => {
    if (typeof s.villager_count !== 'number') errors.push(`step ${i + 1}: villager_count`);
    if (typeof s.age !== 'number') errors.push(`step ${i + 1}: age`);
    if (!s.resources || ['wood', 'food', 'gold', 'stone'].some(k => typeof s.resources[k] !== 'number')) errors.push(`step ${i + 1}: resources.wood/food/gold/stone`);
    if (!Array.isArray(s.notes)) errors.push(`step ${i + 1}: notes[]`);
  });
  return errors;
}

class BuildOrders {
  constructor(dirs) { this.dirs = dirs; this.list = []; }

  load() {
    const byId = new Map();
    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
        try {
          const bo = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const errs = validate(bo);
          if (errs.length) { console.warn('[bo] skipping', f, errs.join('; ')); continue; }
          bo._id = path.basename(f, '.json');
          bo._file = path.join(dir, f);
          bo._civs = (Array.isArray(bo.civilization) ? bo.civilization : [bo.civilization || 'Any']).map(c => c === 'Generic' ? 'Any' : c);
          bo.build_order = bo.build_order.map(s => ({ ...s, notes: (s.notes || []).map(cleanNote) }));
          byId.set(bo._id, bo); // later dirs override earlier ones
        } catch (e) { console.warn('[bo] bad json', f, e.message); }
      }
    }
    this.list = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    return this;
  }

  search({ civ = null, query = '', limit = 10 } = {}) {
    const q = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const scored = this.list.map(bo => {
      let s = 0;
      const hay = (bo.name + ' ' + (bo.author || '') + ' ' + bo._civs.join(' ') + ' ' + (bo.description || '') + ' ' + bo._id).toLowerCase();
      for (const t of q) { if (hay.includes(t)) s += 2; else if (hay.includes(t.replace(/s$/, ''))) s += 1; }
      if (civ) { if (bo._civs.includes(civ)) s += 3; else if (bo._civs.includes('Any')) s += 1; else s -= 5; }
      return { bo, s };
    }).filter(x => x.s > 0 || (!q.length && !civ)).sort((a, b) => b.s - a.s || a.bo.name.localeCompare(b.bo.name));
    return scored.slice(0, limit).map(({ bo }) => this.summary(bo));
  }

  summary(bo) {
    const last = bo.build_order[bo.build_order.length - 1];
    const feudal = bo.build_order.find(s => s.age >= 2), castle = bo.build_order.find(s => s.age >= 3);
    return { id: bo._id, name: bo.name, civilization: bo._civs, author: bo.author || null, source: bo.source || null, description: bo.description || null,
      steps: bo.build_order.length, finalVillagers: last.villager_count,
      feudalAt: feudal ? `${feudal.villager_count} vills${feudal.time ? ' @' + feudal.time : ''}` : null,
      castleAt: castle ? `${castle.villager_count} vills${castle.time ? ' @' + castle.time : ''}` : null };
  }

  get(id) {
    if (!id) return null;
    const q = String(id).toLowerCase();
    return this.list.find(b => b._id.toLowerCase() === q) || this.list.find(b => b.name.toLowerCase() === q) || null;
  }

  /** Render a build order as readable text (for the LLM / TTS). */
  toText(bo, { maxSteps = 60 } = {}) {
    const lines = [`${bo.name} — ${bo._civs.join('/')}${bo.author ? ' — by ' + bo.author : ''}${bo.source ? ' — ' + bo.source : ''}`];
    bo.build_order.slice(0, maxSteps).forEach((s, i) => {
      const r = s.resources;
      const res = `F${r.food} W${r.wood} G${r.gold} S${r.stone}${r.builder ? ' B' + r.builder : ''}`;
      lines.push(`${i + 1}. [${AGE[s.age] || '?'}] ${s.villager_count} vills (${res})${s.time ? ' @' + s.time : ''}: ${s.notes.join(' | ')}`);
    });
    return lines.join('\n');
  }

  /** Import a build order from JSON text; writes to userDir. Returns the stored summary. */
  importJson(text, userDir) {
    const bo = JSON.parse(text);
    const errs = validate(bo);
    if (errs.length) throw new Error('Invalid build order: ' + errs.join('; '));
    fs.mkdirSync(userDir, { recursive: true });
    const safe = bo.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 60) || 'build_order';
    let file = path.join(userDir, safe + '.json'); let n = 2;
    while (fs.existsSync(file)) file = path.join(userDir, `${safe}_${n++}.json`);
    fs.writeFileSync(file, JSON.stringify(bo, null, 2));
    this.load();
    return this.summary(this.list.find(b => b._file === file));
  }

  /** Re-sync the rtsbuilds AoE2 folder from GitHub into destDir. Returns { added, updated, total }. */
  async syncRtsBuilds(destDir, onProgress = () => {}) {
    const res = await fetch(RTSBUILDS_API, { headers: { 'user-agent': 'aoe2coach', accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const entries = (await res.json()).filter(e => e.type === 'file' && e.name.endsWith('.json'));
    fs.mkdirSync(destDir, { recursive: true });
    let added = 0, updated = 0, i = 0;
    for (const e of entries) {
      const dest = path.join(destDir, path.basename(e.name));
      const shaFile = dest + '.sha';
      const have = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, 'utf8') : null;
      if (have !== e.sha) {
        const r = await fetch(e.download_url, { headers: { 'user-agent': 'aoe2coach' } });
        if (!r.ok) continue;
        const text = await r.text();
        try { if (validate(JSON.parse(text)).length) continue; } catch { continue; }
        fs.writeFileSync(dest, text); fs.writeFileSync(shaFile, e.sha);
        if (have) updated++; else added++;
      }
      onProgress(`builds ${++i}/${entries.length}`);
    }
    this.load();
    return { added, updated, total: entries.length };
  }
}

module.exports = { BuildOrders, validate, AGE, cleanNote, tokenToWord };
