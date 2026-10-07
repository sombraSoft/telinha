// The Review: every answer grouped by step (secrets only as "set" / "kept"),
// the web address, the notes the lookups left, and the way on: Apply, Apply
// with a new cookie secret, back to the questions, or quit without writing.
import { type Accessor, createMemo, createSignal, For, Show } from 'solid-js';
import { q } from '../../../cli/setup/qstrings.ts';
import type { ReviewRow, SetupState } from '../../../cli/setup/state.ts';
import { useKeys } from '../../keys.ts';
import { useLocale, useT } from '../../strings.ts';
import { c } from '../../theme.ts';
import { CARD_CHROME, fit, pad, useLayout, wrap } from '../../ui/layout.ts';
import { Bold, Card, Picker, type PickOption } from '../../ui/widgets.tsx';
import type { StateStore } from '../store.ts';
import { useS } from '../strings.ts';
import { type Line, Lines, marked, paint, pickerRows } from './question.tsx';

const STEP_W = 11;
const STEP_MAX = 14;
/** Answer rows the window keeps before the card gets tighter still. */
const MIN_ROWS = 3;

type Item = { kind: 'row'; row: ReviewRow } | { kind: 'line'; line: Line };

/** "Review · Step 6 of 7" for a step the setup state has no question in. */
export function stepBadge(store: StateStore, id: string, locale: Parameters<typeof q>[0]): string {
  const steps = store.steps();
  const i = steps.findIndex((s) => s.id === id);
  return q(locale, 'badge', { step: steps[i]?.label ?? id, n: i + 1, total: steps.length });
}

