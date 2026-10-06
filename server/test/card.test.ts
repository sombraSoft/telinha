import { describe, expect, test } from 'bun:test';
import { formatDuration, MAX_CONTENT, renderCard, type Live } from '../src/card.ts';
import type { RoomRecord } from '../src/rooms.ts';

const REC: RoomRecord = {
  room: 'lamo-futi', guildId: '100', channelId: '300', messageId: '999', locale: 'pt-BR',
  openerId: '7', openerName: 'Zé', what: 'Elden Ring', createdAt: 1_700_000_000_123,
  firstJoinAt: null, lastSeenAt: null, lastTokenAt: null, closedAt: null, cardDone: false, seen: [], streamed: [],
};
const OPTS = { publicUrl: 'https://tela.example.com', group: 'Galera' };
const NOBODY: Live = { streamers: [], viewers: [] };

type Button = { type: number; style: number; label: string; url: string; emoji: { name: string } };
const buttons = (c: ReturnType<typeof renderCard>) => c.components.flatMap((r) => r.components as Button[]);

describe('open card', () => {
  test('pt-BR, nobody yet: title, timer, tip and the link button', () => {
    const c = renderCard(REC, NOBODY, OPTS);
    expect(c.content).toBe([
      '📺 **Zé** abriu uma telinha: Elden Ring',
      '⏱️ Aberta <t:1700000000:R>',
      '-# Só Galera entram (login com Discord). Pra transmitir com som do jogo: Google Chrome → aba **Janela** → escolhe o jogo e marca o áudio do app (só o jogo, sem o Discord).',
    ].join('\n'));
    expect(c.allowedMentions).toEqual({ parse: [] });
    const [b] = buttons(c);
    expect(b).toMatchObject({ type: 2, style: 5, label: 'Abrir telinha', url: 'https://tela.example.com/r/lamo-futi' });
    expect(b!.emoji).toEqual({ name: '📺' });
  });

  test('streamers with quality, viewers, en, no what', () => {
    const c = renderCard({ ...REC, locale: 'en', what: null }, {
      streamers: [{ id: '1', quality: '1080p60 · H265' }, { id: '2' }],
      viewers: ['3', '4'],
    }, { ...OPTS, group: 'Crew' });
    expect(c.content.split('\n')).toEqual([
      '📺 **Zé** opened a Telinha',
      '🔴 Streaming: <@1> (1080p60 · H265), <@2>',
      '👀 Watching: <@3>, <@4>',
      '⏱️ Opened <t:1700000000:R>',
      expect.stringContaining('Only Crew can join') as unknown as string,
    ]);
    expect(buttons(c)[0]!.label).toBe('Open Telinha');
  });

  test('user text is not interpolated', () => {
    const c = renderCard({ ...REC, openerName: '{group}', what: '{what}' }, NOBODY, OPTS);
    expect(c.content).toStartWith('📺 **{group}** abriu uma telinha: {what}\n');
  });

  test('member-typed text renders as plain text (no markdown, links or tags)', () => {
    const rec = { ...REC, openerName: 'a_b**c**', what: '[Abrir telinha](https://evil.example) <@&5> `x`' };
    const open = renderCard(rec, NOBODY, OPTS).content.split('\n')[0];
    // (the emoji stays out of String.raw: Bun's transpiler turns it into "\u{...}" there)
    expect(open).toBe('📺 ' + String.raw`**a\_b\*\*c\*\*** abriu uma telinha: \[Abrir telinha](https://evil.example) \<@&5> \`x\``);
    const closed = renderCard({ ...rec, closedAt: REC.createdAt }, NOBODY, OPTS).content.split('\n')[0];
    expect(closed).toContain(String.raw`**a\_b\*\*c\*\***`);
    expect(closed).toContain(String.raw`\<@&5>`);
  });

  test('long lists are cut with +N and the content stays within the limit', () => {
    const many = Array.from({ length: 200 }, (_, i) => String(100000000000000000n + BigInt(i)));
    const c = renderCard(REC, { streamers: many.slice(0, 50).map((id) => ({ id, quality: '1440p60 · AV1' })), viewers: many.slice(50) }, OPTS);
    expect(c.content.length).toBeLessThanOrEqual(MAX_CONTENT);
    const lines = c.content.split('\n');
    expect(lines[1]).toMatch(/^🔴 Transmitindo: <@\d+> \(1440p60 · AV1\).* \+\d+$/);
    expect(lines[2]).toMatch(/^👀 Assistindo: <@\d+>.* \+\d+$/);
    // every id is either shown or counted
    const shown = (l: string) => (l.match(/<@\d+>/g) ?? []).length + Number(/\+(\d+)$/.exec(l)?.[1] ?? 0);
    expect(shown(lines[1]!)).toBe(50);
    expect(shown(lines[2]!)).toBe(150);
    expect(lines.at(-1)).toStartWith('-# ');
  });
});

describe('closed card', () => {
  const closed: RoomRecord = {
    ...REC, firstJoinAt: REC.createdAt + 60_000, lastSeenAt: REC.createdAt + 60_000 + 72 * 60_000,
    closedAt: REC.createdAt + 80 * 60_000, seen: ['1', '2', '3'],
  };

  test('pt-BR: summary, everyone who came, no button', () => {
    const c = renderCard(closed, NOBODY, OPTS);
    expect(c.content).toBe([
      '📺 Telinha de **Zé** encerrada: Elden Ring',
      '⏱️ Durou 1h 12min',
      '👥 Passaram por aqui: <@1>, <@2>, <@3>',
    ].join('\n'));
    expect(c.components).toEqual([]);
    expect(c.allowedMentions).toEqual({ parse: [] });
  });

  test('en; nobody ever joined', () => {
    const c = renderCard({ ...REC, locale: 'en', what: null, closedAt: REC.createdAt + 300_000 }, NOBODY, OPTS);
    expect(c.content).toBe('📺 Telinha by **Zé** ended\n⏱️ Nobody joined');
    expect(c.components).toEqual([]);
  });

  test('a huge guest list is cut', () => {
    const seen = Array.from({ length: 300 }, (_, i) => String(200000000000000000n + BigInt(i)));
    const c = renderCard({ ...closed, seen }, NOBODY, OPTS);
    expect(c.content.length).toBeLessThanOrEqual(MAX_CONTENT);
    expect(c.content).toMatch(/ \+\d+$/);
  });
});

test('formatDuration', () => {
  expect(formatDuration('pt-BR', 0)).toBe('menos de 1 min');
  expect(formatDuration('pt-BR', 59_999)).toBe('menos de 1 min');
  expect(formatDuration('pt-BR', 8 * 60_000 + 30_000)).toBe('8 min');
  expect(formatDuration('en', 59 * 60_000)).toBe('59 min');
  expect(formatDuration('en', 60 * 60_000)).toBe('1h');
  expect(formatDuration('en', 72 * 60_000)).toBe('1h 12min');
  expect(formatDuration('en', 25 * 3600_000 + 60_000)).toBe('25h 1min');
});
