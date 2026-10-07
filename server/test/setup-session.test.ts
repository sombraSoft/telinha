import { describe, expect, test } from 'bun:test';
import type { Ddns } from '../src/ddns.ts';
import type { NatProbe } from '../src/nat/index.ts';
import type { Locale } from '../src/cli/strings.ts';
import { createDiscordSetup, inviteUrl } from '../src/cli/setup/discord.ts';
import type { HostInfo } from '../src/cli/setup/host.ts';
import type { LookupDeps } from '../src/cli/setup/lookups.ts';
import type { Answers, QuestionId, Text, TrayState } from '../src/cli/setup/model.ts';
import { SetupSession } from '../src/cli/setup/session.ts';
import type { Values } from '../src/cli/setup/steps.ts';

const APP = '111111111111111111';
const GUILD = '222222222222222222';
const GUILD2 = '222222222222222229';
const ROLE = '333333333333333333';
const CHANNEL = '444444444444444441';
const CHANNEL2 = '444444444444444442';
const TOKEN = 'Nq8vXr3KpW7mTz2bLc5hJd'; // gitleaks:allow
const SECRET = 'Vy4kPq9wZr2nXm7tBc3s'; // gitleaks:allow
const DUCK = '7c2e9a4f1b8d3e6a0c5f9b2d'; // gitleaks:allow
const COOKIE = 'Hq3Zx8Vn5Kw2Pr7Tj4Lm9Bc6Df1Gs0Ya'; // gitleaks:allow
const TUNNEL = Buffer.from(JSON.stringify({ a: 'acct', t: 'tunnel-id', s: 'c2VjcmV0' })).toString('base64');
const DUCK_URL = 'https://my-group.duckdns.org:8443';

const NAT: NatProbe = {
  gateway: { kind: 'igd', version: 2, location: 'http://192.168.0.1:49152/d.xml', controlUrl: 'http://192.168.0.1/c', serviceType: 'x', localIp: '192.168.0.10', gatewayIp: '192.168.0.1', name: 'Fritz!Box' },
  externalIp: '203.0.113.9', localIp: '192.168.0.10', errors: [],
};
const HOME: HostInfo = { kind: 'linux-root', platform: 'linux', arch: 'x64', isRoot: true, docker: false, osName: 'Debian GNU/Linux 12 (bookworm)', publicIp: '203.0.113.9', nat: NAT };
const VPS: HostInfo = { ...HOME, nat: { gateway: null, externalIp: null, localIp: '203.0.113.9', errors: [] } };

/** Discord as one bot sees it; tests change it between checks (the bot joins a server, a redirect gets saved). */
interface World {
  guilds: { id: string; name: string }[];
  channels: unknown[];
  redirects: string[];
  flags: number;
  down: boolean;
  /** Holds every Discord answer until released (a slow network). */
  gate: Promise<void> | null;
  calls: string[];
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function world(o: Partial<World> = {}): World {
  return {
    guilds: [{ id: GUILD, name: 'Gurizada' }],
    channels: [{ id: CHANNEL, name: 'geral', type: 0, position: 0 }, { id: CHANNEL2, name: 'telinha', type: 0, position: 1, parent_id: '444444444444444440' }, { id: '444444444444444440', name: 'Salas', type: 4, position: 0 }],
    redirects: [`${DUCK_URL}/auth/callback`, 'https://t.example.com/auth/callback', 'https://telinha.example.com/auth/callback', 'https://203-0-113-9.sslip.io/auth/callback'],
    flags: (1 << 13) | (1 << 15), down: false, gate: null, calls: [],
    ...o,
  };
}

function discordFetch(w: World) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace('https://discord.com/api/v10', '');
    w.calls.push(url);
    if (w.gate) await w.gate;
    if (w.down) return json({ message: 'Service Unavailable' }, 503);
    const auth = new Headers(init?.headers).get('authorization');
    if (url === '/oauth2/token') return auth === `Basic ${Buffer.from(`${APP}:${SECRET}`).toString('base64')}` ? json({}) : json({ error: 'invalid_client' }, 401);
    if (auth !== `Bot ${TOKEN}`) return json({ message: '401: Unauthorized' }, 401);
    if (url === '/applications/@me') return json({ id: APP, name: 'Telinha Bot', flags: w.flags, redirect_uris: w.redirects });
    if (url === '/users/@me/guilds') return json(w.guilds);
    if (url === `/guilds/${GUILD}/roles`) return json([{ id: GUILD, name: '@everyone', position: 0 }, { id: ROLE, name: 'Membro', position: 1 }, { id: '333333333333333334', name: 'Bot', position: 2, managed: true }]);
    if (url === `/guilds/${GUILD}/channels`) return json(w.channels);
    return json({ message: 'Unknown' }, 404);
  }) as unknown as typeof fetch;
}

interface Opts {
  file?: Values; host?: HostInfo | null; preset?: Answers; acceptDefaults?: boolean; rerun?: boolean; presetErrors?: Text[];
  offline?: boolean; compiled?: boolean; docker?: boolean; isRoot?: boolean; langFlag?: boolean; locale?: Locale;
  world?: World; duckOk?: boolean; dns?: string[]; unprivilegedPortStart?: number | null;
  platform?: NodeJS.Platform; tray?: TrayState;
}

