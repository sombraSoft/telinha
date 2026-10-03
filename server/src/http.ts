// HTTP handler: login gate for Caddy forward_auth (/auth/check), Discord OAuth,
// LiveKit tokens for open /tela rooms, the room page (/sala/) and /healthz.
// Everything external is injected so tests drive it with plain Request objects.
import { randomBytes } from 'node:crypto';
import { cookie, parseCookies, safeNext, SESSION, sign, STATE, verify, type Session } from './auth.ts';
import type { Config } from './config.ts';
import { fromAcceptLanguage, resolveLocale, type Locale } from './i18n.ts';
import { createToken, newIdentity, ROOM_RE, type RoomService } from './livekit.ts';
import * as pages from './pages.ts';
import type { IsMember } from './roles.ts';
import type { Registry } from './rooms.ts';
import type { StaticFiles } from './static.ts';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Deps {
  config: Config;
  isMember: IsMember;
  files: StaticFiles;
  registry: Registry;
  rooms: Pick<RoomService, 'ensureRoom' | 'deleteRoom'>;
  /** Display name of the group in the given locale. */
  group: (locale: Locale) => string;
  discordReady?: () => boolean;
  /** Used only for the Discord OAuth calls. */
  fetch?: Fetch;
  now?: () => number;
  random?: (n: number) => Uint8Array;
  log?: (...a: unknown[]) => void;
}

interface OAuthState { s: string; next: string; exp: number }

const DISCORD_API = 'https://discord.com/api/v10';

type HeadersInit = ConstructorParameters<typeof Headers>[0];
const withHeaders = (base: HeadersInit, extra: Record<string, string>) => {
  const h = new Headers(base);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
};
const html = (status: number, body: string, headers: HeadersInit = {}) =>
  new Response(body, {
    status, headers: withHeaders(headers, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }),
  });
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const redirect = (status: number, location: string, headers: HeadersInit = {}) =>
  new Response(null, { status, headers: withHeaders(headers, { Location: location, 'Cache-Control': 'no-store' }) });

