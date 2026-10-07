import { describe, expect, test } from 'bun:test';
import { sign } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createDoctorRoutes, DOCTOR_COOKIE, MAX_REPORT_BYTES, parseReport } from '../src/doctor/routes.ts';
import { createDoctorStore, type DoctorReport } from '../src/doctor/session.ts';
import { staticFromEntries } from '../src/static.ts';
import { ENTRIES, jwtPayload, NOW, PROD_ENV } from './helpers.ts';

const REPORT: DoctorReport = {
  https: { ok: true, latencyMs: 80 },
  signaling: { ok: true },
  initial: { protocol: 'udp', candidateIp: '203.0.113.7', rttMs: 40 },
  tcp: { ok: true, rttMs: 60 },
  udp: { ok: false, error: 'timed out' },
  publish: { ok: true },
  client: { ua: 'Mozilla/5.0 (Android)' },
  startedAt: NOW,
  finishedAt: NOW + 20_000,
};

const DOCTOR_HTML = '<!doctype html><html><head><title>Telinha doctor</title></head><body></body></html>';

function setup(
  o: { pageBuilt?: boolean; ensureRoom?: (room: string) => Promise<void>; env?: Record<string, string> } = {},
) {
  const config = loadConfig({ ...PROD_ENV, ...o.env });
  const store = createDoctorStore({ cookieSecret: config.cookieSecret, now: () => NOW });
  const entries: [string, Uint8Array][] = [...ENTRIES];
  if (o.pageBuilt !== false) entries.push(['doctor.html', new TextEncoder().encode(DOCTOR_HTML)]);
  const ensured: string[] = [];
  const deleted: string[] = [];
  const logs: unknown[][] = [];
  const handle = createDoctorRoutes({
    store,
    config,
    files: staticFromEntries(entries, { command: 'telinha' }),
    rooms: {
      ensureRoom: o.ensureRoom ?? (async (r) => void ensured.push(r)),
      deleteRoom: async (r) => void deleted.push(r),
    },
    now: () => NOW,
    log: (...a) => void logs.push(a),
  });
  const call = (path: string, init: RequestInit = {}) => {
    const req = new Request(`${config.publicUrl}${path}`, init);
    return handle(req, new URL(req.url));
  };
  /** A session opened through its link: the cookie header the phone then sends. */
  const opened = async () => {
    const s = store.create(NOW);
    const r = (await call(`/doctor?t=${s.token}`))!;
    const set = r.headers.get('set-cookie')!;
    const cookie = set.split(';')[0]!;
    return { ...s, cookie, set };
  };
  return { config, store, call, opened, ensured, deleted, logs };
}

