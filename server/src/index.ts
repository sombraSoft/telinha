// Telinha: screen sharing for a Discord group. The entry point of the native
// binary, the Docker image and `bun server/src/index.ts`; cli/main.ts
// dispatches the commands and run.ts is the service. See README.md.
import { main } from './cli/main.ts';

const code = await main(process.argv.slice(2));
// null: `run` is up and the process lives on until a signal or the control endpoint ends it.
if (code !== null) process.exit(code);
