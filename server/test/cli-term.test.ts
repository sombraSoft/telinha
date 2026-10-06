import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createTerm, NeedsInputError, visibleLength, type TermOptions } from '../src/cli/term.ts';

// A TTY stand-in: input is queued and delivered only while a prompt listens,
// one chunk per tick, like keystrokes.
class FakeStdin extends EventEmitter {
  isTTY = true;
  rawCalls: boolean[] = [];
  private queue: string[] = [];
  private flowing = false;
  setRawMode(on: boolean) {
    this.rawCalls.push(on);
  }
  resume() {
    this.flowing = true;
    this.pump();
  }
  pause() {
    this.flowing = false;
  }
  type(...chunks: string[]) {
    this.queue.push(...chunks);
    this.pump();
  }
  private pump() {
    setTimeout(() => {
      if (!this.flowing || !this.queue.length || !this.listenerCount('data')) return;
      this.emit('data', Buffer.from(this.queue.shift()!));
      this.pump();
    }, 1);
  }
}

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function setup(o: Partial<TermOptions> & { tty?: boolean } = {}) {
  const stdin = new FakeStdin();
  let out = '';
  const stdout = { isTTY: true, write: (s: string) => (out += s) };
  const term = createTerm({
    stdin, stdout, tty: true, yes: false, locale: 'en', env: {}, spinnerMs: 0,
    exit: (code) => {
      throw new Exit(code);
    },
    ...o,
  });
  return { term, stdin, out: () => out };
}

const UP = '\x1b[A';
const DOWN = '\x1b[B';

describe('text / confirm', () => {
  test('text returns the typed line, or the default on Enter', async () => {
    const { term, stdin } = setup();
    stdin.type('hello\r\n');
    expect(await term.text('Name?')).toBe('hello');
    stdin.type('\n');
    expect(await term.text('Port?', { default: '443' })).toBe('443');
  });

  test('text re-asks until validate passes', async () => {
    const { term, stdin, out } = setup();
    stdin.type('abc\n', '42\n');
    const v = await term.text('Port?', { validate: (s) => (/^\d+$/.test(s) ? null : 'a number, please') });
    expect(v).toBe('42');
    expect(out()).toContain('a number, please');
  });

  test('confirm: y/n/sim/não and the default', async () => {
    const { term, stdin } = setup();
    stdin.type('y\n');
    expect(await term.confirm('Go?')).toBe(true);
    stdin.type('não\n');
    expect(await term.confirm('Go?')).toBe(false);
    stdin.type('\n');
    expect(await term.confirm('Go?', true)).toBe(true);
    stdin.type('maybe\n', 'n\n');
    expect(await term.confirm('Go?', true)).toBe(false);
  });

  test('typed-ahead input stays buffered for the next prompt', async () => {
    const { term, stdin } = setup();
    stdin.type('one\ntwo\n');
    expect(await term.text('1?')).toBe('one');
    expect(await term.text('2?')).toBe('two');
  });
});

describe('secret', () => {
  test('masked, backspace and Ctrl+U edit, never echoed', async () => {
    const { term, stdin, out } = setup();
    stdin.type('wrong', '\x15', 's3cr', 'x\x7f', 'et-token', '\r');
    const v = await term.secret('Token?');
    expect(v).toBe('s3cret-token');
    expect(out()).not.toContain('s3cret');
    expect(out()).not.toContain('wrong');
    expect(out()).toContain('*');
    // Raw mode on for the prompt, off afterwards.
    expect(stdin.rawCalls).toEqual([true, false]);
  });

  test('a pasted secret with its newline in one chunk', async () => {
    const { term, stdin, out } = setup();
    stdin.type('pasted-secret-value\r\n');
    expect(await term.secret('Token?')).toBe('pasted-secret-value');
    expect(out()).not.toContain('pasted-secret-value');
  });

  test('validate failures re-ask without showing the value', async () => {
    const { term, stdin, out } = setup();
    stdin.type('tiny\r', 'long-enough-secret\r');
    expect(await term.secret('Token?', { validate: (v) => (v.length > 10 ? null : 'too short') })).toBe('long-enough-secret');
    expect(out()).toContain('too short');
    expect(out()).not.toContain('tiny');
    expect(out()).not.toContain('long-enough');
  });

  test('Ctrl+C restores the terminal and exits 130', async () => {
    const { term, stdin } = setup();
    stdin.type('abc', '\x03');
    const err = await term.secret('Token?').catch((e) => e);
    expect(err).toBeInstanceOf(Exit);
    expect((err as Exit).code).toBe(130);
    expect(stdin.rawCalls.at(-1)).toBe(false);
  });
});