const post = (cookie: string, body?: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('doctor routes', () => {
  test('paths outside /doctor are not handled', async () => {
    const { call } = setup();
    expect(await call('/r/')).toBeNull();
    expect(await call('/doctors')).toBeNull();
    expect(await call('/livekit/rtc')).toBeNull();
  });

  test('the link: sets the cookie and drops the token from the URL', async () => {
    const { store, call } = setup();
    const s = store.create(NOW);
    const r = (await call(`/doctor?t=${s.token}`))!;
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/doctor');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const set = r.headers.get('set-cookie')!;
    expect(set).toStartWith(`${DOCTOR_COOKIE}=`);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Path=/');
    expect(set).toContain('Max-Age=900');
    expect(store.state(s.id).state).toBe('opened');
  });

  test('a bad or used link is a plain 404', async () => {
    const { store, call } = setup();
    const s = store.create(NOW);
    await call(`/doctor?t=${s.token}`);
    for (const path of [`/doctor?t=${s.token}`, '/doctor?t=nope', '/doctor?t=', '/doctor']) {
      const r = (await call(path))!;
      expect(r.status).toBe(404);
      expect(await r.text()).toBe('Not found');
      expect(r.headers.get('set-cookie')).toBeNull();
    }
  });

  test('a used link with the cookie already set just shows the page', async () => {
    const { call, opened } = setup();
    const s = await opened();
    const r = (await call(`/doctor?t=${s.token}`, { headers: { cookie: s.cookie } }))!;
    expect(r.status).toBe(302);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  test('the page needs the cookie', async () => {
    const { call, opened } = setup();
    const s = await opened();
    const r = (await call('/doctor', { headers: { cookie: s.cookie } }))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toBe(DOCTOR_HTML);
  });

  test('page not built: 404 and a log line', async () => {
    const { call, opened, logs } = setup({ pageBuilt: false });
    const s = await opened();
    expect((await call('/doctor', { headers: { cookie: s.cookie } }))!.status).toBe(404);
    expect(logs.flat().join(' ')).toContain('doctor.html');
  });

  test('cookie scope: the session cookie opens nothing here, and forged doctor cookies fail', async () => {
    const { config, call, store } = setup();
    const s = store.create(NOW);
    store.claim(s.token, NOW);
    const session = `telinha=${encodeURIComponent(sign(config.cookieSecret, { id: '1', name: 'Zé', avatar: null, exp: NOW + 60_000 }))}`;
    const forged = `${DOCTOR_COOKIE}=${encodeURIComponent(sign(config.cookieSecret, { typ: 'doctor', d: s.id, exp: NOW + 60_000 }))}`;
    for (const cookie of [session, forged, `${DOCTOR_COOKIE}=garbage`]) {
      expect((await call('/doctor', { headers: { cookie } }))!.status).toBe(404);
      expect((await call('/doctor/api/ping', { headers: { cookie } }))!.status).toBe(404);
      expect((await call('/doctor/api/token', post(cookie)))!.status).toBe(404);
      expect((await call('/doctor/api/report', post(cookie, REPORT)))!.status).toBe(404);
    }
  });

  test('ping: the phone address as the proxy saw it', async () => {
    const { call, opened } = setup();
    const s = await opened();
    const r = (await call('/doctor/api/ping', {
      headers: { cookie: s.cookie, 'x-forwarded-for': '198.51.100.9, 10.0.0.1' },
    }))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ ok: true, ip: '198.51.100.9', at: NOW });
    const direct = (await call('/doctor/api/ping', { headers: { cookie: s.cookie } }))!;
    expect(((await direct.json()) as { ip: unknown }).ip).toBeNull();
  });

  test('token: a private room, screen share publish only, no hidden grant, once per session', async () => {
    const { config, call, opened, ensured } = setup();
    const s = await opened();
    const r = (await call('/doctor/api/token', post(s.cookie)))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const body = (await r.json()) as {
      url: string;
      token: string;
      media: string;
      ports: { tcp: number; udp: number };
      turn: unknown;
    };
    expect(body.url).toBe(config.livekitUrl);
    expect(body.media).toBe('self');
    expect(body.ports).toEqual({ tcp: config.mediaTcpPort, udp: config.mediaUdpPort });
    expect(body.turn).toBeNull();
    const room = `doctor-${s.id}`;
    expect(ensured).toEqual([room]);
    const jwt = jwtPayload(body.token);
    expect(jwt.sub).toBe(room);
    expect(jwt.exp - jwt.nbf).toBe(300);
    expect(jwt.name).toBeUndefined();
    expect(jwt.metadata).toBeUndefined();
    expect(jwt.video).toEqual({
      room,
      roomJoin: true,
      canSubscribe: false,
      canPublish: true,
      canPublishData: false,
      canPublishSources: ['screen_share'],
    });
    expect(jwt.video.hidden).toBeUndefined();
    const again = (await call('/doctor/api/token', post(s.cookie)))!;
    expect(again.status).toBe(429);
  });

  test('token: LiveKit Cloud gets the Cloud URL and no ports to name', async () => {
    const { call, opened } = setup({ env: { MEDIA: 'cloud', LIVEKIT_CLOUD_URL: 'wss://proj-abc.livekit.cloud' } });
    const s = await opened();
    const body = (await (await call('/doctor/api/token', post(s.cookie)))!.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['media', 'ports', 'token', 'turn', 'url']);
    expect(body).toMatchObject({ url: 'wss://proj-abc.livekit.cloud', media: 'cloud', ports: null, turn: null });
  });

  test('token: with TURN on, the page learns the TURN host to test', async () => {
    const { call, opened } = setup({ env: { HOSTING: 'vps', TURN: 'on' } });
    const s = await opened();
    const body = (await (await call('/doctor/api/token', post(s.cookie)))!.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      media: 'self',
      ports: { tcp: 7881, udp: 7882 },
      turn: { host: 'turn.telinha.example.com' },
    });
  });

  test('token: LiveKit down is a 503 and does not use up the grant', async () => {
    let fail = true;
    const { call, opened } = setup({
      ensureRoom: async () => {
        if (fail) throw new Error('down');
      },
    });
    const s = await opened();
    expect((await call('/doctor/api/token', post(s.cookie)))!.status).toBe(503);
    fail = false;
    expect((await call('/doctor/api/token', post(s.cookie)))!.status).toBe(200);
  });

  test('report: stored with the proxy-seen ip, room deleted, 204; a second one is refused', async () => {
    const { store, call, opened, deleted } = setup();
    const s = await opened();
    const r = (await call(
      '/doctor/api/report',
      post(s.cookie, { ...REPORT, extra: 'dropped' }, { 'cf-connecting-ip': '198.51.100.20' }),
    ))!;
    expect(r.status).toBe(204);
    expect(deleted).toEqual([`doctor-${s.id}`]);
    const st = store.state(s.id);
    expect(st.state).toBe('done');
    expect(st.report).toEqual({ ...REPORT, client: { ua: REPORT.client.ua, ip: '198.51.100.20' } });
    expect((await call('/doctor/api/report', post(s.cookie, REPORT)))!.status).toBe(409);
  });

  test('report: a TURN step is stored and logged', async () => {
    const { store, call, opened, logs } = setup();
    const s = await opened();
    const turn = { ok: false, error: 'not relayed' };
    expect((await call('/doctor/api/report', post(s.cookie, { ...REPORT, turn })))!.status).toBe(204);
    expect(store.state(s.id).report?.turn).toEqual(turn);
    expect(logs.flat().join(' ')).toContain('turn=false');
  });

  test('report: size cap and validation', async () => {
    const { call, opened } = setup();
    const s = await opened();
    const big = { ...REPORT, client: { ua: 'x'.repeat(MAX_REPORT_BYTES) } };
    expect((await call('/doctor/api/report', post(s.cookie, big)))!.status).toBe(413);
    expect(
      (await call('/doctor/api/report', { method: 'POST', headers: { cookie: s.cookie }, body: '{not json' }))!.status,
    ).toBe(400);
    expect((await call('/doctor/api/report', post(s.cookie, { ...REPORT, tcp: { ok: 'yes' } })))!.status).toBe(400);
  });

  test('wrong methods are not handled', async () => {
    const { call, opened } = setup();
    const s = await opened();
    expect(await call('/doctor/api/token', { headers: { cookie: s.cookie } })).toBeNull();
    expect(await call('/doctor/api/report', { headers: { cookie: s.cookie } })).toBeNull();
    expect(await call('/doctor/api/nope', { headers: { cookie: s.cookie } })).toBeNull();
  });
});

