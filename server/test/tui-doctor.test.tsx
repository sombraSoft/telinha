import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliRenderer } from '@opentui/core';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import type { CliContext } from '../src/cli/args.ts';
import { resolvePaths } from '../src/paths.ts';
import type { DoctorReport, DoctorSessionState } from '../src/cli/control.ts';
import type { DoctorControl } from '../src/cli/doctor.ts';
import type { Locale } from '../src/cli/strings.ts';
import { checkTitle } from '../src/doctor/checks.ts';
import type { Check, CheckContext, CheckStatus } from '../src/doctor/types.ts';
import { runDoctorTui } from '../src/tui/doctor/index.tsx';
import { DoctorScreen } from '../src/tui/doctor/screen.tsx';
import { phoneReportRows } from '../src/tui/doctor/state.ts';
import { qrRows } from '../src/tui/ui/qr.tsx';
import { frame, press, settle, until, VERSION, withTui, type Session } from './tui-harness.tsx';

// A real link: the public address with its port and a 43-character token (a 45-module code).
const TOKEN = 'Xq3vN8rT2mK7pL5wZ9cB4dF6gH1jS0aY-eU_iO2kR7t'; // gitleaks:allow
const URL = `https://my-group.duckdns.org:8443/doctor?t=${TOKEN}`;
const NOW = 1_000_000;
// Blocks on every platform: Windows needs WT_SESSION for them.
const ENV = { WT_SESSION: '1' };

const REPORT: DoctorReport = {
  https: { ok: true, latencyMs: 80 },
  signaling: { ok: true },
  initial: { protocol: 'udp', candidateIp: '203.0.113.7', rttMs: 40 },
  tcp: { ok: true, rttMs: 60 },
  udp: { ok: true, rttMs: 40 },
  publish: { ok: true },
  client: { ua: 'phone' },
  startedAt: 1,
  finishedAt: 2,
};

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

interface Spec { id: string; status: CheckStatus; summary: string; detail?: string[]; fix?: string; wait?: Promise<void> }

const fake = (s: Spec): Check => ({
  id: s.id,
  async run(ctx) {
    if (s.wait) await s.wait;
    return { id: s.id, title: checkTitle(s.id, ctx.locale), status: s.status, summary: s.summary, ...(s.detail ? { detail: s.detail } : {}), ...(s.fix ? { fix: s.fix } : {}) };
  },
});

const SPECS: Spec[] = [
  { id: 'config', status: 'ok', summary: 'telinha.env is valid' },
  { id: 'discord-token', status: 'ok', summary: 'Signed in as Telinha#4410', detail: ['Intents: guild members'] },
  { id: 'dns', status: 'ok', summary: 'gurizada.duckdns.org points at 203.0.113.7' },
  { id: 'gateway', status: 'fail', summary: 'UDP 7882 is not reachable from the internet', detail: ['Router: 192.168.0.1 (UPnP)'], fix: 'Forward UDP 7882 on your router to 192.168.0.23, then run telinha doctor again.' },
  { id: 'cgnat', status: 'skip', summary: 'Skipped: needs the internet' },
  { id: 'update', status: 'warn', summary: '0.9.1 is available (running 0.9.0)', fix: 'Installs by itself when no room is open, or now: telinha update --now' },
];

function control(o: { available?: boolean; states?: (DoctorSessionState | 'hang')[] } = {}) {
  const calls: string[] = [];
  const states = [...(o.states ?? [])];
  const pending: ((s: DoctorSessionState) => void)[] = [];
  const client: DoctorControl = {
    available: async () => (calls.push('available'), o.available ?? true),
    status: async () => ({}) as never,
    doctorSession: async () => (calls.push('session'), { id: 'abc', url: URL, expiresAt: NOW + 600_000 }),
    doctorWait: (id) => {
      calls.push(`wait ${id}`);
      const next = states.shift() ?? 'hang';
      return next === 'hang' ? new Promise<DoctorSessionState>((r) => pending.push(r)) : Promise.resolve(next);
    },
  };
  /** Answers the poll that is waiting. */
  const answer = (s: DoctorSessionState) => pending.splice(0).forEach((r) => r(s));
  return { client, calls, answer };
}

