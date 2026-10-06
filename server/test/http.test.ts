import { describe, expect, test } from 'bun:test';
import { verify, type Session } from '../src/auth.ts';
import { uaFamily, type Deps, type Fetch } from '../src/http.ts';
import type { ProxyData } from '../src/proxy.ts';
import { DEV_ENV, jwtPayload, NOW, PROD_ENV, setup } from './helpers.ts';

const setCookies = (r: Response) => r.headers.getSetCookie();
const cookieValue = (r: Response, name: string) => {
  const c = setCookies(r).find((v) => v.startsWith(`${name}=`));
  return c ? decodeURIComponent(c.slice(name.length + 1).split(';')[0]!) : undefined;
};

describe('/healthz', () => {
  test('local caller: the full body, no login needed', async () => {
    const s = setup({ openRooms: () => 3, children: () => ({ livekit: 'up', caddy: 'restarting' }) });
    const r = await s.get('/healthz');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ ok: true, discord: true, dev: false, rooms: 3, children: { livekit: 'up', caddy: 'restarting' } });
  });

  test('defaults: the registry\'s open rooms, no children', async () => {
    const s = setup();
    s.registry.close('bafo-kiru', NOW);
    expect(await (await s.get('/healthz')).json()).toEqual({ ok: true, discord: true, dev: false, rooms: 1, children: {} });
  });

  test('through a proxy: only ok, room count and children stay private', async () => {
    const s = setup({ openRooms: () => 3, children: () => ({ livekit: 'up' }) });
    for (const h of ['X-Forwarded-For', 'X-Forwarded-Host', 'Forwarded', 'Cf-Connecting-Ip']) {
      const r = await s.get('/healthz', { [h]: h === 'Forwarded' ? 'for=203.0.113.9' : '203.0.113.9' });
      expect([h, r.status, await r.json()]).toEqual([h, 200, { ok: true }]);
    }
  });
});

