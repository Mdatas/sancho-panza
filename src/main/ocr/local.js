'use strict';
/**
 * Local HUD reader (no AI, nothing leaves the PC): the bright text of the game's resource bar is segmented into words,
 * each word is read with Tesseract (digits only) and the numbers are mapped to the HUD fields by where they sit:
 *   [idle] [wood ▾villagers] [food ▾] [gold ▾] [stone ▾] [pop a/b] … [age] [clock m:ss]
 * Input: raw pixels of the calibrated crop (RGBA or BGRA). Output: the same reading shape as the vision model gives
 * (screenread.parseReading), plus a debug list of the words found so the Settings preview can show what was read.
 *
 * Tesseract.js runs in a worker thread of the Electron main process; the worker is created on first use and kept.
 * Everything here is pure Node so the test suite can run it on BMP fixtures.
 */
const { encodeBmp } = require('./bmp');

const TARGET_H = 44; // glyph height Tesseract reads best at (px), words are rescaled to it
const MAX_WORDS = 18;
const AGE_WORDS = [
  [1, /dark|oscur|escur|dunkl|sombre|ténèbr|tenebr/i],
  [2, /feudal|feodal|lehn|féodal/i],
  [3, /castle|castill|castel|burg|château|chateau/i],
  [4, /imperial|kaiser|impérial/i],
];

/* ------------------------------------------------------------------ pixels */
/**
 * Luminance + "is light, unsaturated text" mask. HUD numbers are white / light grey (small villager counts have thin,
 * anti-aliased strokes that never reach pure white; the idle count may be yellowish); the icons are coloured. The
 * threshold adapts to the bar's background: dark strip → anything clearly lighter than it counts.
 */
function maskOf({ width, height, data, bgra = false }, { bright = null } = {}) {
  const gray = new Uint8Array(width * height);
  const mx = new Uint8Array(width * height);
  const sat = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const r = bgra ? data[p + 2] : data[p];
    const g = data[p + 1];
    const b = bgra ? data[p] : data[p + 2];
    gray[i] = (r * 299 + g * 587 + b * 114) / 1000;
    const hi = Math.max(r, g, b),
      lo = Math.min(r, g, b);
    mx[i] = hi;
    sat[i] = hi - lo;
  }
  // background level: median luminance of the left 60 % of the crop (the bar itself), text sits well above it
  const sample = [];
  for (let y = 0; y < height; y += 2) for (let x = 0; x < Math.floor(width * 0.6); x += 3) sample.push(gray[y * width + x]);
  sample.sort((a, b) => a - b);
  const bg = sample.length ? sample[Math.floor(sample.length / 2)] : 0;
  const thr = bright != null ? bright : Math.max(100, Math.min(170, bg + 75));
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) if (mx[i] >= thr && sat[i] <= Math.max(40, mx[i] * 0.55)) mask[i] = 1;
  return { gray, mask, bg, thr };
}

/** 4-connected components of the mask → boxes { x0, y0, x1, y1, n } (x1/y1 exclusive). */
function components(mask, width, height, { minPx = 2 } = {}) {
  const seen = new Uint8Array(width * height);
  const out = [];
  const stack = [];
  for (let start = 0; start < width * height; start++) {
    if (!mask[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let x0 = width,
      y0 = height,
      x1 = -1,
      y1 = -1,
      n = 0;
    while (stack.length) {
      const i = stack.pop();
      const x = i % width,
        y = (i - x) / width;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) ((seen[i - 1] = 1), stack.push(i - 1));
      if (x < width - 1 && mask[i + 1] && !seen[i + 1]) ((seen[i + 1] = 1), stack.push(i + 1));
      if (y > 0 && mask[i - width] && !seen[i - width]) ((seen[i - width] = 1), stack.push(i - width));
      if (y < height - 1 && mask[i + width] && !seen[i + width]) ((seen[i + width] = 1), stack.push(i + width));
    }
    if (n >= minPx) out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, n });
  }
  return out;
}

