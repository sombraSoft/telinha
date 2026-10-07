// Environment -> typed config. Pure (env passed in) so the guards are unit tested.
import { fileURLToPath } from 'node:url';
import { embeddedWebDir } from './embedded.ts';
import { resolveLocale, type Locale } from './i18n.ts';
import type { Mapping } from './nat/index.ts';
import { resolvePaths, type Paths } from './paths.ts';

export interface DevUser { id: string; name: string }
export type Ingress = 'direct' | 'tunnel' | 'external';
export type Media = 'self' | 'cloud';
export interface DuckDnsConfig { provider: 'duckdns'; /** Bare subdomain, without .duckdns.org. */ domain: string; token: string }
export type Hosting = 'home' | 'vps';
export type TurnSetting = 'auto' | 'on' | 'off';
export interface TurnConfig {
  /** turn.<publicHost>: the SNI Caddy matches and the TURN domain LiveKit advertises (always on 443). */
  host: string;
  /** Loopback TCP port LiveKit's TURN listens on (external_tls); Caddy forwards the decrypted stream here. */
  port: number;
}

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
  /** cloud: the remote LiveKit's host (wss URL without scheme), e.g. myproject-abc123.livekit.cloud; undefined for self. */
  livekitCloudHost?: string;
  /** Holds telinha.sqlite (the room registry); equals paths.data. */
  dataDir: string;
  /** A room closes for good after this long with nobody in it. */
  closeEmptySeconds: number;
  pollSeconds: number;
  groupName?: string;
  webDir: string;
  /** Secure cookie flag; off only for plain-http (dev) PUBLIC_URL. */
  secureCookies: boolean;
  /** Slash command name, configurable so two deployments can share a guild. */
  commandName: string;
  ingress: Ingress;
  /** Where telinha runs, as answered in setup; the wizard and the doctor read it, run does not. */
  hosting: Hosting | null;
  /** Bare hostname of PUBLIC_URL (Caddy site address; https_port picks the bind port). */
  publicHost: string;
  /** Non-fatal validation findings; run.ts logs them. */
  warnings: string[];
  /** direct: Caddy's HTTP->HTTPS redirect port, 0 = no redirect listener. */
  httpPort: number;
  /** direct: the port Caddy binds for TLS. */
  httpsPort: number;
  acmeEmail?: string;
  /** direct: DNS-01 instead of the HTTP/TLS-ALPN challenges; null = none. The token reaches Caddy only through its env. */
  acmeDns: { provider: 'duckdns'; token: string } | null;
  tunnelToken?: string;
  media: Media;
  livekitPort: number;
  mediaTcpPort: number;
  mediaUdpPort: number;
  /** Static public IP: skips STUN and the IP watch. */
  livekitNodeIp?: string;
  /** 0 = off; forced 0 when livekitNodeIp is set. */
  ipWatchSeconds: number;
  turnSetting: TurnSetting;
  /** Parsed even with TURN off, so a bad value fails before anyone turns TURN on. */
  turnPort: number;
  /** Non-null = TURN over TLS on 443 is on (see turnIneligibility). */
  turn: TurnConfig | null;
  /** Ask the router (UPnP IGD / NAT-PMP / PCP) to forward the media ports (and a direct-mode high HTTPS port). */
  upnp: boolean;
  ddns: DuckDnsConfig | null;
  /** Native binary only: install new releases by itself. Always false from source/Docker. */
  autoUpdate: boolean;
  /** Install exactly this tag (prereleases allowed) and stay on it. */
  updatePin?: string;
  updateCheckHours: number;
  updateMaxDeferHours: number;
  /** CLI and wizard language; the pages follow the browser. */
  locale?: Locale;
  paths: Paths;
}