describe('/auth/check', () => {
  test('member -> 204', async () => {
    const s = setup();
    expect((await s.get('/auth/check', { cookie: s.sessionCookie() })).status).toBe(204);
  });

  test('not a member -> 403 localized denied page with the group name', async () => {
    const s = setup({ members: [] });
    const r = await s.get('/auth/check', { cookie: s.sessionCookie({ locale: 'pt-BR' }) });
    expect(r.status).toBe(403);
    const body = await r.text();
    expect(body).toContain('Zé, a Telinha é só pra Galera.');
    expect(body).toContain('lang="pt-BR"');
    // old session without locale -> Accept-Language
    const en = await s.get('/auth/check', { cookie: s.sessionCookie(), 'accept-language': 'en-US' });
    expect(await en.text()).toContain('Zé, Telinha is only for Crew.');
  });

  test('no session: 302 to login with safe next, 401 for upgrades', async () => {
    const s = setup();
    const r = await s.get('/auth/check', { 'x-forwarded-uri': '/r/bafo-kiru' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`/auth/login?next=${encodeURIComponent('/r/bafo-kiru')}`);
    const evil = await s.get('/auth/check', { 'x-forwarded-uri': '//evil.com' });
    expect(evil.headers.get('location')).toBe('/auth/login?next=%2F');
    const ws = await s.get('/auth/check', { upgrade: 'websocket' });
    expect(ws.status).toBe(401);
  });

  test('expired or forged session counts as none', async () => {
    const s = setup();
    const r = await s.get('/auth/check', { cookie: s.sessionCookie({ exp: NOW - 1 }) });
    expect(r.status).toBe(302);
    const forged = await s.get('/auth/check', { cookie: 'telinha=eyJ9.abc' });
    expect(forged.status).toBe(302);
  });
});

describe('Discord OAuth', () => {
  test('/auth/login sets the state cookie and redirects to Discord', async () => {
    const s = setup();
    const r = await s.get('/auth/login?next=/r/bafo-kiru%3Fx%3D1');
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(loc.searchParams.get('client_id')).toBe('cid');
    expect(loc.searchParams.get('scope')).toBe('identify');
    expect(loc.searchParams.get('prompt')).toBe('none');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://telinha.example.com/auth/callback');
    const c = setCookies(r)[0]!;
    expect(c).toStartWith('telinha_state=');
    for (const f of ['Path=/auth', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600']) expect(c).toContain(f);
    const st = verify<{ s: string; next: string; exp: number }>(s.config.cookieSecret, cookieValue(r, 'telinha_state'), NOW);
    expect(st?.s).toBe(loc.searchParams.get('state')!);
    expect(st?.next).toBe('/r/bafo-kiru?x=1');
  });

  async function loginState(s: ReturnType<typeof setup>, next = '/r/bafo-kiru') {
    const r = await s.get(`/auth/login?next=${encodeURIComponent(next)}`);
    return { state: new URL(r.headers.get('location')!).searchParams.get('state')!, cookie: `telinha_state=${encodeURIComponent(cookieValue(r, 'telinha_state')!)}` };
  }

  const discord = (user: Record<string, unknown>, calls: Array<{ url: string; init?: RequestInit }> = []): Fetch =>
    async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'AT' });
      if (url.endsWith('/users/@me')) return Response.json(user);
      return new Response(null, { status: 404 });
    };

  test('/auth/callback stores the Discord locale in the session', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const s = setup({ fetch: discord({ id: '1', username: 'ze', global_name: 'Zé', avatar: 'av', locale: 'pt-BR' }, calls) });
    const { state, cookie } = await loginState(s);
    const r = await s.get(`/auth/callback?code=C&state=${state}`, { cookie });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('location.replace("/r/bafo-kiru")');
    expect(body).toContain('Entrando…');
    const sess = verify<Session>(s.config.cookieSecret, cookieValue(r, 'telinha'), NOW);
    expect(sess).toMatchObject({ id: '1', name: 'Zé', avatar: 'av', locale: 'pt-BR', exp: NOW + 7 * 86400_000 });
    expect(setCookies(r).some((c) => c.startsWith('telinha_state=;') && c.includes('Max-Age=0'))).toBe(true);
    const body0 = calls[0]!.init!.body as URLSearchParams;
    expect(body0.get('code')).toBe('C');
    expect(body0.get('client_secret')).toBe('csecret');
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer AT');
  });

  test('callback: welcome page escapes the next target', async () => {
    const s = setup({ fetch: discord({ id: '1', username: 'ze' }) });
    const { state, cookie } = await loginState(s, '/r/?x=</script><script>alert(1)</script>');
    const body = await (await s.get(`/auth/callback?code=C&state=${state}`, { cookie })).text();
    expect(body).not.toContain('</script><script>alert');
  });

  test('callback: non-member gets 403 and no session', async () => {
    const s = setup({ members: [], fetch: discord({ id: '9', username: 'nobody', locale: 'en-US' }) });
    const { state, cookie } = await loginState(s);
    const r = await s.get(`/auth/callback?code=C&state=${state}`, { cookie });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('nobody, Telinha is only for Crew.');
    expect(cookieValue(r, 'telinha')).toBeUndefined();
  });

  test('callback: bad or missing state -> 400 expired page', async () => {
    const s = setup();
    const { cookie } = await loginState(s);
    const r = await s.get('/auth/callback?code=C&state=wrong', { cookie, 'accept-language': 'pt-BR' });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Login expirou.');
    expect((await s.get('/auth/callback?code=C&state=x')).status).toBe(400);
  });

  test('callback: every failed step is logged with its reason and browser family', async () => {
    const s = setup();
    const { state, cookie } = await loginState(s);
    const android = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36';
    await s.get(`/auth/callback?code=C&state=${state}`, { 'user-agent': android });
    await s.get('/auth/callback?code=C&state=wrong', { cookie });
    await s.get('/auth/callback?error=access_denied&error_description=The+resource+owner+denied', { cookie });
    const fails = s.logs.filter((l) => l[0] === 'login failed').map((l) => `${l[1]} | ${l[2]}`);
    expect(fails).toEqual([
      'no state cookie (callback opened in another browser?) | ua=chrome-mobile',
      'state mismatch | ua=none',
      'discord access_denied: The resource owner denied | ua=none',
    ]);
  });

  test('callback: Discord failure -> 502 localized page, path logged without query', async () => {
    const s = setup({ fetch: async () => new Response(null, { status: 500 }) });
    const { state, cookie } = await loginState(s);
    const r = await s.get(`/auth/callback?code=SECRET&state=${state}`, { cookie, 'accept-language': 'en' });
    expect(r.status).toBe(502);
    expect(await r.text()).toContain('Something went wrong');
    const line = s.logs.find((l) => l[0] === 'http error')!;
    expect(line[1]).toBe('/auth/callback');
    expect(JSON.stringify(s.logs)).not.toContain('SECRET');
  });
});

