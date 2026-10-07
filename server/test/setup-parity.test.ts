// The setup screens and --non-interactive end in the same file: the same
// answers given through the setup state and given as flags (secrets from the
// environment) write byte-identical telinha.env files.
import { describe, expect, test } from 'bun:test';
import { posix } from 'node:path';
import type { CliContext } from '../src/cli/args.ts';
import { createDiscordSetup } from '../src/cli/setup/discord.ts';
import type { QuestionId } from '../src/cli/setup/model.ts';
import type { SetupState } from '../src/cli/setup/state.ts';
import type { SetupDeps, SetupFs } from '../src/cli/setup/steps.ts';
import type { SetupUi, SetupUiContext, SetupUiResult } from '../src/cli/setup/ui.ts';
import { run } from '../src/cli/setup.ts';
import type { Spinner, Term } from '../src/cli/term.ts';
import type { Ddns } from '../src/ddns.ts';
import { parseEnvFile } from '../src/envfile.ts';
import type { NatProbe } from '../src/nat/index.ts';
import { resolvePaths } from '../src/paths.ts';

const APP = '111111111111111111';
const GUILD = '222222222222222222';
const ROLE = '333333333333333333';
const CHANNEL = '444444444444444441';
const CHANNEL2 = '444444444444444442';
const TOKEN = 'Mv6tXq2RpZ9wLk4NcB7hJs'; // gitleaks:allow
const SECRET = 'Hy3nWr8KqT5vXm2PbC9d'; // gitleaks:allow
const DUCK = '5e8a1c4f7b2d9e6a3c0f'; // gitleaks:allow
const TUNNEL = Buffer.from(JSON.stringify({ a: 'acct', t: 'tunnel-id', s: 'Qz8RkW3mXv' })).toString('base64');
const ENV = '/opt/telinha/config/telinha.env';
const SECRETS = { DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_SECRET: SECRET };
const QUIET = ['--lang', 'en', '--no-service', '--no-upnp', '--no-doctor'];

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
  if (url === '/applications/@me') {
    const redirects = [
      'https://my-group.duckdns.org:8443',
      'https://t.example.com',
      'https://203-0-113-9.sslip.io',
    ].map((u) => `${u}/auth/callback`);
    return json({ id: APP, name: 'Telinha Bot', flags: (1 << 13) | (1 << 15), redirect_uris: redirects });
  }
  if (url === '/users/@me/guilds') return json([{ id: GUILD, name: 'Gurizada' }]);
  if (url === `/guilds/${GUILD}/roles`)
    return json([
      { id: GUILD, name: '@everyone', position: 0 },
      { id: ROLE, name: 'Membro', position: 1 },
    ]);
  if (url === `/guilds/${GUILD}/channels`)
    return json([
      { id: CHANNEL, name: 'geral', type: 0, position: 0 },
      { id: CHANNEL2, name: 'telinha', type: 0, position: 1 },
    ]);
  return json({ message: 'Unknown' }, 404);
}) as unknown as typeof fetch;

const NAT: NatProbe = {
  gateway: {
    kind: 'igd',
    version: 2,
    location: 'http://192.168.0.1:49152/d.xml',
    controlUrl: 'http://192.168.0.1/c',
    serviceType: 'x',
    localIp: '192.168.0.10',
    gatewayIp: '192.168.0.1',
    name: 'Fritz!Box',
  },
  externalIp: '203.0.113.9',
  localIp: '192.168.0.10',
  errors: [],
};

const quiet: Term = {
  info: () => {},
  ok: () => {},
  warn: () => {},
  fail: () => {},
  step: () => {},
  line: () => {},
  table: () => {},
  spinner: (): Spinner => ({ update: () => {}, stop: () => {}, fail: () => {} }),
  link: (u) => u,
  colors: false,
  style: { bold: (s) => s, dim: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s, cyan: (s) => s },
};

