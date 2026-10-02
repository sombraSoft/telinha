// /tela: posts a fresh room link in the allowed channels. Replies only the
// caller sees use their client locale; the public post uses the guild locale.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, InteractionContextType, Locale as DLocale,
  MessageFlags, REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import { dicts, resolveLocale, t, type Locale } from './i18n.ts';

export function buildCommand() {
  return new SlashCommandBuilder()
    .setName('tela')
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
  channelId: string;
  channelIds: string[];
  who: string;
  what: string | null;
  room: string;
  publicUrl: string;
  group: (l: Locale) => string;
}

export interface TelaReply {
  content: string;
  flags?: MessageFlags.Ephemeral;
  components?: ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: { parse: [] };
}

export function telaReply(i: TelaInput): TelaReply {
  const me = resolveLocale(i.locale);
  if (!i.allowed) {
    return { content: t(me, 'onlyGroup', { group: i.group(me) }), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  }
  if (!i.channelIds.includes(i.channelId)) {
    const where = i.channelIds.map((c) => `<#${c}>`).join(t(me, 'or'));
    return { content: t(me, 'wrongChannel', { where }), flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  }
  const l = resolveLocale(i.guildLocale);
  const link = `${i.publicUrl}/sala/?room=${i.room}`;
  return {
    content: `${t(l, 'opened', { who: i.who, what: i.what ? `: ${i.what}` : '' })}\n${t(l, 'tip', { group: i.group(l) })}`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(l, 'open')).setEmoji('📺').setURL(link),
    )],
    allowedMentions: { parse: [] },
  };
}

export function startBot(o: {
  config: Config; rest: REST; group: (l: Locale) => string; log: (...a: unknown[]) => void;
}): Client {
  const { config: c, rest, group, log } = o;
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const command = buildCommand().toJSON();

  async function registerCommand() {
    try {
      await rest.put(Routes.applicationGuildCommands(client.application!.id, c.guildId), { body: [command] });
      log('/tela registered');
    } catch (e) {
      log('/tela not registered yet (bot not in guild?)', (e as Error).message);
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
    if (!i.isChatInputCommand() || i.commandName !== 'tela') return;
    try {
      const roles = i.member?.roles;
      const hasRole = Array.isArray(roles) ? roles.includes(c.roleId) : Boolean(roles?.cache.has(c.roleId));
      const member = i.member && 'displayName' in i.member ? i.member.displayName : null;
      const room = randomBytes(9).toString('base64url');
      const reply = telaReply({
        locale: i.locale,
        guildLocale: i.guildLocale,
        allowed: i.guildId === c.guildId && hasRole,
        channelId: i.channelId,
        channelIds: c.channelIds,
        who: member ?? i.user.globalName ?? i.user.username,
        what: i.options.getString('what'),
        room,
        publicUrl: c.publicUrl,
        group,
      });
      await i.reply(reply);
      if (!reply.flags) log('tela', i.user.id, room);
    } catch (e) {
      log('tela error', (e as Error).message);
    }
  });

  void client.login(c.discordToken);
  return client;
}
