// Renderer lifecycle and terminal safety. Whatever ends the TUI (the app
// finishing, Ctrl+C, a signal, a crash) goes through one idempotent destroy so
// the terminal always comes back usable: cursor shown, raw mode off, the main
// screen restored. Only call this with stdin AND stdout on a TTY: without one
// OpenTUI waits forever for the terminal's replies.
import { type CliRenderer, type CliRendererConfig, createCliRenderer } from '@opentui/core';
import { render as solidRender, useKeyboard, usePaste } from '@opentui/solid';
import { type Accessor, createSignal, type JSX } from 'solid-js';
import type { Locale } from '../cli/strings.ts';
import { dispatchKey, dispatchPaste, isCtrlC, type KeyStack, KeysCtx, useKeys } from './keys.ts';
import { LocaleCtx } from './strings.ts';
import { applyColorEnv, detectMode, type Mode, setMode } from './theme.ts';

export interface TuiHandle {
  /**
   * Hands the terminal to `fn` (a child that prompts, like sudo): the screen
   * is suspended, `intro` printed plainly, and the TUI redrawn afterwards.
   */
  withTerminal<T>(fn: () => Promise<T>, intro?: string[]): Promise<T>;
  setLocale(l: Locale): void;
}

/** The process surface the runtime hooks into; injectable for tests. */
export interface ProcLike {
  on(event: string, fn: (...args: any[]) => void): unknown;
  off(event: string, fn: (...args: any[]) => void): unknown;
  exit(code: number): void;
}

export interface RuntimeDeps {
  createRenderer?: (config: CliRendererConfig) => Promise<CliRenderer>;
  render?: (node: () => JSX.Element, renderer: CliRenderer) => Promise<void>;
  proc?: ProcLike;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export const RENDERER_CONFIG: CliRendererConfig = {
  // Ctrl+C is a key the screens handle (an install may need a second press).
  exitOnCtrlC: false,
  // Signals are ours: one destroy, then the conventional exit code.
  exitSignals: [],
  useMouse: false,
  targetFps: 30,
  consoleMode: 'console-overlay',
  openConsoleOnError: false,
  screenMode: 'alternate-screen',
};

// 128 + signal number; Windows reports closing the console window as SIGHUP.
const SIGNALS: [NodeJS.Signals, number][] = [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
];

/** Provides the key stack and the locale, and routes every key and paste through the stack. */
export function TuiRoot(props: { locale: Accessor<Locale>; onCtrlC?: () => void; children?: JSX.Element }) {
  const stack: KeyStack = [];
  return (
    <KeysCtx.Provider value={stack}>
      <LocaleCtx.Provider value={props.locale}>
        <KeyRoot stack={stack} onCtrlC={props.onCtrlC}>
          {props.children}
        </KeyRoot>
      </LocaleCtx.Provider>
    </KeysCtx.Provider>
  );
}

function KeyRoot(props: { stack: KeyStack; onCtrlC?: () => void; children?: JSX.Element }) {
  const decoder = new TextDecoder();
  useKeyboard((k) => {
    dispatchKey(props.stack, k);
  });
  usePaste((e) => {
    dispatchPaste(props.stack, decoder.decode(e.bytes));
  });
  // Bottom of the stack: reached only when no screen used the key.
  useKeys({
    key: (k) => {
      if (!isCtrlC(k)) return false;
      props.onCtrlC?.();
      return true;
    },
  });
  return (
    <box flexDirection="column" width="100%" height="100%">
      {props.children}
    </box>
  );
}

export async function runTui<T>(o: {
  locale: Locale;
  env: Record<string, string | undefined>;
  app: (done: (r: T) => void, h: TuiHandle) => JSX.Element;
  /** Value returned when the user presses Ctrl+C outside a screen that handles it. */
  onCtrlC: () => T;
  deps?: RuntimeDeps;
}): Promise<T> {
  const d = o.deps ?? {};
  const proc: ProcLike = d.proc ?? process;
  const stdout = d.stdout ?? ((s: string) => void process.stdout.write(s));
  const stderr = d.stderr ?? ((s: string) => void process.stderr.write(s));
  const renderer = await (d.createRenderer ?? createCliRenderer)(RENDERER_CONFIG);

  const hooks: [string, (...args: any[]) => void][] = [];
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    for (const [event, fn] of hooks) proc.off(event, fn);
    try {
      renderer.destroy();
    } catch {
      // Already torn down by OpenTUI itself: nothing left to restore.
    }
  };
  const hook = (event: string, fn: (...args: any[]) => void) => {
    hooks.push([event, fn]);
    proc.on(event, fn);
  };
  for (const [sig, code] of SIGNALS) {
    hook(sig, () => {
      destroy();
      proc.exit(code);
    });
  }
  const fatal = (e: unknown) => {
    destroy();
    stderr(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    proc.exit(1);
  };
  hook('uncaughtException', fatal);
  hook('unhandledRejection', fatal);

  try {
    applyColorEnv(o.env);
    const theme = await detectMode(renderer, o.env);
    setMode(theme.mode);
    if (theme.source !== 'TELINHA_THEME') renderer.on('theme_mode', (m: Mode) => setMode(m));

    const [locale, setLocale] = createSignal<Locale>(o.locale);
    let finish!: (r: T) => void;
    const result = new Promise<T>((resolve) => (finish = resolve));
    let finished = false;
    const done = (r: T) => {
      if (finished) return;
      finished = true;
      finish(r);
    };
    const handle: TuiHandle = {
      async withTerminal(fn, intro = []) {
        renderer.suspend();
        try {
          for (const line of intro) stdout(`${line}\n`);
          return await fn();
        } finally {
          if (!destroyed) {
            renderer.resume();
            renderer.requestRender();
          }
        }
      },
      setLocale,
    };
    await (d.render ?? solidRender)(
      () => (
        <TuiRoot locale={locale} onCtrlC={() => done(o.onCtrlC())}>
          {o.app(done, handle)}
        </TuiRoot>
      ),
      renderer,
    );
    return await result;
  } finally {
    destroy();
  }
}
