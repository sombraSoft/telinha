// Screen chrome: the header with the TV mascot, the step sidebar and the
// key-help footer.
import { useTerminalDimensions } from '@opentui/solid';
import { For, Show } from 'solid-js';
import { isDown, isEnter, isUp, useKeys } from '../keys.ts';
import { useT } from '../strings.ts';
import { c } from '../theme.ts';
import { fit, SIDEBAR_WIDTH, width, wrap } from './layout.ts';
import { Bold, Spinner } from './widgets.tsx';

/** TV mascot + name, four rows. */
export function Header(props: { mode: 'setup' | 'doctor'; version: string; right?: string }) {
  const t = useT();
  return (
    <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
      <box flexDirection="column" flexShrink={0}>
        <text fg={c.accent}>{' \\ /'}</text>
        <text fg={c.accent}>╭───╮</text>
        <text fg={c.accent}>│•‿•│</text>
        <text fg={c.accent}>╰───╯</text>
      </box>
      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        <box flexDirection="row" gap={1}>
          <text fg={c.accent} attributes={Bold}>{t('app.name')}</text>
          <text fg={c.text}>{props.mode === 'setup' ? t('app.setup') : t('app.doctor')}</text>
        </box>
        <text fg={c.muted} wrapMode="none">{t('app.tagline')}</text>
      </box>
      <box flexDirection="column" paddingTop={1} alignItems="flex-end" flexShrink={0}>
        <text fg={c.muted}>{`v${props.version}`}</text>
        <Show when={props.right}>
          <text fg={c.muted} wrapMode="none">{props.right}</text>
        </Show>
      </box>
    </box>
  );
}

export type StepState = 'done' | 'current' | 'pending' | 'failed' | 'running';
export interface SidebarStep {
  id: string;
  label: string;
  state: StepState;
  summary?: string;
}

const ICON: Record<Exclude<StepState, 'running'>, string> = { done: '✔', current: '❯', pending: '○', failed: '✖' };
const INNER = SIDEBAR_WIDTH - 4;

export function Sidebar(props: {
  steps: SidebarStep[];
  focused: boolean;
  cursor: number;
  /** Rows it may take; a short terminal drops the blank rows between steps first, then the summaries. */
  maxRows?: number;
  onMove(i: number): void;
  onJump(i: number): void;
  onLeave(): void;
}) {
  const t = useT();
  /** A done step's summary: its parts on one line when they fit, else one line each. */
  const summary = (step: SidebarStep): string[] => {
    if (step.state !== 'done' || !step.summary) return [];
    const parts = step.summary.split('\n');
    const one = parts.join(' · ');
    return width(`  ${one}`) <= INNER ? [one] : parts;
  };
  const height = (gaps: boolean, sums: boolean) =>
    2 + props.steps.length * (gaps ? 2 : 1) + (sums ? props.steps.reduce((n, s) => n + summary(s).length, 0) : 0) + (props.focused ? wrap(t('common.sidebarFocus'), INNER).length : 0);
  const gaps = () => height(true, true) <= (props.maxRows ?? Infinity);
  const sums = () => gaps() || height(false, true) <= (props.maxRows ?? Infinity);
  useKeys({
    key: (k) => {
      if (!props.focused) return false;
      const n = props.steps.length;
      if (isUp(k)) return props.onMove((props.cursor - 1 + n) % n), true;
      if (isDown(k)) return props.onMove((props.cursor + 1) % n), true;
      if (isEnter(k) || k.name === 'right') return props.onJump(props.cursor), true;
      if (k.name === 'escape' || k.name === 'left') return props.onLeave(), true;
      // Everything else stays here while the sidebar has focus; Tab and Ctrl
      // keys go on to the app (focus toggle, quit).
      return k.name !== 'tab' && !k.ctrl;
    },
  });
  return (
    <box
      width={SIDEBAR_WIDTH}
      flexShrink={0}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={props.focused ? c.accent : c.muted}
      paddingLeft={1}
      paddingRight={1}
      title={props.focused ? ` ${t('keys.steps')} ` : undefined}
    >
      <For each={props.steps}>
        {(step, i) => {
          const cursor = () => props.focused && props.cursor === i();
          const color = () => (step.state === 'failed' ? c.fail : step.state === 'done' ? c.ok : step.state === 'pending' ? c.muted : c.accent);
          const label = () => fit(`${step.label}${cursor() ? '  ‹' : ''}`, INNER - 2);
          return (
            <box flexDirection="column" marginBottom={gaps() ? 1 : 0} flexShrink={0}>
              <box flexDirection="row">
                <Show when={step.state !== 'running'} fallback={<Spinner />}>
                  <text fg={color()}>{ICON[step.state as Exclude<StepState, 'running'>]}</text>
                </Show>
                <text
                  fg={cursor() ? c.accent : step.state === 'pending' ? c.muted : c.text}
                  attributes={step.state === 'current' || step.state === 'running' || cursor() ? Bold : 0}
                  wrapMode="none"
                >{` ${label()}`}</text>
              </box>
              <Show when={sums()}>
                <For each={summary(step)}>{(line) => <text fg={c.muted} wrapMode="none">{fit(`  ${line}`, INNER)}</text>}</For>
              </Show>
            </box>
          );
        }}
      </For>
      <Show when={props.focused}>
        <text fg={c.muted} wrapMode="word">{t('common.sidebarFocus')}</text>
      </Show>
    </box>
  );
}

/** Keys the footer leaves out first when the terminal is too narrow for all of them. */
const LOW_KEYS = ['1-9', 'tab', 'pgup/pgdn', 'ctrl+u', 'ctrl+r', 'a'];

/** The items that fit in `cols` columns: the low-priority keys go first, then the ones before the last (quit stays). */
export function fitFooter(items: [string, string][], cols: number): [string, string][] {
  const need = (xs: [string, string][]) => 2 + xs.reduce((n, [k, l]) => n + width(k) + 1 + width(l), 0) + 2 * Math.max(0, xs.length - 1);
  const out = [...items];
  for (const key of LOW_KEYS) {
    if (need(out) <= cols) return out;
    const i = out.findIndex(([k]) => k === key);
    if (i >= 0) out.splice(i, 1);
  }
  while (out.length > 1 && need(out) > cols) out.splice(out.length - 2, 1);
  return out;
}

/** Row of "key label" pairs, cut to the terminal's width. */
export function Footer(props: { items: [key: string, label: string][] }) {
  const dims = useTerminalDimensions();
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <For each={fitFooter(props.items, dims().width)}>
        {([key, label]) => (
          <box flexDirection="row" gap={1} marginRight={2} flexShrink={0}>
            <text fg={c.accent} attributes={Bold}>{key}</text>
            <text fg={c.muted}>{label}</text>
          </box>
        )}
      </For>
    </box>
  );
}
