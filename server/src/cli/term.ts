// Terminal I/O for setup/doctor/update/service: status lines, prompts, spinner,
// tables. Prompts that read keys (secret, select, multiselect) use raw mode;
// text/confirm read lines. Without a TTY, or with --yes, a prompt returns its
// default or throws NeedsInputError so the caller can name the missing flag.
// Only ANSI sequences every supported terminal knows: SGR, cursor up, clear line.
import { ts, type Locale } from './strings.ts';

type DataFn = (chunk: string | Uint8Array) => void;
export interface TermIn {
  isTTY?: boolean;
  setRawMode?: (on: boolean) => unknown;
  on(event: 'data', fn: DataFn): unknown;
  on(event: 'end', fn: () => void): unknown;
  off(event: 'data', fn: DataFn): unknown;
  off(event: 'end', fn: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}
export interface TermOut {
  write(s: string): unknown;
  isTTY?: boolean;
}

export interface Choice<T> { value: T; label: string; hint?: string }
export interface Spinner { update(label: string): void; stop(okLabel?: string): void; fail(label?: string): void }

export interface Term {
  info(msg: string): void;
  ok(msg: string): void;
  warn(msg: string): void;
  fail(msg: string): void;
  step(title: string): void;
  line(msg?: string): void;
  text(q: string, o?: { default?: string; validate?: (v: string) => string | null; required?: boolean; id?: string }): Promise<string>;
  /** Masked with *, Ctrl+U clears; never echoed. */
  secret(q: string, o?: { validate?: (v: string) => string | null; id?: string }): Promise<string>;
  confirm(q: string, def?: boolean, o?: { id?: string }): Promise<boolean>;
  select<T>(q: string, items: Choice<T>[], def?: number, o?: { id?: string }): Promise<T>;
  multiselect<T>(q: string, items: Choice<T>[], o?: { min?: number; preselected?: T[]; id?: string }): Promise<T[]>;
  spinner(label: string): Spinner;
  table(rows: string[][]): void;
  /** OSC 8 hyperlink when the terminal supports it; the URL itself is always the visible text. */
  link(url: string): string;
  /** NO_COLOR or not a TTY -> off. */
  colors: boolean;
  style: { bold(s: string): string; dim(s: string): string; red(s: string): string; green(s: string): string; yellow(s: string): string; cyan(s: string): string };
}

/** A question nobody can answer (no TTY, or --yes without a default). `questionId` names it for the caller. */
export class NeedsInputError extends Error {
  constructor(readonly questionId: string, question = questionId) {
    super(ts('en', 'needsInput', { q: question }));
    this.name = 'NeedsInputError';
  }
}

export interface TermOptions {
  stdin?: TermIn;
  stdout?: TermOut;
  tty: boolean;
  yes: boolean;
  locale: Locale;
  env?: Record<string, string | undefined>;
  /** Ctrl+C / EOF in a prompt: restores the terminal, then this(130). */
  exit?: (code: number) => never;
  /** Spinner frame interval; 0 disables the animation (tests). */
  spinnerMs?: number;
}

const ESC = '\x1b';
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x1b]*\x1b\\/g;
export const visibleLength = (s: string) => [...s.replace(ANSI_RE, '')].length;

type Key = { name: 'enter' | 'backspace' | 'clear' | 'cancel' | 'eof' | 'up' | 'down' | 'left' | 'right' | 'other' } | { name: 'char'; ch: string };

/** Buffered stdin: keeps what arrives between prompts, attaches only while one runs. */
class Input {
  private buf = '';
  private ended = false;
  private wake: (() => void) | null = null;
  private decoder = new TextDecoder();
  private attached = false;
  private onData: DataFn = (chunk) => {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.notify();
  };
  private onEnd = () => {
    this.ended = true;
    this.notify();
  };

  constructor(private stdin: TermIn) {}

  private notify() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  attach() {
    if (this.attached) return;
    this.attached = true;
    this.stdin.on('data', this.onData);
    this.stdin.on('end', this.onEnd);
    this.stdin.resume();
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    this.stdin.off('data', this.onData);
    this.stdin.off('end', this.onEnd);
    // Paused, stdin no longer keeps the process alive and unread input waits for the next prompt.
    this.stdin.pause();
  }

  private wait() {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  /** One line without its terminator; null on EOF or Ctrl+C. */
  async line(): Promise<string | null> {
    for (;;) {
      const nl = this.buf.search(/\r\n|\r|\n/);
      const cc = this.buf.indexOf('\x03');
      if (cc >= 0 && (nl < 0 || cc < nl)) {
        this.buf = '';
        return null;
      }
      if (nl >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + (this.buf.startsWith('\r\n', nl) ? 2 : 1));
        return line;
      }
      if (this.ended) return null;
      await this.wait();
    }
  }

