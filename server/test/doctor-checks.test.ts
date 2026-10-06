import { describe, expect, test } from 'bun:test';
import { loadConfig, type Config } from '../src/config.ts';
import { broadAclEntries, CHECKS, compareVersions, inviteUrl, neededPorts, runChecks } from '../src/doctor/checks.ts';
import type {
  Check, CheckContext, CheckResult, ControlStatusLike, NatProbeLike, NetLike, ServiceStatusLike, SysLike, UpdateStateLike,
} from '../src/doctor/types.ts';
import type { Locale } from '../src/i18n.ts';
import { SYSCTL_SCRIPT } from '../src/service/systemd.ts';

const ENV = {
  DISCORD_TOKEN: 'bot-tok', DISCORD_CLIENT_ID: '111', DISCORD_CLIENT_SECRET: 'csecret', // gitleaks:allow
  GUILD_ID: '100', ROLE_ID: '200', CHANNEL_IDS: '300,301',
  PUBLIC_URL: 'https://telinha.example.com', COOKIE_SECRET: 'secret', // gitleaks:allow
  LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'lksecret', // gitleaks:allow
  INGRESS: 'direct', TELINHA_HOME: '/srv/telinha', HTTPS_PORT: '443', HTTP_PORT: '80',
};
const ENV_FILE = '/srv/telinha/config/telinha.env';
const API = 'https://discord.com/api/v10';
const PUBLIC = '203.0.113.7';

// Paths are joined with the host's separator; the fixtures use '/'.
const norm = (p: string) => p.replaceAll('\\', '/');

type Route = unknown | number | Error | ((init?: RequestInit) => Response);

const APP = { id: '111', name: 'Telinha', flags: (1 << 13) | (1 << 15), redirect_uris: ['https://telinha.example.com/auth/callback'] };
const DISCORD: Record<string, Route> = {
  [`${API}/applications/@me`]: APP,
  [`${API}/users/@me/guilds`]: [{ id: '100', name: 'Gurizada' }, { id: '9', name: 'Other' }],
  [`${API}/guilds/100/roles`]: [{ id: '200', name: 'Members' }],
  [`${API}/guilds/100/channels`]: [{ id: '300', name: 'geral', type: 0 }, { id: '301', name: 'avisos', type: 5 }, { id: '302', name: 'Voz', type: 2 }],
  'https://telinha.example.com/healthz': { ok: true },
  'http://127.0.0.1:8081/healthz': { ok: true, rooms: 2, children: { livekit: 'up', caddy: 'up' } },
  'http://127.0.0.1:7880/': 'OK',
};

function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const r = Object.hasOwn(routes, url) ? routes[url] : new Error(`no route ${url}`);
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return (r as (i?: RequestInit) => Response)(init);
    if (typeof r === 'number') return new Response('{}', { status: r });
    if (typeof r === 'string') return new Response(r);
    return Response.json(r);
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

interface Opts {
  env?: Record<string, string>;
  routes?: Record<string, Route>;
  net?: Partial<NetLike>;
  sys?: Partial<SysLike>;
  files?: Record<string, string>;
  nat?: NatProbeLike | null;
  service?: ServiceStatusLike | null;
  control?: ControlStatusLike | null;
  compiled?: boolean;
  version?: string;
  latest?: string | null;
  updateState?: UpdateStateLike | null;
  local?: boolean;
  locale?: Locale;
}

