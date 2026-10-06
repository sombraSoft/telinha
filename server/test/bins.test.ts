import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTarGz, writeZip } from '../src/archive.ts';
import {
  PLATFORMS, TOOLS, assetSpec, ensureBinaries, ensureBinariesForConfig, loadVersions, sha256, toolsFor, type Versions,
} from '../src/bins.ts';

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

// Fake upstream: every asset of every platform, as the real ones are packaged.
function fakeUpstream(version = '1.0.0') {
  const assets = new Map<string, Uint8Array>();
  const versions = {} as Versions;
  for (const tool of TOOLS) {
    versions[tool] = { version, sha256: {} };
    for (const p of PLATFORMS) {
      const [os, arch] = p.split('-') as ['linux' | 'windows', 'amd64' | 'arm64'];
      const spec = assetSpec(tool, version, os, arch);
      if (assets.has(spec.url)) continue;
      const exe = enc.encode(`${tool} ${spec.hashKey} ${version}`);
      const data = spec.archive === null ? exe
        : (spec.archive === 'zip' ? writeZip : writeTarGz)([
          { path: 'LICENSE', mode: 0o644, data: enc.encode('license') },
          { path: spec.member, mode: 0o755, data: exe },
        ]);
      assets.set(spec.url, data);
      versions[tool].sha256[spec.hashKey] = sha256(data);
    }
  }
  const requests: string[] = [];
  const fetch = async (url: string) => {
    requests.push(url);
    const body = assets.get(url);
    return body ? new Response(body) : new Response('nope', { status: 404, statusText: 'Not Found' });
  };
  return { assets, versions, fetch, requests };
}

describe('assetSpec', () => {
  test('cloudflared on windows-arm64 is the x64 build', () => {
    const s = assetSpec('cloudflared', '2026.9.3', 'windows', 'arm64');
    expect(s.asset).toBe('cloudflared-windows-amd64.exe');
    expect(s.hashKey).toBe('windows-amd64');
  });

  test('livekit and caddy have native windows-arm64 builds', () => {
    expect(assetSpec('livekit', '1.13.7', 'windows', 'arm64')).toMatchObject({ asset: 'livekit_1.13.7_windows_arm64.zip', hashKey: 'windows-arm64' });
    expect(assetSpec('caddy', '2.11.4', 'windows', 'arm64')).toMatchObject({ asset: 'caddy_2.11.4_windows_arm64.zip', hashKey: 'windows-arm64' });
  });

  test('the bundled versions.json has a hash for every asset', () => {
    const v = loadVersions();
    for (const tool of TOOLS) {
      for (const p of PLATFORMS) {
        const [os, arch] = p.split('-') as ['linux' | 'windows', 'amd64' | 'arm64'];
        expect(v[tool].sha256[assetSpec(tool, v[tool].version, os, arch).hashKey]).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe('ensureBinaries', () => {
  test('downloads, verifies, extracts only the member, writes the sidecar', async () => {
    const up = fakeUpstream();
    const outDir = tmp();
    const r = await ensureBinaries(['livekit', 'caddy', 'cloudflared'], { os: 'linux', arch: 'amd64', outDir, versions: up.versions, fetch: up.fetch, log: () => {} });
    expect(r.changed).toEqual(['livekit', 'caddy', 'cloudflared']);
    expect(r.paths.livekit).toBe(join(outDir, 'livekit-server'));
    expect(readFileSync(join(outDir, 'livekit-server'), 'utf8')).toBe('livekit linux-amd64 1.0.0');
    expect(readFileSync(join(outDir, 'cloudflared'), 'utf8')).toBe('cloudflared linux-amd64 1.0.0');
    expect(readFileSync(join(outDir, 'caddy.version'), 'utf8')).toBe('1.0.0\n');
    expect(existsSync(join(outDir, 'LICENSE'))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(join(outDir, 'caddy')).mode & 0o777).toBe(0o755);
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
    up.versions.caddy.sha256['linux-amd64'] = '0'.repeat(64);
    const outDir = tmp();
    await expect(ensureBinaries(['caddy'], { os: 'linux', arch: 'amd64', outDir, versions: up.versions, fetch: up.fetch, log: () => {} }))
      .rejects.toThrow('sha256');
    expect(existsSync(join(outDir, 'caddy'))).toBe(false);
    expect(existsSync(join(outDir, 'caddy.version'))).toBe(false);
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

describe('ensureBinariesForConfig', () => {
  const host = { platform: 'linux', arch: 'x64' };

  test('tools per config', () => {
    expect(toolsFor({ media: 'self', ingress: 'direct' })).toEqual(['livekit', 'caddy']);
    expect(toolsFor({ media: 'self', ingress: 'tunnel' })).toEqual(['livekit', 'cloudflared']);
    expect(toolsFor({ media: 'cloud', ingress: 'external' })).toEqual([]);
  });

  test('fetches what the config needs into paths.bin', async () => {
    const up = fakeUpstream();
    const bin = tmp();
    const r = await ensureBinariesForConfig({ media: 'self', ingress: 'tunnel' }, { bin }, () => {}, { ...host, versions: up.versions, fetch: up.fetch });
    expect(r.changed).toEqual(['livekit', 'cloudflared']);
    expect(Object.keys(r.paths).sort()).toEqual(['cloudflared', 'livekit']);
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

  test('offline with the binary missing: fatal, naming where to put it', async () => {
    const up = fakeUpstream();
    const bin = tmp();
    const offline = async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    };
    await expect(ensureBinariesForConfig({ media: 'self', ingress: 'external' }, { bin }, () => {},
      { ...host, versions: up.versions, fetch: offline, which: () => null }))
      .rejects.toThrow(`livekit-server not found: put it in ${bin} or on PATH (download failed: getaddrinfo ENOTFOUND github.com)`);
  });

  test('a binary on PATH counts as present', async () => {
    const up = fakeUpstream();
    const r = await ensureBinariesForConfig({ media: 'self', ingress: 'external' }, { bin: tmp() }, () => {},
      { ...host, versions: up.versions, fetch: async () => new Response('', { status: 503 }), which: (n) => `/usr/local/bin/${n}` });
    expect(r.paths.livekit).toBe('/usr/local/bin/livekit-server');
  });
});
