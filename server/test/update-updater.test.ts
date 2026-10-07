import { describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import { writeTarGz, writeZip } from '../src/archive.ts';
import { sha256 } from '../src/bins.ts';
import { parseSums } from '../src/release.ts';
import { PendingError, type GitHubReleases, type UpdateFs } from '../src/update/types.ts';
import { compareVersions, createUpdater, type UpdaterOptions } from '../src/update/updater.ts';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const PATHS = { bin: '/t/bin', run: '/t/data/run' };
const STATE = '/t/data/run/update.json';

function memFs() {
  const files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  const ops: string[] = [];
  let clock = 1;
  const n = (p: string) => p.replace(/\\/g, '/');
  const err = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });
  const fs: UpdateFs = {
    async readdir(dir) {
      const d = `${n(dir).replace(/\/$/, '')}/`;
      return [...files.keys()].filter((k) => k.startsWith(d) && !k.slice(d.length).includes('/')).map((k) => k.slice(d.length));
    },
    async rename(from, to) {
      const e = files.get(n(from));
      if (!e) throw err('ENOENT', from);
      files.delete(n(from));
      files.set(n(to), e);
      ops.push(`rename ${basename(from)} -> ${basename(to)}`);
    },
    async rm(p) {
      if (files.delete(n(p))) ops.push(`rm ${basename(p)}`);
    },
    async stat(p) {
      const e = files.get(n(p));
      return e ? { size: e.data.length, mtimeMs: e.mtimeMs } : null;
    },
    async readText(p) {
      const e = files.get(n(p));
      return e ? dec.decode(e.data) : null;
    },
    async writeText(p, text) {
      files.set(n(p), { data: enc.encode(text), mtimeMs: ++clock });
    },
    async readBytes(p) {
      const e = files.get(n(p));
      if (!e) throw err('ENOENT', p);
      return e.data;
    },
    async writeBytes(p, data) {
      files.set(n(p), { data, mtimeMs: ++clock });
      ops.push(`write ${basename(p)}`);
    },
    async mkdir() {},
    async openWrite(p) {
      const chunks: Uint8Array[] = [];
      return {
        write: async (c) => void chunks.push(c),
        close: async () => void files.set(n(p), { data: Buffer.concat(chunks), mtimeMs: ++clock }),
      };
    },
  };
  const put = (p: string, text: string) => files.set(n(p), { data: enc.encode(text), mtimeMs: ++clock });
  const text = (p: string) => {
    const e = files.get(n(p));
    return e ? dec.decode(e.data) : null;
  };
  const names = (dir: string) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => basename(k)).sort();
  return { fs, ops, put, text, names, state: () => JSON.parse(text(STATE) ?? '{}') as Record<string, unknown> };
}

interface Release { sums?: string; assets: Record<string, Uint8Array> }

/** A tar.gz (or zip for Windows targets) holding one executable, plus its SHA256SUMS line. */
function release(tag: string, o: { asset?: string; content?: string; badSum?: boolean; noLine?: boolean; member?: string; tray?: string } = {}): Release {
  const asset = o.asset ?? 'telinha-linux-x64.tar.gz';
  const member = o.member ?? (asset.endsWith('.zip') ? 'telinha.exe' : 'telinha');
  const entries = [{ path: member, mode: 0o755, data: enc.encode(o.content ?? `binary ${tag}`) }];
  if (o.tray) entries.push({ path: 'telinha-tray.exe', mode: 0o755, data: enc.encode(o.tray) });
  const bytes = asset.endsWith('.zip') ? writeZip(entries) : writeTarGz(entries);
  const sum = o.badSum ? 'f'.repeat(64) : sha256(bytes);
  return { sums: o.noLine ? `${'a'.repeat(64)}  other.zip\n` : `${sum}  ${asset}\n`, assets: { [asset]: bytes } };
}

