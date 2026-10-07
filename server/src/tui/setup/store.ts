// Solid's view of the setup: the session is framework-free, so a version
// signal bumped by session.subscribe() makes every read below reactive. The
// install has its own store, its rows copied from the task list on every
// change; decide() waits for the user's Retry / Skip / Back pick.
import { batch, createMemo, createSignal, onCleanup } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { ApplyResult, TaskId, TaskRow } from '../../cli/setup/apply.ts';
import type { SetupSession } from '../../cli/setup/session.ts';
import type { SetupUiContext } from '../../cli/setup/ui.ts';

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

export type Decision = 'retry' | 'skip' | 'back' | 'abort';
export type ApplyStage = 'running' | 'failed' | 'done';

export function createApplyStore(tasks: SetupUiContext['tasks']) {
  const [rows, setRows] = createStore<TaskRow[]>([]);
  const [stage, setStage] = createSignal<ApplyStage>('running');
  const [failure, setFailure] = createSignal<{ id: TaskId; error: string } | null>(null);
  const [result, setResult] = createSignal<Extract<ApplyResult, { kind: 'done' }> | null>(null);
  let waiting: ((d: Decision) => void) | null = null;

  onCleanup(tasks.subscribe(() => setRows(reconcile(tasks.rows, { key: 'id' }))));

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
