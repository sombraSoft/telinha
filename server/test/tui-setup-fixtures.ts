// A fake machine for driving the real setup (session, apply, file writes)
// through the setup screens with OpenTUI's test renderer: Discord's REST API,
// DuckDNS, a home router, an in-memory filesystem, a service manager that can
// fail, byte progress that can be held mid-download, and a SetupUi that
// renders SetupApp with the test harness instead of a real terminal.
import { posix } from 'node:path';
import { createComponent, type JSX } from 'solid-js';
import type { CliContext } from '../src/cli/args.ts';
import { offerSetup, run } from '../src/cli/setup.ts';
import { createDiscordSetup } from '../src/cli/setup/discord.ts';
import type { QuestionId } from '../src/cli/setup/model.ts';
import type { SetupDeps, SetupFs } from '../src/cli/setup/steps.ts';
import type { SetupUi, SetupUiContext, SetupUiResult } from '../src/cli/setup/ui.ts';
import type { Spinner, Term } from '../src/cli/term.ts';
import type { Locale } from '../src/cli/strings.ts';
import type { Ddns } from '../src/ddns.ts';
import type { Check, CheckContext, CheckResult, CheckStatus } from '../src/doctor/types.ts';
import type { NatProbe } from '../src/nat/index.ts';
import { resolvePaths } from '../src/paths.ts';
import type { InstallResult, ServiceManager } from '../src/service/index.ts';
import { SetupApp } from '../src/tui/setup/app.tsx';
import { frame, open, paste, press, settle, typeText, type Session } from './tui-harness.tsx';

export const APP = '111111111111111111';
export const GUILD = '222222222222222222';
export const GUILD2 = '222222222222222223';
export const ROLE = '333333333333333333';
export const CHANNEL = '444444444444444441';
export const CHANNEL2 = '444444444444444442';
export const CHANNEL3 = '444444444444444443';
export const ENV = '/opt/telinha/config/telinha.env';
export const PUBLIC_IP = '203.0.113.9';

// Random-looking on purpose: no word or piece of the screens' text, so any
// four characters of them showing up in a frame is a leak.
export const TOKEN = 'Qx7vZr2KpW9mTn4bLc8hJd'; // gitleaks:allow
export const SECRET = 'Hy3nWr8KqT5vXm2PbC9dGf'; // gitleaks:allow
export const DUCK = 'f5e8a1c4-7b2d-9e6a-3c0f-8d2b6e4a1c7f'; // gitleaks:allow
/** A Cloudflare tunnel token: base64 of {"a","t","s"}, as the dashboard's install command carries it. */
export const TUNNEL = Buffer.from(JSON.stringify({ a: 'Rk7Qw2Zx', t: 'Vm4Np8Ty', s: 'Hc3Lb9FdZq' })).toString('base64'); // gitleaks:allow
export const BAD_TOKEN = 'Zt8Wq3Xn5Rv2Ly7Kd4Mp'; // gitleaks:allow

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What Discord answers; tests change it between steps (a bot added to a server, a hold on the token check). */
export interface DiscordWorld {
  guilds: { id: string; name: string }[];
  channels: { id: string; name: string; type: number; position: number; parent_id?: string }[];
  redirects: string[];
  /** The next application read waits for this (a frame catches the check running). */
  hold: Promise<void> | null;
}

export function discordWorld(o: Partial<DiscordWorld> = {}): DiscordWorld {
  return {
    guilds: [{ id: GUILD, name: 'Gurizada' }, { id: GUILD2, name: 'Clube do Livro' }],
    channels: [
      { id: CHANNEL, name: 'geral', type: 0, position: 0 },
      { id: CHANNEL2, name: 'telinha', type: 0, position: 1 },
      { id: CHANNEL3, name: 'filmes', type: 0, position: 2 },
    ],
    redirects: ['https://my-group.duckdns.org:8443', 'https://t.example.com', `https://${PUBLIC_IP.replaceAll('.', '-')}.sslip.io`, 'https://my-group.duckdns.org'].map((u) => `${u}/auth/callback`),
    hold: null,
    ...o,
  };
}