describe('/auth/token', () => {
  test('401 / 403 / 400', async () => {
    const s = setup();
    const noSession = await s.get('/auth/token?room=bafo-kiru');
    expect(noSession.status).toBe(401);
    expect(await noSession.json()).toEqual({ error: 'login' });
    const denied = await setup({ members: [] }).get('/auth/token?room=bafo-kiru', { cookie: s.sessionCookie() });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'members' });
    // Room codes only: no old base64url ids, no near-misses.
    for (const room of ['', 'abcd', 'q3Jx_9aZ-kP2w', 'a'.repeat(40), 'Bafo-kiru', 'bafo-ki', 'bafokiru', 'bafo-kiru-mole', 'ab cd', 'bafo-kiru%2F..']) {
      const r = await s.get(`/auth/token?room=${room}`, { cookie: s.sessionCookie() });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'room' });
    }
  });

  test('200: token, identity, user, group', async () => {
    const s = setup();
    const r = await s.get('/auth/token?room=lamofu-tibare', { cookie: s.sessionCookie({ locale: 'en-GB' }) });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as Record<string, any>;
    expect(body.url).toBe('wss://telinha.example.com/livekit');
    expect(body.identity).toMatch(/^1:[0-9a-f]{6}$/);
    expect(body.user).toEqual({ id: '1', name: 'Zé', avatar: 'abc', locale: 'en' });
    expect(body.group).toBe('Crew');
    const p = jwtPayload(body.token);
    expect(p.sub).toBe(body.identity);
    expect(p.name).toBe('Zé');
    expect(JSON.parse(p.metadata)).toEqual({ id: '1', avatar: 'abc' });
    expect(p.video).toMatchObject({
      room: 'lamofu-tibare', roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: true, canUpdateOwnMetadata: true,
    });
    expect(p.video.canPublishSources).toEqual(['screen_share', 'screen_share_audio']);
  });

  test('locale falls back to Accept-Language for 0.1.1 sessions', async () => {
    const s = setup();
    const r = await s.get('/auth/token?room=bafo-kiru', { cookie: s.sessionCookie({ avatar: null }), 'accept-language': 'pt-BR,en;q=0.5' });
    const body = (await r.json()) as Record<string, any>;
    expect(body.user).toEqual({ id: '1', name: 'Zé', avatar: null, locale: 'pt-BR' });
    expect(body.group).toBe('Galera');
    expect(JSON.parse(jwtPayload(body.token).metadata)).toEqual({ id: '1', avatar: null });
  });

  test('name and avatar from the member directory win over the session ones', async () => {
    const dir = [{ id: '1', name: 'Zé da Galera', avatar: 'fresh', status: 'online' as const }];
    const fresh = setup({ directory: () => dir });
    const r = await fresh.get('/auth/token?room=bafo-kiru', { cookie: fresh.sessionCookie({ avatar: null }) });
    const body = (await r.json()) as Record<string, any>;
    expect(body.user).toMatchObject({ name: 'Zé da Galera', avatar: 'fresh' });
    expect(jwtPayload(body.token).name).toBe('Zé da Galera');
    expect(JSON.parse(jwtPayload(body.token).metadata)).toEqual({ id: '1', avatar: 'fresh' });
    // Not in the directory (or the bot not ready): the session's avatar.
    const s = setup({ directory: () => [] });
    const kept = (await (await s.get('/auth/token?room=bafo-kiru', { cookie: s.sessionCookie({ avatar: 'old' }) })).json()) as Record<string, any>;
    expect(kept.user).toMatchObject({ name: 'Zé', avatar: 'old' });
  });

  test('only rooms /telinha opened: unknown 404, closed 410, nothing minted or created', async () => {
    const s = setup();
    const unknown = await s.get('/auth/token?room=tuge-dosa', { cookie: s.sessionCookie() });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown' });
    expect(s.registry.get('tuge-dosa')).toBeNull();

    s.registry.close('bafo-kiru', NOW - 1);
    const closed = await s.get('/auth/token?room=bafo-kiru', { cookie: s.sessionCookie() });
    expect(closed.status).toBe(410);
    expect(await closed.json()).toEqual({ error: 'closed' });
    expect(s.ensured).toEqual([]);
  });

  test('open room: LiveKit room ensured before the token, room kept alive', async () => {
    const s = setup();
    expect((await s.get('/auth/token?room=bafo-kiru', { cookie: s.sessionCookie() })).status).toBe(200);
    expect(s.ensured).toEqual(['bafo-kiru']);
    // a token is not a join: the card's duration ignores it
    expect(s.registry.get('bafo-kiru')).toMatchObject({ lastTokenAt: NOW, lastSeenAt: null, firstJoinAt: null, seen: [] });
  });

  test('closed while LiveKit was being asked: 410 and the room it made is deleted', async () => {
    const s = setup({ ensureRoom: async (room) => void s.registry.close(room, NOW) });
    const r = await s.get('/auth/token?room=bafo-kiru', { cookie: s.sessionCookie() });
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: 'closed' });
    expect(s.deleted).toEqual(['bafo-kiru']);
  });

  test('LiveKit down -> 503, no token', async () => {
    const s = setup({ ensureRoom: async () => { throw new Error('ECONNREFUSED'); } });
    const r = await s.get('/auth/token?room=bafo-kiru', { cookie: s.sessionCookie() });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: 'livekit' });
  });

  test('LIVEKIT_PUBLIC_URL override', async () => {
    const s = setup({ env: { ...PROD_ENV, LIVEKIT_PUBLIC_URL: 'ws://localhost:7880' } });
    const body = (await (await s.get('/auth/token?room=bafo-kiru', { cookie: s.sessionCookie() })).json()) as { url: string };
    expect(body.url).toBe('ws://localhost:7880');
  });
});

