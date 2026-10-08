// Writes telinha.env: the documented layout of deploy/telinha.env.example with
// the wizard's answers filled in, everything else the file held kept under
// "Other settings", written atomically and readable by its owner only.
import { posix, win32 } from 'node:path';
import { present } from '../../present.ts';
import type { SpawnFn } from '../../service/index.ts';

/**
 * The layout of deploy/telinha.env.example. Keep the two in sync by hand: a
 * test diffs them. Key lines (`KEY=` or `#KEY=default`) are where the
 * wizard's values go; everything else is copied as is.
 */
export const ENV_TEMPLATE = `# Telinha configuration: one file for everything. Copy to <TELINHA_HOME>/config/telinha.env
# (Docker host and Linux root install: /opt/telinha/config/telinha.env), fill in, chmod 600. Never commit or paste it.
# telinha setup writes this file for you; re-run it to change the answers.
# Real environment variables override this file. Commented-out keys show their default.
#
# Values containing $, \\ or # must be 'single-quoted': Docker interpolates or strips them otherwise,
# native telinha reads them literally, and single quotes are the one spelling both read the same.

# --- Identity / Discord ---------------------------------------------------------------------------

# discord.com/developers -> your app -> Bot -> Reset Token; on the same page switch on
# Server Members Intent and Presence Intent (the member list needs both)
DISCORD_TOKEN=''
# OAuth2 page: Client ID + Client Secret. Add the redirect <PUBLIC_URL>/auth/callback
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=''
# The one Discord server (guild) this install serves
GUILD_ID=
# Members with this role may enter
ROLE_ID=
# The slash command works only in these channels (comma separated)
CHANNEL_IDS=
# Slash command name: lowercase, 1-32 letters, digits, - or _
#COMMAND_NAME=telinha
# Group name shown in pages and the command's replies; default = the role's name, or the Discord server's for @everyone
#GROUP_NAME=
# Random, generated on the server: openssl rand -base64 48
COOKIE_SECRET=''
# Login session length in days
#SESSION_DAYS=7
# How long a member's role check is cached, in seconds
#ROLE_CACHE_SECONDS=300

# --- Public URL and HTTP ingress -----------------------------------------------------------------

# What people open, https://host[:port]. At home with DuckDNS the port is part of it: https://name.duckdns.org:8443
PUBLIC_URL=
# home | vps: where Telinha runs, as answered in telinha setup (a re-run starts from it; the doctor adapts its advice)
#HOSTING=
# direct = bundled Caddy gets a certificate and binds HTTPS_PORT (and HTTP_PORT); tunnel = Cloudflare Tunnel
# (no open ports); external = your own reverse proxy forwards to LISTEN
#INGRESS=direct
# Telinha's own listener; Caddy, cloudflared or your proxy forward here
#LISTEN=127.0.0.1:8081
# direct: HTTP->HTTPS redirect and Let's Encrypt HTTP challenge port; 0 turns that listener off (always 0 at home)
#HTTP_PORT=80
# direct: the port Caddy binds for TLS: 443 on a VPS; at home a high port (8443) that PUBLIC_URL also carries
#HTTPS_PORT=443
# direct, optional: Let's Encrypt account email
#ACME_EMAIL=
# direct: how Caddy proves the name to Let's Encrypt. none = over public ports 80/443 (a VPS); duckdns = through the
# DuckDNS API with DUCKDNS_TOKEN (a home connection: nothing to open on 80/443, HTTPS on HTTPS_PORT)
#ACME_DNS=none
# tunnel only, uncomment it: Cloudflare Zero Trust -> Networks -> Tunnels -> your tunnel's token;
# its public hostname points at http://localhost:<LISTEN port>
#TUNNEL_TOKEN=''
# Dynamic DNS for a changing home IP: duckdns keeps <DUCKDNS_DOMAIN>.duckdns.org pointing at this
# network (duckdns.org -> sign in -> add a subdomain; the token is on the same page)
#DDNS_PROVIDER=none
# The subdomain alone, without .duckdns.org
#DUCKDNS_DOMAIN=
#DUCKDNS_TOKEN=''

# --- Media (LiveKit) -----------------------------------------------------------------------------

# self = the bundled livekit-server on this machine (media ports to forward); cloud = LiveKit Cloud: no media
# port to open, the free Build plan allows 5,000 participant-minutes and 50 GB downstream a month, with up to
# 100 participants connected at once. Turn automatic room creation off in the Cloud project's settings.
#MEDIA=self
# self: any key/secret pair you make up (telinha setup generates them); cloud: the project's API key and secret
# (cloud.livekit.io -> project -> Settings -> Keys)
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=''
# cloud: the project's URL (Settings -> Project), wss://<project>.livekit.cloud
#LIVEKIT_CLOUD_URL=
# self: LiveKit's signaling/API port, loopback only
#LIVEKIT_PORT=7880
# self: ICE over TCP and UDP: forward both on the router
#MEDIA_TCP_PORT=7881
#MEDIA_UDP_PORT=7882
# auto = ask the router (UPnP IGD, NAT-PMP or PCP) to forward the media ports, and HTTPS_PORT in direct
# mode when PUBLIC_URL's port is not 443, while telinha runs; off = forward them by hand
#UPNP=auto
# Static public IPv4: skips STUN and turns the IP watch off
#LIVEKIT_NODE_IP=
# self: LiveKit HTTP API as telinha reaches it; default http://127.0.0.1:<LIVEKIT_PORT>
#LIVEKIT_API_URL=http://127.0.0.1:7880
# self: WebSocket URL browsers use for signaling; default = PUBLIC_URL as wss:// + /livekit (proxied by telinha)
#LIVEKIT_PUBLIC_URL=
# How often the public IP is checked, in seconds; 0 = off. On a change the router mappings are renewed, DuckDNS
# is told and (self) LiveKit restarts
#IP_WATCH_SECONDS=300
# TURN over TLS on port 443 for people on networks that only let 443 through. VPS in direct mode on 443 only
# (never at home). auto = on for a VPS install with a DuckDNS or sslip.io address (turn.<host> resolves by
# itself), off with your own domain until you add the DNS record turn.<host> -> your IP and set on; off = never
#TURN=auto
# TURN: the local port LiveKit's TURN listens on; Caddy terminates TLS on 443 and forwards here. Keep it closed
# in the firewall
#TURN_PORT=5349

# --- Rooms ---------------------------------------------------------------------------------------

# A room closes for good after this many seconds with nobody in it (also counted from its
# opening when nobody ever joins)
#CLOSE_EMPTY_SECONDS=300
# How often rooms are checked, in seconds
#POLL_SECONDS=5

# --- Native install ------------------------------------------------------------------------------

# on = install new stable releases by itself, once no room is open; default on in the native
# binary, always off in Docker and from source (Docker: telinha-update)
#AUTO_UPDATE=on
# Stay on this release instead of the newest, e.g. v0.7.0
#UPDATE_PIN=
# How often to look for a new release, in hours (1-168)
#UPDATE_CHECK_HOURS=6
# Longest wait for open rooms before an update is applied anyway, in hours; 0 = do not wait
#UPDATE_MAX_DEFER_HOURS=12
# Language of the command line and setup: en or pt-BR (pages follow the browser)
#LOCALE=

# --- Locations -----------------------------------------------------------------------------------

# Root of bin/ config/ data/ logs/; default %LOCALAPPDATA%\\Telinha, /opt/telinha (root) or
# ~/.local/share/telinha; the image sets /telinha
#TELINHA_HOME=
# Env file to load; only meaningful as a real environment variable; default <TELINHA_HOME>/config/telinha.env
#TELINHA_ENV=
# Room registry, rendered livekit.yaml/Caddyfile (run/) and certificates (caddy/); default <TELINHA_HOME>/data
#DATA_DIR=
# Where livekit-server, caddy and cloudflared are looked for before PATH; default <TELINHA_HOME>/bin
#BIN_DIR=
# Built web app; default: the one inside the native binary, else web/dist next to the sources
#WEB_DIR=

# --- Dev only ------------------------------------------------------------------------------------

# Fake login for local dev: never set it here. The server refuses to start with it unless
# PUBLIC_URL is http://localhost or http://127.0.0.1 and INGRESS is external.
#DEV_USER=
#DEV_LOCALE=
`;

