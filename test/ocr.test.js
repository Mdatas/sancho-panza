'use strict';
/** Local screen reader: BMP codec, text segmentation + Tesseract on synthetic HUD fixtures, field mapping, the local bar finder. No network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { encodeBmp, decodeBmp } = require('../src/main/ocr/bmp');
const { createLocalOcr, mapWords, scalePx } = require('../src/main/ocr/local');
const { findBarLocal } = require('../src/main/screenread');

const fixture = (n) => decodeBmp(fs.readFileSync(path.join(__dirname, 'fixtures', n)));

// --- BMP round trip
{
  const px = { width: 3, height: 2, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]) };
  const back = decodeBmp(encodeBmp(px));
  assert.deepStrictEqual([back.width, back.height], [3, 2]);
  assert.deepStrictEqual([...back.data.slice(0, 12)], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
  assert.deepStrictEqual([...back.data.slice(12, 16)], [10, 20, 30, 255]);
}

// --- field mapping from word boxes (independent of Tesseract)
{
  const w = (text, x0, h = 30) => ({ text, x0, x1: x0 + text.length * 14, y0: 0, y1: h, h });
  let r = mapWords([
    w('310', 100),
    w('9', 110, 14),
    w('1204', 300),
    w('12', 310, 14),
    w('120', 500),
    w('4', 510, 14),
    w('200', 700),
    w('0', 710, 14),
    w('34/40', 900),
    w('Feudal', 1100),
    w('12:30', 1300),
  ]);
  assert.deepStrictEqual([r.hud, r.wood, r.food, r.gold, r.stone, r.pop, r.time, r.age, r.idle], [true, 310, 1204, 120, 200, '34/40', '12:30', 2, null]);
  assert.deepStrictEqual(r.villagers, { food: 12, wood: 9, gold: 4, stone: 0 });
  // five big numbers before the population: the first is the idle count; a clock whose colon was missed still reads
  r = mapWords([w('3', 20), w('310', 100), w('1204', 300), w('120', 500), w('200', 700), w('34/40', 900), w('1230', 1300)]);
  assert.deepStrictEqual([r.idle, r.wood, r.stone, r.time], [3, 310, 200, '12:30']);
  assert.strictEqual(mapWords([w('34/40', 900)]).hud, false, 'no stockpiles → not a HUD');
  assert.strictEqual(mapWords([w('12', 100), w('7', 300)]).hud, false, 'two numbers are not the bar');
}

(async () => {
  const ocr = createLocalOcr({ langPath: path.join(__dirname, '..', 'data', 'ocr'), cachePath: null });
  try {
    // 1080p synthetic bar, fed at 2× like the app does → every field
    const t0 = Date.now();
    let r = await ocr.read(scalePx(fixture('hud-synthetic-1080p.bmp'), 2));
    const ms1 = Date.now() - t0;
    assert.strictEqual(r.hud, true, JSON.stringify(r.debug && r.debug.words.map((x) => x.text)));
    assert.deepStrictEqual([r.wood, r.food, r.gold, r.stone, r.pop, r.time, r.age, r.idle], [310, 1204, 120, 200, '34/40', '12:30', 2, 2]);
    assert.deepStrictEqual(r.villagers, { food: 12, wood: 9, gold: 4, stone: 0 });
    assert.strictEqual(r.engine, 'local');
    assert.ok(r.debug.words.length >= 10 && r.debug.ms >= 0);
    // smaller HUD (864p-like): the stockpiles, population, age and clock still read; tiny villager counts may be missed
    r = await ocr.read(scalePx(fixture('hud-synthetic-864p.bmp'), 2));
    assert.deepStrictEqual([r.hud, r.wood, r.food, r.gold, r.stone, r.pop, r.time, r.age], [true, 310, 1204, 120, 200, '34/40', '12:30', 2]);
    // warm reads are fast
    const t1 = Date.now();
    await ocr.read(scalePx(fixture('hud-synthetic-1080p.bmp'), 2));
    const ms2 = Date.now() - t1;
    assert.ok(ms2 < 4000, 'warm read took ' + ms2 + ' ms');
    // a crop with no HUD (flat colour + noise) is reported as not the bar
    const blank = { width: 600, height: 60, data: new Uint8Array(600 * 60 * 4) };
    for (let i = 0; i < blank.data.length; i += 4) {
      const v = 40 + ((i / 4) % 7) * 3;
      blank.data[i] = v;
      blank.data[i + 1] = v + 20;
      blank.data[i + 2] = v;
      blank.data[i + 3] = 255;
    }
    r = await ocr.read(blank);
    assert.strictEqual(r.hud, false);
    // the local bar finder on a synthetic full screen: the fixture pasted top-left on grass
    const bar = fixture('hud-synthetic-1080p.bmp');
    const W = 1920,
      H = 1080;
    const screen = { width: W, height: H, data: new Uint8Array(W * H * 4) };
    for (let i = 0; i < screen.data.length; i += 4) {
      screen.data[i] = 62;
      screen.data[i + 1] = 84;
      screen.data[i + 2] = 46;
      screen.data[i + 3] = 255;
    }
    for (let y = 0; y < bar.height; y++)
      for (let x = 0; x < bar.width; x++) for (let c = 0; c < 4; c++) screen.data[(y * W + x) * 4 + c] = bar.data[(y * bar.width + x) * 4 + c];
    const reg = findBarLocal(screen);
    assert.ok(reg && reg.x === 0 && reg.y === 0 && reg.w > 0.5 && reg.w < 0.7 && reg.h > 0.03 && reg.h < 0.06, JSON.stringify(reg));
    assert.strictEqual(findBarLocal({ width: 200, height: 100, data: new Uint8Array(200 * 100 * 4).fill(120) }), null, 'no dark strip → nothing found');
    console.log(`ocr tests passed (first read ${ms1} ms, warm ${ms2} ms)`);
  } finally {
    await ocr.terminate();
  }
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
