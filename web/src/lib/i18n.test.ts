import { describe, expect, test } from 'bun:test';
import { commandName, dictionaries, format, resolveLocale } from './i18n';
import { en } from './i18n/en';
import { ptBR } from './i18n/pt-BR';

describe('resolveLocale', () => {
  test('Portuguese tags -> pt-BR', () => {
    for (const tag of ['pt-BR', 'pt', 'pt-PT', 'PT-br']) expect(resolveLocale(tag)).toBe('pt-BR');
  });
  test('everything else -> en', () => {
    for (const tag of ['en-US', 'en', 'es-ES', 'de', '', undefined, null]) expect(resolveLocale(tag)).toBe('en');
  });
});

describe('dictionaries', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  test('pt-BR has exactly the en keys', () => {
    expect(Object.keys(ptBR).sort()).toEqual(Object.keys(en).sort());
  });
  test('no empty strings and the same placeholders', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].length).toBeGreaterThan(0);
      expect(ptBR[key].length).toBeGreaterThan(0);
      expect(placeholders(ptBR[key])).toEqual(placeholders(en[key]));
    }
  });
  test('pt-BR keeps the chosen wording', () => {
    // The dock button names the action; the modal's confirm keeps the old word.
    expect(ptBR['share.start']).toBe('Compartilhar tela');
    expect(ptBR['share.goLive']).toBe('Transmitir');
    expect(ptBR['share.stop']).toBe('Parar transmissão');
    expect(ptBR['empty.title']).toBe('Ninguém transmitindo ainda.');
    expect(ptBR['top.copyLink']).toBe('Copiar link');
    expect(ptBR['tile.live']).toBe('AO VIVO');
    expect(ptBR['people.idle']).toBe('na sala');
  });
  test('both locales are registered', () => {
    expect(dictionaries['pt-BR']).toBe(ptBR);
    expect(dictionaries.en).toBe(en);
  });
});

describe('format', () => {
  test('interpolates {name} params', () => {
    expect(format('en', 'top.room', { name: 'abc' })).toBe('room abc');
    expect(format('pt-BR', 'share.applied', { res: '720p', fps: 30 })).toBe('Agora: 720p 30 fps');
  });
  test('leaves unknown placeholders alone', () => {
    expect(format('en', 'empty.hint')).toBe('Click {share} to start.');
    expect(format('en', 'tile.volume', {})).toBe('Volume of {name}');
  });
});

describe('command name', () => {
  test('defaults to telinha without the meta (no DOM here)', () => {
    expect(commandName).toBe('telinha');
  });
  test('room notices name the configured command in both locales', () => {
    expect(format('en', 'notice.noRoom', { cmd: 'tela' })).toBe('Open a Telinha with /tela on Discord.');
    expect(format('en', 'notice.unknown', { cmd: 'tela' })).toBe('This Telinha does not exist. Open one with /tela on Discord.');
    expect(format('en', 'notice.closed', { cmd: 'tela' })).toBe('This Telinha has ended. Open another with /tela on Discord.');
    expect(format('pt-BR', 'notice.noRoom', { cmd: 'tela' })).toBe('Abra uma telinha com /tela no Discord.');
    expect(format('pt-BR', 'notice.unknown', { cmd: 'tela' })).toBe('Essa telinha não existe. Abra uma com /tela no Discord.');
    expect(format('pt-BR', 'notice.closed', { cmd: 'tela' })).toBe('Essa telinha foi encerrada. Abra outra com /tela no Discord.');
  });
});
