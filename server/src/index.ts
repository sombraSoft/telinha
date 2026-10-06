// Telinha: screen sharing for a Discord group. The entry point of the native
// binary, the Docker image and `bun server/src/index.ts`; cli/main.ts
// dispatches the commands and run.ts is the service. See README.md.
import { main } from './cli/main.ts';
import { prepareTui } from './tui/load.ts';

// Build smoke for CI: renders a tiny OpenTUI screen and presses a key, so a binary
// or image without the native library or a reactive Solid fails here, not in setup.
if (process.env.TELINHA_SMOKE_TUI === '1') {
  await prepareTui();
  const tui = await (await import('./tui/smoke.tsx')).smoke();
  if (tui !== 0) process.exit(tui);
}

const code = await main(process.argv.slice(2));
// null: `run` is up and the process lives on until a signal or the control endpoint ends it.
if (code !== null) process.exit(code);
