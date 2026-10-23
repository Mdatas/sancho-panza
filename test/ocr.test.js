'use strict';
/** Local screen reader: BMP codec, text segmentation + Tesseract on real Definitive Edition HUD crops, field mapping, the local bar finder. No network. */
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

// --- field mapping from word boxes (independent of Tesseract): the Definitive Edition bar
{
  // words as the segmentation produces them: cls 1 = white, 2 = yellow (villager counts, age name), 3 = cyan (total villagers)
  const w = (text, x0, y0 = 60, h = 31, cls = 1) => ({ text, x0, x1: x0 + text.length * 22, y0, y1: y0 + h, h, cls });
  const bar = [
    w('0', 99, 89, 30, 2),
    w('200', 140),
    w('0', 366, 89, 30, 2),
    w('200', 408),
    w('0', 632, 89, 30, 2),
    w('100', 674),
    w('7', 899, 89, 30, 2),
    w('150', 942),
    w('3', 1168, 89, 28, 3),
    w('4/5', 1214),
    w('2', 1454),
    w('DarkAg', 1823, 58, 45, 2),
    w('00:12:30', 2269, 25, 38),
    w('17', 2488, 24, 39),
  ];
  let r = mapWords(bar, 31);
  assert.deepStrictEqual(
    [r.hud, r.wood, r.food, r.gold, r.stone, r.pop, r.time, r.age, r.idle, r.villagersTotal],
    [true, 200, 200, 100, 150, '4/5', '12:30', 1, 2, 3]
  );
  assert.deepStrictEqual(r.villagers, { food: 0, wood: 0, gold: 0, stone: 7 });
  // hours fold into the minutes; a clock whose colons were missed still reads; icon crumbs left of the bar are ignored
  r = mapWords([w('1', 20), ...bar.filter((x) => !x.text.includes(':')), w('010230', 2269, 25, 38)], 31);
  assert.deepStrictEqual([r.wood, r.stone, r.time, r.idle], [200, 150, '62:30', 2]);
  // without colour classes (older layouts, the vision model's words): the top row of full-size numbers are the stockpiles,
  // the lower row the villager counts
  const plain = bar.map((x) => ({ ...x, cls: undefined }));
  r = mapWords(plain, 31);
  assert.deepStrictEqual([r.wood, r.food, r.gold, r.stone, r.pop, r.idle], [200, 200, 100, 150, '4/5', 2]);
  assert.deepStrictEqual(r.villagers, { food: 0, wood: 0, gold: 0, stone: 7 });
  assert.strictEqual(mapWords([w('34/40', 900)]).hud, false, 'no stockpiles → not a HUD');
  assert.strictEqual(mapWords([w('12', 100), w('7', 300)]).hud, false, 'two numbers are not the bar');
}

// Packaging guard: the desktop package ships only the Tesseract cores the Node worker actually loads. tesseract.js 7's Node
// adapter picks the core from the `lstmOnly` boolean it receives (so it takes the full SIMD cores, not the "-lstm" ones);
// run the real picker with the same argument createWorker sends and make sure electron-builder does not exclude that file.
(async () => {
  const Module = require('module');
  const asked = [];
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    if (/^tesseract\.js-core\//.test(req)) asked.push(req.replace(/^tesseract\.js-core\//, ''));
    return origLoad.call(this, req, ...rest);
  };
  try {
    const getCore = require('tesseract.js/src/worker-script/node/getCore');
    await getCore(true, undefined, { progress() {} }); // createWorker('eng', 1) → load payload { lstmOnly: true }
  } finally {
    Module._load = origLoad;
  }
  assert.strictEqual(asked.length, 1, 'core picker required ' + JSON.stringify(asked));
  const excluded = require('../package.json').build.files.filter((f) => f.startsWith('!node_modules/tesseract.js-core/'));
  for (const ext of ['.js', '.wasm']) {
    const file = `!node_modules/tesseract.js-core/${asked[0]}${ext}`;
    assert.ok(!excluded.includes(file), `${file} is excluded from the package but the worker loads it`);
  }
  console.log('ocr packaging guard: worker loads', asked[0]);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});

(async () => {
  const ocr = createLocalOcr({ langPath: path.join(__dirname, '..', 'data', 'ocr'), cachePath: null });
  try {
    // the real Definitive Edition bar (2560×1600 capture, default region), fed at 2× like the app does → every field
    const expect = (r, label) => {
      assert.strictEqual(r.hud, true, label + ' ' + JSON.stringify(r.debug && r.debug.words.map((x) => x.text)));
      assert.deepStrictEqual(
        [r.wood, r.food, r.gold, r.stone, r.pop, r.time, r.age, r.idle, r.villagersTotal],
        [200, 200, 100, 200, '4/5', '0:06', 1, 3, 3],
        label
      );
      assert.deepStrictEqual(r.villagers, { food: 0, wood: 0, gold: 0, stone: 0 }, label);
      assert.strictEqual(r.engine, 'local');
    };
    const t0 = Date.now();
    let r = await ocr.read(scalePx(fixture('hud-de-2560x1600.bmp'), 2));
    const ms1 = Date.now() - t0;
    expect(r, '2560x1600');
    assert.ok(r.debug.words.length >= 12 && r.debug.ms >= 0);
    // the same screen captured at 1080p (smaller glyphs)
    r = await ocr.read(scalePx(fixture('hud-de-1920x1080.bmp'), 2));
    expect(r, '1920x1080');
    // warm reads are fast
    const t1 = Date.now();
    await ocr.read(scalePx(fixture('hud-de-2560x1600.bmp'), 2));
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
    // the local bar finder on a full screen: the real crop pasted top-left on black fog (game start) and on grass
    const bar = fixture('hud-de-2560x1600.bmp');
    const W = 2560,
      H = 1600;
    for (const [bg, label] of [
      [[0, 0, 0], 'black fog'],
      [[62, 84, 46], 'grass'],
    ]) {
      const screen = { width: W, height: H, data: new Uint8Array(W * H * 4) };
      for (let i = 0; i < screen.data.length; i += 4) {
        screen.data[i] = bg[0];
        screen.data[i + 1] = bg[1];
        screen.data[i + 2] = bg[2];
        screen.data[i + 3] = 255;
      }
      for (let y = 0; y < bar.height; y++)
        for (let x = 0; x < bar.width; x++) for (let c = 0; c < 4; c++) screen.data[(y * W + x) * 4 + c] = bar.data[(y * bar.width + x) * 4 + c];
      const reg = findBarLocal(screen);
      assert.ok(reg && reg.x === 0 && reg.y === 0 && reg.w >= 0.6 && reg.w <= 0.7 && reg.h > 0.03 && reg.h < 0.06, label + ' ' + JSON.stringify(reg));
      // the region it found reads the whole bar, clock included
      const crop = { width: Math.round(W * reg.w), height: Math.round(H * reg.h), data: null };
      crop.data = new Uint8Array(crop.width * crop.height * 4);
      for (let y = 0; y < crop.height; y++) crop.data.set(screen.data.subarray(y * W * 4, (y * W + crop.width) * 4), y * crop.width * 4);
      expect(await ocr.read(scalePx(crop, 2)), 'found region on ' + label);
    }
    assert.strictEqual(findBarLocal({ width: 200, height: 100, data: new Uint8Array(200 * 100 * 4).fill(120) }), null, 'no dark strip → nothing found');
    console.log(`ocr tests passed (first read ${ms1} ms, warm ${ms2} ms)`);
  } finally {
    await ocr.terminate();
  }
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