function make(o: Opts = {}) {
  const w = o.world ?? world();
  const file = o.file ?? {};
  const host = o.host === undefined ? HOME : o.host;
  const opened: string[] = [];
  const ddns: string[] = [];
  const deps: LookupDeps = {
    discord: (token) => createDiscordSetup({ token, fetch: discordFetch(w), version: 'test', sleep: async () => {} }),
    ddns: ({ domain }): Ddns => {
      let last: ReturnType<Ddns['last']> = null;
      return {
        async update(ip) {
          ddns.push(`${domain} ${ip}`);
          last = o.duckOk === false ? { ip, at: 1, ok: false, error: 'DuckDNS rejected the domain/token' } : { ip, at: 1, ok: true };
        },
        last: () => last,
      };
    },
    resolveA: async () => o.dns ?? ['203.0.113.9'],
    portInUse: async () => false,
    udpFree: async () => true,
    openUrl: async (url) => void opened.push(url),
  };
  const env = {
    platform: o.platform ?? 'linux', isRoot: o.isRoot ?? true, docker: !!o.docker, compiled: !!o.compiled, offline: !!o.offline, langFlag: o.langFlag ?? true,
    flags: { noService: false, noUpnp: false, noFirewall: false, noDoctor: false }, file, unprivilegedPortStart: o.unprivilegedPortStart ?? null,
    ...(o.tray && { tray: o.tray }),
  };
  const s = new SetupSession({
    env, host, base: { file, host, locale: o.locale ?? 'en', langFlag: env.langFlag, docker: env.docker, compiled: env.compiled },
    locale: o.locale ?? 'en', deps, preset: o.preset ?? {}, acceptDefaults: !!o.acceptDefaults, rerun: !!o.rerun, presetErrors: o.presetErrors ?? [],
  });
  return { s, w, opened, ddns };
}

/** Lets the background list reads finish. */
const settle = () => new Promise((r) => setTimeout(r, 5));

async function answer(s: SetupSession, id: QuestionId, value: string | string[]) {
  expect(s.current().id).toBe(id);
  const r = await s.submit(value);
  if (r !== 'advanced') throw new Error(`${id} stayed: ${JSON.stringify(s.current())}`);
  await settle();
}

/** A fresh home install up to the Discord step: no domain on Cloudflare, DuckDNS on 8443. */
async function homeDuck(s: SetupSession) {
  await answer(s, 'hosting', 'home');
  await answer(s, 'homeCf', 'no');
  await answer(s, 'duckName', 'My-Group.duckdns.org');
  await answer(s, 'duckToken', DUCK);
  await answer(s, 'httpsPort', '');
}

async function discord(s: SetupSession) {
  await answer(s, 'discordToken', TOKEN);
  await answer(s, 'clientSecret', SECRET);
  await answer(s, 'guild', GUILD);
  await answer(s, 'role', ROLE);
  await answer(s, 'channels', [CHANNEL]);
  await answer(s, 'command', '');
  await answer(s, 'group', '');
}

const D = { DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_ID: APP, DISCORD_CLIENT_SECRET: SECRET, GUILD_ID: GUILD, ROLE_ID: ROLE, CHANNEL_IDS: CHANNEL, COMMAND_NAME: 'telinha' };
const VPS_FILE: Values = { ...D, COOKIE_SECRET: COOKIE, PUBLIC_URL: 'https://telinha.example.com', HOSTING: 'vps', INGRESS: 'direct', HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'off', LOCALE: 'en' };
const clean = (v: Values) => Object.fromEntries(Object.entries(v).filter(([, x]) => x));

