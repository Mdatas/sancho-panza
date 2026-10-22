'use strict';
/**
 * Minimal uncompressed BMP (24-bit) encoder/decoder. Tesseract.js takes BMP buffers in Node, which keeps the local OCR
 * free of image libraries: Electron hands us raw BGRA bitmaps (nativeImage.toBitmap) and tests read BMP fixtures.
 */

/** Raw pixels → 24-bit BMP buffer. px = { width, height, data } where data is RGBA or BGRA (set bgra) rows top to bottom. */
function encodeBmp({ width, height, data, bgra = false }) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const imgSize = rowSize * height;
  const buf = Buffer.alloc(54 + imgSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(54 + imgSize, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive height = rows stored bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(imgSize, 34);
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = dst + x * 3;
      if (bgra) {
        buf[d] = data[s];
        buf[d + 1] = data[s + 1];
        buf[d + 2] = data[s + 2];
      } else {
        buf[d] = data[s + 2];
        buf[d + 1] = data[s + 1];
        buf[d + 2] = data[s];
      }
    }
  }
  return buf;
}

/** 24/32-bit uncompressed BMP buffer → { width, height, data: RGBA }. */
function decodeBmp(buf) {
  if (buf.toString('ascii', 0, 2) !== 'BM') throw new Error('not a BMP');
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const h = buf.readInt32LE(22);
  const height = Math.abs(h);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (compression !== 0 || (bpp !== 24 && bpp !== 32)) throw new Error(`unsupported BMP (bpp ${bpp}, compression ${compression})`);
  const bytes = bpp / 8;
  const rowSize = Math.ceil((width * bytes) / 4) * 4;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcRow = h > 0 ? height - 1 - y : y;
    const src = offset + srcRow * rowSize;
    for (let x = 0; x < width; x++) {
      const s = src + x * bytes;
      const d = (y * width + x) * 4;
      data[d] = buf[s + 2];
      data[d + 1] = buf[s + 1];
      data[d + 2] = buf[s];
      data[d + 3] = 255;
    }
  }
  return { width, height, data };
}

module.exports = { encodeBmp, decodeBmp };