describe('/auth/members', () => {
  const list = [
    { id: '1', name: 'Zé', avatar: 'abc', status: 'online' as const },
    { id: '2', name: 'Bia', avatar: null, status: 'offline' as const },
  ];

  test('401 without a session, 403 without the role', async () => {
    const s = setup({ directory: () => list });
    const none = await s.get('/auth/members');
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'login' });
    const forged = await s.get('/auth/members', { cookie: 'telinha=eyJ9.abc' });
    expect(forged.status).toBe(401);
    const denied = await setup({ members: [], directory: () => list }).get('/auth/members', { cookie: s.sessionCookie() });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'members' });
  });

  test('200: the directory as is, never cached', async () => {
    const s = setup({ directory: () => list });
    const r = await s.get('/auth/members', { cookie: s.sessionCookie() });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual({ members: list });
  });

  test('bot not ready yet: an empty list, not an error', async () => {
    const s = setup();
    const r = await s.get('/auth/members', { cookie: s.sessionCookie() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ members: [] });
    const nul = setup({ directory: () => null });
    expect(await (await nul.get('/auth/members', { cookie: nul.sessionCookie() })).json()).toEqual({ members: [] });
  });

  test('DEV_USER: the fixed preview list, still behind the login', async () => {
    const s = setup({ env: DEV_ENV, directory: () => list });
    expect((await s.get('/auth/members')).status).toBe(401);
    expect((await s.get('/auth/members', { cookie: s.sessionCookie({ id: '2' }) })).status).toBe(403);
    const r = await s.get('/auth/members', { cookie: s.sessionCookie({ id: '1', name: 'Dev' }) });
    expect(r.status).toBe(200);
    const { members } = (await r.json()) as { members: Array<{ id: string; name: string; avatar: string | null; status: string }> };
    expect(members).toHaveLength(8);
    expect(members.find((m) => m.id === '1')).toEqual({ id: '1', name: 'Dev', avatar: null, status: 'online' });
    expect(new Set(members.map((m) => m.status))).toEqual(new Set(['online', 'idle', 'dnd', 'offline']));
    // production never serves the fake list
    const prod = setup({ directory: () => list });
    expect(await (await prod.get('/auth/members', { cookie: prod.sessionCookie() })).json()).toEqual({ members: list });
  });
});