export function discordFetch(world: DiscordWorld): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace('https://discord.com/api/v10', '');
    const auth = new Headers(init?.headers).get('authorization');
    if (url === '/oauth2/token') return auth === `Basic ${Buffer.from(`${APP}:${SECRET}`).toString('base64')}` ? json({}) : json({ error: 'invalid_client' }, 401);
    // Held before the answer, whichever token asks: a frame catches the check running.
    if (url === '/applications/@me' && world.hold) await world.hold;
    if (auth !== `Bot ${TOKEN}`) return json({ message: '401: Unauthorized' }, 401);
    if (url === '/applications/@me') {
      return json({ id: APP, name: 'Telinha Bot', flags: (1 << 13) | (1 << 15), redirect_uris: world.redirects });
    }
    if (url === '/users/@me/guilds') return json(world.guilds);
    const roles = /^\/guilds\/(\d+)\/roles$/.exec(url);
    if (roles) return json([{ id: roles[1], name: '@everyone', position: 0 }, { id: ROLE, name: 'Membro', position: 1 }]);
    if (/^\/guilds\/\d+\/channels$/.test(url)) return json(world.channels);
    if (/^\/guilds\/\d+\/members\//.test(url)) return json({ roles: [] });
    if (/^\/guilds\/\d+$/.test(url)) return json({ id: GUILD, name: 'Gurizada' });
    return json({ message: 'Unknown' }, 404);
  }) as unknown as typeof fetch;
}

/** A home router answering UPnP: the machine looks like a home. */
export const NAT: NatProbe = {
  gateway: { kind: 'igd', version: 2, location: 'http://192.168.0.1:49152/d.xml', controlUrl: 'http://192.168.0.1/c', serviceType: 'x', localIp: '192.168.0.10', gatewayIp: '192.168.0.1', name: 'Fritz!Box' },
  externalIp: PUBLIC_IP, localIp: '192.168.0.10', errors: [],
};
/** The public IP on the interface itself: a VPS. */
export const VPS_NAT: NatProbe = { gateway: null, externalIp: null, localIp: PUBLIC_IP, errors: [] };

export const CHECK_RESULTS: CheckResult[] = [
  { id: 'config', title: 'Configuration', status: 'ok', summary: 'telinha.env is valid' },
  { id: 'dns', title: 'DNS', status: 'ok', summary: 'my-group.duckdns.org points at 203.0.113.9' },
  { id: 'gateway', title: 'Router', status: 'fail', summary: 'UDP 7882 is not reachable from the internet', detail: ['Router: 192.168.0.1 (UPnP)'], fix: 'Forward UDP 7882 on your router to 192.168.0.10.' },
  { id: 'update', title: 'Updates', status: 'warn', summary: 'telinha 0.9.1 is available', fix: 'telinha update --now' },
];

/** Doctor checks for the report screen: the results above, each run counted. */
export function fakeChecks(runs: { n: number }, results: CheckResult[] = CHECK_RESULTS): Check[] {
  return results.map((r, i) => ({
    id: r.id,
    async run(): Promise<CheckResult> {
      if (i === 0) runs.n++;
      return { ...r, status: r.status as CheckStatus };
    },
  }));
}

/** Prints nothing to a terminal: collects the plain lines setup.ts leaves after the screens. */
export class FakeTerm implements Term {
  out: string[] = [];
  colors = false;
  style = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, cyan: (s: string) => s };
  info = (m: string) => void this.out.push(m);
  ok = (m: string) => void this.out.push(`ok ${m}`);
  warn = (m: string) => void this.out.push(`warn ${m}`);
  fail = (m: string) => void this.out.push(`fail ${m}`);
  step = (m: string) => void this.out.push(`step ${m}`);
  line = (m = '') => void this.out.push(m);
  spinner(label: string): Spinner {
    this.out.push(`spin ${label}`);
    return { update: (l) => void this.out.push(`spin ${l}`), stop: (l) => void this.out.push(`ok ${l ?? label}`), fail: (l) => void this.out.push(`fail ${l ?? label}`) };
  }
  table = (rows: string[][]) => void this.out.push(...rows.map((r) => r.join(' ')));
  link = (u: string) => u;
}

export interface MachineOptions {
  nat?: NatProbe;
  files?: Record<string, string>;
  /** Discord's answers (default: a bot in two servers). */
  world?: DiscordWorld;
  /** DuckDNS takes this token (default: any). */
  duckOk?: (token: string) => boolean;
  /** The service install fails this many times before it works. */
  serviceFails?: number;
  /** What a working service install leaves to do by hand (`loginctl enable-linger …`). */
  serviceHints?: string[];
  /** Writing telinha.env fails this many times before it works. */
  writeFails?: number;
  /** Download progress: report half of LiveKit, then wait for this before finishing. */
  binsHold?: Promise<void>;
  /** What the install's doctor task finds. */
  results?: CheckResult[];
  isRoot?: boolean;
}

