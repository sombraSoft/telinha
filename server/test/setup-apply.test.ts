import { describe, expect, test } from 'bun:test';
import type { CliContext } from '../src/cli/args.ts';
import {
  type ApplyHooks,
  type ApplyOptions,
  type ApplyTarget,
  backTarget,
  planTasks,
  runApply,
  type SecretMemo,
  silentOut,
  TASKS,
  type TaskId,
  TaskList,
  type TaskRow,
} from '../src/cli/setup/apply.ts';
import { at } from '../src/cli/setup/apply-strings.ts';
import { createDiscordSetup } from '../src/cli/setup/discord.ts';
import type { HostInfo } from '../src/cli/setup/host.ts';
import { type SetupDeps, type SetupFs, SYSCTL_SCRIPT, type Values, type Wizard } from '../src/cli/setup/steps.ts';
import { t } from '../src/cli/setup/strings.ts';
import type { Spinner, Term } from '../src/cli/term.ts';
import type { Ddns } from '../src/ddns.ts';
import type { CheckResult } from '../src/doctor/types.ts';
import { parseEnvFile } from '../src/envfile.ts';
import { resolvePaths } from '../src/paths.ts';
import type { ServiceManager, SpawnOutcome } from '../src/service/index.ts';

const APP = '111111111111111111';
const GUILD = '222222222222222222';
const ROLE = '333333333333333333';
const CHANNEL = '444444444444444441';
const TOKEN = 'Rk7wQz3NvX9pLm2TbC5hJd'; // gitleaks:allow
const SECRET = 'Pw8zHn4Vq2KxMt7RcB3s'; // gitleaks:allow
const DUCK = '9b4e2c7a1f6d3b8e0a5c'; // gitleaks:allow

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const discordFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input).replace('https://discord.com/api/v10', '');
  const auth = new Headers(init?.headers).get('authorization');
  if (url === '/oauth2/token')
    return auth === `Basic ${Buffer.from(`${APP}:${SECRET}`).toString('base64')}`
      ? json({})
      : json({ error: 'invalid_client' }, 401);
  if (auth !== `Bot ${TOKEN}`) return json({ message: '401: Unauthorized' }, 401);
  if (url === '/applications/@me')
    return json({
      id: APP,
      name: 'Telinha Bot',
      flags: (1 << 13) | (1 << 15),
      redirect_uris: ['https://t.example.com/auth/callback'],
    });
  if (url === '/users/@me/guilds') return json([{ id: GUILD, name: 'Gurizada' }]);
  if (url === `/guilds/${GUILD}/roles`) return json([{ id: ROLE, name: 'Membro', position: 1 }]);
  if (url === `/guilds/${GUILD}/channels`) return json([{ id: CHANNEL, name: 'geral', type: 0, position: 0 }]);
  return json({ message: 'Unknown' }, 404);
}) as unknown as typeof fetch;

/** The plain terminal's calls, one entry each. */
class Sink implements Term {
  out: string[] = [];
  progressCalls: [number, number | null, string][] = [];
  colors = false;
  style = {
    bold: (s: string) => s,
    dim: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
  };
  info = (m: string) => void this.out.push(m);
  ok = (m: string) => void this.out.push(`ok ${m}`);
  warn = (m: string) => void this.out.push(`warn ${m}`);
  fail = (m: string) => void this.out.push(`fail ${m}`);
  step = (m: string) => void this.out.push(`step ${m}`);
  line = (m = '') => void this.out.push(m);
  spinner(label: string): Spinner {
    this.out.push(`spin ${label}`);
    return {
      update: (l) => void this.out.push(`spin ${l}`),
      stop: (l) => void this.out.push(`ok ${l ?? label}`),
      fail: (l) => void this.out.push(`fail ${l ?? label}`),
    };
  }
  table = (rows: string[][]) => void this.out.push(...rows.map((r) => r.join(' ')));
  link = (u: string) => u;
  progress = (done: number, total: number | null, label: string) => void this.progressCalls.push([done, total, label]);
}

interface Opts {
  platform?: NodeJS.Platform;
  isRoot?: boolean;
  compiled?: boolean;
  files?: Record<string, string>;
  spawn?: (cmd: string[], files: Map<string, string>) => SpawnOutcome;
  available?: boolean;
  install?: () => Promise<never>;
  random?: (n: number) => Uint8Array;
  checks?: CheckResult[];
  cert?: boolean;
  bins?: SetupDeps['bins'];
  doctor?: SetupDeps['doctor'];
  home?: string;
}

/** Every fake random call differs, across runs too. */
let seq = 0;

const HOST: HostInfo = {
  kind: 'linux-root',
  platform: 'linux',
  arch: 'x64',
  isRoot: true,
  docker: false,
  osName: 'Debian',
  publicIp: '203.0.113.9',
  nat: null,
};

