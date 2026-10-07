// /doctor and /doctor/api/*: the phone test page and its three calls. Reached
// with a one-time link from `telinha doctor`; the cookie it sets opens these
// routes and the LiveKit relay, nothing else. Anything without a valid cookie
// gets the same 404 as an unknown path.
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { cookie, parseCookies } from '../auth.ts';
import type { Config } from '../config.ts';
import { type RoomService, roomTimeouts } from '../livekit.ts';
import type { StaticFiles } from '../static.ts';
import { COOKIE_TTL_MS, DOCTOR_COOKIE, type DoctorReport, type DoctorStore } from './session.ts';

export { DOCTOR_COOKIE };

/** The largest report body accepted. */
export const MAX_REPORT_BYTES = 16 * 1024;

export type DoctorConfig = Pick<
  Config,
  | 'cookieSecret'
  | 'secureCookies'
  | 'livekitUrl'
  | 'livekitKey'
  | 'livekitSecret'
  | 'publicUrl'
  | 'mediaTcpPort'
  | 'mediaUdpPort'
  | 'media'
  | 'turn'
  | 'closeEmptySeconds'
>;

export type DoctorHandler = (req: Request, url: URL) => Promise<Response | null>;

export const doctorRoom = (id: string) => `doctor-${id}`;

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const notFound = () => new Response('Not found', { status: 404, headers: NO_STORE });
const json = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE });

/** The phone's address as the reverse proxy saw it; null when it came straight in. */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = xff || req.headers.get('cf-connecting-ip')?.trim() || '';
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : null;
}

// ---------------------------------------------------------------- report validation

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
// Plain text only, capped: the CLI prints these lines.
const text = (v: unknown, max = 300): string | undefined =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: blanking control characters is the point
  typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : undefined;
const ms = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 3_600_000 ? Math.round(v) : undefined;
const time = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
const ipOrNull = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : null);

function step(v: unknown): { ok: boolean; error?: string } | null {
  if (!isObj(v)) return null;
  const ok = bool(v.ok);
  if (ok === undefined) return null;
  const error = text(v.error);
  return error ? { ok, error } : { ok };
}

function pathStep(v: unknown): { ok: boolean; rttMs?: number; error?: string } | null {
  const s = step(v);
  if (!s || !isObj(v)) return null;
  const rttMs = ms(v.rttMs);
  return rttMs === undefined ? s : { ...s, rttMs };
}

/** The page's report, field by field; null when anything required is missing or malformed. */
export function parseReport(body: unknown): DoctorReport | null {
  if (!isObj(body)) return null;
  const { https, initial, client } = body;
  if (!isObj(https) || bool(https.ok) === undefined) return null;
  if (initial !== null && !isObj(initial)) return null;
  if (!isObj(client)) return null;
  const signaling = step(body.signaling);
  const publish = step(body.publish);
  const tcp = pathStep(body.tcp);
  const udp = pathStep(body.udp);
  const startedAt = time(body.startedAt);
  const finishedAt = time(body.finishedAt);
  if (!signaling || !publish || !tcp || !udp || startedAt === undefined || finishedAt === undefined) return null;
  // Only a page that ran the TURN step sends one; anything else there is malformed.
  const noTurn = body.turn === undefined || body.turn === null;
  const turn = noTurn ? null : pathStep(body.turn);
  if (!noTurn && !turn) return null;
  let init: DoctorReport['initial'] = null;
  if (initial) {
    const protocol =
      typeof initial.protocol === 'string' && /^[a-z]{1,8}$/.test(initial.protocol) ? initial.protocol : null;
    if (!protocol) return null;
    init = { protocol, candidateIp: ipOrNull(initial.candidateIp), rttMs: ms(initial.rttMs) ?? null };
  }
  return {
    https: { ok: https.ok as boolean, latencyMs: ms(https.latencyMs) ?? null },
    signaling,
    initial: init,
    tcp,
    udp,
    publish,
    ...(turn ? { turn } : {}),
    client: { ua: text(client.ua, 200) ?? '' },
    startedAt,
    finishedAt,
  };
}

// ---------------------------------------------------------------- routes