/** A fresh fake machine (no file yet) with the same fake random each time. */
function machine() {
  const files = new Map<string, string>();
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
  const deps: SetupDeps = {
    term: () => quiet,
    fetch: discordFetch,
    nat: { probe: async () => NAT },
    ddns: (): Ddns => {
      let last: ReturnType<Ddns['last']> = null;
      return {
        update: async (ip) => {
          last = { ip, at: 1, ok: true };
        },
        last: () => last,
      };
    },
    discord: (token) => createDiscordSetup({ token, fetch: discordFetch, version: 'test', sleep: async () => {} }),
    serviceManager: () => null,
    control: {
      available: async () => false,
      shutdown: async () => {},
      status: async () => ({ supervised: true }) as Awaited<ReturnType<SetupDeps['control']['status']>>,
      phoneTestLink: async () => ({ id: 's', url: 'https://x', expiresAt: 0 }),
      phoneTestWait: async () => ({ state: 'expired' }),
    },
    bins: async () => {},
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    spawnInteractive: async () => 0,
    openUrl: async () => {},
    fs,
    platform: 'linux',
    arch: 'x64',
    isRoot: true,
    osName: () => 'Debian GNU/Linux 12 (bookworm)',
    existsSync: () => false,
    lookupPublicIp: async () => '203.0.113.9',
    resolveA: async () => ['203.0.113.9'],
    portInUse: async () => false,
    udpFree: async () => true,
    random: (n) => new Uint8Array(n).fill(9),
    now: Date.now,
    sleep: async () => {},
    doctor: async () => 0,
    doctorChecks: async () => [],
    execPath: '/usr/bin/bun',
    which: () => null,
    certReady: async () => true,
  };
  return { deps, files };
}

function ctxFor(argv: string[], o: { tty: boolean; env?: Record<string, string> }): CliContext {
  const env = { TELINHA_HOME: '/opt/telinha', ...o.env };
  const paths = resolvePaths(env, 'linux', true);
  return {
    argv,
    env,
    paths,
    envFile: posix.join(paths.config, 'telinha.env'),
    locale: 'en',
    tty: o.tty,
    yes: false,
    stdout: () => {},
    stderr: () => {},
    compiled: false,
    version: 'test',
  };
}

async function settle(s: SetupState): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(1);
    if (s.screen() !== 'question' || s.current().lookup.state !== 'running') return;
  }
}

/** Answers through the setup state (unscripted questions take what the card shows), then applies. */
class AnswerUi implements SetupUi {
  constructor(private answers: Partial<Record<QuestionId, string | string[]>>) {}
  async run(c: SetupUiContext): Promise<SetupUiResult> {
    const s = c.state;
    while (s.screen() === 'question') {
      await settle(s);
      const v = s.current();
      const value = this.answers[v.id] ?? (v.kind === 'select' || v.kind === 'multi' ? v.initial : '');
      if ((await s.submit(value)) === 'stayed')
        throw new Error(`${v.id} stayed: ${s.current().error ?? JSON.stringify(s.current().lookup)}`);
    }
    const hooks = {
      emit: () => {},
      decide: async () => 'abort' as const,
      withTerminal: <T>(fn: () => Promise<T>) => fn(),
    };
    return { kind: 'applied', result: await c.apply({ rotateCookie: false }, hooks) };
  }
}

/** The file the setup screens write for these answers, and the one --non-interactive writes for these flags. */
async function both(o: {
  answers: Partial<Record<QuestionId, string | string[]>>;
  flags: string[];
  env: Record<string, string>;
  offline?: boolean;
}) {
  const extra = o.offline ? ['--no-discord-check'] : [];
  const screens = machine();
  expect(
    await run({ flags: {}, positionals: [], rest: [] }, ctxFor(['setup', ...QUIET, ...extra], { tty: true }), {
      ...screens.deps,
      ui: new AnswerUi(o.answers),
    }),
  ).toBe(0);
  const plain = machine();
  const err: string[] = [];
  const ctx = {
    ...ctxFor(['setup', '--non-interactive', ...QUIET, ...extra, ...o.flags], { tty: false, env: o.env }),
    stderr: (l: string) => void err.push(l),
  };
  expect(await run({ flags: {}, positionals: [], rest: [] }, ctx, plain.deps), err.join('\n')).toBe(0);
  return { screens: screens.files.get(ENV)!, plain: plain.files.get(ENV)! };
}

