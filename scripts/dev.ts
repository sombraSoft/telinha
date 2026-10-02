// `bun run dev`: LiveKit + the Bun server (DEV_USER login, restarts on change)
// + Vite with hot reload. Vite proxies /auth to the server and /livekit to
// LiveKit, so the browser only ever talks to localhost:5173.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeholderWebDir, startStack } from './stack.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dist = join(ROOT, 'web', 'dist');

try {
  const stack = await startStack({
    publicUrl: 'http://localhost:5173',
    watch: true,
    // The server refuses to start without a built page; Vite serves the real
    // one in dev, so a placeholder is fine before the first build.
    webDir: existsSync(join(dist, 'index.html')) ? dist : await placeholderWebDir(),
    env: process.env.DEV_LOCALE ? { DEV_LOCALE: process.env.DEV_LOCALE } : {},
    devUser: process.env.DEV_USER,
    // e.g. CLOSE_EMPTY_SECONDS=30 to watch a room close without waiting 5 min
    closeEmptySeconds: Number(process.env.CLOSE_EMPTY_SECONDS) || undefined,
    pollSeconds: Number(process.env.POLL_SECONDS) || undefined,
  });
  stack.spawn('vite', [process.execPath, 'run', '--filter', '@telinha/web', 'dev']);
  console.log('\n  open http://localhost:5173/sala/\n');
} catch (e) {
  console.error(`[dev] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
