// The doctor as an interactive checklist: one row per check (spinner while it
// runs), Enter expands a row to its detail and fix, a summary line, and the
// phone test (link + QR) beside the list on wide terminals or under it.
// Also shown inside setup after the install (embedded: no header of its own).
import type { RGBA } from '@opentui/core';
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show, useContext } from 'solid-js';
import { doctorStrings } from '../../cli/doctor-strings.ts';
import type { Locale } from '../../cli/strings.ts';
import { canDrawBlocks } from '../../doctor/qr.ts';
import type { Check, CheckContext, CheckResult } from '../../doctor/types.ts';
import { isDown, isEnter, isSpace, isUp, useKeys } from '../keys.ts';
import { useLocale, useT } from '../strings.ts';
import { c } from '../theme.ts';
import { Footer, Header } from '../ui/chrome.tsx';
import {
  CARD_CHROME,
  ChromeCtx,
  createChrome,
  FOOTER_ROWS,
  fit,
  HEADER_ROWS,
  HINT_WIDTH,
  pad,
  useLayout,
  useTick,
  windowStart,
  wrap,
} from '../ui/layout.ts';
import { QrView, qrRows } from '../ui/qr.tsx';
import { Bold, Card, Spinner, StatusIcon, statusColor } from '../ui/widgets.tsx';
import { createDoctorState, type DoctorRow, type PhoneOptions } from './state.ts';

export interface DoctorScreenProps {
  locale: Locale;
  version: string;
  checks: readonly Check[];
  /** r re-runs: fresh context, all rows back to spinners. */
  buildContext(): Promise<CheckContext>;
  /** Results already run (setup's apply): no first run. */
  initial?: CheckResult[];
  phone: PhoneOptions | null;
  /** Inside setup: no own Header; q/Esc = onExit. */
  embedded?: boolean;
  /** Embedded hosts that draw their own footer get the key help here instead. */
  onFooter?(items: [string, string][]): void;
  checkTimeoutMs?: number;
  onExit(code: number): void;
}

const TITLE_W = 26;
// "❯ ▸ ✔ " before the title, one space after it.
const ROW_LEAD = 6;
const INDENT = 6;

type Color = string | RGBA;
type Item =
  | { kind: 'row'; row: DoctorRow; index: number }
  | { kind: 'text'; text: string; fg: Color; bold?: boolean }
  | { kind: 'spin'; text: () => string }
  | { kind: 'qr'; url: string };

const blank: Item = { kind: 'text', text: '', fg: '' };

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Columns the checklist keeps when the QR code goes beside it. */
const MIN_CARD_W = 40;

export function DoctorScreen(p: DoctorScreenProps) {
  // Embedded, the header is setup's (its provider); alone, this screen's own.
  if (p.embedded) return <DoctorBody {...p} />;
  return (
    <ChromeCtx.Provider value={createChrome()}>
      <DoctorBody {...p} />
    </ChromeCtx.Provider>
  );
}

