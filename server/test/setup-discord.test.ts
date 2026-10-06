import { describe, expect, test } from 'bun:test';
import { resolvePaths } from '../src/paths.ts';
import type { CliContext } from '../src/cli/args.ts';
import type { Choice, Spinner, Term } from '../src/cli/term.ts';
import {
  askDiscord, checkDiscord, createDiscordSetup, DiscordError, inviteUrl, INVITE_PERMISSIONS, pickableRoles, sortChannels, validCommand,
} from '../src/cli/setup/discord.ts';
import type { SetupDeps, Values, Wizard } from '../src/cli/setup/steps.ts';
import { SetupAbort } from '../src/cli/setup/steps.ts';
import { t } from '../src/cli/setup/strings.ts';

const APP = '111111111111111111';
const GUILD = '222222222222222222';
const URL_ = 'https://telinha.example.com';

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
    this.out.push(`select ${o.id}: ${items.map((i) => i.label).join(' | ')}`);
    const v = this.take<T>(`select:${o.id ?? q}`, () => items[def ?? 0]!.value);
    if (!items.some((i) => i.value === v)) throw new Error(`select ${o.id}: ${String(v)} is not offered`);
    return v;
  }
  async multiselect<T>(q: string, items: Choice<T>[], o: { min?: number; preselected?: T[]; id?: string } = {}) {
    this.out.push(`multiselect ${o.id}: ${items.map((i) => i.label).join(' | ')}`);
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

interface Fixture {
  flags?: number;
  redirects?: string[];
  guilds?: { id: string; name: string }[][];
  patch?: 'ok' | 'fail';
  calls: string[];
  patched?: number[];
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function discordFetch(f: Fixture): typeof fetch {
  let flags = f.flags ?? 0;
  const guildLists = f.guilds ?? [[{ id: GUILD, name: 'Gurizada' }]];
  let guildCall = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace('https://discord.com/api/v10', '');
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    f.calls.push(`${method} ${url}`);
    if (url === '/oauth2/token') {
      return auth === `Basic ${Buffer.from(`${APP}:good-secret`).toString('base64')}` ? json({ access_token: 'a' }) : json({ error: 'invalid_client' }, 401);
    }
    if (auth !== 'Bot tok-good') return json({ message: '401: Unauthorized', code: 0 }, 401);
    if (url === '/applications/@me' && method === 'GET') return json({ id: APP, name: 'Telinha Bot', flags, redirect_uris: f.redirects ?? [], bot_public: true });
    if (url === '/applications/@me' && method === 'PATCH') {
      if (f.patch === 'fail') return json({ message: 'Invalid Form Body', code: 50035 }, 400);
      flags = (JSON.parse(String(init!.body)) as { flags: number }).flags;
      (f.patched ??= []).push(flags);
      return json({ id: APP, flags });
    }
    if (url === '/users/@me/guilds') return json(guildLists[Math.min(guildCall++, guildLists.length - 1)]);
    if (url === `/guilds/${GUILD}/roles`) {
      return json([
        { id: GUILD, name: '@everyone', position: 0 },
        { id: '333333333333333333', name: 'Membro', position: 2 },
        { id: '333333333333333334', name: 'Telinha Bot', position: 3, managed: true },
        { id: '333333333333333335', name: 'Admin', position: 5 },
      ]);
    }
    if (url === `/guilds/${GUILD}/channels`) {
      return json([
        { id: '444444444444444440', name: 'Texto', type: 4, position: 1 },
        { id: '444444444444444441', name: 'geral', type: 0, parent_id: '444444444444444440', position: 0 },
        { id: '444444444444444442', name: 'Voz', type: 2, parent_id: '444444444444444440', position: 1 },
        { id: '444444444444444443', name: 'avisos', type: 5, parent_id: null, position: 0 },
      ]);
    }
    return json({ message: 'Unknown' }, 404);
  }) as unknown as typeof fetch;
}