describe('a fresh home install', () => {
  test('question by question to the Review: the file of a home DuckDNS setup', async () => {
    const { s, ddns } = make();
    expect(s.screen()).toBe('question');
    expect(s.current()).toMatchObject({ id: 'hosting', title: 'Where will Telinha run?', kind: 'select', initial: 'home', badge: 'Where · Step 1 of 6' });
    expect(s.current().hint).toEqual(['This machine: Debian GNU/Linux 12 (bookworm), x64, public IP 203.0.113.9.', 'Router: Fritz!Box (UPnP IGD v2, 192.168.0.1).']);
    await homeDuck(s);
    expect(ddns).toEqual(['my-group 203.0.113.9']);
    await discord(s);
    await answer(s, 'mediaPorts', 'keep');
    expect(s.current().id).toBe('upnp');
    expect(s.current().hint).toContain(`  TCP 8443 → 192.168.0.10`);
    await answer(s, 'upnp', 'auto');
    expect(s.screen()).toBe('review');
    expect(s.allAnswered()).toBe(true);
    expect(clean(s.values())).toEqual({
      ...D, HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: DUCK_URL, HTTP_PORT: '0', HTTPS_PORT: '8443', ACME_DNS: 'duckdns',
      DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: DUCK, UPNP: 'auto', LOCALE: 'en',
    });
    expect(s.webAddress()).toBe(DUCK_URL);
    expect(s.steps().map((x) => [x.id, x.state, x.jumpable, x.summary])).toEqual([
      ['where', 'done', true, 'A computer at home'],
      ['address', 'done', true, 'DuckDNS :8443'],
      ['discord', 'done', true, '/telinha · Gurizada'],
      ['ports', 'done', true, 'TCP 7881, 8443\nUDP 7882'],
      ['review', 'current', true, ''],
      ['install', 'pending', false, ''],
    ]);
    expect(s.applyOptions()).toEqual({ sysctl: null, canRotateCookie: false, tray: null });
  });

  test('the client id comes from the token (not asked online) and reaches the values', async () => {
    const { s } = make();
    await homeDuck(s);
    expect(s.values().DISCORD_CLIENT_ID).toBeUndefined();
    await answer(s, 'discordToken', TOKEN);
    expect(s.notice()).toEqual({ kind: 'info', text: `Bot: Telinha Bot (app id ${APP})` });
    expect(s.current().id).toBe('clientSecret');
    expect(s.values().DISCORD_CLIENT_ID).toBe(APP);
  });

  test('the Review shows option labels and the web address; secrets only as a status', async () => {
    const { s } = make();
    await homeDuck(s);
    await discord(s);
    await answer(s, 'mediaPorts', 'keep');
    await answer(s, 'upnp', 'auto');
    const rows = s.reviewRows();
    expect(rows.map((r) => [r.step, r.label, r.value, r.kind])).toEqual([
      ['Where', 'Where will Telinha run?', 'A computer at home', 'plain'],
      ['Address', 'Do you have a domain on Cloudflare?', 'No: use a free DuckDNS address', 'plain'],
      ['', 'DuckDNS name', 'my-group', 'plain'],
      ['', 'DuckDNS token', 'set', 'secret'],
      ['', 'HTTPS port', '8443', 'plain'],
      ['', 'Web address', DUCK_URL, 'url'],
      ['Discord', 'Discord bot token', 'set', 'secret'],
      ['', 'Client secret', 'set', 'secret'],
      ['', 'Which server?', 'Gurizada', 'plain'],
      ['', 'Who may enter the rooms?', '@Membro', 'plain'],
      ['', 'Where does the command work?', '#geral', 'plain'],
      ['', 'Command name', 'telinha', 'plain'],
      ['', 'Group name', 'Gurizada', 'plain'],
      ['Ports', 'Media ports', 'Keep TCP 7881 and UDP 7882', 'plain'],
      ['', 'Ask the router?', 'Yes, ask the router', 'plain'],
    ]);
  });

  test('no screen ever shows a secret, not even four characters of it', async () => {
    const { s } = make();
    const seen: string[] = [];
    const look = () => {
      if (s.screen() === 'question') seen.push(JSON.stringify(s.current()));
      seen.push(JSON.stringify([s.steps(), s.notice(), s.reviewRows(), s.reviewNotes()]));
    };
    s.subscribe(look);
    await homeDuck(s);
    await discord(s);
    // Coming back to a secret: kept, never shown.
    s.back();
    for (let i = 0; i < 6; i++) s.back();
    expect(s.current()).toMatchObject({ id: 'discordToken', initial: '', keepsSecret: true, defaultText: undefined });
    look();
    for (const secret of [TOKEN, SECRET, DUCK]) {
      for (let i = 0; i + 4 <= secret.length; i++) {
        const part = secret.slice(i, i + 4);
        for (const frame of seen) if (frame.includes(part)) throw new Error(`"${part}" of a secret on screen: ${frame.slice(0, 200)}`);
      }
    }
    // The values keep them for the file.
    expect(s.values()).toMatchObject({ DISCORD_TOKEN: TOKEN, DUCKDNS_TOKEN: DUCK });
  });

  test('a pasted tunnel install command keeps the token alone', async () => {
    const { s } = make();
    await answer(s, 'hosting', 'home');
    await answer(s, 'homeCf', 'yes');
    expect(await s.submit('cloudflared service install nope')).toBe('stayed');
    expect(s.current().error).toBe('That does not look like a Cloudflare tunnel token (it starts with eyJ).');
    await answer(s, 'tunnelToken', `  cloudflared.exe service install ${TUNNEL}\n`);
    await answer(s, 'tunnelHost', 'https://T.example.com/');
    expect(s.values()).toMatchObject({ INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL, PUBLIC_URL: 'https://t.example.com' });
  });
});

