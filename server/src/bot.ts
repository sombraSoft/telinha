// The slash command (COMMAND_NAME, /telinha by default): opens a room and
// posts its live status card in the allowed channels.
// Replies only the caller sees use their client locale; the card uses the
// guild locale. Also keeps the member directory (members.ts) current.

import { randomBytes } from 'node:crypto';
import {
  Client,
  Locale as DLocale,
  GatewayIntentBits,
  type GuildMember,
  InteractionContextType,
  MessageFlags,
  Options,
  type PartialGuildMember,
  type REST,
  Routes,
  SlashCommandBuilder,
  Status,
} from 'discord.js';
import type { Card } from './card.ts';
import { uniqueRoomCode } from './codes.ts';
import type { Config } from './config.ts';
import { dicts, type Locale, resolveLocale, t } from './i18n.ts';
import { type Directory, memberData } from './members.ts';
import type { RoomRecord, Rooms } from './rooms.ts';

export function buildCommand(name: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(dicts.en.cmdDescription)
    .setDescriptionLocalizations({ [DLocale.PortugueseBR]: dicts['pt-BR'].cmdDescription })
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName('what')
        .setNameLocalizations({ [DLocale.PortugueseBR]: 'o_que' })
        .setDescription(dicts.en.optWhatDescription)
        .setDescriptionLocalizations({ [DLocale.PortugueseBR]: dicts['pt-BR'].optWhatDescription })
        .setMaxLength(80),
    );
}

export interface CommandInput {
  /** interaction.locale (the caller's client language) */
  locale: string | null | undefined;
  /** interaction.guildLocale */
  guildLocale: string | null | undefined;
  allowed: boolean;
  /** The configured command name, for replies that mention it. */
  command: string;
  guildId: string;
  channelId: string;
  channelIds: string[];
  userId: string;
  who: string;
  what: string | null;
}

export interface Ephemeral {
  content: string;
  flags: MessageFlags.Ephemeral;
  allowedMentions: { parse: [] };
}

export type CommandPayload = (Card & { flags?: undefined }) | Ephemeral;

const ephemeral = (content: string): Ephemeral => ({
  content,
  flags: MessageFlags.Ephemeral,
  allowedMentions: { parse: [] },
});

/** The ephemeral refusal, or null when this caller may open a room here. */
export function commandDenied(
  i: Pick<CommandInput, 'locale' | 'allowed' | 'command' | 'channelId' | 'channelIds'>,
  group: (l: Locale) => string,
): Ephemeral | null {
  const me = resolveLocale(i.locale);
  if (!i.allowed) return ephemeral(t(me, 'onlyGroup', { group: group(me) }));
  if (!i.channelIds.includes(i.channelId)) {
    const where = i.channelIds.map((c) => `<#${c}>`).join(t(me, 'or'));
    return ephemeral(t(me, 'wrongChannel', { cmd: i.command, where }));
  }
  return null;
}

export interface CommandDeps {
  rooms: Pick<Rooms, 'open'>;
  /** The open card with nobody in it yet. */
  render: (rec: RoomRecord) => Card;
  /** Sends the interaction reply; returns where the public card landed. */
  reply: (p: CommandPayload) => Promise<{ channelId: string; messageId: string } | null>;
  newRoom: () => string;
  group: (l: Locale) => string;
  log: (...a: unknown[]) => void;
}

export async function handleCommand(i: CommandInput, d: CommandDeps): Promise<void> {
  const denied = commandDenied(i, d.group);
  if (denied) {
    await d.reply(denied);
    return;
  }
  const room = d.newRoom();
  try {
    // A failed open leaves no room behind (rooms.ts): only the caller hears of it.
    await d.rooms.open(
      {
        room,
        guildId: i.guildId,
        channelId: i.channelId,
        locale: resolveLocale(i.guildLocale),
        openerId: i.userId,
        openerName: i.who,
        what: i.what,
      },
      async (rec) => {
        const posted = await d.reply(d.render(rec));
        if (!posted) throw new Error('no message in the interaction response');
        return posted;
      },
    );
    d.log(i.command, i.userId, room);
  } catch (e) {
    d.log(`${i.command} failed`, room, (e as Error).message);
    await d.reply(ephemeral(t(resolveLocale(i.locale), 'openFailed')));
  }
}

/**
 * The group's name when GROUP_NAME is unset: the gate role's, or the Discord
 * server's when the role is @everyone (its id is the guild's) or not in the
 * cache; undefined until the bot sees the guild.
 */
export function defaultGroupName(
  guild: { id: string; name: string; roles: { cache: { get(id: string): { name: string } | undefined } } } | undefined,
  roleId: string,
): string | undefined {
  if (!guild) return undefined;
  return (roleId !== guild.id && guild.roles.cache.get(roleId)?.name) || guild.name;
}

/** Card edits go through REST: the interaction token behind the reply expires after 15 min. */
export function editCard(rest: REST) {
  return async (channelId: string, messageId: string, card: Card): Promise<void> => {
    await rest.patch(Routes.channelMessage(channelId, messageId), {
      body: { content: card.content, components: card.components, allowed_mentions: { parse: [] } },
    });
  };
}