export function createDoctorRoutes(o: {
  store: DoctorStore;
  config: DoctorConfig;
  files: StaticFiles;
  rooms: Pick<RoomService, 'ensureRoom' | 'deleteRoom'>;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}): DoctorHandler {
  const { store, config: c, files, rooms } = o;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});

  return async (req, url) => {
    const path = url.pathname;
    if (path !== '/doctor' && !path.startsWith('/doctor/')) return null;
    const session = () => store.verifyCookie(parseCookies(req.headers.get('cookie'))[DOCTOR_COOKIE], now());

    if (path === '/doctor' && req.method === 'GET') {
      const t = url.searchParams.get('t');
      if (t !== null) {
        const claimed = store.claim(t, now());
        // A used link opened again in the browser that already has the cookie: just the page.
        if (!claimed) return session() ? redirect() : notFound();
        log('phone test opened', claimed.id.slice(0, 8));
        const value = store.cookieFor(claimed.id, now());
        return redirect(cookie(DOCTOR_COOKIE, value, { maxAge: COOKIE_TTL_MS / 1000, secure: c.secureCookies }));
      }
      if (!session()) return notFound();
      const page = files.get('/r/doctor.html');
      if (!page) {
        log('doctor page missing from WEB_DIR (doctor.html)');
        return notFound();
      }
      return new Response(page.body, {
        headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
      });
    }

    if (path === '/doctor/api/ping' && req.method === 'GET') {
      if (!session()) return notFound();
      return json(200, { ok: true, ip: clientIp(req), at: now() });
    }

    if (path === '/doctor/api/token' && req.method === 'POST') {
      const s = session();
      if (!s) return notFound();
      if (!store.takeGrant(s.id)) return json(429, { error: 'used' });
      const room = doctorRoom(s.id);
      try {
        // auto_create is off: the room exists only because we ask for it.
        await rooms.ensureRoom(room, roomTimeouts(c.closeEmptySeconds));
      } catch (e) {
        store.returnGrant(s.id);
        log('doctor ensureRoom failed', (e as Error).message);
        return json(503, { error: 'livekit' });
      }
      // A private room only this session can join; publish screen share only,
      // nothing to subscribe to, no data channel, no identity data.
      const at = new AccessToken(c.livekitKey, c.livekitSecret, { identity: room, ttl: '5m' });
      at.addGrant({
        room,
        roomJoin: true,
        canSubscribe: false,
        canPublish: true,
        canPublishData: false,
        canPublishSources: [TrackSource.SCREEN_SHARE],
      });
      return json(200, {
        url: c.livekitUrl,
        token: await at.toJwt(),
        media: c.media,
        // Cloud's media ports are Cloud's: nothing for the page to name.
        ports: c.media === 'self' ? { tcp: c.mediaTcpPort, udp: c.mediaUdpPort } : null,
        turn: c.turn ? { host: c.turn.host } : null,
      });
    }

    if (path === '/doctor/api/report' && req.method === 'POST') {
      const s = session();
      if (!s) return notFound();
      const declared = Number(req.headers.get('content-length') ?? 0);
      if (declared > MAX_REPORT_BYTES) return json(413, { error: 'too large' });
      const raw = await req.arrayBuffer();
      if (raw.byteLength > MAX_REPORT_BYTES) return json(413, { error: 'too large' });
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        return json(400, { error: 'json' });
      }
      const report = parseReport(body);
      if (!report) return json(400, { error: 'report' });
      const ip = clientIp(req);
      if (ip) report.client.ip = ip;
      if (!store.report(s.id, report, now())) return json(409, { error: 'done' });
      log(
        'doctor report',
        s.id.slice(0, 8),
        `tcp=${report.tcp.ok} udp=${report.udp.ok} signaling=${report.signaling.ok}${report.turn ? ` turn=${report.turn.ok}` : ''}`,
      );
      await rooms
        .deleteRoom(doctorRoom(s.id))
        .catch((e: unknown) => log('doctor deleteRoom failed', (e as Error).message));
      return new Response(null, { status: 204, headers: NO_STORE });
    }

    return null;
  };
}

// The token leaves the address bar (and history) right away.
function redirect(setCookie?: string): Response {
  const h = new Headers({ ...NO_STORE, Location: '/doctor' });
  if (setCookie) h.set('Set-Cookie', setCookie);
  return new Response(null, { status: 302, headers: h });
}