describe('navigation', () => {
  test('back keeps every answer, also on branches left behind', async () => {
    const { s } = make();
    await answer(s, 'hosting', 'home');
    await answer(s, 'homeCf', 'no');
    await answer(s, 'duckName', 'my-group');
    expect(s.back()).toBe(true);
    expect(s.current()).toMatchObject({ id: 'duckName', initial: 'my-group' });
    s.back();
    const cf = s.current();
    expect(cf.id).toBe('homeCf');
    expect(cf.options.map((o) => [o.value, o.chosen, o.subtle])).toEqual([['yes', false, false], ['no', true, false], ['advanced', false, true]]);
    await answer(s, 'homeCf', 'yes');
    expect(s.current().id).toBe('tunnelToken');
    s.back();
    await answer(s, 'homeCf', 'no');
    expect(s.current()).toMatchObject({ id: 'duckName', initial: 'my-group' });
    // Over to a VPS and back home: the home answers are still there.
    s.back();
    s.back();
    await answer(s, 'hosting', 'vps');
    expect(s.current().id).toBe('vpsAddress');
    s.back();
    await answer(s, 'hosting', 'home');
    expect(s.current().options.find((o) => o.value === 'no')!.chosen).toBe(true);
    expect(s.back()).toBe(true);
    expect(s.back()).toBe(false);
    expect(s.current().id).toBe('hosting');
  });

  test('the frontier: jumps go only to answered steps; the Review waits for everything; Install never', async () => {
    const { s } = make();
    expect(s.frontier()).toBe(0);
    expect(s.jump('discord')).toBe(false);
    expect(s.notice()).toEqual({ kind: 'locked', text: 'Answer the earlier steps first' });
    expect(s.toReview()).toBe(false);
    expect(s.jump('install')).toBe(false);
    await answer(s, 'hosting', 'home');
    await answer(s, 'homeCf', 'yes');
    expect(s.notice()).toBeNull();
    expect(s.steps().map((x) => [x.id, x.state, x.jumpable])).toEqual([
      ['where', 'done', true], ['address', 'current', true], ['discord', 'pending', false], ['ports', 'pending', false], ['review', 'pending', false], ['install', 'pending', false],
    ]);
    expect(s.jump('where')).toBe(true);
    expect(s.current().id).toBe('hosting');
    expect(s.jump('address')).toBe(true);
    expect(s.current().id).toBe('homeCf');
  });

  test('a validation error stays on the question; an empty Enter takes the default; required otherwise', async () => {
    const { s } = make();
    await answer(s, 'hosting', 'home');
    await answer(s, 'homeCf', 'no');
    expect(await s.submit('')).toBe('stayed');
    expect(s.current().error).toBe('This cannot be empty.');
    expect(await s.submit('my_group')).toBe('stayed');
    expect(s.current().error).toBe('Lowercase letters, digits and - only, e.g. my-group.');
    await answer(s, 'duckName', 'my-group');
    await answer(s, 'duckToken', DUCK);
    expect(s.current()).toMatchObject({ id: 'httpsPort', initial: '', defaultText: '8443', placeholder: '8443' });
    expect(await s.submit('443')).toBe('stayed');
    expect(s.current().error).toBe('Use a port from 1024 up: home connections usually do not let 80 or 443 in.');
    await answer(s, 'httpsPort', '9443');
    expect(s.webAddress()).toBe('https://my-group.duckdns.org:9443');
  });

  test('the language question switches everything at once; setLocale does the same', async () => {
    const { s } = make({ langFlag: false });
    expect(s.current()).toMatchObject({ id: 'lang', initial: 'en' });
    await answer(s, 'lang', 'pt-BR');
    expect(s.locale).toBe('pt-BR');
    expect(s.current()).toMatchObject({ id: 'hosting', title: 'Onde a Telinha vai rodar?', badge: 'Onde · Passo 1 de 6' });
    expect(s.values().LOCALE).toBe('pt-BR');
    s.setLocale('en');
    expect(s.current().title).toBe('Where will Telinha run?');
    expect(s.steps()[0]!.label).toBe('Where');
  });

  test('the machine arriving later moves the defaults of unanswered questions only', async () => {
    const { s } = make({ host: null });
    expect(s.current().hint).toEqual(['Looking at this machine and its network…']);
    expect(s.current().initial).toBe('home');
    s.setHost(VPS);
    expect(s.current().initial).toBe('vps');
    // Answered stays answered.
    const b = make({ host: null }).s;
    await answer(b, 'hosting', 'vps');
    await answer(b, 'vpsAddress', 'sslip');
    expect(b.current().id).toBe('nodeIp');
    b.setHost(VPS);
    // The IP is known now: the question is gone and the flow moves on.
    expect(b.current().id).toBe('discordToken');
    expect(b.values()).toMatchObject({ PUBLIC_URL: 'https://203-0-113-9.sslip.io', LIVEKIT_NODE_IP: '203.0.113.9', HOSTING: 'vps' });
  });
});