function wizard(term: FakeTerm, fx: Fixture, extra: Partial<SetupDeps> = {}): Wizard {
  const env = { TELINHA_HOME: '/srv/telinha' };
  const ctx = { argv: ['setup'], env, paths: resolvePaths(env, 'linux'), envFile: '/srv/telinha/config/telinha.env', locale: 'en', tty: true, yes: false, stdout: () => {}, stderr: () => {}, compiled: false, version: '0.7.0' } satisfies CliContext;
  const opened: string[] = [];
  const deps = {
    discord: (token: string) => createDiscordSetup({ token, fetch: discordFetch(fx), version: 'test', sleep: async () => {} }),
    openUrl: async (u: string) => void opened.push(u),
    ...extra,
  } as unknown as SetupDeps;
  return {
    ctx, deps, term, locale: 'en', s: (k, p) => t('en', k, p), keepCurrent: '(keep current)', interactive: true, docker: false,
    host: { kind: 'linux-root', platform: 'linux', arch: 'x64', isRoot: true, docker: false, osName: 'Linux', publicIp: '203.0.113.9', nat: null },
  };
}

describe('client', () => {
  test('sends Bot auth and the DiscordBot user agent; maps the application', async () => {
    const seen: Headers[] = [];
    const c = createDiscordSetup({
      token: 'tok', version: '0.7.0',
      fetch: (async (_u: string, init: RequestInit) => {
        seen.push(new Headers(init.headers));
        return json({ id: APP, name: 'B', flags: 1 << 13, redirect_uris: ['x'], bot_public: false });
      }) as unknown as typeof fetch,
    });
    expect(await c.application()).toEqual({ id: APP, name: 'B', flags: 1 << 13, redirectUris: ['x'], botPublic: false });
    expect(seen[0]!.get('authorization')).toBe('Bot tok');
    expect(seen[0]!.get('user-agent')).toBe('DiscordBot (https://github.com/sombraSoft/telinha, 0.7.0)');
  });

  test('429: waits retry_after once, then returns', async () => {
    const waits: number[] = [];
    let n = 0;
    const c = createDiscordSetup({
      token: 'tok', version: 'v', sleep: async (ms) => void waits.push(ms),
      fetch: (async () => (n++ === 0 ? json({ message: 'You are being rate limited.', retry_after: 1.5 }, 429) : json([{ id: GUILD, name: 'G' }]))) as unknown as typeof fetch,
    });
    expect(await c.guilds()).toEqual([{ id: GUILD, name: 'G' }]);
    expect(waits).toEqual([1500]);
  });

  test("4xx surfaces Discord's message", async () => {
    const c = createDiscordSetup({ token: 'bad', version: 'v', fetch: discordFetch({ calls: [] }) });
    const e = await c.application().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DiscordError);
    expect((e as DiscordError).status).toBe(401);
    expect((e as DiscordError).message).toContain('401: Unauthorized');
  });

  test('enableLimitedIntents PATCHes flags | presence | members', async () => {
    const fx: Fixture = { calls: [], flags: 1 << 23 };
    const c = createDiscordSetup({ token: 'tok-good', version: 'v', fetch: discordFetch(fx) });
    expect(await c.enableLimitedIntents(1 << 23)).toBe((1 << 23) | (1 << 13) | (1 << 15));
    expect(fx.patched).toEqual([(1 << 23) | (1 << 13) | (1 << 15)]);
  });

  test('checkClientSecret: client_credentials with Basic auth', async () => {
    const c = createDiscordSetup({ token: 'tok-good', version: 'v', fetch: discordFetch({ calls: [] }) });
    expect(await c.checkClientSecret(APP, 'good-secret')).toBe(true);
    expect(await c.checkClientSecret(APP, 'nope')).toBe(false);
  });

  test('invite URL: bot + commands scope, permissions 68608, optional fixed guild', () => {
    expect(INVITE_PERMISSIONS).toBe(68608);
    expect(inviteUrl(APP)).toBe(`https://discord.com/oauth2/authorize?client_id=${APP}&scope=bot%20applications.commands&permissions=68608`);
    expect(inviteUrl(APP, GUILD)).toBe(`https://discord.com/oauth2/authorize?client_id=${APP}&scope=bot%20applications.commands&permissions=68608&guild_id=${GUILD}&disable_guild_select=true`);
  });
});