function make(o: Opts = {}) {
  const platform = o.platform ?? 'linux';
  const home = o.home ?? (platform === 'win32' ? 'C:\\T' : '/opt/telinha');
  const files = new Map(Object.entries(o.files ?? {}));
  const rec = {
    spawn: [] as string[][],
    interactive: [] as string[][],
    ddns: [] as string[],
    doctor: [] as { tty: boolean; argv: string[] }[],
    checks: 0,
    cert: 0,
  };
  const fs: SetupFs = {
    mkdir: async () => {},
    createFile: async (p, data) => void files.set(p, data),
    rename: async (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    chmod: async () => {},
    chown: async () => {},
    stat: async (p) =>
      files.has(p)
        ? { uid: 0, gid: 0, mode: 0o100600 }
        : p.includes('.')
          ? null
          : { uid: 0, gid: 0, mode: 0o40700, dir: true },
    rm: async (p) => void files.delete(p),
    readText: async (p) => files.get(p) ?? null,
    exists: async (p) => files.has(p),
    copyFile: async (_a, b) => void files.set(b, 'binary'),
  };
  const manager = (user: boolean): ServiceManager => ({
    kind: user ? 'systemd-user' : 'systemd-system',
    install:
      o.install ?? (async () => ({ ok: true, steps: { task: 'ok', firewall: 'skipped', start: 'ok' }, hints: [] })),
    uninstall: async () => {},
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    status: async () => ({ installed: true, running: true, enabled: true, detail: '' }),
  });

  const deps = {
    discord: (token: string) =>
      createDiscordSetup({ token, fetch: discordFetch, version: 'test', sleep: async () => {} }),
    ddns: ({ domain }: { domain: string }): Ddns => {
      let last: ReturnType<Ddns['last']> = null;
      return {
        async update(ip) {
          rec.ddns.push(`${domain} ${ip}`);
          last = { ip, at: 1, ok: true };
        },
        last: () => last,
      };
    },
    serviceManager: ({ user }: { user: boolean }) => manager(user),
    control: {
      available: async () => o.available ?? false,
      shutdown: async () => {},
      status: async () => ({ supervised: true }),
      doctorSession: async () => ({ id: 's', url: 'https://x', expiresAt: 0 }),
      doctorWait: async () => ({ state: 'expired' }),
    },
    bins: o.bins ?? (async () => {}),
    spawn: async (cmd: string[]) => {
      rec.spawn.push(cmd);
      return o.spawn?.(cmd, files) ?? { code: 0, stdout: '', stderr: '' };
    },
    spawnInteractive: async (cmd: string[]) => (rec.interactive.push(cmd), 0),
    fs,
    platform,
    arch: 'x64',
    isRoot: o.isRoot ?? true,
    random: o.random ?? ((k: number) => new Uint8Array(k).fill(++seq % 256)),
    now: (() => {
      let t0 = 0;
      return () => (t0 += 1000);
    })(),
    sleep: async () => {},
    doctor: o.doctor ?? (async (c: CliContext) => (rec.doctor.push({ tty: c.tty, argv: c.argv }), 0)),
    doctorChecks: async (_c: CliContext, onResult?: (r: CheckResult, done: number, total: number) => void) => {
      rec.checks++;
      const all = o.checks ?? [];
      for (const [i, r] of all.entries()) onResult?.(r, i + 1, all.length);
      return all;
    },
    execPath: platform === 'win32' ? `${home}\\bin\\telinha.exe` : `${home}/bin/telinha`,
    which: () => null,
    certReady: async () => (rec.cert++, o.cert ?? true),
    nat: { probe: async () => ({ gateway: null, externalIp: null, localIp: null, errors: [] }) },
  } as unknown as SetupDeps;
  const env = { TELINHA_HOME: home, SystemRoot: 'C:\\Windows' };
  const ctx: CliContext = {
    argv: ['setup'],
    env,
    paths: resolvePaths(env, platform, o.isRoot ?? true),
    envFile: '',
    locale: 'en',
    tty: true,
    yes: false,
    stdout: () => {},
    stderr: () => {},
    compiled: o.compiled ?? true,
    version: 'test',
  };
  ctx.envFile = platform === 'win32' ? `${home}\\config\\telinha.env` : `${home}/config/telinha.env`;
  const sink = new Sink();
  const w: Wizard = { ctx, deps, out: sink, locale: 'en', s: (k, p) => t('en', k, p), host: HOST, docker: false };
  const target: ApplyTarget = { file: ctx.envFile, shown: ctx.envFile, previous: null };
  return { w, deps, rec, files, sink, target };
}

/** A complete own-domain VPS file's values. */
const VALUES = (more: Values = {}): Values => ({
  HOSTING: 'vps',
  INGRESS: 'direct',
  PUBLIC_URL: 'https://t.example.com',
  HTTP_PORT: '80',
  HTTPS_PORT: '443',
  UPNP: 'off',
  DISCORD_TOKEN: TOKEN,
  DISCORD_CLIENT_ID: APP,
  DISCORD_CLIENT_SECRET: SECRET,
  GUILD_ID: GUILD,
  ROLE_ID: ROLE,
  CHANNEL_IDS: CHANNEL,
  ...more,
});

const OPTS = (more: Partial<ApplyOptions> = {}): ApplyOptions => ({
  docker: false,
  compiled: true,
  sysctl: 'auto',
  rotateCookie: false,
  doctorMode: 'data',
  tray: null,
  flags: { noService: false, noFirewall: false, noUpnp: false, noDoctor: false, offline: false },
  ...more,
});

/** Each value in turn, a repeat of the one before dropped. */
const changes = <T>(xs: T[]): T[] => xs.filter((x, i) => i === 0 || JSON.stringify(x) !== JSON.stringify(xs[i - 1]));

/** Records every decision and every state of the task list; decide answers from a script (then skip). */
function hooks(script: ('retry' | 'skip' | 'back' | 'abort')[] = []) {
  const tasks = new TaskList();
  /** The rows after each change. */
  const seen: TaskRow[][] = [];
  tasks.subscribe(() => void seen.push(tasks.rows));
  const decided: [TaskId, string][] = [];
  const terminal: string[][] = [];
  let inTerminal = false;
  const h: ApplyHooks = {
    decide: async (id, error) => (decided.push([id, error]), script.shift() ?? 'skip'),
    withTerminal: async (fn, intro) => {
      terminal.push(intro ?? []);
      inTerminal = true;
      try {
        return await fn();
      } finally {
        inTerminal = false;
      }
    },
  };
  const row = (id: TaskId) => seen.flatMap((rows) => rows.filter((r) => r.id === id));
  /** The statuses the row went through (a retry shows as running again). */
  const statuses = (id: TaskId) => changes(row(id).map((r) => r.status));
  const details = (id: TaskId) =>
    changes(
      row(id)
        .map((r) => r.detail)
        .filter(Boolean),
    );
  const progress = (id: TaskId) => changes(row(id).flatMap((r) => (r.progress ? [r.progress] : [])));
  /** The latest attempt's lines. */
  const lines = (id: TaskId) => (tasks.rows.find((r) => r.id === id)?.lines ?? []).map((l) => `${l.kind} ${l.text}`);
  return { h, tasks, seen, decided, terminal, statuses, details, progress, lines, inTerminal: () => inTerminal };
}

describe('planTasks', () => {
  const flags = (f: Partial<ApplyOptions['flags']>) => OPTS({ flags: { ...OPTS().flags, ...f } });
  test('native: Discord, the file, programs, service, router, start, certificate, doctor', () => {
    expect(planTasks(VALUES(), OPTS())).toEqual([
      'discord',
      'config',
      'binaries',
      'service',
      'router',
      'start',
      'cert',
      'doctor',
    ]);
  });
  test('DuckDNS adds its update before the file', () => {
    expect(planTasks(VALUES({ DDNS_PROVIDER: 'duckdns' }), OPTS()).slice(0, 3)).toEqual([
      'discord',
      'duckdns',
      'config',
    ]);
  });
  test('docker writes the file only', () => {
    expect(planTasks(VALUES({ DDNS_PROVIDER: 'duckdns' }), OPTS({ docker: true }))).toEqual([
      'discord',
      'duckdns',
      'config',
    ]);
    expect(planTasks(VALUES(), OPTS({ docker: true, flags: { ...OPTS().flags, offline: true } }))).toEqual(['config']);
  });
  test('--no-discord-check, --no-service, --no-upnp, --no-doctor each drop their task', () => {
    expect(planTasks(VALUES(), flags({ offline: true }))[0]).toBe('config');
    expect(planTasks(VALUES(), flags({ noService: true }))).not.toContain('service');
    expect(planTasks(VALUES(), flags({ noUpnp: true }))).not.toContain('router');
    expect(planTasks(VALUES(), flags({ noDoctor: true }))).toEqual([
      'discord',
      'config',
      'binaries',
      'service',
      'router',
      'start',
    ]);
  });
  test('the tray icon right after the service, when there is one (native Windows)', () => {
    const tray = { install: true, autostart: null };
    expect(planTasks(VALUES(), OPTS({ tray }))).toEqual([
      'discord',
      'config',
      'binaries',
      'service',
      'tray',
      'router',
      'start',
      'cert',
      'doctor',
    ]);
    // --no-service keeps the icon: it shows Telinha started by hand too.
    expect(planTasks(VALUES(), OPTS({ tray, flags: { ...OPTS().flags, noService: true } })).slice(2, 4)).toEqual([
      'binaries',
      'tray',
    ]);
    expect(planTasks(VALUES(), OPTS({ tray, docker: true }))).not.toContain('tray');
  });
  test('a tunnel or an own proxy has no certificate of its own to wait for', () => {
    expect(planTasks(VALUES({ INGRESS: 'tunnel' }), OPTS())).not.toContain('cert');
    expect(planTasks(VALUES({ INGRESS: 'external' }), OPTS())).not.toContain('cert');
  });
  test('labels and failure hints exist in both languages; back lands on a question that is asked, else the Review', () => {
    for (const id of Object.keys(TASKS) as TaskId[]) {
      for (const l of ['en', 'pt-BR'] as const) {
        expect(at(l, TASKS[id].label)).not.toBe('');
        expect(at(l, TASKS[id].hint)).not.toBe('');
      }
    }
    expect(backTarget('discord', ['discordToken'])).toBe('discordToken');
    expect(backTarget('service', ['discordToken', 'sysctl'])).toBe('sysctl');
    expect(backTarget('service', ['discordToken'])).toBe('review');
    expect(backTarget('router', ['upnp'])).toBe('upnp');
    expect(backTarget('router', [])).toBe('review');
    expect(backTarget('config', ['discordToken'])).toBe('review');
  });
});

describe('runApply', () => {
  test('rows: every task pending first, then running and a final status; lines are what the plain output printed', async () => {
    const { w, sink, target, files } = make({ compiled: false, available: false });
    const r = hooks();
    const result = await runApply(
      w,
      target,
      VALUES(),
      ['discord', 'config', 'binaries', 'service', 'start'],
      OPTS({ compiled: false }),
      r.h,
      r.tasks,
    );
    expect(result.kind).toBe('done');
    expect(r.seen[0]!.map((e) => `${e.id} ${e.status}`)).toEqual([
      'discord pending',
      'config pending',
      'binaries pending',
      'service pending',
      'start pending',
    ]);
    expect(r.statuses('discord')).toEqual(['pending', 'running', 'ok']);
    expect(r.statuses('config')).toEqual(['pending', 'running', 'ok']);
    // From source the service row says why nothing is installed.
    expect(r.statuses('service')).toEqual(['pending', 'running', 'skipped']);
    expect(r.lines('service')).toEqual([
      'info Running from source: no service is installed (the native binary installs one).',
    ]);
    // Nothing installed, nothing running: start it by hand, a warning.
    expect(r.statuses('start')).toEqual(['pending', 'running', 'warn']);
    expect(r.lines('config')).toEqual(['ok Wrote /opt/telinha/config/telinha.env']);
    expect(r.details('binaries')).toEqual(['Downloading LiveKit, Caddy...']);
    // The plain terminal got the very same lines, in order, as they came, under the tasks' headers.
    expect(sink.out).toEqual([
      'step Discord',
      `ok Bot: Telinha Bot (app id ${APP})`,
      'ok Wrote /opt/telinha/config/telinha.env',
      'step Programs',
      'spin Downloading LiveKit, Caddy...',
      'ok Programs ready in /opt/telinha/bin',
      'step Service',
      'Running from source: no service is installed (the native binary installs one).',
      'step Start',
      'Start it with: bun server/src/index.ts run',
    ]);
    if (result.kind === 'done')
      expect(result.tasks).toMatchObject({
        discord: 'ok',
        config: 'ok',
        binaries: 'ok',
        service: 'skipped',
        start: 'warn',
        router: 'skipped',
      });
    expect(parseEnvFile(files.get(target.file)!).vars.DISCORD_TOKEN).toBe(TOKEN);
  });

  test('a failure asks decide: retry runs the task again, skip goes on', async () => {
    const { w, target, files } = make();
    const r = hooks(['retry', 'skip']);
    const result = await runApply(
      w,
      target,
      VALUES({ ROLE_ID: '999999999999999999' }),
      ['discord', 'config'],
      OPTS(),
      r.h,
      r.tasks,
    );
    expect(r.decided).toEqual([
      ['discord', 'Role 999999999999999999 does not exist in the Discord server.'],
      ['discord', 'Role 999999999999999999 does not exist in the Discord server.'],
    ]);
    expect(r.statuses('discord')).toEqual(['pending', 'running', 'fail', 'running', 'fail', 'skipped']);
    expect(result).toMatchObject({ kind: 'done', tasks: { discord: 'skipped', config: 'ok' } });
    expect(files.has(target.file)).toBe(true);
  });

  test('back and abort stop the run; abort says whether the file was written', async () => {
    const back = make();
    expect(
      await runApply(
        back.w,
        back.target,
        VALUES({ DISCORD_TOKEN: 'nope' }),
        ['discord', 'config'],
        OPTS(),
        hooks(['back']).h,
      ),
    ).toEqual({ kind: 'back', to: 'discord' });
    expect(back.files.size).toBe(0);

    const before = make();
    expect(
      await runApply(
        before.w,
        before.target,
        VALUES({ DISCORD_TOKEN: 'nope' }),
        ['discord', 'config'],
        OPTS(),
        hooks(['abort']).h,
      ),
    ).toEqual({ kind: 'aborted', wrote: false });
    expect(before.files.size).toBe(0);

    // The service never answers: the failure comes after the file.
    const after = make({ available: false });
    const r = hooks(['abort']);
    expect(
      await runApply(
        after.w,
        after.target,
        VALUES(),
        ['config', 'service', 'start', 'doctor'],
        OPTS({ flags: { ...OPTS().flags, offline: true } }),
        r.h,
        r.tasks,
      ),
    ).toEqual({ kind: 'aborted', wrote: true });
    expect(r.decided[0]![0]).toBe('start');
    expect(r.decided[0]![1]).toContain('Telinha does not answer yet');
    expect(r.statuses('doctor')).toEqual(['pending']);
  });

  test('the file cannot be skipped: skipping it stops the run with nothing written', async () => {
    const { w, target, files } = make();
    const r = hooks(['skip']);
    const result = await runApply(
      w,
      target,
      VALUES({ PUBLIC_URL: 'not a url' }),
      ['config', 'binaries', 'start'],
      OPTS(),
      r.h,
      r.tasks,
    );
    expect(r.decided[0]![1]).toStartWith('the resulting configuration is invalid:');
    expect(r.statuses('config')).toEqual(['pending', 'running', 'fail']);
    expect(r.statuses('binaries')).toEqual(['pending']);
    expect(result).toEqual({ kind: 'aborted', wrote: false });
    expect(files.has(target.file)).toBe(false);
  });

  test('a task that throws fails with the error instead of ending the run', async () => {
    const { w, target } = make({ bins: async () => Promise.reject(new Error('boom')) });
    // downloadBinaries turns a failed download into a warning itself.
    const r = hooks();
    expect(await runApply(w, target, VALUES(), ['config', 'binaries'], OPTS(), r.h, r.tasks)).toMatchObject({
      kind: 'done',
      tasks: { binaries: 'warn' },
    });
    expect(r.lines('binaries')).toEqual(['fail Download failed: boom. telinha run tries again at start.']);
    const broken = make({ doctor: async () => Promise.reject(new Error('gone')) });
    broken.w.deps.control.available = () => Promise.reject(new Error('no control'));
    const rb = hooks();
    broken.w.deps.serviceManager = () => {
      throw new Error('no manager');
    };
    expect(
      await runApply(broken.w, broken.target, VALUES(), ['config', 'service'], OPTS(), rb.h, rb.tasks),
    ).toMatchObject({ kind: 'done', tasks: { service: 'skipped' } });
    expect(rb.decided).toEqual([['service', 'no manager']]);
    expect(rb.lines('service')).toContain('fail no manager');
  });

  test('withTerminal only around sudo, with the explanation as its intro', async () => {
    const home = '/home/me/.local/share/telinha';
    const files = { '/proc/sys/net/ipv4/ip_unprivileged_port_start': '1024', [`${home}/bin/telinha`]: 'x' };
    for (const mode of ['sudo', 'auto', 'manual'] as const) {
      const m = make({ isRoot: false, home, files, available: true });
      const seen: { inside: boolean | null } = { inside: null };
      const r = hooks();
      m.w.deps.spawnInteractive = async () => {
        seen.inside = r.inTerminal();
        return 0;
      };
      await runApply(
        m.w,
        m.target,
        VALUES(),
        ['config', 'binaries', 'service', 'router', 'start', 'cert', 'doctor'],
        OPTS({ sysctl: mode }),
        r.h,
        r.tasks,
      );
      if (mode === 'sudo') {
        expect(r.terminal).toEqual([
          [
            'Ports 80, 443 are below 1024: Linux lets only root bind them unless one setting changes.',
            'One sudo command allows ports from 80 up for every user (it survives updates):',
          ],
        ]);
        expect(seen.inside).toBe(true);
        expect(r.lines('service')).toContain('ok Ports from 80 up are allowed now.');
      } else {
        expect(r.terminal).toEqual([]);
        expect(seen.inside).toBeNull();
      }
      expect(m.rec.spawn.some((c) => c.join(' ') === `sudo -n sh -c ${SYSCTL_SCRIPT}`)).toBe(mode === 'auto');
      if (mode === 'manual') expect(r.lines('service')).toContain('warn The setting was not changed.');
    }
  });

  test('Windows UAC: no terminal handover; the service row says what it waits for', async () => {
    const result = { ok: true, steps: { task: 'ok', firewall: 'ok', start: 'ok' }, hints: [] };
    const { w, target } = make({
      platform: 'win32',
      isRoot: false,
      spawn: (cmd, fsFiles) => {
        if (cmd[0]!.endsWith('whoami.exe'))
          return { code: 0, stdout: '"User Name","SID"\r\n"pc\\me","S-1-5-21-9"\r\n', stderr: '' };
        if (cmd[0] === 'powershell' && cmd[4]!.includes('Start-Process'))
          fsFiles.set('C:\\T\\service\\install-result.json', JSON.stringify(result));
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const r = hooks();
    await runApply(w, target, VALUES(), ['config', 'service'], OPTS(), r.h, r.tasks);
    expect(r.terminal).toEqual([]);
    expect(r.details('service')).toEqual(['Approve the Windows administrator prompt…']);
    expect(r.lines('service')).toContain('ok Background task');
    expect(r.statuses('service').at(-1)).toBe('ok');
  });

  test('secrets are made once per session: a retry or a re-apply writes the same ones; a rotation is made once too', async () => {
    const memo: SecretMemo = { made: {} };
    const apply = async (o: Partial<ApplyOptions> = {}, values = VALUES()) => {
      const m = make();
      await runApply(m.w, m.target, values, ['config'], OPTS({ ...o }), hooks().h);
      return parseEnvFile(m.files.get(m.target.file)!).vars;
    };
    const first = await apply({ secrets: memo });
    const again = await apply({ secrets: memo });
    for (const k of ['COOKIE_SECRET', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
      expect(first[k]).toBeTruthy();
      expect(again[k]).toBe(first[k]);
    }
    // Without the session's memo the counter-based random makes new ones.
    expect((await apply()).COOKIE_SECRET).not.toBe(first.COOKIE_SECRET);

    const file = VALUES({
      COOKIE_SECRET: 'Gt5kWq8Zr3Np6Vx1Lm4Bc7Hd9Js2Ya0F', // gitleaks:allow
      LIVEKIT_API_KEY: 'telinhaabcdef12', // gitleaks:allow
      LIVEKIT_API_SECRET: 'Zc4Rn8Wq2Tx6Pk1Vm5Lb9Hs3Jd7Fy0Ga', // gitleaks:allow
    });
    const rot: SecretMemo = { made: {} };
    const r1 = await apply({ secrets: rot, rotateCookie: true }, { ...file });
    const r2 = await apply({ secrets: rot, rotateCookie: true }, { ...file });
    const kept = await apply({ secrets: rot }, { ...file });
    expect(r1.COOKIE_SECRET).not.toBe(file.COOKIE_SECRET);
    expect(r2.COOKIE_SECRET).toBe(r1.COOKIE_SECRET);
    expect(kept.COOKIE_SECRET).toBe(file.COOKIE_SECRET);
    expect(r1.LIVEKIT_API_KEY).toBe('telinhaabcdef12');
  });

  test('byte progress from the downloads: per tool on the row, and the plain terminal hears it', async () => {
    const { w, target, sink } = make({
      bins: async (_c, _p, log, progress) => {
        log('[bins] downloading livekit.tar.gz');
        progress?.('livekit', 0, 2_000_000);
        progress?.('livekit', 2_000_000, 2_000_000);
        progress?.('caddy', 512, null);
      },
    });
    const r = hooks();
    await runApply(w, target, VALUES(), ['config', 'binaries'], OPTS(), r.h, r.tasks);
    expect(r.progress('binaries')).toEqual([
      { done: 0, total: 2_000_000, unit: 'bytes', label: 'livekit' },
      { done: 2_000_000, total: 2_000_000, unit: 'bytes', label: 'livekit' },
      { done: 512, total: null, unit: 'bytes', label: 'caddy' },
    ]);
    expect(r.details('binaries')).toEqual(['Downloading LiveKit, Caddy...', 'downloading livekit.tar.gz']);
    expect(sink.progressCalls).toEqual([
      [0, 2_000_000, 'livekit'],
      [2_000_000, 2_000_000, 'livekit'],
      [512, null, 'caddy'],
    ]);
  });

  test('the certificate wait reports the time waited against its limit', async () => {
    const { w, target, rec } = make({ available: true, cert: false });
    const r = hooks();
    await runApply(w, target, VALUES(), ['config', 'start', 'cert'], OPTS(), r.h, r.tasks);
    const waits = r.progress('cert');
    expect(waits.length).toBeGreaterThan(10);
    expect(waits.every((p) => p.unit === 'ms' && p.total === 90_000)).toBe(true);
    expect(rec.cert).toBe(waits.length + 1);
    expect(r.statuses('cert').at(-1)).toBe('warn');
  });

  test('doctor as data: per-check progress and the results; as the command: plain (tty false), no phone test', async () => {
    const checks: CheckResult[] = [
      { id: 'config', title: 'Configuration', status: 'ok', summary: 'fine' },
      { id: 'dns', title: 'DNS', status: 'fail', summary: 'no A record' },
    ];
    const data = make({ checks });
    const r = hooks();
    const result = await runApply(data.w, data.target, VALUES(), ['config', 'doctor'], OPTS(), r.h, r.tasks);
    expect(r.details('doctor')).toEqual(['1 of 2 checks', '2 of 2 checks']);
    expect(r.progress('doctor')).toEqual([
      { done: 1, total: 2, unit: 'items' },
      { done: 2, total: 2, unit: 'items' },
    ]);
    expect(result).toMatchObject({ kind: 'done', doctor: checks, tasks: { doctor: 'warn' } });
    expect(r.lines('doctor')).toEqual(['warn 1 ok · 0 warnings · 1 failed · 0 skipped']);
    expect(data.rec.doctor).toEqual([]);

    const cli = make();
    await runApply(cli.w, cli.target, VALUES(), ['config', 'doctor'], OPTS({ doctorMode: 'cli' }), hooks().h);
    expect(cli.rec.doctor).toEqual([{ tty: false, argv: ['doctor', '--no-phone'] }]);
    expect(cli.rec.checks).toBe(0);
  });

  test("DuckDNS: the record is set before the file; a refusal fails the task with DuckDNS's words", async () => {
    const m = make();
    const r = hooks();
    const values = VALUES({
      DDNS_PROVIDER: 'duckdns',
      DUCKDNS_DOMAIN: 'my-group',
      DUCKDNS_TOKEN: DUCK,
      PUBLIC_URL: 'https://my-group.duckdns.org',
    });
    await runApply(m.w, m.target, values, ['duckdns', 'config'], OPTS(), r.h, r.tasks);
    expect(m.rec.ddns).toEqual(['my-group 203.0.113.9']);
    expect(r.lines('duckdns')).toEqual(['ok my-group.duckdns.org now points at 203.0.113.9.']);
    const bad = make();
    bad.w.deps.ddns = () => ({ update: async () => {}, last: () => ({ ip: '', at: 1, ok: false, error: 'KO' }) });
    const rb = hooks(['abort']);
    expect(await runApply(bad.w, bad.target, values, ['duckdns', 'config'], OPTS(), rb.h, rb.tasks)).toEqual({
      kind: 'aborted',
      wrote: false,
    });
    expect(rb.decided).toEqual([['duckdns', 'DuckDNS did not accept it: KO']]);
  });

  test('silentOut prints nothing and still hands out spinners', () => {
    const out = silentOut();
    out.info('x');
    const s = out.spinner('y');
    s.update('z');
    s.stop();
    expect(out.colors).toBe(false);
    expect(out.link('https://x')).toBe('https://x');
  });
});

describe('TaskList', () => {
  const plain: ApplyHooks = { decide: async () => 'skip', withTerminal: (fn) => fn() };

  test('a retry starts the row over: it shows the latest attempt only', async () => {
    const { w, target } = make();
    const tasks = new TaskList();
    const atDecide: TaskRow[] = [];
    const script = ['retry', 'skip'] as const;
    const hooks: ApplyHooks = {
      ...plain,
      decide: async () => (atDecide.push(tasks.rows[0]!), script[atDecide.length - 1]!),
    };
    await runApply(w, target, VALUES({ ROLE_ID: '999999999999999999' }), ['discord', 'config'], OPTS(), hooks, tasks);
    const lines = [
      'ok Bot: Telinha Bot (app id 111111111111111111)',
      'fail Role 999999999999999999 does not exist in the Discord server.',
    ];
    expect(atDecide.map((r) => [r.status, ...r.lines.map((l) => `${l.kind} ${l.text}`)])).toEqual([
      ['fail', ...lines],
      ['fail', ...lines],
    ]);
    expect(tasks.rows.map((r) => [r.id, r.status])).toEqual([
      ['discord', 'skipped'],
      ['config', 'ok'],
    ]);
  });

  test("a spinner's next line is the row's result; a line without a spinner is not", async () => {
    const { w, target } = make();
    const tasks = new TaskList();
    const seen: TaskRow[] = [];
    tasks.subscribe(() => void seen.push(...tasks.rows.filter((r) => r.id === 'binaries')));
    await runApply(w, target, VALUES(), ['config', 'binaries'], OPTS(), plain, tasks);
    // While the download runs the spinner is up and nothing has ended it.
    expect(seen.find((r) => r.spinning)).toMatchObject({
      status: 'running',
      detail: 'Downloading LiveKit, Caddy...',
      result: null,
    });
    const [config, binaries] = tasks.rows;
    expect(binaries).toMatchObject({
      status: 'ok',
      spinning: false,
      result: { kind: 'ok', text: 'Programs ready in /opt/telinha/bin' },
    });
    expect(config).toMatchObject({
      status: 'ok',
      result: null,
      lines: [{ kind: 'ok', text: 'Wrote /opt/telinha/config/telinha.env' }],
    });
  });

  test('what is left to do: a warning with its explanation, every router line; the summary leads with the headline', async () => {
    const home = '/home/me/.local/share/telinha';
    const files = { '/proc/sys/net/ipv4/ip_unprivileged_port_start': '1024', [`${home}/bin/telinha`]: 'x' };
    const { w, target } = make({ isRoot: false, home, files, available: true });
    const tasks = new TaskList();
    await runApply(
      w,
      target,
      VALUES(),
      ['config', 'service', 'router', 'start'],
      OPTS({ sysctl: 'manual' }),
      plain,
      tasks,
    );
    const row = (id: TaskId) => tasks.rows.find((r) => r.id === id)!;
    expect(row('service').status).toBe('warn');
    expect(row('service').todo.map((l) => l.kind)).toEqual(['warn', 'info']);
    expect(row('service').todo[0]!.text).toBe('The setting was not changed.');
    expect(row('service').todo[1]!.text).toStartWith('To use 80/443 later: sudo sh -c');
    expect(row('router').todo).toEqual(row('router').lines);
    expect(row('config').todo).toEqual([]);

    const summary = tasks.summary();
    expect(summary.map((r) => [r.id, r.status])).toEqual([
      ['config', 'ok'],
      ['service', 'warn'],
      ['router', 'ok'],
      ['start', 'ok'],
    ]);
    const at = (id: TaskId) => summary.find((r) => r.id === id)!;
    expect(at('config')).toEqual({
      id: 'config',
      status: 'ok',
      headline: { kind: 'ok', text: `Wrote ${home}/config/telinha.env` },
      todo: [],
    });
    // The router's first line heads its row; the rest are what is left to do.
    expect(at('router').headline).toEqual(row('router').lines[0]!);
    expect(at('router').todo).toEqual(row('router').lines.slice(1));
    // A warning row heads with how it went, its warning under it.
    expect(at('service').headline?.kind).toBe('ok');
    expect(at('service').todo).toEqual(row('service').todo);
  });

  test('the summary leaves out what has not finished; a failure heads with its last failed line', async () => {
    const { w, target } = make({ available: false });
    const tasks = new TaskList();
    const offline = OPTS({ flags: { ...OPTS().flags, offline: true } });
    await runApply(
      w,
      target,
      VALUES(),
      ['config', 'service', 'start', 'doctor'],
      offline,
      { ...plain, decide: async () => 'abort' },
      tasks,
    );
    expect(tasks.rows.map((r) => r.status)).toEqual(['ok', 'ok', 'fail', 'pending']);
    const summary = tasks.summary();
    expect(summary.map((r) => [r.id, r.status])).toEqual([
      ['config', 'ok'],
      ['service', 'ok'],
      ['start', 'fail'],
    ]);
    expect(summary[2]!.headline).toEqual(tasks.rows[2]!.lines.findLast((l) => l.kind === 'fail')!);
    expect(summary[2]!.headline?.text).toContain('Telinha does not answer yet');
  });

  test("wrote is the latest run's file, wroteAny any run's; a new run starts the rows over", async () => {
    const tasks = new TaskList();
    expect([tasks.wrote, tasks.wroteAny, tasks.rows]).toEqual([false, false, []]);
    const first = make();
    await runApply(first.w, first.target, VALUES(), ['config'], OPTS(), plain, tasks);
    expect([tasks.wrote, tasks.wroteAny]).toEqual([true, true]);
    const again = make();
    await runApply(
      again.w,
      again.target,
      VALUES({ DISCORD_TOKEN: 'nope' }),
      ['discord', 'config'],
      OPTS(),
      { ...plain, decide: async () => 'abort' },
      tasks,
    );
    expect([tasks.wrote, tasks.wroteAny]).toEqual([false, true]);
    expect(tasks.rows.map((r) => [r.id, r.status])).toEqual([
      ['discord', 'fail'],
      ['config', 'pending'],
    ]);
  });

  test('subscribe hears every change until it unsubscribes; rows is a copy', async () => {
    const tasks = new TaskList();
    let calls = 0;
    const off = tasks.subscribe(() => void calls++);
    const m = make();
    await runApply(m.w, m.target, VALUES(), ['config'], OPTS(), plain, tasks);
    // The plan, the attempt, the line, the end.
    expect(calls).toBe(4);
    off();
    await runApply(m.w, m.target, VALUES(), ['config'], OPTS(), plain, tasks);
    expect(calls).toBe(4);
    const rows = tasks.rows;
    rows[0]!.lines.push({ kind: 'fail', text: 'mine' });
    rows[0]!.status = 'fail';
    expect(tasks.rows[0]).toMatchObject({
      status: 'ok',
      lines: [{ kind: 'ok', text: 'Wrote /opt/telinha/config/telinha.env' }],
    });
  });
});