const DISCORD = { discordToken: TOKEN, clientSecret: SECRET, channels: [CHANNEL] };
const DISCORD_FLAGS = ['--guild', GUILD, '--role', ROLE, '--channels', CHANNEL, '--command', 'telinha'];

describe('setup screens and --non-interactive write the same telinha.env', () => {
  test('home, no domain: DuckDNS on 8443', async () => {
    const r = await both({
      answers: { ...DISCORD, duckName: 'my-group', duckToken: DUCK },
      flags: ['--host', 'home', '--duckdns-domain', 'my-group', ...DISCORD_FLAGS],
      env: { ...SECRETS, DUCKDNS_TOKEN: DUCK },
    });
    expect(r.screens).toBe(r.plain);
    expect(parseEnvFile(r.screens).vars).toMatchObject({
      HOSTING: 'home',
      PUBLIC_URL: 'https://my-group.duckdns.org:8443',
      HTTPS_PORT: '8443',
      ACME_DNS: 'duckdns',
      UPNP: 'auto',
      LOCALE: 'en',
    });
  });

  test('home, a domain on Cloudflare: tunnel (the pasted install command keeps the token)', async () => {
    const r = await both({
      answers: {
        ...DISCORD,
        homeCf: 'yes',
        tunnelToken: `cloudflared service install ${TUNNEL}`,
        tunnelHost: 't.example.com',
      },
      flags: ['--host', 'home', '--ingress', 'tunnel', '--public-url', 'https://t.example.com', ...DISCORD_FLAGS],
      env: { ...SECRETS, TUNNEL_TOKEN: TUNNEL },
    });
    expect(r.screens).toBe(r.plain);
    expect(parseEnvFile(r.screens).vars).toMatchObject({
      INGRESS: 'tunnel',
      TUNNEL_TOKEN: TUNNEL,
      PUBLIC_URL: 'https://t.example.com',
    });
  });

  test('VPS, no domain: sslip.io from the public IP', async () => {
    const r = await both({
      answers: { ...DISCORD, hosting: 'vps', vpsAddress: 'sslip' },
      flags: [
        '--host',
        'vps',
        '--public-url',
        'https://203-0-113-9.sslip.io',
        '--node-ip',
        '203.0.113.9',
        ...DISCORD_FLAGS,
      ],
      env: SECRETS,
    });
    expect(r.screens).toBe(r.plain);
    expect(parseEnvFile(r.screens).vars).toMatchObject({
      HOSTING: 'vps',
      PUBLIC_URL: 'https://203-0-113-9.sslip.io',
      LIVEKIT_NODE_IP: '203.0.113.9',
      UPNP: 'off',
    });
  });

  test('VPS, own domain, custom media ports', async () => {
    const r = await both({
      answers: {
        ...DISCORD,
        hosting: 'vps',
        domain: 't.example.com',
        mediaPorts: 'change',
        mediaTcp: '50000',
        mediaUdp: '50001',
      },
      flags: [
        '--host',
        'vps',
        '--public-url',
        'https://t.example.com',
        '--media-tcp',
        '50000',
        '--media-udp',
        '50001',
        '--turn',
        'on',
        ...DISCORD_FLAGS,
      ],
      env: SECRETS,
    });
    expect(r.screens).toBe(r.plain);
    expect(parseEnvFile(r.screens).vars).toMatchObject({
      HTTP_PORT: '80',
      HTTPS_PORT: '443',
      MEDIA_TCP_PORT: '50000',
      MEDIA_UDP_PORT: '50001',
    });
  });

  test('Discord offline: the ids typed', async () => {
    const r = await both({
      offline: true,
      answers: {
        discordToken: TOKEN,
        clientId: APP,
        clientSecret: SECRET,
        guild: GUILD,
        role: ROLE,
        channels: `${CHANNEL},${CHANNEL2}`,
        hosting: 'vps',
        domain: 't.example.com',
      },
      flags: [
        '--host',
        'vps',
        '--public-url',
        'https://t.example.com',
        '--client-id',
        APP,
        '--turn',
        'on',
        ...DISCORD_FLAGS.map((f) => (f === CHANNEL ? `${CHANNEL},${CHANNEL2}` : f)),
      ],
      env: SECRETS,
    });
    expect(r.screens).toBe(r.plain);
    expect(parseEnvFile(r.screens).vars).toMatchObject({
      DISCORD_CLIENT_ID: APP,
      CHANNEL_IDS: `${CHANNEL},${CHANNEL2}`,
    });
  });

  test('online: the client id read from the token equals --client-id', async () => {
    const r = await both({
      answers: { ...DISCORD, hosting: 'vps', domain: 't.example.com' },
      flags: [
        '--host',
        'vps',
        '--public-url',
        'https://t.example.com',
        '--client-id',
        APP,
        '--turn',
        'on',
        ...DISCORD_FLAGS,
      ],
      env: SECRETS,
    });
    expect(r.screens).toBe(r.plain);
    expect(parseEnvFile(r.screens).vars.DISCORD_CLIENT_ID).toBe(APP);
  });

  test("VPS, own domain, no TURN: the screens' no is the flags' auto (off for an own domain)", async () => {
    const r = await both({
      answers: { ...DISCORD, hosting: 'vps', domain: 't.example.com', turn: 'off' },
      flags: ['--host', 'vps', '--public-url', 'https://t.example.com', ...DISCORD_FLAGS],
      env: SECRETS,
    });
    expect(r.screens).toBe(r.plain);
    expect(parseEnvFile(r.screens).vars.TURN).toBeUndefined();
  });

  test('VPS, DuckDNS: TURN yes is the default auto, left commented', async () => {
    const r = await both({
      answers: {
        ...DISCORD,
        hosting: 'vps',
        vpsAddress: 'duckdns',
        duckName: 'my-group',
        duckToken: DUCK,
        redirect: 'skip',
        turn: 'on',
      },
      flags: ['--host', 'vps', '--duckdns-domain', 'my-group', ...DISCORD_FLAGS],
      env: { ...SECRETS, DUCKDNS_TOKEN: DUCK },
    });
    expect(r.screens).toBe(r.plain);
    expect(parseEnvFile(r.screens).vars.TURN).toBeUndefined();
    expect(r.screens).toContain('#TURN=auto');
  });

  test("home, LiveKit Cloud: the project's URL, key and secret, no media ports", async () => {
    const r = await both({
      answers: {
        ...DISCORD,
        hosting: 'home',
        homeCf: 'no',
        duckName: 'my-group',
        duckToken: DUCK,
        media: 'cloud',
        cloudUrl: 'https://my-proj.livekit.cloud/',
        cloudKey: 'APIcloudkey',
        cloudSecret: 'cloud-secret',
      },
      flags: [
        '--host',
        'home',
        '--duckdns-domain',
        'my-group',
        '--media',
        'cloud',
        '--cloud-url',
        'wss://my-proj.livekit.cloud',
        '--livekit-key',
        'APIcloudkey',
        ...DISCORD_FLAGS,
      ],
      env: { ...SECRETS, DUCKDNS_TOKEN: DUCK, LIVEKIT_API_SECRET: 'cloud-secret' },
    });
    expect(r.screens).toBe(r.plain);
    expect(parseEnvFile(r.screens).vars).toMatchObject({
      MEDIA: 'cloud',
      LIVEKIT_CLOUD_URL: 'wss://my-proj.livekit.cloud',
      LIVEKIT_API_KEY: 'APIcloudkey',
      LIVEKIT_API_SECRET: 'cloud-secret',
    });
    for (const k of ['MEDIA_TCP_PORT', 'MEDIA_UDP_PORT', 'TURN'])
      expect(parseEnvFile(r.screens).vars[k]).toBeUndefined();
  });
});
