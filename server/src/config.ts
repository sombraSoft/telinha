// Environment -> typed config. Pure (env passed in) so the guards are unit tested.
import { fileURLToPath } from 'node:url';

export interface DevUser { id: string; name: string }

export interface Config {
  /** Fake login for local dev/E2E; null in production. */
  dev: DevUser | null;
  devLocale?: string;
  discordToken: string;
  clientId: string;
  clientSecret: string;
  guildId: string;
  roleId: string;
  channelIds: string[];
  publicUrl: string;
  cookieSecret: string;
  host: string;
  port: number;
  sessionSeconds: number;
  roleTtlMs: number;
  livekitKey: string;
  livekitSecret: string;
  livekitUrl: string;
  /** LiveKit HTTP API (RoomService) as the server reaches it. */
  livekitApiUrl: string;
  /** Holds telinha.sqlite (the room registry). */
  dataDir: string;
  /** A room closes for good after this long with nobody in it. */
  closeEmptySeconds: number;
  pollSeconds: number;
  groupName?: string;
  webDir: string;
  /** Secure cookie flag; off only for plain-http (dev) PUBLIC_URL. */
  secureCookies: boolean;
}

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const DEV_URL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function parseListen(v: string): { host: string; port: number } {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(v) ?? /^([^:[\]]+):(\d+)$/.exec(v);
  const port = Number(m?.[2]);
  if (!m || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`bad LISTEN ${v} (want host:port or [::1]:port)`);
  }
  return { host: m[1]!, port };
}

export function loadConfig(env: Env): Config {
  const get = (k: string, d?: string) => {
    const v = env[k] === undefined || env[k] === '' ? d : env[k];
    if (v === undefined || v === '') throw new Error(`missing env ${k}`);
    return v;
  };
  const opt = (k: string) => (env[k] ? env[k] : undefined);
  const num = (k: string, d: string) => {
    const n = Number(get(k, d));
    if (!Number.isFinite(n) || n <= 0) throw new Error(`bad ${k}`);
    return n;
  };

  const publicUrl = get('PUBLIC_URL').replace(/\/$/, '');
  const { host, port } = parseListen(get('LISTEN', '127.0.0.1:8081'));

  let dev: DevUser | null = null;
  const devRaw = opt('DEV_USER');
  if (devRaw) {
    const m = /^(\d+):(.+)$/.exec(devRaw);
    if (!m) throw new Error('bad DEV_USER (want "<digits>:<name>")');
    // Fake login must never be reachable from outside this machine.
    if (!DEV_URL_RE.test(publicUrl)) throw new Error('DEV_USER requires PUBLIC_URL http://localhost[:port] or http://127.0.0.1[:port]');
    if (!LOOPBACK.has(host)) throw new Error('DEV_USER requires a loopback LISTEN host');
    dev = { id: m[1]!, name: m[2]! };
  }
  const discord = (k: string) => (dev ? (env[k] ?? '') : get(k));

  return {
    dev,
    devLocale: dev ? opt('DEV_LOCALE') : undefined,
    discordToken: discord('DISCORD_TOKEN'),
    clientId: discord('DISCORD_CLIENT_ID'),
    clientSecret: discord('DISCORD_CLIENT_SECRET'),
    guildId: discord('GUILD_ID'),
    roleId: discord('ROLE_ID'),
    // /telinha only works in these channels, e.g. a chat visitors can't see
    channelIds: discord('CHANNEL_IDS').split(',').map((c) => c.trim()).filter(Boolean),
    publicUrl,
    cookieSecret: get('COOKIE_SECRET'),
    host,
    port,
    sessionSeconds: num('SESSION_DAYS', '7') * 86400,
    roleTtlMs: num('ROLE_CACHE_SECONDS', '300') * 1000,
    livekitKey: get('LIVEKIT_API_KEY'),
    livekitSecret: get('LIVEKIT_API_SECRET'),
    livekitUrl: opt('LIVEKIT_PUBLIC_URL') ?? `${publicUrl.replace(/^http/, 'ws')}/livekit`,
    livekitApiUrl: get('LIVEKIT_API_URL', 'http://127.0.0.1:7880').replace(/\/$/, ''),
    dataDir: opt('DATA_DIR') ?? fileURLToPath(new URL('../../.cache/data/', import.meta.url)),
    closeEmptySeconds: num('CLOSE_EMPTY_SECONDS', '300'),
    pollSeconds: num('POLL_SECONDS', '5'),
    groupName: opt('GROUP_NAME'),
    webDir: opt('WEB_DIR') ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    secureCookies: !publicUrl.startsWith('http://'),
  };
}