/** Keys the wizard decides: a re-run rewrites or drops them; every other key is kept as it was. */
export const MANAGED_KEYS: readonly string[] = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'GUILD_ID',
  'ROLE_ID',
  'CHANNEL_IDS',
  'COMMAND_NAME',
  'GROUP_NAME',
  'COOKIE_SECRET',
  'PUBLIC_URL',
  'HOSTING',
  'INGRESS',
  'ACME_DNS',
  'HTTP_PORT',
  'HTTPS_PORT',
  'TUNNEL_TOKEN',
  'DDNS_PROVIDER',
  'DUCKDNS_DOMAIN',
  'DUCKDNS_TOKEN',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'MEDIA',
  'LIVEKIT_CLOUD_URL',
  'TURN',
  'MEDIA_TCP_PORT',
  'MEDIA_UDP_PORT',
  'UPNP',
  'LIVEKIT_NODE_IP',
  'AUTO_UPDATE',
  'LOCALE',
];

/** Always single-quoted, never shown. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_SECRET',
  'COOKIE_SECRET',
  'LIVEKIT_API_SECRET',
  'TUNNEL_TOKEN',
  'DUCKDNS_TOKEN',
]);

const KEY_LINE = /^(#?)([A-Z_][A-Z0-9_]*)=(.*)$/;
const SECTION_WIDTH = 100;

/** The previous file: parsed values, and its text when the raw lines should be kept verbatim. */
export interface PreviousEnv {
  vars: Record<string, string>;
  text?: string;
}