function screen(o: { specs?: Spec[]; ctl?: DoctorControl | null; exits?: number[]; builds?: { n: number }; locale?: Locale; env?: Record<string, string> } = {}) {
  const exits = o.exits ?? [];
  return () => (
    <DoctorScreen
      locale={o.locale ?? 'en'}
      version={VERSION}
      checks={(o.specs ?? SPECS).map(fake)}
      buildContext={async () => {
        if (o.builds) o.builds.n++;
        return { locale: o.locale ?? 'en' } as CheckContext;
      }}
      phone={o.ctl === null ? null : { control: o.ctl ?? control({ available: false }).client, env: o.env ?? ENV, config: null, now: () => NOW }}
      onExit={(c) => exits.push(c)}
    />
  );
}

async function done(s: Session) {
  return until(s, /\d+ ok · /);
}

describe('doctor screen', () => {
  test('rows in order with spinners, then results; expand shows detail and fix; q exits 1 on a failure', async () => {
    const g = gate();
    const specs = SPECS.map((x, i) => (i >= 3 ? { ...x, wait: g.p } : x));
    const exits: number[] = [];
    await withTui(screen({ specs, ctl: null, exits }), {}, async (s) => {
      let f = await until(s, 'Updates');
      expect(f).toContain('Running checks…');
      expect(f).toMatch(/Configuration +telinha\.env is valid/);
      // Still running: a spinner and "…" instead of a summary.
      expect(f).toMatch(/⠋ Router +…/);
      const order = ['Configuration', 'Discord bot token', 'DNS', 'Router', 'Carrier NAT', 'Updates'].map((x) => f.indexOf(x));
      expect(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]!))).toBe(true);
      g.open();
      f = await done(s);
      expect(f).toContain('3 ok · 1 warning · 1 failed · 1 skipped');
      expect(f).toContain('❯ ▸ ✔ Configuration');
      await press(s, 'enter');
      expect(frame(s)).toContain('Nothing to do.');
      await press(s, 'enter', 'down', 'down', 'down', 'space');
      f = frame(s);
      expect(f).toContain('❯ ▾ ✖ Router');
      expect(f).toContain('Router: 192.168.0.1 (UPnP)');
      expect(f).toContain('└ Fix');
      expect(f).toContain('Forward UDP 7882 on your router');
      await press(s, 'right');
      expect(frame(s)).not.toContain('└ Fix');
      await press(s, 'q');
      expect(exits).toEqual([1]);
    });
  });

  test('r runs the checks again with a fresh context', async () => {
    const builds = { n: 0 };
    let g = gate();
    const specs = SPECS.map((x) => ({ ...x, status: 'ok' as const, get wait() { return g.p; } }));
    const exits: number[] = [];
    await withTui(screen({ specs, ctl: null, exits, builds }), {}, async (s) => {
      g.open();
      expect(await done(s)).toContain('6 ok · 0 warnings · 0 failed');
      g = gate();
      await press(s, 'r');
      const f = await until(s, 'Running checks…');
      expect(f).toMatch(/⠋ Configuration +…/);
      expect(builds.n).toBe(2);
      g.open();
      await done(s);
      await press(s, 'escape');
      expect(exits).toEqual([0]);
    });
  });

  test('phone test: link and QR, s skips, p starts again, the report becomes rows with hints', async () => {
    const ctl = control();
    const exits: number[] = [];
    await withTui(screen({ specs: SPECS.slice(0, 2), ctl: ctl.client, exits }), {}, async (s) => {
      let f = await until(s, 'Waiting for the phone (10:00)');
      expect(f).toContain('Open this on your phone with Wi-Fi');
      // The link wraps inside the panel, in full.
      expect(f).toContain('https://my-group.duckdns.org:8443/doctor?t=Xq');
      expect(f).toContain(TOKEN.slice(-20));
      expect(f).toContain('▀▀▀▀▀▀▀▀');
      expect(f).toContain('s skip');
      expect(f).toContain('p phone test');
      await press(s, 's');
      f = await until(s, 'Phone test skipped.');
      expect(f).toContain('Press p to start a new phone test.');
      expect(f).not.toContain('▀▀▀▀');
      await press(s, 'p');
      await until(s, 'Waiting for the phone');
      ctl.answer({ state: 'opened', openedAt: 1 });
      await until(s, 'Opened on the phone, testing...');
      ctl.answer({ state: 'done', openedAt: 1, report: { ...REPORT, udp: { ok: false }, tcp: { ok: false }, initial: null } });
      f = await until(s, 'LiveKit connection');
      expect(f).not.toContain('▀▀▀▀');
      expect(f).toMatch(/│ {2}Phone test +│/);
      expect(f).toMatch(/✖ UDP 7882 +failed/);
      expect(f).toMatch(/✖ TCP 7881 +failed/);
      expect(f).toMatch(/✔ HTTPS +80 ms/);
      await press(s, 'down', 'down', 'down', 'down', 'down', 'down', 'enter');
      f = frame(s);
      expect(f).toContain('❯ ▾ ✖ UDP 7882');
      expect(f).toContain('open TCP 7881 and UDP 7882 to this machine');
      expect(ctl.calls.filter((x) => x === 'session')).toHaveLength(2);
      await press(s, 'q');
      // The checks passed; the phone test failed.
      expect(exits).toEqual([1]);
    });
  });

  test('the QR code of a real link: whole (the header gives way when needed) or the link alone, never cut', async () => {
    const modules = qrRows(URL, true).length;
    const cases: { width: number; height: number; env: Record<string, string>; qr: boolean; header: boolean }[] = [
      { width: 120, height: 34, env: ENV, qr: true, header: false },
      { width: 160, height: 40, env: ENV, qr: true, header: true },
      { width: 80, height: 30, env: ENV, qr: true, header: false },
      { width: 80, height: 24, env: ENV, qr: false, header: true },
      // Two spaces per module: 90 columns and 45 rows.
      { width: 120, height: 34, env: { TERM: 'linux' }, qr: false, header: true },
    ];
    for (const k of cases) {
      await withTui(screen({ ctl: control().client, env: k.env }), { width: k.width, height: k.height }, async (s) => {
        const f = await until(s, 'Waiting for the phone (10:00)');
        const lines = f.trimEnd().split('\n');
        const where = `${k.width}x${k.height} ${k.env.TERM ?? 'blocks'}:\n${f}`;
        expect(lines.length, where).toBe(k.height);
        expect(lines.at(-1), where).toContain('q quit');
        expect(f.includes('Screen sharing for your Discord group'), where).toBe(k.header);
        expect(f, where).toContain(TOKEN.slice(-10));
        if (k.qr) {
          expect(lines.filter((l) => /▀{20}/.test(l)).length, where).toBe(modules);
          // The status above the code.
          expect(f.indexOf('Waiting for the phone'), where).toBeLessThan(f.indexOf('▀▀▀▀'));
        } else {
          expect(f, where).not.toMatch(/▀{4}/);
          expect(f, where).toContain('Make the window larger to see the');
        }
      });
    }
  });

  test('an expired link is a warning; the service not running gets the note', async () => {
    const expired = control({ states: [{ state: 'pending' }, { state: 'expired' }] });
    const exits: number[] = [];
    await withTui(screen({ specs: SPECS.slice(0, 1), ctl: expired.client, exits }), {}, async (s) => {
      await until(s, 'The link expired');
      await press(s, 'q');
      expect(exits).toEqual([0]);
    });
    const down = control({ available: false });
    await withTui(screen({ specs: SPECS.slice(0, 1), ctl: down.client }), {}, async (s) => {
      const f = await until(s, 'Start Telinha to run the phone');
      expect(f).not.toContain('s skip');
      expect(down.calls).toEqual(['available']);
    });
  });

  test('pt-BR', async () => {
    await withTui(screen({ ctl: control({ available: false }).client, locale: 'pt-BR' }), { locale: 'pt-BR' }, async (s) => {
      const f = await until(s, 'Inicie a Telinha');
      expect(f).toContain('telinha diagnóstico');
      expect(f).toContain('Compartilhamento de tela pro seu grupo do Discord');
      expect(f).toContain('Verificações desta instalação');
      expect(f).toContain('3 ok · 1 aviso · 1 com falha · 1 pulado');
      expect(f).toContain('rodar de novo');
      expect(f).toContain('Teste no celular');
    });
  });

  test('phone rows: hints land on the row they explain', () => {
    const rows = phoneReportRows({ ...REPORT, udp: { ok: false, error: 'fell back to TCP' } }, null, 'en');
    expect(rows.map((r) => [r.title, r.status])).toEqual([
      ['HTTPS', 'ok'], ['LiveKit connection', 'ok'], ['Sending video', 'ok'], ['First path', 'ok'], ['UDP 7882', 'warn'], ['TCP 7881', 'ok'],
    ]);
    expect(rows[4]!.summary).toBe('failed: fell back to TCP');
    expect(rows[4]!.fix).toContain('UDP 7882 is not reachable from the internet');
    const down = phoneReportRows({ ...REPORT, signaling: { ok: false, error: 'timeout' } }, null, 'pt-BR');
    expect(down[1]!.status).toBe('fail');
    expect(down[1]!.fix).toContain('A Telinha não é acessível pela internet');
  });
});

