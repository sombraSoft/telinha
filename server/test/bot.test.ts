import { describe, expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import { buildCommand, handleTela, telaDenied, type TelaDeps, type TelaInput, type TelaPayload } from '../src/bot.ts';
import { renderCard, type Card } from '../src/card.ts';
import type { Locale } from '../src/i18n.ts';
import { openRegistry } from '../src/rooms.ts';

const NOW = 1_700_000_000_000;
const group = (l: Locale) => (l === 'pt-BR' ? 'Galera' : 'Crew');

const base: TelaInput = {
  locale: 'en-US', guildLocale: 'pt-BR', allowed: true, guildId: '100', channelId: '300', channelIds: ['300', '301'],
  userId: '7', who: 'Zé', what: 'Elden Ring',
};

function setup(o: { ensureFails?: boolean; replyFails?: boolean } = {}) {
  const registry = openRegistry(':memory:');
  const calls: string[] = [];
  const replies: TelaPayload[] = [];
  const deps: TelaDeps = {
    registry,
    rooms: {
      ensureRoom: async (room) => {
        calls.push(`ensureRoom ${room}`);
        if (o.ensureFails) throw new Error('livekit down');
      },
      deleteRoom: async (room) => void calls.push(`deleteRoom ${room}`),
    },
    render: (rec) => renderCard(rec, { streamers: [], viewers: [] }, { publicUrl: 'https://tela.example.com', group: group(rec.locale) }),
    reply: async (p) => {
      calls.push(p.flags ? 'reply ephemeral' : 'reply card');
      if (o.replyFails && !p.flags) throw new Error('Unknown interaction');
      replies.push(p);
      return p.flags ? null : { channelId: '300', messageId: '999' };
    },
    newRoom: () => 'abcdefghijkl',
    now: () => NOW,
    group,
    log: () => {},
  };
  return { deps, registry, calls, replies };
}

test('command: English base with pt-BR localizations', () => {
  const c = buildCommand().toJSON();
  expect(c.name).toBe('telinha');
  expect(c.description_localizations?.['pt-BR']).toBe('Abre uma telinha pra compartilhar a tela');
  const [opt] = c.options as Array<{ name: string; name_localizations?: Record<string, string>; max_length?: number; required?: boolean; description_localizations?: Record<string, string> }>;
  expect(opt!.name).toBe('what');
  expect(opt!.name_localizations?.['pt-BR']).toBe('o_que');
  expect(opt!.description_localizations?.['pt-BR']).toContain('O que vai passar');
  expect(opt!.max_length).toBe(80);
  expect(opt!.required).toBeFalsy();
});

describe('telaDenied', () => {
  test('not allowed: ephemeral in the caller locale', () => {
    const en = telaDenied({ ...base, allowed: false }, group)!;
    expect(en.flags).toBe(MessageFlags.Ephemeral);
    expect(en.content).toBe('Telinha is only for Crew.');
    const pt = telaDenied({ ...base, allowed: false, locale: 'pt-BR' }, group)!;
    expect(pt.content).toBe('A Telinha é só pra Galera.');
    expect(pt.allowedMentions).toEqual({ parse: [] });
  });

  test('wrong channel: lists allowed channels in the caller locale', () => {
    expect(telaDenied({ ...base, channelId: '999' }, group)!.content).toBe('Use /telinha in <#300> or <#301>.');
    const pt = telaDenied({ ...base, channelId: '999', locale: 'pt-BR' }, group)!;
    expect(pt.content).toBe('Usa o /telinha no <#300> ou <#301>.');
    expect(pt.flags).toBe(MessageFlags.Ephemeral);
  });

  test('allowed in the right channel -> null', () => {
    expect(telaDenied(base, group)).toBeNull();
  });
});

describe('handleTela', () => {
  test('registers, creates the LiveKit room, posts the card, stores the message', async () => {
    const s = setup();
    await handleTela(base, s.deps);
    expect(s.calls).toEqual(['ensureRoom abcdefghijkl', 'reply card']);
    expect(s.registry.get('abcdefghijkl')).toMatchObject({
      guildId: '100', channelId: '300', messageId: '999', locale: 'pt-BR', openerId: '7', openerName: 'Zé',
      what: 'Elden Ring', createdAt: NOW, closedAt: null,
    });
    const card = s.replies[0]!;
    expect(card.flags).toBeUndefined();
    expect(card.allowedMentions).toEqual({ parse: [] });
    // the guild locale, not the caller's
    expect(card.content).toStartWith('📺 **Zé** abriu uma telinha: Elden Ring\n⏱️ Aberta <t:1700000000:R>\n');
    expect(card.content).toContain('Só Galera entram');
    expect(card.content).toContain('aba **Janela**');
    const btn = (card as Card).components[0]!.components[0]!;
    expect(btn.url).toBe('https://tela.example.com/sala/?room=abcdefghijkl');
    expect(btn.label).toBe('Abrir telinha');
  });

  test('en guild, no "what"', async () => {
    const s = setup();
    await handleTela({ ...base, guildLocale: 'en-US', what: null }, s.deps);
    expect(s.replies[0]!.content).toStartWith('📺 **Zé** opened a Telinha\n');
    expect(s.replies[0]!.content).toContain('Only Crew can join');
    expect(s.registry.get('abcdefghijkl')!.locale).toBe('en');
  });

  test('denied: ephemeral only, no room', async () => {
    const s = setup();
    await handleTela({ ...base, allowed: false }, s.deps);
    expect(s.calls).toEqual(['reply ephemeral']);
    expect(s.registry.open()).toEqual([]);
  });

  test('LiveKit failure: room closed, ephemeral error in the caller locale', async () => {
    const s = setup({ ensureFails: true });
    await handleTela({ ...base, locale: 'pt-BR' }, s.deps);
    expect(s.calls).toEqual(['ensureRoom abcdefghijkl', 'deleteRoom abcdefghijkl', 'reply ephemeral']);
    expect(s.registry.get('abcdefghijkl')!.closedAt).toBe(NOW);
    expect(s.replies[0]!.content).toBe('Não deu pra abrir a telinha agora. Tenta de novo daqui a pouco.');
    expect(s.replies[0]!.flags).toBe(MessageFlags.Ephemeral);
  });

  test('reply failure: room closed and LiveKit room deleted', async () => {
    const s = setup({ replyFails: true });
    await handleTela(base, s.deps);
    expect(s.calls).toEqual(['ensureRoom abcdefghijkl', 'reply card', 'deleteRoom abcdefghijkl', 'reply ephemeral']);
    expect(s.registry.get('abcdefghijkl')).toMatchObject({ closedAt: NOW, messageId: null });
    expect(s.replies[0]!.content).toBe('Could not open a Telinha right now. Try again in a moment.');
  });

  test('user text is not interpolated', async () => {
    const s = setup();
    await handleTela({ ...base, who: '{group}', what: '{what}' }, s.deps);
    expect(s.replies[0]!.content).toStartWith('📺 **{group}** abriu uma telinha: {what}\n');
  });
});