  async key(): Promise<Key> {
    for (;;) {
      const k = this.take();
      if (k) return k;
      if (this.ended) return { name: 'eof' };
      await this.wait();
    }
  }

  private take(): Key | null {
    const b = this.buf;
    if (!b) return null;
    const eat = (n: number, k: Key) => {
      this.buf = b.slice(n);
      return k;
    };
    if (b[0] === ESC) {
      if (b.length === 1) return eat(1, { name: 'other' });
      if (b[1] !== '[' && b[1] !== 'O') return eat(2, { name: 'other' });
      // CSI / SS3: parameters, then one final byte in @..~.
      let i = 2;
      while (i < b.length && !/[@-~]/.test(b[i]!)) i++;
      if (i >= b.length) return null;
      const names: Record<string, Key['name']> = { A: 'up', B: 'down', C: 'right', D: 'left' };
      return eat(i + 1, { name: names[b[i]!] ?? 'other' } as Key);
    }
    if (b.startsWith('\r\n')) return eat(2, { name: 'enter' });
    const ch = String.fromCodePoint(b.codePointAt(0)!);
    const n = ch.length;
    if (ch === '\r' || ch === '\n') return eat(n, { name: 'enter' });
    if (ch === '\x03') return eat(n, { name: 'cancel' });
    if (ch === '\x04') return eat(n, { name: 'eof' });
    if (ch === '\x7f' || ch === '\b') return eat(n, { name: 'backspace' });
    if (ch === '\x15') return eat(n, { name: 'clear' });
    if (ch < ' ') return eat(n, { name: 'other' });
    return eat(n, { name: 'char', ch });
  }
}

/** A console window of its own (double-click): keep it open until Enter, or what was printed vanishes with it. */
export async function waitForEnter(prompt: string): Promise<void> {
  process.stderr.write(`${prompt}\n`);
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
    process.stdin.once('end', () => resolve());
    process.stdin.resume();
  });
  process.stdin.pause();
}