/**
 * A stockpile digit glued to the villager count under it (anti-aliasing bridges them at some HUD scales) is one tall
 * component: split such components at their emptiest row so both numbers survive.
 */
function splitStacked(comps, mask, width, H) {
  const out = [];
  for (const c of comps) {
    const h = c.y1 - c.y0;
    if (h <= H * 1.4) {
      out.push(c);
      continue;
    }
    let bestY = -1,
      bestInk = Infinity;
    for (let y = c.y0 + Math.floor(h * 0.3); y < c.y0 + Math.ceil(h * 0.8); y++) {
      let ink = 0;
      for (let x = c.x0; x < c.x1; x++) ink += mask[y * width + x];
      if (ink < bestInk) {
        bestInk = ink;
        bestY = y;
      }
    }
    if (bestY < 0 || bestInk > (c.x1 - c.x0) * 0.15) {
      out.push(c);
      continue;
    }
    const box = (y0, y1) => {
      let x0 = c.x1,
        x1 = c.x0,
        n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = c.x0; x < c.x1; x++)
          if (mask[y * width + x]) {
            n++;
            if (x < x0) x0 = x;
            if (x + 1 > x1) x1 = x + 1;
          }
      return n ? { x0, y0, x1, y1, n } : null;
    };
    const top = box(c.y0, bestY),
      bottom = box(bestY + 1, c.y1);
    // only a stockpile (≈ the dominant height) with a smaller number under it; anything else (icon frames, art) stays whole
    const glyphLike = top && bottom && top.y1 - top.y0 <= H * 1.3 && top.y1 - top.y0 >= H * 0.7 && bottom.y1 - bottom.y0 <= (top.y1 - top.y0) * 0.8;
    if (glyphLike) out.push(top, bottom);
    else out.push(c);
  }
  return out;
}

/** Stroke thickness of a component (px): how many erosions until it vanishes. Text strokes are thin; icons have thick cores. */
function thickness(c, mask, width) {
  const w = c.x1 - c.x0,
    h = c.y1 - c.y0;
  let m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = mask[(c.y0 + y) * width + c.x0 + x];
  let k = 0;
  for (;;) {
    const next = new Uint8Array(w * h);
    let any = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w]) {
          next[i] = 1;
          any = 1;
        }
      }
    if (!any) break;
    m = next;
    k++;
    if (k > 64) break;
  }
  return 2 * k + 1;
}

/** Glyph boxes → word boxes: neighbours on the same line closer than ~half a glyph height belong together. */
function groupWords(comps, width, mask = null) {
  const heights = (cs) =>
    cs
      .filter((c) => c.n >= 12)
      .map((c) => c.y1 - c.y0)
      .sort((a, b) => a - b);
  let hs = heights(comps);
  let H = hs.length ? hs[Math.floor(hs.length / 2)] : 0; // dominant glyph height
  if (!H) return { words: [], H: 0 };
  if (mask) {
    comps = splitStacked(comps, mask, width, H);
    hs = heights(comps);
    H = hs[Math.floor(hs.length / 2)] || H;
  }
  const glyphs = comps
    .filter((c) => {
      const h = c.y1 - c.y0,
        w = c.x1 - c.x0;
      if (!(h >= Math.max(2, H * 0.12) && h <= H * 1.6 && w <= width * 0.25 && w <= H * 2.5)) return false;
      // an icon (disc, block, drawing) has thick solid parts; a (bold, upscaled) glyph is made of strokes no thicker than ~40 % of its height
      return !(mask && w >= H * 0.45 && h >= H * 0.45 && thickness(c, mask, width) > H * 0.6);
    })
    .sort((a, b) => a.x0 - b.x0);
  const words = [];
  for (const g of glyphs) {
    let home = null;
    for (const w of words) {
      const gap = g.x0 - w.x1;
      const gh = g.y1 - g.y0;
      const overlap = Math.min(g.y1, w.y1) - Math.max(g.y0, w.y0);
      const minH = Math.min(gh, w.h);
      // same line, close by, and of similar size (a small villager count never joins the big number next to it; colon dots may)
      const similar = Math.min(gh, w.h) / Math.max(gh, w.h) >= 0.6 || gh < H * 0.45;
      if (similar && gap <= Math.max(w.h, gh) * 0.55 && gap > -minH && overlap >= minH * 0.4) {
        home = w;
        break;
      }
    }
    if (home) {
      home.x0 = Math.min(home.x0, g.x0);
      home.x1 = Math.max(home.x1, g.x1);
      home.y0 = Math.min(home.y0, g.y0);
      home.y1 = Math.max(home.y1, g.y1);
      home.h = home.y1 - home.y0;
      home.glyphs.push(g);
    } else words.push({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, h: g.y1 - g.y0, glyphs: [g] });
  }
  // a word needs a real glyph in it (not just specks) and is kept left-to-right
  return { words: words.filter((w) => w.glyphs.some((g) => g.y1 - g.y0 >= H * 0.35)).sort((a, b) => a.x0 - b.x0), H };
}