/** Every key telinha.env may hold (no "unknown key" warning). */
export const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'GUILD_ID', 'ROLE_ID', 'CHANNEL_IDS',
  'COMMAND_NAME', 'GROUP_NAME', 'COOKIE_SECRET', 'SESSION_DAYS', 'ROLE_CACHE_SECONDS',
  'PUBLIC_URL', 'HOSTING', 'INGRESS', 'LISTEN', 'HTTP_PORT', 'HTTPS_PORT', 'ACME_EMAIL', 'ACME_DNS', 'TUNNEL_TOKEN',
  'MEDIA', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_CLOUD_URL',
  'LIVEKIT_PORT', 'MEDIA_TCP_PORT', 'MEDIA_UDP_PORT', 'LIVEKIT_NODE_IP', 'LIVEKIT_API_URL', 'LIVEKIT_PUBLIC_URL',
  'IP_WATCH_SECONDS', 'TURN', 'TURN_PORT',
  'CLOSE_EMPTY_SECONDS', 'POLL_SECONDS',
  'TELINHA_HOME', 'TELINHA_ENV', 'DATA_DIR', 'BIN_DIR', 'WEB_DIR',
  'DEV_USER', 'DEV_LOCALE',
  'UPNP', 'DDNS_PROVIDER', 'DUCKDNS_DOMAIN', 'DUCKDNS_TOKEN',
  'AUTO_UPDATE', 'UPDATE_PIN', 'UPDATE_CHECK_HOURS', 'UPDATE_MAX_DEFER_HOURS', 'LOCALE',
]);

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const DEV_URL_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const INGRESSES: readonly Ingress[] = ['direct', 'tunnel', 'external'];
const MEDIAS: readonly Media[] = ['self', 'cloud'];
const HOSTINGS: readonly Hosting[] = ['home', 'vps'];
// Discord's chat-input name rule (lowercase is checked separately, it is locale-aware).
export const COMMAND_RE = /^[-_\p{L}\p{N}]{1,32}$/u;
// The duckdns.org subdomain alone.
const DUCKDNS_RE = /^[a-z0-9-]{1,63}$/;
// A release tag, prereleases included (a pin may name one).
const TAG_RE = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// en, pt-BR, also pt / pt_BR / en-US as people write them (same rule as --lang).
const LOCALE_RE = /^(en|pt)([-_][A-Za-z]+)?$/i;
// Dotted-quad IPv4 (LiveKit advertises IPv4 only; ipwatch reuses this).
export const IPV4_RE = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
// LiveKit refuses a TURN domain that does not match this (its IsValidDomain).
const TURN_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+\.?$/i;
// turn.<name> resolves by construction under these, so TURN=auto needs no DNS record there.
const TURN_AUTO_SUFFIXES = ['.duckdns.org', '.sslip.io'];
/** TURN=auto turns TURN on for this host (on a VPS where TURN can run at all). */
export const turnAutoHost = (publicHost: string): boolean => TURN_AUTO_SUFFIXES.some((s) => publicHost.endsWith(s));

export function parseListen(v: string): { host: string; port: number } {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(v) ?? /^([^:[\]]+):(\d+)$/.exec(v);
  const port = Number(m?.[2]);
  if (!m || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`bad LISTEN ${v} (want host:port or [::1]:port)`);
  }
  return { host: m[1]!, port };
}

/** Why TURN over TLS on 443 cannot run with this config, or null when it can. */
export function turnIneligibility(c: Pick<Config, 'media' | 'ingress' | 'hosting' | 'httpsPort' | 'publicUrl' | 'publicHost'>): string | null {
  if (c.media === 'cloud') return "MEDIA=cloud brings LiveKit Cloud's own TURN";
  if (c.ingress !== 'direct') return 'it needs INGRESS=direct (Caddy must own port 443)';
  if (c.hosting === 'home') return 'home installs get no TURN: home connections do not let port 443 in';
  const u = new URL(c.publicUrl);
  // LiveKit always advertises turns:<domain>:443, so the public port must be 443 too.
  if (c.httpsPort !== 443 || Number(u.port || (u.protocol === 'http:' ? 80 : 443)) !== 443) {
    return 'it needs HTTPS on port 443 (HTTPS_PORT=443 and a PUBLIC_URL without a port)';
  }
  if (IPV4_RE.test(c.publicHost) || c.publicHost === 'localhost' || !TURN_DOMAIN_RE.test(c.publicHost)) {
    return 'it needs a DNS name in PUBLIC_URL (turn.<host> must resolve)';
  }
  return null;
}