export function ReviewScreen(p: {
  state: SetupState;
  store: StateStore;
  active: () => boolean;
  shownFile: string;
  docker: boolean;
  /** An earlier Apply wrote telinha.env before "Back to questions": the machine is not untouched any more. */
  appliedBefore?: boolean;
  onApply(rotate: boolean): void;
  onQuit(): void;
}) {
  const s = useS();
  const t = useT();
  const locale = useLocale();
  const L = useLayout();
  const fullW = () => (L.side() ? L.cardW() + L.hintW() + 1 : L.cardW());
  const inner = () => Math.max(10, fullW() - 6);
  const labelW = () => Math.min(42, Math.floor((fullW() - 15) / 2));
  // Wide enough for the longest step name ("Atualizações"), within reason.
  const stepW = () =>
    Math.min(STEP_MAX, Math.max(STEP_W, ...p.store.reviewRows().map((r) => Bun.stringWidth(r.step) + 1)));

  const options = (): PickOption[] => [
    { value: 'apply', label: s('review.apply'), desc: s(p.docker ? 'review.applyDescDocker' : 'review.applyDesc') },
    ...(p.store.applyOptions().canRotateCookie
      ? [{ value: 'rotate', label: s('review.rotate'), desc: s('review.rotateDesc') }]
      : []),
    { value: 'back', label: s('review.back'), desc: s('review.backDesc') },
    p.appliedBefore
      ? { value: 'quit', label: s('review.leave'), desc: s('review.leaveDesc') }
      : { value: 'quit', label: s('review.quit'), desc: s('review.quitDesc') },
  ];

  const introText = () => s(p.appliedBefore ? 'review.introAgain' : 'review.intro');
  const intro = createMemo(() => [
    ...paint(introText(), inner(), c.muted),
    ...paint(s('review.file', { file: p.shownFile }), inner(), c.muted),
  ]);
  const notes = createMemo<Line[]>(() => p.store.reviewNotes().flatMap((n) => marked('!', n, inner(), c.warn)));
  const notice = createMemo<Line[]>(() => {
    const n = p.store.notice();
    if (!n) return [];
    return n.text
      .split('\n')
      .flatMap((text) => marked(n.kind === 'info' ? '›' : '!', text, inner(), n.kind === 'info' ? c.text : c.warn));
  });
  const rows = () => p.store.reviewRows();

  // The card besides the answer rows: chrome, title, intro, the notes, the
  // notice, the choices and the margins between them.
  const around = (introRows: number, noteRows: number, picker: number) =>
    CARD_CHROME +
    1 +
    introRows +
    1 +
    (noteRows ? noteRows + 1 : 0) +
    (notice().length ? notice().length + 1 : 0) +
    1 +
    picker;
  const tightPicker = () =>
    options().length +
    Math.max(0, ...options().map((o) => (o.desc ? wrap(o.desc, Math.max(1, inner() - 5)).length : 0)));
  // full: everything shows. tight: the rows scroll and the choices keep only
  // the highlighted one's description. tiny (a short terminal): a one-line
  // intro, no descriptions, the notes scroll with the rows; the choices always fit.
  const mode = createMemo<'full' | 'tight' | 'tiny'>(() => {
    if (rows().length + around(intro().length, notes().length, pickerRows(options(), inner())) <= L.bodyRows())
      return 'full';
    if (L.bodyRows() - around(intro().length, notes().length, tightPicker()) >= MIN_ROWS + 2) return 'tight';
    return 'tiny';
  });
  const shownIntro = (): Line[] => (mode() === 'tiny' ? [{ text: fit(introText(), inner()), fg: c.muted }] : intro());
  const shownOptions = () => (mode() === 'tiny' ? options().map((o) => ({ ...o, desc: undefined })) : options());
  const items = createMemo<Item[]>(() => [
    ...rows().map((row): Item => ({ kind: 'row', row })),
    ...(mode() === 'tiny' && notes().length
      ? [{ text: '', fg: c.muted }, ...notes()].map((line): Item => ({ kind: 'line', line }))
      : []),
  ]);
  const budget = () => {
    const m = mode();
    const room =
      m === 'tiny'
        ? L.bodyRows() - around(1, 0, options().length)
        : L.bodyRows() -
          around(intro().length, notes().length, m === 'tight' ? tightPicker() : pickerRows(options(), inner()));
    return Math.max(3, room);
  };

  // PgUp/PgDn move the window.
  const [offset, setOffset] = createSignal(0);
  const windowed = () => items().length > budget();
  const size = () => (windowed() ? Math.max(1, budget() - 2) : items().length);
  const start = () => (windowed() ? Math.max(0, Math.min(offset(), items().length - size())) : 0);
  useKeys({
    key: (k) => {
      if (!p.active()) return false;
      if (k.name === 'pagedown')
        return setOffset(Math.min(start() + size(), Math.max(0, items().length - size()))), true;
      if (k.name === 'pageup') return setOffset(Math.max(0, start() - size())), true;
      return false;
    },
  });
  // A window that starts inside a step still names it.
  const shown = () =>
    items()
      .slice(start(), start() + size())
      .map((it, i): Item => {
        if (i !== 0 || it.kind !== 'row' || it.row.step) return it;
        return {
          kind: 'row',
          row: {
            ...it.row,
            step:
              rows()
                .slice(0, start())
                .findLast((x) => x.step)?.step ?? '',
          },
        };
      });
  const above = () => start();
  const below = () => Math.max(0, items().length - start() - size());

  const choose = (v: string | string[]) => {
    if (v === 'apply' || v === 'rotate') return p.onApply(v === 'rotate');
    if (v === 'back') return void p.state.back();
    p.onQuit();
  };

  return (
    <Card title={` ${stepBadge(p.store, 'review', locale())} `} width={fullW()} active={p.active()}>
      <text fg={c.text} attributes={Bold} wrapMode="none">
        {fit(s('review.title'), inner())}
      </text>
      <Lines lines={shownIntro()} />
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        <Show when={above()}>
          <text fg={c.muted} wrapMode="none">{`  ${t('common.moreAbove', { n: above() })}`}</text>
        </Show>
        <For each={shown()}>
          {(it) => (
            <Show
              when={it.kind === 'row' ? it.row : null}
              fallback={<Lines lines={it.kind === 'line' ? [it.line] : []} />}
            >
              {(r: Accessor<ReviewRow>) => (
                <box flexDirection="row" flexShrink={0}>
                  <text fg={c.accent} attributes={Bold} wrapMode="none">{`${pad(r().step, stepW() - 1)} `}</text>
                  <text fg={c.muted} wrapMode="none">{`${pad(r().label, labelW() - 1)} `}</text>
                  <text
                    fg={r().kind === 'url' ? c.accent : c.text}
                    attributes={r().kind === 'url' ? Bold : 0}
                    wrapMode="none"
                  >
                    {fit(r().value, Math.max(1, inner() - stepW() - labelW()))}
                  </text>
                </box>
              )}
            </Show>
          )}
        </For>
        <Show when={below()}>
          <text fg={c.muted} wrapMode="none">{`  ${t('common.moreBelow', { n: below() })}`}</text>
        </Show>
      </box>
      <Show when={mode() !== 'tiny' && notes().length}>
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          <Lines lines={notes()} />
        </box>
      </Show>
      <Show when={notice().length}>
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          <Lines lines={notice()} />
        </box>
      </Show>
      <box marginTop={1} flexShrink={0}>
        <Picker
          options={shownOptions()}
          width={inner()}
          maxRows={mode() === 'tight' ? tightPicker() : undefined}
          active={p.active}
          onConfirm={choose}
        />
      </box>
    </Card>
  );
}