function ctxFor(o: Opts = {}) {
  const env: Record<string, string> = { ...ENV, ...o.env };
  for (const [k, v] of Object.entries(env)) if (v === '') delete env[k];
  let config: Config | null = null;
  let configError: string | null = null;
  try {
    config = loadConfig(env);
  } catch (e) {
    configError = (e as Error).message;
  }
  const f = fakeFetch({ ...DISCORD, ...o.routes });
  const files: Record<string, string> = o.files ?? { [ENV_FILE]: 'PUBLIC_URL=https://telinha.example.com\n' };
  const net: NetLike = {
    lookupPublicIp: async () => PUBLIC,
    resolveA: async () => [PUBLIC],
    tlsInfo: async () => ({ validTo: Date.now() + 60 * 86_400_000, issuer: "Let's Encrypt", subjectAltNames: ['telinha.example.com'], authorized: true }),
    tcpOpen: async () => true,
    ...o.net,
  };
  const sys: Partial<SysLike> = {
    platform: 'linux', isRoot: false,
    readText: (p) => files[norm(p)] ?? null,
    fileMode: (p) => (norm(p) in files ? 0o100600 : null),
    icacls: async () => null,
    which: () => null,
    exists: (p) => norm(p) in files,
    ...o.sys,
  };
  let latestCalls = 0;
  const ctx: CheckContext = {
    env, envFile: ENV_FILE, paths: config?.paths ?? { home: '', bin: '/srv/telinha/bin', config: '', data: '', run: '/srv/telinha/data/run', logs: '', logFile: '' },
    config, configError, fetch: f.fetch, locale: o.locale ?? 'en', local: o.local ?? false,
    nat: o.nat === null ? null : { probe: async () => o.nat ?? { gateway: { kind: 'igd', gatewayIp: '192.168.0.1', localIp: '192.168.0.10' }, externalIp: PUBLIC, localIp: '192.168.0.10', errors: [] } },
    service: o.service === null ? null : async () => o.service ?? { installed: true, running: true, enabled: true, detail: '' },
    control: o.control === undefined || o.control === null ? null : { available: async () => true, status: async () => o.control! },
    compiled: o.compiled ?? true,
    version: o.version ?? '0.7.0',
    latestTag: async () => { latestCalls++; return o.latest === undefined ? 'v0.7.0' : o.latest; },
    updateState: o.updateState ?? null,
    net, sys, versions: { livekit: { version: '1.13.7' }, caddy: { version: '2.11.4' }, cloudflared: { version: '2026.9.3' } },
  };
  return { ctx, calls: f.calls, latestCalls: () => latestCalls };
}

const byId = (rs: CheckResult[]) => Object.fromEntries(rs.map((r) => [r.id, r]));
async function run(id: string, o: Opts = {}) {
  const { ctx } = ctxFor(o);
  // Through runChecks so the shared lookups behave as in a real run.
  return byId(await runChecks(CHECKS, ctx))[id]!;
}
const one = async (id: string, o: Opts = {}) => {
  const { ctx } = ctxFor(o);
  return CHECKS.find((c) => c.id === id)!.run(ctx);
};

const BIN_FILES = {
  [ENV_FILE]: 'GUILD_ID=100\n',
  '/srv/telinha/bin/livekit-server': '', '/srv/telinha/bin/livekit.version': '1.13.7\n',
  '/srv/telinha/bin/caddy': '', '/srv/telinha/bin/caddy.version': '2.11.4\n',
};

test('checks run in the documented order', () => {
  expect(CHECKS.map((c) => c.id)).toEqual([
    'config', 'binaries', 'discord-token', 'discord-intents', 'discord-guild', 'discord-role', 'discord-channels', 'discord-redirect',
    'public-ip', 'dns', 'tls', 'listeners', 'service', 'gateway', 'cgnat', 'mappings', 'update',
  ]);
});

test('a healthy setup is all ok', async () => {
  const { ctx } = ctxFor({ files: BIN_FILES });
  const rs = await runChecks(CHECKS, ctx);
  expect(rs.filter((r) => r.status !== 'ok').map((r) => `${r.id}: ${r.summary}`)).toEqual([
    // No upnp.json and no running service to ask.
    'mappings: Skipped: the running service opens the ports; start it to see them.',
  ]);
  for (const r of rs) expect(r.title).not.toBe(r.id);
});