/**
 * KEY=value with the quoting both Docker's env_file and envfile.ts read the
 * same: single quotes when the value has $, \, #, whitespace or quotes (and
 * for secrets always). A value with ' falls back to double quotes, which is
 * only safe without $, \ and ".
 */
export function quoteValue(key: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${key}: a value cannot span lines`);
  if (!SECRET_KEYS.has(key) && !/[$\\#\s'"]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!/[$\\"]/.test(value)) return `"${value}"`;
  throw new Error(`${key}: a value cannot hold ' together with $, \\ or "`);
}

/** The last non-comment line defining each key, as written. */
function rawLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.replace(/^export\s+/, '').indexOf('=');
    if (eq > 0)
      out.set(
        line
          .replace(/^export\s+/, '')
          .slice(0, eq)
          .trim(),
        line,
      );
  }
  return out;
}

/**
 * The file text for `values` (empty string = not set). Managed keys go to
 * their documented place; keys of `previous` the wizard does not manage, and
 * values with no place in the template, land under "Other settings".
 */
export function renderEnvFile(values: Record<string, string>, previous: PreviousEnv | null): string {
  const placed = new Set<string>();
  const lines = ENV_TEMPLATE.replace(/\n$/, '')
    .split('\n')
    .map((line) => {
      const m = KEY_LINE.exec(line);
      if (!m) return line;
      const key = present(m[2], 'a template key');
      placed.add(key);
      const value = values[key];
      return value ? `${key}=${quoteValue(key, value)}` : line;
    });

  const other: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (!placed.has(k) && v !== '') other.push(`${k}=${quoteValue(k, v)}`);
  }
  if (previous) {
    const raw = previous.text !== undefined ? rawLines(previous.text) : new Map<string, string>();
    for (const [k, v] of Object.entries(previous.vars)) {
      if (MANAGED_KEYS.includes(k) || Object.hasOwn(values, k)) continue;
      other.push(raw.get(k) ?? `${k}=${quoteValue(k, v)}`);
    }
  }
  if (other.length) {
    const title = '# --- Other settings ';
    lines.push('', title + '-'.repeat(SECTION_WIDTH - title.length), '', ...other);
  }
  return `${lines.join('\n')}\n`;
}

