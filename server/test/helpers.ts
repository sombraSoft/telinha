// Shared fixtures for the handler tests (not a test file itself).
import { sign, type Session } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHandler, type Deps, type Fetch } from '../src/http.ts';
import type { Locale } from '../src/i18n.ts';
import { devIsMember } from '../src/roles.ts';
import { openRegistry } from '../src/rooms.ts';
import { staticFromEntries, type StaticFiles } from '../src/static.ts';

export const PROD_ENV = {
  DISCORD_TOKEN: 'tok', DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret',
  GUILD_ID: '100', ROLE_ID: '200', CHANNEL_IDS: '300, 301,,',
  PUBLIC_URL: 'https://telinha.example.com/', COOKIE_SECRET: 'secret',
  LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'lksecret',
  // Pinned rather than defaulted, so these tests never read the host's layout.
  INGRESS: 'direct', TELINHA_HOME: '/srv/telinha',
};
export const DEV_ENV = {
  DEV_USER: '1:Dev', PUBLIC_URL: 'http://localhost:8081', COOKIE_SECRET: 'x',
  LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret', TELINHA_HOME: '/srv/telinha',
};

export const NOW = 1_700_000_000_000;
const enc = (s: string) => new TextEncoder().encode(s);

export const ENTRIES: [string, Uint8Array][] = [
  ['index.html', enc('<!doctype html><html><head><title>Telinha</title></head><body><div id="app"></div></body></html>')],
  ['assets/index-abc123.js', enc('console.log(1)')],
  ['assets/index-abc123.css', enc('body{}')],
  ['favicon.svg', enc('<svg/>')],
];
export const FILES = staticFromEntries(ENTRIES, { command: 'telinha' });

export interface Setup {
  env?: Record<string, string>;
  /** COMMAND_NAME, also written into the served index.html. */
  command?: string;
  /** Default: ENTRIES with the configured command. */
  files?: StaticFiles;
  members?: string[];
  fetch?: Fetch;
  isMember?: Deps['isMember'];
  /** Rooms opened by the slash command before the test; default: the names the tests use. */
  rooms?: string[];
  ensureRoom?: (room: string) => Promise<void>;
  /** The bot's member directory; unset = not ready yet. */
  directory?: Deps['members'];
  upgrade?: Deps['upgrade'];
  proxy?: Deps['proxy'];
  openRooms?: Deps['openRooms'];
  children?: Deps['children'];
}

export function setup(o: Setup = {}) {
  const config = loadConfig({ ...(o.env ?? PROD_ENV), ...(o.command ? { COMMAND_NAME: o.command } : {}) });
  const logs: unknown[][] = [];
  const members = new Set(o.members ?? ['1']);
  const registry = openRegistry(':memory:');
  for (const room of o.rooms ?? ['bafo-kiru', 'lamofu-tibare']) {
    registry.create({ room, guildId: '100', channelId: '300', locale: 'en', openerId: '1', openerName: 'Zé', what: null, createdAt: NOW - 1000 });
  }
  const ensured: string[] = [];
  const deleted: string[] = [];
  const handler = createHandler({
    config,
    isMember: o.isMember ?? (config.dev ? devIsMember(config.dev.id) : async (id) => members.has(id)),
    files: o.files ?? staticFromEntries(ENTRIES, { command: config.commandName }),
    registry,
    rooms: {
      ensureRoom: o.ensureRoom ?? (async (room) => void ensured.push(room)),
      deleteRoom: async (room) => void deleted.push(room),
    },
    group: (l: Locale) => (l === 'pt-BR' ? 'Galera' : 'Crew'),
    discordReady: () => true,
    members: o.directory,
    fetch: o.fetch ?? (async () => { throw new Error('no fetch in this test'); }),
    now: () => NOW,
    random: (n) => new Uint8Array(n).fill(0xab),
    log: (...a) => { logs.push(a); },
    upgrade: o.upgrade,
    proxy: o.proxy,
    openRooms: o.openRooms,
    children: o.children,
  });
  const base = config.publicUrl;
  /** The handler for requests that must answer (undefined only follows an upgrade). */
  const call = async (req: Request) => {
    const r = await handler(req);
    if (!r) throw new Error(`no response for ${req.url} (upgraded?)`);
    return r;
  };
  const get = (path: string, headers: Record<string, string> = {}) => call(new Request(`${base}${path}`, { headers }));
  const sessionCookie = (s: Partial<Session> = {}) =>
    `telinha=${encodeURIComponent(sign(config.cookieSecret, { id: '1', name: 'Zé', avatar: 'abc', exp: NOW + 60_000, ...s }))}`;
  /** GET as the default member (id 1). */
  const member = (path: string, headers: Record<string, string> = {}) => get(path, { cookie: sessionCookie(), ...headers });
  return { config, handler, call, get, member, logs, sessionCookie, registry, ensured, deleted };
}

export function jwtPayload(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
}
