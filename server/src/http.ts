// HTTP handler: the login gate in front of everything but /auth/*, /healthz,
// the page's hashed assets, the doctor page (its own one-time cookie) and the
// local control endpoint (its own token); Discord OAuth, LiveKit tokens for
// open rooms, the member list (/auth/members), the signaling proxy
// (/livekit/*), the room page (/r/<code>) and /healthz.
// Everything external is injected so tests drive it with plain Request objects.
import { randomBytes } from 'node:crypto';
import { cookie, parseCookies, SESSION, type Session, STATE, safeNext, sign, verify } from './auth.ts';
import { ROOM_RE } from './codes.ts';
import type { Config } from './config.ts';
import type { Control } from './control.ts';
import { DOCTOR_COOKIE } from './doctor/session.ts';
import { fromAcceptLanguage, type Locale, resolveLocale } from './i18n.ts';
import { createToken, newIdentity } from './livekit.ts';
import { type DirMember, devMembers } from './members.ts';
import * as pages from './pages.ts';
import type { LivekitProxy, ProxyData } from './proxy.ts';
import type { IsMember } from './roles.ts';
import type { Rooms } from './rooms.ts';
import type { StaticFiles } from './static.ts';
import { version as programVersion } from './version.ts';

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Deps {
  config: Config;
  isMember: IsMember;
  files: StaticFiles;
  rooms: Pick<Rooms, 'admit' | 'openRooms'>;
  /** Display name of the group in the given locale. */
  group: (locale: Locale) => string;
  discordReady?: () => boolean;
  /** Role members with their status (members.ts); null until the bot has fetched them. */
  members?: () => DirMember[] | null;
  /** Used only for the Discord OAuth calls. */
  fetch?: Fetch;
  now?: () => number;
  random?: (n: number) => Uint8Array;
  log?: (...a: unknown[]) => void;
  /** run.ts: (req, data) => server.upgrade(req, { data }). */
  upgrade?: (req: Request, data: ProxyData) => boolean;
  /** The /livekit/* signaling proxy (proxy.ts); unset = /livekit/* is 404. */
  proxy?: Pick<LivekitProxy, 'allows' | 'fetch' | 'upgradeData'>;
  /** /healthz: open rooms; default: the Room module's. */
  openRooms?: () => number;
  /** /healthz: child process states (supervisor), e.g. { livekit: 'up' }. */
  children?: () => Record<string, string>;
  /** /healthz; default version.ts. */
  version?: string;
  /** /internal/*: the local control endpoint; unset = 404. */
  control?: Pick<Control, 'handle'> & Partial<Pick<Control, 'authorized'>>;
  /**
   * run.ts: (req, s) => server.timeout(req, s). Bun closes a request that has
   * sent nothing for 10 s; the control routes long-poll (the phone test) or
   * run for minutes (an update), so an authorized one gets no idle timeout.
   */
  timeout?: (req: Request, seconds: number) => void;
  /** /doctor and /doctor/*: the phone test (doctor/routes.ts); null = not ours, 404. */
  doctor?: (req: Request, url: URL) => Promise<Response | null>;
  /** A valid telinha_doctor cookie opens the /livekit signaling proxy (and nothing else) for the phone test. */
  doctorCookie?: (value: string | undefined, now: number) => { id: string } | null;
}

interface OAuthState {
  s: string;
  next: string;
  exp: number;
}

const DISCORD_API = 'https://discord.com/api/v10';

type HeadersInit = ConstructorParameters<typeof Headers>[0];
const withHeaders = (base: HeadersInit, extra: Record<string, string>) => {
  const h = new Headers(base);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
};
const html = (status: number, body: string, headers: HeadersInit = {}) =>
  new Response(body, {
    status,
    headers: withHeaders(headers, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }),
  });
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const redirect = (status: number, location: string, headers: HeadersInit = {}) =>
  new Response(null, { status, headers: withHeaders(headers, { Location: location, 'Cache-Control': 'no-store' }) });

// Dev mode answers only to loopback names: a reverse proxy forwarding a public
// host, or a DNS-rebound page, must not get the fake login.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
// Set by Caddy, cloudflared and any mainstream proxy: such a caller is not local
// (/healthz detail, the control endpoint).
export const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip'];
const isWebSocket = (req: Request) => req.headers.get('upgrade')?.toLowerCase() === 'websocket';