function fakeGitHub(latest: string | null, releases: Record<string, Release> = {}) {
  const calls: string[] = [];
  const state = { latest, releases };
  const gh: GitHubReleases = {
    async latestTag() {
      calls.push('latest');
      return state.latest;
    },
    assetUrl: (tag, asset) => `https://example.test/${tag}/${asset}`,
    async sums(tag) {
      calls.push(`sums ${tag}`);
      const r = state.releases[tag];
      if (!r?.sums) throw new PendingError(`SHA256SUMS of ${tag}: HTTP 404`);
      return parseSums(r.sums);
    },
    async asset(tag, name) {
      calls.push(`asset ${tag}/${name}`);
      const bytes = state.releases[tag]?.assets[name];
      return bytes ? new Response(bytes) : new Response('Not Found', { status: 404 });
    },
  };
  return { gh, calls, state };
}

function setup(o: Partial<UpdaterOptions> & { latest?: string | null; releases?: Record<string, Release>; rooms?: number; exe?: string } = {}) {
  const m = memFs();
  m.put(`${PATHS.bin}/${o.exe ?? 'telinha'}`, 'binary 0.7.0');
  const gh = fakeGitHub(o.latest ?? null, o.releases ?? {});
  const clock = { t: T0 };
  const rooms = { n: o.rooms ?? 0 };
  const applied: string[] = [];
  const logs: string[] = [];
  const sleeps: { ms: number; resolve: () => void }[] = [];
  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    sleeps.push({ ms, resolve });
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });
  const updater = createUpdater({
    current: '0.7.0', checkMs: 6 * HOUR, maxDeferMs: 12 * HOUR, startDelayMs: 120_000, deferPollMs: 60_000,
    paths: PATHS, target: 'linux-x64', platform: 'linux', openRooms: () => rooms.n, github: gh.gh, fs: m.fs,
    now: () => clock.t, sleep, log: (...a) => logs.push(a.join(' ')), onApplied: (tag) => applied.push(tag), compiled: true,
    ...o,
  });
  return { m, gh, clock, rooms, applied, logs, sleeps, updater };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('compareVersions', () => {
  test('numeric parts, v prefix ignored, prerelease below release', () => {
    expect(compareVersions('v0.8.0', '0.7.0')).toBe(1);
    expect(compareVersions('0.7.0', 'v0.7.0')).toBe(0);
    expect(compareVersions('0.7.10', '0.7.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.8.0-rc.1', '0.8.0')).toBe(-1);
    expect(compareVersions('0.8.0-rc.2', '0.8.0-rc.10')).toBe(-1);
    expect(compareVersions('0.8.0-rc.1', '0.7.0')).toBe(1);
  });
});