test('/auth/logout clears the session', async () => {
  const s = setup();
  const r = await s.get('/auth/logout', { cookie: s.sessionCookie({ locale: 'pt-BR' }) });
  expect(r.status).toBe(200);
  expect(await r.text()).toContain('Saiu da Telinha.');
  expect(setCookies(r)[0]).toMatch(/^telinha=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/);
});

describe('the gate', () => {
  test('no session: 302 to the login with the path and query as next', async () => {
    const s = setup();
    for (const [p, next] of [['/r/bafo-kiru', '/r/bafo-kiru'], ['/r/bafo-kiru?x=1&y=2', '/r/bafo-kiru?x=1&y=2'], ['/r/', '/r/'], ['/', '/'], ['/nope', '/nope']]) {
      const r = await s.get(p!);
      expect([p, r.status, r.headers.get('location')]).toEqual([p, 302, `/auth/login?next=${encodeURIComponent(next!)}`]);
    }
    // expired or forged sessions count as none
    expect((await s.get('/r/bafo-kiru', { cookie: s.sessionCookie({ exp: NOW - 1 }) })).status).toBe(302);
    expect((await s.get('/r/bafo-kiru', { cookie: 'telinha=eyJ9.abc' })).status).toBe(302);
  });

  test('no session: 401 JSON for upgrades and anything under /livekit', async () => {
    const s = setup();
    for (const [p, h] of [['/livekit/rtc', {}], ['/livekit/rtc/validate?access_token=x', {}], ['/livekit', {}], ['/livekit/rtc', { upgrade: 'websocket' }], ['/r/bafo-kiru', { upgrade: 'websocket' }]] as const) {
      const r = await s.get(p, h);
      expect([p, r.status, await r.json()]).toEqual([p, 401, { error: 'login' }]);
    }
  });

  test('not a member: 403 localized denied page, also for /livekit', async () => {
    const s = setup({ members: [] });
    const r = await s.get('/r/bafo-kiru', { cookie: s.sessionCookie({ locale: 'pt-BR' }) });
    expect(r.status).toBe(403);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await r.text()).toContain('Zé, a Telinha é só pra Galera.');
    expect((await s.get('/livekit/rtc', { cookie: s.sessionCookie(), upgrade: 'websocket' })).status).toBe(403);
  });

  test('member: the room page', async () => {
    const s = setup();
    const r = await s.member('/r/bafo-kiru');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('<div id="app"></div>');
  });

  test('/auth/* and /healthz stay outside', async () => {
    const s = setup();
    expect((await s.get('/auth/login')).status).toBe(302);
    expect((await s.get('/auth/login')).headers.get('location')).toStartWith('https://discord.com/');
    expect((await s.get('/auth/token?room=bafo-kiru')).status).toBe(401);
    expect((await s.get('/auth/nope')).status).toBe(404);
    expect((await s.get('/healthz')).status).toBe(200);
  });
});

