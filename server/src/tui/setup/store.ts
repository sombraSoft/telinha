// Solid's view of the setup: the setup state is framework-free, so a version
// signal bumped by state.subscribe() makes every read below reactive. The
// install has its own store, its rows copied from the task list on every
// change; decide() waits for the user's Retry / Skip / Back pick.
import { batch, createMemo, createSignal, onCleanup } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { ApplyResult, TaskId, TaskRow } from '../../cli/setup/apply.ts';
import type { SetupState } from '../../cli/setup/state.ts';
import type { SetupUiContext } from '../../cli/setup/ui.ts';

export function createStateStore(state: SetupState) {
  const [version, setVersion] = createSignal(0);
  onCleanup(state.subscribe(() => setVersion((n) => n + 1)));
  const read =
    <T>(fn: () => T) =>
    () => (version(), fn());
  return {
    version,
    locale: read(() => state.locale),
    screen: read(() => state.screen()),
    view: createMemo(() => (version(), state.screen() === 'question' ? state.current() : null)),
    steps: createMemo(() => (version(), state.steps())),
    notice: read(() => state.notice()),
    reviewRows: read(() => state.reviewRows()),
    reviewNotes: read(() => state.reviewNotes()),
    applyOptions: read(() => state.applyOptions()),
  };
}

export type StateStore = ReturnType<typeof createStateStore>;

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
