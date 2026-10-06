import { describe, expect, test } from 'bun:test';
import { defineStrings, dicts, localeFromTag, pickLocale, ts } from '../src/cli/strings.ts';

describe('ts', () => {
  test('substitutes params once and falls back to the key text', () => {
    expect(ts('en', 'alreadyRunning', { pid: 42 })).toBe('Telinha is already running (pid 42). Use: telinha service status | telinha service stop');
    expect(ts('pt-BR', 'noConfig', { path: '{path}' })).toBe('Ainda não tem configuração ({path}).');
    expect(ts('en', 'argNeedsValue')).toBe('{flag} needs a value');
  });

  test('pt-BR keeps every placeholder of en', () => {
    for (const [k, v] of Object.entries(dicts.en)) {
      const want = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const got = [...dicts['pt-BR'][k as keyof typeof dicts.en].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(`${k}: ${got.join(',')}`).toBe(`${k}: ${want.join(',')}`);
    }
  });

  test('help lists every command and never says "phase"', () => {
    for (const l of ['en', 'pt-BR'] as const) {
      const help = ts(l, 'help');
      for (const cmd of ['run', 'setup', 'doctor', 'update', 'service', '--lang', '--home', '--yes', '--version', '--help']) expect(help).toContain(cmd);
      for (const v of Object.values(dicts[l])) expect(v.toLowerCase()).not.toMatch(/\bphase\b|\bfase\b/);
    }
  });
});

describe('defineStrings', () => {
  test('a scoped dictionary with the same rules', () => {
    const t = defineStrings({ hi: 'Hi {name}', bye: 'Bye' }, { hi: 'Oi {name}', bye: 'Tchau' });
    expect(t('en', 'hi', { name: 'Ana' })).toBe('Hi Ana');
    expect(t('pt-BR', 'hi', { name: '{x}' })).toBe('Oi {x}');
    expect(t('pt-BR', 'bye')).toBe('Tchau');
  });
});

describe('pickLocale', () => {
  const intl = (tag: string) => () => tag;
  test('--lang wins, then LOCALE, then LC_ALL/LC_MESSAGES/LANG, then Intl', () => {
    expect(pickLocale({ LOCALE: 'en' }, 'pt-BR', intl('en-US'))).toBe('pt-BR');
    expect(pickLocale({ LOCALE: 'pt-BR', LANG: 'en_US.UTF-8' }, undefined, intl('en-US'))).toBe('pt-BR');
    expect(pickLocale({ LC_ALL: 'pt_BR.UTF-8', LANG: 'en_US.UTF-8' }, undefined, intl('en-US'))).toBe('pt-BR');
    expect(pickLocale({ LC_MESSAGES: 'en_GB.UTF-8' }, undefined, intl('pt-BR'))).toBe('en');
    expect(pickLocale({ LANG: 'pt_PT.UTF-8' }, undefined, intl('en-US'))).toBe('pt-BR');
    expect(pickLocale({}, undefined, intl('pt-BR'))).toBe('pt-BR');
    expect(pickLocale({}, undefined, intl('de-DE'))).toBe('en');
  });

  test('C and POSIX locales defer to the OS language', () => {
    expect(pickLocale({ LANG: 'C.UTF-8' }, undefined, intl('pt-BR'))).toBe('pt-BR');
    expect(pickLocale({ LC_ALL: 'POSIX' }, undefined, intl('pt-BR'))).toBe('pt-BR');
  });

  test('a broken Intl falls back to en', () => {
    expect(pickLocale({}, undefined, () => {
      throw new Error('no ICU');
    })).toBe('en');
  });

  test('localeFromTag', () => {
    expect(localeFromTag('pt_BR.UTF-8')).toBe('pt-BR');
    expect(localeFromTag('PT')).toBe('pt-BR');
    expect(localeFromTag('en-US')).toBe('en');
    expect(localeFromTag(undefined)).toBe('en');
  });
});
