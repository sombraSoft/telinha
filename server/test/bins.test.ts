import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../../scripts/versions.ts';
import { writeTarGz, writeZip } from '../src/archive.ts';
import {
  HELPERS, PLATFORMS, assetSpec, caddyRelease, download, ensureBinaries, ensureBinariesForConfig, isPinned, loadVersions, resolveCaddyRelease, sha256,
  type Versions,
} from '../src/bins.ts';
import { releaseAssetUrl } from '../src/release.ts';
import { version } from '../src/version.ts';

const enc = new TextEncoder();
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'telinha-bins-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const LATEST = 'https://github.com/sombraSoft/telinha/releases/latest';
const redirectTo = (tag: string) => new Response(null, { status: 302, headers: { location: `https://github.com/sombraSoft/telinha/releases/tag/${tag}` } });

// Fake upstream: every asset of every platform, as the real ones are packaged;
// caddy lives in a fake Telinha release `tag` with a SHA256SUMS listing it.
function fakeUpstream(ver = '1.0.0', tag = 'v9.9.9') {
  const assets = new Map<string, Uint8Array>();
  const versions: Versions = {
    livekit: { version: ver, sha256: {} },
    caddy: { version: '2.11.4', xcaddy: 'v0.4.7', modules: { 'github.com/caddy-dns/duckdns': 'v0.5.0' } },
    cloudflared: { version: ver, sha256: {} },
  };
  const sums: string[] = [];
  for (const helper of HELPERS) {
    const v = isPinned(helper) ? ver : tag;
    for (const p of PLATFORMS) {
      const [os, arch] = p.split('-') as ['linux' | 'windows', 'amd64' | 'arm64'];
      const spec = assetSpec(helper, v, os, arch);
      if (assets.has(spec.url)) continue;
      const exe = enc.encode(`${helper} ${spec.hashKey} ${v}`);
      const data = spec.archive === null ? exe
        : (spec.archive === 'zip' ? writeZip : writeTarGz)([
          { path: 'LICENSE', mode: 0o644, data: enc.encode('license') },
          { path: spec.member, mode: 0o755, data: exe },
        ]);
      assets.set(spec.url, data);
      if (isPinned(helper)) versions[helper].sha256[spec.hashKey] = sha256(data);
      else sums.push(`${sha256(data)}  ${spec.asset}`);
    }
  }
  assets.set(releaseAssetUrl(tag, 'SHA256SUMS'), enc.encode(`${sums.join('\n')}\n`));
  const requests: string[] = [];
  const fetch = async (url: string, _init?: RequestInit) => {
    requests.push(url);
    if (url === LATEST) return redirectTo(tag);
    const body = assets.get(url);
    return body ? new Response(body) : new Response('nope', { status: 404, statusText: 'Not Found' });
  };
  return { assets, versions, fetch, requests, tag, release: caddyRelease(tag, fetch) };
}

