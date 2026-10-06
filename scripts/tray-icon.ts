// Writes tray/telinha.ico from the favicon's geometry (docs/public/favicon.svg, a
// screen on a stand in a 32-unit box): screen and stand both in the page accent,
// on a transparent background, so the whole glyph reads on a light taskbar and a
// dark one alike (a white stand vanishes on the light one). Signed distances sampled 4x4
// per pixel keep the small sizes crisp. BMP entries for the sizes Windows asks a
// tray or Explorer for, one PNG entry at 256. Same input, same bytes.
//
//   bun scripts/tray-icon.ts
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const ROOT = resolve(import.meta.dir, '..');
export const OUT = resolve(ROOT, 'tray', 'telinha.ico');
export const BMP_SIZES = [16, 20, 24, 32, 40, 48, 64] as const;
export const PNG_SIZE = 256;

const ACCENT = [0x58, 0x65, 0xf2] as const;
const SUB = 4;
const STROKE = 2.5;

type Rgba = Uint8Array;

/** rect x=3 y=5 w=26 h=17 rx=2.5 */
function screenDistance(x: number, y: number): number {
  const r = 2.5;
  const qx = Math.abs(x - 16) - (13 - r);
  const qy = Math.abs(y - 13.5) - (8.5 - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** A round-capped line from (ax,ay) to (bx,by), the SVG stroke with stroke-linecap=round. */
function capsuleDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const px = x - ax;
  const py = y - ay;
  const dx = bx - ax;
  const dy = by - ay;
  const h = Math.min(1, Math.max(0, (px * dx + py * dy) / (dx * dx + dy * dy)));
  const ex = px - dx * h;
  const ey = py - dy * h;
  return Math.sqrt(ex * ex + ey * ey) - STROKE / 2;
}

/** M16 22v4 M10 27h12 */
function standDistance(x: number, y: number): number {
  return Math.min(capsuleDistance(x, y, 16, 22, 16, 26), capsuleDistance(x, y, 10, 27, 22, 27));
}

/** size x size pixels, RGBA (straight alpha), top row first. */
export function render(size: number): Rgba {
  const out = new Uint8Array(size * size * 4);
  const unit = 32 / size;
  // Each subsample antialiases over its own width.
  const aa = unit / SUB;
  const cover = (d: number) => Math.min(1, Math.max(0, 0.5 - d / aa));
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const x = (px + (sx + 0.5) / SUB) * unit;
          const y = (py + (sy + 0.5) / SUB) * unit;
          // One colour: the coverage of screen and stand together.
          const ca = cover(Math.min(screenDistance(x, y), standDistance(x, y)));
          r += ACCENT[0] * ca;
          g += ACCENT[1] * ca;
          b += ACCENT[2] * ca;
          a += ca;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.min(255, Math.round(r / a));
        out[i + 1] = Math.min(255, Math.round(g / a));
        out[i + 2] = Math.min(255, Math.round(b / a));
      }
      out[i + 3] = Math.round((a / (SUB * SUB)) * 255);
    }
  }
  return out;
}

/** BITMAPINFOHEADER + BGRA rows bottom-up + the 1-bit AND mask (set = transparent). */
export function bmpEntry(size: number, rgba: Rgba): Buffer {
  const xor = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = maskStride * size;
  const buf = Buffer.alloc(40 + xor + mask);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(size, 4);
  // Height counts the XOR and AND bitmaps together.
  buf.writeInt32LE(size * 2, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(0, 16);
  buf.writeUInt32LE(xor + mask, 20);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = 40 + (row * size + x) * 4;
      const alpha = rgba[s + 3]!;
      buf[d] = rgba[s + 2]!;
      buf[d + 1] = rgba[s + 1]!;
      buf[d + 2] = rgba[s]!;
      buf[d + 3] = alpha;
      if (alpha < 128) {
        const m = 40 + xor + row * maskStride + (x >> 3);
        buf[m] = buf[m]! | (0x80 >> (x & 7));
      }
    }
  }
  return buf;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

export function pngEntry(size: number, rgba: Rgba): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // compression, filter, interlace: 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    // Filter type 0 (none) per row.
    raw[y * (size * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** ICONDIR + one ICONDIRENTRY per image, images after the directory in the same order. */
export function buildIco(): Buffer {
  const images: { size: number; data: Buffer }[] = [
    ...BMP_SIZES.map((size) => ({ size, data: bmpEntry(size, render(size)) })),
    { size: PNG_SIZE, data: pngEntry(PNG_SIZE, render(PNG_SIZE)) },
  ];
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    // 0 means 256.
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir[e + 2] = 0;
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

if (import.meta.main) {
  const ico = buildIco();
  writeFileSync(OUT, ico);
  console.log(`wrote ${OUT} (${ico.length} bytes)`);
}
