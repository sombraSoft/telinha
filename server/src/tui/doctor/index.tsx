// `telinha doctor` on a terminal: the checklist screen in its own renderer.
// Loaded only through a dynamic import after prepareTui().
import type { CliContext } from '../../cli/args.ts';
import { createControlClient } from '../../cli/control.ts';
import { buildCheckContext, type DoctorCliDeps } from '../../cli/doctor.ts';
import { CHECKS } from '../../doctor/checks.ts';
import type { CheckContext } from '../../doctor/types.ts';
import { type RuntimeDeps, runTui } from '../runtime.tsx';
import { DoctorScreen } from './screen.tsx';

export { DoctorScreen, type DoctorScreenProps } from './screen.tsx';

/** Exit code: 1 when a check or the phone test failed, 130 on Ctrl+C, else 0. */
export async function runDoctorTui(
  o: { ctx: CliContext; flags: { phone?: boolean; local?: boolean }; deps: DoctorCliDeps },
  runtime?: RuntimeDeps,
): Promise<number> {
  const { ctx, deps } = o;
  const local = !!o.flags.local;
  const control = deps.control ?? createControlClient({ paths: ctx.paths, envFile: ctx.envFile, env: ctx.env });
  const build = async (): Promise<CheckContext> => ({
    ...(await buildCheckContext(ctx, { local, control })),
    ...deps.context,
    local,
  });
  // The first context also gives the phone test its ports; every re-run builds a fresh one.
  let first: Promise<CheckContext> | null = build();
  const firstCtx = await first;
  const buildContext = () => {
    const ready = first;
    first = null;
    return ready ?? build();
  };
  const phone =
    o.flags.phone !== false && !local
      ? { control, env: ctx.env, config: firstCtx.config, ...(deps.now ? { now: deps.now } : {}) }
      : null;
  return runTui<number>({
    locale: ctx.locale,
    env: ctx.env,
    onCtrlC: () => 130,
    ...(runtime ? { deps: runtime } : {}),
    app: (done) => (
      <DoctorScreen
        locale={ctx.locale}
        version={ctx.version}
        checks={deps.checks ?? CHECKS}
        buildContext={buildContext}
        phone={phone}
        {...(deps.checkTimeoutMs ? { checkTimeoutMs: deps.checkTimeoutMs } : {})}
        onExit={done}
      />
    ),
  });
}