describe('/livekit/* (member)', () => {
  function fakeProxy() {
    const calls: unknown[][] = [];
    const proxy: NonNullable<Deps['proxy']> = {
      allows: (rest) => rest === '/rtc' || rest.startsWith('/rtc/'),
      fetch: async (req, rest, search) => {
        calls.push(['fetch', req.method, rest, search]);
        return new Response('from livekit', { status: 418 });
      },
      upgradeData: (rest, search) => ({ upstream: `ws://lk${rest}${search}` }),
    };
    return { proxy, calls };
  }

  test('HTTP goes to the proxy with the path after /livekit and the query', async () => {
    const { proxy, calls } = fakeProxy();
    const s = setup({ proxy });
    const r = await s.member('/livekit/rtc/validate?access_token=AT&sdk=js');
    expect(r.status).toBe(418);
    expect(await r.text()).toBe('from livekit');
    expect(calls).toEqual([['fetch', 'GET', '/rtc/validate', '?access_token=AT&sdk=js']]);
  });

  test('upgrade: handed to Bun with the proxy data, no response', async () => {
    const { proxy, calls } = fakeProxy();
    const upgrades: ProxyData[] = [];
    const s = setup({ proxy, upgrade: (_req, data) => (upgrades.push(data), true) });
    const r = await s.handler(new Request('https://telinha.example.com/livekit/rtc?access_token=AT', {
      headers: { cookie: s.sessionCookie(), upgrade: 'websocket' },
    }));
    expect(r).toBeUndefined();
    expect(upgrades).toEqual([{ upstream: 'ws://lk/rtc?access_token=AT' }]);
    expect(calls).toEqual([]);
  });

  test('upgrade refused by Bun -> 500', async () => {
    const { proxy } = fakeProxy();
    const s = setup({ proxy, upgrade: () => false });
    const r = await s.member('/livekit/rtc', { upgrade: 'websocket' });
    expect(r.status).toBe(500);
  });

  test('outside the /rtc allowlist (Twirp RoomService and co.) -> 404, nothing forwarded', async () => {
    const { proxy, calls } = fakeProxy();
    const upgrades: ProxyData[] = [];
    const s = setup({ proxy, upgrade: (_req, data) => (upgrades.push(data), true) });
    for (const p of ['/livekit/twirp/livekit.RoomService/ListRooms', '/livekit', '/livekit/', '/livekit/rtcx', '/livekit/RTC']) {
      for (const h of [{}, { upgrade: 'websocket' }] as Record<string, string>[]) {
        const r = await s.member(p, h);
        expect([p, r.status, await r.json()]).toEqual([p, 404, { error: 'not found' }]);
      }
    }
    expect(calls).toEqual([]);
    expect(upgrades).toEqual([]);
  });

  test('no proxy configured -> 404', async () => {
    expect((await setup().member('/livekit/rtc')).status).toBe(404);
  });
});

describe('redirects (members)', () => {
  test('/ -> /r/ (302), query dropped', async () => {
    const s = setup();
    for (const p of ['/', '/?room=bafo-kiru', '/?x=1']) {
      const r = await s.member(p);
      expect([p, r.status, r.headers.get('location')]).toEqual([p, 302, '/r/']);
    }
  });

  test('/r -> /r/ (301)', async () => {
    const r = await setup().member('/r');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/r/');
  });
});

test('unknown paths -> 404 (members)', async () => {
  const s = setup();
  const paths = ['/nope', '/auth', '/healthz/x', '/livekitx', '/rx', '/r/bafo-kiru/x', '/sala', '/sala/?room=bafo-kiru', '/sala/bafo-kiru'];
  for (const p of paths) expect([p, (await s.member(p)).status]).toEqual([p, 404]);
});

