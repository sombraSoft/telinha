import { describe, expect, test } from 'bun:test';
import { dictionaries, format, resolveLocale } from './i18n';
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
  test('pt-BR keeps the 0.1.1 wording', () => {
    expect(ptBR['share.start']).toBe('Transmitir');
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
    expect(format('en', 'empty.hint')).toBe('Click {share} to share your screen.');
    expect(format('en', 'tile.volume', {})).toBe('Volume of {name}');
  });
});
