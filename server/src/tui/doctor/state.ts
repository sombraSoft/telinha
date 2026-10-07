// The doctor screen's state: check rows filled in live as runChecks reports,
// re-runs with a fresh context, and the phone test (doctor/phone-test.ts: a
// version signal bumped by its subscribe() makes the reads reactive, as the
// setup store does for SetupSession).
import { type Accessor, batch, createComputed, createMemo, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { Locale } from '../../cli/strings.ts';
import type { Config } from '../../config.ts';
import { checkTitle, runChecks } from '../../doctor/checks.ts';
import { type DoctorControl, PhoneTest, type PhoneTestState } from '../../doctor/phone-test.ts';
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

/** off: not started yet (the checks run first), or no phone test at all. */
export type PhoneState = { kind: 'off' } | PhoneTestState;

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
  key: `${i}:${r.id}`,
  title: r.title,
  status: r.status,
  summary: r.summary,
  detail: [...(r.detail ?? [])],
  ...(r.fix ? { fix: r.fix } : {}),
});

export function createDoctorState(o: {
  locale: Accessor<Locale>;
  checks: readonly Check[];
  buildContext: () => Promise<CheckContext>;
  initial?: CheckResult[];
  phone: PhoneOptions | null;
  checkTimeoutMs?: number;
}) {
  const pendingRows = (): DoctorRow[] =>
    o.checks.map((c, i) => ({
      key: `${i}:${c.id}`,
      title: checkTitle(c.id, o.locale()),
      status: 'running',
      summary: '',
      detail: [],
    }));
  const [rows, setRows] = createStore<DoctorRow[]>(o.initial ? o.initial.map(fromResult) : pendingRows());
  const [running, setRunning] = createSignal(false);
  const now = o.phone?.now ?? Date.now;
  const p = o.phone;
  const test = p
    ? new PhoneTest({
        control: p.control,
        config: p.config,
        locale: o.locale(),
        now,
        ...(p.waitMs ? { waitMs: p.waitMs } : {}),
      })
    : null;
  const [version, setVersion] = createSignal(0);
  test?.subscribe(() => setVersion((n) => n + 1));
  createComputed(() => test?.setLocale(o.locale()));
  const phone = createMemo<PhoneState>(() => (version(), test?.state ?? { kind: 'off' }));
  // The phone report's rows below the checks; a hint is the fix of the row it explains.
  const phoneRows = createMemo<DoctorRow[]>(() => {
    const s = phone();
    if (s.kind !== 'done') return [];
    return s.rows.map((row) => ({
      key: `phone:${row.id}`,
      title: row.label,
      status: row.status,
      summary: row.value,
      detail: [],
      ...(row.hint ? { fix: row.hint } : {}),
    }));
  });
  let runId = 0;
  let disposed = false;

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
      await runChecks(
        o.checks,
        ctx,
        (r) => {
          if (id !== runId || disposed) return;
          const i = index++;
          setRows(i, fromResult(r, i));
        },
        o.checkTimeoutMs ? { timeoutMs: o.checkTimeoutMs } : {},
      );
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
    return test !== null;
  }

  async function startPhone(): Promise<void> {
    await test?.start();
  }

  function skipPhone(): void {
    test?.skip();
  }

  /** 1 when a check or the phone test failed, else 0. */
  const code = () => {
    const s = phone();
    return rows.some((r) => r.status === 'fail') || (s.kind === 'done' && s.status === 'fail') ? 1 : 0;
  };

  function dispose(): void {
    disposed = true;
    test?.dispose();
  }

  return { rows, phoneRows, running, phone, run, startPhone, skipPhone, phoneAvailable, code, dispose, now };
}

export type DoctorState = ReturnType<typeof createDoctorState>;