describe('lookups', () => {
  test('a rejected token stays with the error; a good one goes on', async () => {
    const { s } = make();
    await homeDuck(s);
    expect(await s.submit('Bw2xQ8rLk5vN9mZp3Tc7')).toBe('stayed'); // gitleaks:allow
    expect(s.current()).toMatchObject({ id: 'discordToken', lookup: { state: 'rejected', error: 'Discord rejected the token; copy it again and paste it here.' }, error: 'Discord rejected the token; copy it again and paste it here.' });
    await answer(s, 'discordToken', TOKEN);
    expect(s.values().DISCORD_TOKEN).toBe(TOKEN);
  });

  test('Discord down: try again or quit; the retry uses what was typed', async () => {
    const w = world({ down: true });
    const { s } = make({ world: w });
    await homeDuck(s);
    expect(await s.submit(TOKEN)).toBe('stayed');
    const v = s.current();
    expect(v.lookup).toEqual({ state: 'error', error: 'Discord could not be reached: Service Unavailable (HTTP 503)' });
    expect(v.actions).toEqual([{ id: 'retry', label: 'Try again' }, { id: 'quit', label: 'Quit setup' }]);
    w.down = false;
    await s.action('retry');
    expect(s.current().id).toBe('clientSecret');
  });

  test('a result that arrives after the user went back (or switched language) is dropped', async () => {
    const w = world();
    const { s } = make({ world: w });
    await homeDuck(s);
    let release!: () => void;
    w.gate = new Promise((r) => (release = r));
    const pending = s.submit(TOKEN);
    expect(s.current().lookup).toEqual({ state: 'running', label: 'Checking the token with Discord…' });
    s.back();
    release();
    expect(await pending).toBe('stayed');
    expect(s.current().id).toBe('httpsPort');
    expect(s.values().DISCORD_TOKEN).toBeUndefined();
    // The language: same.
    w.gate = new Promise((r) => (release = r));
    await answer(s, 'httpsPort', '');
    const again = s.submit(TOKEN);
    s.setLocale('pt-BR');
    release();
    expect(await again).toBe('stayed');
    expect(s.values().DISCORD_TOKEN).toBeUndefined();
    expect(s.current().lookup).toEqual({ state: 'idle' });
  });

  test('DuckDNS refuses: type it again, or keep it anyway (noted for the Review)', async () => {
    const { s } = make({ duckOk: false });
    await answer(s, 'hosting', 'home');
    await answer(s, 'homeCf', 'no');
    await answer(s, 'duckName', 'my-group');
    expect(await s.submit(DUCK)).toBe('stayed');
    expect(s.current().lookup).toEqual({ state: 'error', error: 'DuckDNS did not accept it: DuckDNS rejected the domain/token' });
    expect(s.current().actions).toEqual([{ id: 'retry', label: 'Type the token again' }, { id: 'keep', label: 'Keep it anyway (the running service retries)' }]);
    await s.action('retry');
    expect(s.current()).toMatchObject({ id: 'duckToken', lookup: { state: 'idle' }, actions: [] });
    expect(await s.submit(DUCK)).toBe('stayed');
    await s.action('keep');
    expect(s.current().id).toBe('httpsPort');
    expect(s.values().DUCKDNS_TOKEN).toBe(DUCK);
    expect(s.reviewNotes()).toEqual(['DuckDNS did not accept the token for my-group.duckdns.org yet; the running service keeps trying.']);
  });

  test('the redirect: asked only when missing; check again until it is there, or skip with a note', async () => {
    const w = world({ redirects: [] });
    const { s } = make({ world: w });
    await homeDuck(s);
    await answer(s, 'discordToken', TOKEN);
    await answer(s, 'clientSecret', SECRET);
    const v = s.current();
    expect(v).toMatchObject({ id: 'redirect', link: `${DUCK_URL}/auth/callback` });
    expect(s.allAnswered()).toBe(false);
    expect(await s.submit('check')).toBe('stayed');
    expect(s.current().lookup).toEqual({ state: 'warn', note: 'Not there yet (did you press Save Changes?).' });
    w.redirects = [`${DUCK_URL}/auth/callback`];
    expect(await s.submit('check')).toBe('advanced');
    expect(s.current().id).toBe('guild');
    // Skipping instead leaves a note.
    const other = make({ world: world({ redirects: [] }) }).s;
    await homeDuck(other);
    await answer(other, 'discordToken', TOKEN);
    await answer(other, 'clientSecret', SECRET);
    await answer(other, 'redirect', 'skip');
    expect(other.reviewNotes()).toEqual([`Login will fail until ${DUCK_URL}/auth/callback is a redirect of the app (telinha doctor checks it).`]);
  });

  test('intents off: noted for the Review (the install switches them on)', async () => {
    const { s } = make({ world: world({ flags: 0 }) });
    await homeDuck(s);
    await answer(s, 'discordToken', TOKEN);
    expect(s.notice()?.text).toBe(`Bot: Telinha Bot (app id ${APP})
Server Members Intent and Presence Intent are off: Telinha switches them on during the install.`);
    expect(s.reviewNotes()).toEqual(['Server Members Intent and Presence Intent are off: Telinha switches them on during the install.']);
  });

  test('a wrong client secret stays', async () => {
    const { s } = make();
    await homeDuck(s);
    await answer(s, 'discordToken', TOKEN);
    expect(await s.submit('Jx4mR8wQ2tZk6Vn9')).toBe('stayed'); // gitleaks:allow
    expect(s.current().error).toBe('Discord rejected the client secret.');
  });

  test('the server list: none yet shows the invite card; the browser opens once; check again lists it', async () => {
    const w = world({ guilds: [] });
    const { s, opened } = make({ world: w });
    await homeDuck(s);
    await answer(s, 'discordToken', TOKEN);
    await answer(s, 'clientSecret', SECRET);
    const card = s.current();
    expect(card).toMatchObject({ id: 'guild', options: [], link: inviteUrl(APP), lookup: { state: 'warn', note: 'The bot is not in any server yet.' } });
    expect(card.hint).toContain('Add the bot to your server with this link (you need Manage Server there):');
    expect(card.actions).toEqual([{ id: 'open', label: 'Open the link in the browser' }, { id: 'check', label: 'I added the bot: check again' }]);
    await s.action('open');
    await s.action('open');
    expect(opened).toEqual([inviteUrl(APP)]);
    expect(s.current().actions.map((a) => a.id)).toEqual(['check']);
    w.guilds = [{ id: GUILD, name: 'Gurizada' }];
    await s.action('check');
    expect(s.current()).toMatchObject({ link: undefined, lookup: { state: 'idle' } });
    expect(s.current().options.map((o) => [o.value, o.label, o.subtle])).toEqual([[GUILD, 'Gurizada', false], ['+invite', 'Another server (add the bot)', true]]);
    // "Another server" opens the same card without leaving the question.
    expect(await s.submit('+invite')).toBe('stayed');
    expect(s.current().link).toBe(inviteUrl(APP));
    await answer(s, 'guild', GUILD);
    expect(s.current().id).toBe('role');
    expect(s.current().options.map((o) => o.label)).toEqual(['@Membro', 'Everyone in the server (@everyone)']);
  });

  test('a --guild the bot is not in: the invite goes straight to that server', async () => {
    const { s } = make({ preset: { guild: GUILD2 } });
    await homeDuck(s);
    await answer(s, 'discordToken', TOKEN);
    await answer(s, 'clientSecret', SECRET);
    expect(s.current()).toMatchObject({ id: 'guild', link: inviteUrl(APP, GUILD2), lookup: { state: 'warn', note: `The bot is not in server ${GUILD2}.` } });
  });

  test('channels: at least one; none visible is a dead end until checked again', async () => {
    const w = world();
    const { s } = make({ world: w, preset: { channels: [CHANNEL2, '999999999999999999'] } });
    await homeDuck(s);
    await answer(s, 'discordToken', TOKEN);
    await answer(s, 'clientSecret', SECRET);
    await answer(s, 'guild', GUILD);
    await answer(s, 'role', GUILD);
    const v = s.current();
    expect(v).toMatchObject({ id: 'channels', kind: 'multi', min: 1, initial: [CHANNEL2] });
    expect(v.options.map((o) => o.label)).toEqual(['#geral', 'Salas › #telinha']);
    expect(await s.submit([])).toBe('stayed');
    expect(s.current().error).toBe('Pick at least one channel.');
    await answer(s, 'channels', [CHANNEL, CHANNEL2]);
    expect(s.values().CHANNEL_IDS).toBe(`${CHANNEL},${CHANNEL2}`);
    expect(s.values().ROLE_ID).toBe(GUILD);

    const none = world({ channels: [] });
    const t = make({ world: none }).s;
    await homeDuck(t);
    await answer(t, 'discordToken', TOKEN);
    await answer(t, 'clientSecret', SECRET);
    await answer(t, 'guild', GUILD);
    await answer(t, 'role', ROLE);
    expect(t.current()).toMatchObject({ id: 'channels', lookup: { state: 'rejected', error: 'The bot sees no text channel in Gurizada; give it access to one, then check again.' }, actions: [{ id: 'check', label: 'Check again' }] });
    none.channels = [{ id: CHANNEL, name: 'geral', type: 0, position: 0 }];
    await t.action('check');
    expect(t.current().options.map((o) => o.value)).toEqual([CHANNEL]);
  });

  test('a domain whose A record points elsewhere is noted, not blocking', async () => {
    const { s } = make({ host: VPS, dns: ['198.51.100.1'] });
    await answer(s, 'hosting', 'vps');
    await answer(s, 'vpsAddress', 'domain');
    await answer(s, 'domain', 'telinha.example.com');
    expect(s.notice()?.text).toBe('telinha.example.com points at 198.51.100.1, not at 203.0.113.9: set its A record to 203.0.113.9 (it can take a few minutes).');
    expect(s.reviewNotes()).toHaveLength(1);
    // Answering differently later takes the note away.
    s.back();
    s.back();
    await answer(s, 'vpsAddress', 'tunnel');
    expect(s.reviewNotes()).toEqual([]);
  });

  test('offline: ids typed, nothing looked up, the client id asked', async () => {
    const w = world();
    const { s } = make({ offline: true, world: w });
    await homeDuck(s);
    await answer(s, 'discordToken', TOKEN);
    await answer(s, 'clientId', APP);
    await answer(s, 'clientSecret', SECRET);
    expect(s.current()).toMatchObject({ id: 'guild', kind: 'text' });
    expect(await s.submit('12')).toBe('stayed');
    expect(s.current().error).toBe('A Discord id is 17 to 20 digits.');
    await answer(s, 'guild', GUILD);
    await answer(s, 'role', ROLE);
    await answer(s, 'channels', `${CHANNEL}, ${CHANNEL2}`);
    expect(w.calls).toEqual([]);
    expect(s.values()).toMatchObject({ DISCORD_CLIENT_ID: APP, GUILD_ID: GUILD, CHANNEL_IDS: `${CHANNEL},${CHANNEL2}` });
  });
});