function DoctorBody(p: DoctorScreenProps) {
  const t = useT();
  const locale = useLocale();
  const ds = (key: Parameters<typeof doctorStrings>[1], params?: Record<string, string | number>) =>
    doctorStrings(locale(), key, params);
  const L = useLayout({ sidebar: !!p.embedded });
  const chrome = useContext(ChromeCtx);
  onCleanup(() => chrome.setHeaderHidden(false));
  const tick = useTick();
  const st = createDoctorState({
    locale,
    checks: p.checks,
    buildContext: () => p.buildContext(),
    phone: p.phone,
    ...(p.initial ? { initial: p.initial } : {}),
    ...(p.checkTimeoutMs ? { checkTimeoutMs: p.checkTimeoutMs } : {}),
  });
  onCleanup(st.dispose);
  onMount(() => {
    if (p.initial) {
      if (p.phone) void st.startPhone();
      return;
    }
    void st.run().then(() => {
      if (p.phone) void st.startPhone();
    });
  });

  const [hi, setHi] = createSignal(0);
  const [open, setOpen] = createSignal<string[]>([]);
  const all = (): DoctorRow[] => [...st.rows, ...st.phoneRows()];
  const sel = () => Math.max(0, Math.min(hi(), all().length - 1));

  const waiting = () => st.phone().kind === 'waiting' || st.phone().kind === 'starting';
  useKeys({
    key: (k) => {
      if (k.ctrl || k.meta) return false;
      const n = all().length;
      if (isUp(k)) return n && setHi((sel() - 1 + n) % n), true;
      if (isDown(k)) return n && setHi((sel() + 1) % n), true;
      if (isEnter(k) || isSpace(k) || k.name === 'right') {
        const key = all()[sel()]?.key;
        if (key) setOpen((o) => (o.includes(key) ? o.filter((x) => x !== key) : [...o, key]));
        return true;
      }
      if (k.name === 'r') return !st.running() && void st.run(), true;
      if (k.name === 'p') return st.phoneAvailable() && !st.running() && void st.startPhone(), true;
      if (k.name === 's') return st.skipPhone(), true;
      if (k.name === 'q' || k.name === 'escape') return p.onExit(st.code()), true;
      return false;
    },
  });

  const footer = createMemo<[string, string][]>(() => [
    ['↑↓', t('keys.move')],
    ['enter', t('keys.details')],
    ['r', t('keys.rerun')],
    ...(st.phoneAvailable() ? [['p', t('keys.phone')] as [string, string]] : []),
    ...(waiting() ? [['s', t('keys.skip')] as [string, string]] : []),
    ['q', t('keys.quit')],
  ]);
  createEffect(() => p.onFooter?.(footer()));

  // ---- geometry
  const blocks = () => canDrawBlocks(p.phone?.env ?? {});
  const phoneUrl = () => {
    const s = st.phone();
    return s.kind === 'waiting' ? s.url : null;
  };
  const qr = createMemo(() => {
    const url = phoneUrl();
    return url ? qrRows(url, blocks()) : [];
  });
  const qrW = () => qr()[0]?.reduce((w, r) => w + r.text.length, 0) ?? 0;
  const panelShown = () => !['off', 'done'].includes(st.phone().kind);
  const total = () => (L.side() ? L.cardW() + L.hintW() + 1 : L.cardW());
  // Where the QR code goes while the link waits: beside the list when both
  // fit side by side, else alone in the list's place until the phone answers
  // (compact); with the header hidden when that is what makes it fit; or not
  // at all (the link and "make the window larger") when even that is short.
  // The panel: border, the link's lines, the status line, the code.
  const qrPlan = createMemo(() => {
    const url = phoneUrl();
    if (!url) return { show: false, compact: false, hideHeader: false };
    const rows = L.height() - FOOTER_ROWS;
    /** The panel at this inner width: border, the link's lines, the status line, the code. */
    const fits = (w: number) => {
      const need = 2 + wrap(ds('phoneOpen'), w).length + wrap(url, w).length + 1 + qr().length;
      return need <= rows - HEADER_ROWS ? 'header' : need <= rows ? 'noHeader' : null;
    };
    const sideW = Math.max(HINT_WIDTH, qrW() + 4);
    const beside = L.side() && total() - sideW - 1 >= MIN_CARD_W ? fits(sideW - 4) : null;
    if (beside) return { show: true, compact: false, hideHeader: beside === 'noHeader' };
    const alone = qrW() + 6 <= total() ? fits(total() - 6) : null;
    if (alone) return { show: true, compact: true, hideHeader: alone === 'noHeader' };
    // The link only: beside the list when there is room, else in its place until the phone answers.
    return { show: false, compact: !L.side(), hideHeader: false };
  });
  createEffect(() => chrome.setHeaderHidden(qrPlan().hideHeader));
  const compact = () => qrPlan().compact;
  const besides = () => L.side() && panelShown() && !compact();
  const panelW = () => Math.max(HINT_WIDTH, qrPlan().show ? qrW() + 4 : 0);
  const cardW = () => (besides() ? total() - panelW() - 1 : total());
  const inner = () => Math.max(10, cardW() - 6);
  const panelInner = () => (besides() ? panelW() - 4 : inner());

  const panelItems = createMemo<Item[]>(() => {
    const s = st.phone();
    const w = panelInner();
    const lines = (text: string, fg: Color): Item[] => wrap(text, w).map((l) => ({ kind: 'text', text: l, fg }));
    switch (s.kind) {
      case 'starting':
        return [{ kind: 'spin', text: () => t('doctor.phoneStarting') }];
      case 'notRunning':
        return lines(ds('phoneNotRunning'), c.warn);
      case 'error':
        return lines(ds('phoneError', { error: s.message }), c.fail);
      case 'waiting': {
        // Read per tick, so the countdown moves without rebuilding the QR code.
        const spin: Item = {
          kind: 'spin',
          text: () => (
            tick(), s.opened ? ds('phoneOpened') : t('doctor.phoneLeft', { time: clock(s.deadline - st.now()) })
          ),
        };
        const head = [...lines(ds('phoneOpen'), c.text), ...lines(s.url, c.accent)];
        // The status above the code; a code that would be cut is not drawn at all (it would not scan).
        if (qrPlan().show) return [...head, spin, { kind: 'qr', url: s.url }];
        return [...head, spin, blank, ...lines(t('doctor.qrTooBig'), c.muted)];
      }
      case 'skipped':
        return [...lines(ds('phoneSkipped'), c.muted), ...lines(t('doctor.phoneAgain'), c.muted)];
      case 'expired':
        return [...lines(ds('phoneExpired'), c.warn), ...lines(t('doctor.phoneAgain'), c.muted)];
      default:
        return [];
    }
  });
  const itemRows = (items: Item[]) => items.reduce((n, i) => n + (i.kind === 'qr' ? qr().length : 1), 0);

  // Card content rows: title, intro, blank, list, blank, summary (+ the phone panel under it when narrow).
  const under = () => panelShown() && !besides() && !compact();
  const listBudget = () => {
    const room = L.bodyRows() - CARD_CHROME - 5 - (under() ? 2 + itemRows(panelItems()) : 0);
    return Math.max(3, room);
  };

  let prevStart = 0;
  const listItems = createMemo<Item[]>(() => {
    const rows = all();
    const out: Item[] = [];
    let first = -1;
    let last = -1;
    rows.forEach((row, i) => {
      if (i === st.rows.length && i > 0)
        out.push(blank, { kind: 'text', text: ds('phoneTitle'), fg: c.text, bold: true });
      if (i === sel()) first = out.length;
      out.push({ kind: 'row', row, index: i });
      if (open().includes(row.key)) {
        const w = Math.max(4, inner() - INDENT);
        // The row cuts a long summary: open, it reads in full first.
        const cut = row.status !== 'running' && Bun.stringWidth(row.summary) > summaryWidth(inner());
        for (const d of cut ? [row.summary, ...row.detail] : row.detail)
          for (const l of wrap(d, w)) out.push({ kind: 'text', text: ' '.repeat(INDENT) + l, fg: c.muted });
        const showFix = row.fix && row.status !== 'ok' && row.status !== 'running';
        if (showFix) {
          out.push({ kind: 'text', text: `${' '.repeat(INDENT)}└ ${t('doctor.fix')}`, fg: c.text, bold: true });
          for (const l of wrap(row.fix!, w - 2))
            out.push({ kind: 'text', text: `${' '.repeat(INDENT + 2)}${l}`, fg: c.text });
        }
        if (!row.detail.length && !showFix)
          out.push({ kind: 'text', text: `${' '.repeat(INDENT)}${t('doctor.nothing')}`, fg: c.muted });
        out.push(blank);
      }
      if (i === sel()) last = out.length - 1;
    });
    const budget = listBudget();
    if (out.length <= budget) {
      prevStart = 0;
      return out;
    }
    const size = Math.max(1, budget - 2);
    let start = windowStart(Math.max(0, first), out.length, size, prevStart);
    if (last >= start + size) start = Math.min(first, last - size + 1);
    prevStart = start;
    const end = Math.min(out.length, start + size);
    const rowsIn = (from: number, to: number) => out.slice(from, to).filter((x) => x.kind === 'row').length;
    const above = rowsIn(0, start);
    const below = rowsIn(end, out.length);
    return [
      ...(above ? [{ kind: 'text', text: `  ${t('common.moreAbove', { n: above })}`, fg: c.muted } as Item] : []),
      ...out.slice(start, end),
      ...(below ? [{ kind: 'text', text: `  ${t('common.moreBelow', { n: below })}`, fg: c.muted } as Item] : []),
    ];
  });

  const counts = () => {
    const n = { ok: 0, warn: 0, fail: 0, skip: 0 };
    for (const r of st.rows) if (r.status !== 'running') n[r.status]++;
    return n;
  };
  const summary = () => {
    const n = counts();
    return [
      t('doctor.ok', { n: n.ok }),
      n.warn === 1 ? t('doctor.warn1') : t('doctor.warnN', { n: n.warn }),
      t('doctor.fail', { n: n.fail }),
      ...(n.skip ? [n.skip === 1 ? t('doctor.skip1') : t('doctor.skip', { n: n.skip })] : []),
    ].join(' · ');
  };
  const worst = () => {
    const n = counts();
    return n.fail ? c.fail : n.warn ? c.warn : c.ok;
  };

  const renderItem = (it: Item): JSX.Element => {
    switch (it.kind) {
      case 'row':
        return <RowLine row={it.row} sel={it.index === sel()} open={open().includes(it.row.key)} width={inner()} />;
      case 'spin':
        return (
          <box flexDirection="row" gap={1} flexShrink={0}>
            <Spinner />
            <text fg={c.muted} wrapMode="none">
              {fit(it.text(), panelInner() - 2)}
            </text>
          </box>
        );
      case 'qr':
        return <QrView text={it.url} env={p.phone?.env ?? {}} />;
      case 'text':
        return (
          <text fg={it.fg || c.muted} attributes={it.bold ? Bold : 0} wrapMode="none">
            {it.text === '' ? ' ' : it.text}
          </text>
        );
    }
  };

  return (
    <box flexDirection="column" flexGrow={1}>
      <Show when={!p.embedded && !chrome.headerHidden()}>
        <Header mode="doctor" version={p.version} />
      </Show>
      <box
        flexDirection="row"
        height={L.bodyRows()}
        flexShrink={0}
        gap={1}
        paddingLeft={p.embedded ? 0 : 1}
        paddingRight={p.embedded ? 0 : 1}
        alignItems="flex-start"
        overflow="hidden"
      >
        <Show when={compact()}>
          <box
            flexDirection="column"
            border
            borderStyle="rounded"
            borderColor={c.accent}
            title={` ${ds('phoneTitle')} `}
            paddingLeft={2}
            paddingRight={2}
            width={total()}
            flexShrink={0}
          >
            <For each={panelItems()}>{renderItem}</For>
          </box>
        </Show>
        <Show when={!compact()}>
          <Card title={` ${t('doctor.title')} `} width={cardW()}>
            <text fg={c.text} attributes={Bold}>
              {t('doctor.title')}
            </text>
            <text fg={c.muted} wrapMode="none">
              {fit(t('doctor.intro'), inner())}
            </text>
            <box flexDirection="column" marginTop={1} flexShrink={0}>
              <For each={listItems()}>{renderItem}</For>
            </box>
            <box marginTop={1} flexDirection="row" gap={1} flexShrink={0}>
              <Show
                when={!st.running()}
                fallback={
                  <>
                    <Spinner />
                    <text fg={c.muted}>{t('doctor.running')}</text>
                  </>
                }
              >
                <text fg={worst()} attributes={Bold} wrapMode="none">
                  {fit(summary(), inner())}
                </text>
              </Show>
            </box>
            <Show when={under()}>
              <box flexDirection="column" marginTop={1} flexShrink={0}>
                <text fg={c.text} attributes={Bold}>
                  {ds('phoneTitle')}
                </text>
                <For each={panelItems()}>{renderItem}</For>
              </box>
            </Show>
          </Card>
        </Show>
        <Show when={besides()}>
          <box
            flexDirection="column"
            border
            borderStyle="rounded"
            borderColor={c.muted}
            title={` ${ds('phoneTitle')} `}
            paddingLeft={1}
            paddingRight={1}
            width={panelW()}
            flexShrink={0}
          >
            <For each={panelItems()}>{renderItem}</For>
          </box>
        </Show>
      </box>
      <Show when={!p.onFooter}>
        <Footer items={footer()} />
      </Show>
    </box>
  );
}

/** Columns a row's summary gets beside its title. */
const summaryWidth = (width: number) => Math.max(4, width - ROW_LEAD - TITLE_W - 1);

function RowLine(props: { row: DoctorRow; sel: boolean; open: boolean; width: number }) {
  const sumW = () => summaryWidth(props.width);
  const fg = () =>
    props.row.status === 'running' || props.row.status === 'ok' || props.row.status === 'skip'
      ? c.muted
      : statusColor(props.row.status);
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={c.accent}>{props.sel ? '❯ ' : '  '}</text>
      <text fg={c.muted}>{props.open ? '▾ ' : props.sel ? '▸ ' : '  '}</text>
      <StatusIcon status={props.row.status} />
      <text
        fg={props.sel ? c.accent : c.text}
        attributes={props.sel ? Bold : 0}
        wrapMode="none"
      >{` ${pad(props.row.title, TITLE_W)} `}</text>
      <text fg={fg()} wrapMode="none">
        {props.row.status === 'running' ? '…' : fit(props.row.summary, sumW())}
      </text>
    </box>
  );
}