describe('config', () => {
  test('error from loadConfig is a fail with the message', async () => {
    const r = await one('config', { env: { PUBLIC_URL: '' } });
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('missing env PUBLIC_URL');
    expect(r.fix).toContain(ENV_FILE);
  });

  test('unknown keys and envfile warnings are warnings', async () => {
    const r = await one('config', { files: { [ENV_FILE]: 'PUBLIK_URL=x\nGUILD_ID=1\n' } });
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('PUBLIK_URL');
  });

  test('linux: group/world readable file fails with chmod', async () => {
    const r = await one('config', { sys: { fileMode: () => 0o100644 } });
    expect(r.status).toBe('fail');
    expect(r.fix).toBe(`Run: chmod 600 "${ENV_FILE}"`);
    expect(r.detail).toContain('mode 644');
  });

  test('linux: the root install\'s root:telinha 0640 is fine; group-readable and owned by someone else is not', async () => {
    expect((await one('config', { sys: { fileMode: () => 0o100640, fileUid: () => 0 } })).status).toBe('ok');
    expect((await one('config', { sys: { fileMode: () => 0o100640, fileUid: () => 1000 } })).status).toBe('fail');
    expect((await one('config', { sys: { fileMode: () => 0o100660, fileUid: () => 0 } })).status).toBe('fail');
  });

  test('windows: broad ACL entries fail; owner-only passes', async () => {
    const open = `${ENV_FILE} BUILTIN\\Users:(I)(RX)\n    NT AUTHORITY\\SYSTEM:(I)(F)\n\nSuccessfully processed 1 files`;
    const r = await one('config', { sys: { platform: 'win32', icacls: async () => open } });
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('icacls');
    const closed = `${ENV_FILE} DESKTOP\\joao:(F)\n NT AUTHORITY\\SYSTEM:(F)\n BUILTIN\\Administrators:(F)\n`;
    expect((await one('config', { sys: { platform: 'win32', icacls: async () => closed } })).status).toBe('ok');
  });

  test('no file: environment only, permission part skipped', async () => {
    const r = await one('config', { files: {} });
    expect(r.status).toBe('ok');
    expect(r.summary).toContain('environment');
    expect(r.detail?.[0]).toContain('no file permissions');
  });
});

test('broadAclEntries reads English and Portuguese (mangled code page) Windows', () => {
  expect(broadAclEntries('f BUILTIN\\Usu�rios:(I)(RX)\n NT AUTHORITY\\Usuários autenticados:(I)(M)\n Todos:(R)')).toHaveLength(3);
  expect(broadAclEntries('f NT AUTHORITY\\Authenticated Users:(I)(M)\n Everyone:(R)\n PC\\UsersGroupX:(F)')).toHaveLength(2);
  expect(broadAclEntries('f NT AUTHORITY\\SYSTEM:(F)\n PC\\joao:(F)')).toEqual([]);
});

describe('binaries', () => {
  test('present with matching sidecars', async () => {
    const r = await one('binaries', { files: BIN_FILES });
    expect(r.status).toBe('ok');
    expect(r.detail?.map(norm)).toEqual(['livekit 1.13.7 (/srv/telinha/bin/livekit-server)', 'caddy 2.11.4 (/srv/telinha/bin/caddy)']);
  });

  test('stale sidecar is a pending update (warn); missing is a fail', async () => {
    const stale = await one('binaries', { files: { ...BIN_FILES, '/srv/telinha/bin/caddy.version': '2.10.0' } });
    expect(stale.status).toBe('warn');
    expect(stale.summary).toContain('caddy 2.10.0 is installed, 2.11.4 is pinned');
    const missing = await one('binaries', { files: { [ENV_FILE]: '' } });
    expect(missing.status).toBe('fail');
    expect(missing.fix).toContain('Start telinha');
  });

  test('on PATH counts (Docker image)', async () => {
    const r = await one('binaries', { files: { [ENV_FILE]: '' }, sys: { which: (n) => `/usr/local/bin/${n}` }, env: { INGRESS: 'tunnel', TUNNEL_TOKEN: 't' } });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('cloudflared found on PATH (/usr/local/bin/cloudflared)');
  });
});

