import { describe, expect, test } from 'bun:test';
import type { Ddns } from '../src/ddns.ts';
import { createDiscordSetup, type DiscordSetup } from '../src/cli/setup/discord.ts';
import {
  checkDns, checkPort, checkRedirect, checkSecret, checkToken, loadChannels, loadGuilds, loadRoles, Runs, updateDuckDns,
} from '../src/cli/setup/lookups.ts';

const APP = '111111111111111111';
const GUILD = '222222222222222222';
const TOKEN = 'Nq8vXr3KpW7mTz2bLc5hJd'; // gitleaks:allow
const SECRET = 'Vy4kPq9wZr2nXm7tBc3s'; // gitleaks:allow
const URI = 'https://telinha.example.com/auth/callback';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Discord's REST API as one bot sees it; `status` forces every answer (a 500, a 401). */
function client(o: { status?: number; flags?: number; redirects?: string[]; guilds?: { id: string; name: string }[]; channels?: unknown[]; secretStatus?: number } = {}): DiscordSetup {
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (o.status) return json({ message: 'nope' }, o.status);
    const url = String(input).replace('https://discord.com/api/v10', '');
    const auth = new Headers(init?.headers).get('authorization');
    if (url === '/oauth2/token') {
      if (o.secretStatus) return json({ message: 'down' }, o.secretStatus);
      return auth === `Basic ${Buffer.from(`${APP}:${SECRET}`).toString('base64')}` ? json({}) : json({ error: 'invalid_client' }, 401);
    }
    if (auth !== `Bot ${TOKEN}`) return json({ message: '401: Unauthorized' }, 401);
    if (url === '/applications/@me') return json({ id: APP, name: 'Telinha Bot', flags: o.flags ?? (1 << 13) | (1 << 15), redirect_uris: o.redirects ?? [URI] });
    if (url === '/users/@me/guilds') return json(o.guilds ?? [{ id: GUILD, name: 'Gurizada' }]);
    if (url === `/guilds/${GUILD}/roles`) return json([{ id: GUILD, name: '@everyone', position: 0 }, { id: '333333333333333333', name: 'Membro', position: 1 }]);
    if (url === `/guilds/${GUILD}/channels`) return json(o.channels ?? [{ id: '444444444444444442', name: 'geral', type: 0, position: 1, parent_id: '444444444444444440' }, { id: '444444444444444440', name: 'Texto', type: 4, position: 0 }, { id: '444444444444444441', name: 'avisos', type: 0, position: 0 }]);
    return json({ message: 'Unknown' }, 404);
  }) as unknown as typeof fetch;
  return createDiscordSetup({ token: TOKEN, fetch: fetchFn, version: 'test', sleep: async () => {} });
}

describe('Discord lookups', () => {
  test('the token: the app and its id, intents off noted; 401 rejected; anything else an error to retry', async () => {
    const ok = await checkToken(client());
    expect(ok.state).toEqual({ state: 'ok', data: ok.app, note: { key: 'discordBot', params: { name: 'Telinha Bot', id: APP } } });
    expect(ok.app?.id).toBe(APP);
    expect(ok.intentsOff).toBe(false);
    expect((await checkToken(client({ flags: 0 }))).intentsOff).toBe(true);
    expect((await checkToken(client({ status: 401 }))).state).toEqual({ state: 'rejected', error: { key: 'discordTokenRejected' } });
    const down = await checkToken(client({ status: 500 }));
    expect(down.state.state).toBe('error');
    expect(down.app).toBeUndefined();
  });

  test('the client secret: accepted, rejected, or kept when Discord cannot say', async () => {
    expect(await checkSecret(client(), APP, SECRET)).toEqual({ state: 'ok', note: { key: 'secretOk' } });
    expect(await checkSecret(client(), APP, 'Zt5wQm8rXk2pLv9n')).toEqual({ state: 'rejected', error: { key: 'secretRejected' } }); // gitleaks:allow
    const unsure = await checkSecret(client({ secretStatus: 503 }), APP, SECRET);
    expect(unsure.state).toBe('warn');
  });

  test('the redirect: read again, present or still missing', async () => {
    expect((await checkRedirect(client(), URI)).state).toEqual({ state: 'ok', note: { key: 'redirectOk' } });
    const missing = await checkRedirect(client({ redirects: [] }), URI);
    expect(missing.state).toEqual({ state: 'warn', note: { key: 'redirectMissing' } });
    expect(missing.app?.redirectUris).toEqual([]);
    expect((await checkRedirect(client({ status: 502 }), URI)).state.state).toBe('error');
  });

  test('the lists: servers (none is a warning), roles, text channels in order (none is a dead end)', async () => {
    expect((await loadGuilds(client())).guilds).toEqual([{ id: GUILD, name: 'Gurizada' }]);
    expect((await loadGuilds(client({ guilds: [] }))).state).toEqual({ state: 'warn', note: { key: 'guildNone' } });
    expect((await loadGuilds(client({ status: 500 }))).state.state).toBe('error');
    expect((await loadRoles(client(), GUILD)).roles?.map((r) => r.name)).toEqual(['@everyone', 'Membro']);
    expect((await loadRoles(client({ status: 500 }), GUILD)).state.state).toBe('error');
    const ch = await loadChannels(client(), GUILD, 'Gurizada');
    expect(ch.channels?.map((c) => `${c.category ?? ''}/${c.channel.name}`)).toEqual(['/avisos', 'Texto/geral']);
    expect((await loadChannels(client({ channels: [] }), GUILD, 'Gurizada')).state).toEqual({ state: 'rejected', error: { key: 'channelsNone', params: { guild: 'Gurizada' } } });
  });
});

