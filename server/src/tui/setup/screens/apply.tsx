// The install as a live task list: a spinner on the running task, a bar for
// downloads, the lines of a failed task under it with Retry / Skip / Back to
// questions, and at the end the web address with the doctor report or Exit.
// ↑ from the first choice walks the finished tasks; Enter shows their lines.
import type { KeyEvent, RGBA } from '@opentui/core';
import { createEffect, createMemo, createSignal, Index, Match, on, Show, Switch, type Accessor } from 'solid-js';
import { at } from '../../../cli/setup/apply-strings.ts';
import { TASKS, type TaskId, type TaskLine, type TaskRow } from '../../../cli/setup/apply.ts';
import { t as st } from '../../../cli/setup/strings.ts';
import { isDown, isEnter, isSpace, isUp, useKeys } from '../../keys.ts';
import { useLocale, useT } from '../../strings.ts';
import { c } from '../../theme.ts';
import { CARD_CHROME, fit, pad, useLayout, windowStart, wrap } from '../../ui/layout.ts';
import { Bar, Bold, Card, Picker, StatusIcon, type PickOption } from '../../ui/widgets.tsx';
import type { ApplyStore } from '../store.ts';
import { useS } from '../strings.ts';
import { Lines, marked, paint, pickerRows, type Line } from './question.tsx';

type Color = string | RGBA;
const LABEL_W = 26;
const BAR_W = 22;
const INDENT = '    ';
const MB = 1024 * 1024;

const lineColor = (k: TaskLine['kind']): Color => (k === 'ok' ? c.ok : k === 'warn' ? c.warn : k === 'fail' ? c.fail : c.muted);
const lineMark = (k: TaskLine['kind']) => (k === 'ok' ? '✔ ' : k === 'warn' ? '! ' : k === 'fail' ? '✖ ' : '');
const mb = (n: number) => (n / MB).toFixed(1);

type Item = { kind: 'row'; row: TaskRow; index: number } | { kind: 'text'; line: Line };

export interface ApplyProps {
  store: ApplyStore;
  badge: () => string;
  docker: boolean;
  shownFile: string;
  webAddress: () => string;
  canDoctor: boolean;
  /** A one-line notice under the title ("going back is disabled", "press Ctrl+C again"). */
  notice: () => string | null;
  active: () => boolean;
  onDecide(d: 'retry' | 'skip' | 'back'): void;
  onDoctor(): void;
  onExit(): void;
}