export interface Rec {
  installs: number;
  ddns: string[];
  checks: number;
  spawnInteractive: string[][];
}

/** A Linux machine with nothing on it yet; every network and system call is a fake. */
export function machine(o: MachineOptions = {}) {
  const files = new Map(Object.entries(o.files ?? {}));
  const world = o.world ?? discordWorld();
  const fetchFn = discordFetch(world);
  const rec: Rec = { installs: 0, ddns: [], checks: 0, spawnInteractive: [] };
  let fails = o.serviceFails ?? 0;
  let writeFails = o.writeFails ?? 0;
  // Host detection waits for the public IP lookup (the router probe runs beside it, not in Docker);
  // setup.ts hands the result to the session right after.
  let looked!: () => void;
  const detected = new Promise<void>((r) => (looked = r)).then(() => Bun.sleep(10));
  let installed = false;
  const fs: SetupFs = {
    mkdir: async () => {},
    createFile: async (p, data) => {
      if (p.includes('telinha.env') && writeFails > 0) {
        writeFails--;
        throw new Error(`ENOSPC: no space left on device, open '${p}'`);
      }
      files.set(p, data);
    },
    rename: async (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    chmod: async () => {},
    chown: async () => {},
    stat: async (p) => (files.has(p) ? { uid: 0, gid: 0, mode: 0o100600 } : p.includes('.') ? null : { uid: 0, gid: 0, mode: 0o40700, dir: true }),
    rm: async (p) => void files.delete(p),
    readText: async (p) => files.get(p) ?? null,
    exists: async (p) => files.has(p),
    copyFile: async (_a, b) => void files.set(b, 'binary'),
  };
  const manager = (user: boolean): ServiceManager => ({
    kind: user ? 'systemd-user' : 'systemd-system',
    async install(): Promise<InstallResult> {
      rec.installs++;
      if (fails > 0) {
        fails--;
        throw new Error('systemctl enable --now telinha.service exited with 1');
      }
      installed = true;
      return { ok: true, steps: { task: 'ok', firewall: 'skipped', start: 'ok' }, hints: o.serviceHints ?? [] };
    },
    uninstall: async () => {},
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    status: async () => ({ installed, running: installed, enabled: installed, detail: '' }),
  });
  const deps: SetupDeps = {
    term: () => new FakeTerm(),
    fetch: fetchFn,
    nat: { probe: async () => o.nat ?? NAT },
    ddns: ({ domain, token }): Ddns => {
      let last: ReturnType<Ddns['last']> = null;
      return {
        async update(ip) {
          rec.ddns.push(`${domain} ${ip}`);
          const ok = (o.duckOk ?? (() => true))(token);
          last = ok ? { ip, at: 1, ok } : { ip, at: 1, ok, error: 'KO' };
        },
        last: () => last,
      };
    },
    discord: (token) => createDiscordSetup({ token, fetch: fetchFn, version: 'test', sleep: async () => {} }),
    serviceManager: ({ user }) => manager(user),
    control: {
      // Up once the service is installed: the install starts it.
      available: async () => installed,
      shutdown: async () => {},
      status: async () => ({ supervised: true }) as Awaited<ReturnType<SetupDeps['control']['status']>>,
      doctorSession: async () => ({ id: 's', url: 'https://my-group.duckdns.org:8443/doctor/s', expiresAt: 0 }),
      doctorWait: async () => ({ state: 'expired' }),
    },
    bins: async (_config, _paths, _log, progress) => {
      const total = 22_020_096;
      progress?.('livekit', Math.round(total * 0.52), total);
      if (o.binsHold) await o.binsHold;
      progress?.('livekit', total, total);
    },
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawnInteractive: async (cmd) => (rec.spawnInteractive.push(cmd), 0),
    openUrl: async () => {},
    fs,
    platform: 'linux',
    arch: 'x64',
    isRoot: o.isRoot ?? true,
    osName: () => 'Debian GNU/Linux 12 (bookworm)',
    existsSync: () => false,
    lookupPublicIp: async () => (looked(), PUBLIC_IP),
    resolveA: async () => [PUBLIC_IP],
    portInUse: async () => false,
    udpFree: async () => true,
    random: (n) => new Uint8Array(n).fill(7),
    now: (() => {
      let t = 0;
      return () => (t += 1000);
    })(),
    sleep: async () => {},
    doctor: async () => 0,
    doctorChecks: async (_c, onResult) => {
      rec.checks++;
      const all = o.results ?? CHECK_RESULTS;
      all.forEach((r, i) => onResult?.(r, i + 1, all.length));
      return all;
    },
    execPath: '/usr/local/bin/telinha',
    which: () => null,
    certReady: async () => true,
  };
  return { deps, files, rec, world, detected };
}

export function ctxFor(argv: string[], o: { tty?: boolean; yes?: boolean; compiled?: boolean; locale?: Locale; env?: Record<string, string> } = {}) {
  const env = { TELINHA_HOME: '/opt/telinha', ...o.env };
  const paths = resolvePaths(env, 'linux', true);
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    argv, env, paths, envFile: posix.join(paths.config, 'telinha.env'), locale: o.locale ?? 'en',
    tty: o.tty ?? true, yes: o.yes ?? false, stdout: (l) => void out.push(l), stderr: (l) => void err.push(l), compiled: o.compiled ?? false, version: 'test',
  };
  return { ctx, out, err };
}