describe('discord', () => {
  test('every call carries the Bot token', async () => {
    const { ctx, calls } = ctxFor();
    await runChecks(CHECKS.filter((c) => c.id.startsWith('discord-')), ctx);
    const discord = calls.filter((c) => c.url.startsWith(API));
    expect(discord.length).toBe(4); // app, guilds, roles, channels: each fetched once
    for (const c of discord) expect(c.auth).toBe('Bot bot-tok');
  });

  test('401: token fails, the rest skip', async () => {
    const { ctx } = ctxFor({ routes: { [`${API}/applications/@me`]: 401, [`${API}/users/@me/guilds`]: 401 } });
    const rs = byId(await runChecks(CHECKS.filter((c) => c.id.startsWith('discord-')), ctx));
    expect(rs['discord-token']!.status).toBe('fail');
    expect(rs['discord-token']!.fix).toContain('Reset Token');
    for (const id of ['discord-intents', 'discord-guild', 'discord-role', 'discord-channels', 'discord-redirect']) expect(rs[id]!.status).toBe('skip');
  });

  test('client id of another application fails', async () => {
    const r = await one('discord-token', { env: { DISCORD_CLIENT_ID: '999' } });
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('DISCORD_CLIENT_ID=111');
  });

  test('intents: limited or full bits count; missing ones are named', async () => {
    expect((await one('discord-intents', { routes: { [`${API}/applications/@me`]: { ...APP, flags: (1 << 12) | (1 << 14) } } })).status).toBe('ok');
    const r = await one('discord-intents', { routes: { [`${API}/applications/@me`]: { ...APP, flags: 1 << 13 } } });
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('Server Members');
    expect(r.summary).not.toContain('Presence');
    expect(r.fix).toContain('telinha setup');
  });

  test('bot not in the guild: fail with the invite URL', async () => {
    const r = await run('discord-guild', { routes: { [`${API}/users/@me/guilds`]: [{ id: '9', name: 'Other' }] } });
    expect(r.status).toBe('fail');
    expect(r.fix).toContain(inviteUrl('111', '100'));
    expect(inviteUrl('111', '100')).toBe('https://discord.com/oauth2/authorize?client_id=111&scope=bot%20applications.commands&permissions=68608&guild_id=100&disable_guild_select=true');
  });

  test('role and channels', async () => {
    expect((await run('discord-role', { env: { ROLE_ID: '201' } })).status).toBe('fail');
    expect((await run('discord-role')).summary).toContain('Members');
    expect((await run('discord-channels')).summary).toContain('#geral, #avisos');
    const voice = await run('discord-channels', { env: { CHANNEL_IDS: '300,302,303' } });
    expect(voice.status).toBe('fail');
    expect([voice.summary, ...(voice.detail ?? [])].join('\n')).toMatch(/Voz.*302[\s\S]*303/);
  });

  test('redirect missing: fail naming the exact URI', async () => {
    const r = await run('discord-redirect', { routes: { [`${API}/applications/@me`]: { ...APP, redirect_uris: ['http://localhost/auth/callback'] } } });
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('https://telinha.example.com/auth/callback');
    expect(r.detail?.[0]).toContain('http://localhost/auth/callback');
  });

  test('dev login skips Discord', async () => {
    const r = await one('discord-token', { env: { DEV_USER: '1:Dev', PUBLIC_URL: 'http://localhost:8081', INGRESS: 'external' } });
    expect(r.status).toBe('skip');
  });
});

