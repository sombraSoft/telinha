// Shared fixtures for the handler tests (not a test file itself).
import { sign, type Session } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHandler, type Deps, type Fetch } from '../src/http.ts';
import type { Locale } from '../src/i18n.ts';
import { devIsMember } from '../src/roles.ts';
import { openRegistry } from '../src/rooms.ts';
import { staticFromEntries } from '../src/static.ts';

export const PROD_ENV = {
  DISCORD_TOKEN: 'tok', DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret',
  GUILD_ID: '100', ROLE_ID: '200', CHANNEL_IDS: '300, 301,,',
  PUBLIC_URL: 'https://tela.example.com/', COOKIE_SECRET: 'secret',
  LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'lksecret',
};
export const DEV_ENV = {
  DEV_USER: '1:Dev', PUBLIC_URL: 'http://localhost:8081', COOKIE_SECRET: 'x',
  LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret',
};

export const NOW = 1_700_000_000_000;
const enc = (s: string) => new TextEncoder().encode(s);

export const FILES = staticFromEntries([
  ['index.html', enc('<!doctype html><div id="app"></div>')],
  ['assets/index-abc123.js', enc('console.log(1)')],
  ['assets/index-abc123.css', enc('body{}')],
  ['favicon.svg', enc('<svg/>')],
]);

export interface Setup {
  env?: Record<string, string>;
  members?: string[];
  fetch?: Fetch;
  isMember?: Deps['isMember'];
  /** Rooms opened by /telinha before the test; default: the names the tests use. */
  rooms?: string[];
  ensureRoom?: (room: string) => Promise<void>;
  /** The bot's member directory; unset = not ready yet. */
  directory?: Deps['members'];
}

export function setup(o: Setup = {}) {
  const config = loadConfig(o.env ?? PROD_ENV);
  const logs: unknown[][] = [];
  const members = new Set(o.members ?? ['1']);
  const registry = openRegistry(':memory:');
  for (const room of o.rooms ?? ['abcd', 'Room_1-x']) {
    registry.create({ room, guildId: '100', channelId: '300', locale: 'en', openerId: '1', openerName: 'Zé', what: null, createdAt: NOW - 1000 });
  }
  const ensured: string[] = [];
  const deleted: string[] = [];
  const handler = createHandler({
    config,
    isMember: o.isMember ?? (config.dev ? devIsMember(config.dev.id) : async (id) => members.has(id)),
    files: FILES,
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
  });
  const base = config.publicUrl;
  const get = (path: string, headers: Record<string, string> = {}) =>
    handler(new Request(`${base}${path}`, { headers }));
  const sessionCookie = (s: Partial<Session> = {}) =>
    `telinha=${encodeURIComponent(sign(config.cookieSecret, { id: '1', name: 'Zé', avatar: 'abc', exp: NOW + 60_000, ...s }))}`;
  return { config, handler, get, logs, sessionCookie, registry, ensured, deleted };
}

export function jwtPayload(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
}
