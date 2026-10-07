import { describe, expect, test } from 'bun:test';
import { byteProgress, createTerm, visibleLength, type Term, type TermOptions, type TermOut } from '../src/cli/term.ts';

function setup(o: Partial<TermOptions> = {}) {
  let out = '';
  const stdout = { isTTY: true, write: (s: string) => (out += s) };
  const term = createTerm({ stdout, tty: true, yes: false, locale: 'en', env: {}, spinnerMs: 0, ...o });
  return { term, out: () => out };
}

describe('createTerm', () => {
  test('the options doctor passes still build a terminal that prints', () => {
    let written = '';
    const stdout: TermOut = { isTTY: false, write: (s: string) => (written += s) };
    const ctx = { tty: false, yes: true, locale: 'pt-BR' as const, env: {} };
    const term: Term = createTerm({ stdout, tty: ctx.tty, yes: ctx.yes, locale: ctx.locale, env: ctx.env });
    term.info('ok');
    term.line();
    expect(written).toBe('  ok\n\n');
    for (const k of ['info', 'ok', 'warn', 'fail', 'step', 'line', 'link', 'spinner', 'table'] as const) expect(typeof term[k]).toBe('function');
    expect(term.colors).toBe(false);
    expect(term.style.bold('x')).toBe('x');
  });
});

describe('output', () => {
  test('no colours without a TTY or with NO_COLOR', () => {
    expect(setup({ tty: false }).term.colors).toBe(false);
    expect(setup({ env: { NO_COLOR: '1' } }).term.colors).toBe(false);
    const { term, out } = setup({ env: { NO_COLOR: '1' } });
    term.ok('done');
    term.warn('careful');
    term.fail('broken');
    expect(out()).toBe('✓ done\n! careful\n✗ broken\n');
    expect(setup().term.colors).toBe(true);
  });

  test('table aligns columns by visible width', () => {
    const { term, out } = setup();
    term.table([[term.style.green('ok'), 'config', 'fine'], ['fail', 'dns', 'no A record']]);
    const lines = out().trimEnd().split('\n');
    expect(lines[1]).toBe('  fail  dns     no A record');
    expect(visibleLength(lines[0]!)).toBe('  ok    config  fine'.length);
  });

  test('link: OSC 8 only where supported', () => {
    expect(setup().term.link('https://x.test')).toBe('https://x.test');
    expect(setup({ env: { WT_SESSION: '1' } }).term.link('https://x.test')).toBe('\x1b]8;;https://x.test\x1b\\https://x.test\x1b]8;;\x1b\\');
    expect(setup({ tty: false, env: { WT_SESSION: '1' } }).term.link('https://x.test')).toBe('https://x.test');
  });

  test('spinner without animation prints start and result lines', () => {
    const { term, out } = setup({ tty: false });
    const s = term.spinner('downloading');
    s.stop('downloaded');
    term.spinner('checking').fail();
    expect(out()).toBe('- downloading\n✓ downloaded\n- checking\n✗ checking\n');
  });

  test('progress: nothing on a plain log, folded into an animated spinner\'s line', async () => {
    const plain = setup({ tty: false });
    const s = plain.term.spinner('downloading');
    plain.term.progress?.(5_000_000, 10_000_000, 'livekit');
    s.stop();
    expect(plain.out()).toBe('- downloading\n✓ downloading\n');

    const live = setup({ env: { NO_COLOR: '' }, spinnerMs: 5 });
    const spin = live.term.spinner('downloading');
    live.term.progress?.(5_000_000, 10_000_000, 'livekit');
    await Bun.sleep(30);
    spin.stop('done');
    expect(live.out()).toContain('livekit 50% 5.0 / 10.0 MB');
    // Gone with the spinner: a later progress has no line to land on.
    const before = live.out();
    live.term.progress?.(1, 2, 'caddy');
    expect(live.out()).toBe(before);
  });

  test('byteProgress: percent and megabytes, or just megabytes without a size', () => {
    expect(byteProgress(10_900_000, 21_000_000)).toBe('51% 10.9 / 21.0 MB');
    expect(byteProgress(3_200_000, null)).toBe('3.2 MB');
    expect(byteProgress(30, 20)).toBe('100% 0.0 / 0.0 MB');
  });
});
