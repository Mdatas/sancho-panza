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
const MAX_WORDS = 24;
const AGE_WORDS = [
  [1, /dark|oscur|escur|dunkl|sombre|ténèbr|tenebr/i],
  [2, /feudal|feodal|lehn|féodal/i],
  [3, /castle|castill|castel|burg|château|chateau/i],
  [4, /imperial|kaiser|impérial/i],
];

/* ------------------------------------------------------------------ pixels */
/**
 * "Is HUD text" mask. In the game's bar (Definitive Edition, default UI) the stockpiles, the population, the idle count
 * and the clock are bold white with a dark outline; the villager counts under the icons and the age name are yellow
 * (255,214,0); the total villager count under the population icon is cyan (127,255,255). Everything else — the wooden
 * frame (brown/beige, saturated), the resource icons (coloured or thick), the red idle bell, the age badge — is kept out
 * by colour: white/grey must be unsaturated, yellow must have no blue, cyan no red. The brightness threshold adapts to
 * the background (a dark strip wants ~160; a lighter one, more) so the outlined glyphs come out as clean components.
 */
function maskOf({ width, height, data, bgra = false }, { bright = null } = {}) {
  const gray = new Uint8Array(width * height);
  const mask = new Uint8Array(width * height);
  const R = new Uint8Array(width * height),
    G = new Uint8Array(width * height),
    B = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    R[i] = bgra ? data[p + 2] : data[p];
    G[i] = data[p + 1];
    B[i] = bgra ? data[p] : data[p + 2];
    gray[i] = (R[i] * 299 + G[i] * 587 + B[i] * 114) / 1000;
  }
  // background level: median luminance of the left 60 % of the crop (the bar itself); text sits far above it
  const sample = [];
  for (let y = 0; y < height; y += 2) for (let x = 0; x < Math.floor(width * 0.6); x += 3) sample.push(gray[y * width + x]);
  sample.sort((a, b) => a - b);
  const bg = sample.length ? sample[Math.floor(sample.length / 2)] : 0;
  const thr = bright != null ? bright : Math.max(160, Math.min(200, bg + 128));
  // soft: the same test with a lower bar, graded 0..255 up to the real threshold — the thin arcs of a small glyph
  // are anti-aliased below it and would leave cracks in the glyph image Tesseract reads (mask pixels are 255)
  const soft = new Uint8Array(width * height);
  const low = thr - 60;
  for (let i = 0; i < width * height; i++) {
    const r = R[i],
      g = G[i],
      b = B[i];
    const hi = Math.max(r, g, b),
      lo = Math.min(r, g, b);
    if (hi < low) continue;
    let cls = 0;
    if (hi - lo <= 40)
      cls = WHITE; // white / light grey
    else if (r >= low && g >= r * 0.72 && b <= r * 0.3)
      cls = YELLOW; // yellow text (villager counts, age name)
    else if (g >= low && b >= g * 0.9 && r <= g * 0.6) cls = CYAN; // cyan (total villagers)
    if (!cls) continue;
    if (hi >= thr) {
      mask[i] = cls;
      soft[i] = 255;
    } else soft[i] = Math.round((255 * (hi - low)) / (thr - low));
  }
  return { gray, mask, soft, bg, thr };
}
const WHITE = 1,
  YELLOW = 2,
  CYAN = 3; // mask values: the text colour class of the pixel (0 = not text)

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
    const tally = [0, 0, 0, 0];
    while (stack.length) {
      const i = stack.pop();
      const x = i % width,
        y = (i - x) / width;
      n++;
      tally[mask[i]]++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) ((seen[i - 1] = 1), stack.push(i - 1));
      if (x < width - 1 && mask[i + 1] && !seen[i + 1]) ((seen[i + 1] = 1), stack.push(i + 1));
      if (y > 0 && mask[i - width] && !seen[i - width]) ((seen[i - width] = 1), stack.push(i - width));
      if (y < height - 1 && mask[i + width] && !seen[i + width]) ((seen[i + width] = 1), stack.push(i + width));
    }
    if (n >= minPx) out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, n, cls: tally.indexOf(Math.max(tally[1], tally[2], tally[3])) });
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
      for (let x = c.x0; x < c.x1; x++) ink += mask[y * width + x] ? 1 : 0;
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
      return n ? { x0, y0, x1, y1, n, cls: c.cls } : null;
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

/**
 * Dominant glyph height: the most populated height cluster (±20 %) among digit-shaped components (not wider than
 * they are tall, not specks). The bar's stockpile digits are the biggest such group; frame texture and icon crumbs are
 * many but tiny or wide, so a plain median would land on them.
 */
