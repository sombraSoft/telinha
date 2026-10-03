// /telinha: opens a room and posts its live status card in the allowed channels.
// Replies only the caller sees use their client locale; the card uses the
// guild locale. Also keeps the member directory (members.ts) current.
import {
  Client, GatewayIntentBits, InteractionContextType, Locale as DLocale, MessageFlags, Options, REST, Routes,
  SlashCommandBuilder, Status, type GuildMember, type PartialGuildMember,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import type { Card } from './card.ts';
import type { Config } from './config.ts';
import { dicts, resolveLocale, t, type Locale } from './i18n.ts';
import { memberData, type Directory } from './members.ts';
import type { RoomService } from './livekit.ts';
import type { Registry, RoomRecord } from './rooms.ts';

export function buildCommand() {
  return new SlashCommandBuilder()
    .setName('telinha')
    .setDescription(dicts.en.cmdDescription)
    .setDescriptionLocalizations({ [DLocale.PortugueseBR]: dicts['pt-BR'].cmdDescription })
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o
      .setName('what')
      .setNameLocalizations({ [DLocale.PortugueseBR]: 'o_que' })
      .setDescription(dicts.en.optWhatDescription)
      .setDescriptionLocalizations({ [DLocale.PortugueseBR]: dicts['pt-BR'].optWhatDescription })
      .setMaxLength(80));
}

export interface TelaInput {
  /** interaction.locale (the caller's client language) */
  locale: string | null | undefined;
  /** interaction.guildLocale */
  guildLocale: string | null | undefined;
  allowed: boolean;
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

export type TelaPayload = (Card & { flags?: undefined }) | Ephemeral;

const ephemeral = (content: string): Ephemeral => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

/** The ephemeral refusal, or null when this caller may open a room here. */
export function telaDenied(
  i: Pick<TelaInput, 'locale' | 'allowed' | 'channelId' | 'channelIds'>, group: (l: Locale) => string,
): Ephemeral | null {
  const me = resolveLocale(i.locale);
  if (!i.allowed) return ephemeral(t(me, 'onlyGroup', { group: group(me) }));
  if (!i.channelIds.includes(i.channelId)) {
    const where = i.channelIds.map((c) => `<#${c}>`).join(t(me, 'or'));
    return ephemeral(t(me, 'wrongChannel', { where }));
  }
  return null;
}

export interface TelaDeps {
  registry: Registry;
  rooms: Pick<RoomService, 'ensureRoom' | 'deleteRoom'>;
  /** The open card with nobody in it yet. */
  render: (rec: RoomRecord) => Card;
  /** Sends the interaction reply; returns where the public card landed. */
  reply: (p: TelaPayload) => Promise<{ channelId: string; messageId: string } | null>;
  newRoom: () => string;
  now: () => number;
  group: (l: Locale) => string;
  log: (...a: unknown[]) => void;
}

export async function handleTela(i: TelaInput, d: TelaDeps): Promise<void> {
  const denied = telaDenied(i, d.group);
  if (denied) {
    await d.reply(denied);
    return;
  }
  const room = d.newRoom();
  const rec = d.registry.create({
    room, guildId: i.guildId, channelId: i.channelId, locale: resolveLocale(i.guildLocale),
    openerId: i.userId, openerName: i.who, what: i.what, createdAt: d.now(),
  });
  try {
    await d.rooms.ensureRoom(room);
    const posted = await d.reply(d.render(rec));
    if (!posted) throw new Error('no message in the interaction response');
    d.registry.setMessage(room, posted.channelId, posted.messageId);
    d.log('telinha', i.userId, room);
  } catch (e) {
    // A room without its card would be a link nobody can see the state of.
    d.log('telinha failed', room, (e as Error).message);
    d.registry.close(room, d.now());
    await d.rooms.deleteRoom(room).catch(() => {});
    await d.reply(ephemeral(t(resolveLocale(i.locale), 'telaFailed')));
  }
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
  config: Config; rest: REST; group: (l: Locale) => string; log: (...a: unknown[]) => void;
  registry: Registry; rooms: Pick<RoomService, 'ensureRoom' | 'deleteRoom'>; render: (rec: RoomRecord) => Card;
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
  const command = buildCommand().toJSON();

  async function registerCommand() {
    try {
      await rest.put(Routes.applicationGuildCommands(client.application!.id, c.guildId), { body: [command] });
      log('/telinha registered');
    } catch (e) {
      log('/telinha not registered yet (bot not in guild?)', (e as Error).message);
    }
  }

  // The whole guild once per gateway session (members, roles and presences of
  // the online ones); the events below keep it current from there. A failed
  // load (fetch timeout, Discord hiccup) tries again: 30 s, 1, 2, 4... up to
  // 10 min, until one works or a new session starts over.
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
      directory.reset(all.map((m) => memberData(m, c.roleId)), all.map((m) => [m.id, m.presence?.status]));
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
    if (!i.isChatInputCommand() || i.commandName !== 'telinha') return;
    try {
      const roles = i.member?.roles;
      const hasRole = Array.isArray(roles) ? roles.includes(c.roleId) : Boolean(roles?.cache.has(c.roleId));
      const member = i.member && 'displayName' in i.member ? i.member.displayName : null;
      await handleTela({
        locale: i.locale,
        guildLocale: i.guildLocale,
        allowed: i.guildId === c.guildId && hasRole,
        guildId: i.guildId ?? '',
        channelId: i.channelId,
        channelIds: c.channelIds,
        userId: i.user.id,
        who: member ?? i.user.globalName ?? i.user.username,
        what: i.options.getString('what'),
      }, {
        registry: o.registry,
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
        newRoom: () => randomBytes(9).toString('base64url'),
        now: Date.now,
        group,
        log,
      });
    } catch (e) {
      log('tela error', (e as Error).message);
    }
  });

  void client.login(c.discordToken);
  return client;
}