describe('runDoctorTui', () => {
  test('builds the context from the CLI, runs the checks in a renderer, q gives the exit code', async () => {
    const home = mkdtempSync(join(tmpdir(), 'telinha-tui-doc-'));
    try {
      const env = { TELINHA_HOME: home, TELINHA_THEME: 'dark' };
      const ctx: CliContext = {
        argv: ['doctor', '--local'], env, paths: resolvePaths(env), envFile: join(home, 'config', 'telinha.env'), locale: 'en', tty: true, yes: false,
        stdout: () => {}, stderr: () => {}, compiled: false, version: 'test',
      };
      const seen: CheckContext[] = [];
      const checks: Check[] = [{ id: 'config', async run(c) { seen.push(c); return { id: 'config', title: 'Configuration', status: 'fail', summary: 'missing' }; } }];
      let setup!: TestRendererSetup;
      const ctl = control();
      const p = runDoctorTui({ ctx, flags: { local: true }, deps: { checks, control: ctl.client } }, {
        createRenderer: async () => {
          setup = await createTestRenderer({ width: 100, height: 30 });
          return setup.renderer as CliRenderer;
        },
        proc: { on: () => {}, off: () => {}, exit: () => {} },
      });
      for (let i = 0; i < 100 && !seen.length; i++) await Bun.sleep(10);
      await Bun.sleep(30);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain('0 ok · 0 warnings · 1 failed');
      setup.mockInput.pressKey('q');
      expect(await p).toBe(1);
      expect(seen[0]!.local).toBe(true);
      expect(seen[0]!.configError).toContain('missing env');
      // --local: no phone test.
      expect(ctl.calls).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('doctor frames', () => {
  const sizes = [[120, 34], [80, 30]] as const;
  const locales: Locale[] = ['en', 'pt-BR'];

  for (const [width, height] of sizes) {
    for (const locale of locales) {
      test(`results with an expanded row, ${locale} ${width}x${height}`, async () => {
        const ctl = control({ states: [{ state: 'done', report: { ...REPORT, udp: { ok: false } } }] });
        await withTui(screen({ ctl: ctl.client, locale }), { width, height, locale }, async (s) => {
          await until(s, locale === 'en' ? 'LiveKit connection' : 'Conexão com o LiveKit');
          await press(s, 'down', 'down', 'down', 'enter');
          await settle(s);
          expect(frame(s)).toMatchSnapshot();
        });
      });

      test(`waiting for the phone, ${locale} ${width}x${height}`, async () => {
        const ctl = control();
        await withTui(screen({ ctl: ctl.client, locale }), { width, height, locale }, async (s) => {
          await until(s, locale === 'en' ? 'Waiting for the phone' : 'Esperando o celular');
          expect(frame(s)).toMatchSnapshot();
        });
      });
    }
  }
});
