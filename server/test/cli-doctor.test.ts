import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliContext } from '../src/cli/args.ts';
import type { DoctorReport, PhoneTestPoll } from '../src/cli/control.ts';
import { buildCheckContext, DOCTOR_FLAGS, run, type DoctorTuiRunner } from '../src/cli/doctor.ts';
import type { DoctorControl } from '../src/doctor/phone-test.ts';
import type { Check, CheckContext, CheckStatus } from '../src/doctor/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { PROD_ENV } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REPORT: DoctorReport = {
  https: { ok: true, latencyMs: 80 },
  signaling: { ok: true },
  initial: { protocol: 'udp', candidateIp: '203.0.113.7', rttMs: 40 },
  tcp: { ok: true, rttMs: 60 },
  udp: { ok: true, rttMs: 40 },
  publish: { ok: true },
  client: { ua: 'phone', ip: '198.51.100.9' },
  startedAt: 1,
  finishedAt: 2,
};

function ctx(o: { argv: string[]; tty?: boolean; locale?: 'en' | 'pt-BR' }) {
  const home = mkdtempSync(join(tmpdir(), 'telinha-doc-'));
  dirs.push(home);
  const json: string[] = [];
  const err: string[] = [];
  const c: CliContext = {
    argv: o.argv, env: { TELINHA_HOME: home, NO_COLOR: '1' }, paths: resolvePaths({ TELINHA_HOME: home }), envFile: join(home, 'config', 'telinha.env'),
    locale: o.locale ?? 'en', tty: o.tty ?? false, yes: false, stdout: (l) => json.push(l), stderr: (l) => err.push(l), compiled: false, version: '0.7.0',
  };
  let text = '';
  const out = { write: (s: string) => void (text += s), isTTY: false };
  return { ctx: c, json, err, out, text: () => text };
}

const fakeCheck = (id: string, status: CheckStatus, extra: { detail?: string[]; fix?: string } = {}, seen?: CheckContext[]): Check => ({
  id,
  async run(c) {
    seen?.push(c);
    return { id, title: id, status, summary: `${id} is ${status}`, ...extra };
  },
});

function control(o: { available?: boolean; states?: (PhoneTestPoll | 'hang')[] } = {}) {
  const calls: string[] = [];
  const states = [...(o.states ?? [])];
  const client: DoctorControl = {
    available: async () => (calls.push('available'), o.available ?? true),
    status: async () => ({}) as never,
    doctorSession: async () => (calls.push('session'), { id: 'abc', url: 'https://telinha.example.com/doctor?t=TOKEN', expiresAt: Date.now() + 600_000 }),
    doctorWait: async (id, ms) => {
      calls.push(`wait ${id} ${ms}`);
      const next = states.shift() ?? { state: 'expired' };
      return next === 'hang' ? new Promise<PhoneTestPoll>(() => {}) : next;
    },
  };
  return { client, calls };
}

const args = { flags: {}, positionals: [], rest: [] };
/** The plain output from the phone test's title on. */
const phoneSection = (text: string) => text.slice(text.indexOf('▸ Phone test')).trimEnd();
const noPhone = { qr: (u: string) => `[QR ${u}]`, onInterrupt: () => () => {} };