describe('select / multiselect', () => {
  const items = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta', hint: 'second' },
    { value: 'c', label: 'Gamma' },
  ];

  test('arrows, j/k and Enter', async () => {
    const { term, stdin } = setup();
    stdin.type(DOWN, DOWN, UP, '\r');
    expect(await term.select('Pick', items)).toBe('b');
    stdin.type('k', '\r');
    expect(await term.select('Pick', items)).toBe('c'); // wraps from the first row
  });

  test('digits jump; the default is preselected', async () => {
    const { term, stdin } = setup();
    stdin.type('3', '\r');
    expect(await term.select('Pick', items)).toBe('c');
    stdin.type('\r');
    expect(await term.select('Pick', items, 1)).toBe('b');
  });

  test('long lists scroll and say how many are hidden', async () => {
    const { term, stdin, out } = setup();
    const many = Array.from({ length: 20 }, (_, i) => ({ value: i, label: `item ${i}` }));
    stdin.type(...Array(15).fill(DOWN), '\r');
    expect(await term.select('Pick', many)).toBe(15);
    expect(out()).toContain('↓ 8 more');
    expect(out()).toContain('↑ 4 more');
  });

  test('multiselect: space toggles, a toggles all, min enforced', async () => {
    const { term, stdin, out } = setup();
    stdin.type('\r', ' ', DOWN, DOWN, ' ', '\r');
    expect(await term.multiselect('Pick', items, { min: 1 })).toEqual(['a', 'c']);
    expect(out()).toContain('Pick at least 1.');
    stdin.type('a', '\r');
    expect(await term.multiselect('Pick', items)).toEqual(['a', 'b', 'c']);
    stdin.type(DOWN, ' ', '\r');
    expect(await term.multiselect('Pick', items, { preselected: ['a', 'b'] })).toEqual(['a']);
  });
});

describe('non-interactive and --yes', () => {
  test('no TTY: defaults are returned, questions without one throw NeedsInputError', async () => {
    const { term } = setup({ tty: false });
    expect(await term.text('Port?', { default: '443' })).toBe('443');
    expect(await term.confirm('Go?', false)).toBe(false);
    expect(await term.select('Pick', [{ value: 1, label: 'one' }, { value: 2, label: 'two' }], 1)).toBe(2);
    expect(await term.multiselect('Pick', [{ value: 1, label: 'one' }], { preselected: [1] })).toEqual([1]);
    const e = await term.text('Domain?', { id: 'public-url' }).catch((x) => x);
    expect(e).toBeInstanceOf(NeedsInputError);
    expect((e as NeedsInputError).questionId).toBe('public-url');
    await expect(term.secret('Token?', { id: 'discord-token' })).rejects.toBeInstanceOf(NeedsInputError);
    await expect(term.confirm('Go?')).rejects.toBeInstanceOf(NeedsInputError);
    await expect(term.select('Pick', [{ value: 1, label: 'one' }])).rejects.toBeInstanceOf(NeedsInputError);
    await expect(term.multiselect('Pick', [{ value: 1, label: 'one' }], { min: 1, preselected: [] })).rejects.toBeInstanceOf(NeedsInputError);
  });

  test('--yes on a TTY takes defaults without reading input, and still asks what has none', async () => {
    const { term, stdin } = setup({ yes: true });
    expect(await term.confirm('Go?', true)).toBe(true);
    stdin.type('typed\n');
    expect(await term.text('Name?')).toBe('typed');
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
});