/** One word → padded, rescaled (bilinear), inverted 24-bit BMP (dark text on white: what Tesseract likes). */
function wordImage(gray, width, height, w, pad = 2) {
  const x0 = Math.max(0, w.x0 - pad),
    y0 = Math.max(0, w.y0 - pad),
    x1 = Math.min(width, w.x1 + pad),
    y1 = Math.min(height, w.y1 + pad);
  const sw = x1 - x0,
    sh = y1 - y0;
  const scale = Math.max(1, TARGET_H / Math.max(1, w.h));
  const dw = Math.round(sw * scale),
    dh = Math.round(sh * scale);
  const margin = Math.round(TARGET_H * 0.4);
  const W = dw + 2 * margin,
    Hh = dh + 2 * margin;
  const out = new Uint8Array(W * Hh * 4).fill(255);
  // normalise the word's own contrast: its darkest pixels become the background, its brightest the full stroke
  // (small villager counts are thin, anti-aliased strokes that never reach white)
  let lo = 255,
    hi = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const v = gray[y * width + x];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  const span = Math.max(40, hi - lo);
  const norm = (v) => Math.max(0, Math.min(255, ((v - lo) / span) * 255));
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, y / scale);
    const iy = Math.floor(sy),
      fy = sy - iy,
      iy2 = Math.min(sh - 1, iy + 1);
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, x / scale);
      const ix = Math.floor(sx),
        fx = sx - ix,
        ix2 = Math.min(sw - 1, ix + 1);
      const g00 = gray[(y0 + iy) * width + x0 + ix],
        g10 = gray[(y0 + iy) * width + x0 + ix2],
        g01 = gray[(y0 + iy2) * width + x0 + ix],
        g11 = gray[(y0 + iy2) * width + x0 + ix2];
      const v = g00 * (1 - fx) * (1 - fy) + g10 * fx * (1 - fy) + g01 * (1 - fx) * fy + g11 * fx * fy;
      // invert (Tesseract likes dark text on white) after the per-word normalisation; a mild gamma thickens thin strokes
      const inv = 255 - Math.round(255 * Math.pow(norm(v) / 255, 0.7));
      const d = ((y + margin) * W + x + margin) * 4;
      out[d] = out[d + 1] = out[d + 2] = inv;
    }
  }
  return encodeBmp({ width: W, height: Hh, data: out });
}

