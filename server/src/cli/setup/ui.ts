// The contract between setup.ts and the setup screens (server/src/tui/setup):
// setup.ts builds the session, the task list and the apply runner, the screens
// drive them and own the terminal until they return. Types only, so nothing
// here pulls the screens (or Solid) into a plain run.
import type { Config } from '../../config.ts';
import type { DoctorControl } from '../../doctor/phone-test.ts';
import type { CheckContext } from '../../doctor/types.ts';
import type { CliContext } from '../args.ts';
import type { ApplyHooks, ApplyResult, TaskList } from './apply.ts';
import type { SetupSession } from './session.ts';

export interface SetupUiContext {
  ctx: CliContext;
  version: string;
  docker: boolean;
  session: SetupSession;
  /** What apply did, one row per task, across re-applies: the screens render the rows. */
  tasks: Pick<TaskList, 'subscribe' | 'rows' | 'wroteAny'>;
  /**
   * Runs apply for session.values() with session.applyOptions(), into tasks. The
   * UI owns the renderer, so it passes the hooks: decide (its retry/skip/back
   * picker) and withTerminal (runtime.tsx suspend/resume). May be called again
   * after a 'back' result (re-apply after changing answers).
   */
  apply(o: { rotateCookie: boolean }, hooks: ApplyHooks): Promise<ApplyResult>;
  /** `telinha` alone without a telinha.env: a welcome card first (Set up / Quit). */
  offer: { envFile: string } | null;
  /** For "Show the doctor report": rerun checks and the phone test; null when not native or --no-doctor. */
  doctor: { buildContext(): Promise<CheckContext>; control: DoctorControl; config(): Config | null } | null;
  /** The telinha.env path as the user finds it (the host's under --docker). */
  shownFile: string;
}

export type SetupUiResult =
  | { kind: 'declined' } // welcome card: Quit -> offerSetup resolves null
  | { kind: 'quit'; reason: 'ctrl-c' | 'review' } // left before or during apply without finishing
  | { kind: 'applied'; result: ApplyResult }; // apply reached done (or aborted after the file was written)

export interface SetupUi {
  run(c: SetupUiContext): Promise<SetupUiResult>;
}