describe('public address', () => {
  test('public-ip fails offline', async () => {
    expect((await run('public-ip', { net: { lookupPublicIp: async () => { throw new Error('offline'); } } })).status).toBe('fail');
  });

  test('dns: direct must point at the public IP', async () => {
    expect((await run('dns')).status).toBe('ok');
    const wrong = await run('dns', { net: { resolveA: async () => ['198.51.100.1'] } });
    expect(wrong.status).toBe('fail');
    expect(wrong.fix).toContain(PUBLIC);
    const none = await run('dns', { net: { resolveA: async () => { throw new Error('ENOTFOUND'); } } });
    expect(none.status).toBe('fail');
  });

  test('dns: LIVEKIT_NODE_IP is the expected address', async () => {
    expect((await run('dns', { env: { LIVEKIT_NODE_IP: '198.51.100.1' }, net: { resolveA: async () => ['198.51.100.1'] } })).status).toBe('ok');
  });

  test('dns: tunnel only needs to resolve; DuckDNS mismatch is reported, not fixed', async () => {
    expect((await run('dns', { env: { INGRESS: 'tunnel', TUNNEL_TOKEN: 't' }, net: { resolveA: async () => ['104.16.1.1'] } })).status).toBe('ok');
    const duck = await run('dns', {
      env: { PUBLIC_URL: 'https://grupo.duckdns.org', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'grupo', DUCKDNS_TOKEN: 't' }, net: { resolveA: async () => ['198.51.100.1'] },
    });
    expect(duck.status).toBe('warn');
    expect(duck.summary).toBe(`DuckDNS points grupo.duckdns.org at 198.51.100.1, the public IP is ${PUBLIC}; the running service updates it.`);
  });

  test('tls: expiring soon warns, untrusted fails, healthz must answer', async () => {
    expect((await run('tls')).status).toBe('ok');
    const soon = await run('tls', { net: { tlsInfo: async () => ({ validTo: Date.now() + 5 * 86_400_000, issuer: 'LE', subjectAltNames: [], authorized: true }) } });
    expect(soon.status).toBe('warn');
    const bad = await run('tls', { net: { tlsInfo: async () => ({ validTo: 0, issuer: '', subjectAltNames: [], authorized: false, error: 'self-signed certificate' }) } });
    expect(bad.status).toBe('fail');
    expect(bad.summary).toContain('self-signed');
    expect(bad.fix).toContain('Caddy');
    const down = await run('tls', { routes: { 'https://telinha.example.com/healthz': 502 } });
    expect(down.status).toBe('fail');
    expect(down.summary).toContain('/healthz');
  });
});