export function ApplyScreen(p: ApplyProps) {
  const s = useS();
  const t = useT();
  const locale = useLocale();
  const L = useLayout();
  const fullW = () => (L.side() ? L.cardW() + L.hintW() + 1 : L.cardW());
  const inner = () => Math.max(10, fullW() - 6);
  const detailW = () => Math.max(1, inner() - 2 - LABEL_W - 1);

  // ---- finished rows can be opened: ↑ from the first choice moves into the list
  const [rowSel, setRowSel] = createSignal<number | null>(null);
  const [pickHi, setPickHi] = createSignal(0);
  const [open, setOpen] = createSignal<TaskId[]>([]);
  const settled = () => p.store.stage() !== 'running';
  const openable = (r: TaskRow) => r.status !== 'pending' && r.status !== 'running' && r.lines.length > 0;
  const selectable = () => p.store.rows.map((r, i) => (openable(r) ? i : -1)).filter((i) => i >= 0);
  const failed = () => p.store.failure()?.id ?? null;
  const expanded = (r: TaskRow) => r.id === failed() || open().includes(r.id);
  // The last card opens what is left to do by hand (the row's todo): the router's
  // lines, a warning's with its explanation when the row cannot say it all.
  // Opened that way a row shows only those lines; Enter shows all of them.
  const [brief, setBrief] = createSignal<TaskId[]>([]);
  createEffect(on(p.store.stage, (stage) => {
    if (stage !== 'done') return;
    const todo = p.store.rows.filter((r) => {
      if (r.id === 'router') return r.todo.length > 0;
      return r.status === 'warn' && (r.todo.length > 1 || (r.todo.length === 1 && Bun.stringWidth(r.todo[0]!.text) > detailW()));
    }).map((r) => r.id);
    setBrief(todo.filter((id) => !open().includes(id)));
    setOpen((o) => [...new Set([...o, ...todo])]);
  }));

  const rowKeys = (k: KeyEvent): boolean => {
    if (!p.active() || !settled() || k.ctrl || k.meta) return false;
    const sel = selectable();
    const cur = rowSel();
    if (cur === null) {
      if (isUp(k) && pickHi() === 0 && sel.length) return setRowSel(sel[sel.length - 1]!), true;
      return false;
    }
    const pos = sel.indexOf(cur);
    if (isUp(k)) return pos > 0 && setRowSel(sel[pos - 1]!), true;
    if (isDown(k)) return setRowSel(pos >= 0 && pos < sel.length - 1 ? sel[pos + 1]! : null), true;
    if (isEnter(k) || isSpace(k) || k.name === 'right') {
      const id = p.store.rows[cur]?.id;
      if (!id) return true;
      // A row opened to its to-do lines opens to all of them; another press closes it.
      if (brief().includes(id)) setBrief((b) => b.filter((x) => x !== id));
      else setOpen((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
      return true;
    }
    return false;
  };

  // ---- what follows the list
  const result = () => p.store.result();
  const running = () => result()?.tasks.start === 'ok';
  const failHint = createMemo(() => {
    const id = failed();
    return id ? paint(at(locale(), TASKS[id].hint), inner(), c.text) : [];
  });
  // Everything after telinha.env needs it: that one has no Skip.
  const failOptions = (): PickOption[] => [
    { value: 'retry', label: s('apply.retry'), desc: s('apply.retryDesc') },
    ...(failed() === 'config' ? [] : [{ value: 'skip', label: s('apply.skip'), desc: s('apply.skipDesc') }]),
    { value: 'back', label: s('apply.back'), desc: s('apply.backDesc') },
  ];
  const doneOptions = (): PickOption[] => [
    ...(p.canDoctor ? [{ value: 'doctor', label: s('apply.doctor'), desc: s('apply.doctorDesc') }] : []),
    { value: 'exit', label: s('apply.exit'), desc: s(running() ? 'apply.exitDesc' : 'apply.exitDescIdle') },
  ];
  const doneLines = createMemo<Line[]>(() => {
    if (!p.docker) return [];
    const out = marked('✔', st(locale(), 'written', { file: p.shownFile }), inner(), c.ok, true);
    out.push({ text: '', fg: c.muted });
    // Its columns are aligned with spaces: wrapped only when a line does not fit.
    for (const l of st(locale(), 'nextDocker').split('\n')) out.push(...(Bun.stringWidth(l) <= inner() ? [{ text: l, fg: c.muted }] : paint(l, inner(), c.muted)));
    return out;
  });
  // Rows under the list; tight: the choices without their descriptions.
  const tailRows = (tight: boolean) => {
    const stage = p.store.stage();
    const picker = (o: PickOption[]) => (tight ? o.length : pickerRows(o, inner()));
    if (stage === 'failed') return 1 + failHint().length + 1 + picker(failOptions());
    if (stage === 'done') return 1 + (p.docker ? doneLines().length : 1) + 1 + picker(doneOptions());
    return 0;
  };
  /** Title, status line and the list's margin. */
  const HEAD = CARD_CHROME + 2 + 1;

  // ---- the list, windowed around the row that matters
  /** errorsOnly: the failed task shows only its warnings and failures (what went wrong), not its progress lines. */
  const build = (errorsOnly: boolean): Item[] => {
    const out: Item[] = [];
    const w = Math.max(4, inner() - INDENT.length);
    p.store.rows.forEach((row, index) => {
      out.push({ kind: 'row', row, index });
      if (!expanded(row)) return;
      const bad = row.lines.filter((l) => l.kind === 'warn' || l.kind === 'fail');
      const lines = errorsOnly && row.id === failed() && bad.length ? bad : brief().includes(row.id) ? row.todo : row.lines;
      for (const l of lines) {
        // The mark on the first line, its width of spaces before the others.
        const mark = lineMark(l.kind);
        for (const [i, text] of wrap(l.text, Math.max(1, w - Bun.stringWidth(mark))).entries()) {
          out.push({ kind: 'text', line: { text: `${INDENT}${i ? ' '.repeat(Bun.stringWidth(mark)) : mark}${text}`, fg: lineColor(l.kind) } });
        }
      }
    });
    return out;
  };
  const allItems = createMemo(() => build(false));
  // A list that does not fit beside the full choices: the choices give up their descriptions first.
  const tight = createMemo(() => settled() && allItems().length > L.bodyRows() - HEAD - tailRows(false));
  const shownOptions = (o: PickOption[]) => (tight() ? o.map((x) => ({ ...x, desc: undefined })) : o);
  const budget = () => Math.max(3, L.bodyRows() - HEAD - tailRows(tight()));
  // The failed task's block comes before the other rows; when it is taller than the window it keeps its errors only.
  const items = createMemo<Item[]>(() => {
    const all = allItems();
    const f = failed();
    if (!f || all.length <= budget()) return all;
    const from = all.findIndex((x) => x.kind === 'row' && x.row.id === f);
    let end = from + 1;
    while (all[end]?.kind === 'text') end++;
    return end - from > Math.max(1, budget() - 2) ? build(true) : all;
  });
  const focusRow = () => {
    const sel = rowSel();
    if (sel !== null) return sel;
    const f = failed();
    const rows = p.store.rows;
    const i = f ? rows.findIndex((r) => r.id === f) : rows.findIndex((r) => r.status === 'running');
    return i >= 0 ? i : 0;
  };
  let prevStart = 0;
  /** merged: one "↑ n more  ↓ n more" line under the list instead of one above and one below. */
  const view = createMemo(() => {
    const all = items();
    if (all.length <= budget()) {
      prevStart = 0;
      return { shown: all, above: 0, below: 0, merged: false };
    }
    const first = all.findIndex((x) => x.kind === 'row' && x.index === focusRow());
    let last = first;
    while (all[last + 1]?.kind === 'text') last++;
    // A focused block taller than the window between two markers gets the row of the top one.
    const merged = last - first + 1 > budget() - 2;
    const size = Math.max(1, budget() - (merged ? 1 : 2));
    let start = windowStart(Math.max(0, first), all.length, size, prevStart);
    if (last >= start + size) start = Math.min(first, last - size + 1);
    prevStart = start;
    const end = Math.min(all.length, start + size);
    const rowsIn = (a: Item[]) => a.filter((x) => x.kind === 'row').length;
    return { shown: all.slice(start, end), above: rowsIn(all.slice(0, start)), below: rowsIn(all.slice(end)), merged };
  });
  const moreLine = () => {
    const v = view();
    if (!v.merged) return v.below ? t('common.moreBelow', { n: v.below }) : '';
    return [v.above ? t('common.moreAbove', { n: v.above }) : '', v.below ? t('common.moreBelow', { n: v.below }) : ''].filter(Boolean).join('  ');
  };

  const title = () => s(p.docker ? 'apply.titleDocker' : 'apply.title');
  const status = (): Line => {
    const n = p.notice();
    if (n) return { text: fit(`! ${n}`, inner()), fg: c.warn };
    return { text: p.store.stage() === 'running' ? s('apply.running') : '', fg: c.muted };
  };

  return (
    <Card title={` ${p.badge()} `} width={fullW()} active={p.active()}>
      <text fg={c.text} attributes={Bold} wrapMode="none">{fit(title(), inner())}</text>
      <Lines lines={[status()]} />
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        <Show when={view().above && !view().merged}>
          <text fg={c.muted} wrapMode="none">{`  ${t('common.moreAbove', { n: view().above })}`}</text>
        </Show>
        <Index each={view().shown}>
          {(item) => (
            <Switch>
              <Match when={item().kind === 'row' && (item() as Extract<Item, { kind: 'row' }>)}>
                {(it: Accessor<Extract<Item, { kind: 'row' }>>) => <TaskRowView row={it().row} sel={rowSel() === it().index} width={detailW()} />}
              </Match>
              <Match when={item().kind === 'text' && (item() as Extract<Item, { kind: 'text' }>)}>
                {(it: Accessor<Extract<Item, { kind: 'text' }>>) => <Lines lines={[it().line]} />}
              </Match>
            </Switch>
          )}
        </Index>
        <Show when={moreLine()}>
          <text fg={c.muted} wrapMode="none">{`  ${moreLine()}`}</text>
        </Show>
      </box>
      <Switch>
        <Match when={p.store.stage() === 'failed' && failed()} keyed>
          {(_key: string) => (
            <box flexDirection="column" flexShrink={0}>
              <box flexDirection="column" marginTop={1} flexShrink={0}>
                <Lines lines={failHint()} />
              </box>
              <box marginTop={1} flexShrink={0}>
                <Picker
                  options={shownOptions(failOptions())}
                  width={inner()}
                  active={() => p.active() && rowSel() === null}
                  onMove={setPickHi}
                  onConfirm={(v) => p.onDecide(v as 'retry' | 'skip' | 'back')}
                />
              </box>
              <RowKeys on={rowKeys} />
            </box>
          )}
        </Match>
        <Match when={p.store.stage() === 'done'}>
          <box flexDirection="column" flexShrink={0}>
            <box flexDirection="column" marginTop={1} flexShrink={0}>
              <Show when={!p.docker} fallback={<Lines lines={doneLines()} />}>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text fg={c.ok} attributes={Bold} wrapMode="none">{`✔ ${s(running() ? 'apply.done' : 'apply.setUp')}`}</text>
                  <text fg={c.muted}>→</text>
                  <text fg={c.accent} attributes={Bold} wrapMode="none">
                    {fit(p.webAddress(), Math.max(1, inner() - Bun.stringWidth(s(running() ? 'apply.done' : 'apply.setUp')) - 6))}
                  </text>
                </box>
              </Show>
            </box>
            <box marginTop={1} flexShrink={0}>
              <Picker
                options={shownOptions(doneOptions())}
                width={inner()}
                active={() => p.active() && rowSel() === null}
                onMove={setPickHi}
                onConfirm={(v) => (v === 'doctor' ? p.onDoctor() : p.onExit())}
              />
            </box>
            <RowKeys on={rowKeys} />
          </box>
        </Match>
      </Switch>
    </Card>
  );
}

/** Pushed after the picker, so it sees ↑↓ first and can take them into the task list. */
function RowKeys(p: { on(k: KeyEvent): boolean }) {
  useKeys({ key: (k) => p.on(k) });
  return null;
}

function TaskRowView(p: { row: TaskRow; sel: boolean; width: number }) {
  const s = useS();
  const locale = useLocale();
  const label = () => at(locale(), TASKS[p.row.id].label);
  const last = () => p.row.lines[p.row.lines.length - 1];
  const progress = () => (p.row.status === 'running' ? p.row.progress : null);
  const barW = () => (p.width >= BAR_W + 22 ? BAR_W : p.width >= 30 ? p.width - 22 : 0);
  const pct = () => {
    const g = progress();
    return g?.total ? Math.max(0, Math.min(100, Math.floor((g.done / g.total) * 100))) : 0;
  };
  const progressText = () => {
    const g = progress()!;
    if (g.unit === 'bytes') {
      const amount = g.total ? `${String(pct()).padStart(3)}%  ${mb(g.done)} / ${mb(g.total)} MB` : `${mb(g.done)} MB`;
      return g.label ? `${amount}  ${g.label}` : amount;
    }
    if (g.unit === 'items') return p.row.detail || `${g.done} / ${g.total ?? '?'}`;
    return `${String(pct()).padStart(3)}%  ${p.row.detail}`;
  };
  const detail = (): { text: string; fg: Color } => {
    const r = p.row;
    switch (r.status) {
      case 'pending':
        return { text: '', fg: c.muted };
      case 'running':
        return { text: r.detail, fg: c.muted };
      case 'skipped':
        return { text: last()?.kind === 'info' ? last()!.text : s('apply.skipped'), fg: c.muted };
      case 'fail': {
        const bad = [...r.lines].reverse().find((l) => l.kind === 'fail') ?? last();
        return { text: bad?.text ?? '', fg: c.fail };
      }
      case 'warn': {
        const w = [...r.lines].reverse().find((l) => l.kind === 'warn' || l.kind === 'fail') ?? last();
        return { text: w?.text ?? r.detail, fg: c.warn };
      }
      default:
        return { text: r.result?.text ?? last()?.text ?? r.detail, fg: c.muted };
    }
  };
  const text = () => (detail().text.split('\n')[0] ?? '');
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <StatusIcon status={p.row.status} />
      <text
        fg={p.sel ? c.accent : p.row.status === 'pending' ? c.muted : c.text}
        attributes={p.row.status === 'running' || p.sel ? Bold : 0}
        wrapMode="none"
      >{pad(`${label()}${p.sel ? '  ‹' : ''}`, LABEL_W)}</text>
      <Show
        when={progress()?.total || progress()?.unit === 'bytes' ? progress() : null}
        fallback={<text fg={detail().fg} wrapMode="none">{fit(text(), p.width)}</text>}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Show when={barW() && progress()?.total}>
            <Bar value={pct()} width={barW()} />
          </Show>
          <text fg={c.muted} wrapMode="none">{fit(progressText(), Math.max(1, p.width - (barW() && progress()?.total ? barW() + 1 : 0)))}</text>
        </box>
      </Show>
    </box>
  );
}