// Dev mode answers only to loopback names: a reverse proxy forwarding a public
// host, or a DNS-rebound page, must not get the fake login.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Coarse browser family for login logs (enough to spot in-app browsers). */
export function uaFamily(ua: string | null): string {
  if (!ua) return 'none';
  if (/Discord/i.test(ua)) return 'discord-app';
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua) ? '-mobile' : '';
  const name = /Edg\//.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera' : /Firefox\//.test(ua) ? 'firefox'
    : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
  return name + mobile;
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  const { config: c, isMember, files, group, registry, rooms } = deps;
  const discordReady = deps.discordReady ?? (() => false);
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const log = deps.log ?? ((...a: unknown[]) => console.log(new Date().toISOString(), ...a));
  const redirectUri = `${c.publicUrl}/auth/callback`;
  const ck = (name: string, value: string, o: { maxAge?: number; path?: string } = {}) =>
    cookie(name, value, { ...o, secure: c.secureCookies });
  const sessionCookie = (s: Session) => ck(SESSION, sign(c.cookieSecret, s), { maxAge: c.sessionSeconds });
  const clearState = () => ck(STATE, '', { maxAge: 0, path: '/auth' });

  async function handle(req: Request, url: URL): Promise<Response> {
    const cookies = parseCookies(req.headers.get('cookie'));
    const acceptLocale = fromAcceptLanguage(req.headers.get('accept-language'));
    const session = () => verify<Session>(c.cookieSecret, cookies[SESSION], now());
    // Sessions from 0.1.1 have no locale: fall back to the browser's.
    const localeOf = (s: Session | null) => (s?.locale ? resolveLocale(s.locale) : acceptLocale);
    const path = url.pathname;

    // Container healthcheck: up as long as HTTP answers; reports the gateway state.
    if (path === '/healthz') return json(200, { ok: true, discord: discordReady(), dev: Boolean(c.dev) });

    if (path === '/auth/check') {
      const s = session();
      if (s && (await isMember(s.id))) return new Response(null, { status: 204 });
      if (s) return html(403, pages.denied(localeOf(s), s.name, group(localeOf(s))));
      // WebSocket upgrades can't follow a redirect
      if (req.headers.get('upgrade')) return new Response(null, { status: 401 });
      const next = safeNext(req.headers.get('x-forwarded-uri'));
      return redirect(302, `/auth/login?next=${encodeURIComponent(next)}`);
    }

    if (path === '/auth/login') {
      const next = safeNext(url.searchParams.get('next'));
      if (c.dev) {
        const s: Session = {
          id: c.dev.id, name: c.dev.name, avatar: null, locale: c.devLocale ?? acceptLocale,
          exp: now() + c.sessionSeconds * 1000,
        };
        log('dev login', c.dev.id);
        return redirect(302, next, { 'Set-Cookie': sessionCookie(s) });
      }
      const state = Buffer.from(random(16)).toString('base64url');
      const v = sign(c.cookieSecret, { s: state, next, exp: now() + 10 * 60_000 } satisfies OAuthState);
      const q = new URLSearchParams({
        client_id: c.clientId, response_type: 'code', redirect_uri: redirectUri, scope: 'identify', state, prompt: 'none',
      });
      return redirect(302, `https://discord.com/oauth2/authorize?${q}`, {
        'Set-Cookie': ck(STATE, v, { maxAge: 600, path: '/auth' }),
      });
    }

    if (path === '/auth/callback') {
      const st = verify<OAuthState>(c.cookieSecret, cookies[STATE], now());
      const code = url.searchParams.get('code');
      // Every failed step gets one line: a failed login must be explainable later.
      const fail = (why: string) => log('login failed', why, `ua=${uaFamily(req.headers.get('user-agent'))}`);
      const discordError = url.searchParams.get('error');
      if (discordError) {
        fail(`discord ${discordError}${url.searchParams.get('error_description') ? `: ${url.searchParams.get('error_description')!.slice(0, 120)}` : ''}`);
        return html(400, pages.expired(acceptLocale));
      }
      if (!st || !code || url.searchParams.get('state') !== st.s) {
        fail(!cookies[STATE] ? 'no state cookie (callback opened in another browser?)'
          : !st ? 'state cookie invalid or expired'
            : !code ? 'no code' : 'state mismatch');
        return html(400, pages.expired(acceptLocale));
      }
      const tok = await doFetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: redirectUri,
          client_id: c.clientId, client_secret: c.clientSecret,
        }),
      });
      if (!tok.ok) {
        const body = (await tok.text().catch(() => '')).slice(0, 200);
        fail(`token exchange ${tok.status} ${body}`);
        throw new Error(`token exchange ${tok.status}`);
      }
      const { access_token } = (await tok.json()) as { access_token: string };
      const me = await doFetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${access_token}` } });
      if (!me.ok) {
        fail(`users/@me ${me.status}`);
        throw new Error(`users/@me ${me.status}`);
      }
      const user = (await me.json()) as {
        id: string; username: string; global_name?: string | null; avatar?: string | null; locale?: string;
      };
      const name = user.global_name || user.username;
      const s: Session = {
        id: user.id, name, avatar: user.avatar ?? null, exp: now() + c.sessionSeconds * 1000,
        ...(user.locale ? { locale: user.locale } : {}),
      };
      const locale = localeOf(s);
      let ok: boolean;
      try {
        ok = await isMember(user.id);
      } catch (e) {
        fail(`role check for ${user.id}: ${(e as Error).message}`);
        throw e;
      }
      log('login', user.id, name, ok ? 'ok' : 'denied', `ua=${uaFamily(req.headers.get('user-agent'))}`);
      if (!ok) return html(403, pages.denied(locale, name, group(locale)), { 'Set-Cookie': clearState() });
      const h = new Headers();
      h.append('Set-Cookie', sessionCookie(s));
      h.append('Set-Cookie', clearState());
      return html(200, pages.welcome(locale, st.next), h);
    }

    // LiveKit token for the room page. Members only; may only publish screen
    // share; only for rooms /tela opened that have not closed yet.
    if (path === '/auth/token') {
      const s = session();
      const room = url.searchParams.get('room') ?? '';
      if (!s) return json(401, { error: 'login' });
      if (!(await isMember(s.id))) return json(403, { error: 'members' });
      if (!ROOM_RE.test(room)) return json(400, { error: 'room' });
      let rec = registry.get(room);
      // Dev/E2E have no /tela: any valid room name opens one (closed stays closed).
      if (!rec && c.dev) {
        rec = registry.create({
          room, guildId: '', channelId: '', locale: localeOf(s), openerId: s.id, openerName: s.name, what: null, createdAt: now(),
        });
        log('dev room', room);
      }
      if (!rec) return json(404, { error: 'unknown' });
      // Someone is on the way in: the lifecycle must not close it under them.
      // Before the await below, so a poll during it sees the fresh time.
      if (rec.closedAt !== null || !registry.touch(room, now())) return json(410, { error: 'closed' });
      // LiveKit drops an idle room on its own; auto_create is off, so bring it back.
      try {
        await rooms.ensureRoom(room);
      } catch (e) {
        log('ensureRoom failed', room, (e as Error).message);
        return json(503, { error: 'livekit' });
      }
      // Closed while we waited (e.g. by hand): don't leave a room nobody polls.
      if (registry.get(room)?.closedAt !== null) {
        await rooms.deleteRoom(room).catch((e: unknown) => log('deleteRoom failed', room, (e as Error).message));
        return json(410, { error: 'closed' });
      }
      const identity = newIdentity(s.id, random);
      const avatar = s.avatar ?? null;
      const locale = localeOf(s);
      const token = await createToken({
        key: c.livekitKey, secret: c.livekitSecret, room, identity, name: s.name, id: s.id, avatar,
      });
      return json(200, {
        url: c.livekitUrl, token, identity, user: { id: s.id, name: s.name, avatar, locale }, group: group(locale),
      });
    }

    if (path === '/auth/logout') {
      return html(200, pages.loggedOut(localeOf(session())), { 'Set-Cookie': ck(SESSION, '', { maxAge: 0 }) });
    }

    if (path === '/') return redirect(302, `/sala/${url.search}`);
    if (path === '/sala') return redirect(301, `/sala/${url.search}`);

    const f = files.get(path);
    if (f && (req.method === 'GET' || req.method === 'HEAD')) {
      return new Response(req.method === 'HEAD' ? null : f.body, {
        headers: { 'Content-Type': f.type, 'Cache-Control': f.cache, 'X-Content-Type-Options': 'nosniff' },
      });
    }
    return new Response('Not found', { status: 404 });
  }

  return async (req) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    if (c.dev && !LOOPBACK_HOST.test(req.headers.get('host') ?? url.host)) {
      return new Response('DEV_USER mode only answers on localhost', { status: 421 });
    }
    try {
      return await handle(req, url);
    } catch (e) {
      log('http error', url.pathname, (e as Error).message);
      return html(502, pages.failed(fromAcceptLanguage(req.headers.get('accept-language'))));
    }
  };
}