/** compiled: the native binary (version.ts isCompiled()); decides AUTO_UPDATE's default and the embedded page. */
export function loadConfig(env: Env, o: { compiled?: boolean } = {}): Config {
  const compiled = o.compiled ?? false;
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
  const int = (k: string, d: string, min: number, max: number) => {
    const n = Number(get(k, d));
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`bad ${k}`);
    return n;
  };
  const oneOf = <T extends string>(k: string, d: T, allowed: readonly T[]) => {
    const v = get(k, d) as T;
    if (!allowed.includes(v)) throw new Error(`bad ${k} ${v} (want ${allowed.join(' | ')})`);
    return v;
  };

  const publicUrl = get('PUBLIC_URL').replace(/\/$/, '');
  const { host, port } = parseListen(get('LISTEN', '127.0.0.1:8081'));
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error(`bad PUBLIC_URL ${publicUrl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`bad PUBLIC_URL ${publicUrl}`);

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

  // Dev has no Caddy and no tunnel: the stack (or Vite) talks to LISTEN directly.
  const ingress = oneOf<Ingress>('INGRESS', dev ? 'external' : 'direct', INGRESSES);
  if (dev && ingress !== 'external') throw new Error('DEV_USER requires INGRESS=external');
  const hostingRaw = opt('HOSTING');
  if (hostingRaw && !HOSTINGS.includes(hostingRaw as Hosting)) throw new Error(`bad HOSTING ${hostingRaw} (want ${HOSTINGS.join(' | ')})`);
  const hosting = (hostingRaw as Hosting | undefined) ?? null;
  const media = oneOf<Media>('MEDIA', 'self', MEDIAS);

  const warnings: string[] = [];
  const httpPort = int('HTTP_PORT', '80', 0, 65535);
  const httpsPort = int('HTTPS_PORT', '443', 1, 65535);
  if ((ingress === 'direct' || ingress === 'tunnel') && url.protocol !== 'https:') {
    throw new Error(`INGRESS=${ingress} requires an https:// PUBLIC_URL`);
  }
  // Dev never runs Caddy, so the key is not even parsed there.
  let acmeDns: Config['acmeDns'] = null;
  if (!dev && oneOf('ACME_DNS', 'none', ['none', 'duckdns'] as const) === 'duckdns') {
    if (ingress !== 'direct') {
      warnings.push('config: ACME_DNS only applies to INGRESS=direct; ignored');
    } else {
      const token = get('DUCKDNS_TOKEN');
      // The DuckDNS API can only set TXT records under its own names.
      if (!url.hostname.endsWith('.duckdns.org')) {
        throw new Error(`ACME_DNS=duckdns needs a PUBLIC_URL host under duckdns.org (got ${url.hostname})`);
      }
      acmeDns = { provider: 'duckdns', token };
    }
  }
  if (ingress === 'direct') {
    const urlPort = Number(url.port || 443);
    // Let's Encrypt's HTTP and TLS-ALPN challenges only ever dial public 80 and 443.
    if (!acmeDns && urlPort !== 443) {
      if (httpPort === 0) {
        throw new Error(`PUBLIC_URL uses port ${urlPort} and HTTP_PORT=0: Let's Encrypt validates only over public port 80 or 443, so this needs ACME_DNS=duckdns (a DuckDNS name) or a PUBLIC_URL on port 443`);
      }
      warnings.push(`config: PUBLIC_URL uses port ${urlPort}; without ACME_DNS the certificate needs public port 80 reaching HTTP_PORT ${httpPort}`);
    }
    // Not an error: external 443 -> internal 8443 is common where 443 is taken.
    if (urlPort !== httpsPort) {
      warnings.push(`config: PUBLIC_URL port ${urlPort} differs from HTTPS_PORT ${httpsPort}; assuming the router translates ${urlPort} -> ${httpsPort}`);
    }
  }
  const tunnelToken = ingress === 'tunnel' ? get('TUNNEL_TOKEN') : undefined;

  const livekitPort = int('LIVEKIT_PORT', '7880', 1, 65535);
  const mediaTcpPort = int('MEDIA_TCP_PORT', '7881', 1, 65535);
  const mediaUdpPort = int('MEDIA_UDP_PORT', '7882', 1, 65535);
  const turnPort = int('TURN_PORT', '5349', 1, 65535);
  const turnSetting = oneOf<TurnSetting>('TURN', 'auto', ['auto', 'on', 'off']);
  const publicHost = url.hostname;
  let turn: TurnConfig | null = null;
  if (turnSetting !== 'off') {
    const why = turnIneligibility({ media, ingress, hosting, httpsPort, publicUrl, publicHost });
    if (turnSetting === 'on' && why) {
      throw new Error(`TURN=on is not possible here: ${why}. TURN over TLS on 443 is for a VPS in direct mode on port 443.`);
    }
    // auto: only where turn.<host> resolves with no user action, and only on a
    // declared VPS (a HOSTING-less file at home on 80/443 must not get it).
    const on = turnSetting === 'on'
      || (!why && hosting === 'vps' && turnAutoHost(publicHost));
    if (on) turn = { host: `turn.${publicHost}`, port: turnPort };
  }
  // One flat rule, TCP/UDP not told apart: nobody needs UDP 7882 to equal a TCP port.
  // Cloud binds neither LiveKit's port nor the media ports here.
  const ports: [string, number][] = media === 'self'
    ? [['MEDIA_TCP_PORT', mediaTcpPort], ['MEDIA_UDP_PORT', mediaUdpPort], ['LIVEKIT_PORT', livekitPort], ['LISTEN', port]]
    : [['LISTEN', port]];
  if (ingress === 'direct') {
    ports.push(['HTTPS_PORT', httpsPort]);
    if (httpPort !== 0) ports.push(['HTTP_PORT', httpPort]);
  }
  if (turn) ports.push(['TURN_PORT', turn.port]);
  for (const [i, [a, n]] of ports.entries()) {
    const clash = ports.slice(i + 1).find(([, m]) => m === n);
    if (clash) throw new Error(`ports collide: ${a}=${n}, ${clash[0]}=${n}`);
  }

  const commandName = get('COMMAND_NAME', 'telinha');
  if (!COMMAND_RE.test(commandName) || commandName !== commandName.toLocaleLowerCase()) {
    throw new Error('bad COMMAND_NAME (Discord: lowercase, 1-32 chars)');
  }
  const livekitNodeIp = opt('LIVEKIT_NODE_IP');
  if (livekitNodeIp && !IPV4_RE.test(livekitNodeIp)) throw new Error(`bad LIVEKIT_NODE_IP ${livekitNodeIp} (want an IPv4 address)`);
  // Upper bound: setTimeout's 2^31 ms limit (a longer delay fires at once).
  const ipWatchSeconds = int('IP_WATCH_SECONDS', '300', 0, 2_147_483);
  let livekitUrl: string;
  let livekitApiUrl: string;
  let livekitCloudHost: string | undefined;
  if (media === 'cloud') {
    const raw = get('LIVEKIT_CLOUD_URL');
    let u: URL | null = null;
    try {
      u = new URL(raw);
    } catch {
      // reported below
    }
    const secure = u?.protocol === 'wss:' || u?.protocol === 'https:';
    // Plain ws/http only for a dev run against a local stand-in for Cloud.
    const plain = u?.protocol === 'ws:' || u?.protocol === 'http:';
    if (!u || !u.hostname || !(secure || (plain && dev))) {
      throw new Error(`bad LIVEKIT_CLOUD_URL ${raw} (want wss://<project>.livekit.cloud)`);
    }
    // The project URL is the host alone: a pasted path, query or trailing slash is dropped.
    livekitCloudHost = u.host;
    livekitUrl = `${secure ? 'wss' : 'ws'}://${u.host}`;
    livekitApiUrl = `${secure ? 'https' : 'http'}://${u.host}`;
    const selfOnly: [string, string | undefined][] = [
      ['LIVEKIT_PORT', '7880'], ['MEDIA_TCP_PORT', '7881'], ['MEDIA_UDP_PORT', '7882'],
      ['LIVEKIT_API_URL', `http://127.0.0.1:${livekitPort}`], ['LIVEKIT_PUBLIC_URL', undefined],
    ];
    for (const [k, d] of selfOnly) {
      const v = opt(k);
      if (v !== undefined && v.replace(/\/$/, '') !== d) warnings.push(`config: ${k} only applies to MEDIA=self; ignored`);
    }
  } else {
    // The proxy derives ws(s):// from it per request; a bad value must fail here,
    // not as an error per join (Bun's WebSocket errors quote the URL, token included).
    livekitApiUrl = get('LIVEKIT_API_URL', `http://127.0.0.1:${livekitPort}`).replace(/\/$/, '');
    let apiUrl: URL | null = null;
    try {
      apiUrl = new URL(livekitApiUrl);
    } catch {
      // reported below
    }
    if (!apiUrl || (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') || !apiUrl.hostname) {
      throw new Error(`bad LIVEKIT_API_URL ${livekitApiUrl} (want http(s)://host[:port])`);
    }
    livekitUrl = opt('LIVEKIT_PUBLIC_URL') ?? `${publicUrl.replace(/^http/, 'ws')}/livekit`;
  }
  const paths = resolvePaths(env);

  const upnp = oneOf('UPNP', 'auto', ['auto', 'off'] as const) === 'auto';
  let ddns: DuckDnsConfig | null = null;
  if (oneOf('DDNS_PROVIDER', 'none', ['none', 'duckdns'] as const) === 'duckdns') {
    let domain = get('DUCKDNS_DOMAIN').trim().toLowerCase();
    if (domain.endsWith('.duckdns.org')) {
      domain = domain.slice(0, -'.duckdns.org'.length);
      warnings.push(`config: DUCKDNS_DOMAIN is the subdomain alone; using ${domain}`);
    }
    if (!DUCKDNS_RE.test(domain)) throw new Error(`bad DUCKDNS_DOMAIN ${domain} (want the subdomain: a-z, 0-9, -)`);
    ddns = { provider: 'duckdns', domain, token: get('DUCKDNS_TOKEN') };
    if (url.hostname !== `${domain}.duckdns.org`) {
      warnings.push(`config: DuckDNS updates ${domain}.duckdns.org but PUBLIC_URL's host is ${url.hostname}`);
    }
  }
  // Only the native binary can replace itself; Docker and source runs update their own way.
  let autoUpdate = oneOf('AUTO_UPDATE', compiled ? 'on' : 'off', ['on', 'off'] as const) === 'on';
  if (autoUpdate && !compiled) {
    warnings.push('config: AUTO_UPDATE=on applies to the native binary only; off here (Docker: telinha-update, source: git pull)');
    autoUpdate = false;
  }
  const updatePin = opt('UPDATE_PIN');
  if (updatePin && !TAG_RE.test(updatePin)) throw new Error(`bad UPDATE_PIN ${updatePin} (want a release tag like v1.2.3)`);
  const localeRaw = opt('LOCALE');
  if (localeRaw && !LOCALE_RE.test(localeRaw)) throw new Error(`bad LOCALE ${localeRaw} (want en | pt-BR)`);

  return {
    dev,
    devLocale: dev ? opt('DEV_LOCALE') : undefined,
    discordToken: discord('DISCORD_TOKEN'),
    clientId: discord('DISCORD_CLIENT_ID'),
    clientSecret: discord('DISCORD_CLIENT_SECRET'),
    guildId: discord('GUILD_ID'),
    roleId: discord('ROLE_ID'),
    // the slash command only works in these channels, e.g. a chat visitors can't see
    channelIds: discord('CHANNEL_IDS').split(',').map((c) => c.trim()).filter(Boolean),
    publicUrl,
    cookieSecret: get('COOKIE_SECRET'),
    host,
    port,
    sessionSeconds: num('SESSION_DAYS', '7') * 86400,
    roleTtlMs: num('ROLE_CACHE_SECONDS', '300') * 1000,
    livekitKey: get('LIVEKIT_API_KEY'),
    livekitSecret: get('LIVEKIT_API_SECRET'),
    livekitUrl,
    livekitApiUrl,
    livekitCloudHost,
    dataDir: paths.data,
    closeEmptySeconds: num('CLOSE_EMPTY_SECONDS', '300'),
    pollSeconds: num('POLL_SECONDS', '5'),
    groupName: opt('GROUP_NAME'),
    webDir: opt('WEB_DIR') ?? embeddedWebDir({ compiled }) ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    secureCookies: !publicUrl.startsWith('http://'),
    commandName,
    ingress,
    hosting,
    publicHost,
    warnings,
    httpPort,
    httpsPort,
    acmeEmail: ingress === 'direct' ? opt('ACME_EMAIL') : undefined,
    acmeDns,
    tunnelToken,
    media,
    livekitPort,
    mediaTcpPort,
    mediaUdpPort,
    livekitNodeIp,
    // A static IP never changes, so there is nothing to watch.
    ipWatchSeconds: livekitNodeIp ? 0 : ipWatchSeconds,
    turnSetting,
    turnPort,
    turn,
    upnp,
    ddns,
    autoUpdate,
    updatePin,
    updateCheckHours: int('UPDATE_CHECK_HOURS', '6', 1, 168),
    updateMaxDeferHours: int('UPDATE_MAX_DEFER_HOURS', '12', 0, 720),
    locale: localeRaw ? resolveLocale(localeRaw) : undefined,
    paths,
  };
}

/**
 * What UPNP=auto asks the router to forward: the media ports, plus in direct
 * mode Caddy's HTTPS listener (PUBLIC_URL's port -> HTTPS_PORT) when that port
 * is a high one. Never 80 or 443: home connections block them anyway, and
 * whoever opened them by hand forwards them by hand.
 */
export function upnpMappings(c: Pick<Config, 'media' | 'ingress' | 'publicUrl' | 'mediaTcpPort' | 'mediaUdpPort' | 'httpsPort'>): Mapping[] {
  const out: Mapping[] = [];
  if (c.media === 'self') {
    out.push(
      { protocol: 'tcp', externalPort: c.mediaTcpPort, internalPort: c.mediaTcpPort, description: 'telinha media (tcp)' },
      { protocol: 'udp', externalPort: c.mediaUdpPort, internalPort: c.mediaUdpPort, description: 'telinha media (udp)' },
    );
  }
  if (c.ingress === 'direct') {
    const external = Number(new URL(c.publicUrl).port || 443);
    if (external !== 443 && external !== 80) {
      out.push({ protocol: 'tcp', externalPort: external, internalPort: c.httpsPort, description: 'telinha https' });
    }
  }
  return out;
}
