// One question at a time: the card (step badge, title, question, then a
// picker or a field, the lookup's state, errors and notices) and the "About
// this" pane beside it on wide terminals or under it. Everything shown comes
// from the setup state's view: a secret is never in it, only whether one is kept.
import type { RGBA } from '@opentui/core';
import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { q } from '../../../cli/setup/qstrings.ts';
import type { ActionId, QuestionView, SetupState } from '../../../cli/setup/state.ts';
import { useLocale } from '../../strings.ts';
import { c } from '../../theme.ts';
import { CARD_CHROME, fit, useLayout, wrap } from '../../ui/layout.ts';
import { Bold, Card, Field, HintPane, Picker, type PickOption, Spinner } from '../../ui/widgets.tsx';
import type { StateStore } from '../store.ts';

type Color = string | RGBA;
export interface Line {
  text: string;
  fg: Color;
  bold?: boolean;
}

/** Pre-wrapped lines: their count is what the layout budget counts. */
export function Lines(p: { lines: Line[] }) {
  return (
    <For each={p.lines}>
      {(l) => (
        <text fg={l.fg} attributes={l.bold ? Bold : 0} wrapMode="none">
          {l.text === '' ? ' ' : l.text}
        </text>
      )}
    </For>
  );
}

export const paint = (text: string, width: number, fg: Color, bold = false): Line[] =>
  wrap(text, Math.max(1, width)).map((t) => ({ text: t, fg, bold }));

/** "! text" style lines: the mark on the first line, the rest indented under the text. */
export function marked(mark: string, text: string, width: number, fg: Color, bold = false): Line[] {
  return wrap(text, Math.max(1, width - 2)).map((t, i) => ({ text: `${i ? '  ' : `${mark} `}${t}`, fg, bold }));
}

/** The rows Picker draws for these options when nothing has to be cut. */
export function pickerRows(opts: PickOption[], width: number, multi = false): number {
  const indent = String(opts.length).length + 4 + (multi ? 4 : 0);
  let n = multi ? 2 : 0;
  opts.forEach((o, i) => {
    if (o.subtle && i > 0) n++;
    n++;
    if (o.desc) n += wrap(o.desc, Math.max(1, width - indent)).length;
  });
  return n;
}