describe('assetSpec', () => {
  test('cloudflared on windows-arm64 is the x64 build', () => {
    const s = assetSpec('cloudflared', '2026.9.3', 'windows', 'arm64');
    expect(s.asset).toBe('cloudflared-windows-amd64.exe');
    expect(s.hashKey).toBe('windows-amd64');
    expect(s.verify).toBe('pinned');
  });

  test('livekit has native windows-arm64 builds, pinned', () => {
    expect(assetSpec('livekit', '1.13.7', 'windows', 'arm64')).toMatchObject({ asset: 'livekit_1.13.7_windows_arm64.zip', hashKey: 'windows-arm64', verify: 'pinned' });
  });

  test('caddy is the Telinha release asset, verified through the release sums', () => {
    expect(assetSpec('caddy', 'v0.6.0', 'windows', 'arm64')).toEqual({
      url: 'https://github.com/sombraSoft/telinha/releases/download/v0.6.0/caddy-windows-arm64.zip',
      asset: 'caddy-windows-arm64.zip',
      archive: 'zip',
      member: 'caddy.exe',
      hashKey: 'windows-arm64',
      verify: 'release-sums',
    });
    expect(assetSpec('caddy', 'v0.6.0', 'windows', 'amd64').asset).toBe('caddy-windows-x64.zip');
    expect(assetSpec('caddy', 'v0.6.0', 'linux', 'amd64')).toMatchObject({ asset: 'caddy-linux-x64.tar.gz', archive: 'tar.gz', member: 'caddy' });
    expect(assetSpec('caddy', 'v0.6.0', 'linux', 'arm64').asset).toBe('caddy-linux-arm64.tar.gz');
  });

  test('the bundled versions.json has a hash for every pinned asset', () => {
    const v = loadVersions();
    for (const helper of HELPERS) {
      if (!isPinned(helper)) continue;
      for (const p of PLATFORMS) {
        const [os, arch] = p.split('-') as ['linux' | 'windows', 'amd64' | 'arm64'];
        const spec = assetSpec(helper, v[helper].version, os, arch);
        expect(spec.verify).toBe('pinned');
        expect(v[helper].sha256[spec.hashKey]).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  test('the bundled caddy entry is a build recipe: xcaddy and modules, no hashes', () => {
    const c = loadVersions().caddy;
    expect(c.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(c.xcaddy).toMatch(/^v\d/);
    expect(Object.keys(c.modules)).toEqual(expect.arrayContaining(['github.com/caddy-dns/duckdns', 'github.com/mholt/caddy-l4']));
    for (const tag of Object.values(c.modules)) expect(tag).toMatch(/^v\d/);
    expect('sha256' in c).toBe(false);
    expect(validate(loadVersions())).toEqual([]);
  });

  test('versions check refuses a hashed or incomplete caddy entry', () => {
    const v = structuredClone(loadVersions()) as unknown as Record<string, Record<string, unknown>>;
    v.caddy!.sha256 = { 'linux-amd64': 'a'.repeat(64) };
    expect(validate(v).join('\n')).toContain('caddy is built, not downloaded');
    v.caddy = { version: '2.11', xcaddy: '0.4.7', modules: {} };
    expect(validate(v)).toEqual([
      'caddy: version 2.11 is not x.y.z',
      'caddy: xcaddy must be a tag like v0.4.7',
      'caddy: modules must be a non-empty object of Go module path -> tag',
    ]);
    v.caddy = { version: '2.11.4', xcaddy: 'v0.4.7', modules: { duckdns: 'v0.5.0', 'github.com/mholt/caddy-l4': 'latest' } };
    expect(validate(v)).toEqual(['caddy: duckdns is not a Go module path', 'caddy: github.com/mholt/caddy-l4 needs a tag like v1.2.3']);
  });
});

describe('ensureBinaries', () => {
  test('downloads, verifies, extracts only the member, writes the sidecar', async () => {
    const up = fakeUpstream();
    const outDir = tmp();
    const r = await ensureBinaries(['livekit', 'caddy', 'cloudflared'], { os: 'linux', arch: 'amd64', outDir, versions: up.versions, release: up.release, fetch: up.fetch, log: () => {} });
    expect(r.changed).toEqual(['livekit', 'caddy', 'cloudflared']);
    expect(r.paths.livekit).toBe(join(outDir, 'livekit-server'));
    expect(readFileSync(join(outDir, 'livekit-server'), 'utf8')).toBe('livekit linux-amd64 1.0.0');
    expect(readFileSync(join(outDir, 'cloudflared'), 'utf8')).toBe('cloudflared linux-amd64 1.0.0');
    expect(readFileSync(join(outDir, 'livekit.version'), 'utf8')).toBe('1.0.0\n');
    expect(existsSync(join(outDir, 'LICENSE'))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(join(outDir, 'livekit-server')).mode & 0o777).toBe(0o755);
  });

  test('windows zip assets', async () => {
    const up = fakeUpstream();
    const outDir = tmp();
    await ensureBinaries(['livekit'], { os: 'windows', arch: 'arm64', outDir, versions: up.versions, fetch: up.fetch, log: () => {} });
    expect(readFileSync(join(outDir, 'livekit-server.exe'), 'utf8')).toBe('livekit windows-arm64 1.0.0');
  });

  test('a matching sidecar skips the download; a pin bump re-downloads', async () => {
    const up = fakeUpstream();
    const outDir = tmp();
    const o = { os: 'linux' as const, arch: 'arm64' as const, outDir, fetch: up.fetch, log: () => {} };
    await ensureBinaries(['livekit'], { ...o, versions: up.versions });
    up.requests.length = 0;
    const again = await ensureBinaries(['livekit'], { ...o, versions: up.versions });
    expect(again.changed).toEqual([]);
    expect(up.requests).toEqual([]);

    const bumped = fakeUpstream('1.0.1');
    const r = await ensureBinaries(['livekit'], { ...o, versions: bumped.versions, fetch: bumped.fetch });
    expect(r.changed).toEqual(['livekit']);
    expect(readFileSync(join(outDir, 'livekit-server'), 'utf8')).toBe('livekit linux-arm64 1.0.1');
  });

  test('a hash mismatch writes nothing', async () => {
    const up = fakeUpstream();
    up.versions.livekit.sha256['linux-amd64'] = '0'.repeat(64);
    const outDir = tmp();
    await expect(ensureBinaries(['livekit'], { os: 'linux', arch: 'amd64', outDir, versions: up.versions, fetch: up.fetch, log: () => {} }))
      .rejects.toThrow('sha256');
    expect(existsSync(join(outDir, 'livekit-server'))).toBe(false);
    expect(existsSync(join(outDir, 'livekit.version'))).toBe(false);
  });

  test('cloudflared on windows-arm64 uses the x64 asset and says so', async () => {
    const up = fakeUpstream();
    const outDir = tmp();
    const lines: string[] = [];
    await ensureBinaries(['cloudflared'], { os: 'windows', arch: 'arm64', outDir, versions: up.versions, fetch: up.fetch, log: (m) => lines.push(m) });
    expect(up.requests).toEqual([assetSpec('cloudflared', '1.0.0', 'windows', 'amd64').url]);
    expect(lines.join('\n')).toContain('cloudflared has no windows-arm64 build; using the x64 build (emulated)');
    expect(readFileSync(join(outDir, 'cloudflared.exe'), 'utf8')).toBe('cloudflared windows-amd64 1.0.0');
  });
});

describe('ensureBinaries: caddy from a Telinha release', () => {
  const linux = { os: 'linux' as const, arch: 'amd64' as const };

  test('verified against the release SHA256SUMS; the sidecar holds the release tag', async () => {
    const up = fakeUpstream();
    const outDir = tmp();
    const lines: string[] = [];
    const r = await ensureBinaries(['caddy'], { ...linux, outDir, versions: up.versions, release: up.release, fetch: up.fetch, log: (m) => lines.push(m) });
    expect(r.changed).toEqual(['caddy']);
    expect(up.requests).toEqual([releaseAssetUrl('v9.9.9', 'SHA256SUMS'), releaseAssetUrl('v9.9.9', 'caddy-linux-x64.tar.gz')]);
    expect(readFileSync(join(outDir, 'caddy'), 'utf8')).toBe('caddy linux-amd64 v9.9.9');
    expect(readFileSync(join(outDir, 'caddy.version'), 'utf8')).toBe('v9.9.9\n');
    expect(lines).toContain('[bins] caddy v9.9.9 installed');
    if (process.platform !== 'win32') expect(statSync(join(outDir, 'caddy')).mode & 0o777).toBe(0o755);
  });

  test('windows arm64 gets its own zip', async () => {
    const up = fakeUpstream();
    const outDir = tmp();
    await ensureBinaries(['caddy'], { os: 'windows', arch: 'arm64', outDir, versions: up.versions, release: up.release, fetch: up.fetch, log: () => {} });
    expect(readFileSync(join(outDir, 'caddy.exe'), 'utf8')).toBe('caddy windows-arm64 v9.9.9');
  });

  test('same tag: nothing fetched; another release: re-downloaded', async () => {
    const up = fakeUpstream();
    const outDir = tmp();
    const o = { ...linux, outDir, versions: up.versions, log: () => {} };
    await ensureBinaries(['caddy'], { ...o, release: up.release, fetch: up.fetch });
    up.requests.length = 0;
    expect((await ensureBinaries(['caddy'], { ...o, release: up.release, fetch: up.fetch })).changed).toEqual([]);
    expect(up.requests).toEqual([]);

    const next = fakeUpstream('1.0.0', 'v10.0.0');
    expect((await ensureBinaries(['caddy'], { ...o, release: next.release, fetch: next.fetch })).changed).toEqual(['caddy']);
    expect(readFileSync(join(outDir, 'caddy.version'), 'utf8')).toBe('v10.0.0\n');
  });

  test('a release whose SHA256SUMS lacks the asset: error, nothing downloaded or written', async () => {
    const up = fakeUpstream();
    const outDir = tmp();
    const release = { tag: 'v9.9.9', sums: async () => ({ 'caddy-windows-x64.zip': 'a'.repeat(64) }) };
    await expect(ensureBinaries(['caddy'], { ...linux, outDir, versions: up.versions, release, fetch: up.fetch, log: () => {} }))
      .rejects.toThrow('SHA256SUMS of v9.9.9 has no caddy-linux-x64.tar.gz');
    expect(up.requests).toEqual([]);
    expect(existsSync(join(outDir, 'caddy'))).toBe(false);
    expect(existsSync(join(outDir, 'caddy.version'))).toBe(false);
  });

  test('a hash mismatch against the sums writes nothing', async () => {
    const up = fakeUpstream();
    const outDir = tmp();
    const release = { tag: 'v9.9.9', sums: async () => ({ 'caddy-linux-x64.tar.gz': '0'.repeat(64) }) };
    await expect(ensureBinaries(['caddy'], { ...linux, outDir, versions: up.versions, release, fetch: up.fetch, log: () => {} }))
      .rejects.toThrow('caddy-linux-x64.tar.gz: sha256');
    expect(existsSync(join(outDir, 'caddy'))).toBe(false);
    expect(existsSync(join(outDir, 'caddy.version'))).toBe(false);
  });

  test('no release given: an explicit error, no request', async () => {
    const up = fakeUpstream();
    await expect(ensureBinaries(['caddy'], { ...linux, outDir: tmp(), versions: up.versions, fetch: up.fetch, log: () => {} }))
      .rejects.toThrow('caddy comes from a Telinha release: pass the release tag (bun scripts/bins.ts --release vX.Y.Z caddy)');
    expect(up.requests).toEqual([]);
  });
});

describe('resolveCaddyRelease', () => {
  function recorder(respond: (url: string) => Response | Error) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const r = respond(url);
      if (r instanceof Error) throw r;
      return r;
    };
    return { fetch, calls };
  }

  test('compiled: this binary\'s own release, without asking GitHub', async () => {
    const f = recorder(() => new Error('no network expected'));
    const r = await resolveCaddyRelease(f.fetch, true);
    expect(r.tag).toBe(`v${version()}`);
    expect(f.calls).toEqual([]);
  });

  test('source: the tag releases/latest redirects to, read without following it', async () => {
    const f = recorder(() => redirectTo('v0.6.0'));
    expect((await resolveCaddyRelease(f.fetch, false)).tag).toBe('v0.6.0');
    expect(f.calls.map((c) => [c.url, c.init?.redirect])).toEqual([[LATEST, 'manual']]);
    expect(f.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('offline or no release: an explicit error', async () => {
    await expect(resolveCaddyRelease(recorder(() => new Error('getaddrinfo ENOTFOUND github.com')).fetch, false))
      .rejects.toThrow('no Telinha release found for caddy (offline?)');
    await expect(resolveCaddyRelease(recorder(() => new Response('', { status: 404 })).fetch, false))
      .rejects.toThrow('no Telinha release found for caddy (offline?)');
  });

  test('sums are fetched once, with a timeout', async () => {
    const line = `${'a'.repeat(64)}  caddy-linux-x64.tar.gz\n`;
    const f = recorder((url) => (url === LATEST ? redirectTo('v0.6.0') : new Response(line)));
    const r = await resolveCaddyRelease(f.fetch, false);
    expect(await r.sums()).toEqual({ 'caddy-linux-x64.tar.gz': 'a'.repeat(64) });
    expect(await r.sums()).toEqual({ 'caddy-linux-x64.tar.gz': 'a'.repeat(64) });
    const sumsCalls = f.calls.filter((c) => c.url.endsWith('/SHA256SUMS'));
    expect(sumsCalls.map((c) => c.url)).toEqual(['https://github.com/sombraSoft/telinha/releases/download/v0.6.0/SHA256SUMS']);
    expect(sumsCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('a release without SHA256SUMS: an error naming the tag', async () => {
    const f = recorder((url) => (url === LATEST ? redirectTo('v0.6.0') : new Response('Not Found', { status: 404 })));
    const r = await resolveCaddyRelease(f.fetch, false);
    await expect(r.sums()).rejects.toThrow('SHA256SUMS of v0.6.0: HTTP 404');
  });
});

describe('ensureBinariesForConfig', () => {
  const host = { platform: 'linux', arch: 'x64' };

  test('fetches what the config needs into paths.bin; a tunnel never looks up a release', async () => {
    const up = fakeUpstream();
    const bin = tmp();
    const r = await ensureBinariesForConfig({ media: 'self', ingress: 'tunnel' }, { bin }, () => {}, { ...host, versions: up.versions, fetch: up.fetch });
    expect(r.changed).toEqual(['livekit', 'cloudflared']);
    expect(Object.keys(r.paths).sort()).toEqual(['cloudflared', 'livekit']);
    expect(up.requests.filter((u) => u.includes('sombraSoft/telinha'))).toEqual([]);
  });

  test('direct from source: resolves the latest release, then fetches its caddy', async () => {
    const up = fakeUpstream();
    const bin = tmp();
    const r = await ensureBinariesForConfig({ media: 'cloud', ingress: 'direct' }, { bin }, () => {}, { ...host, versions: up.versions, fetch: up.fetch, compiled: false });
    expect(r.changed).toEqual(['caddy']);
    expect(up.requests[0]).toBe(LATEST);
    expect(readFileSync(join(bin, 'caddy.version'), 'utf8')).toBe('v9.9.9\n');
  });

  test('a given release is used as is', async () => {
    const up = fakeUpstream();
    const r = await ensureBinariesForConfig({ media: 'cloud', ingress: 'direct' }, { bin: tmp() }, () => {}, { ...host, versions: up.versions, fetch: up.fetch, release: up.release });
    expect(r.changed).toEqual(['caddy']);
    expect(up.requests).not.toContain(LATEST);
  });

  test('offline with the binary present: warns and continues', async () => {
    const up = fakeUpstream();
    const bin = tmp();
    writeFileSync(join(bin, 'livekit-server'), 'old');
    const lines: string[] = [];
    const offline = async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    };
    const r = await ensureBinariesForConfig({ media: 'self', ingress: 'external' }, { bin }, (m) => lines.push(m),
      { ...host, versions: up.versions, fetch: offline, which: () => null });
    expect(r.changed).toEqual([]);
    expect(r.paths.livekit).toBe(join(bin, 'livekit-server'));
    expect(lines.join('\n')).toContain('could not update livekit (');
  });

  test('offline with caddy present: no release found is a warning too', async () => {
    const bin = tmp();
    writeFileSync(join(bin, 'caddy'), 'old');
    const lines: string[] = [];
    const offline = async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    };
    const r = await ensureBinariesForConfig({ media: 'cloud', ingress: 'direct' }, { bin }, (m) => lines.push(m),
      { ...host, fetch: offline, which: () => null, compiled: false });
    expect(r.paths.caddy).toBe(join(bin, 'caddy'));
    expect(lines.join('\n')).toContain('could not update caddy (no Telinha release found for caddy (offline?))');
  });

  test('offline with the binary missing: fatal, naming where to put it', async () => {
    const up = fakeUpstream();
    const bin = tmp();
    const offline = async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    };
    await expect(ensureBinariesForConfig({ media: 'self', ingress: 'external' }, { bin }, () => {},
      { ...host, versions: up.versions, fetch: offline, which: () => null }))
      .rejects.toThrow(`livekit-server not found: put it in ${bin} or on PATH (download failed: getaddrinfo ENOTFOUND github.com)`);
    await expect(ensureBinariesForConfig({ media: 'cloud', ingress: 'direct' }, { bin }, () => {},
      { ...host, fetch: offline, which: () => null, compiled: false }))
      .rejects.toThrow(`caddy not found: put it in ${bin} or on PATH (download failed: no Telinha release found for caddy (offline?))`);
  });

  test('a binary on PATH counts as present', async () => {
    const up = fakeUpstream();
    const r = await ensureBinariesForConfig({ media: 'self', ingress: 'external' }, { bin: tmp() }, () => {},
      { ...host, versions: up.versions, fetch: async () => new Response('', { status: 503 }), which: (n) => `/usr/local/bin/${n}` });
    expect(r.paths.livekit).toBe('/usr/local/bin/livekit-server');
  });
});

describe('download progress', () => {
  /** A body in chunks with a Content-Length, like GitHub's. */
  const chunked = (parts: string[], length = true) => async () => {
    const data = parts.map((p) => enc.encode(p));
    const size = data.reduce((n, d) => n + d.byteLength, 0);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const d of data) c.enqueue(d);
        c.close();
      },
    });
    return new Response(body, { headers: length ? { 'content-length': String(size) } : {} });
  };

  test('streams the body and reports bytes against the size; the data is whole', async () => {
    const seen: [number, number | null][] = [];
    const data = await download('https://x.test/a', chunked(['abc', 'defg', 'h']), (got, total) => void seen.push([got, total]));
    expect(new TextDecoder().decode(data)).toBe('abcdefgh');
    expect(seen).toEqual([[0, 8], [3, 8], [7, 8], [8, 8]]);
  });

  test('no Content-Length: the size is null; no callback: nothing streamed by hand', async () => {
    const seen: (number | null)[] = [];
    await download('https://x.test/a', chunked(['ab', 'c'], false), (_got, total) => void seen.push(total));
    expect(seen).toEqual([null, null, null]);
    expect(new TextDecoder().decode(await download('https://x.test/a', chunked(['ab', 'c'])))).toBe('abc');
  });

  test('ensureBinaries and ensureBinariesForConfig name the helper; the result is the same without it', async () => {
    const up = fakeUpstream();
    const helpers = new Set<string>();
    let last = 0;
    const bin = tmp();
    const r = await ensureBinariesForConfig({ media: 'self', ingress: 'tunnel' }, { bin }, () => {}, {
      platform: 'linux', arch: 'x64', versions: up.versions, fetch: up.fetch,
      progress: (helper, got) => {
        helpers.add(helper);
        last = got;
      },
    });
    expect([...helpers].sort()).toEqual(['cloudflared', 'livekit']);
    expect(last).toBeGreaterThan(0);
    expect(r.changed).toEqual(['livekit', 'cloudflared']);
    const plain = await ensureBinaries(['livekit'], { os: 'linux', arch: 'amd64', outDir: tmp(), versions: up.versions, fetch: up.fetch, log: () => {} });
    expect(plain.changed).toEqual(['livekit']);
  });
});