export function startBot(o: {
  config: Config;
  rest: REST;
  group: (l: Locale) => string;
  log: (...a: unknown[]) => void;
  rooms: Pick<Rooms, 'open' | 'get'>;
  render: (rec: RoomRecord) => Card;
  directory: Directory;
}): Client {
  const { config: c, rest, group, log, directory } = o;
  // GuildMembers and GuildPresences are privileged: both must be switched on
  // in the Developer Portal (Bot tab), or login fails with "disallowed intents".
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      // Presences carry activities and change all the time: cache only the
      // role members' (read once by loadMembers); the directory keeps its own
      // copy of everyone's status from the events.
      PresenceManager: {
        maxSize: 0,
        keepOverLimit: (p) => p.guild?.members.cache.get(p.userId)?.roles.cache.has(c.roleId) ?? false,
      },
    }),
  });
  const command = buildCommand(c.commandName).toJSON();

  async function registerCommand() {
    try {
      await rest.put(Routes.applicationGuildCommands(client.application!.id, c.guildId), { body: [command] });
      log(`/${c.commandName} registered`);
    } catch (e) {
      log(`/${c.commandName} not registered yet (bot not in guild?)`, (e as Error).message);
    }
  }

  // The whole guild once per gateway connection (members, roles and presences of
  // the online ones); the events below keep it current from there. A failed
  // load (fetch timeout, Discord hiccup) tries again: 30 s, 1, 2, 4... up to
  // 10 min, until one works or a new connection starts over.
  let retry: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  async function loadMembers() {
    if (retry) clearTimeout(retry);
    retry = null;
    const guild = client.guilds.cache.get(c.guildId);
    // Down in an outage: guildAvailable loads it once it is back.
    if (!guild?.available) return;
    try {
      const all = [...(await guild.members.fetch({ withPresences: true })).values()];
      directory.reset(
        all.map((m) => memberData(m, c.roleId)),
        all.map((m) => [m.id, m.presence?.status]),
      );
      failures = 0;
      log(`members: ${directory.size} with the role`);
    } catch (e) {
      const wait = Math.min(30_000 * 2 ** failures++, 600_000);
      log(`members not loaded, again in ${wait / 1000} s`, (e as Error).message);
      retry = setTimeout(() => void loadMembers(), wait);
    }
  }
  const ours = (m: GuildMember | PartialGuildMember) => m.guild.id === c.guildId;
  const upsert = (m: GuildMember) => {
    if (ours(m)) directory.upsert(memberData(m, c.roleId));
  };

  client.once('clientReady', () => {
    log(`logged in as ${client.user?.tag}`);
    void registerCommand();
  });
  // Every fresh session (the first one and after a re-identify): events from
  // while the bot was away are lost, so start over.
  client.on('shardReady', () => void loadMembers());
  client.on('guildCreate', (g) => {
    if (g.id !== c.guildId) return;
    void registerCommand();
    void loadMembers();
  });
  // Back from an outage (it was down when the session started). Every session
  // start also brings guilds back this way, before shardReady: that one loads.
  client.on('guildAvailable', (g) => {
    if (g.id === c.guildId && g.shard.status === Status.Ready) void loadMembers();
  });
  client.on('guildMemberAdd', upsert);
  client.on('guildMemberUpdate', (_old, m) => upsert(m));
  // A member discord.js had not cached comes as "available" instead of
  // "update". Add only: a presence for an uncached member also fires it, with
  // a member built without roles.
  client.on('guildMemberAvailable', (m) => {
    if (!m.partial && m.roles.cache.has(c.roleId)) upsert(m);
  });
  client.on('guildMemberRemove', (m) => {
    if (ours(m)) directory.remove(m.id);
  });
  client.on('presenceUpdate', (_old, p) => {
    if (p.guild?.id === c.guildId) directory.presence(p.userId, p.status);
  });
  // Global name or avatar changed: re-read the member.
  client.on('userUpdate', (_old, u) => {
    const m = client.guilds.cache.get(c.guildId)?.members.cache.get(u.id);
    if (m) upsert(m);
  });

  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || i.commandName !== c.commandName) return;
    try {
      const roles = i.member?.roles;
      const hasRole = Array.isArray(roles) ? roles.includes(c.roleId) : Boolean(roles?.cache.has(c.roleId));
      const member = i.member && 'displayName' in i.member ? i.member.displayName : null;
      await handleCommand(
        {
          locale: i.locale,
          guildLocale: i.guildLocale,
          allowed: i.guildId === c.guildId && hasRole,
          command: c.commandName,
          guildId: i.guildId ?? '',
          channelId: i.channelId,
          channelIds: c.channelIds,
          userId: i.user.id,
          who: member ?? i.user.globalName ?? i.user.username,
          what: i.options.getString('what'),
        },
        {
          rooms: o.rooms,
          render: o.render,
          async reply(p) {
            if (p.flags) {
              // after a failed public reply the interaction may already be acknowledged
              await (i.replied || i.deferred ? i.followUp(p) : i.reply(p));
              return null;
            }
            const res = await i.reply({ ...p, withResponse: true });
            const m = res.resource?.message;
            return m ? { channelId: m.channelId, messageId: m.id } : null;
          },
          newRoom: () => uniqueRoomCode((code) => o.rooms.get(code) !== null, randomBytes),
          group,
          log,
        },
      );
    } catch (e) {
      log('command error', (e as Error).message);
    }
  });

  void client.login(c.discordToken);
  return client;
}
