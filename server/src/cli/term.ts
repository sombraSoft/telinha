// Terminal output for setup/doctor/update/service: status lines, a spinner,
// tables and links. Nothing here reads keys: questions belong to the setup
// screens (server/src/tui), and a run without a terminal takes its answers
// from flags. Only ANSI sequences every supported terminal knows: SGR,
// carriage return, clear line.
import type { Locale } from './strings.ts';

export interface TermOut {
  write(s: string): unknown;
  isTTY?: boolean;
}

export interface Spinner {
  update(label: string): void;
  stop(okLabel?: string): void;
  fail(label?: string): void;
}

export interface Term {
  info(msg: string): void;
  ok(msg: string): void;
  warn(msg: string): void;
  fail(msg: string): void;
  step(title: string): void;
  line(msg?: string): void;
  spinner(label: string): Spinner;
  table(rows: string[][]): void;
  /** OSC 8 hyperlink when the terminal supports it; the URL itself is always the visible text. */
  link(url: string): string;
  /** NO_COLOR or not a TTY -> off. */
  colors: boolean;
  style: {
    bold(s: string): string;
    dim(s: string): string;
    red(s: string): string;
    green(s: string): string;
    yellow(s: string): string;
    cyan(s: string): string;
  };
  /** How far a download got; a plain terminal folds it into the running spinner's label. */
  progress?(done: number, total: number | null, label: string): void;
  /** What a long wait is waiting for (the setup screens show it on the task row); plain output has its lines already. */
  detail?(text: string): void;
}

/** What setup's steps print through: a terminal, or the setup screens' task rows. */
export type Out = Term;

export interface TermOptions {
  stdout?: TermOut;
  tty: boolean;
  /** --yes: accepted from every caller, though printing has nothing to accept. */
  yes: boolean;
  locale: Locale;
  env?: Record<string, string | undefined>;
  /** Spinner frame interval; 0 disables the animation (tests). */
  spinnerMs?: number;
}

const ESC = '\x1b';
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI sequences start with ESC
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x1b]*\x1b\\/g;
export const visibleLength = (s: string) => [...s.replace(ANSI_RE, '')].length;

const mb = (n: number) => (n / 1e6).toFixed(1);

/** "52% 10.9 / 21.0 MB", or "3.2 MB" when the size is unknown. */
export function byteProgress(done: number, total: number | null): string {
  if (!total) return `${mb(done)} MB`;
  return `${Math.min(100, Math.floor((done / total) * 100))}% ${mb(done)} / ${mb(total)} MB`;
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
  const stdout: TermOut = o.stdout ?? process.stdout;
  const env = o.env ?? process.env;
  const colors = o.tty && !!stdout.isTTY && !env.NO_COLOR;
  const sgr = (open: number, close: number) => (s: string) => (colors ? `${ESC}[${open}m${s}${ESC}[${close}m` : s);
  const style = {
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    red: sgr(31, 39),
    green: sgr(32, 39),
    yellow: sgr(33, 39),
    cyan: sgr(36, 39),
  };
  const write = (s: string) => void stdout.write(s);
  const println = (s = '') => write(`${s}\n`);
  // The animated spinner on screen, if any: progress lands on its line.
  let active: { suffix(s: string): void } | null = null;

  return {
    colors,
    style,
    info: (msg) => println(`  ${msg}`),
    ok: (msg) => println(`${style.green('✓')} ${msg}`),
    warn: (msg) => println(`${style.yellow('!')} ${msg}`),
    fail: (msg) => println(`${style.red('✗')} ${msg}`),
    step: (title) => println(`\n${style.bold(style.cyan('▸'))} ${style.bold(title)}`),
    line: (msg = '') => println(msg),

    spinner(label) {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let current = label;
      let extra = '';
      let n = 0;
      let timer: ReturnType<typeof setInterval> | null = null;
      const animated = colors && (o.spinnerMs ?? 80) > 0;
      const paint = () =>
        write(
          `\r${ESC}[2K${style.cyan(frames[n++ % frames.length]!)} ${current}${extra ? ` ${style.dim(extra)}` : ''}`,
        );
      const self = {
        suffix: (s: string) => {
          extra = s;
        },
      };
      if (animated) {
        paint();
        timer = setInterval(paint, o.spinnerMs ?? 80);
        (timer as { unref?: () => void }).unref?.();
        active = self;
      } else {
        println(`- ${current}`);
      }
      const end = (line: string) => {
        if (timer) clearInterval(timer);
        timer = null;
        if (active === self) active = null;
        if (animated) write(`\r${ESC}[2K`);
        println(line);
      };
      return {
        update(l) {
          current = l;
          extra = '';
          if (!animated) println(`- ${l}`);
        },
        stop: (okLabel) => end(`${style.green('✓')} ${okLabel ?? current}`),
        fail: (l) => end(`${style.red('✗')} ${l ?? current}`),
      };
    },

    progress(done, total, label) {
      // A line per chunk would flood a log: only an animated spinner shows it.
      active?.suffix(`${label} ${byteProgress(done, total)}`.trim());
    },

    table(rows) {
      const widths: number[] = [];
      for (const r of rows) {
        for (const [i, c] of r.entries()) widths[i] = Math.max(widths[i] ?? 0, visibleLength(c));
      }
      for (const r of rows) {
        println(
          `  ${r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(widths[i]! - visibleLength(c)))).join('  ')}`.trimEnd(),
        );
      }
    },

    link(url) {
      const supported =
        colors &&
        !!(
          env.WT_SESSION ||
          env.TERM_PROGRAM ||
          env.VTE_VERSION ||
          env.KONSOLE_VERSION ||
          /kitty|wezterm/.test(env.TERM ?? '')
        );
      return supported ? `${ESC}]8;;${url}${ESC}\\${url}${ESC}]8;;${ESC}\\` : url;
    },
  };
}
