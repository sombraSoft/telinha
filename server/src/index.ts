// Telinha: Discord login gate in front of the LiveKit room page (Caddy
// forward_auth calls /auth/check on every request), the room page itself
// (/sala/), the /telinha slash command and the room lifecycle. See README.md.
import { REST } from 'discord.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { editCard, startBot } from './bot.ts';
import { renderCard, type Card } from './card.ts';
import { loadConfig } from './config.ts';
import { createHandler } from './http.ts';
import { t, type Locale } from './i18n.ts';
import { createLifecycle } from './lifecycle.ts';
import { roomService } from './livekit.ts';
import { createDirectory } from './members.ts';
import { createRoleChecker, devIsMember, restGetMember, type IsMember } from './roles.ts';
import { openRegistry } from './rooms.ts';
import { loadStatic } from './static.ts';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const config = loadConfig(process.env);
const files = loadStatic(config.webDir);
mkdirSync(config.dataDir, { recursive: true });
const registry = openRegistry(join(config.dataDir, 'telinha.sqlite'));
const rooms = roomService({
  url: config.livekitApiUrl, key: config.livekitKey, secret: config.livekitSecret, closeEmptySeconds: config.closeEmptySeconds,
});

let isMember: IsMember;
let discordReady = () => false;
// Filled by the bot; stays "not ready" (an empty list) in dev, where http.ts serves a fixed one.
const directory = createDirectory();
let guildName = (): string | undefined => undefined;
// GROUP_NAME, else the guild's name once the bot sees it, else "members".
const group = (l: Locale) => config.groupName ?? guildName() ?? t(l, 'members');
const render = (rec: Parameters<typeof renderCard>[0], live: Parameters<typeof renderCard>[1] = { streamers: [], viewers: [] }) =>
  renderCard(rec, live, { publicUrl: config.publicUrl, group: group(rec.locale) });
// Dev rooms have no Discord message; the lifecycle still opens and closes them.
let editMessage = async (_c: string, _m: string, _card: Card) => {};

if (config.dev) {
  log(`!!! DEV_USER fake login enabled: everyone on ${config.publicUrl} is "${config.dev.name}" (${config.dev.id}); Discord bot not started !!!`);
  isMember = devIsMember(config.dev.id);
} else {
  const rest = new REST().setToken(config.discordToken);
  isMember = createRoleChecker({ getMember: restGetMember(rest, config.guildId), roleId: config.roleId, ttlMs: config.roleTtlMs });
  const client = startBot({ config, rest, group, log, registry, rooms, render: (rec) => render(rec), directory });
  discordReady = () => client.isReady();
  guildName = () => client.guilds.cache.get(config.guildId)?.name;
  editMessage = editCard(rest);
}

createLifecycle({
  registry, rooms, render, editMessage: (c, m, card) => editMessage(c, m, card), closeEmptyMs: config.closeEmptySeconds * 1000, log,
}).start(config.pollSeconds * 1000);

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createHandler({ config, isMember, files, group, registry, rooms, discordReady: () => discordReady(), members: () => directory.list(), log }),
});
log(`gate on ${server.hostname}:${server.port}; rooms in ${config.dataDir}`);