/** Coarse browser family for login logs (enough to spot in-app browsers). */
export function uaFamily(ua: string | null): string {
  if (!ua) return 'none';
  if (/Discord/i.test(ua)) return 'discord-app';
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua) ? '-mobile' : '';
  const name = /Edg\//.test(ua)
    ? 'edge'
    : /OPR\//.test(ua)
      ? 'opera'
      : /Firefox\//.test(ua)
        ? 'firefox'
        : /Chrome\//.test(ua)
          ? 'chrome'
          : /Safari\//.test(ua)
            ? 'safari'
            : 'other';
  return name + mobile;
}

/** Resolves to undefined after a successful WebSocket upgrade (Bun owns the socket then). */
export function createHandler(deps: Deps): (req: Request) => Promise<Response | undefined> {
  const { config: c, isMember, files, group, rooms, proxy } = deps;
  const discordReady = deps.discordReady ?? (() => false);
  const members = deps.members ?? (() => null);
  const openRooms = deps.openRooms ?? (() => rooms.openRooms().length);
  const children = deps.children ?? (() => ({}));
  const version = deps.version ?? programVersion();
  const doFetch: Fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const log = deps.log ?? ((...a: unknown[]) => console.log(new Date().toISOString(), ...a));
  const redirectUri = `${c.publicUrl}/auth/callback`;
  const ck = (name: string, value: string, o: { maxAge?: number; path?: string } = {}) =>
    cookie(name, value, { ...o, secure: c.secureCookies });
  const sessionCookie = (s: Session) => ck(SESSION, sign(c.cookieSecret, s), { maxAge: c.sessionSeconds });
  const clearState = () => ck(STATE, '', { maxAge: 0, path: '/auth' });

  async function handle(req: Request, url: URL): Promise<Response | undefined> {
    const cookies = parseCookies(req.headers.get('cookie'));
    const acceptLocale = fromAcceptLanguage(req.headers.get('accept-language'));
    const session = () => verify<Session>(c.cookieSecret, cookies[SESSION], now());
    // Sessions from 0.1.1 have no locale: fall back to the browser's.
    const localeOf = (s: Session | null) => (s?.locale ? resolveLocale(s.locale) : acceptLocale);
    const path = url.pathname;

    // Container healthcheck: up while HTTP answers and no child is "restarting"
    // (compose.yml greps the body). The detail (open rooms, children) only for
    // local callers: the healthcheck, updater and smoke test
    // hit LISTEN directly, without a proxy's forwarding headers.
    if (path === '/healthz') {
      if (FORWARDED.some((h) => req.headers.has(h))) return json(200, { ok: true });
      return json(200, {
        ok: true,
        version,
        discord: discordReady(),
        dev: Boolean(c.dev),
        rooms: openRooms(),
        children: children(),
      });
    }

    if (path === '/internal' || path.startsWith('/internal/')) {
      if (!deps.control) return new Response('Not found', { status: 404 });
      if (deps.control.authorized?.(req)) deps.timeout?.(req, 0);
      return deps.control.handle(req, url);
    }

    // Content-hashed and public anyway (they ship in the image and the binary);
    // the doctor page loads them before any login.
    if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/r/assets/')) {
      return serveFile(req, path) ?? new Response('Not found', { status: 404 });
    }

    if (path === '/doctor' || path.startsWith('/doctor/')) {
      return (await deps.doctor?.(req, url)) ?? new Response('Not found', { status: 404 });
    }

    // Telinha gates by itself now; kept (cheap) for an external proxy's forward_auth.
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
          id: c.dev.id,
          name: c.dev.name,
          avatar: null,
          locale: c.devLocale ?? acceptLocale,
          exp: now() + c.sessionSeconds * 1000,
        };
        log('dev login', c.dev.id);
        return redirect(302, next, { 'Set-Cookie': sessionCookie(s) });
      }
      const state = Buffer.from(random(16)).toString('base64url');
      const v = sign(c.cookieSecret, { s: state, next, exp: now() + 10 * 60_000 } satisfies OAuthState);
      const q = new URLSearchParams({
        client_id: c.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: 'identify',
        state,
        prompt: 'none',
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
        fail(
          `discord ${discordError}${url.searchParams.get('error_description') ? `: ${url.searchParams.get('error_description')!.slice(0, 120)}` : ''}`,
        );
        return html(400, pages.expired(acceptLocale));
      }
      if (!st || !code || url.searchParams.get('state') !== st.s) {
        fail(
          !cookies[STATE]
            ? 'no state cookie (callback opened in another browser?)'
            : !st
              ? 'state cookie invalid or expired'
              : !code
                ? 'no code'
                : 'state mismatch',
        );
        return html(400, pages.expired(acceptLocale));
      }
      const tok = await doFetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: c.clientId,
          client_secret: c.clientSecret,
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
        id: string;
        username: string;
        global_name?: string | null;
        avatar?: string | null;
        locale?: string;
      };
      const name = user.global_name || user.username;
      const s: Session = {
        id: user.id,
        name,
        avatar: user.avatar ?? null,
        exp: now() + c.sessionSeconds * 1000,
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
    // share; only for rooms the slash command opened that have not closed yet.
    if (path === '/auth/token') {
      const s = session();
      const room = url.searchParams.get('room') ?? '';
      if (!s) return json(401, { error: 'login' });
      if (!(await isMember(s.id))) return json(403, { error: 'members' });
      if (!ROOM_RE.test(room)) return json(400, { error: 'room' });
      const locale = localeOf(s);
      // In dev, an unknown code opens a room under this session's name and locale.
      const admitted = await rooms.admit(room, { id: s.id, name: s.name, locale });
      if (admitted === 'unknown') return json(404, { error: 'unknown' });
      if (admitted === 'closed') return json(410, { error: 'closed' });
      if (admitted === 'media-down') return json(503, { error: 'livekit' });
      const identity = newIdentity(s.id, random);
      // The bot's directory is live and has the server nick; the session only has
      // the name and avatar from login (no avatar at all for sessions older than
      // the avatar field).
      const me = members()?.find((m) => m.id === s.id);
      const name = me?.name ?? s.name;
      const avatar = me?.avatar ?? s.avatar ?? null;
      const token = await createToken({
        key: c.livekitKey,
        secret: c.livekitSecret,
        room,
        identity,
        name,
        id: s.id,
        avatar,
      });
      return json(200, {
        url: c.livekitUrl,
        token,
        identity,
        user: { id: s.id, name, avatar, locale },
        group: group(locale),
      });
    }

    // Who else has the role, for the page's Online / Offline lists. /auth/* is
    // outside the gate, so the session and role are checked here, as for the token.
    if (path === '/auth/members') {
      const s = session();
      if (!s) return json(401, { error: 'login' });
      if (!(await isMember(s.id))) return json(403, { error: 'members' });
      // Dev has no bot: a fixed list to preview the page with.
      return json(200, { members: c.dev ? devMembers(c.dev) : (members() ?? []) });
    }

    if (path === '/auth/logout') {
      return html(200, pages.loggedOut(localeOf(session())), { 'Set-Cookie': ck(SESSION, '', { maxAge: 0 }) });
    }

    if (path.startsWith('/auth/')) return new Response('Not found', { status: 404 });

    // The gate: everything below is for members only (the phone test may use the signaling proxy).
    const livekit = path === '/livekit' || path.startsWith('/livekit/');
    const doctor = livekit && Boolean(deps.doctorCookie?.(cookies[DOCTOR_COOKIE], now()));
    const s = doctor ? null : session();
    if (!doctor && !s) {
      // The LiveKit client and WebSocket upgrades can't follow a redirect to the login.
      if (livekit || req.headers.get('upgrade')) return json(401, { error: 'login' });
      return redirect(302, `/auth/login?next=${encodeURIComponent(safeNext(path + url.search))}`);
    }
    if (s && !(await isMember(s.id))) return html(403, pages.denied(localeOf(s), s.name, group(localeOf(s))));

    if (livekit) {
      // /livekit/rtc -> /rtc, /livekit -> / (as Caddy's handle_path did).
      const rest = path.slice('/livekit'.length) || '/';
      if (!proxy?.allows(rest)) return json(404, { error: 'not found' });
      if (!isWebSocket(req)) return proxy.fetch(req, rest, url.search);
      // Upgraded: the socket is Bun's now and the response must be undefined.
      if (deps.upgrade?.(req, proxy.upgradeData(rest, url.search))) return undefined;
      return json(500, { error: 'upgrade' });
    }

    if (path === '/') return redirect(302, '/r/');
    if (path === '/r') return redirect(301, '/r/');

    if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/r/')) {
      // An exact file wins over a room code. Codes have no dots and Vite's top-level
      // files do, so only an extensionless file named like a code could shadow a room.
      const code = path.slice('/r/'.length);
      const served = serveFile(req, files.get(path) ? path : ROOM_RE.test(code) ? '/r/' : path);
      if (served) return served;
    }
    return new Response('Not found', { status: 404 });
  }

  function serveFile(req: Request, path: string): Response | null {
    const f = files.get(path);
    if (!f) return null;
    return new Response(req.method === 'HEAD' ? null : f.body, {
      headers: { 'Content-Type': f.type, 'Cache-Control': f.cache, 'X-Content-Type-Options': 'nosniff' },
    });
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
