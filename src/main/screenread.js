'use strict';
/**
 * Screen reader (opt-in, desktop only): every N seconds it grabs the game's resource bar from the screen and turns it
 * into a HUD reading { food, wood, gold, stone, pop: 'current/limit', idle, villagers: { food, wood, gold, stone }, age: 1-4, time: 'm:ss', at }.
 * Two engines: 'local' (default; Tesseract in a worker thread, see ocr/local.js — nothing leaves the PC) and 'ai'
 * (the crop goes to the AI provider's vision model). Nothing here touches the UI: main.js forwards each reading to the
 * window and to the brain (brain.setLive), and the settings decide whether the loop runs at all (settings.screenRead).
 *
 * Readings are skipped while the crop does not change (menus, pause) and the loop backs off when the bar is not on
 * screen, so an idle app costs nothing (and, with the vision model, one small image ≈ US$0.0003 per reading).
 */
const { visionComplete } = require('./brain/providers');

const DEFAULT_REGION = { x: 0, y: 0, w: 0.62, h: 0.055 }; // AoE2 DE top bar: resources top-left, age + clock further right
const MIN_INTERVAL_MS = 5000;
const BACKOFF = [1, 2, 4, 8, 8]; // consecutive "not the HUD" results → wait this many intervals before trying again
const STALE_MS = 120 * 1000; // a reading older than this is dropped from the UI

const READ_SYSTEM = `You read the top resource bar of Age of Empires II: Definitive Edition from a cropped screenshot.
Return ONLY a JSON object, no prose:
{"hud": true, "food": int, "wood": int, "gold": int, "stone": int, "pop": "current/limit", "idle": int or null,
 "villagers": {"food": int or null, "wood": int or null, "gold": int or null, "stone": int or null}, "villagersTotal": int or null,
 "age": "dark" | "feudal" | "castle" | "imperial" | null, "time": "h:mm:ss" or "m:ss" or null, "confidence": 0.0-1.0}
The bar shows, left to right, ALWAYS in this order in Definitive Edition: wood (logs icon), food (meat icon), gold (nuggets icon),
stone (grey block icon) — each box has the stockpile as a big white number right of the icon and a small YELLOW number under the icon =
villagers gathering that resource; then the population box: "current/limit" in white with a small CYAN number under its icon = total
villagers; then the idle-villager bell (red when there are idle villagers; its white number = idle villagers); then the age badge and the
age name (yellow). The game clock is white text at the top centre of the screen, outside the bar, possibly followed by the speed and
difficulty in parentheses. Read the digits exactly as printed; never guess a number you cannot read (use null).
If the image is not this HUD (menu, loading screen, desktop, another game), return {"hud": false}.`;

const FIND_SYSTEM = `You locate the top resource bar of Age of Empires II: Definitive Edition in a full screenshot (it may be downscaled).
The bar is a dark horizontal strip in a wooden frame at the very top-left, showing wood, food, gold, stone and population numbers with icons, then the
idle-villager bell and the age; the game clock is at the top centre of the screen, outside the strip.
Return ONLY JSON: {"found": true, "x": 0-1, "y": 0-1, "w": 0-1, "h": 0-1} with the box that encloses the whole strip AND the game clock,
as fractions of the image width/height, or {"found": false} if the game HUD is not visible.`;

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
    villagersTotal: int(j.villagersTotal, 300),
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
  const t = String(j.time || '').match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/);
  if (t && Number(t[3]) < 60 && (t[1] == null || Number(t[2]) < 60)) r.time = `${Number(t[2]) + (t[1] ? Number(t[1]) * 60 : 0)}:${t[3]}`;
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
 * Find the resource bar on a full screenshot without any model: the HUD is a dark strip glued to the top-left corner
 * with light text on it. Rows are "bar rows" while most pixels of the left half are dark; the bar's right edge is where
 * the dark run along those rows ends. Returns a region in screen fractions, or null.
 */