describe('other lookups', () => {
  const ddns = (ok: boolean, seen: string[]) => ({
    ddns: ({ domain }: { domain: string; token: string }): Ddns => {
      let last: ReturnType<Ddns['last']> = null;
      return {
        async update(ip) {
          seen.push(`${domain} ${ip}`);
          last = ok ? { ip, at: 1, ok } : { ip, at: 1, ok, error: 'DuckDNS rejected the domain/token' };
        },
        last: () => last,
      };
    },
  });

  test('DuckDNS: the record set to the public IP (empty lets DuckDNS take the caller\'s); a refusal is an error', async () => {
    const seen: string[] = [];
    expect(await updateDuckDns(ddns(true, seen), 'my-group', 'k', '203.0.113.9')).toEqual({ state: 'ok', note: { key: 'duckOk', params: { name: 'my-group.duckdns.org', ip: '203.0.113.9' } } });
    expect(await updateDuckDns(ddns(false, seen), 'my-group', 'k', null)).toEqual({ state: 'error', error: { key: 'duckFailed', params: { error: 'DuckDNS rejected the domain/token' } } });
    expect(seen).toEqual(['my-group 203.0.113.9', 'my-group ']);
  });

  test('DNS: right, wrong, nothing yet, or no public IP to compare with; never blocking', async () => {
    const dns = (ips: string[] | Error) => ({ resolveA: async () => (ips instanceof Error ? Promise.reject(ips) : ips) });
    expect(await checkDns(dns(['203.0.113.9']), 't.example.com', '203.0.113.9')).toEqual({ state: 'ok', note: { key: 'dnsOk', params: { host: 't.example.com', ip: '203.0.113.9' } } });
    expect(await checkDns(dns(['198.51.100.1']), 't.example.com', '203.0.113.9')).toEqual({ state: 'warn', note: { key: 'dnsWrong', params: { host: 't.example.com', ip: '203.0.113.9', now: '198.51.100.1' } } });
    expect(await checkDns(dns(new Error('ENOTFOUND')), 't.example.com', '203.0.113.9')).toEqual({ state: 'warn', note: { key: 'dnsWrongNone', params: { host: 't.example.com', ip: '203.0.113.9' } } });
    expect(await checkDns(dns(['198.51.100.1']), 't.example.com', null)).toEqual({ state: 'ok', note: { key: 'dnsUnknown', params: { host: 't.example.com', now: '198.51.100.1' } } });
    expect((await checkDns(dns([]), 't.example.com', null)).state).toBe('warn');
  });

  test('media ports: busy TCP or UDP is a warning only', async () => {
    const deps = (tcpBusy: boolean, udpFree: boolean) => ({ portInUse: async () => tcpBusy, udpFree: async () => udpFree });
    expect(await checkPort(deps(true, true), 'TCP', 7881)).toEqual({ state: 'warn', note: { key: 'mediaBusy', params: { proto: 'TCP', port: 7881 } } });
    expect(await checkPort(deps(false, false), 'UDP', 7882)).toEqual({ state: 'warn', note: { key: 'mediaBusy', params: { proto: 'UDP', port: 7882 } } });
    expect(await checkPort(deps(false, true), 'TCP', 7881)).toEqual({ state: 'ok' });
    expect(await checkPort({ portInUse: () => Promise.reject(new Error('x')), udpFree: () => Promise.reject(new Error('x')) }, 'UDP', 7882)).toEqual({ state: 'ok' });
  });

  test('run ids: only the newest run counts; cancel makes every earlier one stale', () => {
    const runs = new Runs();
    const a = runs.next();
    const b = runs.next();
    expect(runs.current(a)).toBe(false);
    expect(runs.current(b)).toBe(true);
    runs.cancel();
    expect(runs.current(b)).toBe(false);
  });
});
