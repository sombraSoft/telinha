import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeArchive } from '../src/archive.ts';
import { sha256 } from '../src/bins.ts';
import {
  ASIDE_RE,
  archiveContents,
  archiveFiles,
  asideBase,
  assetName,
  caddyAssetName,
  caddyExeName,
  exeName,
  formatSums,
  isStableTag,
  latestReleaseTag,
  newExeName,
  parseSums,
  releaseAssetUrl,
  SUMS,
  TRAY_DIST,
  tagFromRedirect,
} from '../src/release.ts';
import { downloadRelease } from '../src/update/download.ts';
import type { GitHubReleases, UpdateFs } from '../src/update/types.ts';
import { TARGETS } from '../src/version.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

type Call = { url: string; redirect: RequestInit['redirect'] };
function fakeFetch(respond: (url: string) => Response | Error) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, redirect: init?.redirect });
    const r = respond(url);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

describe('release tags', () => {
  test('a release tag with - is a prerelease', () => {
    expect(isStableTag('v0.8.0')).toBe(true);
    expect(isStableTag('v0.8.0-rc.1')).toBe(false);
  });

  test('tagFromRedirect reads the release tag out of Location, decoded', () => {
    expect(tagFromRedirect(redirect('https://github.com/sombraSoft/telinha/releases/tag/v0.8.0'))).toBe('v0.8.0');
    expect(tagFromRedirect(redirect('/sombraSoft/telinha/releases/tag/v0.8.0-rc.1?x=1'))).toBe('v0.8.0-rc.1');
    expect(tagFromRedirect(redirect('https://github.com/sombraSoft/telinha/releases/tag/v0.8.0%2Bbuild'))).toBe(
      'v0.8.0+build',
    );
    expect(tagFromRedirect(new Response('page', { status: 200 }))).toBeNull();
    expect(tagFromRedirect(new Response('', { status: 404 }))).toBeNull();
    expect(tagFromRedirect(redirect('https://github.com/sombraSoft/telinha/releases'))).toBeNull();
  });

  test('releaseAssetUrl: encoded release tag, other repos', () => {
    expect(releaseAssetUrl('v0.6.0', SUMS)).toBe(
      'https://github.com/sombraSoft/telinha/releases/download/v0.6.0/SHA256SUMS',
    );
    expect(releaseAssetUrl('v1+b', 'x', 'me/fork')).toBe('https://github.com/me/fork/releases/download/v1%2Bb/x');
  });

  test('latestReleaseTag: the redirect target; offline or no release -> null', async () => {
    const f = fakeFetch(() => redirect('https://github.com/me/fork/releases/tag/v2.0.0'));
    expect(await latestReleaseTag(f.fetch, 'me/fork')).toBe('v2.0.0');
    expect(f.calls).toEqual([{ url: 'https://github.com/me/fork/releases/latest', redirect: 'manual' }]);
    expect(await latestReleaseTag(fakeFetch(() => new Error('ENOTFOUND')).fetch)).toBeNull();
    expect(await latestReleaseTag(fakeFetch(() => new Response('', { status: 404 })).fetch)).toBeNull();
  });
});

describe('release layout', () => {
  // Published names: changing any of these breaks every install that fetches them.
  test('asset names and archive contents per target', () => {
    expect(TARGETS.map((t) => [assetName(t), caddyAssetName(t), archiveContents(t)])).toEqual([
      ['telinha-linux-x64.tar.gz', 'caddy-linux-x64.tar.gz', { exe: 'telinha', tray: null, license: 'LICENSE' }],
      ['telinha-linux-arm64.tar.gz', 'caddy-linux-arm64.tar.gz', { exe: 'telinha', tray: null, license: 'LICENSE' }],
      [
        'telinha-windows-x64.zip',
        'caddy-windows-x64.zip',
        { exe: 'telinha.exe', tray: 'telinha-tray.exe', license: 'LICENSE' },
      ],
      [
        'telinha-windows-arm64.zip',
        'caddy-windows-arm64.zip',
        { exe: 'telinha.exe', tray: 'telinha-tray.exe', license: 'LICENSE' },
      ],
    ]);
    expect([caddyExeName('linux'), caddyExeName('windows-arm64')]).toEqual(['caddy', 'caddy.exe']);
  });

  test('bin folder names take a target, an OS or a Node platform', () => {
    expect([exeName('win32'), exeName('windows'), exeName('windows-x64')]).toEqual([
      'telinha.exe',
      'telinha.exe',
      'telinha.exe',
    ]);
    expect([exeName('linux'), exeName('linux-arm64')]).toEqual(['telinha', 'telinha']);
    expect([newExeName('win32'), newExeName('linux-x64')]).toEqual(['telinha.new.exe', 'telinha.new']);
    expect(asideBase('telinha', 'old', '0.7.0')).toBe('telinha.old-0.7.0');
    expect(asideBase('telinha-tray', 'failed', 'v0.8.0')).toBe('telinha-tray.failed-v0.8.0');
    for (const stem of ['telinha', 'telinha-tray'] as const) {
      for (const kind of ['old', 'failed'] as const)
        expect(ASIDE_RE.test(`${asideBase(stem, kind, 'x')}.exe`)).toBe(true);
    }
    expect(ASIDE_RE.test(TRAY_DIST)).toBe(false);
    expect(ASIDE_RE.test(newExeName('win32'))).toBe(false);
  });
});

