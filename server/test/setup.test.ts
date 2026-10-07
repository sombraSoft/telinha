import { describe, expect, test } from 'bun:test';
import { posix, win32 } from 'node:path';
import { loadConfig } from '../src/config.ts';
import type { Ddns } from '../src/ddns.ts';
import { parseEnvFile } from '../src/envfile.ts';
import type { NatProbe } from '../src/nat/index.ts';
import { resolvePaths } from '../src/paths.ts';
import type { InstallResult, ServiceManager, SpawnOutcome } from '../src/service/index.ts';
import type { CliContext } from '../src/cli/args.ts';
import type { Choice, Spinner, Term } from '../src/cli/term.ts';
import { offerSetup, run } from '../src/cli/setup.ts';
import { createDiscordSetup } from '../src/cli/setup/discord.ts';
import { elevationCommand, generateSecrets, publicPorts, SYSCTL_SCRIPT, type SetupDeps, type SetupFs } from '../src/cli/setup/steps.ts';

const APP = '111111111111111111';
const GUILD = '222222222222222222';
const ROLE = '333333333333333333';
const CHANNEL = '444444444444444441';
const URL_ = 'https://telinha.example.com';
const DUCK_URL = 'https://my-group.duckdns.org:8443';
const TUNNEL = Buffer.from(JSON.stringify({ a: 'acct', t: 'tunnel-id', s: 'c2VjcmV0' })).toString('base64');

/** Scripted answers by "<kind>:<id>"; a prompt without one takes its default. */
class FakeTerm implements Term {
  out: string[] = [];
  asked: string[] = [];
  colors = false;
  style = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, cyan: (s: string) => s };
  constructor(private answers: Record<string, unknown[]> = {}) {}
  private take<T>(key: string, fallback?: () => T): T {
    this.asked.push(key);
    const q = this.answers[key];
    if (q?.length) return q.shift() as T;
    if (fallback) return fallback();
    throw new Error(`no answer for ${key}`);
  }
  info = (m: string) => void this.out.push(m);
  ok = (m: string) => void this.out.push(`ok ${m}`);
  warn = (m: string) => void this.out.push(`warn ${m}`);
  fail = (m: string) => void this.out.push(`fail ${m}`);
  step = (m: string) => void this.out.push(`step ${m}`);
  line = (m = '') => void this.out.push(m);
  async text(q: string, o: { default?: string; validate?: (v: string) => string | null; required?: boolean; id?: string } = {}) {
    for (;;) {
      const v = this.take<string>(`text:${o.id ?? q}`, o.default !== undefined ? () => o.default! : undefined);
      const err = (!v && o.required ? 'required' : null) ?? o.validate?.(v) ?? null;
      if (!err) return v;
      this.out.push(`fail ${err}`);
    }
  }
  async secret(q: string, o: { validate?: (v: string) => string | null; id?: string } = {}) {
    for (;;) {
      const v = this.take<string>(`secret:${o.id ?? q}`);
      const err = o.validate?.(v) ?? (v ? null : 'required');
      if (!err) return v;
      this.out.push(`fail ${err}`);
    }
  }
  async confirm(q: string, def?: boolean, o: { id?: string } = {}) {
    return this.take<boolean>(`confirm:${o.id ?? q}`, def !== undefined ? () => def : undefined);
  }
  async select<T>(q: string, items: Choice<T>[], def?: number, o: { id?: string } = {}) {
    const v = this.take<T>(`select:${o.id ?? q}`, () => items[def ?? 0]!.value);
    if (!items.some((i) => i.value === v)) throw new Error(`select ${o.id}: ${String(v)} is not offered`);
    return v;
  }
  async multiselect<T>(q: string, items: Choice<T>[], o: { min?: number; preselected?: T[]; id?: string } = {}) {
    return this.take<T[]>(`multiselect:${o.id ?? q}`, o.preselected && o.preselected.length >= (o.min ?? 0) ? () => o.preselected! : undefined);
  }
  spinner(label: string): Spinner {
    this.out.push(`spin ${label}`);
    return { update: (l) => void this.out.push(`spin ${l}`), stop: (l) => void this.out.push(`ok ${l ?? label}`), fail: (l) => void this.out.push(`fail ${l ?? label}`) };
  }
  table = (rows: string[][]) => void this.out.push(...rows.map((r) => r.join(' ')));
  link = (u: string) => u;
  text_(): string {
    return this.out.join('\n');
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Discord's REST API for a bot in one guild, with the intents already on; the home redirect carries its port. */
const discordFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input).replace('https://discord.com/api/v10', '');
  const auth = new Headers(init?.headers).get('authorization');
  if (url === '/oauth2/token') return auth === `Basic ${Buffer.from(`${APP}:good-secret`).toString('base64')}` ? json({}) : json({ error: 'invalid_client' }, 401);
  if (auth !== 'Bot tok-good') return json({ message: '401: Unauthorized' }, 401);
  if (url === '/applications/@me') {
    return json({ id: APP, name: 'Telinha Bot', flags: (1 << 13) | (1 << 15), redirect_uris: [`${URL_}/auth/callback`, 'https://my-group.duckdns.org/auth/callback', `${DUCK_URL}/auth/callback`] });
  }
  if (url === '/users/@me/guilds') return json([{ id: GUILD, name: 'Gurizada' }]);
  if (url === `/guilds/${GUILD}/roles`) return json([{ id: GUILD, name: '@everyone', position: 0 }, { id: ROLE, name: 'Membro', position: 1 }]);
  if (url === `/guilds/${GUILD}/channels`) return json([{ id: CHANNEL, name: 'geral', type: 0, position: 0 }]);
  return json({ message: 'Unknown' }, 404);
}) as unknown as typeof fetch;

interface Rec {
  spawn: string[][];
  spawnInteractive: string[][];
  fsCalls: string[];
  bins: unknown[];
  doctor: string[][];
  installs: { user: boolean; o: unknown }[];
  ddns: string[];
  probes: number;
  cert: { host: string; port: number }[];
}

interface Opts {
  platform?: NodeJS.Platform;
  isRoot?: boolean;
  files?: Record<string, string>;
  spawn?: (cmd: string[], files: Map<string, string>) => SpawnOutcome;
  spawnInteractive?: (cmd: string[]) => number;
  available?: boolean;
  nat?: NatProbe;
  duck?: (token: string) => boolean;
  execPath?: string;
  which?: (cmd: string) => string | null;
  /** The local listener serves a valid certificate (default yes). */
  cert?: boolean;
}

/** A home router answering UPnP: the machine looks like a home. */
const NAT: NatProbe = {
  gateway: { kind: 'igd', version: 2, location: 'http://192.168.0.1:49152/d.xml', controlUrl: 'http://192.168.0.1/c', serviceType: 'x', localIp: '192.168.0.10', gatewayIp: '192.168.0.1', name: 'Fritz!Box' },
  externalIp: '203.0.113.9', localIp: '192.168.0.10', errors: [],
};
/** The public IP on the interface itself: a VPS. */
const VPS_NAT: NatProbe = { gateway: null, externalIp: null, localIp: '203.0.113.9', errors: [] };

