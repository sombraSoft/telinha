import { describe, expect, test } from 'bun:test';
import { defineStrings, dicts, localeFromTag, pickLocale, ts } from '../src/cli/strings.ts';
import { at as applyStrings } from '../src/cli/setup/apply-strings.ts';
import { t as setupStrings } from '../src/cli/setup/strings.ts';

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

  test('setup help names the non-interactive home rules', () => {
    for (const l of ['en', 'pt-BR'] as const) {
      const help = ts(l, 'helpSetup');
      for (const flag of ['--non-interactive', '--host home|vps', '--duckdns-domain', '--advanced', '80/443']) expect(help).toContain(flag);
    }
  });

  test('setup and doctor help say what a terminal shows', () => {
    expect(ts('en', 'helpSetup')).toContain('On a terminal it opens the setup screens: arrows and Enter answer, Esc goes back, Tab jumps to a step, then Review and Install.');
    expect(ts('pt-BR', 'helpSetup')).toContain('Num terminal ele abre as telas de configuração: setas e Enter respondem, Esc volta, Tab pula pra uma etapa, depois Revisão e Instalação.');
    expect(ts('en', 'helpDoctor')).toContain('On a terminal the results are an interactive checklist: Enter shows how to fix a row, r runs the checks again.');
    expect(ts('pt-BR', 'helpDoctor')).toContain('Num terminal o resultado é uma lista interativa: Enter mostra como corrigir uma linha, r roda as verificações de novo.');
  });

  test('the prompt texts left with the prompts', () => {
    for (const k of ['needsInput', 'yesNo', 'answerYesNo', 'pickAtLeast', 'selectHint', 'multiHint', 'keepCurrent']) expect(Object.keys(dicts.en)).not.toContain(k);
    for (const k of ['welcome', 'hostingQ', 'cfDomainQ', 'reviewQ', 'sysctlQ', 'autoUpdateQ']) expect(Object.keys(setupStrings.en)).not.toContain(k);
  });
});

describe('setup strings', () => {
  // The questions' texts (qstrings.ts) are tested next to the setup model.
  for (const [name, dict] of [['install lines', setupStrings], ['task list', applyStrings]] as const) {
    test(`${name}: pt-BR keeps every key and placeholder of en; nothing says "phase" or tells a home to open 80/443`, () => {
      const en = dict.en as Record<string, string>;
      const pt = dict.ptBR as Record<string, string>;
      expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(en)) {
        const want = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        const got = [...pt[k]!.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(`${k}: ${got.join(',')}`).toBe(`${k}: ${want.join(',')}`);
      }
      for (const d of [en, pt]) {
        for (const v of Object.values(d)) expect(v.toLowerCase()).not.toMatch(/\bphase\b|\bfase\b/);
        // The old ports question and the 443 -> 8443 router rewrite are gone.
        expect(Object.values(d).join('\n')).not.toMatch(/reach this machine\?|chegam nesta máquina\?|Switch to port 8443|Mudar pra porta 8443|open (ports )?80|abra a 80/);
      }
    });
  }
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
