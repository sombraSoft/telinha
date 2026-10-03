import { describe, expect, test } from 'bun:test';
import { THEMES, THEME_CHOICES, parseThemeChoice, resolveTheme } from './theme';

describe('theme', () => {
  test('explicit themes win over the OS', () => {
    for (const th of THEMES) {
      expect(resolveTheme(th, true)).toBe(th);
      expect(resolveTheme(th, false)).toBe(th);
    }
  });
  test('system follows prefers-color-scheme', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
  });
  test('the picker offers system and every theme once', () => {
    expect([...THEME_CHOICES].sort()).toEqual(['system' as const, ...THEMES].sort());
  });
  test('stored values are validated', () => {
    expect(parseThemeChoice('onyx')).toBe('onyx');
    expect(parseThemeChoice('system')).toBe('system');
    expect(parseThemeChoice('neon')).toBe('system');
    expect(parseThemeChoice(42)).toBe('system');
    expect(parseThemeChoice(undefined)).toBe('system');
  });
  test('index.html pre-paint script knows every theme', async () => {
    const html = await Bun.file(new URL('../../index.html', import.meta.url)).text();
    const list = html.match(/\[('dark'[^\]]*)\]/)?.[1];
    expect(list?.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...THEMES]);
    expect(html).toContain('telinha.theme');
    expect(html).toContain('<div id="app"></div>');
  });
});