export function createTerm(o: TermOptions): Term {
  const stdin: TermIn = o.stdin ?? (process.stdin as unknown as TermIn);
  const stdout: TermOut = o.stdout ?? process.stdout;
  const env = o.env ?? process.env;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const t = (key: Parameters<typeof ts>[1], params?: Record<string, string | number>) => ts(o.locale, key, params);
  const colors = o.tty && !!stdout.isTTY && !env.NO_COLOR;
  const sgr = (open: number, close: number) => (s: string) => (colors ? `${ESC}[${open}m${s}${ESC}[${close}m` : s);
  const style = { bold: sgr(1, 22), dim: sgr(2, 22), red: sgr(31, 39), green: sgr(32, 39), yellow: sgr(33, 39), cyan: sgr(36, 39) };
  const input = new Input(stdin);
  const write = (s: string) => void stdout.write(s);
  const println = (s = '') => write(`${s}\n`);
  let raw = false;
  let cursorHidden = false;

  const setRaw = (on: boolean) => {
    if (raw === on || !stdin.setRawMode) return;
    stdin.setRawMode(on);
    raw = on;
  };
  const hideCursor = (hide: boolean) => {
    if (!colors || cursorHidden === hide) return;
    write(`${ESC}[?25${hide ? 'l' : 'h'}`);
    cursorHidden = hide;
  };
  const restore = () => {
    setRaw(false);
    hideCursor(false);
    input.detach();
  };
  // Ctrl+C or EOF inside a prompt: leave the terminal usable, exit like a SIGINT would.
  const cancel = (): never => {
    restore();
    println();
    return exit(130);
  };

  const ask = (q: string) => `${style.cyan('?')} ${style.bold(q)}`;
  const answered = (q: string, a: string) => println(`${ask(q)} ${style.dim('›')} ${a}`);
  // Non-TTY or --yes: the default when there is one; else a TTY still asks, a pipe cannot.
  const preset = <T>(q: string, id: string | undefined, def: T | undefined, show: (v: T) => string): { value: T } | null => {
    if (o.tty && !o.yes) return null;
    if (def !== undefined) {
      answered(q, show(def));
      return { value: def };
    }
    if (!o.tty) throw new NeedsInputError(id ?? q, q);
    return null;
  };

  async function readLine(): Promise<string> {
    input.attach();
    try {
      const line = await input.line();
      if (line === null) return cancel();
      return line;
    } finally {
      input.detach();
    }
  }

  async function keys<T>(handle: (k: Key) => T | undefined): Promise<T> {
    input.attach();
    setRaw(true);
    try {
      for (;;) {
        const k = await input.key();
        if (k.name === 'cancel' || k.name === 'eof') return cancel();
        const r = handle(k);
        if (r !== undefined) return r;
      }
    } finally {
      setRaw(false);
      input.detach();
    }
  }

  const term: Term = {
    colors,
    style,
    info: (msg) => println(`  ${msg}`),
    ok: (msg) => println(`${style.green('✓')} ${msg}`),
    warn: (msg) => println(`${style.yellow('!')} ${msg}`),
    fail: (msg) => println(`${style.red('✗')} ${msg}`),
    step: (title) => println(`\n${style.bold(style.cyan('▸'))} ${style.bold(title)}`),
    line: (msg = '') => println(msg),

    async text(q, opts = {}) {
      const p = preset(q, opts.id, opts.default, (v) => v);
      if (p) return p.value;
      for (;;) {
        write(`${ask(q)}${opts.default ? style.dim(` (${opts.default})`) : ''} ${style.dim('›')} `);
        const v = (await readLine()).trim() || opts.default || '';
        if (!v && opts.required) {
          term.fail(t('required'));
          continue;
        }
        const err = opts.validate?.(v) ?? null;
        if (err) {
          term.fail(err);
          continue;
        }
        return v;
      }
    },

    async secret(q, opts = {}) {
      if (!o.tty) throw new NeedsInputError(opts.id ?? q, q);
      for (;;) {
        write(`${ask(q)} ${style.dim('›')} `);
        let value = '';
        const done = await keys<string>((k) => {
          if (k.name === 'enter') return value;
          if (k.name === 'backspace' && value) {
            value = [...value].slice(0, -1).join('');
            write('\b \b');
          } else if (k.name === 'clear') {
            write('\b \b'.repeat([...value].length));
            value = '';
          } else if (k.name === 'char') {
            value += k.ch;
            write('*');
          }
          return undefined;
        });
        println();
        const v = done.trim();
        const err = opts.validate?.(v) ?? (v ? null : t('required'));
        if (err) {
          term.fail(err);
          continue;
        }
        return v;
      }
    },

    async confirm(q, def, opts = {}) {
      const yes = (v: boolean) => (v ? (o.locale === 'pt-BR' ? 'sim' : 'yes') : (o.locale === 'pt-BR' ? 'não' : 'no'));
      const p = preset(q, opts.id, def, yes);
      if (p) return p.value;
      const hint = def === undefined ? t('yesNo') : def ? t('yesNoDefYes') : t('yesNoDefNo');
      for (;;) {
        write(`${ask(q)} ${style.dim(hint)} ${style.dim('›')} `);
        const a = (await readLine()).trim().toLowerCase();
        if (!a && def !== undefined) return def;
        if (/^(y|yes|s|sim)$/.test(a)) return true;
        if (/^(n|no|não|nao)$/.test(a)) return false;
        term.fail(t('answerYesNo'));
      }
    },

    async select<T>(q: string, items: Choice<T>[], def?: number, opts: { id?: string } = {}) {
      if (!items.length) throw new Error(`select "${q}": no items`);
      const d = def !== undefined ? items[def] : undefined;
      const p = preset(q, opts.id, d, (v) => v.label);
      if (p) return p.value.value;
      let cur = Math.min(Math.max(def ?? 0, 0), items.length - 1);
      const view = listView(items.length);
      println(`${ask(q)} ${style.dim(t('selectHint'))}`);
      hideCursor(true);
      const draw = (first: boolean) => {
        const rows = view.rows(cur).map((i) => {
          const it = items[i]!;
          const label = i === cur ? style.cyan(`❯ ${it.label}`) : `  ${it.label}`;
          return it.hint ? `${label} ${style.dim(it.hint)}` : label;
        });
        redraw(rows.concat(view.footer(cur)), first);
      };
      draw(true);
      const picked = await keys<T>((k) => {
        if (k.name === 'up' || (k.name === 'char' && k.ch === 'k')) cur = (cur - 1 + items.length) % items.length;
        else if (k.name === 'down' || (k.name === 'char' && k.ch === 'j')) cur = (cur + 1) % items.length;
        else if (k.name === 'char' && /^[1-9]$/.test(k.ch) && Number(k.ch) <= items.length) cur = Number(k.ch) - 1;
        else if (k.name === 'enter') return items[cur]!.value;
        else return undefined;
        draw(false);
        return undefined;
      });
      finish(view.height, q, items[cur]!.label);
      return picked;
    },

    async multiselect<T>(q: string, items: Choice<T>[], opts: { min?: number; preselected?: T[]; id?: string } = {}) {
      const min = opts.min ?? 0;
      const pre = opts.preselected !== undefined && opts.preselected.length >= min ? opts.preselected : undefined;
      const p = preset(q, opts.id, pre, (v) => items.filter((i) => v.includes(i.value)).map((i) => i.label).join(', '));
      if (p) return p.value;
      if (!items.length) return [];
      const on = new Set(items.map((it, i) => (opts.preselected?.includes(it.value) ? i : -1)).filter((i) => i >= 0));
      let cur = 0;
      let warning = '';
      const view = listView(items.length);
      println(`${ask(q)} ${style.dim(t('multiHint'))}`);
      hideCursor(true);
      const draw = (first: boolean) => {
        const rows = view.rows(cur).map((i) => {
          const it = items[i]!;
          const box = on.has(i) ? style.green('[x]') : '[ ]';
          const label = `${i === cur ? style.cyan('❯') : ' '} ${box} ${i === cur ? style.cyan(it.label) : it.label}`;
          return it.hint ? `${label} ${style.dim(it.hint)}` : label;
        });
        redraw(rows.concat(warning ? style.yellow(warning) : view.footer(cur)), first);
      };
      draw(true);
      await keys<true>((k) => {
        warning = '';
        if (k.name === 'up' || (k.name === 'char' && k.ch === 'k')) cur = (cur - 1 + items.length) % items.length;
        else if (k.name === 'down' || (k.name === 'char' && k.ch === 'j')) cur = (cur + 1) % items.length;
        else if (k.name === 'char' && k.ch === ' ') {
          if (on.has(cur)) on.delete(cur);
          else on.add(cur);
        } else if (k.name === 'char' && k.ch === 'a') {
          if (on.size === items.length) on.clear();
          else items.forEach((_, i) => on.add(i));
        } else if (k.name === 'enter') {
          if (on.size >= min) return true;
          warning = t('pickAtLeast', { n: min });
        } else return undefined;
        draw(false);
        return undefined;
      });
      const chosen = items.filter((_, i) => on.has(i));
      finish(view.height, q, chosen.map((i) => i.label).join(', '));
      return chosen.map((i) => i.value);
    },

    spinner(label) {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let current = label;
      let n = 0;
      let timer: ReturnType<typeof setInterval> | null = null;
      const animated = colors && (o.spinnerMs ?? 80) > 0;
      const paint = () => write(`\r${ESC}[2K${style.cyan(frames[n++ % frames.length]!)} ${current}`);
      if (animated) {
        paint();
        timer = setInterval(paint, o.spinnerMs ?? 80);
        (timer as { unref?: () => void }).unref?.();
      } else {
        println(`- ${current}`);
      }
      const end = (line: string) => {
        if (timer) clearInterval(timer);
        timer = null;
        if (animated) write(`\r${ESC}[2K`);
        println(line);
      };
      return {
        update(l) {
          current = l;
          if (!animated) println(`- ${l}`);
        },
        stop: (okLabel) => end(`${style.green('✓')} ${okLabel ?? current}`),
        fail: (l) => end(`${style.red('✗')} ${l ?? current}`),
      };
    },

    table(rows) {
      const widths: number[] = [];
      for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, visibleLength(c))));
      for (const r of rows) {
        println(`  ${r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i]! - visibleLength(c)))).join('  ')}`.trimEnd());
      }
    },

    link(url) {
      const supported = colors && !!(env.WT_SESSION || env.TERM_PROGRAM || env.VTE_VERSION || env.KONSOLE_VERSION || /kitty|wezterm/.test(env.TERM ?? ''));
      return supported ? `${ESC}]8;;${url}${ESC}\\${url}${ESC}]8;;${ESC}\\` : url;
    },
  };

  // Lists render at most 12 rows and scroll; the footer line says what is hidden.
  function listView(count: number) {
    const size = Math.min(12, count);
    let top = 0;
    const scroll = (cur: number) => {
      if (cur < top) top = cur;
      if (cur >= top + size) top = cur - size + 1;
    };
    return {
      height: size + 1,
      rows(cur: number) {
        scroll(cur);
        return Array.from({ length: size }, (_, i) => top + i);
      },
      footer(cur: number) {
        scroll(cur);
        const above = top;
        const below = count - top - size;
        const parts = [above ? t('moreAbove', { n: above }) : '', below ? t('moreBelow', { n: below }) : ''].filter(Boolean);
        return style.dim(parts.join('  '));
      },
    };
  }

  function redraw(lines: string[], first: boolean) {
    if (!first) write(`${ESC}[${lines.length}A`);
    for (const l of lines) write(`${ESC}[2K${l}\n`);
  }

  // Replaces the question and its list with one answered line.
  function finish(height: number, q: string, answer: string) {
    write(`${ESC}[${height + 1}A${ESC}[0J`);
    hideCursor(false);
    answered(q, answer);
  }

  return term;
}