/** Bilinear upscale of raw pixels (the reader likes glyphs ≥ 20 px; the app feeds it the 2× crop, tests feed 1× fixtures). */
function scalePx({ width, height, data, bgra = false }, k = 2) {
  const W = Math.round(width * k),
    H = Math.round(height * k);
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(height - 1, y / k),
      iy = Math.floor(sy),
      fy = sy - iy,
      iy2 = Math.min(height - 1, iy + 1);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(width - 1, x / k),
        ix = Math.floor(sx),
        fx = sx - ix,
        ix2 = Math.min(width - 1, ix + 1);
      const d = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = data[(iy * width + ix) * 4 + c],
          p10 = data[(iy * width + ix2) * 4 + c],
          p01 = data[(iy2 * width + ix) * 4 + c],
          p11 = data[(iy2 * width + ix2) * 4 + c];
        out[d + c] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
  }
  return { width: W, height: H, data: out, bgra };
}

/* ------------------------------------------------------------------ mapping */
const NUM = /^\d{1,6}$/,
  POP = /^\d{1,3}\/\d{1,3}$/,
  TIME = /^\d{1,3}:\d{2}$/;

/** Words (with their OCR text) → HUD reading by position. Exported for tests. */
function mapWords(words) {
  const numeric = words.filter((w) => NUM.test(w.text) || POP.test(w.text) || TIME.test(w.text));
  const pop = numeric.find((w) => POP.test(w.text));
  let time = numeric.find((w) => TIME.test(w.text));
  const left = numeric.filter((w) => NUM.test(w.text) && (!pop || w.x0 < pop.x0));
  if (!left.length) return { hud: false };
  // the stockpile font height = the median of the numbers' heights (a stockpile glued to the villager count below it is taller, a lone digit is not shorter)
  const hs = left.map((w) => w.h).sort((a, b) => a - b);
  const H = hs[Math.floor(hs.length / 2)];
  const big = left.filter((w) => w.h >= H * 0.72);
  const small = left.filter((w) => w.h < H * 0.72);
  // the stockpiles are the big numbers before the population: 4 = wood food gold stone, 5 = idle + those four
  let idle = null;
  let stock = big;
  if (big.length >= 5) {
    idle = Number(big[0].text);
    stock = big.slice(1, 5);
  } else if (big.length === 4) stock = big;
  else if (big.length === 3 && small.length === 0)
    stock = big; // one number lost: partial, low confidence
  else return { hud: false, partial: true };
  const keys = ['wood', 'food', 'gold', 'stone'];
  const r = {
    hud: true,
    food: null,
    wood: null,
    gold: null,
    stone: null,
    idle,
    villagers: null,
    pop: null,
    age: 0,
    time: null,
    confidence: stock.length === 4 ? 0.8 : 0.5,
  };
  stock.forEach((w, i) => (r[keys[i]] = Number(w.text)));
  // small numbers: idle count left of the first stockpile; villagers under/next to the stockpile whose panel they fall in
  if (small.length) {
    const v = { food: null, wood: null, gold: null, stone: null };
    for (const s of small) {
      const cx = (s.x0 + s.x1) / 2;
      if (cx < stock[0].x0 - stock[0].h) {
        if (idle == null) idle = Number(s.text);
        continue;
      }
      let k = -1;
      for (let i = 0; i < stock.length; i++)
        if (cx >= stock[i].x0 - stock[i].h * 1.5 && (i === stock.length - 1 || cx < stock[i + 1].x0 - stock[i + 1].h * 1.5)) k = i;
      if (k >= 0) v[keys[k]] = Number(s.text);
    }
    if (Object.values(v).some((x) => x != null)) r.villagers = v;
    r.idle = idle;
  }
  if (pop) {
    const [a, b] = pop.text.split('/').map(Number);
    if (a <= 600 && b <= 600) r.pop = `${a}/${b}`;
  }
  // a clock whose colon was missed reads as 3-4 digits at the far right ("1230"), or as two numbers ("12" "30")
  if (!time && pop) {
    const tail = numeric.filter((w) => NUM.test(w.text) && w.x0 > pop.x1);
    const last = tail[tail.length - 1],
      prev = tail[tail.length - 2];
    if (last && /^\d{3,4}$/.test(last.text) && Number(last.text.slice(-2)) < 60) time = { text: `${Number(last.text.slice(0, -2))}:${last.text.slice(-2)}` };
    else if (last && prev && /^\d{2}$/.test(last.text) && Number(last.text) < 60 && /^\d{1,3}$/.test(prev.text) && last.x0 - prev.x1 < last.h * 1.5)
      time = { text: `${Number(prev.text)}:${last.text}` };
  }
  if (time) r.time = time.text.replace(/^0+(\d)/, '$1');
  for (const w of words) {
    const m = w.text && AGE_WORDS.find(([, re]) => re.test(w.text));
    if (m && (!pop || w.x0 > pop.x1)) r.age = m[0];
  }
  return r;
}