/** The harness's open(), English, sized for the setup screens. */
export async function openApp(node: () => JSX.Element, o: { width?: number; height?: number } = {}): Promise<Session> {
  return open(node, o);
}

export interface DriverOptions {
  width?: number;
  height?: number;
  /** The report screen's checks (default: the real ones, which would touch the network). */
  doctorChecks?: Check[];
  /** Replaces the doctor hooks setup.ts gives (its context builder reads the real machine). */
  doctor?: SetupUiContext['doctor'];
  /** Replaces the install and its task list: a test shows rows of its own. */
  apply?: SetupUiContext['apply'];
  /** Replaces the task list the screens read their rows from (pair it with `apply`). */
  tasks?: SetupUiContext['tasks'];
}

/** The setup screens on OpenTUI's test renderer: what run() returns is what the user picked. */
export class Driver implements SetupUi {
  context: SetupUiContext | null = null;
  /** The intro lines of every terminal hand-off (sudo). */
  terminal: string[][] = [];
  readonly ready: Promise<Session>;
  #ready!: (s: Session) => void;
  constructor(private o: DriverOptions = {}) {
    this.ready = new Promise((r) => (this.#ready = r));
  }

  async run(c: SetupUiContext): Promise<SetupUiResult> {
    this.context = c;
    let finish!: (r: SetupUiResult) => void;
    const result = new Promise<SetupUiResult>((r) => (finish = r));
    const ctx: SetupUiContext = { ...c, doctor: c.doctor && this.o.doctor !== undefined ? this.o.doctor : c.doctor, ...(this.o.apply ? { apply: this.o.apply } : {}), ...(this.o.tasks ? { tasks: this.o.tasks } : {}) };
    const s = await openApp(
      () =>
        createComponent(SetupApp, {
          c: ctx,
          done: finish,
          withTerminal: async (fn, intro) => {
            this.terminal.push(intro ?? []);
            return fn();
          },
          ...(this.o.doctorChecks ? { checks: this.o.doctorChecks } : {}),
        }),
      { width: this.o.width ?? 120, height: this.o.height ?? 34 },
    );
    this.#ready(s);
    try {
      return await result;
    } finally {
      s.renderer.destroy();
    }
  }
}

/** The fake doctor hooks: a context that is only the locale, a control that is not running. */
export function fakeDoctor(builds: { n: number } = { n: 0 }): NonNullable<SetupUiContext['doctor']> {
  return {
    buildContext: async () => (builds.n++, { locale: 'en' } as CheckContext),
    control: {
      available: async () => false,
      status: async () => ({}) as never,
      doctorSession: async () => ({ id: 's', url: 'https://x/doctor/s', expiresAt: 0 }),
      doctorWait: async () => ({ state: 'expired' }),
    },
    config: () => null,
  };
}

export type StartOptions = MachineOptions & DriverOptions & { yes?: boolean; compiled?: boolean; locale?: Locale; env?: Record<string, string> };

/** The screens up and the machine detected (its defaults are in): what a test drives. */
async function started(m: ReturnType<typeof machine>, driver: Driver, code: Promise<number | null>, err: string[]) {
  const s = await Promise.race([
    driver.ready,
    code.then((c) => {
      throw new Error(`setup ended (${c}) before the screens opened: ${err.join(' | ')}`);
    }),
  ]);
  await m.detected;
  await settle(s);
  return s;
}

/**
 * Starts `telinha setup <argv>` on a terminal with the setup screens; resolves
 * once the first card is up and the machine detected. `code` is setup's exit
 * code once the screens are gone.
 */
export async function startSetup(argv: string[], o: StartOptions = {}) {
  const m = machine(o);
  const term = new FakeTerm();
  m.deps.term = () => term;
  const { ctx, out, err } = ctxFor(['setup', ...argv], { yes: o.yes, compiled: o.compiled, locale: o.locale, env: o.env });
  const driver = new Driver(o);
  const code = run({ flags: {}, positionals: [], rest: [] }, ctx, { ...m.deps, ui: driver });
  const s = await started(m, driver, code, err);
  return { s, code, driver, term, out, err, ...m, session: () => driver.context!.session };
}

/** `telinha` alone without a telinha.env: the welcome card first. */
export async function startOffer(o: StartOptions = {}) {
  const m = machine(o);
  const term = new FakeTerm();
  m.deps.term = () => term;
  const { ctx, out, err } = ctxFor([], { compiled: o.compiled, locale: o.locale, env: o.env });
  const driver = new Driver(o);
  const code = offerSetup(ctx, { ...m.deps, ui: driver });
  const s = await started(m, driver, code, err);
  return { s, code, driver, term, out, err, ...m, session: () => driver.context!.session };
}

export type Started = Awaited<ReturnType<typeof startSetup>>;

/**
 * Waits until the session shows `id` (or the Review) with no lookup running,
 * whatever the language; returns the frame.
 */
export async function at(r: Pick<Started, 's' | 'session'>, id: QuestionId | 'review', o: { running?: boolean; ms?: number } = {}): Promise<string> {
  const end = Date.now() + (o.ms ?? 3000);
  for (;;) {
    await settle(r.s, 20);
    const s = r.session();
    const here = id === 'review'
      ? s.screen() === 'review'
      : s.screen() === 'question' && s.current().id === id && (s.current().lookup.state === 'running') === !!o.running;
    if (here) return frame(r.s);
    if (Date.now() > end) throw new Error(`timed out waiting for ${id}: ${frame(r.s)}`);
  }
}

/** The Discord step with the defaults: the token, the secret, the first server, its first role, the first channel. */
export async function discordKeys(r: Started, o: { token?: string } = {}): Promise<void> {
  await at(r, 'discordToken');
  await paste(r.s, o.token ?? TOKEN);
  await press(r.s, 'enter');
  await at(r, 'clientSecret');
  await paste(r.s, SECRET);
  await press(r.s, 'enter');
  await at(r, 'guild');
  await press(r.s, 'enter');
  await at(r, 'role');
  await press(r.s, 'enter');
  await at(r, 'channels');
  await press(r.s, 'space', 'enter');
  await at(r, 'command');
  await press(r.s, 'enter');
  await at(r, 'group');
  await press(r.s, 'enter');
}

/** Home, no domain on Cloudflare: a DuckDNS name and token, the default port. */
export async function homeDuckKeys(r: Started): Promise<void> {
  await at(r, 'hosting');
  await press(r.s, '1');
  await at(r, 'homeCf');
  await press(r.s, '2');
  await at(r, 'duckName');
  await typeText(r.s, 'my-group');
  await press(r.s, 'enter');
  await at(r, 'duckToken');
  await paste(r.s, DUCK);
  await press(r.s, 'enter');
  await at(r, 'httpsPort');
  await press(r.s, 'enter');
}

/** Enter on every question left until the Review (their defaults). */
export async function defaultsToReview(r: Started): Promise<string> {
  for (let i = 0; i < 20; i++) {
    await settle(r.s, 20);
    const s = r.session();
    if (s.screen() === 'review') return at(r, 'review');
    const v = s.current();
    if (v.lookup.state === 'running') continue;
    await press(r.s, 'enter');
  }
  throw new Error(`the questions never end: ${frame(r.s)}`);
}

/** Any 4 characters of `secret` found in `text` (a secret on screen), or null. */
export function leak(secret: string, text: string): string | null {
  for (let i = 0; i + 4 <= secret.length; i++) {
    const part = secret.slice(i, i + 4);
    if (text.includes(part)) return part;
  }
  return null;
}
