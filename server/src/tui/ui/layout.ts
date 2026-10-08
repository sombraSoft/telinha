// Layout helpers. Single-line rows are cut here by display width instead of
// relying on OpenTUI's wrapping/truncation, so frames are the same in every
// terminal and in tests.
import { useTerminalDimensions } from '@opentui/solid';
import { type Accessor, createContext, createSignal, onCleanup, useContext } from 'solid-js';

export const SIDEBAR_WIDTH = 26;
export const HINT_WIDTH = 38;
/** Header rows (TV mascot) and the key-help footer. */
export const HEADER_ROWS = 4;
export const FOOTER_ROWS = 1;
/** Card border + vertical padding. */
export const CARD_CHROME = 4;
/** Card + hint pane side by side from this card+hint width on. */
export const SIDE_BY_SIDE = 110;
/** Below this terminal width the sidebar is hidden. */
export const NARROW = 80;

export const width = (s: string): number => Bun.stringWidth(s);

/** Cuts `text` to `max` display columns with a trailing "…". */
export function fit(text: string, max: number): string {
  if (max <= 0) return '';
  if (width(text) <= max) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = width(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** fit() and then pad with spaces to exactly `max` columns. */
export function pad(text: string, max: number): string {
  const f = fit(text, max);
  return f + ' '.repeat(Math.max(0, max - width(f)));
}

/** Keeps the end of `text` within `max` columns, with a leading "…" when cut. */
export function fitTail(text: string, max: number): string {
  if (max <= 0) return '';
  if (width(text) <= max) return text;
  let out = '';
  let w = 0;
  for (const ch of [...text].reverse()) {
    const cw = width(ch);
    if (w + cw > max - 1) break;
    out = ch + out;
    w += cw;
  }
  return `…${out}`;
}

/** Word wrap by display width; words longer than a line are split. Keeps blank lines. */
export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/ +/)) {
      let rest = word;
      while (width(rest) > max) {
        if (line) {
          out.push(line);
          line = '';
        }
        let head = '';
        for (const ch of rest) {
          if (width(head + ch) > max) break;
          head += ch;
        }
        out.push(head);
        rest = rest.slice(head.length);
      }
      if (!rest) continue;
      if (!line) line = rest;
      else if (width(`${line} ${rest}`) <= max) line = `${line} ${rest}`;
      else {
        out.push(line);
        line = rest;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * The start of a window of `size` items out of `total` that keeps `index` in
 * view and moves as little as possible from `prev`.
 */
export function windowStart(index: number, total: number, size: number, prev = 0): number {
  if (total <= size) return 0;
  let start = Math.min(Math.max(prev, 0), total - size);
  if (index < start) start = index;
  if (index >= start + size) start = index - size + 1;
  return start;
}

/**
 * Whether the screen's header (the TV mascot) is hidden: the phone test's QR
 * code takes its rows when it would not fit otherwise. Every layout under the
 * provider counts the rows it frees.
 */
export interface Chrome {
  headerHidden: Accessor<boolean>;
  setHeaderHidden(on: boolean): void;
}

export const ChromeCtx = createContext<Chrome>({ headerHidden: () => false, setHeaderHidden: () => {} });

export function createChrome(): Chrome {
  const [headerHidden, setHeaderHidden] = createSignal(false);
  return { headerHidden, setHeaderHidden };
}

export interface Layout {
  width: Accessor<number>;
  height: Accessor<number>;
  /** Sidebar shown (terminal at least 80 columns wide). */
  sidebar: Accessor<boolean>;
  /** Hint pane beside the card instead of under it. */
  side: Accessor<boolean>;
  cardW: Accessor<number>;
  hintW: Accessor<number>;
  /** Rows between the header (when shown) and the footer. */
  bodyRows: Accessor<number>;
  /** Rows a list inside a card can use (title and question lines taken off); at least 4. */
  listRows: Accessor<number>;
}

export function useLayout(o: { sidebar?: boolean } = {}): Layout {
  const dims = useTerminalDimensions();
  const chrome = useContext(ChromeCtx);
  const w = () => dims().width;
  const h = () => dims().height;
  const sidebar = () => (o.sidebar ?? true) && w() >= NARROW;
  // Outer padding 1 + 1, and the sidebar with its 1-column gap.
  const total = () => w() - 2 - (sidebar() ? SIDEBAR_WIDTH + 1 : 0);
  const side = () => total() >= SIDE_BY_SIDE;
  const hintW = () => (side() ? HINT_WIDTH : total());
  const cardW = () => (side() ? total() - HINT_WIDTH - 1 : total());
  const bodyRows = () => Math.max(0, h() - (chrome.headerHidden() ? 0 : HEADER_ROWS) - FOOTER_ROWS);
  const listRows = () => Math.max(4, bodyRows() - CARD_CHROME - 3);
  return { width: w, height: h, sidebar, side, cardW, hintW, bodyRows, listRows };
}

// One ticker for every spinner: 80 ms frames, started by the first user and
// stopped with the last, frozen in tests so frames are deterministic.
const [tick, setTick] = createSignal(0);
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let frozen = false;

export function setTickerFrozen(on: boolean): void {
  frozen = on;
  if (on && timer) {
    clearInterval(timer);
    timer = null;
  }
  setTick(0);
}

export function useTick(): Accessor<number> {
  users++;
  if (!frozen && !timer) timer = setInterval(() => setTick((n) => n + 1), 80);
  onCleanup(() => {
    users--;
    if (users <= 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  return tick;
}
