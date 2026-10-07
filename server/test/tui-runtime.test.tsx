import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { type CliRenderer, RGBA } from '@opentui/core';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import { RENDERER_CONFIG, runTui, type TuiHandle } from '../src/tui/runtime.tsx';
import { applyColorEnv, c, detectMode, mode, setMode } from '../src/tui/theme.ts';

const EVENTS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection'];
const ENV = { TELINHA_THEME: 'dark' };

/** A test renderer whose lifecycle calls are logged; suspend/resume only log (no real terminal here). */
function harness() {
  const log: string[] = [];
  let setup: TestRendererSetup | null = null;
  const proc = Object.assign(new EventEmitter(), { exit: (code: number) => void log.push(`exit ${code}`) });
  const createRenderer = async () => {
    setup = await createTestRenderer({ width: 40, height: 10 });
    const r = setup.renderer as CliRenderer;
    const destroy = r.destroy.bind(r);
    r.destroy = () => {
      log.push('destroy');
      destroy();
    };
    r.suspend = () => void log.push('suspend');
    r.resume = () => void log.push('resume');
    return r;
  };
  const errors: string[] = [];
  const deps = {
    createRenderer,
    proc,
    stdout: (s: string) => void log.push(`out ${s.trim()}`),
    stderr: (s: string) => void errors.push(s),
  };
  const listeners = () => EVENTS.reduce((n, e) => n + proc.listenerCount(e), 0);
  return { log, proc, deps, errors, listeners, setup: () => setup! };
}

describe('runTui', () => {
  test('the exit-on-Ctrl+C and signal handling of OpenTUI stay off', () => {
    expect(RENDERER_CONFIG.exitOnCtrlC).toBe(false);
    expect(RENDERER_CONFIG.exitSignals).toEqual([]);
    expect(RENDERER_CONFIG.screenMode).toBe('alternate-screen');
  });

  test('done: the value comes back, one destroy, every handler removed', async () => {
    const h = harness();
    const p = runTui<number>({
      locale: 'en',
      env: ENV,
      onCtrlC: () => 130,
      deps: h.deps,
      app: (done) => {
        setTimeout(() => {
          done(7);
          done(8);
        }, 5);
        return <text fg="#ffffff">hi</text>;
      },
    });
    await Bun.sleep(1);
    expect(h.listeners()).toBe(EVENTS.length);
    expect(await p).toBe(7);
    expect(h.log).toEqual(['destroy']);
    expect(h.listeners()).toBe(0);
  });

  test('a throwing app: destroy once, the error goes on', async () => {
    const h = harness();
    const p = runTui<number>({
      locale: 'en',
      env: ENV,
      onCtrlC: () => 130,
      deps: h.deps,
      app: () => {
        throw new Error('boom');
      },
    });
    await expect(p).rejects.toThrow('boom');
    expect(h.log).toEqual(['destroy']);
    expect(h.listeners()).toBe(0);
  });

  test('a signal: destroy once, the conventional exit code, handlers gone', async () => {
    for (const [sig, code] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
      ['SIGHUP', 129],
    ] as const) {
      const h = harness();
      void runTui<number>({
        locale: 'en',
        env: ENV,
        onCtrlC: () => 130,
        deps: h.deps,
        app: () => <text fg="#ffffff">hi</text>,
      });
      await Bun.sleep(20);
      h.proc.emit(sig);
      expect(h.log).toEqual(['destroy', `exit ${code}`]);
      expect(h.listeners()).toBe(0);
    }
  });

  test('a crash: destroy first, then the error on stderr, exit 1', async () => {
    const h = harness();
    void runTui<number>({
      locale: 'en',
      env: ENV,
      onCtrlC: () => 130,
      deps: h.deps,
      app: () => <text fg="#ffffff">hi</text>,
    });
    await Bun.sleep(20);
    h.proc.emit('unhandledRejection', new Error('lost promise'));
    expect(h.log).toEqual(['destroy', 'exit 1']);
    expect(h.errors.join('')).toContain('lost promise');
    expect(h.listeners()).toBe(0);
  });

  test('Ctrl+C no screen handles: onCtrlC decides the value', async () => {
    const h = harness();
    const p = runTui<number>({
      locale: 'en',
      env: ENV,
      onCtrlC: () => 130,
      deps: h.deps,
      app: () => <text fg="#ffffff">hi</text>,
    });
    await Bun.sleep(20);
    h.setup().mockInput.pressCtrlC();
    expect(await p).toBe(130);
    expect(h.log).toEqual(['destroy']);
  });

  test('withTerminal: suspend, intro, fn, resume; resume also when fn throws', async () => {
    const h = harness();
    let handle!: TuiHandle;
    let finish!: (n: number) => void;
    const p = runTui<number>({
      locale: 'en',
      env: ENV,
      onCtrlC: () => 130,
      deps: h.deps,
      app: (done, th) => {
        handle = th;
        finish = done;
        return <text fg="#ffffff">hi</text>;
      },
    });
    await Bun.sleep(20);
    const got = await handle.withTerminal(async () => {
      h.log.push('fn');
      return 5;
    }, ['Telinha needs your password for one command.']);
    expect(got).toBe(5);
    await expect(
      handle.withTerminal(async () => {
        h.log.push('fn2');
        throw new Error('sudo refused');
      }),
    ).rejects.toThrow('sudo refused');
    finish(0);
    expect(await p).toBe(0);
    expect(h.log).toEqual([
      'suspend',
      'out Telinha needs your password for one command.',
      'fn',
      'resume',
      'suspend',
      'fn2',
      'resume',
      'destroy',
    ]);
  });
});