describe('helpers', () => {
  test('roles: no @everyone, no managed role, highest first', () => {
    const roles = pickableRoles([
      { id: GUILD, name: '@everyone', position: 0, managed: false },
      { id: 'a', name: 'A', position: 1, managed: false },
      { id: 'b', name: 'Bot', position: 3, managed: true },
      { id: 'c', name: 'C', position: 2, managed: false },
    ], GUILD);
    expect(roles.map((r) => r.id)).toEqual(['c', 'a']);
  });

  test('channels: text + announcement only, uncategorised first, then by category', () => {
    const sorted = sortChannels([
      { id: 'cat2', name: 'Two', type: 4, parentId: null, position: 2 },
      { id: 'cat1', name: 'One', type: 4, parentId: null, position: 1 },
      { id: 'x', name: 'x', type: 0, parentId: 'cat2', position: 0 },
      { id: 'y', name: 'y', type: 0, parentId: 'cat1', position: 1 },
      { id: 'z', name: 'z', type: 5, parentId: 'cat1', position: 0 },
      { id: 'v', name: 'voice', type: 2, parentId: 'cat1', position: 2 },
      { id: 'top', name: 'top', type: 0, parentId: null, position: 5 },
    ]);
    expect(sorted.map((c) => `${c.category ?? '-'}/${c.channel.id}`)).toEqual(['-/top', 'One/z', 'One/y', 'Two/x']);
  });

  test('command names follow the config rule', () => {
    expect(validCommand('telinha')).toBe(true);
    expect(validCommand('tela-2_x')).toBe(true);
    expect(validCommand('Telinha')).toBe(false);
    expect(validCommand('a b')).toBe(false);
    expect(validCommand('x'.repeat(33))).toBe(false);
  });
});

describe('askDiscord', () => {
  test('happy path: token -> intents switched on -> secret -> redirect -> guild/role/channels', async () => {
    const fx: Fixture = { calls: [], redirects: [`${URL_}/auth/callback`] };
    const term = new FakeTerm({
      'secret:DISCORD_TOKEN': ['tok-bad', 'tok-good'],
      'secret:DISCORD_CLIENT_SECRET': ['wrong', 'good-secret'],
      'multiselect:channels': [['444444444444444441', '444444444444444443']],
      'text:group': ['Gurizada Medonha'],
    });
    const values: Values = {};
    await askDiscord(wizard(term, fx), values, { publicUrl: URL_ });
    expect(values).toEqual({
      DISCORD_TOKEN: 'tok-good', DISCORD_CLIENT_ID: APP, DISCORD_CLIENT_SECRET: 'good-secret', GUILD_ID: GUILD,
      ROLE_ID: '333333333333333335', CHANNEL_IDS: '444444444444444441,444444444444444443', COMMAND_NAME: 'telinha', GROUP_NAME: 'Gurizada Medonha',
    });
    const out = term.text_();
    expect(out).toContain('Discord rejected the token');
    expect(out).toContain('Switched on Server Members Intent and Presence Intent');
    expect(out).toContain('Discord rejected the client secret');
    // Roles: highest first, no @everyone/managed in the list but an explicit "everyone" item.
    expect(out).toContain('select role: @Admin | @Membro | Everyone in the server (@everyone)');
    // Channels grouped: uncategorised first, then "Texto › #geral".
    expect(out).toContain('multiselect channels: #avisos | Texto › #geral');
    expect(fx.patched).toEqual([(1 << 13) | (1 << 15)]);
    expect(out).not.toContain('tok-good');
    expect(out).not.toContain('good-secret');
  });

  test('intents PATCH refused: manual toggles, re-checked, then a warning', async () => {
    const fx: Fixture = { calls: [], patch: 'fail', redirects: [`${URL_}/auth/callback`] };
    const term = new FakeTerm({
      'secret:DISCORD_TOKEN': ['tok-good'], 'secret:DISCORD_CLIENT_SECRET': ['good-secret'], 'multiselect:channels': [['444444444444444441']],
      'text:intents': ['', '', ''],
    });
    await askDiscord(wizard(term, fx), {}, { publicUrl: URL_ });
    expect(term.asked.filter((a) => a === 'text:intents')).toHaveLength(3);
    expect(term.text_()).toContain('The intents are still off');
  });

  test('redirect missing: shows it, re-reads, skip warns', async () => {
    const fx: Fixture = { calls: [] };
    const term = new FakeTerm({
      'secret:DISCORD_TOKEN': ['tok-good'], 'secret:DISCORD_CLIENT_SECRET': ['good-secret'],
      'select:redirect': ['check', 'skip'], 'multiselect:channels': [['444444444444444441']],
    });
    await askDiscord(wizard(term, fx), {}, { publicUrl: URL_ });
    const out = term.text_();
    expect(out).toContain(`    ${URL_}/auth/callback`);
    expect(out).toContain('Not there yet');
    expect(out).toContain(`Login will fail until ${URL_}/auth/callback is a redirect`);
    expect(fx.calls.filter((c) => c === 'GET /applications/@me')).toHaveLength(2);
  });

  test('bot in no server: invite URL, browser opened, re-listed', async () => {
    const fx: Fixture = { calls: [], redirects: [`${URL_}/auth/callback`], guilds: [[], [{ id: GUILD, name: 'Gurizada' }]] };
    const opened: string[] = [];
    const term = new FakeTerm({ 'secret:DISCORD_TOKEN': ['tok-good'], 'secret:DISCORD_CLIENT_SECRET': ['good-secret'], 'multiselect:channels': [['444444444444444441']], 'text:invite': [''] });
    const values: Values = {};
    await askDiscord(wizard(term, fx, { openUrl: async (u: string) => void opened.push(u) }), values, { publicUrl: URL_ });
    expect(opened).toEqual([inviteUrl(APP)]);
    expect(term.asked).toContain('text:invite');
    expect(values.GUILD_ID).toBe(GUILD);
  });

  test('a bot that never joins: the browser opens once, and the step gives up with the link after 5 rounds', async () => {
    const fx: Fixture = { calls: [], redirects: [`${URL_}/auth/callback`], guilds: [[]] };
    const opened: string[] = [];
    const term = new FakeTerm({ 'secret:DISCORD_TOKEN': ['tok-good'], 'secret:DISCORD_CLIENT_SECRET': ['good-secret'], 'text:invite': ['', '', '', '', ''] });
    const err = await askDiscord(wizard(term, fx, { openUrl: async (u: string) => void opened.push(u) }), {}, { publicUrl: URL_ }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupAbort);
    expect((err as Error).message).toBe(`The bot is still not in a server. Add it with ${inviteUrl(APP)}, then run telinha setup again.`);
    expect(opened).toHaveLength(1);
    expect(term.asked.filter((a) => a === 'confirm:open-browser')).toHaveLength(1);
    expect(term.asked.filter((a) => a === 'text:invite')).toHaveLength(5);
  });

  test('"everyone" stores the guild id as ROLE_ID; re-run keeps the current token', async () => {
    const fx: Fixture = { calls: [], flags: (1 << 13) | (1 << 15), redirects: [`${URL_}/auth/callback`] };
    const term = new FakeTerm({ 'select:role': [GUILD] });
    const values: Values = { DISCORD_TOKEN: 'tok-good', DISCORD_CLIENT_SECRET: 'good-secret', CHANNEL_IDS: '444444444444444443', GUILD_ID: GUILD };
    await askDiscord(wizard(term, fx), values, { publicUrl: URL_ });
    expect(values.ROLE_ID).toBe(GUILD);
    expect(values.CHANNEL_IDS).toBe('444444444444444443');
    expect(term.asked).toContain('select:DISCORD_TOKEN');
    expect(term.asked).not.toContain('secret:DISCORD_TOKEN');
    expect(term.text_()).toContain('Server Members Intent and Presence Intent are on.');
  });
});