describe('starts', () => {
  test('a re-run: every step answered from the file, jumpable, the Review open; nothing asked again', async () => {
    const { s } = make({ host: VPS, file: VPS_FILE, rerun: true });
    expect(s.current().id).toBe('hosting');
    expect(s.allAnswered()).toBe(true);
    expect(s.steps().every((x) => x.id === 'install' || x.jumpable)).toBe(true);
    expect(s.jump('ports')).toBe(true);
    expect(s.toReview()).toBe(true);
    expect(clean(s.values())).toEqual(clean(VPS_FILE));
    expect(s.reviewRows().filter((r) => r.kind === 'secret').map((r) => r.value)).toEqual(['kept', 'kept']);
    expect(s.applyOptions().canRotateCookie).toBe(true);
    // From the Review, back is the last question.
    s.back();
    expect(s.current().id).toBe('mediaPorts');
  });

  test('a re-run that moves home asks the new branch (not a guess from the VPS file)', async () => {
    const { s } = make({ host: VPS, file: VPS_FILE, rerun: true });
    await answer(s, 'hosting', 'home');
    expect(s.current().id).toBe('homeCf');
    expect(s.allAnswered()).toBe(false);
    expect(s.frontier()).toBe(1);
  });

  test('a re-run that picks another server asks its role and channels again', async () => {
    const w = world({ guilds: [{ id: GUILD, name: 'Gurizada' }, { id: GUILD2, name: 'Outro' }] });
    const { s } = make({ host: VPS, file: VPS_FILE, rerun: true, world: w });
    expect(s.jump('discord')).toBe(true);
    await answer(s, 'discordToken', '');
    await answer(s, 'clientSecret', '');
    expect(s.current().options.map((o) => [o.label, o.chosen])).toEqual([['Gurizada', true], ['Outro', false], ['Another server (add the bot)', false]]);
    await answer(s, 'guild', GUILD2);
    expect(s.current().id).toBe('role');
    expect(s.allAnswered()).toBe(false);
    expect(s.steps().find((x) => x.id === 'discord')!.summary).toBe('/telinha · Outro');
  });

  test('--yes: opens at the first question without a default, or at the Review', () => {
    const fresh = make({ acceptDefaults: true }).s;
    expect(fresh.current().id).toBe('duckName');
    const rerun = make({ host: VPS, file: VPS_FILE, acceptDefaults: true, rerun: true }).s;
    expect(rerun.screen()).toBe('review');
  });

  test('flags next to a terminal are defaults, counted on a re-run only; their errors are a notice shown once', async () => {
    const errors: Text[] = [{ key: 'homeNeedsAdvanced' }];
    const { s } = make({ preset: { hosting: 'home', duckName: 'flagged', httpsPort: '9443' }, presetErrors: errors });
    expect(s.notice()?.kind).toBe('presetErrors');
    expect(s.notice()?.text).toContain('at home Telinha never relies on ports 80/443');
    expect(s.current()).toMatchObject({ id: 'hosting', initial: 'home' });
    expect(s.frontier()).toBe(0);
    await answer(s, 'hosting', 'home');
    expect(s.notice()).toBeNull();
    await answer(s, 'homeCf', 'no');
    expect(s.current()).toMatchObject({ id: 'duckName', initial: '', defaultText: 'flagged' });
    await answer(s, 'duckName', '');
    await answer(s, 'duckToken', DUCK);
    expect(s.current().defaultText).toBe('9443');
    s.back();
    expect(s.notice()).toBeNull();
  });
});