describe('createUpdater', () => {
  test('latest newer than current: downloads, verifies, stages, writes state, asks for the restart', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0') } });
    const r = await s.updater.update('now');
    expect(r.action).toBe('staged');
    expect(r.target).toBe('v0.8.0');
    expect(r.latest).toBe('v0.8.0');
    expect(s.applied).toEqual(['v0.8.0']);
    expect(s.gh.calls).toEqual(['latest', 'sums v0.8.0', 'asset v0.8.0/telinha-linux-x64.tar.gz']);
    expect(s.m.text(`${PATHS.bin}/telinha`)).toBe('binary v0.8.0');
    expect(s.m.text(`${PATHS.bin}/telinha.old-0.7.0`)).toBe('binary 0.7.0');
    expect(s.m.names(PATHS.bin)).toEqual(['telinha', 'telinha.old-0.7.0']);
    expect(s.m.state()).toEqual({
      staged: { tag: 'v0.8.0', previous: '0.7.0', previousFile: 'telinha.old-0.7.0', at: T0, failedStarts: 0 },
      lastCheck: T0,
    });
    expect(s.updater.status()).toMatchObject({ enabled: true, current: '0.7.0', latest: 'v0.8.0', pin: null, failed: null, pending: null });
    expect(s.updater.status().staged?.tag).toBe('v0.8.0');
  });

  test('Windows target: zip, telinha.exe, .exe names', async () => {
    const s = setup({
      target: 'windows-x64', platform: 'win32', exe: 'telinha.exe',
      latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0', { asset: 'telinha-windows-x64.zip' }) },
    });
    expect((await s.updater.update('now')).action).toBe('staged');
    expect(s.m.text(`${PATHS.bin}/telinha.exe`)).toBe('binary v0.8.0');
    expect(s.m.names(PATHS.bin)).toEqual(['telinha.exe', 'telinha.old-0.7.0.exe']);
  });

  test('Windows target with the tray in the release: an installed tray is replaced and recorded', async () => {
    const s = setup({
      target: 'windows-x64', platform: 'win32', exe: 'telinha.exe',
      latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0', { asset: 'telinha-windows-x64.zip', tray: 'tray v0.8.0' }) },
    });
    s.m.put(`${PATHS.bin}/telinha-tray.exe`, 'tray v0.7.0');
    expect((await s.updater.update('now')).action).toBe('staged');
    expect(s.m.text(`${PATHS.bin}/telinha-tray.exe`)).toBe('tray v0.8.0');
    expect(s.updater.status().staged?.trayPreviousFile).toBe('telinha-tray.old-0.7.0.exe');
    expect((s.m.state().staged as Record<string, unknown>).trayPreviousFile).toBe('telinha-tray.old-0.7.0.exe');
  });

  test('a failed install removes both staged .new files', async () => {
    const s = setup({
      target: 'windows-x64', platform: 'win32', exe: 'telinha.exe',
      latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0', { asset: 'telinha-windows-x64.zip', tray: 'tray v0.8.0' }) },
    });
    s.m.put(`${PATHS.bin}/telinha-tray.exe`, 'tray v0.7.0');
    // The main swap fails after the download wrote both .new files.
    const rename = s.m.fs.rename;
    s.m.fs.rename = async (from, to) => {
      if (basename(from) === 'telinha.new.exe') throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' });
      return rename(from, to);
    };
    expect((await s.updater.update('now')).action).toBe('pending');
    expect(s.m.names(PATHS.bin)).toEqual(['telinha-tray.exe', 'telinha.exe']);
    expect(s.m.text(`${PATHS.bin}/telinha-tray.exe`)).toBe('tray v0.7.0');
  });

  test('up to date, or latest older than current: nothing happens (no downgrade without a pin)', async () => {
    for (const latest of ['v0.7.0', 'v0.6.9']) {
      const s = setup({ latest, releases: { [latest]: release(latest) } });
      const r = await s.updater.update('scheduled');
      expect(r.action).toBe('none');
      expect(r.target).toBeNull();
      expect(r.message).toContain('up to date');
      expect(s.gh.calls).toEqual(['latest']);
      expect(s.applied).toEqual([]);
    }
  });

  test('a prerelease as latest is no stable release: ignored, never failed', async () => {
    const s = setup({ latest: 'v0.8.0-rc.1', releases: { 'v0.8.0-rc.1': release('v0.8.0-rc.1') } });
    const c = await s.updater.check();
    expect(c).toMatchObject({ latest: null, target: null, failed: null, pending: null });
    expect(s.logs.join('\n')).toContain('v0.8.0-rc.1 is a prerelease');
    expect((await s.updater.update('now')).action).toBe('none');
    expect(s.m.state().failed).toBeUndefined();
  });

  test('pin: that exact tag, prerelease or downgrade included; pin equal to current means up to date', async () => {
    const rc = setup({ pin: 'v0.8.0-rc.1', latest: 'v0.8.0-rc.1', releases: { 'v0.8.0-rc.1': release('v0.8.0-rc.1') } });
    const r = await rc.updater.update('scheduled');
    expect(r.action).toBe('staged');
    expect(r.latest).toBe('v0.8.0-rc.1');
    expect(rc.m.text(`${PATHS.bin}/telinha`)).toBe('binary v0.8.0-rc.1');

    const down = setup({ pin: 'v0.6.0', latest: 'v0.9.0', releases: { 'v0.6.0': release('v0.6.0') } });
    const d = await down.updater.update('now');
    expect(d.action).toBe('staged');
    expect(d.target).toBe('v0.6.0');
    expect(d.latest).toBe('v0.9.0');
    expect(down.m.text(`${PATHS.bin}/telinha`)).toBe('binary v0.6.0');

    const same = setup({ pin: 'v0.7.0', latest: 'v0.9.0' });
    expect((await same.updater.update('now')).action).toBe('none');
    expect(same.updater.status().pin).toBe('v0.7.0');
  });

  test('404 on the assets: pending with its first `since`, retried, never failed; installs once published', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': { assets: {} } } });
    const r1 = await s.updater.update('scheduled');
    expect(r1.action).toBe('pending');
    expect(r1.pending).toEqual({ tag: 'v0.8.0', since: T0 });
    expect(r1.failed).toBeNull();
    s.clock.t += HOUR;
    // Assets up now, sums still missing: still pending, same since.
    s.gh.state.releases['v0.8.0'] = { assets: release('v0.8.0').assets };
    const r2 = await s.updater.update('scheduled');
    expect(r2.action).toBe('pending');
    expect(r2.pending).toEqual({ tag: 'v0.8.0', since: T0 });
    expect(s.m.state().failed).toBeUndefined();
    expect(s.m.text(`${PATHS.bin}/telinha`)).toBe('binary 0.7.0');
    // Fully published: installs and clears pending.
    s.gh.state.releases['v0.8.0'] = release('v0.8.0');
    const r3 = await s.updater.update('scheduled');
    expect(r3.action).toBe('staged');
    expect(r3.pending).toBeNull();
    expect(s.m.state().pending).toBeUndefined();
  });

  test('a newer tag clears a pending older one', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': { assets: {} } } });
    await s.updater.update('scheduled');
    s.gh.state.latest = 'v0.8.1';
    s.gh.state.releases['v0.8.1'] = { assets: {} };
    const r = await s.updater.update('scheduled');
    expect(r.pending).toEqual({ tag: 'v0.8.1', since: T0 });
  });

  test('sha256 mismatch: failed, nothing touched, skipped by the timer, retried by --now, forgotten on a newer tag', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0', { badSum: true }) } });
    const r = await s.updater.update('scheduled');
    expect(r.action).toBe('failed');
    expect(r.failed?.tag).toBe('v0.8.0');
    expect(r.failed?.reason).toContain('sha256 mismatch');
    expect(s.m.text(`${PATHS.bin}/telinha`)).toBe('binary 0.7.0');
    expect(s.m.names(PATHS.bin)).toEqual(['telinha']);
    expect(s.applied).toEqual([]);
    // The timer skips it...
    s.gh.calls.length = 0;
    const skip = await s.updater.update('scheduled');
    expect(skip.action).toBe('failed');
    expect(skip.message).toContain('skipping v0.8.0');
    expect(s.gh.calls).toEqual(['latest']);
    // ...--now retries (and the release is fixed).
    s.gh.state.releases['v0.8.0'] = release('v0.8.0');
    const retry = await s.updater.applyNow();
    expect(retry.action).toBe('staged');
    expect(retry.failed).toBeNull();
  });

  test('a newer tag supersedes a failed one', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0', { badSum: true }) } });
    await s.updater.update('scheduled');
    s.gh.state.latest = 'v0.8.1';
    s.gh.state.releases['v0.8.1'] = release('v0.8.1');
    const r = await s.updater.update('scheduled');
    expect(r.action).toBe('staged');
    expect(r.failed).toBeNull();
    expect(s.m.state().failed).toBeUndefined();
  });

  test('missing SHA256SUMS line and bad archives are failures too', async () => {
    const noLine = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0', { noLine: true }) } });
    expect((await noLine.updater.update('now')).failed?.reason).toContain('no line for telinha-linux-x64.tar.gz');
    const wrongMember = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0', { member: 'other' }) } });
    expect((await wrongMember.updater.update('now')).failed?.reason).toContain('no telinha');
    expect(wrongMember.m.names(PATHS.bin)).toEqual(['telinha']);
  });

  test('rooms open: deferred per target up to maxDeferMs, then applied; --now never waits', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0') }, rooms: 2 });
    const r1 = await s.updater.update('scheduled');
    expect(r1.action).toBe('deferred');
    expect(r1.message).toBe('2 room(s) open, will update to v0.8.0 when they close');
    expect(r1.deferredSince).toBe(T0);
    expect(s.applied).toEqual([]);
    s.clock.t += 11 * HOUR;
    expect((await s.updater.update('scheduled')).deferredSince).toBe(T0);
    s.clock.t += 2 * HOUR;
    const r3 = await s.updater.update('scheduled');
    expect(r3.action).toBe('staged');
    expect(r3.deferredSince).toBeNull();
    expect(s.logs.some((l) => l.includes('deferred for 12 h'))).toBe(true);

    const now = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0') }, rooms: 5 });
    expect((await now.updater.update('now')).action).toBe('staged');
  });

  test('a new target restarts the deferral clock', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0'), 'v0.8.1': release('v0.8.1') }, rooms: 1 });
    await s.updater.update('scheduled');
    s.clock.t += 10 * HOUR;
    s.gh.state.latest = 'v0.8.1';
    const r = await s.updater.update('scheduled');
    expect(r.action).toBe('deferred');
    expect(r.deferredSince).toBe(T0 + 10 * HOUR);
  });

  test('check never writes files; the control endpoint mode "check" neither', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0') } });
    const c = await s.updater.check();
    expect(c.target).toBe('v0.8.0');
    const r = await s.updater.update('check');
    expect(r.action).toBe('none');
    expect(r.message).toBe('v0.8.0 is available');
    expect(s.m.names(PATHS.bin)).toEqual(['telinha']);
    expect(s.applied).toEqual([]);
  });

  test('not compiled (dev, Docker): reports, never applies', async () => {
    const s = setup({ compiled: false, latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0') } });
    const r = await s.updater.update('now');
    expect(r.action).toBe('none');
    expect(r.target).toBe('v0.8.0');
    expect(r.message).toContain('native installs only');
    expect(s.gh.calls).toEqual(['latest']);
    expect(s.updater.status().enabled).toBe(false);
  });

  test('already staged: no second download until the restart', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0') } });
    await s.updater.update('now');
    s.gh.state.latest = 'v0.8.1';
    const r = await s.updater.update('now');
    expect(r.action).toBe('staged');
    expect(r.message).toContain('restart telinha');
    expect(s.applied).toEqual(['v0.8.0']);
  });

  test('finish clears the staged record and sweeps', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0') } });
    await s.updater.update('now');
    await s.updater.finish();
    expect(s.m.state().staged).toBeUndefined();
    expect(s.m.names(PATHS.bin)).toEqual(['telinha']);
    expect(s.updater.status().staged).toBeNull();
  });

  test('finish records the applied update; status exposes it, null before any', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0') } });
    await s.updater.update('now');
    expect(s.updater.status().applied).toBeNull();
    s.clock.t = T0 + 5_000;
    await s.updater.finish();
    const applied = { tag: 'v0.8.0', previous: '0.7.0', at: T0 + 5_000 };
    expect(s.m.state().applied).toEqual(applied);
    expect(s.updater.status().applied).toEqual(applied);
    // A later start with nothing staged keeps it.
    s.clock.t += 60_000;
    await s.updater.finish();
    expect(s.updater.status().applied).toEqual(applied);
    // Writes that follow (a check) keep it too.
    await s.updater.check();
    expect(s.m.state().applied).toEqual(applied);
  });

  test('start(): first check after startDelayMs, then every checkMs, every minute while deferred; stop aborts', async () => {
    const s = setup({ latest: 'v0.8.0', releases: { 'v0.8.0': release('v0.8.0') }, rooms: 1 });
    const stop = s.updater.start();
    await settle();
    expect(s.sleeps.map((x) => x.ms)).toEqual([120_000]);
    expect(s.gh.calls).toEqual([]);
    s.sleeps[0]!.resolve();
    await settle();
    expect(s.gh.calls).toEqual(['latest']);
    expect(s.m.state().deferredSince).toBe(T0);
    expect(s.sleeps.map((x) => x.ms)).toEqual([120_000, 60_000]);
    // Rooms closed: the next poll applies without asking GitHub again (answer reused within checkMs).
    s.rooms.n = 0;
    s.clock.t += 60_000;
    s.sleeps[1]!.resolve();
    await settle();
    expect(s.applied).toEqual(['v0.8.0']);
    expect(s.gh.calls).toEqual(['latest', 'sums v0.8.0', 'asset v0.8.0/telinha-linux-x64.tar.gz']);
    expect(s.sleeps.map((x) => x.ms)).toEqual([120_000, 60_000, 6 * HOUR]);
    stop();
    await settle();
    expect(s.sleeps).toHaveLength(3);
  });

  test('start() with enabled=false does nothing', async () => {
    const s = setup({ enabled: false, latest: 'v0.8.0' });
    const stop = s.updater.start();
    await settle();
    expect(s.sleeps).toEqual([]);
    expect(s.gh.calls).toEqual([]);
    stop();
  });
});