describe('telinha doctor', () => {
  test('flags', () => {
    expect(DOCTOR_FLAGS).toEqual({ json: 'boolean', phone: 'boolean', local: 'boolean' });
  });

  test('prints a row per check, details and fixes, and a summary; 0 without failures', async () => {
    const c = ctx({ argv: ['doctor', '--no-phone'] });
    const code = await run(args, c.ctx, {
      ...noPhone, out: c.out, control: control().client,
      checks: [fakeCheck('config', 'ok'), fakeCheck('dns', 'warn', { detail: ['A 1.2.3.4'], fix: 'point it at 5.6.7.8' }), fakeCheck('gateway', 'skip')],
    });
    expect(code).toBe(0);
    const text = c.text();
    expect(text).toMatch(/✓ config +config is ok/);
    expect(text).toMatch(/! dns +dns is warn/);
    expect(text).toContain('A 1.2.3.4');
    expect(text).toContain('→ point it at 5.6.7.8');
    expect(text).toMatch(/– gateway +gateway is skip/);
    expect(text).toContain('1 ok, 1 warning(s), 0 failure(s), 1 skipped');
    expect(c.json).toEqual([]);
  });

  test('an unknown or secret flag: usage, exit 2, no check runs', async () => {
    for (const argv of [['doctor', '--jsonn'], ['doctor', '--discord-token', 'x']]) {
      const c = ctx({ argv });
      const seen: CheckContext[] = [];
      expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: control().client, checks: [fakeCheck('a', 'ok', {}, seen)] })).toBe(2);
      expect(seen).toEqual([]);
      expect(c.err.at(-1)).toContain('Usage: telinha doctor');
    }
  });

  test('any failed check: exit 1', async () => {
    const c = ctx({ argv: ['doctor', '--no-phone'] });
    expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: control().client, checks: [fakeCheck('a', 'ok'), fakeCheck('b', 'fail')] })).toBe(1);
  });

  test('the native binary: config read as `run` reads it (AUTO_UPDATE=on stays on), the service check gets a status', async () => {
    const c = ctx({ argv: ['doctor'] });
    Object.assign(c.ctx.env, PROD_ENV, { TELINHA_HOME: c.ctx.paths.home, AUTO_UPDATE: 'on' });
    const native = await buildCheckContext({ ...c.ctx, compiled: true }, { local: true, control: control().client });
    expect(native.config?.autoUpdate).toBe(true);
    expect(native.config?.warnings.join('\n') ?? '').not.toContain('AUTO_UPDATE');
    expect(typeof native.service).toBe(process.platform === 'win32' || process.platform === 'linux' ? 'function' : 'object');
    const docker = await buildCheckContext(c.ctx, { local: true, control: control().client });
    expect(docker.config?.autoUpdate).toBe(false);
    expect(docker.service).toBeNull();
  });

  test('the checks get the merged environment, --local, the control client and the version', async () => {
    const c = ctx({ argv: ['doctor', '--local'] });
    c.ctx.env.PUBLIC_URL = 'https://from-env.example.com';
    const seen: CheckContext[] = [];
    const ctl = control();
    await run(args, c.ctx, { ...noPhone, out: c.out, control: ctl.client, checks: [fakeCheck('a', 'ok', {}, seen)] });
    const got = seen[0]!;
    expect(got.local).toBe(true);
    expect(got.env.PUBLIC_URL).toBe('https://from-env.example.com');
    expect(got.control).toBe(ctl.client);
    expect(got.version).toBe('0.7.0');
    expect(got.compiled).toBe(false);
    // Not the native binary (Docker, a checkout): no service to report on.
    expect(got.service).toBeNull();
    expect(got.config).toBeNull();
    expect(got.configError).toContain('missing env');
    expect(got.updateState).toBeNull();
    expect(typeof got.latestTag).toBe('function');
    expect(typeof got.nat?.probe).toBe('function');
    // --local: no phone test either.
    expect(ctl.calls).toEqual([]);
  });

  test('tray.json is read from data/run: absent, corrupt or incomplete is null', async () => {
    const c = ctx({ argv: ['doctor'] });
    const build = () => buildCheckContext(c.ctx, { local: true, control: control().client });
    expect((await build()).trayState).toBeNull();
    mkdirSync(c.ctx.paths.run, { recursive: true });
    const file = join(c.ctx.paths.run, 'tray.json');
    writeFileSync(file, '{not json');
    expect((await build()).trayState).toBeNull();
    writeFileSync(file, JSON.stringify({ version: '0.7.0' }));
    expect((await build()).trayState).toBeNull();
    const state = { version: '0.7.0', pid: 1234, startedAt: 1_700_000_000_000, exe: 'C:\\Users\\ana\\AppData\\Local\\Telinha\\bin\\telinha-tray.exe' };
    writeFileSync(file, JSON.stringify(state));
    expect((await build()).trayState).toEqual(state);
  });

  test('--json: only JSON on stdout', async () => {
    const c = ctx({ argv: ['doctor', '--json', '--no-phone'] });
    const code = await run(args, c.ctx, { ...noPhone, out: c.out, control: control().client, checks: [fakeCheck('a', 'ok'), fakeCheck('b', 'fail')] });
    expect(code).toBe(1);
    expect(c.text()).toBe('');
    const parsed = JSON.parse(c.json.join('\n')) as { checks: { id: string; status: string }[]; phone?: unknown };
    expect(parsed.checks.map((r) => [r.id, r.status])).toEqual([['a', 'ok'], ['b', 'fail']]);
    expect(parsed.phone).toBeUndefined();
  });

  test('no terminal: the phone test is skipped with a note', async () => {
    const c = ctx({ argv: ['doctor'], tty: false });
    const ctl = control();
    expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: ctl.client, checks: [fakeCheck('a', 'ok')] })).toBe(0);
    expect(c.text()).toContain('needs an interactive terminal');
    expect(ctl.calls).toEqual([]);
  });

  // On a terminal only --json stays plain; the phone test runs there too.
  test('service not running: says how to start it', async () => {
    const c = ctx({ argv: ['doctor', '--json'], tty: true });
    const ctl = control({ available: false });
    expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: ctl.client, checks: [fakeCheck('a', 'ok')] })).toBe(0);
    expect(c.text()).toContain('telinha service start');
    expect(ctl.calls).toEqual(['available']);
  });

  test('phone test: link, QR, opened, then the rows as the checks draw them, each hint under its row', async () => {
    const c = ctx({ argv: ['doctor', '--json'], tty: true });
    const report: DoctorReport = { ...REPORT, udp: { ok: false, error: 'fell back to TCP' } };
    const ctl = control({ states: [{ state: 'pending' }, { state: 'opened', openedAt: 1 }, { state: 'done', openedAt: 1, report }] });
    expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: ctl.client, checks: [fakeCheck('a', 'ok')] })).toBe(0);
    expect(ctl.calls.slice(0, 3)).toEqual(['available', 'session', 'wait abc 8000']);
    expect(phoneSection(c.text())).toBe([
      '▸ Phone test',
      'Open this on your phone with Wi-Fi OFF (mobile data):',
      '  https://telinha.example.com/doctor?t=TOKEN',
      '',
      '[QR https://telinha.example.com/doctor?t=TOKEN]',
      '  Waiting up to 10 minutes... (Ctrl+C to skip)',
      '  Opened on the phone, testing...',
      '✓ HTTPS               80 ms',
      '✓ LiveKit connection  works',
      '✓ Sending video       works',
      '✓ First path          UDP to 203.0.113.7, 40 ms',
      '! UDP 7882            failed: fell back to TCP',
      "                      → UDP 7882 is not reachable from the internet: open it to this machine (router forwarding, or the VPS provider's firewall); video falls back to TCP, with more delay.",
      '✓ TCP 7881            works, 60 ms',
    ].join('\n'));
  });

  test('phone test: both media paths closed fail the run; their shared hint is printed once', async () => {
    const c = ctx({ argv: ['doctor', '--json'], tty: true });
    const report: DoctorReport = { ...REPORT, initial: null, udp: { ok: false }, tcp: { ok: false } };
    const ctl = control({ states: [{ state: 'done', report }] });
    expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: ctl.client, checks: [fakeCheck('a', 'ok')] })).toBe(1);
    expect(phoneSection(c.text()).split('\n').slice(-4)).toEqual([
      '! First path          no media path',
      '✗ UDP 7882            failed',
      '✗ TCP 7881            failed',
      "                      → The HTTP side works, but the media ports are closed: open TCP 7881 and UDP 7882 to this machine (router forwarding at home; the provider's firewall or security group on a VPS; and this machine's own firewall).",
    ]);
  });

  test('phone test: all good says so', async () => {
    const c = ctx({ argv: ['doctor', '--json'], tty: true });
    const ctl = control({ states: [{ state: 'done', report: REPORT }] });
    expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: ctl.client, checks: [fakeCheck('a', 'ok')] })).toBe(0);
    expect(c.text()).toContain('✓ The phone reached Telinha over UDP and TCP.');
  });

  test('phone test: an expired link is a warning, not a failure', async () => {
    const c = ctx({ argv: ['doctor', '--json'], tty: true });
    const ctl = control({ states: [{ state: 'pending' }, { state: 'expired' }] });
    expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: ctl.client, checks: [fakeCheck('a', 'ok')] })).toBe(0);
    expect(c.text()).toContain('The link expired');
  });

  test('Ctrl+C skips the wait', async () => {
    const c = ctx({ argv: ['doctor', '--json'], tty: true });
    const ctl = control({ states: ['hang'] });
    let interrupt = () => {};
    let removed = false;
    const p = run(args, c.ctx, {
      qr: () => 'QR', out: c.out, control: ctl.client, checks: [fakeCheck('a', 'ok')],
      onInterrupt: (fn) => {
        interrupt = fn;
        return () => void (removed = true);
      },
    });
    await Bun.sleep(20);
    interrupt();
    expect(await p).toBe(0);
    expect(removed).toBe(true);
    expect(c.text()).toContain('Phone test skipped.');
  });

  test('--json with the phone test: the report is in the JSON', async () => {
    const c = ctx({ argv: ['doctor', '--json'], tty: true });
    const ctl = control({ states: [{ state: 'done', report: REPORT }] });
    expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: ctl.client, checks: [fakeCheck('a', 'ok')] })).toBe(0);
    expect((JSON.parse(c.json.join('\n')) as { phone: DoctorReport }).phone).toEqual(REPORT);
  });

  test('pt-BR', async () => {
    const c = ctx({ argv: ['doctor', '--json'], tty: true, locale: 'pt-BR' });
    const ctl = control({ available: false });
    await run(args, c.ctx, { ...noPhone, out: c.out, control: ctl.client, checks: [fakeCheck('a', 'ok')] });
    expect(c.text()).toContain('Inicie a Telinha');
  });
});