describe('hidden answers and apply options', () => {
  test('custom direct ports from the file stay while the mode does, and show in the Review', async () => {
    const file = { ...VPS_FILE, HTTP_PORT: '8080', HTTPS_PORT: '8443', PUBLIC_URL: 'https://telinha.example.com:8443' };
    const { s } = make({ host: VPS, file, rerun: true });
    expect(s.values()).toMatchObject({ HTTP_PORT: '8080', HTTPS_PORT: '8443', PUBLIC_URL: 'https://telinha.example.com:8443' });
    s.toReview();
    expect(s.reviewRows().filter((r) => /port|address/i.test(r.label)).map((r) => [r.label, r.value])).toEqual([
      ['Web address', 'https://telinha.example.com:8443'], ['HTTPS port', '8443'], ['HTTP port', '8080'], ['Media ports', 'Keep TCP 7881 and UDP 7882'],
    ]);
    s.jump('address');
    await answer(s, 'vpsAddress', 'tunnel');
    await answer(s, 'tunnelToken', TUNNEL);
    await answer(s, 'tunnelHost', 't.example.com');
    expect(s.values()).toMatchObject({ INGRESS: 'tunnel', HTTP_PORT: '', HTTPS_PORT: '', PUBLIC_URL: 'https://t.example.com' });
    s.jump('address');
    await answer(s, 'vpsAddress', 'domain');
    // Back on the same mode: the ports again; a new name drops the old URL with its port.
    expect(s.values()).toMatchObject({ HTTP_PORT: '8080', HTTPS_PORT: '8443', PUBLIC_URL: 'https://telinha.example.com:8443' });
    await answer(s, 'domain', 'new.example.com');
    expect(s.values()).toMatchObject({ HTTPS_PORT: '8443', PUBLIC_URL: 'https://new.example.com' });
  });

  test('the sysctl choice for a Linux user on 80/443', async () => {
    const { s } = make({ host: VPS, isRoot: false, compiled: true, unprivilegedPortStart: 1024 });
    await answer(s, 'hosting', 'vps');
    await answer(s, 'vpsAddress', 'sslip');
    await discord(s);
    await answer(s, 'mediaPorts', 'keep');
    const v = s.current();
    expect(v.id).toBe('sysctl');
    expect(v.hint[0]).toContain('Ports 80, 443 are below 1024');
    await answer(s, 'sysctl', 'manual');
    expect(s.current().id).toBe('autoUpdate');
    await answer(s, 'autoUpdate', 'off');
    expect(s.screen()).toBe('review');
    expect(s.applyOptions()).toEqual({ sysctl: 'manual', canRotateCookie: false, tray: null });
    expect(s.values().AUTO_UPDATE).toBe('off');
    expect(s.steps().map((x) => x.summary)).toEqual(['Rented server (VPS)', 'sslip.io', '/telinha · Gurizada', 'TCP 7881, 443, 80\nUDP 7882', 'manual', '', '']);
  });

  test('Windows: the tray step after the updates, its sidebar summary and the apply option', async () => {
    const { s } = make({ host: VPS, platform: 'win32', isRoot: false, compiled: true });
    await answer(s, 'hosting', 'vps');
    await answer(s, 'vpsAddress', 'sslip');
    await discord(s);
    await answer(s, 'mediaPorts', 'keep');
    await answer(s, 'autoUpdate', 'on');
    expect(s.current()).toMatchObject({ id: 'tray', step: 'tray', initial: 'yes', badge: 'Tray icon · Step 6 of 8' });
    await answer(s, 'tray', 'yes');
    expect(s.current()).toMatchObject({ id: 'trayAutostart', initial: 'no' });
    await answer(s, 'trayAutostart', 'yes');
    expect(s.screen()).toBe('review');
    expect(s.applyOptions().tray).toEqual({ install: true, autostart: true });
    expect(s.steps().map((x) => x.summary)[5]).toBe('icon, at sign-in');
    const rows = s.reviewRows();
    const at = rows.findIndex((r) => r.step === 'Tray icon');
    expect(rows.slice(at).map((r) => [r.label, r.value])).toEqual([
      ['Tray icon', 'Yes, show the icon'], ['Start with Windows', 'Yes, at every sign-in'],
    ]);
    s.jump('tray');
    await answer(s, 'tray', 'no');
    expect(s.screen()).toBe('review');
    expect(s.applyOptions().tray).toEqual({ install: false, autostart: false });
    expect(s.steps().map((x) => x.summary)[5]).toBe('no icon');
  });

  test('Windows re-run: the tray questions start from what the PC has', () => {
    const { s } = make({ host: VPS, platform: 'win32', isRoot: false, compiled: true, file: VPS_FILE, rerun: true, tray: { installed: false, optedOut: true, autostart: false } });
    expect(s.applyOptions().tray).toEqual({ install: false, autostart: false });
  });

  test('custom media ports are checked against the HTTPS port and written', async () => {
    const { s } = make({ host: VPS });
    await answer(s, 'hosting', 'vps');
    await answer(s, 'vpsAddress', 'sslip');
    await discord(s);
    await answer(s, 'mediaPorts', 'change');
    expect(s.current()).toMatchObject({ id: 'mediaTcp', defaultText: '7881' });
    expect(await s.submit('443')).toBe('stayed');
    expect(s.current().error).toBe('That is the HTTPS port; pick another.');
    await answer(s, 'mediaTcp', '50000');
    await answer(s, 'mediaUdp', '');
    expect(s.values()).toMatchObject({ MEDIA_TCP_PORT: '50000', MEDIA_UDP_PORT: '' });
  });

  test('dispose: no more updates, running lookups dropped', async () => {
    const w = world();
    const { s } = make({ world: w });
    await homeDuck(s);
    let calls = 0;
    s.subscribe(() => calls++);
    let release!: () => void;
    w.gate = new Promise((r) => (release = r));
    const pending = s.submit(TOKEN);
    const before = calls;
    s.dispose();
    release();
    expect(await pending).toBe('stayed');
    expect(calls).toBe(before);
    expect(await s.submit('x')).toBe('stayed');
  });
});
