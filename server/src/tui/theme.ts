// Colours. Text uses the terminal's own default foreground so it reads on any
// background; only the brand accent and the status colours are hex, picked per
// light/dark mode. Nothing paints a background, so the terminal's shows through.
// OpenTUI's default text colour is white, so every <text> passes one of these.
import { RGBA } from '@opentui/core';
import { createSignal } from 'solid-js';

export type Mode = 'dark' | 'light';

const palettes = {
  // The web app's accent is #5865f2; on dark backgrounds its lighter focus-ring
  // tint keeps the contrast.
  dark: { accent: '#949cf7', muted: '#8b8d96', ok: '#57c785', warn: '#f0b232', fail: '#f26b6f' },
  light: { accent: '#4452bb', muted: '#6c6d76', ok: '#1f8a4c', warn: '#9a6700', fail: '#c62f35' },
} as const;

const [mode, setMode] = createSignal<Mode>('dark');
const [noColor, setNoColor] = createSignal(false);

export { mode, noColor, setMode, setNoColor };

const fg = RGBA.defaultForeground();
type Color = string | RGBA;
const pick = (k: keyof (typeof palettes)['dark']): Color => (noColor() ? fg : palettes[mode()][k]);

export const c = {
  get text(): Color {
    return fg;
  },
  get accent() {
    return pick('accent');
  },
  get muted() {
    return pick('muted');
  },
  get ok() {
    return pick('ok');
  },
  get warn() {
    return pick('warn');
  },
  get fail() {
    return pick('fail');
  },
};

/** The renderer's theme surface, so tests can pass a stand-in. */
export interface ThemeSource {
  waitForThemeMode(timeoutMs?: number): Promise<Mode | null>;
}

/** TELINHA_THEME > the terminal's answer to OSC 10/11 > COLORFGBG > dark. */
export async function detectMode(
  renderer: ThemeSource | null,
  env: Record<string, string | undefined>,
): Promise<{ mode: Mode; source: 'TELINHA_THEME' | 'terminal' | 'COLORFGBG' | 'fallback' }> {
  const forced = env.TELINHA_THEME?.toLowerCase();
  if (forced === 'light' || forced === 'dark') return { mode: forced, source: 'TELINHA_THEME' };
  if (renderer) {
    const m = await renderer.waitForThemeMode(300).catch(() => null);
    if (m) return { mode: m, source: 'terminal' };
  }
  // "fg;bg" or "fg;default;bg": ANSI 7 and 15 are the light backgrounds.
  const bg = env.COLORFGBG?.split(';').pop();
  if (bg !== undefined && /^\d+$/.test(bg))
    return { mode: bg === '7' || bg === '15' ? 'light' : 'dark', source: 'COLORFGBG' };
  return { mode: 'dark', source: 'fallback' };
}

/** NO_COLOR (any non-empty value) turns every colour into the terminal's own. */
export function applyColorEnv(env: Record<string, string | undefined>): void {
  setNoColor(!!env.NO_COLOR);
}
