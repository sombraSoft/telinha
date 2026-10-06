// The building blocks every screen uses. Each <text> sets fg (OpenTUI's own
// default is white) and every bounded single-line row is cut with fit().
import { TextAttributes, type RGBA } from '@opentui/core';
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { isDown, isEnter, isPrintable, isSpace, isUp, useKeys } from '../keys.ts';
import { useT } from '../strings.ts';
import { c } from '../theme.ts';
import { fit, fitTail, useTick, windowStart, wrap } from './layout.ts';

export const Bold = TextAttributes.BOLD;
type Color = string | RGBA;

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner(props: { fg?: Color }) {
  const tick = useTick();
  return <text fg={props.fg ?? c.accent}>{FRAMES[tick() % FRAMES.length]}</text>;
}

export function Bar(props: { value: number; width: number }) {
  const full = () => Math.max(0, Math.min(props.width, Math.round((props.value / 100) * props.width)));
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={c.accent}>{'█'.repeat(full())}</text>
      <text fg={c.muted}>{'░'.repeat(props.width - full())}</text>
    </box>
  );
}

/** A multi-line paragraph, word-wrapped by OpenTUI (muted unless told otherwise). */
export function Para(props: { text: string; fg?: Color }) {
  return (
    <box flexDirection="column">
      <For each={props.text.split('\n')}>{(line) => <text fg={props.fg ?? c.muted} wrapMode="word">{line === '' ? ' ' : line}</text>}</For>
    </box>
  );
}

export type Status = 'ok' | 'warn' | 'fail' | 'skip' | 'pending' | 'running' | 'skipped';

const ICON: Record<Exclude<Status, 'running'>, string> = { ok: '✔', warn: '!', fail: '✖', skip: '–', skipped: '–', pending: '○' };

export function statusColor(s: Status): Color {
  return s === 'ok' ? c.ok : s === 'warn' ? c.warn : s === 'fail' ? c.fail : s === 'running' ? c.accent : c.muted;
}

/** Distinct glyphs per status, so NO_COLOR still tells them apart. */
export function StatusIcon(props: { status: Status }) {
  return (
    <Show when={props.status !== 'running'} fallback={<Spinner />}>
      <text fg={statusColor(props.status)} attributes={props.status === 'ok' || props.status === 'warn' || props.status === 'fail' ? Bold : 0}>
        {ICON[props.status as Exclude<Status, 'running'>]}
      </text>
    </Show>
  );
}

export function Card(props: { title: string; width?: number; active?: boolean; children?: JSX.Element }) {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={props.active === false ? c.muted : c.accent}
      title={props.title}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      width={props.width}
      flexGrow={props.width ? 0 : 1}
      flexShrink={props.width ? 0 : 1}
    >
      {props.children}
    </box>
  );
}

interface Line {
  text: string;
  fg: Color;
  bold?: boolean;
}

/** The "About this" pane: wrapped here so an overflow can end in a "…" line. */
export function HintPane(props: { title?: string; lines: string[]; extra?: { head: string; items: string[] }; width: number; maxRows?: number }) {
  const t = useT();
  const lines = createMemo<Line[]>(() => {
    const inner = Math.max(1, props.width - 4);
    const out: Line[] = [];
    for (const l of props.lines) for (const w of wrap(l, inner)) out.push({ text: w, fg: c.muted });
    const extra = props.extra;
    if (extra) {
      out.push({ text: '', fg: c.muted });
      for (const w of wrap(extra.head, inner)) out.push({ text: w, fg: c.text, bold: true });
      for (const item of extra.items) for (const w of wrap(item, inner)) out.push({ text: w, fg: c.accent });
    }
    while (out.length && out[out.length - 1]!.text === '') out.pop();
    if (props.maxRows === undefined) return out;
    const room = Math.max(1, props.maxRows - 2);
    return out.length <= room ? out : [...out.slice(0, room - 1), { text: '…', fg: c.muted }];
  });
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={c.muted}
      title={` ${props.title ?? t('common.hint')} `}
      paddingLeft={1}
      paddingRight={1}
      width={props.width}
      flexShrink={0}
    >
      <For each={lines()}>{(l) => <text fg={l.fg} attributes={l.bold ? Bold : 0} wrapMode="none">{l.text === '' ? ' ' : l.text}</text>}</For>
    </box>
  );
}

export interface PickOption {
  value: string;
  label: string;
  desc?: string;
  /** De-emphasised (e.g. "Advanced…"): muted, with a blank line above. */
  subtle?: boolean;
  /** The saved answer: marked "✓ current answer". */
  chosen?: boolean;
}

