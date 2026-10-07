// The doctor screen's state: check rows filled in live as runChecks reports,
// re-runs with a fresh context, and the phone test (the same session/long-poll
// loop as the plain doctor, but cancellable from a key).
import { batch, createMemo, createSignal, type Accessor } from 'solid-js';
import { createStore } from 'solid-js/store';
import { mediaPorts, PHONE_POLL_MS, PHONE_WAIT_MS, phoneHints, phoneRows, phoneStatus, type DoctorControl, type PhoneRow } from '../../cli/doctor.ts';
import { doctorStrings } from '../../cli/doctor-strings.ts';
import type { Locale } from '../../cli/strings.ts';
import type { DoctorReport, DoctorSessionState } from '../../cli/control.ts';
import type { Config } from '../../config.ts';
import { checkTitle, runChecks } from '../../doctor/checks.ts';
import type { Check, CheckContext, CheckResult, CheckStatus } from '../../doctor/types.ts';

export type RowStatus = CheckStatus | 'running';

export interface DoctorRow {
  key: string;
  title: string;
  status: RowStatus;
  summary: string;
  detail: string[];
  fix?: string;
}

export type PhoneState =
  | { kind: 'off' }
  | { kind: 'starting' }
  | { kind: 'notRunning' }
  | { kind: 'error'; message: string }
  | { kind: 'waiting'; url: string; deadline: number; opened: boolean }
  | { kind: 'skipped' }
  | { kind: 'expired' }
  | { kind: 'done'; status: CheckStatus };

export interface PhoneOptions {
  control: DoctorControl;
  env: Record<string, string | undefined>;
  config: Config | null;
  /** How long to wait for the phone; PHONE_WAIT_MS by default. */
  waitMs?: number;
  now?: () => number;
}

// Copies: the store wraps what it is given, and a result's arrays belong to the caller.
const fromResult = (r: CheckResult, i: number): DoctorRow => ({
  key: `${i}:${r.id}`, title: r.title, status: r.status, summary: r.summary, detail: [...(r.detail ?? [])], ...(r.fix ? { fix: r.fix } : {}),
});

function phoneRowStatus(row: PhoneRow, r: DoctorReport, hinted: boolean): CheckStatus {
  if (row.ok) return hinted ? 'warn' : 'ok';
  if (row.id === 'udp' || row.id === 'tcp') return !r.udp.ok && !r.tcp.ok ? 'fail' : 'warn';
  if (row.id === 'publish' || row.id === 'initial') return 'warn';
  return 'fail';
}

// Which row a hint explains.
const HINT_ROWS: Record<string, PhoneRow['id'][]> = {
  hintSignaling: ['signaling'], hintBoth: ['udp', 'tcp'], hintUdp: ['udp'], hintTcp: ['tcp'], hintIp: ['initial'],
};

/** The phone report as doctor rows, the hints as the fix of the row they explain. */
export function phoneReportRows(r: DoctorReport, config: Config | null, locale: Locale): DoctorRow[] {
  const s = (key: Parameters<typeof doctorStrings>[1], params?: Record<string, string | number>) => doctorStrings(locale, key, params);
  const ports = mediaPorts(config);
  const hints = phoneHints(r, ports, config?.livekitNodeIp ?? null);
  return phoneRows(r, ports, s).map((row) => {
    const fixes = hints.filter((h) => HINT_ROWS[h.key]?.includes(row.id)).map((h) => s(h.key, h.params));
    const status = phoneRowStatus(row, r, fixes.length > 0);
    return { key: `phone:${row.id}`, title: row.label, status, summary: row.value, detail: [], ...(fixes.length && status !== 'ok' ? { fix: fixes.join('\n') } : {}) };
  });
}