describe('listeners and service', () => {
  test('service not running: warn with the start command', async () => {
    const r = await one('listeners', { routes: { 'http://127.0.0.1:8081/healthz': new Error('ECONNREFUSED') } });
    expect(r.status).toBe('warn');
    expect(r.fix).toContain('telinha service start');
  });

  test('children down and closed ports are listed', async () => {
    const r = await one('listeners', {
      routes: { 'http://127.0.0.1:8081/healthz': { ok: true, rooms: 0, children: { livekit: 'down', caddy: 'up' } }, 'http://127.0.0.1:7880/': 503 },
      net: { tcpOpen: async () => false },
    });
    expect(r.status).toBe('warn');
    expect([r.summary, ...(r.detail ?? [])].join('\n')).toMatch(/livekit[\s\S]*7880[\s\S]*7881[\s\S]*443/);
  });

  test('low port as non-root on Linux explains the sysctl', async () => {
    const closed443 = { tcpOpen: async (_h: string, p: number) => p !== 443 };
    const r = await one('listeners', { net: closed443, routes: { 'http://127.0.0.1:8081/healthz': { ok: true, children: {} } } });
    // The same one sudo step setup offers, and the same high-port alternative.
    expect(r.fix).toContain(`sudo sh -c '${SYSCTL_SCRIPT}'`);
    expect(r.fix).toContain('HTTPS_PORT=8443 and HTTP_PORT=0');
    const root = await one('listeners', { net: closed443, sys: { isRoot: true }, routes: { 'http://127.0.0.1:8081/healthz': { ok: true, children: {} } } });
    expect(root.fix).toBeUndefined();
  });

  test('ufw and firewalld hints name the ports this host listens on', async () => {
    const env = { HTTPS_PORT: '8443', HTTP_PORT: '0', PUBLIC_URL: 'https://telinha.example.com' };
    const tools = (names: string[]) => ({ which: (n: string) => (names.includes(n) ? `/usr/sbin/${n}` : null) });
    const both = await one('listeners', { env, sys: tools(['ufw', 'firewall-cmd']) });
    expect(both.status).toBe('ok');
    expect(both.detail).toContain('If ufw is active, open the ports: sudo ufw allow 8443/tcp && sudo ufw allow 7881/tcp && sudo ufw allow 7882/udp');
    expect(both.detail).toContain(
      'If firewalld is running, open the ports: sudo firewall-cmd --permanent --add-port=8443/tcp --add-port=7881/tcp --add-port=7882/udp && sudo firewall-cmd --reload',
    );
    // Shown even when telinha is down: a closed firewall is one reason it looks down.
    const down = await one('listeners', { env, sys: tools(['ufw']), routes: { 'http://127.0.0.1:8081/healthz': new Error('ECONNREFUSED') } });
    expect(down.detail?.join('\n')).toContain('sudo ufw allow 8443/tcp');
    const pt = await one('listeners', { env, sys: tools(['ufw']), locale: 'pt-BR' });
    expect(pt.detail?.join('\n')).toContain('Se o ufw estiver ativo');
    expect((await one('listeners', { env })).detail?.join('\n')).not.toMatch(/ufw|firewall/);
    expect((await one('listeners', { env, sys: { platform: 'win32', ...tools(['ufw']) } })).detail?.join('\n')).not.toContain('ufw');
  });

  test('service states', async () => {
    expect((await one('service', { service: null })).status).toBe('skip');
    const notInstalled = await one('service', { service: { installed: false, running: false, enabled: false, detail: '' } });
    expect(notInstalled.fix).toBe('Run: telinha service install');
    expect((await one('service', { service: { installed: true, running: false, enabled: true, detail: 'inactive' } })).fix).toBe('Run: telinha service start');
    expect((await one('service')).status).toBe('ok');
  });

  test('service fixes per platform: Windows goes through setup (one UAC prompt, firewall, the right account), root gets sudo', async () => {
    const missing = { installed: false, running: false, enabled: false, detail: '' };
    const disabled = { installed: true, running: true, enabled: false, detail: '' };
    const win = { sys: { platform: 'win32' as const } };
    expect((await one('service', { ...win, service: missing })).fix).toContain('Run telinha setup again: it installs the service (and the firewall rules)');
    expect((await one('service', { ...win, service: disabled })).fix).toContain('Run telinha setup again');
    const root = { sys: { platform: 'linux' as const, isRoot: true } };
    expect((await one('service', { ...root, service: missing })).fix).toBe('Run: sudo telinha service install');
    expect((await one('service', { ...root, service: disabled })).fix).toBe('Run: sudo telinha service install (again)');
  });
});