interface Part {
  text: string;
  fg: Color;
  bold?: boolean;
}

/**
 * Claude-Code-style picker: numbered rows, ❯ on the highlighted one, a muted
 * description under each, ✓ on the saved answer. Multi mode: space toggles,
 * `a` toggles all (allKey). A long list shows a window around the highlight.
 */
export function Picker(props: {
  options: PickOption[];
  initial?: number;
  multi?: boolean;
  picked?: string[];
  min?: number;
  minError?: string;
  active?: () => boolean;
  /** Rows the picker may use, its status line included; unset = all of them. */
  maxRows?: number;
  allKey?: boolean;
  /** Columns available; labels are cut and descriptions wrapped to it. */
  width?: number;
  onMove?(i: number): void;
  onConfirm(v: string | string[]): void;
}) {
  const t = useT();
  const n = () => props.options.length;
  const first = props.initial ?? props.options.findIndex((o) => o.chosen);
  const [hi, setHi] = createSignal(Math.max(0, Math.min(first, props.options.length - 1)));
  const [picked, setPicked] = createSignal<string[]>(props.picked ?? []);
  const [err, setErr] = createSignal('');
  props.onMove?.(hi());

  const go = (i: number) => {
    setHi(i);
    props.onMove?.(i);
  };
  const confirmMulti = () => {
    if (picked().length < (props.min ?? 0)) return setErr(props.minError ?? t('common.pickOne'));
    props.onConfirm(props.options.filter((o) => picked().includes(o.value)).map((o) => o.value));
  };
  useKeys({
    key: (k) => {
      if (props.active && !props.active()) return false;
      if (!n() || k.ctrl || k.meta) return false;
      if (isUp(k)) return go((hi() - 1 + n()) % n()), true;
      if (isDown(k)) return go((hi() + 1) % n()), true;
      if (/^[1-9]$/.test(k.name ?? '') && Number(k.name) <= n()) {
        go(Number(k.name) - 1);
        if (!props.multi) props.onConfirm(props.options[hi()]!.value);
        return true;
      }
      if (props.multi && isSpace(k)) {
        const v = props.options[hi()]!.value;
        setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
        setErr('');
        return true;
      }
      if (props.multi && props.allKey && k.name === 'a') {
        setPicked((p) => (p.length === n() ? [] : props.options.map((o) => o.value)));
        setErr('');
        return true;
      }
      if (isEnter(k)) {
        if (props.multi) confirmMulti();
        else props.onConfirm(props.options[hi()]!.value);
        return true;
      }
      return false;
    },
  });

  let prevStart = 0;
  const lines = createMemo<Part[][]>(() => {
    const opts = props.options;
    const digits = String(opts.length).length;
    const indent = digits + 4 + (props.multi ? 4 : 0);
    const descLines = (o: PickOption): string[] => {
      if (!o.desc) return [];
      return props.width ? wrap(o.desc, Math.max(1, props.width - indent)) : [o.desc];
    };
    const row = (o: PickOption, i: number): Part[] => {
      const sel = i === hi();
      const box = props.multi ? (picked().includes(o.value) ? '[x] ' : '[ ] ') : '';
      const mark = !props.multi && o.chosen ? `  ✓ ${t('common.chosen')}` : '';
      let label = `${sel ? '❯' : ' '} ${String(i + 1).padStart(digits)}. ${box}${o.label}`;
      if (props.width) label = fit(label, Math.max(1, props.width - Bun.stringWidth(mark)));
      const parts: Part[] = [{ text: label, fg: sel ? c.accent : o.subtle ? c.muted : c.text, bold: sel }];
      if (mark) parts.push({ text: mark, fg: c.ok });
      return parts;
    };
    const desc = (d: string): Part[] => [{ text: `${' '.repeat(indent)}${d}`, fg: c.muted }];
    const status: Part[][] = props.multi
      ? [[], [{ text: err() || (picked().length === 1 ? t('common.selected1') : t('common.selected', { n: picked().length })), fg: err() ? c.fail : c.muted }]]
      : [];

    const full: Part[][] = [];
    opts.forEach((o, i) => {
      if (o.subtle && i > 0) full.push([]);
      full.push(row(o, i));
      for (const d of descLines(o)) full.push(desc(d));
    });
    if (props.maxRows === undefined || full.length + status.length <= props.maxRows) return [...full, ...status];

    // Tight: one line per option, the description only under the highlighted one.
    const hiDesc = descLines(opts[hi()]!);
    const room = Math.max(1, props.maxRows - status.length - hiDesc.length);
    const out: Part[][] = [];
    if (opts.length <= room) {
      prevStart = 0;
      opts.forEach((o, i) => {
        out.push(row(o, i));
        if (i === hi()) for (const d of hiDesc) out.push(desc(d));
      });
      return [...out, ...status];
    }
    const size = Math.max(1, room - 2);
    const start = windowStart(hi(), opts.length, size, prevStart);
    prevStart = start;
    const end = Math.min(opts.length, start + size);
    out.push(start > 0 ? [{ text: `  ${t('common.moreAbove', { n: start })}`, fg: c.muted }] : []);
    for (let i = start; i < end; i++) {
      out.push(row(opts[i]!, i));
      if (i === hi()) for (const d of hiDesc) out.push(desc(d));
    }
    if (end < opts.length) out.push([{ text: `  ${t('common.moreBelow', { n: opts.length - end })}`, fg: c.muted }]);
    return [...out, ...status];
  });

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={lines()}>
        {(parts) => (
          <box flexDirection="row" flexShrink={0}>
            <Show when={parts.length} fallback={<text fg={c.muted}> </text>}>
              <For each={parts}>
                {(p) => <text fg={p.fg} attributes={p.bold ? Bold : 0} wrapMode={props.width ? 'none' : 'word'}>{p.text}</text>}
              </For>
            </Show>
          </box>
        )}
      </For>
    </box>
  );
}