/** File operations, injected so tests record chmod/chown on any host. */
export interface EnvFs {
  mkdir(dir: string): Promise<void>;
  /**
   * A new file, never through a symlink: open(O_CREAT|O_EXCL|O_NOFOLLOW), then
   * mode and owner set on the open handle, then the data. Fails when the path
   * exists in any form.
   */
  createFile(path: string, data: string, o: { mode: number; uid?: number; gid?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** The link itself when `path` is one (lchown). */
  chown(path: string, uid: number, gid: number): Promise<void>;
  /** lstat: a symlink is reported as one, never followed. null when the path does not exist. */
  stat(path: string): Promise<{ uid: number; gid: number; mode: number; dir?: boolean; symlink?: boolean } | null>;
  /** unlink: removes a symlink itself, never its target. */
  rm(path: string): Promise<void>;
}

export interface WriteEnvOptions {
  file: string;
  text: string;
  fs: EnvFs;
  platform: NodeJS.Platform;
  isRoot: boolean;
  /** TELINHA_HOME: its owner owns a new file (a root re-run must not lock the service user out). */
  home: string;
  /** Inside the image: the mounted config dir is the host's; only the file mode is ours. */
  docker: boolean;
  spawn: SpawnFn;
  /** Windows: the account that keeps access (DOMAIN\user). */
  user: string;
}

/** Windows ACL: inheritance off, full control for the user, SYSTEM and Administrators (by SID: names are localised). */
export const icaclsArgv = (file: string, user: string): string[] => [
  'icacls',
  file,
  '/inheritance:r',
  '/grant:r',
  `${user}:(F)`,
  '*S-1-5-18:(F)',
  '*S-1-5-32-544:(F)',
];

/**
 * The same for the whole Windows home, inherited by everything in it: the
 * control token, the task XML and bin\ (which the elevated `service install`
 * registers) stay the user's under a TELINHA_HOME like C:\Telinha, whose
 * inherited ACL lets Users read and Authenticated Users modify.
 */
export const icaclsHomeArgv = (home: string, user: string): string[] => [
  'icacls',
  home,
  '/inheritance:r',
  '/grant:r',
  `${user}:(OI)(CI)F`,
  '*S-1-5-18:(OI)(CI)F',
  '*S-1-5-32-544:(OI)(CI)F',
];

/** Locks the Windows home down to the user, SYSTEM and Administrators; a failure is a warning (doctor checks the file). */
export async function lockWindowsHome(o: {
  home: string;
  user: string;
  spawn: SpawnFn;
  warn: (msg: string) => void;
}): Promise<void> {
  const r = await o
    .spawn(icaclsHomeArgv(o.home, o.user))
    .catch((e: unknown) => ({ code: 1, stdout: '', stderr: String(e) }));
  if (r.code !== 0) o.warn(`icacls ${o.home}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
}

const GROUP_READ = 0o040;
const GROUP_OTHER_WRITE = 0o022;

/**
 * Atomic write (.tmp + rename) with owner-only access, the file never open to
 * anyone else for a moment:
 * - Linux: a 0700 dir (0750 when it already was, the root install's
 *   root:telinha config/) and a 0600 file (0640 when the previous one was
 *   group-readable), created exclusively without following a symlink, mode
 *   and owner set on the open handle. As root the owner is the previous
 *   file's, else the home dir's; a config dir that is a symlink, belongs to
 *   neither root nor the home's owner, or is writable by group/other is
 *   refused: someone else could swap files in it under root's hands.
 * - Windows: the tmp file's ACL is reset before it takes the real name; if
 *   that fails nothing is written.
 */
export async function writeEnvFile(o: WriteEnvOptions): Promise<void> {
  const { fs } = o;
  const dir = (o.platform === 'win32' ? win32 : posix).dirname(o.file);
  const tmp = `${o.file}.tmp`;
  const linux = o.platform !== 'win32';
  const before = linux ? await fs.stat(o.file) : null;
  const dirBefore = linux ? await fs.stat(dir) : null;
  await fs.mkdir(dir);
  let owner: { uid: number; gid: number } | null = null;
  if (linux && !o.docker) {
    const home = await fs.stat(o.home);
    if (o.isRoot) {
      const d = await fs.stat(dir);
      const trusted = new Set([0, home?.uid ?? 0]);
      if (!d || d.symlink || d.dir === false || !trusted.has(d.uid) || d.mode & GROUP_OTHER_WRITE) {
        throw new Error(
          `refusing to write into ${dir} as root: it must be a directory owned by root (or the home's owner) and not writable by others`,
        );
      }
      owner = before ?? home;
    }
    await fs.chmod(dir, dirBefore && (dirBefore.mode & 0o050) === 0o050 ? 0o750 : 0o700);
    if (o.isRoot && !dirBefore && owner) await fs.chown(dir, owner.uid, owner.gid);
  }
  const mode = linux && before && before.mode & GROUP_READ && !o.docker ? 0o640 : 0o600;
  // A leftover (or planted) tmp goes first: unlink removes a symlink, not its target.
  await fs.rm(tmp);
  try {
    await fs.createFile(tmp, o.text, { mode, ...(owner ? { uid: owner.uid, gid: owner.gid } : {}) });
    if (!linux) {
      const r = await o
        .spawn(icaclsArgv(tmp, o.user))
        .catch((e: unknown) => ({ code: 1, stdout: '', stderr: String(e) }));
      if (r.code !== 0)
        throw new Error(
          `could not restrict access to ${o.file} (icacls: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`})`,
        );
    }
    await fs.rename(tmp, o.file);
  } catch (e) {
    await fs.rm(tmp).catch(() => {});
    throw e;
  }
}