describe('router', () => {
  const gw = { kind: 'igd' as const, gatewayIp: '192.168.0.1', localIp: '192.168.0.10' };
  const nat = (externalIp: string | null, gateway: typeof gw | null = gw): NatProbeLike => ({ gateway, externalIp, localIp: '192.168.0.10', errors: [] });

  test('CGNAT fails, double NAT warns, a public external IP is ok', async () => {
    const cg = await run('cgnat', { nat: nat('100.72.3.4') });
    expect(cg.status).toBe('fail');
    expect(cg.fix).toContain('public IP');
    const dbl = await run('cgnat', { nat: nat('192.168.1.5') });
    expect(dbl.status).toBe('warn');
    expect(dbl.summary).toContain('Double NAT');
    expect(dbl.fix).toContain('TCP 443, TCP 80, TCP 7881, UDP 7882');
    expect((await run('cgnat', { nat: nat(PUBLIC) })).status).toBe('ok');
    expect((await run('cgnat', { nat: nat('198.51.100.9') })).status).toBe('warn');
  });

  test('no gateway: router warns with the ports, cgnat and mappings skip', async () => {
    const rs = byId(await runChecks(CHECKS, ctxFor({ nat: nat(null, null) }).ctx));
    expect(rs.gateway!.status).toBe('warn');
    expect(rs.gateway!.fix).toContain('TCP 443');
    expect(rs.cgnat!.status).toBe('skip');
    expect(rs.mappings!.status).toBe('skip');
  });

  test('a host with a public address needs no router', async () => {
    const vps: NatProbeLike = { gateway: null, externalIp: null, localIp: PUBLIC, errors: ['no SSDP answer'] };
    const rs = byId(await runChecks(CHECKS, ctxFor({ nat: vps }).ctx));
    expect(rs.gateway!.status).toBe('ok');
    expect(rs.cgnat!.status).toBe('ok');
  });

  test('mappings from the running service: partial warns with the list', async () => {
    const upnp = {
      enabled: true,
      mappings: [
        { protocol: 'tcp', externalPort: 443, internalPort: 443, state: 'mapped' },
        { protocol: 'tcp', externalPort: 80, internalPort: 80, state: 'mapped' },
        { protocol: 'tcp', externalPort: 7881, internalPort: 7881, state: 'mapped' },
        { protocol: 'udp', externalPort: 7882, internalPort: 7882, state: 'failed', error: 'ConflictInMappingEntry' },
      ],
    };
    const r = await run('mappings', { control: { upnp } });
    expect(r.status).toBe('warn');
    expect(r.summary).toBe('Not forwarded: UDP 7882.');
    expect(r.fix).toContain('192.168.0.10');
    expect(r.detail).toEqual(['UDP 7882: ConflictInMappingEntry']);
    upnp.mappings[3]!.state = 'mapped';
    expect((await run('mappings', { control: { upnp } })).status).toBe('ok');
  });

  test('mappings from upnp.json when the service is not reachable; UPNP=off skips', async () => {
    const file = JSON.stringify({ mappings: [443, 80, 7881].map((p) => ({ protocol: 'tcp', externalPort: p })).concat([{ protocol: 'udp', externalPort: 7882 }]) });
    expect((await run('mappings', { files: { [ENV_FILE]: '', '/srv/telinha/data/run/upnp.json': file } })).status).toBe('ok');
    const off = await run('mappings', { env: { UPNP: 'off' } });
    expect(off.status).toBe('skip');
    expect(off.summary).toContain('UDP 7882');
  });

  test('neededPorts follows ingress and the PUBLIC_URL port', () => {
    const c = loadConfig({ ...ENV, PUBLIC_URL: 'https://t.example.com:8443', HTTPS_PORT: '8443', HTTP_PORT: '0' });
    expect(neededPorts(c)).toEqual([
      { protocol: 'tcp', external: 8443, internal: 8443 },
      { protocol: 'tcp', external: 7881, internal: 7881 },
      { protocol: 'udp', external: 7882, internal: 7882 },
    ]);
    expect(neededPorts(loadConfig({ ...ENV, INGRESS: 'tunnel', TUNNEL_TOKEN: 't' }))).toHaveLength(2);
  });
});

