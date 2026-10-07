// Drives TUI components with OpenTUI's test renderer (no terminal) and reads
// plain-text frames. The ticker is frozen and the header version fixed, so
// frames are stable enough for snapshots. Needs the bunfig [test] preload.
import { testRender } from '@opentui/solid';
import { createSignal, type JSX } from 'solid-js';
import type { Locale } from '../src/cli/strings.ts';
import { RENDERER_CONFIG, TuiRoot } from '../src/tui/runtime.tsx';
import { setMode, setNoColor } from '../src/tui/theme.ts';
import { setTickerFrozen } from '../src/tui/ui/layout.ts';

setTickerFrozen(true);

/** The version string headers show in tests. */
export const VERSION = 'test';

export type Session = Awaited<ReturnType<typeof testRender>> & { setLocale(l: Locale): void };

export interface OpenOptions {
  width?: number;
  height?: number;
  locale?: Locale;
  onCtrlC?: () => void;
}

export async function open(node: () => JSX.Element, o: OpenOptions = {}): Promise<Session> {
  setMode('dark');
  setNoColor(false);
  const [locale, setLocale] = createSignal<Locale>(o.locale ?? 'en');
  const s = await testRender(() => <TuiRoot locale={locale} onCtrlC={o.onCtrlC}>{node()}</TuiRoot>, {
    width: o.width ?? 120,
    height: o.height ?? 34,
    // The runtime's rule: Ctrl+C reaches the screens instead of tearing the
    // test renderer down.
    exitOnCtrlC: RENDERER_CONFIG.exitOnCtrlC,
  });
  await s.renderOnce();
  return Object.assign(s, { setLocale });
}

/** open(), run `fn`, and always destroy the renderer. */
export async function withTui<T>(node: () => JSX.Element, o: OpenOptions, fn: (s: Session) => Promise<T>): Promise<T> {
  const s = await open(node, o);
  try {
    return await fn(s);
  } finally {
    s.renderer.destroy();
  }
}

/** Key parsing is async: wait, then render. */
export async function settle(s: Session, ms = 30): Promise<void> {
  await Bun.sleep(ms);
  await s.renderOnce();
}

/** The frame, trailing spaces and blank tail trimmed. */
export function frame(s: Session): string {
  return `${s.captureCharFrame().split('\n').map((l) => l.trimEnd()).join('\n').trimEnd()}\n`;
}

export async function until(s: Session, text: string | RegExp, ms = 3000): Promise<string> {
  const end = Date.now() + ms;
  const hit = (f: string) => (typeof text === 'string' ? f.includes(text) : text.test(f));
  for (;;) {
    await settle(s, 20);
    const f = frame(s);
    if (hit(f)) return f;
    if (Date.now() > end) throw new Error(`timed out waiting for ${String(text)}\n${f}`);
  }
}

export async function typeText(s: Session, text: string): Promise<void> {
  await s.mockInput.typeText(text);
  await settle(s);
}

export async function paste(s: Session, text: string): Promise<void> {
  await s.mockInput.pasteBracketedText(text);
  await settle(s);
}

const ARROWS = ['up', 'down', 'left', 'right'] as const;

/** Keys by name: enter, escape, tab, backspace, space, up/down/left/right, ctrl+<x>, or a character. */
export async function press(s: Session, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    const m = /^ctrl\+(.)$/.exec(key);
    if (m) s.mockInput.pressKey(m[1]!, { ctrl: true });
    else if (key === 'enter') s.mockInput.pressEnter();
    else if (key === 'escape') s.mockInput.pressEscape();
    else if (key === 'tab') s.mockInput.pressTab();
    else if (key === 'backspace') s.mockInput.pressBackspace();
    else if (key === 'space') s.mockInput.pressKey(' ');
    else if ((ARROWS as readonly string[]).includes(key)) s.mockInput.pressArrow(key as (typeof ARROWS)[number]);
    else s.mockInput.pressKey(key);
    await settle(s, 15);
  }
  await settle(s);
}
