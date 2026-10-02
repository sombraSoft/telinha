import { expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import { buildCommand, telaReply, type TelaInput } from '../src/bot.ts';
import type { Locale } from '../src/i18n.ts';

const base: TelaInput = {
  locale: 'en-US', guildLocale: 'pt-BR', allowed: true, channelId: '300', channelIds: ['300', '301'],
  who: 'Zé', what: 'Elden Ring', room: 'abcdefghijkl', publicUrl: 'https://tela.example.com',
  group: (l: Locale) => (l === 'pt-BR' ? 'Galera' : 'Crew'),
};

test('command: English base with pt-BR localizations', () => {
  const c = buildCommand().toJSON();
  expect(c.name).toBe('tela');
  expect(c.description_localizations?.['pt-BR']).toBe('Abre uma telinha pra compartilhar a tela');
  const [opt] = c.options as Array<{ name: string; name_localizations?: Record<string, string>; max_length?: number; required?: boolean; description_localizations?: Record<string, string> }>;
  expect(opt!.name).toBe('what');
  expect(opt!.name_localizations?.['pt-BR']).toBe('o_que');
  expect(opt!.description_localizations?.['pt-BR']).toContain('O que vai passar');
  expect(opt!.max_length).toBe(80);
  expect(opt!.required).toBeFalsy();
});

test('not allowed: ephemeral in the caller locale', () => {
  const en = telaReply({ ...base, allowed: false });
  expect(en.flags).toBe(MessageFlags.Ephemeral);
  expect(en.content).toBe('Telinha is only for Crew.');
  const pt = telaReply({ ...base, allowed: false, locale: 'pt-BR', guildLocale: 'en-US' });
  expect(pt.content).toBe('A Telinha é só pra Galera.');
  expect(pt.components).toBeUndefined();
});

test('wrong channel: lists allowed channels in the caller locale', () => {
  expect(telaReply({ ...base, channelId: '999' }).content).toBe('Use /tela in <#300> or <#301>.');
  const pt = telaReply({ ...base, channelId: '999', locale: 'pt-BR' });
  expect(pt.content).toBe('Usa o /tela no <#300> ou <#301>.');
  expect(pt.flags).toBe(MessageFlags.Ephemeral);
});

test('public post uses the guild locale, link button, no mentions', () => {
  const r = telaReply(base);
  expect(r.flags).toBeUndefined();
  expect(r.allowedMentions).toEqual({ parse: [] });
  expect(r.content).toStartWith('📺 **Zé** abriu uma telinha: Elden Ring\n');
  expect(r.content).toContain('Só Galera entram');
  expect(r.content).toContain('aba **Janela**');
  const row = r.components![0]!.toJSON() as { components: Array<{ url: string; label: string; style: number }> };
  expect(row.components[0]!.url).toBe('https://tela.example.com/sala/?room=abcdefghijkl');
  expect(row.components[0]!.label).toBe('Abrir telinha');

  const en = telaReply({ ...base, guildLocale: 'en-US', what: null });
  expect(en.content).toStartWith('📺 **Zé** opened a Telinha\n');
  expect(en.content).toContain('Only Crew can join');
  expect(en.content).toContain('**Window** tab');
});

test('user text is not interpolated', () => {
  const r = telaReply({ ...base, who: '{group}', what: '{what}' });
  expect(r.content).toStartWith('📺 **{group}** abriu uma telinha: {what}\n');
});