describe('checkDiscord (non-interactive)', () => {
  test('fills the client id and reports what does not exist', async () => {
    const term = new FakeTerm();
    const values: Values = { DISCORD_TOKEN: 'tok-good', DISCORD_CLIENT_SECRET: 'good-secret', GUILD_ID: GUILD, ROLE_ID: '999999999999999999', CHANNEL_IDS: '444444444444444442' };
    const problems = await checkDiscord(wizard(term, { calls: [] }), values, URL_);
    expect(values.DISCORD_CLIENT_ID).toBe(APP);
    expect(problems).toEqual(['Role 999999999999999999 does not exist in the server.', 'Channel 444444444444444442 is not a text channel the bot can see.']);
    expect(term.text_()).toContain(`Login will fail until ${URL_}/auth/callback`);
  });

  test('missing guild names the invite URL; a bad token is one problem', async () => {
    const values: Values = { DISCORD_TOKEN: 'tok-good', DISCORD_CLIENT_SECRET: 'good-secret', GUILD_ID: '555555555555555555', ROLE_ID: GUILD, CHANNEL_IDS: '1' };
    const problems = await checkDiscord(wizard(new FakeTerm(), { calls: [] }), values, URL_);
    expect(problems[0]).toContain(inviteUrl(APP, '555555555555555555'));
    const bad = await checkDiscord(wizard(new FakeTerm(), { calls: [] }), { ...values, DISCORD_TOKEN: 'nope' }, URL_);
    expect(bad).toEqual(['Discord rejected the token; paste it again.']);
  });
});
