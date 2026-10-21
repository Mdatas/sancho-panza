'use strict';
/**
 * Screen reader (opt-in, desktop only): every N seconds it grabs the game's resource bar from the screen, sends that crop
 * to the AI provider's vision model and turns the answer into a HUD reading
 *   { food, wood, gold, stone, pop: 'current/limit', idle, villagers: { food, wood, gold, stone }, age: 1-4, time: 'm:ss', at }
 * Only the crop of the bar leaves the PC. Nothing here touches the UI: main.js forwards each reading to the window and
 * to the brain (brain.setLive), and the settings decide whether the loop runs at all (settings.screenRead).
 *
 * Costs: one small image (~50 tokens) per reading; readings are skipped while the crop does not change (menus, pause)
 * and the loop backs off when the bar is not on screen, so an idle app costs nothing.
 */
const { visionComplete } = require('./brain/providers');

const DEFAULT_REGION = { x: 0, y: 0, w: 0.62, h: 0.055 }; // AoE2 DE top bar: resources top-left, age + clock further right
const MIN_INTERVAL_MS = 5000;
const BACKOFF = [1, 2, 4, 8, 8]; // consecutive "not the HUD" results → wait this many intervals before trying again
const STALE_MS = 120 * 1000; // a reading older than this is dropped from the UI

const READ_SYSTEM = `You read the top resource bar of Age of Empires II: Definitive Edition from a cropped screenshot.
Return ONLY a JSON object, no prose:
{"hud": true, "food": int, "wood": int, "gold": int, "stone": int, "pop": "current/limit", "idle": int or null,
 "villagers": {"food": int or null, "wood": int or null, "gold": int or null, "stone": int or null},
 "age": "dark" | "feudal" | "castle" | "imperial" | null, "time": "m:ss" or null, "confidence": 0.0-1.0}
The bar shows, left to right: the idle-villager button (its number = idle villagers, when any), then the four resources, ALWAYS in this order in
Definitive Edition: wood (tree icon), food (meat icon), gold (nuggets icon), stone (grey rocks icon) — each with the stockpile (big number) and,
next to or under it, a smaller number = villagers gathering that resource; then population "current/limit"; further right the current age
(icon or name) and the game clock. Read the digits exactly as printed; never guess a number you cannot read (use null).
If the image is not this HUD (menu, loading screen, desktop, another game), return {"hud": false}.`;

const FIND_SYSTEM = `You locate the top resource bar of Age of Empires II: Definitive Edition in a full screenshot (it may be downscaled).
The bar is a dark horizontal strip, usually at the very top-left, showing food, wood, gold, stone and population numbers with icons, and the game clock / age to its right.
Return ONLY JSON: {"found": true, "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1} with the box that encloses the whole strip from the idle-villager button
to the game clock, as fractions of the image width/height, or {"found": false} if the game HUD is not visible.`;

const AGES = { dark: 1, feudal: 2, castle: 3, imperial: 4 };

/** Parse and sanity-check the model's JSON. Returns null when it is not a usable HUD reading. */
function parseReading(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!j || j.hud === false) return { hud: false };
  const int = (v, max = 99999) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'string' ? parseInt(v.replace(/[^\d]/g, ''), 10) : Number(v);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
  };
  const r = {
    hud: true,
    food: int(j.food),
    wood: int(j.wood),
    gold: int(j.gold),
    stone: int(j.stone),
    idle: int(j.idle, 500),
    villagers: null,
    age: 0,
    time: null,
    pop: null,
  };
  if (r.food == null && r.wood == null && r.gold == null && r.stone == null) return { hud: false };
  const pop = String(j.pop || '').match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
  if (pop && Number(pop[1]) <= 600 && Number(pop[2]) <= 600) r.pop = `${Number(pop[1])}/${Number(pop[2])}`;
  if (j.villagers && typeof j.villagers === 'object') {
    const v = { food: int(j.villagers.food, 300), wood: int(j.villagers.wood, 300), gold: int(j.villagers.gold, 300), stone: int(j.villagers.stone, 300) };
    if (Object.values(v).some((x) => x != null)) r.villagers = v;
  }
  const age = String(j.age || '').toLowerCase();
  r.age = AGES[age] || 0;
  const t = String(j.time || '').match(/^(\d{1,3}):(\d{2})$/);
  if (t && Number(t[2]) < 60) r.time = `${Number(t[1])}:${t[2]}`;
  r.confidence = typeof j.confidence === 'number' ? j.confidence : null;
  if (r.confidence != null && r.confidence < 0.3) return { hud: false, lowConfidence: true };
  return r;
}

