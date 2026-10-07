import { describe, expect, test } from 'bun:test';
import { basename, join } from 'node:path';
import type { Entry } from '../src/archive.ts';
import { writeArchive } from '../src/archive.ts';
import { sha256 } from '../src/bins.ts';
import { assetName, parseSums } from '../src/release.ts';
import { downloadRelease } from '../src/update/download.ts';
import { FailedError, type GitHubReleases, type UpdateFs } from '../src/update/types.ts';
import type { Target } from '../src/version.ts';

const BIN = '/t/bin';
const TAG = 'v0.8.0';
const enc = new TextEncoder();
const dec = new TextDecoder();
// Another asset's line, as a real SHA256SUMS has: never read.
const OTHER_LINE = `${'0123456789abcdef'.repeat(4)}  telinha-linux-arm64.tar.gz\n`; // gitleaks:allow

function memFs() {
  const files = new Map<string, Uint8Array>();
  const n = (p: string) => p.replace(/\\/g, '/');
  const fs: UpdateFs = {
    async readdir(dir) {
      const d = `${n(dir)}/`;
      return [...files.keys()].filter((k) => k.startsWith(d)).map((k) => k.slice(d.length));
    },
    async rename(from, to) {
      const e = files.get(n(from));
      if (!e) throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
      files.delete(n(from));
      files.set(n(to), e);
    },
    async rm(p) {
      files.delete(n(p));
    },
    async stat(p) {
      const e = files.get(n(p));
      return e ? { size: e.length, mtimeMs: 1 } : null;
    },
    async readText(p) {
      const e = files.get(n(p));
      return e ? dec.decode(e) : null;
    },
    async writeText(p, text) {
      files.set(n(p), enc.encode(text));
    },
    async readBytes(p) {
      const e = files.get(n(p));
      if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return e;
    },
    async writeBytes(p, data) {
      files.set(n(p), data);
    },
    async mkdir() {},
    async openWrite(p) {
      const chunks: Uint8Array[] = [];
      return {
        write: async (c) => void chunks.push(c),
        close: async () => void files.set(n(p), Buffer.concat(chunks)),
      };
    },
  };
  const text = (p: string) => {
    const e = files.get(n(p));
    return e ? dec.decode(e) : null;
  };
  const names = () => [...files.keys()].map((k) => basename(k)).sort();
  return { fs, files, text, names };
}

/** One release of one target: its archive and a SHA256SUMS that matches it. */
function github(target: Target, members: Record<string, string>): GitHubReleases {
  const asset = assetName(target);
  const entries: Entry[] = Object.entries(members).map(([path, content]) => ({
    path,
    mode: 0o755,
    data: enc.encode(content),
  }));
  const bytes = writeArchive(target, entries);
  return {
    latestTag: async () => TAG,
    assetUrl: (tag, name) => `https://example.test/${tag}/${name}`,
    sums: async () => parseSums(`${OTHER_LINE}${sha256(bytes)}  ${asset}\n`),
    asset: async (_tag, name) => (name === asset ? new Response(bytes) : new Response('Not Found', { status: 404 })),
  };
}

const download = (m: ReturnType<typeof memFs>, target: Target, members: Record<string, string>) =>
  downloadRelease({ github: github(target, members), fs: m.fs, bin: BIN, tag: TAG, target });

describe('downloadRelease', () => {
  test('Windows: the tray in the archive lands as telinha-tray.new.exe next to telinha.new.exe', async () => {
    const m = memFs();
    const r = await download(m, 'windows-x64', { 'telinha.exe': 'telinha v0.8.0', 'telinha-tray.exe': 'tray v0.8.0' });
    expect(r).toEqual({ exe: join(BIN, 'telinha.new.exe'), tray: join(BIN, 'telinha-tray.new.exe') });
    expect(m.text(r.exe)).toBe('telinha v0.8.0');
    expect(m.text(r.tray!)).toBe('tray v0.8.0');
    // The streamed archive is gone; only the two staged files stay.
    expect(m.names()).toEqual(['telinha-tray.new.exe', 'telinha.new.exe']);
  });

  test('Windows: a release without the tray is fine (tray null) and a stale staged tray is dropped', async () => {
    const m = memFs();
    await m.fs.writeBytes(join(BIN, 'telinha-tray.new.exe'), enc.encode('stale tray'));
    const r = await download(m, 'windows-arm64', { 'telinha.exe': 'telinha v0.8.0' });
    expect(r).toEqual({ exe: join(BIN, 'telinha.new.exe'), tray: null });
    expect(m.names()).toEqual(['telinha.new.exe']);
  });

  test('Windows: two tray entries is a bad archive', async () => {
    const m = memFs();
    const p = download(m, 'windows-x64', { 'telinha.exe': 'x', 'telinha-tray.exe': 'a', 'sub/telinha-tray.exe': 'b' });
    await expect(p).rejects.toBeInstanceOf(FailedError);
    await expect(p).rejects.toThrow('2 entries named telinha-tray.exe');
  });

  test('Linux never looks for the tray, whatever the archive holds', async () => {
    const m = memFs();
    const r = await download(m, 'linux-x64', {
      telinha: 'telinha v0.8.0',
      'telinha-tray.exe': 'tray',
      'x/telinha-tray.exe': 'tray',
    });
    expect(r).toEqual({ exe: join(BIN, 'telinha.new'), tray: null });
    expect(m.names()).toEqual(['telinha.new']);
  });
});