/**
 * Single-line field. OpenTUI's <input> has no masking, so this one is built
 * on the key stack: printable keys append, Backspace deletes, a paste appends
 * the decoded payload. No cursor movement, so ← stays "back".
 */
export function Field(props: {
  secret?: boolean;
  initial?: string;
  placeholder?: string;
  /** Submitted when the field is empty; shown as "default: X". */
  defaultText?: string;
  /** A secret is already saved: empty + Enter keeps it. */
  keepsSecret?: boolean;
  width: number;
  disabled?: boolean;
  active?: () => boolean;
  onSubmit(v: string): void;
  onChange?(): void;
}) {
  const t = useT();
  const [value, setValue] = createSignal(props.initial ?? '');
  const [reveal, setReveal] = createSignal(false);
  const [pasted, setPasted] = createSignal(false);
  const edit = (v: string, wasPaste = false) => {
    setValue(v);
    setPasted(wasPaste);
    props.onChange?.();
  };
  useKeys({
    key: (k) => {
      if (props.active && !props.active()) return false;
      if (props.disabled) return k.name !== 'escape' && k.name !== 'left' && !k.ctrl;
      if (isEnter(k)) return props.onSubmit(value() || props.defaultText || ''), true;
      if (k.name === 'backspace') return edit(value().slice(0, -1)), true;
      if (k.ctrl && k.name === 'u') return edit(''), true;
      if (k.ctrl && k.name === 'r' && props.secret) return setReveal((r) => !r), true;
      if (k.name === 'left' || k.name === 'escape' || k.name === 'tab') return false;
      if (isPrintable(k)) return edit(value() + k.sequence, pasted()), true;
      return false;
    },
    paste: (text) => {
      if (props.active && !props.active()) return false;
      if (props.disabled) return true;
      edit(value() + text.replace(/[\r\n]+/g, '').trim(), true);
      return true;
    },
  });
  const inner = () => Math.max(2, props.width - 4);
  const shown = () => {
    const v = props.secret && !reveal() ? '•'.repeat([...value()].length) : value();
    return fitTail(v, inner() - 1);
  };
  const status = () =>
    [
      props.secret ? t('common.characters', { n: [...value()].length }) : '',
      pasted() ? t('common.pasted') : '',
      props.defaultText ? `${t('common.default')}: ${props.defaultText}` : '',
      props.keepsSecret && value() === '' ? t('common.keepCurrent') : '',
    ].filter(Boolean).join(' · ');
  return (
    <box flexDirection="column" width={props.width} flexShrink={0}>
      <box border borderStyle="rounded" borderColor={props.disabled ? c.muted : c.accent} paddingLeft={1} paddingRight={1} flexDirection="row">
        <Show
          when={value() !== ''}
          fallback={
            <box flexDirection="row">
              <text fg={c.accent}>▌</text>
              <text fg={c.muted} wrapMode="none">{fit(props.placeholder ?? t('common.empty'), inner() - 1)}</text>
            </box>
          }
        >
          <text fg={c.text} wrapMode="none">{shown()}</text>
          <Show when={!props.disabled}>
            <text fg={c.accent}>▌</text>
          </Show>
        </Show>
      </box>
      <text fg={c.muted} paddingLeft={1} wrapMode="none">{fit(status(), props.width - 1) || ' '}</text>
    </box>
  );
}