/* ------------------------------------------------------------------ the reader */
function createLocalOcr({ tesseract = null, langPath, cachePath, log = () => {} } = {}) {
  let worker = null;
  let loading = null;
  const lib = () => tesseract || require('tesseract.js');
  async function getWorker() {
    if (worker) return worker;
    if (!loading)
      loading = (async () => {
        const { createWorker } = lib();
        const w = await createWorker('eng', 1, { langPath, cachePath, gzip: false, cacheMethod: cachePath ? 'write' : 'none', logger: () => {} });
        worker = w;
        return w;
      })().catch((e) => {
        loading = null;
        throw e;
      });
    return loading;
  }
  async function ocrWord(w, img, letters, single = false) {
    const { PSM } = lib();
    await w.setParameters({
      tessedit_pageseg_mode: single ? PSM.SINGLE_CHAR : PSM.SINGLE_WORD,
      tessedit_char_whitelist: letters ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzáéíóúÁÉÍÓÚäöüÄÖÜ' : '0123456789/:',
    });
    const { data } = await w.recognize(img);
    return { text: String(data.text || '').replace(/\s+/g, ''), conf: data.confidence };
  }
  /**
   * @param px { width, height, data, bgra } raw pixels of the HUD crop (any scale; words are rescaled)
   * @returns reading (screenread shape) with debug.words = [{ x0, y0, x1, y1, h, text, conf }]
   */
  async function read(px, opts = {}) {
    const t0 = Date.now();
    const { gray, mask, bg, thr } = maskOf(px, opts);
    const comps = components(mask, px.width, px.height);
    const { words, H } = groupWords(comps, px.width, mask);
    const w = await getWorker();
    const out = [];
    let lettersLeft = 3;
    for (const word of words.slice(0, MAX_WORDS)) {
      const img = wordImage(gray, px.width, px.height, word);
      let { text, conf } = await ocrWord(w, img, false);
      if (!text && word.glyphs.length === 1) ({ text, conf } = await ocrWord(w, img, false, true)); // a lone digit: single-character mode
      if (!(NUM.test(text) || POP.test(text) || TIME.test(text)) && lettersLeft > 0 && word.glyphs.length >= 3) {
        // not a number: maybe the age name ("Feudal Age") — one letters pass, a few times at most
        lettersLeft--;
        const r = await ocrWord(w, img, true);
        if (r.text && /^[A-Za-zÁÉÍÓÚáéíóúäöüÄÖÜ]{3,}$/.test(r.text)) {
          text = r.text;
          conf = r.conf;
        }
      }
      out.push({ x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1, h: word.h, text, conf: Math.round(conf || 0) });
    }
    const reading = mapWords(out);
    reading.engine = 'local';
    reading.debug = { words: out, glyphHeight: H, ms: Date.now() - t0, components: comps.length, bg, thr };
    return reading;
  }
  async function terminate() {
    const w = worker;
    worker = null;
    loading = null;
    if (w) await w.terminate().catch(() => {});
  }
  return { read, terminate, ready: () => !!worker };
}

module.exports = { createLocalOcr, mapWords, maskOf, components, groupWords, scalePx, TARGET_H };
