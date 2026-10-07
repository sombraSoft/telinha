// The setup screens behind setup.ts's SetupUi: one renderer for the whole run,
// handed back (terminal restored) before setup.ts prints its plain epilogue.
// Loaded only through a dynamic import after prepareTui().
import type { SetupUi, SetupUiResult } from '../../cli/setup/ui.ts';
import { runTui } from '../runtime.tsx';
import { SetupApp } from './app.tsx';

export { SetupApp, type SetupAppProps } from './app.tsx';

export const setupUi: SetupUi = {
  run: (c) =>
    runTui<SetupUiResult>({
      locale: c.session.locale,
      env: c.ctx.env,
      onCtrlC: () => ({ kind: 'quit', reason: 'ctrl-c' }),
      app: (done, h) => <SetupApp c={c} done={done} withTerminal={h.withTerminal} setLocale={h.setLocale} />,
    }),
};