describe('DEV_USER mode', () => {
  test('login sets the session immediately and redirects to next', async () => {
    const s = setup({ env: DEV_ENV });
    expect(((await (await s.get('/healthz')).json()) as { dev: boolean }).dev).toBe(true);
    const r = await s.get('/auth/login?next=%2Fr%2Fbafo-kiru', { 'accept-language': 'pt-BR' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/r/bafo-kiru');
    const c = setCookies(r)[0]!;
    expect(c).not.toContain('Secure');
    expect(c).toContain('HttpOnly');
    const sess = verify<Session>(s.config.cookieSecret, cookieValue(r, 'telinha'), NOW);
    expect(sess).toMatchObject({ id: '1', name: 'Dev', avatar: null, locale: 'pt-BR' });

    const tok = await s.get('/auth/token?room=bafo-kiru', { cookie: `telinha=${encodeURIComponent(cookieValue(r, 'telinha')!)}` });
    expect(tok.status).toBe(200);
    const body = (await tok.json()) as Record<string, any>;
    expect(body.identity).toMatch(/^1:[0-9a-f]{6}$/);
    expect(body.url).toBe('ws://localhost:8081/livekit');
    expect(body.user.locale).toBe('pt-BR');
  });

  test('DEV_LOCALE wins over Accept-Language; unsafe next is dropped', async () => {
    const s = setup({ env: { ...DEV_ENV, DEV_LOCALE: 'en-US' } });
    const r = await s.get('/auth/login?next=//evil.com', { 'accept-language': 'pt-BR' });
    expect(r.headers.get('location')).toBe('/');
    expect(verify<Session>(s.config.cookieSecret, cookieValue(r, 'telinha'), NOW)?.locale).toBe('en-US');
  });

  test('non-loopback Host gets no fake login', async () => {
    const s = setup({ env: DEV_ENV });
    for (const host of ['telinha.example.com', 'evil.test:8081', 'localhost.evil.test']) {
      const r = await s.get('/auth/login', { host });
      expect(r.status).toBe(421);
      expect(setCookies(r)).toEqual([]);
    }
    for (const host of ['localhost:5173', '127.0.0.1:8081', '[::1]:8081', 'localhost']) {
      expect((await s.get('/auth/login', { host })).status).toBe(302);
    }
    // production ignores Host here (the ingress in front owns it)
    expect((await setup().get('/healthz', { host: 'telinha.example.com' })).status).toBe(200);
  });

  test('an unknown valid room code opens on first use; a closed one stays closed', async () => {
    const s = setup({ env: DEV_ENV, rooms: [] });
    const r = await s.get('/auth/token?room=debu-gamo', { cookie: s.sessionCookie({ id: '1', name: 'Dev', locale: 'pt-BR' }) });
    expect(r.status).toBe(200);
    expect(s.registry.get('debu-gamo')).toMatchObject({
      openerId: '1', openerName: 'Dev', locale: 'pt-BR', messageId: null, createdAt: NOW, closedAt: null,
    });
    expect(s.ensured).toEqual(['debu-gamo']);
    s.registry.close('debu-gamo', NOW);
    const again = await s.get('/auth/token?room=debu-gamo', { cookie: s.sessionCookie({ id: '1' }) });
    expect(again.status).toBe(410);
  });

  test('only the dev user is a member', async () => {
    const s = setup({ env: DEV_ENV });
    expect((await s.get('/auth/check', { cookie: s.sessionCookie({ id: '2' }) })).status).toBe(403);
    expect((await s.get('/auth/check', { cookie: s.sessionCookie({ id: '1' }) })).status).toBe(204);
  });
});

test('uaFamily spots in-app and mobile browsers', () => {
  expect(uaFamily(null)).toBe('none');
  expect(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('safari-mobile');
  expect(uaFamily('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/154.0 Safari/537.36 Edg/154.0')).toBe('edge');
  expect(uaFamily('Mozilla/5.0 (Linux; Android 14) Discord/250.0')).toBe('discord-app');
});