export function createDoctorState(o: {
  locale: Accessor<Locale>;
  checks: readonly Check[];
  buildContext: () => Promise<CheckContext>;
  initial?: CheckResult[];
  phone: PhoneOptions | null;
  checkTimeoutMs?: number;
}) {
  const pendingRows = (): DoctorRow[] =>
    o.checks.map((c, i) => ({ key: `${i}:${c.id}`, title: checkTitle(c.id, o.locale()), status: 'running', summary: '', detail: [] }));
  const [rows, setRows] = createStore<DoctorRow[]>(o.initial ? o.initial.map(fromResult) : pendingRows());
  const [running, setRunning] = createSignal(false);
  const [phone, setPhone] = createSignal<PhoneState>({ kind: 'off' });
  const [report, setReport] = createSignal<DoctorReport | null>(null);
  const now = o.phone?.now ?? Date.now;
  let runId = 0;
  let phoneId = 0;
  let cancelWait: () => void = () => {};
  let disposed = false;

  const phoneRowsNow = createMemo(() => {
    const r = report();
    return r ? phoneReportRows(r, o.phone?.config ?? null, o.locale()) : [];
  });

  async function run(): Promise<void> {
    const id = ++runId;
    batch(() => {
      setRunning(true);
      setRows(pendingRows());
    });
    let index = 0;
    try {
      const ctx = await o.buildContext();
      if (id !== runId || disposed) return;
      await runChecks(o.checks, ctx, (r) => {
        if (id !== runId || disposed) return;
        const i = index++;
        setRows(i, fromResult(r, i));
      }, o.checkTimeoutMs ? { timeoutMs: o.checkTimeoutMs } : {});
    } catch (e) {
      // The context itself could not be built: every row still pending fails with that reason.
      if (id !== runId || disposed) return;
      const msg = (e as Error).message;
      setRows((all) => all.map((row) => (row.status === 'running' ? { ...row, status: 'fail', summary: msg } : row)));
    } finally {
      if (id === runId && !disposed) setRunning(false);
    }
  }

  function phoneAvailable(): boolean {
    return o.phone !== null;
  }

  async function startPhone(): Promise<void> {
    const p = o.phone;
    if (!p) return;
    cancelWait();
    const id = ++phoneId;
    const stale = () => id !== phoneId || disposed;
    let cancelled = false;
    const interrupted = new Promise<null>((resolve) => {
      cancelWait = () => {
        cancelled = true;
        resolve(null);
      };
    });
    batch(() => {
      setReport(null);
      setPhone({ kind: 'starting' });
    });
    const ctl = p.control;
    let up = false;
    try {
      up = await ctl.available();
    } catch {
      up = false;
    }
    if (stale()) return;
    if (!up) return void setPhone({ kind: 'notRunning' });
    let session: { id: string; url: string; expiresAt: number };
    try {
      session = await ctl.doctorSession();
    } catch (e) {
      if (!stale()) setPhone({ kind: 'error', message: (e as Error).message });
      return;
    }
    if (stale()) return;
    const deadline = now() + (p.waitMs ?? PHONE_WAIT_MS);
    setPhone({ kind: 'waiting', url: session.url, deadline, opened: false });
    let state: DoctorSessionState = { state: 'pending' };
    try {
      while (!cancelled && now() < deadline) {
        const next = await Promise.race([ctl.doctorWait(session.id, Math.min(PHONE_POLL_MS, deadline - now())), interrupted]);
        if (!next || stale()) return;
        if (next.state === 'opened' || next.state === 'done') setPhone((s) => (s.kind === 'waiting' ? { ...s, opened: true } : s));
        state = next;
        if (state.state === 'done' || state.state === 'expired') break;
      }
    } catch (e) {
      if (!stale()) setPhone({ kind: 'error', message: (e as Error).message });
      return;
    }
    if (stale()) return;
    if (state.state === 'done' && state.report) {
      const r = state.report;
      batch(() => {
        setReport(r);
        setPhone({ kind: 'done', status: phoneStatus(r) });
      });
    } else setPhone({ kind: state.state === 'expired' ? 'expired' : 'skipped' });
  }

  function skipPhone(): void {
    const s = phone().kind;
    if (s !== 'waiting' && s !== 'starting') return;
    phoneId++;
    cancelWait();
    setPhone({ kind: 'skipped' });
  }

  /** 1 when a check or the phone test failed, else 0. */
  const code = () => {
    const p = phone();
    return rows.some((r) => r.status === 'fail') || (p.kind === 'done' && p.status === 'fail') ? 1 : 0;
  };

  function dispose(): void {
    disposed = true;
    cancelWait();
  }

  return { rows, phoneRows: phoneRowsNow, running, phone, run, startPhone, skipPhone, phoneAvailable, code, dispose, now };
}

export type DoctorState = ReturnType<typeof createDoctorState>;