function fakeDeps(term: FakeTerm, o: Opts = {}) {
  const platform = o.platform ?? 'linux';
  const files = new Map(Object.entries(o.files ?? {}));
  const rec: Rec = { spawn: [], spawnInteractive: [], fsCalls: [], bins: [], doctor: [], installs: [], ddns: [], probes: 0, cert: [] };
  const fs: SetupFs = {
    mkdir: async (d) => void rec.fsCalls.push(`mkdir ${d}`),
    createFile: async (p, data, c) => {
      rec.fsCalls.push(`create ${p} ${c.mode.toString(8)}${c.uid !== undefined ? ` ${c.uid}:${c.gid}` : ''}`);
      files.set(p, data);
    },
    rename: async (a, b) => {
      rec.fsCalls.push(`rename ${a} ${b}`);
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    chmod: async (p, m) => void rec.fsCalls.push(`chmod ${p} ${m.toString(8)}`),
    chown: async (p, u, g) => void rec.fsCalls.push(`chown ${p} ${u}:${g}`),
    stat: async (p) => (files.has(p) ? { uid: 0, gid: 0, mode: 0o100600 } : p.includes('.') ? null : { uid: 0, gid: 0, mode: 0o40700, dir: true }),
    rm: async (p) => void files.delete(p),
    readText: async (p) => files.get(p) ?? null,
    exists: async (p) => files.has(p),
    copyFile: async (a, b) => {
      rec.fsCalls.push(`copy ${a} ${b}`);
      files.set(b, 'binary');
    },
  };
  const manager = (user: boolean): ServiceManager => ({
    kind: platform === 'win32' ? 'windows-task' : user ? 'systemd-user' : 'systemd-system',
    async install(io) {
      rec.installs.push({ user, o: io });
      return { ok: true, steps: { task: 'ok', firewall: 'skipped', start: 'ok' }, hints: user ? ['loginctl enable-linger me'] : [] };
    },
    uninstall: async () => {},
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    status: async () => ({ installed: true, running: true, enabled: true, detail: '' }),
  });
  const deps: SetupDeps = {
    term: () => term,
    fetch: discordFetch,
    nat: { probe: async () => (rec.probes++, o.nat ?? NAT) },
    ddns: ({ domain, token }): Ddns => {
      let last: ReturnType<Ddns['last']> = null;
      return {
        async update(ip) {
          rec.ddns.push(`${domain} ${ip}`);
          const ok = (o.duck ?? (() => true))(token);
          last = ok ? { ip, at: 1, ok } : { ip, at: 1, ok, error: 'DuckDNS rejected the domain/token' };
        },
        last: () => last,
      };
    },
    discord: (token) => createDiscordSetup({ token, fetch: discordFetch, version: 'test', sleep: async () => {} }),
    serviceManager: ({ user }) => manager(user),
    control: {
      available: async () => o.available ?? false,
      shutdown: async () => {},
      status: async () => ({ supervised: true }) as Awaited<ReturnType<SetupDeps['control']['status']>>,
    },
    bins: async (config) => void rec.bins.push({ media: config.media, ingress: config.ingress }),
    spawn: async (cmd) => {
      rec.spawn.push(cmd);
      return o.spawn?.(cmd, files) ?? { code: 0, stdout: '', stderr: '' };
    },
    spawnInteractive: async (cmd) => {
      rec.spawnInteractive.push(cmd);
      return o.spawnInteractive?.(cmd) ?? 0;
    },
    openUrl: async () => {},
    fs,
    platform,
    arch: 'x64',
    isRoot: o.isRoot ?? true,
    osName: () => (platform === 'win32' ? 'Windows 11' : 'Debian GNU/Linux 12 (bookworm)'),
    existsSync: () => false,
    lookupPublicIp: async () => '203.0.113.9',
    resolveA: async () => ['203.0.113.9'],
    portInUse: async () => false,
    udpFree: async () => true,
    random: (n) => new Uint8Array(n).fill(7),
    now: (() => {
      let t = 0;
      return () => (t += 1000);
    })(),
    sleep: async () => {},
    doctor: async (c) => (rec.doctor.push(c.argv), 0),
    execPath: o.execPath ?? (platform === 'win32' ? 'C:\\bun\\bun.exe' : '/usr/bin/bun'),
    which: (cmd) => o.which?.(cmd) ?? null,
    certReady: async (host, port) => (rec.cert.push({ host, port }), o.cert ?? true),
  };
  return { deps, rec, files };
}

function ctxFor(argv: string[], o: { tty?: boolean; compiled?: boolean; platform?: NodeJS.Platform; home?: string; env?: Record<string, string>; isRoot?: boolean } = {}) {
  const platform = o.platform ?? 'linux';
  const home = o.home ?? '/opt/telinha';
  const env = { TELINHA_HOME: home, ...o.env };
  const paths = resolvePaths(env, platform, o.isRoot ?? true);
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    argv, env, paths, envFile: (platform === 'win32' ? win32 : posix).join(paths.config, 'telinha.env'), locale: 'en',
    tty: o.tty ?? false, yes: false, stdout: (l) => void out.push(l), stderr: (l) => void err.push(l), compiled: o.compiled ?? false, version: '0.7.0',
  };
  return { ctx, out, err };
}

/** The file as `run` would load it. */
function config(text: string, home = '/opt/telinha', o: { compiled?: boolean } = {}) {
  return loadConfig({ ...parseEnvFile(text).vars, TELINHA_HOME: home }, o);
}

const ENV = '/opt/telinha/config/telinha.env';
const go = (ctx: CliContext, deps: SetupDeps, o: { stdin?: () => Promise<string> } = {}) => run({ flags: {}, positionals: [], rest: [] }, ctx, deps, o);

const discordAnswers = (): Record<string, unknown[]> => ({
  'secret:DISCORD_TOKEN': ['tok-good'],
  'secret:DISCORD_CLIENT_SECRET': ['good-secret'],
  'multiselect:channels': [[CHANNEL]],
});
/** A fresh home install that takes every default: no domain on Cloudflare, DuckDNS on 8443. */
const freshHome = (): Record<string, unknown[]> => ({ ...discordAnswers(), 'text:duckdns-domain': ['my-group'], 'secret:DUCKDNS_TOKEN': ['duck-token'] });
/** A fresh VPS install with an own domain. */
const freshVps = (): Record<string, unknown[]> => ({ ...discordAnswers(), 'select:hosting': ['vps'], 'text:public-url': ['telinha.example.com'] });

/** The home DuckDNS block as the file holds it. */
const HOME_DUCK = { HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: DUCK_URL, HTTP_PORT: '0', HTTPS_PORT: '8443', ACME_DNS: 'duckdns', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: 'duck-token' };