function glyphHeight(comps) {
  const hs = comps.filter((c) => c.n >= 12 && c.y1 - c.y0 >= 5 && c.x1 - c.x0 <= (c.y1 - c.y0) * 1.3).map((c) => c.y1 - c.y0);
  let best = 0,
    bestN = 0;
  for (const h0 of new Set(hs)) {
    const members = hs.filter((h) => Math.abs(h - h0) <= h0 * 0.2);
    if (members.length > bestN || (members.length === bestN && h0 > best)) {
      bestN = members.length;
      members.sort((a, b) => a - b);
      best = members[Math.floor(members.length / 2)];
    }
  }
  return bestN >= 3 ? best : 0;
}

/** Glyph boxes → word boxes: neighbours on the same line closer than ~half a glyph height belong together. */
function groupWords(comps, width, mask = null) {
  let H = glyphHeight(comps);
  if (!H) return { words: [], H: 0 };
  if (mask) {
    comps = splitStacked(comps, mask, width, H);
    H = glyphHeight(comps) || H;
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
  // a word needs a real glyph in it (icon crumbs and frame specks are all small) and carries its colour class
  const kept = words.filter((w) => w.glyphs.some((g) => g.y1 - g.y0 >= H * 0.6)).sort((a, b) => a.x0 - b.x0);
  for (const w of kept) {
    const tally = [0, 0, 0, 0];
    for (const g of w.glyphs) tally[g.cls || 0] += g.n;
    w.cls = tally.indexOf(Math.max(tally[1], tally[2], tally[3]));
  }
  return { words: kept, H };
}

/**
 * One word → padded, rescaled (bilinear), inverted 24-bit BMP (dark text on white: what Tesseract likes). The source is
 * the text mask, not the grey image: the HUD glyphs are outlined and may sit on wood (the clock) or on a red bell (the
 * idle count), and the mask already separates the glyph from all of that; the bilinear upscale smooths the edges.
 */
function wordImage(soft, width, height, w, pad = 2) {
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
  const ink = (i) => soft[i];
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
      const g00 = ink((y0 + iy) * width + x0 + ix),
        g10 = ink((y0 + iy) * width + x0 + ix2),
        g01 = ink((y0 + iy2) * width + x0 + ix),
        g11 = ink((y0 + iy2) * width + x0 + ix2);
      const v = g00 * (1 - fx) * (1 - fy) + g10 * fx * (1 - fy) + g01 * (1 - fx) * fy + g11 * fx * fy;
      const inv = 255 - Math.round(v); // invert: Tesseract likes dark text on white
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
  TIME = /^\d{1,2}:\d{2}(?::\d{2})?$/;

/** "h:mm:ss" / "mm:ss" / "m:ss" → "m:ss" with the hours folded into the minutes ("1:02:30" → "62:30"). */
function clockText(t) {
  const parts = t.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n)) || parts[parts.length - 1] >= 60) return null;
  if (parts.length === 3 && parts[1] >= 60) return null;
  const secs = parts[parts.length - 1];
  const mins = parts.length === 3 ? parts[0] * 60 + parts[1] : parts[0];
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Words (with their OCR text) → HUD reading by position. The Definitive Edition bar, left to right:
 *   [wood ▾villagers] [food ▾] [gold ▾] [stone ▾] [▾total pop a/b] [idle] [age badge + name] … clock (top centre)
 * The stockpiles, the population, the idle count and the clock are white; the villager counts are yellow, one under
 * each icon (left of and below the stockpile, same font size), the total villager count is cyan under the population
 * icon. Words carry that colour class (cls) from the segmentation; without it (older layouts, tests) the numbers on
 * the lower row of the bar are taken as the villager counts. H = the stockpile glyph height (from the segmentation);
 * without it, the tallest numbers' height is used. Exported for tests.
 */