/** The rows HintPane needs for these lines (border included). */
export function hintRows(lines: string[], extra: { head: string; items: string[] } | undefined, width: number): number {
  const inner = Math.max(1, width - 4);
  const out: string[] = [];
  for (const l of lines) out.push(...wrap(l, inner));
  if (extra) {
    out.push('', ...wrap(extra.head, inner));
    for (const i of extra.items) out.push(...wrap(i, inner));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.length ? out.length + 2 : 0;
}

/** A "Ports to forward:" line followed by indented ports becomes the pane's highlighted block. */
export function splitExtra(lines: string[]): { lines: string[]; extra?: { head: string; items: string[] } } {
  const at = lines.findIndex((l, i) => l.endsWith(':') && lines[i + 1]?.startsWith('  '));
  const head = lines[at];
  if (head === undefined) return { lines };
  let end = at + 1;
  while (lines[end]?.startsWith('  ')) end++;
  const rest = [...lines.slice(0, at), ...lines.slice(end)];
  // Two blank lines meet where the block was.
  const cleaned = rest.filter((l, i) => !(l === '' && (i === 0 || rest[i - 1] === '')));
  return { lines: cleaned, extra: { head: head.slice(0, -1), items: lines.slice(at + 1, end) } };
}

const ACTION = '\u0000';

export interface QuestionProps {
  state: SetupState;
  store: StateStore;
  active: () => boolean;
  /** "Quit setup" on a lookup that cannot go on. */
  quit(): void;
}

export function QuestionScreen(p: QuestionProps) {
  // A new card per question. Keyed children take the key as a parameter:
  // Solid re-runs a keyed child only when its function has one.
  return (
    <Show when={p.store.view()?.id} keyed>
      {(_key: string) => <QuestionCard {...p} />}
    </Show>
  );
}

function QuestionCard(p: QuestionProps) {
  const locale = useLocale();
  const L = useLayout();
  const view = () => p.store.view() as QuestionView;
  const [hi, setHi] = createSignal(0);
  // Typing after an error hides it until the next Enter.
  const [quiet, setQuiet] = createSignal(false);
  // A new field after an action that starts over ("Type the token again").
  const [gen, setGen] = createSignal(0);

  const inner = () => Math.max(10, L.cardW() - 6);
  const running = () => view().lookup.state === 'running';
  const actions = () => view().actions;
  const textual = () => view().kind === 'text' || view().kind === 'secret';

  const options = (): PickOption[] =>
    view().options.map((o) => ({ value: o.value, label: o.label, desc: o.desc, subtle: o.subtle, chosen: o.chosen }));
  const actionOptions = (): PickOption[] =>
    actions().map((a, i) => ({
      value: ACTION + a.id,
      label: a.label,
      subtle: i === 0 && options().length > 0 && !textual(),
    }));
  /** Select: the options and the actions in one list; multi and fields keep them apart. */
  const mainOptions = (): PickOption[] => (view().kind === 'select' ? [...options(), ...actionOptions()] : options());
  const separateActions = () => actions().length > 0 && (textual() || options().length === 0);

  const qLines = createMemo(() => paint(view().question, inner(), c.muted));
  const linkLines = createMemo(() => {
    const link = view().link;
    return link ? paint(link, inner(), c.accent, true) : [];
  });
  const lookupLines = createMemo<Line[]>(() => {
    const l = view().lookup;
    const w = inner();
    if (l.state === 'ok' && l.note) return marked('✔', l.note, w, c.ok);
    if (l.state === 'warn') return marked('!', l.note, w, c.warn);
    if (l.state === 'error') return marked('✖', l.error, w, c.fail);
    return [];
  });
  const statusLines = createMemo<Line[]>(() => {
    const w = inner();
    const out: Line[] = [];
    const err = view().error;
    if (err && !quiet()) out.push(...marked('✖', err, w, c.fail));
    const n = p.store.notice();
    if (n) {
      for (const text of n.text.split('\n')) {
        if (n.kind === 'info') out.push(...marked('›', text, w, c.text));
        else out.push(...marked('!', text, w, c.warn));
      }
    }
    return out;
  });

  // ---- the hint pane
  const hint = createMemo(() => {
    const v = view();
    const pre = v.kind === 'select' ? v.options[hi()]?.preview : undefined;
    const lines = [...(pre ? [pre, ''] : []), ...v.hint];
    while (lines[0] === '') lines.shift();
    while (lines.at(-1) === '') lines.pop();
    return splitExtra(lines);
  });
  const hintNeed = () => hintRows(hint().lines, hint().extra, L.hintW());

  // ---- the vertical budget: the card takes what it needs, the pane under it what is left
  const lookupRowCount = () => (running() ? 1 : lookupLines().length);
  const fixedRows = () =>
    CARD_CHROME +
    1 +
    qLines().length +
    (linkLines().length ? 1 + linkLines().length : 0) +
    1 +
    (statusLines().length ? 1 + statusLines().length : 0);
  const sideRows = () => {
    // Body rows next to the main picker or field.
    const acts = separateActions() ? 1 + pickerRows(actionOptions(), inner()) : 0;
    if (textual()) return 4 + lookupRowCount() + acts;
    if (!options().length) return lookupRowCount() + acts;
    return lookupRowCount() ? 1 + lookupRowCount() : 0;
  };
  const reserve = () => (L.side() || !hintNeed() ? 0 : Math.min(hintNeed(), 5));
  const pickerMax = () => Math.max(4, L.bodyRows() - fixedRows() - sideRows() - reserve());
  const cardRows = () => {
    const main =
      !textual() && options().length
        ? Math.min(pickerRows(mainOptions(), inner(), view().kind === 'multi'), pickerMax())
        : 0;
    return fixedRows() + sideRows() + main;
  };
  const hintMax = () => (L.side() ? L.bodyRows() : L.bodyRows() - cardRows());

  // ---- answering
  const submit = (v: string | string[]) => {
    setQuiet(false);
    void p.state.submit(v);
  };
  const act = async (id: ActionId) => {
    if (id === 'quit') return p.quit();
    await p.state.action(id);
    if (p.store.view()?.lookup.state === 'idle') setGen((g) => g + 1);
  };
  const pick = (v: string | string[]) => {
    if (typeof v === 'string' && v.startsWith(ACTION)) return void act(v.slice(1) as ActionId);
    submit(v);
  };

  const initialIndex = () => {
    const v = view();
    if (v.kind !== 'select') return 0;
    // Actions just appeared (an invite card, a failed lookup): start on the first one.
    if (actions().length) return options().length;
    return Math.max(
      0,
      v.options.findIndex((o) => o.value === v.initial),
    );
  };
  const fieldKey = () => `${view().id}|${view().kind}|${gen()}`;
  // A default that moves (the machine was detected meanwhile) moves the highlight too.
  const pickKey = () =>
    !textual() && options().length
      ? `${view().id}|${mainOptions()
          .map((o) => o.value)
          .join(',')}|${view().kind === 'select' ? view().initial : ''}|${gen()}`
      : '';
  const actionsKey = () =>
    separateActions()
      ? actions()
          .map((a) => a.id)
          .join(',')
      : '';
  const minError = () => (view().id === 'channels' ? q(locale(), 'channelsMin') : undefined);

  const body = (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <Show when={textual()}>
        <Show when={fieldKey()} keyed>
          {(_key: string) => (
            <Field
              secret={view().kind === 'secret'}
              initial={typeof view().initial === 'string' ? (view().initial as string) : ''}
              placeholder={view().placeholder}
              defaultText={view().defaultText}
              keepsSecret={view().keepsSecret}
              width={Math.min(64, inner())}
              disabled={running() || actions().length > 0}
              active={p.active}
              onChange={() => setQuiet(true)}
              onSubmit={submit}
            />
          )}
        </Show>
      </Show>
      <Show when={pickKey()} keyed>
        {(_key: string) => (
          <Picker
            options={mainOptions()}
            multi={view().kind === 'multi'}
            picked={view().kind === 'multi' && Array.isArray(view().initial) ? (view().initial as string[]) : undefined}
            min={view().min}
            minError={minError()}
            allKey={view().kind === 'multi'}
            initial={initialIndex()}
            width={inner()}
            maxRows={pickerMax()}
            active={() => p.active() && !running()}
            onMove={setHi}
            onConfirm={pick}
          />
        )}
      </Show>
      <box flexDirection="column" marginTop={!textual() && options().length && lookupRowCount() ? 1 : 0} flexShrink={0}>
        <Switch>
          <Match when={running()}>
            <box flexDirection="row" gap={1} flexShrink={0}>
              <Spinner />
              <text fg={c.text} wrapMode="none">
                {fit(view().lookup.state === 'running' ? (view().lookup as { label: string }).label : '', inner() - 2)}
              </text>
            </box>
          </Match>
          <Match when={lookupLines().length}>
            <Lines lines={lookupLines()} />
          </Match>
        </Switch>
      </box>
      <Show when={actionsKey()} keyed>
        {(_key: string) => (
          <box marginTop={1} flexShrink={0}>
            <Picker
              options={actionOptions()}
              width={inner()}
              active={() => p.active() && !running()}
              onConfirm={pick}
            />
          </box>
        )}
      </Show>
    </box>
  );

  return (
    <box flexDirection={L.side() ? 'row' : 'column'} gap={L.side() ? 1 : 0} flexGrow={1} alignItems="flex-start">
      <Card title={` ${view().badge} `} width={L.cardW()} active={p.active()}>
        <text fg={c.text} attributes={Bold} wrapMode="none">
          {fit(view().title, inner())}
        </text>
        <Lines lines={qLines()} />
        <Show when={linkLines().length}>
          <box flexDirection="column" marginTop={1} flexShrink={0}>
            <Lines lines={linkLines()} />
          </box>
        </Show>
        {body}
        <Show when={statusLines().length}>
          <box flexDirection="column" marginTop={1} flexShrink={0}>
            <Lines lines={statusLines()} />
          </box>
        </Show>
      </Card>
      <Show when={hintNeed() && hintMax() >= 3}>
        <HintPane lines={hint().lines} extra={hint().extra} width={L.hintW()} maxRows={hintMax()} />
      </Show>
    </box>
  );
}
