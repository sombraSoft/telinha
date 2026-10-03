// /telinha: opens a room and posts its live status card in the allowed channels.
// Replies only the caller sees use their client locale; the card uses the
// guild locale.
import {
  Client, GatewayIntentBits, InteractionContextType, Locale as DLocale, MessageFlags, REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import type { Card } from './card.ts';
import type { Config } from './config.ts';
import { dicts, resolveLocale, t, type Locale } from './i18n.ts';
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
}): Client {
  const { config: c, rest, group, log } = o;
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const command = buildCommand().toJSON();

  async function registerCommand() {
    try {
      await rest.put(Routes.applicationGuildCommands(client.application!.id, c.guildId), { body: [command] });
      log('/telinha registered');
    } catch (e) {
      log('/telinha not registered yet (bot not in guild?)', (e as Error).message);
    }
  }

  client.once('clientReady', () => {
    log(`logged in as ${client.user?.tag}`);
    void registerCommand();
  });
  client.on('guildCreate', (g) => {
    if (g.id === c.guildId) void registerCommand();
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
