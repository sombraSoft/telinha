import { expect, test } from 'bun:test';
import { dicts, fromAcceptLanguage, resolveLocale, t } from '../src/i18n.ts';

test('resolveLocale', () => {
  for (const tag of ['pt-BR', 'pt', 'PT-pt', 'pt_BR']) expect(resolveLocale(tag)).toBe('pt-BR');
  for (const tag of ['en-US', 'en', 'es-ES', 'de', '', undefined, null]) expect(resolveLocale(tag)).toBe('en');
});

test('Accept-Language picks the highest-q supported entry', () => {
  expect(fromAcceptLanguage('pt-BR,pt;q=0.9,en-US;q=0.8')).toBe('pt-BR');
  expect(fromAcceptLanguage('en-US,en;q=0.9,pt-BR;q=0.8')).toBe('en');
  expect(fromAcceptLanguage('de-DE,pt;q=0.5,en;q=0.4')).toBe('pt-BR');
  expect(fromAcceptLanguage('fr;q=1, en;q=0.2, pt-BR;q=0.7')).toBe('pt-BR');
  expect(fromAcceptLanguage('de, fr')).toBe('en');
  expect(fromAcceptLanguage('pt;q=0, en;q=0.1')).toBe('en');
  expect(fromAcceptLanguage('')).toBe('en');
  expect(fromAcceptLanguage(null)).toBe('en');
});

test('dictionaries have the same keys and no empty strings', () => {
  expect(Object.keys(dicts['pt-BR']).sort()).toEqual(Object.keys(dicts.en).sort());
  for (const d of Object.values(dicts)) for (const v of Object.values(d)) expect(v.length).toBeGreaterThan(0);
});

test('t interpolates once (params are not re-expanded)', () => {
  expect(t('pt-BR', 'onlyGroup', { group: 'Galera' })).toBe('A Telinha é só pra Galera.');
  expect(t('en', 'denied', { name: '{group}', group: 'Crew' })).toBe('{group}, Telinha is only for Crew.');
  expect(t('en', 'onlyGroup')).toBe('Telinha is only for {group}.');
});