function findBarLocal({ width, height, data, bgra = false }) {
  const lum = (x, y) => {
    const p = (y * width + x) * 4;
    return bgra ? (data[p + 2] * 299 + data[p + 1] * 587 + data[p] * 114) / 1000 : (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  };
  const maxRows = Math.floor(height * 0.15);
  const half = Math.floor(width * 0.45);
  const darkRow = (y) => {
    let dark = 0,
      n = 0;
    for (let x = 4; x < half; x += 3) {
      n++;
      if (lum(x, y) < 70) dark++;
    }
    return dark / n;
  };
  // the resource boxes are a band of dark rows under the bar's wooden top edge (which is not dark); the band ends at
  // the bottom edge of the frame — a few non-dark rows — even when the map under it is still black fog
  let top = -1,
    bottom = -1,
    gap = 0;
  for (let y = 0; y < maxRows; y++) {
    if (darkRow(y) >= 0.5) {
      if (top < 0) top = y;
      bottom = y;
      gap = 0;
    } else if (top >= 0 && ++gap > 3) {
      if (bottom - top >= 8) break; // past the band
      top = bottom = -1; // a dark line at the very top (screen edge) is not the band
    }
  }
  if (top < 0 || bottom - top < 8) return null;
  // right edge: along the band's rows, the first long run of columns that are not dark any more
  const rows = [];
  for (let y = top + 2; y < bottom - 1; y += Math.max(1, Math.floor((bottom - top) / 6))) rows.push(y);
  let right = half;
  let bright = 0;
  for (let x = half; x < width; x += 2) {
    const dark = rows.filter((y) => lum(x, y) < 70).length / rows.length;
    if (dark < 0.4) {
      bright++;
      if (bright >= 12) break; // ~24 px of non-bar → the bar ended before this run
    } else {
      bright = 0;
      right = x;
    }
  }
  // the clock sits at the top centre of the screen, outside the bar: the region always reaches past the middle
  const w = Math.max(0.6, Math.min(0.7, ((right + 8) / width) * 1.12));
  return { x: 0, y: 0, w, h: Math.min(1, (bottom + 6) / height) };
}

/**
 * @param {object} o
 * @param o.electron { desktopCapturer, screen, systemPreferences } (injected so the module can be unit-tested without Electron)
 * @param o.getSettings full settings with the real keys
 * @param o.providerArgs (settings) → { provider, apiKey, model, baseUrl, strictTransport } for the vision call
 * @param o.localOcr ocr/local.js reader (createLocalOcr) or null when Tesseract is not available
 * @param o.engine (settings) → 'local' | 'ai' (which reader the automatic loop uses)
 * @param o.enabled () → boolean: whether the automatic loop may read right now
 * @param o.getDisplay () → Electron display to capture (the one the overlay is on)
 * @param o.onReading (reading) → void, for every accepted automatic or manual reading
 * @param o.saveRegion (region) → void, after a successful calibration
 */
function createScreenReader({
  electron,
  getSettings,
  providerArgs,
  localOcr = null,
  engine = () => 'local',
  enabled,
  getDisplay,
  onReading = () => {},
  saveRegion = () => {},
  log = () => {},
}) {
  const { desktopCapturer, screen, systemPreferences } = electron;
  const st = { timer: null, busy: false, lastAt: 0, lastSig: null, notHud: 0, last: null, lastError: null, reads: 0, cost: 0 };
  const jpeg = (image, rect) =>
    image
      .resize({ width: Math.min(900, rect.width) })
      .toJPEG(70)
      .toString('base64');
  const bitmapOf = (image) => {
    const size = image.getSize();
    return { width: size.width, height: size.height, data: image.toBitmap(), bgra: true };
  };

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

  /** Read one crop with the chosen engine → { reading | null, raw, cost }. reading.hud === false when it is not the bar. */
  async function readCrop(image, which) {
    if (which === 'ai') {
      const r = await askVision(READ_SYSTEM, 'Read this HUD crop.', image.toPNG());
      const reading = parseReading(r.text);
      if (reading && reading.hud) reading.engine = 'ai';
      return { reading, raw: r.text, cost: r.cost || null };
    }
    if (!localOcr) throw Object.assign(new Error('local OCR not available'), { code: 'no-local-ocr' });
    const reading = await localOcr.read(bitmapOf(image));
    return {
      reading,
      raw: reading && reading.debug ? reading.debug.words.map((w) => w.text || '?').join(' ') : '',
      cost: null,
      debug: reading && reading.debug,
    };
  }

  /** One reading now. { manual } readings ignore the change detector and the back-off and return the crop for the UI. */
  async function readOnce({ manual = false, engine: forced = null } = {}) {
    const perm = macPermissionError();
    if (perm) throw Object.assign(new Error('screen recording permission'), { code: perm });
    const which = forced || engine(getSettings()) || 'local';
    const full = await capture();
    const { image, rect } = crop(full, region());
    const sig = signature(image);
    if (!manual && !changed(sig, st.lastSig)) {
      st.lastAt = Date.now();
      return { ok: true, unchanged: true, reading: st.last };
    }
    st.lastSig = sig;
    const r = await readCrop(image, which);
    st.reads++;
    st.lastAt = Date.now();
    const reading = r.reading;
    if (!reading || reading.hud === false) {
      st.notHud = Math.min(st.notHud + 1, BACKOFF.length - 1);
      st.lastError = 'not-hud';
      return {
        ok: false,
        notHud: true,
        engine: which,
        crop: manual ? jpeg(image, rect) : null,
        cropSize: image.getSize(),
        raw: r.raw,
        debug: manual ? r.debug : undefined,
        rect,
      };
    }
    st.notHud = 0;
    st.lastError = null;
    reading.at = Date.now();
    reading.cost = r.cost;
    const { debug, ...clean } = reading;
    st.last = clean;
    onReading(clean);
    return {
      ok: true,
      reading: clean,
      engine: which,
      crop: manual ? jpeg(image, rect) : null,
      cropSize: image.getSize(),
      debug: manual ? debug : undefined,
      rect,
    };
  }

  /** Verify a candidate region by reading it; on success save it and return the reading. */
  async function adopt(full, reg, which) {
    const { image, rect } = crop(full, reg);
    const r = await readCrop(image, which);
    const reading = r.reading;
    if (!reading || reading.hud === false)
      return { ok: false, notFound: true, raw: r.raw, rect, crop: jpeg(image, rect), cropSize: image.getSize(), debug: r.debug };
    saveRegion(reg);
    st.lastSig = null;
    reading.at = Date.now();
    const { debug, ...clean } = reading;
    st.last = clean;
    onReading(clean);
    return { ok: true, region: reg, rect, reading: clean, engine: which, crop: jpeg(image, rect), cropSize: image.getSize(), debug };
  }

  /**
   * Find the bar on a full screenshot and save the region. Local first (the dark strip at the top-left), the vision
   * model when that fails and the engine is 'ai' (or forced). Either way the region is only kept when a reading works.
   */
  async function calibrate({ engine: forced = null } = {}) {
    const perm = macPermissionError();
    if (perm) throw Object.assign(new Error('screen recording permission'), { code: perm });
    const which = forced || engine(getSettings()) || 'local';
    const full = await capture();
    const pad = 0.004;
    const clamp = (box) => {
      const reg = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), w: Math.min(1, box.w + 2 * pad), h: Math.min(1, box.h + 3 * pad) };
      if (reg.x + reg.w > 1) reg.w = 1 - reg.x;
      if (reg.y + reg.h > 1) reg.h = 1 - reg.y;
      return reg;
    };
    let last = null;
    const guess = findBarLocal(bitmapOf(full));
    if (guess) {
      last = await adopt(full, clamp(guess), which);
      if (last.ok) return { ...last, how: 'local' };
    }
    if (which === 'ai') {
      const s = full.getSize();
      const small = s.width > 1400 ? full.resize({ width: 1400, quality: 'best' }) : full;
      const r = await askVision(FIND_SYSTEM, 'Locate the resource bar in this screenshot.', small.toPNG());
      const box = parseBox(r.text);
      if (!box) return { ok: false, notFound: true, raw: r.text };
      last = await adopt(full, clamp(box), which);
      if (last.ok) return { ...last, how: 'ai' };
    }
    return last || { ok: false, notFound: true };
  }

  /** Manual calibration: the player marked the bar on a screenshot (fractions) → verify, save. */
  async function calibrateManual(box) {
    const b = box && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(box[k])) ? box : null;
    if (!b || b.w <= 0.02 || b.h <= 0.005) return { ok: false, notFound: true };
    const full = await capture();
    const reg = { x: Math.max(0, b.x), y: Math.max(0, b.y), w: Math.min(1 - Math.max(0, b.x), b.w), h: Math.min(1 - Math.max(0, b.y), b.h) };
    const r = await adopt(full, reg, engine(getSettings()) || 'local');
    if (!r.ok) saveRegion(reg); // keep what the player marked even if this frame did not read (menu open, game paused…)
    return { ...r, region: reg, how: 'manual' };
  }

  /** The whole screen, small, for the manual calibration picker. */
  async function snapshot() {
    const perm = macPermissionError();
    if (perm) throw Object.assign(new Error('screen recording permission'), { code: perm });
    const full = await capture();
    const s = full.getSize();
    const small = full.resize({ width: Math.min(1280, s.width), quality: 'good' });
    return { ok: true, jpeg: small.toJPEG(72).toString('base64'), width: s.width, height: s.height, region: region() };
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
    calibrateManual,
    snapshot,
    /** forget the change detector so the next tick reads again (settings toggled, window shown) */
    poke() {
      st.lastSig = null;
      st.notHud = 0;
      st.lastAt = 0;
    },
    status() {
      const fresh = st.last && Date.now() - st.last.at < STALE_MS ? st.last : null;
      return {
        last: fresh,
        lastError: st.lastError,
        reads: st.reads,
        cost: +st.cost.toFixed(4),
        region: region(),
        engine: engine(getSettings()) || 'local',
        localReady: !!(localOcr && localOcr.ready()),
      };
    },
  };
}

module.exports = { createScreenReader, parseReading, parseBox, findBarLocal, DEFAULT_REGION, STALE_MS };