/** Just enough of UpdateFs for downloadRelease. */
function memFs(): { fs: UpdateFs; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const fs = {
    async mkdir() {},
    async rm(p: string) {
      files.delete(p);
    },
    async readBytes(p: string) {
      return files.get(p)!;
    },
    async writeBytes(p: string, data: Uint8Array) {
      files.set(p, data);
    },
    async openWrite(p: string) {
      const chunks: Uint8Array[] = [];
      return {
        write: async (c: Uint8Array) => void chunks.push(c),
        close: async () => void files.set(p, Buffer.concat(chunks)),
      };
    },
  } as unknown as UpdateFs;
  return { fs, files };
}

describe('pack, then the fetcher finds its files', () => {
  for (const t of TARGETS) {
    test(t, async () => {
      // The packer's own layout and archive writer, the updater's own reader.
      const entries = archiveFiles(t, { exe: 'exe', tray: 'tray', license: 'license' }).map((f) => ({
        path: f.path,
        mode: f.mode,
        data: enc.encode(`${t} ${f.source}`),
      }));
      const bytes = writeArchive(t, entries);
      const github: GitHubReleases = {
        latestTag: async () => 'v0.8.0',
        assetUrl: (tag, name) => `https://example.test/${tag}/${name}`,
        sums: async () => parseSums(formatSums({ [assetName(t)]: sha256(bytes) })),
        asset: async (_tag, name) =>
          name === assetName(t) ? new Response(bytes) : new Response('Not Found', { status: 404 }),
      };
      const m = memFs();
      const got = await downloadRelease({ github, fs: m.fs, bin: '/bin', tag: 'v0.8.0', target: t });
      expect(got.exe).toBe(join('/bin', newExeName(t)));
      expect(dec.decode(m.files.get(got.exe))).toBe(`${t} exe`);
      if (archiveContents(t).tray) expect(dec.decode(m.files.get(got.tray!))).toBe(`${t} tray`);
      else expect(got.tray).toBeNull();
    });
  }
});

describe('write sums, then every reader parses them', () => {
  const hex = (c: string) => c.repeat(64);
  const sums = {
    'telinha-windows-x64.zip': hex('b'),
    'caddy-linux-x64.tar.gz': hex('c'),
    'telinha-linux-x64.tar.gz': hex('a'),
  };
  const text = formatSums(sums);

  test('sha256sum format, sorted by name; parseSums reads it back', () => {
    expect(text).toBe(
      `${hex('c')}  caddy-linux-x64.tar.gz\n${hex('a')}  telinha-linux-x64.tar.gz\n${hex('b')}  telinha-windows-x64.zip\n`,
    );
    expect(parseSums(text)).toEqual(sums);
  });

  test('parseSums: binary marker, CRLF, upper case; anything else is skipped', () => {
    const lines = [
      `${hex('A')} *telinha-windows-x64.zip`,
      'not a sum line',
      `${'a'.repeat(128)}  sha512.zip`,
      `${'a'.repeat(63)}  short.zip`,
      '',
      `${hex('d')}  with space.zip`,
    ];
    expect(parseSums(lines.join('\r\n'))).toEqual({ 'telinha-windows-x64.zip': hex('a'), 'with space.zip': hex('d') });
  });
});
