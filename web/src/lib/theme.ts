// Theme rules. index.html repeats them inline to paint the right theme before
// the bundle loads; keep both in sync.
export const THEMES = ['dark', 'ash', 'onyx', 'light'] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_CHOICES = ['system', ...THEMES] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export function parseThemeChoice(value: unknown): ThemeChoice {
  return (THEME_CHOICES as readonly unknown[]).includes(value) ? (value as ThemeChoice) : 'system';
}

/** "system" follows the OS: light -> Light, anything else -> Dark. */
export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): Theme {
  if (choice !== 'system') return choice;
  return prefersLight ? 'light' : 'dark';
}
