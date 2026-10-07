// tar.gz and zip in plain TypeScript: reading upstream releases (livekit, caddy,
// our own binaries) and writing our release archives. No tar/unzip spawn, so it
// behaves the same in the Alpine image, on Windows and inside the compiled binary.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';
import { archiveType } from './release.ts';

export interface Entry { path: string; mode: number; data: Uint8Array }

// 2000-01-01T00:00:00Z: archives built from the same files are byte-identical.
const FIXED_MTIME = 946684800;
const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- tar

function cstr(buf: Uint8Array, off: number, len: number): string {
  const end = buf.subarray(off, off + len).indexOf(0);
  return dec.decode(buf.subarray(off, end < 0 ? off + len : off + end));
}

function octal(buf: Uint8Array, off: number, len: number): number {
  // GNU base-256 for values that do not fit the octal field.
  if (buf[off]! & 0x80) {
    let n = buf[off]! & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + buf[off + i]!;
    return n;
  }
  const s = cstr(buf, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  // Records are "<len> <key>=<value>\n" with len counted in bytes.
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(dec.decode(data.subarray(i, sp)));
    if (!Number.isInteger(len) || len <= 0) break;
    const rec = dec.decode(data.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Regular files of a gzip'd tar (ustar, pax and GNU long names); directories and links are skipped. */
export function readTarGz(data: Uint8Array): Entry[] {
  const tar = new Uint8Array(gunzipSync(data));
  const out: Entry[] = [];
  let off = 0;
  let longName: string | null = null;
  let pax: Record<string, string> = {};
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const stored = octal(h, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== stored) throw new Error(`tar: bad header checksum at offset ${off}`);
    const type = String.fromCharCode(h[156]!);
    let size = octal(h, 124, 12);
    if (pax.size) size = Number(pax.size);
    const body = off + BLOCK;
    if (body + size > tar.length) throw new Error('tar: truncated archive');
    const content = tar.subarray(body, body + size);
    off = body + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') {
      longName = cstr(content, 0, content.length);
      continue;
    }
    if (type === 'x') {
      pax = parsePax(content);
      continue;
    }
    if (type === 'g') continue;
    const prefix = dec.decode(h.subarray(257, 263)).startsWith('ustar') ? cstr(h, 345, 155) : '';
    const name = cstr(h, 0, 100);
    const path = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    pax = {};
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    out.push({ path, mode: octal(h, 100, 8) & 0o7777, data: content.slice() });
  }
  return out;
}

function putStr(h: Uint8Array, off: number, len: number, s: string) {
  h.set(enc.encode(s).subarray(0, len), off);
}

function putOctal(h: Uint8Array, off: number, len: number, n: number) {
  putStr(h, off, len, `${n.toString(8).padStart(len - 1, '0')}\0`);
}

function tarHeader(name: string, size: number, mode: number, type: string): Uint8Array {
  const h = new Uint8Array(BLOCK);
  putStr(h, 0, 100, name);
  putOctal(h, 100, 8, mode & 0o7777);
  putOctal(h, 108, 8, 0);
  putOctal(h, 116, 8, 0);
  putOctal(h, 124, 12, size);
  putOctal(h, 136, 12, FIXED_MTIME);
  h.fill(0x20, 148, 156);
  putStr(h, 156, 1, type);
  putStr(h, 257, 6, 'ustar\0');
  putStr(h, 263, 2, '00');
  let sum = 0;
  for (const b of h) sum += b;
  putStr(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

function padded(data: Uint8Array): Uint8Array[] {
  const rest = data.length % BLOCK;
  return rest ? [data, new Uint8Array(BLOCK - rest)] : [data];
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Deterministic gzip'd ustar: fixed mtime, uid/gid 0, modes from the entries; long paths via pax. */
export function writeTarGz(entries: Entry[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    if (enc.encode(e.path).length > 100) {
      const rec = ` path=${e.path}\n`;
      // The length prefix counts its own digits: iterate until it is stable.
      const base = enc.encode(rec).length;
      let len = base + 1;
      while (base + String(len).length !== len) len = base + String(len).length;
      const body = enc.encode(`${len}${rec}`);
      parts.push(tarHeader('PaxHeader', body.length, 0o644, 'x'), ...padded(body));
    }
    parts.push(tarHeader(e.path, e.data.length, e.mode, '0'), ...padded(e.data));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const gz = new Uint8Array(gzipSync(concat(parts), { level: 9 }));
  // The OS byte depends on the platform zlib was built for: "unknown" keeps it stable.
  gz[9] = 255;
  return gz;
}

// ---------------------------------------------------------------- zip

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
// DOS date for 2000-01-01, time 00:00.
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

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
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Regular files of a zip (store and deflate); directories and symlinks are skipped. */
export function readZip(data: Uint8Array): Entry[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  // The end record sits in the last 22 bytes plus an optional comment of up to 64 KB.
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === END_SIG) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('zip: no end of central directory');
  const count = v.getUint16(end + 10, true);
  let off = v.getUint32(end + 16, true);
  if (count === 0xffff || off === 0xffffffff) throw new Error('zip: zip64 is not supported');
  const out: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(off, true) !== CENTRAL_SIG) throw new Error('zip: bad central directory');
    const madeBy = v.getUint16(off + 4, true) >> 8;
    const flags = v.getUint16(off + 8, true);
    const method = v.getUint16(off + 10, true);
    const crc = v.getUint32(off + 16, true);
    const csize = v.getUint32(off + 20, true);
    const usize = v.getUint32(off + 24, true);
    const nameLen = v.getUint16(off + 28, true);
    const extraLen = v.getUint16(off + 30, true);
    const commentLen = v.getUint16(off + 32, true);
    const attrs = v.getUint32(off + 38, true);
    const local = v.getUint32(off + 42, true);
    const path = dec.decode(data.subarray(off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;

    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new Error('zip: zip64 is not supported');
    const unixMode = madeBy === 3 ? attrs >>> 16 : 0;
    const kind = unixMode & 0o170000;
    if (path.endsWith('/') || (kind !== 0 && kind !== 0o100000)) continue;
    if (flags & 1) throw new Error(`zip: ${path} is encrypted`);
    if (v.getUint32(local, true) !== LOCAL_SIG) throw new Error(`zip: bad local header for ${path}`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = data.subarray(start, start + csize);
    let content: Uint8Array;
    if (method === 0) content = raw.slice();
    else if (method === 8) content = new Uint8Array(inflateRawSync(raw));
    else throw new Error(`zip: ${path} uses unsupported method ${method}`);
    if (content.length !== usize || crc32(content) !== crc) throw new Error(`zip: ${path} is corrupt (size or crc mismatch)`);
    out.push({ path, mode: unixMode & 0o7777 || 0o644, data: content });
  }
  return out;
}

/** Deterministic zip: deflate (store when that is smaller), fixed timestamps, unix modes in the external attributes. */
export function writeZip(entries: Entry[]): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const deflated = new Uint8Array(deflateRawSync(e.data, { level: 9 }));
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const crc = crc32(e.data);
    // Bit 11: the name is UTF-8.
    const flags = /^[\x20-\x7e]*$/.test(e.path) ? 0 : 0x0800;

    const lh = new Uint8Array(30 + name.length);
    const l = new DataView(lh.buffer);
    l.setUint32(0, LOCAL_SIG, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, flags, true);
    l.setUint16(8, stored ? 0 : 8, true);
    l.setUint16(10, 0, true);
    l.setUint16(12, DOS_DATE, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, e.data.length, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    lh.set(name, 30);

    const ch = new Uint8Array(46 + name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, CENTRAL_SIG, true);
    // Made by unix (3), so readers honour the mode in the high attribute bits.
    c.setUint16(4, (3 << 8) | 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, flags, true);
    c.setUint16(10, stored ? 0 : 8, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, DOS_DATE, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(38, ((0o100000 | (e.mode & 0o7777)) << 16) >>> 0, true);
    c.setUint32(42, offset, true);
    ch.set(name, 46);

    locals.push(lh, body);
    centrals.push(ch);
    offset += lh.length + body.length;
  }
  const cdSize = centrals.reduce((n, p) => n + p.length, 0);
  const eocd = new Uint8Array(22);
  const d = new DataView(eocd.buffer);
  d.setUint32(0, END_SIG, true);
  d.setUint16(8, entries.length, true);
  d.setUint16(10, entries.length, true);
  d.setUint32(12, cdSize, true);
  d.setUint32(16, offset, true);
  return concat([...locals, ...centrals, eocd]);
}

// ---------------------------------------------------------------- extract

/** Archive path -> safe relative segments; throws on absolute paths and `..` (zip-slip). */
export function safeSegments(path: string): string[] {
  const p = path.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new Error(`archive entry ${path} is an absolute path`);
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.includes('..')) throw new Error(`archive entry ${path} escapes the target directory`);
  return segs;
}

/**
 * Writes the (picked) entries under `dir` and returns the written paths. Every
 * path is checked before anything is written, so a hostile archive leaves no
 * partial output. Modes: 0755 when any execute bit is set, else 0644.
 */
export async function extractTo(entries: Entry[], dir: string, pick?: (path: string) => boolean): Promise<string[]> {
  const chosen = entries
    .filter((e) => !pick || pick(e.path))
    .map((e) => ({ e, segs: safeSegments(e.path) }))
    .filter((x) => x.segs.length > 0);
  const written: string[] = [];
  for (const { e, segs } of chosen) {
    const file = join(dir, ...segs);
    const mode = e.mode & 0o111 ? 0o755 : 0o644;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, e.data, { mode });
    // writeFile's mode only applies to new files and goes through the umask.
    if (process.platform !== 'win32') await chmod(file, mode);
    written.push(file);
  }
  return written;
}

/** A target's release archive, zip or tar.gz as its asset name says. */
export const writeArchive = (t: Parameters<typeof archiveType>[0], entries: Entry[]): Uint8Array =>
  (archiveType(t) === 'zip' ? writeZip(entries) : writeTarGz(entries));