function parseBox(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!j || j.found === false) return null;
    const f = (v) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
    const box = { x: f(j.x), y: f(j.y), w: f(j.w), h: f(j.h) };
    if (Object.values(box).some((v) => v == null) || box.w < 0.05 || box.h < 0.01) return null;
    return box;
  } catch {
    return null;
  }
}

/** Cheap "did the picture change" signature: a tiny grayscale thumbnail of the crop. */
function signature(img) {
  try {
    const small = img.resize({ width: 48, height: 6, quality: 'good' });
    const b = small.toBitmap();
    const out = [];
    for (let i = 0; i < b.length; i += 4) out.push((b[i] + b[i + 1] + b[i + 2]) / 3);
    return out;
  } catch {
    return null;
  }
}
function changed(a, b) {
  if (!a || !b || a.length !== b.length) return true;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return diff / a.length > 1.5; // mean per-pixel change above noise
}

/**
 * @param {object} o
 * @param o.electron { desktopCapturer, screen, systemPreferences } (injected so the module can be unit-tested without Electron)
 * @param o.getSettings full settings with the real keys
 * @param o.providerArgs (settings) → { provider, apiKey, model, baseUrl, strictTransport } for the vision call
 * @param o.enabled () → boolean: whether the automatic loop may read right now
 * @param o.getDisplay () → Electron display to capture (the one the overlay is on)
 * @param o.onReading (reading) → void, for every accepted automatic or manual reading
 * @param o.saveRegion (region) → void, after a successful calibration
 */