describe('interactive', () => {
  test('fresh home install, no domain: DuckDNS on a high port, valid without warnings, the port everywhere it matters', async () => {
    const term = new FakeTerm(freshHome());
    const { ctx } = ctxFor(['setup', '--no-service'], { tty: true, compiled: true });
    const { deps, rec, files } = fakeDeps(term, { available: true });
    expect(await go(ctx, deps)).toBe(0);
    const text = files.get(ENV)!;
    const vars = parseEnvFile(text).vars;
    expect(vars).toMatchObject({
      ...HOME_DUCK, UPNP: 'auto', LOCALE: 'en',
      DISCORD_TOKEN: 'tok-good', DISCORD_CLIENT_ID: APP, DISCORD_CLIENT_SECRET: 'good-secret', GUILD_ID: GUILD, ROLE_ID: ROLE, CHANNEL_IDS: CHANNEL,
    });
    expect(vars.TUNNEL_TOKEN).toBeUndefined();
    expect(text).toContain("DUCKDNS_TOKEN='duck-token'");
    const c = config(text, '/opt/telinha', { compiled: true });
    expect(c.warnings).toEqual([]);
    expect(c.acmeDns).toEqual({ provider: 'duckdns', token: 'duck-token' });
    expect(c.httpsPort).toBe(8443);
    expect(rec.ddns).toEqual(['my-group 203.0.113.9']);
    // The machine suggested home (a router answered); nothing about opening 80/443 was asked.
    expect(term.asked).toContain('select:hosting');
    expect(term.asked).toContain('select:cf-domain');
    expect(term.asked).not.toContain('select:advanced');
    const out = term.text_();
    expect(out).toContain('This machine: Debian GNU/Linux 12 (bookworm), x64, public IP 203.0.113.9. Router: Fritz!Box (UPnP IGD v2, 192.168.0.1).');
    expect(out).toContain(`ok Address: ${DUCK_URL} (the port is part of it).`);
    // Discord's redirect carries the port and is registered (the fixture has it).
    expect(out).toContain('ok Redirect URI is registered.');
    expect(out).toContain('Telinha asks the router for TCP 7881, UDP 7882, TCP 8443');
    expect(out).not.toContain('TCP 443');
    // The certificate wait knows it comes through DuckDNS, and asks the high port.
    expect(out).toContain("spin Waiting for the HTTPS certificate (Let's Encrypt through DuckDNS, usually 1-3 minutes)...");
    expect(rec.cert).toEqual([{ host: 'my-group.duckdns.org', port: 8443 }]);
    expect(out).toContain(`Open ${DUCK_URL} or type /telinha`);
    expect(out).not.toContain('duck-token');
  });

  test('home, a custom port: the redirect URI shown for Discord carries it', async () => {
    const term = new FakeTerm({ ...freshHome(), 'text:https-port': ['9443'], 'select:redirect': ['skip'] });
    const { ctx } = ctxFor(['setup', '--no-service', '--no-upnp', '--no-doctor'], { tty: true });
    const { deps, files } = fakeDeps(term);
    expect(await go(ctx, deps)).toBe(0);
    const out = term.text_();
    expect(out).toContain('    https://my-group.duckdns.org:9443/auth/callback');
    expect(out).toContain('warn Login will fail until https://my-group.duckdns.org:9443/auth/callback is a redirect of the app');
    expect(parseEnvFile(files.get(ENV)!).vars).toMatchObject({ PUBLIC_URL: 'https://my-group.duckdns.org:9443', HTTPS_PORT: '9443' });
  });

  test('fresh home with a domain on Cloudflare: tunnel, no HTTP ports, no DNS certificate', async () => {
    const term = new FakeTerm({ ...discordAnswers(), 'select:cf-domain': ['yes'], 'secret:TUNNEL_TOKEN': [TUNNEL], 'text:public-url': ['telinha.example.com'] });
    const { ctx } = ctxFor(['setup', '--no-service', '--no-upnp', '--no-doctor'], { tty: true });
    const { deps, rec, files } = fakeDeps(term);
    expect(await go(ctx, deps)).toBe(0);
    const text = files.get(ENV)!;
    expect(parseEnvFile(text).vars).toMatchObject({ HOSTING: 'home', INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL, PUBLIC_URL: URL_, UPNP: 'auto' });
    expect(text).toContain('#HTTP_PORT=80\n');
    expect(text).toContain('#HTTPS_PORT=443\n');
    expect(text).toContain('#ACME_DNS=none\n');
    expect(rec.bins).toEqual([{ media: 'self', ingress: 'tunnel' }]);
    expect(config(text).tunnelToken).toBe(TUNNEL);
  });

  test('fresh VPS, own domain: 80/443, file written and valid, then binaries, provider firewall, doctor', async () => {
    const term = new FakeTerm(freshVps());
    const { ctx } = ctxFor(['setup'], { tty: true });
    const { deps, rec, files } = fakeDeps(term);
    expect(await go(ctx, deps)).toBe(0);
    const text = files.get(ENV)!;
    const vars = parseEnvFile(text).vars;
    expect(vars).toMatchObject({
      DISCORD_TOKEN: 'tok-good', DISCORD_CLIENT_ID: APP, DISCORD_CLIENT_SECRET: 'good-secret', GUILD_ID: GUILD, ROLE_ID: ROLE, CHANNEL_IDS: CHANNEL,
      COMMAND_NAME: 'telinha', PUBLIC_URL: URL_, HOSTING: 'vps', INGRESS: 'direct', HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'off', LOCALE: 'en',
    });
    expect(vars.ACME_DNS).toBeUndefined();
    expect(text).toContain("DISCORD_TOKEN='tok-good'");
    expect(vars.COOKIE_SECRET).toBe(Buffer.from(new Uint8Array(48).fill(7)).toString('base64'));
    expect(vars.LIVEKIT_API_KEY).toBe('telinha07070707');
    expect(vars.LIVEKIT_API_SECRET!.length).toBeGreaterThanOrEqual(32);
    expect(config(text).publicHost).toBe('telinha.example.com');
    expect(config(text).warnings).toEqual([]);
    // Not compiled: no AUTO_UPDATE question, no service, start by hand.
    expect(term.asked).not.toContain('confirm:auto-update');
    expect(term.asked).not.toContain('select:cf-domain');
    expect(term.asked).not.toContain('confirm:upnp');
    expect(rec.bins).toEqual([{ media: 'self', ingress: 'direct' }]);
    expect(rec.installs).toEqual([]);
    expect(rec.doctor).toEqual([['doctor', '--no-phone']]);
    const out = term.text_();
    expect(out).toContain("Open these ports in your provider's firewall (security group / security list) and in this machine's own firewall: TCP 7881, UDP 7882, TCP 443, TCP 80");
    expect(out).not.toContain('Forward these ports on the router');
    expect(out).toContain('Start it with: bun server/src/index.ts run');
    // Secrets never reach the screen.
    expect(out).not.toContain('tok-good');
    expect(out).not.toContain('good-secret');
    expect(out).not.toContain(vars.COOKIE_SECRET!);
    expect(rec.fsCalls).toContain('chmod /opt/telinha/config 700');
  });

  const PREVIOUS = [
    "DISCORD_TOKEN='tok-good'", `DISCORD_CLIENT_ID=${APP}`, "DISCORD_CLIENT_SECRET='good-secret'", `GUILD_ID=${GUILD}`, `ROLE_ID=${ROLE}`, `CHANNEL_IDS=${CHANNEL}`,
    "COOKIE_SECRET='old-cookie-secret'", `PUBLIC_URL=${URL_}`, 'HOSTING=vps', 'INGRESS=direct', 'LIVEKIT_API_KEY=telinhaabcdef12', "LIVEKIT_API_SECRET='0123456789abcdef0123456789abcdef'", // gitleaks:allow
    'LOCALE=en', 'SESSION_DAYS=14', 'ACME_EMAIL="me@example.com"', "MY_NOTE='keep # me'", '',
  ].join('\n');

  test('re-run: every default kept, secrets kept, unmanaged keys verbatim', async () => {
    const term = new FakeTerm();
    const { ctx } = ctxFor(['setup', '--no-service', '--no-upnp', '--no-doctor'], { tty: true });
    const { deps, files } = fakeDeps(term, { files: { [ENV]: PREVIOUS } });
    expect(await go(ctx, deps)).toBe(0);
    const text = files.get(ENV)!;
    const vars = parseEnvFile(text).vars;
    expect(vars).toMatchObject({ DISCORD_TOKEN: 'tok-good', COOKIE_SECRET: 'old-cookie-secret', LIVEKIT_API_KEY: 'telinhaabcdef12', LIVEKIT_API_SECRET: '0123456789abcdef0123456789abcdef', ROLE_ID: ROLE, HOSTING: 'vps', PUBLIC_URL: URL_ }); // gitleaks:allow
    const other = text.slice(text.indexOf('# --- Other settings'));
    expect(other).toContain('SESSION_DAYS=14\nACME_EMAIL="me@example.com"\nMY_NOTE=\'keep # me\'\n');
    // LOCALE was set: no language question; HOSTING=vps preselected (a home router answers here); secrets offered as "keep current".
    expect(term.asked).not.toContain('select:lang');
    expect(term.asked).toContain('select:hosting');
    expect(term.asked).not.toContain('select:cf-domain');
    expect(term.asked).toContain('select:DISCORD_TOKEN');
    expect(term.asked).not.toContain('secret:DISCORD_TOKEN');
    expect(term.text_()).toContain('COOKIE_SECRET (kept)');
    expect(config(text).sessionSeconds).toBe(14 * 86400);
    // Same answers, same file: idempotent.
    const again = fakeDeps(new FakeTerm(), { files: { [ENV]: text } });
    await go(ctx, again.deps);
    expect(again.files.get(ENV)).toBe(text);
  });

  test('re-run of a home DuckDNS file on Enter reproduces it', async () => {
    const first = fakeDeps(new FakeTerm(freshHome()));
    const { ctx } = ctxFor(['setup', '--no-service', '--no-upnp', '--no-doctor'], { tty: true });
    expect(await go(ctx, first.deps)).toBe(0);
    const text = first.files.get(ENV)!;
    const term = new FakeTerm();
    const again = fakeDeps(term, { files: { [ENV]: text } });
    expect(await go(ctx, again.deps)).toBe(0);
    expect(again.files.get(ENV)).toBe(text);
    expect(term.asked).toContain('text:https-port');
    expect(term.asked).not.toContain('select:advanced');
  });

  test('re-run with "rotate": a new cookie secret, the rest kept', async () => {
    const term = new FakeTerm({ 'select:review': ['rotate'] });
    const { ctx } = ctxFor(['setup', '--no-service', '--no-upnp', '--no-doctor'], { tty: true });
    const { deps, files } = fakeDeps(term, { files: { [ENV]: PREVIOUS } });
    await go(ctx, deps);
    const vars = parseEnvFile(files.get(ENV)!).vars;
    expect(vars.COOKIE_SECRET).not.toBe('old-cookie-secret');
    expect(vars.LIVEKIT_API_KEY).toBe('telinhaabcdef12');
  });

  test('cancel at the review writes nothing', async () => {
    const term = new FakeTerm({ ...freshHome(), 'select:review': ['abort'] });
    const { ctx, err } = ctxFor(['setup'], { tty: true });
    const { deps, files } = fakeDeps(term);
    expect(await go(ctx, deps)).toBe(1);
    expect(files.size).toBe(0);
    expect(err).toEqual(['Nothing was written.']);
  });

  test('Linux user, VPS on 443: the sysctl step is offered; declined, the command is printed and the file stays on 443', async () => {
    const term = new FakeTerm({ ...freshVps(), 'confirm:sysctl': [false] });
    const home = '/home/me/.local/share/telinha';
    const { ctx } = ctxFor(['setup', '--no-upnp', '--no-doctor'], { tty: true, compiled: true, home, isRoot: false });
    const { deps, rec, files } = fakeDeps(term, {
      isRoot: false, execPath: `${home}/bin/telinha`,
      files: { '/proc/sys/net/ipv4/ip_unprivileged_port_start': '1024\n', [`${home}/bin/telinha`]: 'binary' },
    });
    expect(await go(ctx, deps)).toBe(0);
    expect(term.asked).toContain('confirm:sysctl');
    expect(rec.spawnInteractive).toEqual([]);
    expect(SYSCTL_SCRIPT).toBe('printf "net.ipv4.ip_unprivileged_port_start=80\\n" > /etc/sysctl.d/50-telinha.conf && sysctl --system');
    expect(rec.spawn.some((c) => c.includes('setcap'))).toBe(false);
    const text = files.get(`${home}/config/telinha.env`)!;
    expect(parseEnvFile(text).vars).toMatchObject({ HTTPS_PORT: '443', HTTP_PORT: '80', PUBLIC_URL: URL_ });
    expect(config(text, home).httpsPort).toBe(443);
    // Written once: no rewrite to high ports.
    expect(rec.fsCalls.filter((c) => c.startsWith('create ') && c.includes('telinha.env'))).toHaveLength(1);
    expect(term.asked).not.toContain('confirm:high-ports');
    const out = term.text_();
    expect(out).toContain('warn The setting was not changed.');
    expect(out).toContain(`To use 80/443 later: sudo sh -c '${SYSCTL_SCRIPT}'`);
    expect(out).not.toContain('8443');
    expect(rec.installs).toEqual([{ user: true, o: { firewall: false, exe: `${home}/bin/telinha`, home, locale: 'en' } }]);
    expect(term.asked).toContain('confirm:auto-update');
    expect(out).toContain('Still to do by hand: loginctl enable-linger me');
    expect(rec.fsCalls.some((c) => c.startsWith('chown'))).toBe(false);
  });

  test('Linux user at home on 8443: no sysctl step at all', async () => {
    const term = new FakeTerm(freshHome());
    const home = '/home/me/.local/share/telinha';
    const { ctx } = ctxFor(['setup', '--no-upnp', '--no-doctor'], { tty: true, compiled: true, home, isRoot: false });
    const { deps, rec } = fakeDeps(term, { isRoot: false, execPath: `${home}/bin/telinha`, files: { '/proc/sys/net/ipv4/ip_unprivileged_port_start': '1024\n', [`${home}/bin/telinha`]: 'binary' } });
    expect(await go(ctx, deps)).toBe(0);
    expect(term.asked).not.toContain('confirm:sysctl');
    expect(rec.spawn.some((c) => c[0] === 'sudo')).toBe(false);
  });

  test('a running service is restarted to read the new file', async () => {
    const term = new FakeTerm(freshHome());
    let shutdowns = 0;
    const { ctx } = ctxFor(['setup', '--no-service', '--no-upnp', '--no-doctor'], { tty: true });
    const { deps } = fakeDeps(term, { available: true });
    deps.control.shutdown = async () => void shutdowns++;
    await go(ctx, deps);
    expect(shutdowns).toBe(1);
    expect(term.text_()).toContain('Telinha is running.');
  });

  test('home, advanced ports with UPnP on: the router step names only what the mapper asks for; 80/443 stay by hand', async () => {
    const term = new FakeTerm({ ...discordAnswers(), 'select:cf-domain': ['advanced'], 'select:advanced': ['ports'], 'select:ingress': ['domain'], 'text:public-url': ['telinha.example.com'] });
    const { ctx } = ctxFor(['setup', '--no-service', '--no-doctor'], { tty: true });
    const { deps, files } = fakeDeps(term);
    expect(await go(ctx, deps)).toBe(0);
    expect(parseEnvFile(files.get(ENV)!).vars).toMatchObject({ HOSTING: 'home', INGRESS: 'direct', HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'auto' });
    const out = term.text_();
    expect(out).toContain('Telinha will not ask the router for 80 and 443');
    expect(out).toContain('Telinha asks the router for TCP 7881, UDP 7882 while it runs');
    expect(out).not.toMatch(/asks the router for [^\n]*TCP (443|80)\b/);
    expect(out).toContain('Forward these ports on the router to this machine: TCP 443, TCP 80');
  });

  test('--https-port next to a TTY is the default of the home port question', async () => {
    const term = new FakeTerm(freshHome());
    const { ctx } = ctxFor(['setup', '--https-port', '9443', '--no-service', '--no-upnp', '--no-doctor'], { tty: true });
    const { deps, files } = fakeDeps(term);
    expect(await go(ctx, deps)).toBe(0);
    expect(parseEnvFile(files.get(ENV)!).vars).toMatchObject({ PUBLIC_URL: 'https://my-group.duckdns.org:9443', HTTPS_PORT: '9443', HTTP_PORT: '0', ACME_DNS: 'duckdns' });
  });

});

