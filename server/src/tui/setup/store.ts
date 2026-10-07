// Solid's view of the setup: the session is framework-free, so a version
// signal bumped by session.subscribe() makes every read below reactive. The
// install has its own store, filled by apply's events; decide() waits for the
// user's Retry / Skip / Back pick.
import { batch, createMemo, createSignal, onCleanup } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type { ApplyResult, TaskEvent, TaskId, TaskLine, TaskStatus } from '../../cli/setup/apply.ts';
import type { SetupSession } from '../../cli/setup/session.ts';

export function createSessionStore(session: SetupSession) {
  const [version, setVersion] = createSignal(0);
  onCleanup(session.subscribe(() => setVersion((n) => n + 1)));
  const read = <T>(fn: () => T) => () => (version(), fn());
  return {
    version,
    locale: read(() => session.locale),
    screen: read(() => session.screen()),
    view: createMemo(() => (version(), session.screen() === 'question' ? session.current() : null)),
    steps: createMemo(() => (version(), session.steps())),
    notice: read(() => session.notice()),
    reviewRows: read(() => session.reviewRows()),
    reviewNotes: read(() => session.reviewNotes()),
    applyOptions: read(() => session.applyOptions()),
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

export interface TaskRow {
  id: TaskId;
  status: TaskStatus;
  /** The running step's one-liner (spinner label, the UAC wait…). */
  detail: string;
  lines: TaskLine[];
  progress: TaskEvent['progress'] | null;
  /** The line that ended the task's spinner ("Service installed"): what a finished row shows. */
  result: string | null;
  /** A spinner is up: its next line is the result. */
  spinning: boolean;
}

export type Decision = 'retry' | 'skip' | 'back' | 'abort';
export type ApplyStage = 'running' | 'failed' | 'done';

export function createApplyStore() {
  const [rows, setRows] = createStore<TaskRow[]>([]);
  const [stage, setStage] = createSignal<ApplyStage>('running');
  const [failure, setFailure] = createSignal<{ id: TaskId; error: string } | null>(null);
  const [result, setResult] = createSignal<Extract<ApplyResult, { kind: 'done' }> | null>(null);
  let waiting: ((d: Decision) => void) | null = null;

  function emit(e: TaskEvent): void {
    const i = rows.findIndex((r) => r.id === e.id);
    if (i < 0) {
      setRows(rows.length, { id: e.id, status: e.status, detail: e.detail ?? '', lines: [...(e.lines ?? [])], progress: e.progress ?? null, result: null, spinning: false });
      return;
    }
    setRows(i, produce((r) => {
      // A bare 'running' starts an attempt: a retry's row starts clean.
      if (e.status === 'running' && !e.detail && !e.lines && !e.progress && !e.checks) {
        r.detail = '';
        r.lines = [];
        r.progress = null;
        r.result = null;
        r.spinning = false;
      }
      r.status = e.status;
      if (e.detail !== undefined) {
        r.detail = e.detail;
        r.spinning = true;
      }
      if (e.lines?.length) {
        if (r.spinning) r.result = e.lines[0]!.text;
        r.spinning = false;
        r.lines.push(...e.lines);
      }
      if (e.progress) r.progress = { ...e.progress };
    }));
  }

  return {
    rows,
    stage,
    failure,
    result,
    reset(): void {
      batch(() => {
        setRows([]);
        setStage('running');
        setFailure(null);
        setResult(null);
      });
    },
    emit,
    decide(id: TaskId, error: string): Promise<Decision> {
      batch(() => {
        setFailure({ id, error });
        setStage('failed');
      });
      return new Promise<Decision>((resolve) => (waiting = resolve));
    },
    /** The user's pick for the failed task; false when nothing is waiting. */
    choose(d: Decision): boolean {
      const w = waiting;
      if (!w) return false;
      waiting = null;
      batch(() => {
        setFailure(null);
        setStage('running');
      });
      w(d);
      return true;
    },
    finish(r: Extract<ApplyResult, { kind: 'done' }>): void {
      batch(() => {
        setResult(r);
        setStage('done');
      });
    },
  };
}

export type ApplyStore = ReturnType<typeof createApplyStore>;
