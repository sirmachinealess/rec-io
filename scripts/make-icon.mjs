// Draws build/icon.png (256x256): a red rounded square with a white waveform.
// electron-builder converts it to the Windows .ico.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
const px = Buffer.alloc(SIZE * SIZE * 4);

// Signed distance to a rounded rectangle, for anti-aliased edges.
function roundedRectDist(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const coverage = (d) => Math.max(0, Math.min(1, 0.5 - d));

const BARS = [0.28, 0.55, 0.85, 0.6, 0.35]; // waveform heights as a fraction of the tile
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const tile = coverage(roundedRectDist(x + 0.5, y + 0.5, 128, 128, 120, 120, 52));
    // Vertical gradient from coral to deep red.
    const t = y / SIZE;
    let r = 236 - 40 * t, g = 92 - 40 * t, b = 84 - 34 * t;
    let bar = 0;
    BARS.forEach((h, i) => {
      const cx = 128 + (i - 2) * 36;
      bar = Math.max(bar, coverage(roundedRectDist(x + 0.5, y + 0.5, cx, 128, 11, (h * 176) / 2, 11)));
    });
    r += (255 - r) * bar; g += (255 - g) * bar; b += (255 - b) * bar;
    const o = (y * SIZE + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = Math.round(255 * tile);
  }
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`wrote ${OUT}`);