describe('non-interactive', () => {
  const ARGS = ['setup', '--non-interactive', '--host', 'vps', '--public-url', URL_, '--guild', GUILD, '--role', ROLE, '--channels', CHANNEL];
  const HOME_ARGS = ['setup', '--non-interactive', '--host', 'home', '--guild', GUILD, '--role', ROLE, '--channels', CHANNEL];
  const QUIET = ['--no-service', '--no-upnp', '--no-doctor'];
  const SECRETS = { DISCORD_TOKEN: 'tok-good', DISCORD_CLIENT_SECRET: 'good-secret' };
  const DUCK = { ...SECRETS, DUCKDNS_TOKEN: 'duck-token' };

  test('missing secret: exit 2 naming the variable and the -file flag', async () => {
    const { ctx, err } = ctxFor(ARGS, { env: { DISCORD_CLIENT_SECRET: 'good-secret' } });
    const { deps, files } = fakeDeps(new FakeTerm());
    expect(await go(ctx, deps)).toBe(2);
    expect(err).toEqual(['missing in non-interactive mode: DISCORD_TOKEN (environment) or --discord-token-file <path|->']);
    expect(files.size).toBe(0);
  });

  test('every missing answer is listed at once', async () => {
    const { ctx, err } = ctxFor(['setup', '--non-interactive', '--ingress', 'tunnel']);
    const { deps } = fakeDeps(new FakeTerm());
    expect(await go(ctx, deps)).toBe(2);
    for (const what of ['--public-url', 'DISCORD_TOKEN', 'DISCORD_CLIENT_SECRET', '--guild', '--role', '--channels', 'TUNNEL_TOKEN (environment) or --tunnel-token-file']) expect(err[0]).toContain(what);
  });

  test('a secret value flag is a usage error naming the variable and the -file form', async () => {
    const { ctx, err } = ctxFor([...ARGS, '--discord-token', 'abc']);
    const { deps } = fakeDeps(new FakeTerm());
    expect(await go(ctx, deps)).toBe(2);
    expect(err[0]).toContain('DISCORD_TOKEN');
    expect(err[0]).toContain('--discord-token-file');
    expect(err.join('\n')).not.toContain('abc');
  });

  test('secrets from the environment and --x-file -, checked against Discord, written', async () => {
    const { ctx } = ctxFor([...ARGS, '--discord-token-file', '-', ...QUIET], { env: { DISCORD_CLIENT_SECRET: 'good-secret' } });
    const { deps, files } = fakeDeps(new FakeTerm());
    expect(await go(ctx, deps, { stdin: async () => 'tok-good\n' })).toBe(0);
    const text = files.get(ENV)!;
    expect(parseEnvFile(text).vars).toMatchObject({ DISCORD_TOKEN: 'tok-good', DISCORD_CLIENT_ID: APP, GUILD_ID: GUILD, HOSTING: 'vps', INGRESS: 'direct', HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'off' });
    config(text);
  });

  test('Discord problems: exit 1, nothing written', async () => {
    const { ctx } = ctxFor([...ARGS.slice(0, -2), '--channels', '999999999999999999'], { env: SECRETS });
    const term = new FakeTerm();
    const { deps, files } = fakeDeps(term);
    expect(await go(ctx, deps)).toBe(1);
    expect(term.text_()).toContain('Channel 999999999999999999 is not a text channel the bot can see.');
    expect(files.size).toBe(0);
  });

  test('bad flag values: exit 2', async () => {
    const { ctx, err } = ctxFor([...ARGS, '--ingress', 'magic', '--upnp', 'maybe', '--host', 'moon'], { env: SECRETS });
    const { deps } = fakeDeps(new FakeTerm());
    expect(await go(ctx, deps)).toBe(2);
    expect(err.join('\n')).toContain('--ingress: magic is not valid');
    expect(err.join('\n')).toContain('--upnp: maybe is not valid');
    expect(err.join('\n')).toContain('--host: moon is not valid (want home | vps)');
  });

  describe('at home', () => {
    test('--duckdns-domain: HTTPS on 8443 through the DuckDNS API; the router step lists 8443', async () => {
      const term = new FakeTerm();
      const { ctx } = ctxFor([...HOME_ARGS, '--duckdns-domain', 'my-group', '--no-service', '--no-doctor'], { env: DUCK });
      const { deps, rec, files } = fakeDeps(term);
      expect(await go(ctx, deps)).toBe(0);
      const text = files.get(ENV)!;
      expect(parseEnvFile(text).vars).toMatchObject({ ...HOME_DUCK, UPNP: 'auto' });
      expect(config(text).warnings).toEqual([]);
      expect(rec.ddns).toEqual(['my-group 203.0.113.9']);
      expect(term.text_()).toContain('Telinha asks the router for TCP 7881, UDP 7882, TCP 8443');
    });

    test('an own domain without --advanced: exit 2 pointing at the three ways out (and --host vps)', async () => {
      const { ctx, err } = ctxFor([...HOME_ARGS, '--public-url', URL_, ...QUIET], { env: SECRETS });
      const { deps, files } = fakeDeps(new FakeTerm());
      expect(await go(ctx, deps)).toBe(2);
      expect(err).toEqual(['at home Telinha never relies on ports 80/443: use --duckdns-domain (HTTPS on a high port), --ingress tunnel, or --advanced to confirm you opened 80 and 443 yourself (or run your own proxy); on a rented server pass --host vps']);
      expect(err[0]).toContain('--host vps');
      expect(files.size).toBe(0);
    });

    test('an own domain with --advanced: 80/443 like a VPS, UPnP still on for the media ports', async () => {
      const { ctx } = ctxFor([...HOME_ARGS, '--public-url', URL_, '--advanced', ...QUIET], { env: SECRETS });
      const { deps, files } = fakeDeps(new FakeTerm());
      expect(await go(ctx, deps)).toBe(0);
      const vars = parseEnvFile(files.get(ENV)!).vars;
      expect(vars).toMatchObject({ HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: URL_, HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'auto' });
      expect(vars.ACME_DNS).toBeUndefined();
    });

    test('an own proxy needs --advanced too', async () => {
      const { ctx, err } = ctxFor([...HOME_ARGS, '--ingress', 'external', '--public-url', 'https://x.example.com:8443', ...QUIET], { env: SECRETS });
      const no = fakeDeps(new FakeTerm());
      expect(await go(ctx, no.deps)).toBe(2);
      expect(err[0]).toContain('--advanced');
      const yes = fakeDeps(new FakeTerm());
      expect(await go(ctxFor([...HOME_ARGS, '--ingress', 'external', '--public-url', 'https://x.example.com:8443', '--advanced', ...QUIET], { env: SECRETS }).ctx, yes.deps)).toBe(0);
      expect(parseEnvFile(yes.files.get(ENV)!).vars).toMatchObject({ HOSTING: 'home', INGRESS: 'external', PUBLIC_URL: 'https://x.example.com:8443' });
    });

    test('DuckDNS with 80/443 or a redirect port asks for --advanced; a port of Telinha\'s own is a bad value', async () => {
      for (const extra of [['--https-port', '443'], ['--https-port', '80'], ['--http-port', '80']]) {
        const { ctx, err } = ctxFor([...HOME_ARGS, '--duckdns-domain', 'x', ...extra, ...QUIET], { env: DUCK });
        const { deps, files } = fakeDeps(new FakeTerm());
        expect(await go(ctx, deps)).toBe(2);
        expect(err[0]).toContain('at home Telinha never relies on ports 80/443');
        expect(err[0]).toContain('--host vps');
        expect(files.size).toBe(0);
      }
      const { ctx, err } = ctxFor([...HOME_ARGS, '--duckdns-domain', 'x', '--https-port', '8081', ...QUIET], { env: DUCK });
      const { deps } = fakeDeps(new FakeTerm());
      expect(await go(ctx, deps)).toBe(2);
      expect(err).toEqual(['--https-port: 8081 is not valid (want 1024-65535, != LISTEN)']);
    });

    test('DuckDNS with --https-port 9443: the URL carries it; a --public-url must agree', async () => {
      const ok = fakeDeps(new FakeTerm());
      expect(await go(ctxFor([...HOME_ARGS, '--duckdns-domain', 'x', '--https-port', '9443', ...QUIET], { env: DUCK }).ctx, ok.deps)).toBe(0);
      expect(parseEnvFile(ok.files.get(ENV)!).vars).toMatchObject({ PUBLIC_URL: 'https://x.duckdns.org:9443', HTTPS_PORT: '9443', HTTP_PORT: '0', ACME_DNS: 'duckdns' });
      const same = fakeDeps(new FakeTerm());
      expect(await go(ctxFor([...HOME_ARGS, '--duckdns-domain', 'x', '--https-port', '9443', '--public-url', 'https://X.duckdns.org:9443/', ...QUIET], { env: DUCK }).ctx, same.deps)).toBe(0);
      const { ctx, err } = ctxFor([...HOME_ARGS, '--duckdns-domain', 'x', '--public-url', 'https://x.duckdns.org', ...QUIET], { env: DUCK });
      const bad = fakeDeps(new FakeTerm());
      expect(await go(ctx, bad.deps)).toBe(2);
      expect(err).toEqual(['--public-url: https://x.duckdns.org is not valid (want https://x.duckdns.org:8443)']);
    });

    test('HOSTING=home in the environment works like --host home', async () => {
      const { ctx, err } = ctxFor(['setup', '--non-interactive', '--public-url', URL_, '--guild', GUILD, '--role', ROLE, '--channels', CHANNEL, ...QUIET], { env: { ...SECRETS, HOSTING: 'home' } });
      const { deps } = fakeDeps(new FakeTerm(), { nat: VPS_NAT });
      expect(await go(ctx, deps)).toBe(2);
      expect(err[0]).toContain('--advanced');
    });

    test('--ingress tunnel: as on a VPS, with the token', async () => {
      const { ctx } = ctxFor([...HOME_ARGS, '--ingress', 'tunnel', '--public-url', URL_, ...QUIET], { env: { ...SECRETS, TUNNEL_TOKEN: TUNNEL } });
      const { deps, files } = fakeDeps(new FakeTerm());
      expect(await go(ctx, deps)).toBe(0);
      const text = files.get(ENV)!;
      expect(parseEnvFile(text).vars).toMatchObject({ HOSTING: 'home', INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL, PUBLIC_URL: URL_, UPNP: 'auto' });
      expect(text).toContain('#ACME_DNS=none\n');
    });

    const ADVANCED_FILE = [
      "DISCORD_TOKEN='tok-good'", `DISCORD_CLIENT_ID=${APP}`, "DISCORD_CLIENT_SECRET='good-secret'", `GUILD_ID=${GUILD}`, `ROLE_ID=${ROLE}`, `CHANNEL_IDS=${CHANNEL}`,
      "COOKIE_SECRET='old-cookie-secret'", `PUBLIC_URL=${URL_}`, 'HOSTING=home', 'INGRESS=direct', 'HTTP_PORT=80', 'HTTPS_PORT=443', 'UPNP=auto',
      'LIVEKIT_API_KEY=telinhaabcdef12', "LIVEKIT_API_SECRET='0123456789abcdef0123456789abcdef'", '', // gitleaks:allow
    ].join('\n');

    test('a re-run of an advanced home file with only --guild keeps its 80/443 (already confirmed)', async () => {
      const { ctx } = ctxFor(['setup', '--non-interactive', '--guild', GUILD, ...QUIET]);
      const { deps, files } = fakeDeps(new FakeTerm(), { files: { [ENV]: ADVANCED_FILE } });
      expect(await go(ctx, deps)).toBe(0);
      const vars = parseEnvFile(files.get(ENV)!).vars;
      expect(vars).toMatchObject({ HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: URL_, HTTP_PORT: '80', HTTPS_PORT: '443', COOKIE_SECRET: 'old-cookie-secret' });
      expect(vars.ACME_DNS).toBeUndefined();
    });

    test('the same file with --duckdns-domain and no --advanced moves to the high port (the address changed)', async () => {
      const { ctx } = ctxFor(['setup', '--non-interactive', '--duckdns-domain', 'x', ...QUIET], { env: { DUCKDNS_TOKEN: 'duck-token' } });
      const { deps, files } = fakeDeps(new FakeTerm(), { files: { [ENV]: ADVANCED_FILE } });
      expect(await go(ctx, deps)).toBe(0);
      const text = files.get(ENV)!;
      expect(parseEnvFile(text).vars).toMatchObject({ HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: 'https://x.duckdns.org:8443', HTTP_PORT: '0', HTTPS_PORT: '8443', ACME_DNS: 'duckdns', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'x' });
      expect(config(text).warnings).toEqual([]);
    });

    test('the same file with new ports must say --advanced again', async () => {
      const { ctx, err } = ctxFor(['setup', '--non-interactive', '--https-port', '443', ...QUIET]);
      const { deps } = fakeDeps(new FakeTerm(), { files: { [ENV]: ADVANCED_FILE } });
      expect(await go(ctx, deps)).toBe(2);
      expect(err[0]).toContain('--advanced');
    });

    test('a re-run of an advanced DuckDNS-on-443 home file with only a new token stays on 443, HTTP-01', async () => {
      const file = ADVANCED_FILE.replace(`PUBLIC_URL=${URL_}`, 'PUBLIC_URL=https://x.duckdns.org\nDDNS_PROVIDER=duckdns\nDUCKDNS_DOMAIN=x\nDUCKDNS_TOKEN=old');
      const { ctx } = ctxFor(['setup', '--non-interactive', ...QUIET], { env: { DUCKDNS_TOKEN: 'new-token' } });
      const { deps, files, rec } = fakeDeps(new FakeTerm(), { files: { [ENV]: file } });
      expect(await go(ctx, deps)).toBe(0);
      const vars = parseEnvFile(files.get(ENV)!).vars;
      expect(vars).toMatchObject({ HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: 'https://x.duckdns.org', HTTP_PORT: '80', HTTPS_PORT: '443', DUCKDNS_TOKEN: 'new-token' });
      expect(vars.ACME_DNS).toBeUndefined();
      expect(rec.ddns).toEqual(['x 203.0.113.9']);
    });

    test('a home DuckDNS file re-run with only --guild reproduces its block', async () => {
      const file = Object.entries({ ...HOME_DUCK, DISCORD_TOKEN: 'tok-good', DISCORD_CLIENT_ID: APP, DISCORD_CLIENT_SECRET: 'good-secret', GUILD_ID: GUILD, ROLE_ID: ROLE, CHANNEL_IDS: CHANNEL, UPNP: 'auto' })
        .map(([k, v]) => `${k}=${v}`).join('\n');
      const { ctx } = ctxFor(['setup', '--non-interactive', '--guild', GUILD, ...QUIET]);
      const { deps, files } = fakeDeps(new FakeTerm(), { files: { [ENV]: file } });
      expect(await go(ctx, deps)).toBe(0);
      expect(parseEnvFile(files.get(ENV)!).vars).toMatchObject({ ...HOME_DUCK, UPNP: 'auto' });
    });

    /** A complete file holding `vars` next to the Discord answers. */
    const fileOf = (vars: Record<string, string>) => Object.entries({ DISCORD_TOKEN: 'tok-good', DISCORD_CLIENT_ID: APP, DISCORD_CLIENT_SECRET: 'good-secret', GUILD_ID: GUILD, ROLE_ID: ROLE, CHANNEL_IDS: CHANNEL, ...vars })
      .map(([k, v]) => `${k}=${v}`).join('\n');
    const HOME_DUCK_FILE = fileOf({ ...HOME_DUCK, UPNP: 'auto' });

    test('a home DuckDNS file with an own-domain --public-url leaves DuckDNS: --advanced is the remedy, then nothing of DuckDNS stays', async () => {
      const { ctx, err } = ctxFor(['setup', '--non-interactive', '--public-url', URL_, ...QUIET]);
      const no = fakeDeps(new FakeTerm(), { files: { [ENV]: HOME_DUCK_FILE } });
      expect(await go(ctx, no.deps)).toBe(2);
      expect(err).toEqual(['at home Telinha never relies on ports 80/443: use --duckdns-domain (HTTPS on a high port), --ingress tunnel, or --advanced to confirm you opened 80 and 443 yourself (or run your own proxy); on a rented server pass --host vps']);

      const yes = fakeDeps(new FakeTerm(), { files: { [ENV]: HOME_DUCK_FILE } });
      expect(await go(ctxFor(['setup', '--non-interactive', '--public-url', URL_, '--advanced', ...QUIET]).ctx, yes.deps)).toBe(0);
      const text = yes.files.get(ENV)!;
      const vars = parseEnvFile(text).vars;
      expect(vars).toMatchObject({ HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: URL_, HTTP_PORT: '80', HTTPS_PORT: '443' });
      for (const k of ['ACME_DNS', 'DDNS_PROVIDER', 'DUCKDNS_DOMAIN', 'DUCKDNS_TOKEN']) expect(vars[k]).toBeUndefined();
      expect(config(text).warnings).toEqual([]);
      expect(yes.rec.ddns).toEqual([]);
    });

    test('a home tunnel file switched to DuckDNS with only --duckdns-domain becomes direct on the high port', async () => {
      const file = fileOf({ HOSTING: 'home', INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL, PUBLIC_URL: URL_, UPNP: 'auto' });
      const { ctx } = ctxFor(['setup', '--non-interactive', '--host', 'home', '--duckdns-domain', 'my-group', ...QUIET], { env: { DUCKDNS_TOKEN: 'duck-token' } });
      const { deps, files } = fakeDeps(new FakeTerm(), { files: { [ENV]: file } });
      expect(await go(ctx, deps)).toBe(0);
      const text = files.get(ENV)!;
      const vars = parseEnvFile(text).vars;
      expect(vars).toMatchObject({ ...HOME_DUCK, UPNP: 'auto' });
      expect(vars.TUNNEL_TOKEN).toBeUndefined();
      expect(config(text).warnings).toEqual([]);
      // DuckDNS exists only in direct mode.
      const bad = ctxFor(['setup', '--non-interactive', '--host', 'home', '--duckdns-domain', 'my-group', '--ingress', 'tunnel', ...QUIET], { env: { DUCKDNS_TOKEN: 'duck-token' } });
      expect(await go(bad.ctx, fakeDeps(new FakeTerm(), { files: { [ENV]: file } }).deps)).toBe(2);
      expect(bad.err).toContain('--ingress: tunnel is not valid (want direct (with --duckdns-domain))');
    });

    test('a home DuckDNS file switched to a tunnel needs the tunnel\'s own --public-url', async () => {
      const env = { TUNNEL_TOKEN: TUNNEL };
      const { ctx, err } = ctxFor(['setup', '--non-interactive', '--ingress', 'tunnel', ...QUIET], { env });
      expect(await go(ctx, fakeDeps(new FakeTerm(), { files: { [ENV]: HOME_DUCK_FILE } }).deps)).toBe(2);
      expect(err).toEqual(['missing in non-interactive mode: --public-url']);

      const ok = fakeDeps(new FakeTerm(), { files: { [ENV]: HOME_DUCK_FILE } });
      expect(await go(ctxFor(['setup', '--non-interactive', '--ingress', 'tunnel', '--public-url', URL_, ...QUIET], { env }).ctx, ok.deps)).toBe(0);
      const vars = parseEnvFile(ok.files.get(ENV)!).vars;
      expect(vars).toMatchObject({ HOSTING: 'home', INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL, PUBLIC_URL: URL_ });
      for (const k of ['ACME_DNS', 'DDNS_PROVIDER', 'DUCKDNS_DOMAIN', 'DUCKDNS_TOKEN', 'HTTPS_PORT', 'HTTP_PORT']) expect(vars[k]).toBeUndefined();
    });

    test('a VPS file moved home starts with UPnP on: off was the VPS path\'s, not a choice', async () => {
      const file = fileOf({ HOSTING: 'vps', INGRESS: 'direct', PUBLIC_URL: URL_, HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'off' });
      const { ctx } = ctxFor(['setup', '--non-interactive', '--host', 'home', '--duckdns-domain', 'my-group', ...QUIET], { env: { DUCKDNS_TOKEN: 'duck-token' } });
      const { deps, files } = fakeDeps(new FakeTerm(), { files: { [ENV]: file } });
      expect(await go(ctx, deps)).toBe(0);
      expect(parseEnvFile(files.get(ENV)!).vars).toMatchObject({ ...HOME_DUCK, UPNP: 'auto' });
      // An explicit --upnp off still wins.
      const off = fakeDeps(new FakeTerm(), { files: { [ENV]: file } });
      expect(await go(ctxFor(['setup', '--non-interactive', '--host', 'home', '--duckdns-domain', 'my-group', '--upnp', 'off', ...QUIET], { env: { DUCKDNS_TOKEN: 'duck-token' } }).ctx, off.deps)).toBe(0);
      expect(parseEnvFile(off.files.get(ENV)!).vars.UPNP).toBe('off');
    });

    test('--https-port on a media port is refused up front', async () => {
      const { ctx, err } = ctxFor([...HOME_ARGS, '--duckdns-domain', 'x', '--https-port', '7881', ...QUIET], { env: DUCK });
      expect(await go(ctx, fakeDeps(new FakeTerm()).deps)).toBe(2);
      expect(err).toEqual(['--https-port: 7881 is not valid (want 1024-65535, != MEDIA_TCP_PORT)']);
    });

  });

  test('no --host and no HOSTING: a machine whose public IP is its own is a VPS', async () => {
    const term = new FakeTerm();
    const { ctx } = ctxFor(['setup', '--non-interactive', '--public-url', URL_, '--guild', GUILD, '--role', ROLE, '--channels', CHANNEL, '--no-service', '--no-doctor'], { env: SECRETS });
    const { deps, files } = fakeDeps(term, { nat: VPS_NAT });
    expect(await go(ctx, deps)).toBe(0);
    expect(parseEnvFile(files.get(ENV)!).vars).toMatchObject({ HOSTING: 'vps', HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'off' });
    expect(term.text_()).toContain("Open these ports in your provider's firewall");
  });

  test('no --host and no HOSTING behind a home router: home, so an own domain needs --advanced', async () => {
    const { ctx, err } = ctxFor(['setup', '--non-interactive', '--public-url', URL_, '--guild', GUILD, '--role', ROLE, '--channels', CHANNEL, ...QUIET], { env: SECRETS });
    const { deps } = fakeDeps(new FakeTerm());
    expect(await go(ctx, deps)).toBe(2);
    expect(err[0]).toContain('--host vps');
  });

  test('Windows: one elevated child with --user/--sid/--result; its result file is read', async () => {
    const home = 'C:\\Users\\John Smith\\AppData\\Local\\Telinha';
    const exe = `${home}\\bin\\telinha.exe`;
    const resultFile = `${home}\\service\\install-result.json`;
    const term = new FakeTerm();
    const { ctx } = ctxFor([...HOME_ARGS, '--duckdns-domain', 'my-group', '--no-upnp', '--no-doctor'], { platform: 'win32', home, compiled: true, env: { ...DUCK, SystemRoot: 'C:\\Windows' } });
    const result: InstallResult = { ok: true, steps: { task: 'ok', firewall: 'ok', start: 'ok' }, hints: [] };
    const { deps, rec, files } = fakeDeps(term, {
      platform: 'win32', isRoot: false, execPath: 'C:\\Users\\John Smith\\Downloads\\telinha.exe',
      spawn: (cmd, fsFiles) => {
        if (cmd[0]!.endsWith('whoami.exe')) return { code: 0, stdout: '"User Name","SID"\r\n"desktop-1\\john smith","S-1-5-21-1-2-3-1001"\r\n', stderr: '' };
        if (cmd[0] === 'powershell') fsFiles.set(resultFile, JSON.stringify(result));
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(await go(ctx, deps)).toBe(0);
    const ps = rec.spawn.find((c) => c[0] === 'powershell' && c[4]!.includes('Start-Process'))!;
    expect(ps.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command']);
    expect(ps[4]).toBe(
      `$p = Start-Process -FilePath '${exe}' -ArgumentList 'service','install','--firewall','--home','"${home}"','--lang','en',` +
      `'--user','"desktop-1\\john smith"','--sid','S-1-5-21-1-2-3-1001','--result','"${resultFile}"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
    );
    expect(rec.fsCalls).toContain(`copy C:\\Users\\John Smith\\Downloads\\telinha.exe ${exe}`);
    // bin\ joins the user's PATH (the raw value, kept REG_EXPAND_SZ): the hints' `telinha` works in new terminals.
    expect(rec.spawn.some((c) => c[0] === 'powershell' && c[4]!.includes("Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path") && c[4]!.includes(`$d = '${home}\\bin'`))).toBe(true);
    // The file's ACL names the same account.
    expect(rec.spawn.find((c) => c[0] === 'icacls' && c[1]!.endsWith('telinha.env.tmp'))).toContain('desktop-1\\john smith:(F)');
    // The whole home first: inherited by the control token, the task XML and bin\.
    expect(rec.spawn.find((c) => c[0] === 'icacls' && c[1] === home)).toContain('desktop-1\\john smith:(OI)(CI)F');
    const out = term.text_();
    expect(out).toContain('ok Background task');
    expect(out).toContain('ok Firewall rules');
    expect(parseEnvFile(files.get(`${home}\\config\\telinha.env`)!).vars).toMatchObject(HOME_DUCK);
    expect(rec.fsCalls.some((c) => c.startsWith('chmod'))).toBe(false);
  });

  test('Windows: declined UAC prints the manual command', async () => {
    const home = 'C:\\T';
    const term = new FakeTerm();
    const { ctx } = ctxFor([...ARGS, '--no-upnp', '--no-doctor', '--no-firewall'], { platform: 'win32', home, compiled: true, env: SECRETS });
    const { deps } = fakeDeps(term, {
      platform: 'win32', isRoot: false, execPath: 'C:\\T\\bin\\telinha.exe',
      spawn: (cmd) => (cmd[0]!.endsWith('whoami.exe') ? { code: 0, stdout: '"User Name","SID"\r\n"pc\\me","S-1-5-21-9"\r\n', stderr: '' } : cmd[0] === 'powershell' ? { code: 1, stdout: '', stderr: 'The operation was canceled by the user.' } : { code: 0, stdout: '', stderr: '' }),
    });
    expect(await go(ctx, deps)).toBe(0);
    const out = term.text_();
    expect(out).toContain('Administrator rights were not granted');
    // Pasted into PowerShell (no quoted path starting the line), it asks for elevation itself.
    expect(out).toContain("  Start-Process -FilePath 'C:\\T\\bin\\telinha.exe' -ArgumentList 'service install --home C:\\T --lang en --user pc\\me --sid S-1-5-21-9' -Verb RunAs");
  });

  test('Linux user, VPS on 443: the sysctl step runs with sudo -n; a failure prints the command, the file stays on 443', async () => {
    const home = '/home/me/.local/share/telinha';
    const term = new FakeTerm();
    const { ctx } = ctxFor([...ARGS, '--no-upnp', '--no-doctor'], { home, compiled: true, isRoot: false, env: SECRETS });
    const { deps, rec, files } = fakeDeps(term, {
      isRoot: false, execPath: `${home}/bin/telinha`,
      files: { '/proc/sys/net/ipv4/ip_unprivileged_port_start': '1024', [`${home}/bin/telinha`]: 'x' },
      spawn: (cmd) => (cmd[0] === 'sudo' ? { code: 1, stdout: '', stderr: 'sudo: a password is required' } : { code: 0, stdout: '', stderr: '' }),
    });
    expect(await go(ctx, deps)).toBe(0);
    expect(rec.spawn).toContainEqual(['sudo', '-n', 'sh', '-c', SYSCTL_SCRIPT]);
    expect(parseEnvFile(files.get(`${home}/config/telinha.env`)!).vars.HTTPS_PORT).toBe('443');
    expect(term.text_()).toContain(`To use 80/443 later: sudo sh -c '${SYSCTL_SCRIPT}'`);
    expect(term.text_()).not.toContain('8443');
    expect(rec.installs[0]!.user).toBe(true);
  });

  test('Linux user with the sysctl already in place: no sudo', async () => {
    const home = '/home/me/.local/share/telinha';
    const { ctx } = ctxFor([...ARGS, '--no-upnp', '--no-doctor'], { home, compiled: true, isRoot: false, env: SECRETS });
    const { deps, rec } = fakeDeps(new FakeTerm(), { isRoot: false, execPath: `${home}/bin/telinha`, files: { '/proc/sys/net/ipv4/ip_unprivileged_port_start': '80' } });
    await go(ctx, deps);
    expect(rec.spawn.some((c) => c[0] === 'sudo')).toBe(false);
  });

  test('Linux root: system unit, no sudo step', async () => {
    const { ctx } = ctxFor([...ARGS, '--no-upnp', '--no-doctor'], { compiled: true, env: SECRETS });
    const { deps, rec } = fakeDeps(new FakeTerm(), { execPath: '/opt/telinha/bin/telinha' });
    await go(ctx, deps);
    expect(rec.installs.map((i) => i.user)).toEqual([false]);
    expect(rec.spawn.some((c) => c[0] === 'sudo')).toBe(false);
  });

  test('--docker at home writes only the file (0600) and prints the compose next step', async () => {
    const term = new FakeTerm();
    const { ctx } = ctxFor([...HOME_ARGS, '--duckdns-domain', 'my-group', '--docker'], { home: '/telinha', env: DUCK });
    const { deps, rec, files } = fakeDeps(term);
    expect(await go(ctx, deps)).toBe(0);
    expect([...files.keys()]).toEqual(['/telinha/config/telinha.env']);
    expect(rec.fsCalls).toEqual([
      'mkdir /telinha/config',
      'create /telinha/config/telinha.env.tmp 600',
      'rename /telinha/config/telinha.env.tmp /telinha/config/telinha.env',
    ]);
    expect(parseEnvFile(files.get('/telinha/config/telinha.env')!).vars).toMatchObject({ ...HOME_DUCK, UPNP: 'auto' });
    expect(rec.bins).toEqual([]);
    expect(rec.installs).toEqual([]);
    expect(rec.doctor).toEqual([]);
    expect(rec.spawn).toEqual([]);
    expect(rec.probes).toBe(0);
    expect(term.text_()).toContain('cd /opt/telinha && docker compose up -d');
    // The path as found on the host, not the container's /telinha/config.
    expect(term.text_()).toContain('ok Wrote /opt/telinha/config/telinha.env');
    expect(term.text_()).toContain('docker exec -it telinha bun server/src/index.ts doctor');
    expect(term.text_()).toContain('systemctl enable --now telinha-update.timer');
    expect(config(files.get('/telinha/config/telinha.env')!, '/telinha').warnings).toEqual([]);
  });

  test('--docker without --host is a home (no router to probe inside the image): an own domain needs --advanced', async () => {
    const { ctx, err } = ctxFor(['setup', '--non-interactive', '--public-url', URL_, '--guild', GUILD, '--role', ROLE, '--channels', CHANNEL, '--docker'], { home: '/telinha', env: SECRETS });
    const { deps } = fakeDeps(new FakeTerm());
    expect(await go(ctx, deps)).toBe(2);
    expect(err[0]).toContain('--host vps');
  });


  test('a VPS DuckDNS file with an own-domain --public-url drops the DuckDNS keys (no token needed)', async () => {
    const file = ['HOSTING=vps', 'INGRESS=direct', 'PUBLIC_URL=https://my-group.duckdns.org', 'HTTP_PORT=80', 'HTTPS_PORT=443', 'DDNS_PROVIDER=duckdns', 'DUCKDNS_DOMAIN=my-group', 'DUCKDNS_TOKEN=duck-token', 'UPNP=off'].join('\n');
    const { ctx } = ctxFor([...ARGS, ...QUIET], { env: SECRETS });
    const { deps, files, rec } = fakeDeps(new FakeTerm(), { files: { [ENV]: file } });
    expect(await go(ctx, deps)).toBe(0);
    const text = files.get(ENV)!;
    const vars = parseEnvFile(text).vars;
    expect(vars).toMatchObject({ HOSTING: 'vps', INGRESS: 'direct', PUBLIC_URL: URL_, HTTP_PORT: '80', HTTPS_PORT: '443' });
    for (const k of ['DDNS_PROVIDER', 'DUCKDNS_DOMAIN', 'DUCKDNS_TOKEN', 'ACME_DNS']) expect(vars[k]).toBeUndefined();
    expect(config(text).warnings).toEqual([]);
    expect(rec.ddns).toEqual([]);
  });

  test('VPS DuckDNS: 443 with HTTP-01 and no port in the URL; the updater must accept the token', async () => {
    const { ctx } = ctxFor(['setup', '--non-interactive', '--host', 'vps', '--duckdns-domain', 'my-group.duckdns.org', '--guild', GUILD, '--role', ROLE, '--channels', CHANNEL, '--docker'], {
      home: '/telinha', env: DUCK,
    });
    const ok = fakeDeps(new FakeTerm());
    expect(await go(ctx, ok.deps)).toBe(0);
    const vars = parseEnvFile(ok.files.get('/telinha/config/telinha.env')!).vars;
    expect(vars).toMatchObject({ HOSTING: 'vps', PUBLIC_URL: 'https://my-group.duckdns.org', HTTP_PORT: '80', HTTPS_PORT: '443', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', UPNP: 'off' });
    expect(vars.ACME_DNS).toBeUndefined();
    const bad = fakeDeps(new FakeTerm(), { duck: () => false });
    expect(await go(ctx, bad.deps)).toBe(1);
    expect(bad.files.size).toBe(0);
  });

  test('a run switching away from sslip.io drops the pinned node IP; a pasted tunnel install command keeps just the token', async () => {
    const sslip = { files: { [ENV]: 'PUBLIC_URL=https://203-0-113-9.sslip.io\nLIVEKIT_NODE_IP=203.0.113.9\n' } };
    const a = fakeDeps(new FakeTerm(), sslip);
    expect(await go(ctxFor([...ARGS, ...QUIET], { env: SECRETS }).ctx, a.deps)).toBe(0);
    expect(parseEnvFile(a.files.get(ENV)!).vars.LIVEKIT_NODE_IP).toBeUndefined();
    // Given again with --node-ip (and no --host: the pinned IP says VPS), it stays.
    const b = fakeDeps(new FakeTerm(), sslip);
    const keep = ['setup', '--non-interactive', '--public-url', 'https://203-0-113-9.sslip.io', '--node-ip', '203.0.113.9', '--guild', GUILD, '--role', ROLE, '--channels', CHANNEL];
    expect(await go(ctxFor([...keep, '--no-discord-check', '--client-id', APP, ...QUIET], { env: SECRETS }).ctx, b.deps)).toBe(0);
    expect(parseEnvFile(b.files.get(ENV)!).vars).toMatchObject({ LIVEKIT_NODE_IP: '203.0.113.9', HOSTING: 'vps' });

    const c = fakeDeps(new FakeTerm());
    const tunnelEnv = { ...SECRETS, TUNNEL_TOKEN: `cloudflared.exe service install ${TUNNEL}` };
    expect(await go(ctxFor([...ARGS, '--ingress', 'tunnel', ...QUIET], { env: tunnelEnv }).ctx, c.deps)).toBe(0);
    expect(parseEnvFile(c.files.get(ENV)!).vars.TUNNEL_TOKEN).toBe(TUNNEL);
  });

  test('a VPS: the router step names the provider\'s firewall and the ufw commands, not router forwarding', async () => {
    const term = new FakeTerm();
    const argv = ['setup', '--non-interactive', '--public-url', 'https://203-0-113-9.sslip.io', '--node-ip', '203.0.113.9', '--guild', GUILD, '--role', ROLE, '--channels', CHANNEL,
      '--no-discord-check', '--client-id', APP, '--no-service', '--no-doctor'];
    const { deps } = fakeDeps(term, { which: (c) => (c === 'ufw' ? '/usr/sbin/ufw' : null) });
    expect(await go(ctxFor(argv, { env: SECRETS }).ctx, deps)).toBe(0);
    const out = term.text_();
    expect(out).toContain("Open these ports in your provider's firewall (security group / security list) and in this machine's own firewall: TCP 7881, UDP 7882, TCP 443, TCP 80");
    expect(out).toContain('ufw is installed; if it is active: sudo ufw allow 7881/tcp && sudo ufw allow 7882/udp && sudo ufw allow 443/tcp && sudo ufw allow 80/tcp');
    expect(out).not.toContain('No router answered');
    expect(out).not.toContain('Forward these ports on the router');
  });

  test('direct mode: doctor waits for the HTTPS certificate first; still none after the wait says so', async () => {
    for (const cert of [true, false]) {
      const term = new FakeTerm();
      const { deps, rec } = fakeDeps(term, { available: true, cert });
      expect(await go(ctxFor([...ARGS, '--no-service', '--no-upnp'], { compiled: true, env: SECRETS }).ctx, deps)).toBe(0);
      const out = term.text_();
      const doctorAt = out.indexOf('step Checking everything');
      expect(out.indexOf("spin Waiting for the HTTPS certificate (Let's Encrypt, usually under a minute)...")).toBeGreaterThan(-1);
      expect(out.indexOf('spin Waiting for the HTTPS certificate')).toBeLessThan(doctorAt);
      expect(rec.cert[0]).toEqual({ host: 'telinha.example.com', port: 443 });
      if (cert) expect(out).toContain('ok HTTPS certificate in place.');
      else expect(out).toContain('fail No HTTPS certificate yet: getting one can take a few minutes. If doctor flags it below, run /usr/bin/bun doctor again');
    }
  });

  test('the service does not come up: the log and doctor --local are named', async () => {
    const term = new FakeTerm();
    const { deps } = fakeDeps(term, { execPath: '/usr/local/lib/telinha/telinha' });
    expect(await go(ctxFor([...ARGS, '--no-upnp'], { compiled: true, env: SECRETS }).ctx, deps)).toBe(0);
    const out = term.text_();
    expect(out).toContain('fail Telinha does not answer yet. Its log says why: journalctl -u telinha -e');
    // Root never gets pointed at the service's own bin/telinha.
    expect(out).toContain('/usr/local/lib/telinha/telinha doctor --local checks the rest.');
  });

  test('root, bin/ owned by the service user: no downloads as root, the program copied in as that user', async () => {
    const term = new FakeTerm();
    const { deps, rec } = fakeDeps(term, { execPath: '/usr/local/lib/telinha/telinha' });
    const stat = deps.fs.stat;
    deps.fs.stat = async (p) => (p === '/opt/telinha/bin' ? { uid: 998, gid: 998, mode: 0o40755, dir: true } : stat(p));
    expect(await go(ctxFor([...ARGS, '--no-upnp', '--no-doctor'], { compiled: true, env: SECRETS }).ctx, deps)).toBe(0);
    expect(rec.bins).toEqual([]);
    expect(term.text_()).toContain('The service downloads LiveKit, Caddy / cloudflared itself, as its own user, when it starts.');
    expect(rec.spawn).toContainEqual(['runuser', '-u', 'telinha', '--', 'install', '-m', '755', '/usr/local/lib/telinha/telinha', '/opt/telinha/bin/telinha']);
    expect(rec.fsCalls.some((c) => c.startsWith('copy '))).toBe(false);
  });

  test('a Linux user install whose linger failed: the hint says what happens without it', async () => {
    const term = new FakeTerm();
    const { deps } = fakeDeps(term, { isRoot: false, execPath: '/home/me/.local/share/telinha/bin/telinha' });
    const home = '/home/me/.local/share/telinha';
    expect(await go(ctxFor([...ARGS, '--no-upnp', '--no-doctor'], { compiled: true, env: SECRETS, home, isRoot: false }).ctx, deps)).toBe(0);
    expect(term.text_()).toContain('Without it Telinha stops whenever you log out of this machine');
  });
});

describe('pieces', () => {
  test('elevationCommand quotes for PowerShell and for the child command line', () => {
    expect(elevationCommand("C:\\it's\\telinha.exe", ['a b', 'c'])).toBe("$p = Start-Process -FilePath 'C:\\it''s\\telinha.exe' -ArgumentList '\"a b\"','c' -Verb RunAs -Wait -PassThru; exit $p.ExitCode");
  });

  test('generateSecrets keeps what exists, makes what is missing', () => {
    const values: Record<string, string> = { COOKIE_SECRET: 'keep', LIVEKIT_API_SECRET: 'short' };
    expect(generateSecrets(values, (n) => new Uint8Array(n))).toEqual(['LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']);
    expect(values.COOKIE_SECRET).toBe('keep');
    expect(values.LIVEKIT_API_SECRET!.length).toBe(43);
  });

  test('publicPorts: the public port from the URL, a translation only when it differs, no HTTP port when off', () => {
    expect(publicPorts({ INGRESS: 'direct', PUBLIC_URL: 'https://x:8443', HTTPS_PORT: '8443', HTTP_PORT: '0' })).toEqual(['TCP 7881', 'UDP 7882', 'TCP 8443']);
    expect(publicPorts({ INGRESS: 'direct', PUBLIC_URL: 'https://x', HTTPS_PORT: '8443', HTTP_PORT: '0' })).toEqual(['TCP 7881', 'UDP 7882', 'TCP 443 -> 8443']);
    expect(publicPorts({ INGRESS: 'direct', PUBLIC_URL: 'https://x', HTTPS_PORT: '443', HTTP_PORT: '80' })).toEqual(['TCP 7881', 'UDP 7882', 'TCP 443', 'TCP 80']);
    expect(publicPorts({ PUBLIC_URL: 'https://x' })).toEqual(['TCP 7881', 'UDP 7882', 'TCP 443', 'TCP 80']);
    expect(publicPorts({ INGRESS: 'tunnel', MEDIA_UDP_PORT: '50000' })).toEqual(['TCP 7881', 'UDP 50000']);
  });

  test('offerSetup: declined -> null; accepted -> runs setup', async () => {
    const { ctx } = ctxFor([], { tty: true });
    const no = fakeDeps(new FakeTerm({ 'confirm:setup': [false] }));
    expect(await offerSetup(ctx, no.deps)).toBeNull();
    const term = new FakeTerm({ ...freshHome(), 'select:review': ['abort'] });
    const yes = fakeDeps(term);
    expect(await offerSetup(ctx, yes.deps)).toBe(1);
    expect(term.text_()).toContain('warn No configuration yet (/opt/telinha/config/telinha.env).');
  });
});