function createScreenReader({ electron, getSettings, providerArgs, enabled, getDisplay, onReading = () => {}, saveRegion = () => {}, log = () => {} }) {
  const { desktopCapturer, screen, systemPreferences } = electron;
  const st = { timer: null, busy: false, lastAt: 0, lastSig: null, notHud: 0, last: null, lastError: null, reads: 0, cost: 0 };

  function macPermissionError() {
    if (process.platform !== 'darwin' || !systemPreferences || !systemPreferences.getMediaAccessStatus) return null;
    try {
      const s = systemPreferences.getMediaAccessStatus('screen');
      if (s === 'denied' || s === 'restricted') return 'mac-permission';
    } catch {
      /* older Electron */
    }
    return null;
  }

  async function capture() {
    const d = (getDisplay && getDisplay()) || screen.getPrimaryDisplay();
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) throw new Error('no screen source');
    return src.thumbnail;
  }
  function crop(image, region) {
    const s = image.getSize();
    const rect = {
      x: Math.max(0, Math.round(region.x * s.width)),
      y: Math.max(0, Math.round(region.y * s.height)),
      width: Math.max(16, Math.round(region.w * s.width)),
      height: Math.max(8, Math.round(region.h * s.height)),
    };
    rect.width = Math.min(rect.width, s.width - rect.x);
    rect.height = Math.min(rect.height, s.height - rect.y);
    let c = image.crop(rect);
    if (rect.width < 1800) c = c.resize({ width: rect.width * 2, quality: 'best' }); // small text reads better at 2×
    return { image: c, rect };
  }
  function region() {
    const s = getSettings();
    return s.screenReadRegion && s.screenReadRegion.w ? s.screenReadRegion : DEFAULT_REGION;
  }
  async function askVision(system, user, png) {
    const s = getSettings();
    const a = providerArgs(s);
    if (a.provider !== 'openai' && !a.apiKey) throw Object.assign(new Error('no api key'), { code: 'no-key' });
    const r = await visionComplete(a.provider, { ...a, system, user, imageBase64: png.toString('base64'), maxTokens: 900, timeoutMs: 25000 });
    if (r.cost) st.cost += r.cost;
    return r;
  }

  /** One reading now. { manual } readings ignore the change detector and the back-off and return the crop for the UI. */
  async function readOnce({ manual = false } = {}) {
    const perm = macPermissionError();
    if (perm) throw Object.assign(new Error('screen recording permission'), { code: perm });
    const full = await capture();
    const { image, rect } = crop(full, region());
    const sig = signature(image);
    if (!manual && !changed(sig, st.lastSig)) {
      st.lastAt = Date.now();
      return { ok: true, unchanged: true, reading: st.last };
    }
    st.lastSig = sig;
    const png = image.toPNG();
    const r = await askVision(READ_SYSTEM, 'Read this HUD crop.', png);
    st.reads++;
    st.lastAt = Date.now();
    const reading = parseReading(r.text);
    if (!reading || reading.hud === false) {
      st.notHud = Math.min(st.notHud + 1, BACKOFF.length - 1);
      st.lastError = 'not-hud';
      return {
        ok: false,
        notHud: true,
        crop: manual
          ? image
              .resize({ width: Math.min(900, rect.width) })
              .toJPEG(70)
              .toString('base64')
          : null,
        raw: r.text,
      };
    }
    st.notHud = 0;
    st.lastError = null;
    reading.at = Date.now();
    reading.cost = r.cost || null;
    st.last = reading;
    onReading(reading);
    return {
      ok: true,
      reading,
      crop: manual
        ? image
            .resize({ width: Math.min(900, rect.width) })
            .toJPEG(70)
            .toString('base64')
        : null,
    };
  }

  /** Find the bar on a full screenshot, verify by reading it, save the region. */
  async function calibrate() {
    const perm = macPermissionError();
    if (perm) throw Object.assign(new Error('screen recording permission'), { code: perm });
    const full = await capture();
    const s = full.getSize();
    const small = s.width > 1400 ? full.resize({ width: 1400, quality: 'best' }) : full;
    const r = await askVision(FIND_SYSTEM, 'Locate the resource bar in this screenshot.', small.toPNG());
    const box = parseBox(r.text);
    if (!box) return { ok: false, notFound: true, raw: r.text };
    // a little margin, clamped to the screen
    const pad = 0.004;
    const reg = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), w: Math.min(1, box.w + 2 * pad), h: Math.min(1, box.h + 3 * pad) };
    if (reg.x + reg.w > 1) reg.w = 1 - reg.x;
    if (reg.y + reg.h > 1) reg.h = 1 - reg.y;
    const { image, rect } = crop(full, reg);
    const check = await askVision(READ_SYSTEM, 'Read this HUD crop.', image.toPNG());
    const reading = parseReading(check.text);
    if (!reading || reading.hud === false) return { ok: false, notFound: true, raw: check.text, rect };
    saveRegion(reg);
    st.lastSig = null;
    reading.at = Date.now();
    st.last = reading;
    onReading(reading);
    return {
      ok: true,
      region: reg,
      rect,
      reading,
      crop: image
        .resize({ width: Math.min(900, rect.width) })
        .toJPEG(70)
        .toString('base64'),
    };
  }

  async function tick() {
    if (st.busy || !enabled()) return;
    const s = getSettings();
    const every = Math.max(MIN_INTERVAL_MS, (Number(s.screenReadInterval) || 15) * 1000) * BACKOFF[st.notHud];
    if (Date.now() - st.lastAt < every) return;
    st.busy = true;
    try {
      await readOnce({ manual: false });
    } catch (e) {
      st.lastError = e.code || e.message;
      st.lastAt = Date.now();
      st.notHud = Math.min(st.notHud + 1, BACKOFF.length - 1); // errors back off too (no key, offline, permission)
      log('screenread', e.message);
    } finally {
      st.busy = false;
    }
  }
  return {
    start() {
      if (!st.timer) st.timer = setInterval(tick, 1000);
    },
    stop() {
      clearInterval(st.timer);
      st.timer = null;
    },
    readOnce,
    calibrate,
    /** forget the change detector so the next tick reads again (settings toggled, window shown) */
    poke() {
      st.lastSig = null;
      st.notHud = 0;
      st.lastAt = 0;
    },
    status() {
      const fresh = st.last && Date.now() - st.last.at < STALE_MS ? st.last : null;
      return { last: fresh, lastError: st.lastError, reads: st.reads, cost: +st.cost.toFixed(4), region: region() };
    },
  };
}

module.exports = { createScreenReader, parseReading, parseBox, DEFAULT_REGION, STALE_MS };