describe('update', () => {
  test('not compiled: skip', async () => {
    expect((await one('update', { compiled: false })).status).toBe('skip');
  });

  test('newer stable release available: warn', async () => {
    const r = await one('update', { latest: 'v0.8.0' });
    expect(r.status).toBe('warn');
    expect(r.summary).toBe('v0.8.0 is available (running 0.7.0).');
    expect((await one('update', { latest: 'v0.7.0' })).summary).toBe('Up to date (0.7.0).');
  });

  test('failed / staged / pending from update.json', async () => {
    const failed = await one('update', { latest: 'v0.8.0', updateState: { failed: { tag: 'v0.8.0', at: 1, reason: 'start failed twice (exit 1)' } } });
    expect(failed.status).toBe('warn');
    expect(failed.summary).toContain('start failed twice');
    expect(failed.detail).toBeUndefined(); // the failed tag is the latest: not repeated as "available"
    expect(failed.fix).toBe('Retry now: telinha update --now');
    expect((await one('update', { updateState: { staged: { tag: 'v0.8.0', previous: '0.7.0', at: 1, failedStarts: 0 } } })).summary).toContain('waiting for the restart');
    expect((await one('update', { updateState: { pending: { tag: 'v0.8.0', since: 1 } } })).summary).toContain('not ready yet');
  });

  test('the running service is asked first', async () => {
    const h = ctxFor({ control: { update: { latest: 'v0.9.0' } }, latest: 'v0.7.0' });
    const r = await CHECKS.find((c) => c.id === 'update')!.run(h.ctx);
    expect(r.summary).toContain('v0.9.0');
    expect(h.latestCalls()).toBe(0);
  });

  test('--local does not look the release up', async () => {
    const h = ctxFor({ local: true });
    const r = await CHECKS.find((c) => c.id === 'update')!.run(h.ctx);
    expect(r.summary).toBe('Running 0.7.0; the newest release is unknown.');
    expect(h.latestCalls()).toBe(0);
  });

  test('compareVersions', () => {
    expect(compareVersions('v0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('0.6.0', 'v0.7.0')).toBe(-1);
    expect(compareVersions('dev', 'v0.7.0')).toBeNull();
  });
});

describe('runChecks', () => {
  test('--local skips internet checks and reports in order', async () => {
    const { ctx, calls } = ctxFor({ local: true, files: BIN_FILES });
    const seen: string[] = [];
    const rs = await runChecks(CHECKS, ctx, (r) => seen.push(r.id));
    expect(seen).toEqual(CHECKS.map((c) => c.id));
    for (const id of ['discord-token', 'discord-intents', 'discord-guild', 'discord-role', 'discord-channels', 'discord-redirect', 'public-ip', 'dns', 'tls']) {
      expect(byId(rs)[id]!.status).toBe('skip');
    }
    expect(calls.some((c) => !c.url.startsWith('http://127.0.0.1'))).toBe(false);
  });

  test('a hung check times out, a throwing one fails, the rest still run', async () => {
    const hang: Check = { id: 'hang', run: () => new Promise(() => {}) };
    const boom: Check = { id: 'boom', run: async () => { throw new Error('kaput'); } };
    const ok: Check = { id: 'ok', run: async (ctx) => ({ id: 'ok', title: 'OK', status: 'ok', summary: ctx.locale }) };
    const rs = await runChecks([hang, boom, ok], ctxFor().ctx, undefined, { timeoutMs: 20 });
    expect(rs.map((r) => r.status)).toEqual(['fail', 'fail', 'ok']);
    expect(rs[0]!.summary).toContain('Did not finish');
    expect(rs[1]!.summary).toContain('kaput');
  });

  test('pt-BR', async () => {
    const cg: NatProbeLike = { gateway: { kind: 'igd', gatewayIp: '192.168.0.1', localIp: '192.168.0.10' }, externalIp: '100.64.1.1', localIp: '192.168.0.10', errors: [] };
    const rs = byId(await runChecks(CHECKS, ctxFor({ locale: 'pt-BR', nat: cg }).ctx));
    expect(rs.cgnat!.title).toBe('NAT da operadora');
    expect(rs.cgnat!.summary).toContain('operadora');
    expect(rs.cgnat!.fix).toContain('IP público');
  });
});