describe('telinha doctor on a terminal', () => {
  function runner(code: number) {
    const calls: Parameters<DoctorTuiRunner>[0][] = [];
    const tui: DoctorTuiRunner = async (o) => (calls.push(o), code);
    return { tui, calls };
  }

  test('the interactive doctor runs, gets the flags, and its exit code is the result', async () => {
    const c = ctx({ argv: ['doctor', '--no-phone', '--local'], tty: true });
    const r = runner(1);
    const seen: CheckContext[] = [];
    const ctl = control();
    const checks = [fakeCheck('a', 'ok', {}, seen)];
    expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: ctl.client, checks, tui: r.tui })).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.flags).toEqual({ phone: false, local: true });
    expect(r.calls[0]!.ctx).toBe(c.ctx);
    expect(r.calls[0]!.deps.checks).toBe(checks);
    // Nothing ran or printed on the plain side.
    expect(seen).toEqual([]);
    expect(ctl.calls).toEqual([]);
    expect(c.text()).toBe('');
    expect(c.json).toEqual([]);
  });

  test('no terminal (setup runs it this way) and --json stay plain', async () => {
    for (const o of [{ argv: ['doctor', '--no-phone'], tty: false }, { argv: ['doctor', '--json', '--no-phone'], tty: true }]) {
      const c = ctx(o);
      const r = runner(9);
      expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: control().client, checks: [fakeCheck('a', 'ok')], tui: r.tui })).toBe(0);
      expect(r.calls).toEqual([]);
    }
  });

  test('a usage error never opens the interactive doctor', async () => {
    const c = ctx({ argv: ['doctor', '--jsonn'], tty: true });
    const r = runner(0);
    expect(await run(args, c.ctx, { ...noPhone, out: c.out, control: control().client, checks: [], tui: r.tui })).toBe(2);
    expect(r.calls).toEqual([]);
  });
});