function mapWords(words, H = 0) {
  const numeric = words.filter((w) => NUM.test(w.text) || POP.test(w.text) || TIME.test(w.text));
  const pop = numeric.find((w) => POP.test(w.text));
  let time = numeric.find((w) => TIME.test(w.text) && clockText(w.text));
  const left = numeric.filter((w) => NUM.test(w.text) && (!pop || w.x0 < pop.x0));
  if (!left.length) return { hud: false };
  if (!H) H = Math.max(...left.map((w) => w.h));
  const coloured = words.some((w) => w.cls);
  let big, small;
  if (coloured) {
    big = left.filter((w) => w.cls === WHITE && w.h >= H * 0.85);
    small = left.filter((w) => w.cls !== WHITE || w.h < H * 0.85);
  } else {
    // no colour: the stockpiles are the top row of full-size numbers; smaller numbers or a lower row are the counts
    const tall = left.filter((w) => w.h >= H * 0.85);
    const top = tall.length ? Math.min(...tall.map((w) => (w.y0 + w.y1) / 2)) : 0;
    big = tall.filter((w) => (w.y0 + w.y1) / 2 <= top + H * 0.5);
    small = left.filter((w) => !big.includes(w));
  }
  // the stockpiles are the last four big numbers before the population (anything further left is icon crumbs)
  let stock;
  if (big.length >= 4) stock = big.slice(-4);
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
    idle: null,
    villagers: null,
    villagersTotal: null,
    pop: null,
    age: 0,
    time: null,
    confidence: stock.length === 4 ? 0.8 : 0.5,
  };
  stock.forEach((w, i) => (r[keys[i]] = Number(w.text)));
  // small numbers: each stockpile owns the panel from ~2.4 glyph heights left of it to its own right edge; a small
  // number between the last stockpile and the population is the total villager count
  if (small.length) {
    const v = { food: null, wood: null, gold: null, stone: null };
    for (const s of small) {
      const cx = (s.x0 + s.x1) / 2;
      const k = stock.findIndex((w) => cx >= w.x0 - H * 2.4 && cx <= w.x1);
      if (k >= 0) v[keys[k]] = Number(s.text);
      else if (pop && cx > stock[3].x1 && cx < pop.x0 && s.text.length <= 3) r.villagersTotal = Number(s.text);
    }
    if (Object.values(v).some((x) => x != null)) r.villagers = v;
  }
  if (pop) {
    const [a, b] = pop.text.split('/').map(Number);
    if (a <= 600 && b <= 600) r.pop = `${a}/${b}`;
    // the idle count: the first big number right of the population (the red bell), before the age / clock
    const idle = numeric.find((w) => NUM.test(w.text) && w.x0 > pop.x1 && w.h >= H * 0.85 && w.text.length <= 3 && w.x0 - pop.x1 < H * 12);
    if (idle) r.idle = Number(idle.text);
    // a clock whose colons were missed reads as 3-6 digits at the far right ("1230", "001230"), or as two numbers ("12" "30")
    if (!time) {
      const tail = numeric.filter((w) => NUM.test(w.text) && w.x0 > pop.x1 && w !== idle);
      const last = tail[tail.length - 1],
        prev = tail[tail.length - 2];
      if (last && /^\d{3,6}$/.test(last.text)) {
        const d = last.text.padStart(6, '0');
        const t = clockText(`${d.slice(0, 2)}:${d.slice(2, 4)}:${d.slice(4)}`);
        if (t) time = { text: t };
      } else if (last && prev && /^\d{2}$/.test(last.text) && Number(last.text) < 60 && /^\d{1,3}$/.test(prev.text) && last.x0 - prev.x1 < last.h * 1.5)
        time = { text: `${Number(prev.text)}:${last.text}` };
    }
  }
  if (time) r.time = clockText(time.text);
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
  /** mode: 'line' (keeps the "/" of "4/5" and the colons of the clock), 'word' (reliable for a lone digit), 'char'. */
  async function ocrWord(w, img, letters, mode = 'line') {
    const { PSM } = lib();
    await w.setParameters({
      tessedit_pageseg_mode: mode === 'char' ? PSM.SINGLE_CHAR : mode === 'word' ? PSM.SINGLE_WORD : PSM.SINGLE_LINE,
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
    const { mask, soft, bg, thr } = maskOf(px, opts);
    const comps = components(mask, px.width, px.height);
    const { words, H } = groupWords(comps, px.width, mask);
    const w = await getWorker();
    const out = [];
    let lettersLeft = 3;
    for (const word of words.slice(0, MAX_WORDS)) {
      const img = wordImage(soft, px.width, px.height, word);
      const lone = word.glyphs.length === 1;
      let { text, conf } = await ocrWord(w, img, false, lone ? 'word' : 'line');
      if (!text) ({ text, conf } = await ocrWord(w, img, false, lone ? 'char' : 'word')); // second try in the next mode
      if (!(NUM.test(text) || POP.test(text) || TIME.test(text)) && lettersLeft > 0 && word.glyphs.length >= 3) {
        // not a number: maybe the age name ("Feudal Age") — one letters pass, a few times at most
        lettersLeft--;
        const r = await ocrWord(w, img, true);
        if (r.text && /^[A-Za-zÁÉÍÓÚáéíóúäöüÄÖÜ]{3,}$/.test(r.text)) {
          text = r.text;
          conf = r.conf;
        }
      }
      out.push({ x0: word.x0, y0: word.y0, x1: word.x1, y1: word.y1, h: word.h, cls: word.cls, text, conf: Math.round(conf || 0) });
    }
    const reading = mapWords(out, H);
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

module.exports = { createLocalOcr, mapWords, maskOf, components, groupWords, scalePx, wordImage, TARGET_H };