describe('parseReport', () => {
  test('accepts a full report and keeps only known fields', () => {
    expect(parseReport({ ...REPORT, evil: 1, client: { ua: 'a', ip: '1.2.3.4', x: 1 } })).toEqual({
      ...REPORT,
      client: { ua: 'a' },
    });
  });

  test('turn: absent or null means no TURN step; a step is kept with its rtt and error', () => {
    expect(parseReport(REPORT)).not.toHaveProperty('turn');
    expect(parseReport({ ...REPORT, turn: null })).toEqual(REPORT);
    expect(parseReport({ ...REPORT, turn: { ok: true, rttMs: 91.6, x: 1 } })?.turn).toEqual({ ok: true, rttMs: 92 });
    expect(parseReport({ ...REPORT, turn: { ok: false, error: 'relayed over udp, not TLS' } })?.turn).toEqual({
      ok: false,
      error: 'relayed over udp, not TLS',
    });
  });

  test('turn: a malformed step rejects the report', () => {
    for (const turn of [{}, { ok: 'yes' }, 'ok', true, []]) expect(parseReport({ ...REPORT, turn })).toBeNull();
  });

  test('initial may be null; a bad candidate ip becomes null', () => {
    expect(parseReport({ ...REPORT, initial: null })?.initial).toBeNull();
    expect(
      parseReport({ ...REPORT, initial: { protocol: 'tcp', candidateIp: '<script>', rttMs: 'x' } })?.initial,
    ).toEqual({ protocol: 'tcp', candidateIp: null, rttMs: null });
  });

  test('control characters are stripped from text and long text is capped', () => {
    const r = parseReport({ ...REPORT, signaling: { ok: false, error: `a\u001b[31mb\n${'z'.repeat(1000)}` } })!;
    expect(r.signaling.error).toStartWith('a [31mb ');
    expect(r.signaling.error!.length).toBe(300);
  });

  test('rejects missing or malformed required fields', () => {
    for (const bad of [
      null,
      [],
      'x',
      { ...REPORT, https: undefined },
      { ...REPORT, udp: {} },
      { ...REPORT, startedAt: 'now' },
      { ...REPORT, initial: { protocol: 'UDP!' } },
      { ...REPORT, client: null },
      { ...REPORT, publish: { ok: 1 } },
    ]) {
      expect(parseReport(bad)).toBeNull();
    }
  });
});
