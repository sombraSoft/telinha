import { describe, expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import {
  buildCommand,
  type CommandDeps,
  type CommandInput,
  type CommandPayload,
  commandDenied,
  defaultGroupName,
  handleCommand,
} from '../src/bot.ts';
import { type Card, renderCard } from '../src/card.ts';
import type { Locale } from '../src/i18n.ts';
import { createRooms } from '../src/rooms.ts';

const NOW = 1_700_000_000_000;
const group = (l: Locale) => (l === 'pt-BR' ? 'Galera' : 'Crew');

const base: CommandInput = {
  locale: 'en-US',
  guildLocale: 'pt-BR',
  allowed: true,
  command: 'tela',
  guildId: '100',
  channelId: '300',
  channelIds: ['300', '301'],
  userId: '7',
  who: 'Zé',
  what: 'Elden Ring',
};

// The real Room module on :memory: with a fake LiveKit (rooms.test.ts covers open itself).
function setup(o: { ensureFails?: boolean; replyFails?: boolean } = {}) {
  const calls: string[] = [];
  const replies: CommandPayload[] = [];
  const logs: unknown[][] = [];
  const rooms = createRooms({
    path: ':memory:',
    livekit: {
      ensureRoom: async (room) => {
        calls.push(`ensureRoom ${room}`);
        if (o.ensureFails) throw new Error('livekit down');
      },
      deleteRoom: async (room) => void calls.push(`deleteRoom ${room}`),
      listParticipants: async () => [],
    },
    closeEmptySeconds: 300,
    now: () => NOW,
  });
  const deps: CommandDeps = {
    rooms,
    render: (rec) =>
      renderCard(
        rec,
        { streamers: [], viewers: [] },
        { publicUrl: 'https://tela.example.com', group: group(rec.locale) },
      ),
    reply: async (p) => {
      calls.push(p.flags ? 'reply ephemeral' : 'reply card');
      if (o.replyFails && !p.flags) throw new Error('Unknown interaction');
      replies.push(p);
      return p.flags ? null : { channelId: '300', messageId: '999' };
    },
    newRoom: () => 'lamo-futi',
    group,
    log: (...a) => void logs.push(a),
  };
  return { deps, rooms, calls, replies, logs };
}

test('command: configured name, English base with pt-BR localizations', () => {
  const c = buildCommand('tela').toJSON();
  expect(c.name).toBe('tela');
  expect(c.description_localizations?.['pt-BR']).toBe('Abre uma telinha pra compartilhar a tela');
  const [opt] = c.options as Array<{
    name: string;
    name_localizations?: Record<string, string>;
    max_length?: number;
    required?: boolean;
    description_localizations?: Record<string, string>;
  }>;
  expect(opt!.name).toBe('what');
  expect(opt!.name_localizations?.['pt-BR']).toBe('o_que');
  expect(opt!.description_localizations?.['pt-BR']).toContain('O que vai passar');
  expect(opt!.max_length).toBe(80);
  expect(opt!.required).toBeFalsy();
});

describe('commandDenied', () => {
  test('not allowed: ephemeral in the caller locale', () => {
    const en = commandDenied({ ...base, allowed: false }, group)!;
    expect(en.flags).toBe(MessageFlags.Ephemeral);
    expect(en.content).toBe('Telinha is only for Crew.');
    const pt = commandDenied({ ...base, allowed: false, locale: 'pt-BR' }, group)!;
    expect(pt.content).toBe('A Telinha é só pra Galera.');
    expect(pt.allowedMentions).toEqual({ parse: [] });
  });

  test('wrong channel: lists allowed channels in the caller locale', () => {
    expect(commandDenied({ ...base, channelId: '999' }, group)!.content).toBe('Use /tela in <#300> or <#301>.');
    const pt = commandDenied({ ...base, channelId: '999', locale: 'pt-BR', command: 'telinha' }, group)!;
    expect(pt.content).toBe('Usa o /telinha no <#300> ou <#301>.');
    expect(pt.flags).toBe(MessageFlags.Ephemeral);
  });

  test('allowed in the right channel -> null', () => {
    expect(commandDenied(base, group)).toBeNull();
  });
});

describe('handleCommand', () => {
  test('registers, creates the LiveKit room, posts the card, stores the message', async () => {
    const s = setup();
    await handleCommand(base, s.deps);
    expect(s.calls).toEqual(['ensureRoom lamo-futi', 'reply card']);
    expect(s.logs).toEqual([['tela', '7', 'lamo-futi']]);
    expect(s.rooms.get('lamo-futi')).toMatchObject({
      guildId: '100',
      channelId: '300',
      messageId: '999',
      locale: 'pt-BR',
      openerId: '7',
      openerName: 'Zé',
      what: 'Elden Ring',
      createdAt: NOW,
      closedAt: null,
    });
    const card = s.replies[0]!;
    expect(card.flags).toBeUndefined();
    expect(card.allowedMentions).toEqual({ parse: [] });
    // the guild locale, not the caller's
    expect(card.content).toStartWith('📺 **Zé** abriu uma telinha: Elden Ring\n⏱️ Aberta <t:1700000000:R>\n');
    expect(card.content).toContain('Só Galera entram');
    expect(card.content).toContain('aba **Janela**');
    const btn = (card as Card).components[0]!.components[0]!;
    expect(btn.url).toBe('https://tela.example.com/r/lamo-futi');
    expect(btn.label).toBe('Abrir telinha');
  });

  test('en guild, no "what"', async () => {
    const s = setup();
    await handleCommand({ ...base, guildLocale: 'en-US', what: null }, s.deps);
    expect(s.replies[0]!.content).toStartWith('📺 **Zé** opened a Telinha\n');
    expect(s.replies[0]!.content).toContain('Only Crew can join');
    expect(s.rooms.get('lamo-futi')!.locale).toBe('en');
  });

  test('denied: ephemeral only, no room', async () => {
    const s = setup();
    await handleCommand({ ...base, allowed: false }, s.deps);
    expect(s.calls).toEqual(['reply ephemeral']);
    expect(s.rooms.openRooms()).toEqual([]);
  });

  test('LiveKit failure: no open room, ephemeral error in the caller locale', async () => {
    const s = setup({ ensureFails: true });
    await handleCommand({ ...base, locale: 'pt-BR' }, s.deps);
    expect(s.calls).toEqual(['ensureRoom lamo-futi', 'deleteRoom lamo-futi', 'reply ephemeral']);
    expect(s.rooms.openRooms()).toEqual([]);
    expect(s.logs).toEqual([['tela failed', 'lamo-futi', 'livekit down']]);
    expect(s.replies[0]!.content).toBe('Não deu pra abrir a telinha agora. Tenta de novo daqui a pouco.');
    expect(s.replies[0]!.flags).toBe(MessageFlags.Ephemeral);
  });

  test('reply failure: no open room, ephemeral error', async () => {
    const s = setup({ replyFails: true });
    await handleCommand(base, s.deps);
    expect(s.calls).toEqual(['ensureRoom lamo-futi', 'reply card', 'deleteRoom lamo-futi', 'reply ephemeral']);
    expect(s.rooms.openRooms()).toEqual([]);
    expect(s.replies[0]!.content).toBe('Could not open a Telinha right now. Try again in a moment.');
  });

  test('user text is not interpolated', async () => {
    const s = setup();
    await handleCommand({ ...base, who: '{group}', what: '{what}' }, s.deps);
    expect(s.replies[0]!.content).toStartWith('📺 **{group}** abriu uma telinha: {what}\n');
  });
});

describe('defaultGroupName', () => {
  const guild = { id: '100', name: 'Galera', roles: { cache: new Map([['200', { name: 'amigos' }]]) } };

  test("the gate role's name", () => {
    expect(defaultGroupName(guild, '200')).toBe('amigos');
  });

  test("@everyone (the guild's id): the Discord server's name", () => {
    expect(defaultGroupName(guild, '100')).toBe('Galera');
  });

  test("a role not in the cache: the Discord server's name", () => {
    expect(defaultGroupName(guild, '999')).toBe('Galera');
  });

  test('guild not seen yet: undefined', () => {
    expect(defaultGroupName(undefined, '200')).toBeUndefined();
  });
});
