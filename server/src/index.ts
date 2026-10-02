// Telinha: Discord login gate in front of the LiveKit room page (Caddy
// forward_auth calls /auth/check on every request), the room page itself
// (/sala/) and the /tela slash command. See README.md for the architecture.
import { REST } from 'discord.js';
import { startBot } from './bot.ts';
import { loadConfig } from './config.ts';
import { createHandler } from './http.ts';
import { t, type Locale } from './i18n.ts';
import { createRoleChecker, devIsMember, restGetMember, type IsMember } from './roles.ts';
import { loadStatic } from './static.ts';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

const config = loadConfig(process.env);
const files = loadStatic(config.webDir);

let isMember: IsMember;
let discordReady = () => false;
let guildName = (): string | undefined => undefined;
// GROUP_NAME, else the guild's name once the bot sees it, else "members".
const group = (l: Locale) => config.groupName ?? guildName() ?? t(l, 'members');

if (config.dev) {
  log(`!!! DEV_USER fake login enabled: everyone on ${config.publicUrl} is "${config.dev.name}" (${config.dev.id}); Discord bot not started !!!`);
  isMember = devIsMember(config.dev.id);
} else {
  const rest = new REST().setToken(config.discordToken);
  isMember = createRoleChecker({ getMember: restGetMember(rest, config.guildId), roleId: config.roleId, ttlMs: config.roleTtlMs });
  const client = startBot({ config, rest, group, log });
  discordReady = () => client.isReady();
  guildName = () => client.guilds.cache.get(config.guildId)?.name;
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createHandler({ config, isMember, files, group, discordReady: () => discordReady(), log }),
});
log(`gate on ${server.hostname}:${server.port}`);