describe('theme', () => {
  const term = (m: 'dark' | 'light' | null) => ({ waitForThemeMode: async () => m });

  test('TELINHA_THEME > the terminal > COLORFGBG > dark', async () => {
    expect(await detectMode(term('dark'), { TELINHA_THEME: 'light', COLORFGBG: '0;0' })).toEqual({
      mode: 'light',
      source: 'TELINHA_THEME',
    });
    expect(await detectMode(term('light'), { TELINHA_THEME: 'bogus', COLORFGBG: '0;0' })).toEqual({
      mode: 'light',
      source: 'terminal',
    });
    expect(await detectMode(term(null), { COLORFGBG: '0;15' })).toEqual({ mode: 'light', source: 'COLORFGBG' });
    expect(await detectMode(term(null), { COLORFGBG: '15;default;0' })).toEqual({ mode: 'dark', source: 'COLORFGBG' });
    expect(await detectMode(null, {})).toEqual({ mode: 'dark', source: 'fallback' });
    expect(await detectMode({ waitForThemeMode: () => Promise.reject(new Error('no tty')) }, {})).toEqual({
      mode: 'dark',
      source: 'fallback',
    });
  });

  test('runTui applies the detected mode', async () => {
    const h = harness();
    setMode('dark');
    const p = runTui<number>({
      locale: 'en',
      env: { TELINHA_THEME: 'light' },
      onCtrlC: () => 130,
      deps: h.deps,
      app: (done) => (setTimeout(() => done(0), 5), (<text fg="#ffffff">hi</text>)),
    });
    await p;
    expect(mode()).toBe('light');
    setMode('dark');
  });

  test('palettes per mode; NO_COLOR turns every colour into the terminal default', () => {
    setMode('dark');
    expect(c.accent).toBe('#949cf7');
    setMode('light');
    expect(c.accent).toBe('#4452bb');
    applyColorEnv({ NO_COLOR: '1' });
    expect(c.accent).toEqual(RGBA.defaultForeground());
    expect(c.fail).toEqual(RGBA.defaultForeground());
    applyColorEnv({});
    setMode('dark');
    expect(c.ok).toBe('#57c785');
    expect(c.text).toEqual(RGBA.defaultForeground());
  });
});
