// Local stack: livekit-server --dev plus the Bun server with a fake DEV_USER
// login. Used by `bun run dev` (scripts/dev.ts) and, as
// `bun scripts/stack.ts --e2e`, by Playwright's webServer.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLivekit } from './livekit.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_PORT = 8081;

export interface StackOptions {
  /** Origin the browser opens (PUBLIC_URL); must be http://localhost or 127.0.0.1. */
  publicUrl: string;
  /** Signaling URL for the browser; unset = the server derives PUBLIC_URL + /livekit. */
  livekitPublicUrl?: string;
  /** "<id>:<name>" fake login. */
  devUser?: string;
  /** Restart the server on source changes (bun --watch). */
  watch?: boolean;
  /** Static page directory; unset = web/dist. */
  webDir?: string;
  /** Extra env for the server (e.g. DEV_LOCALE). */
  env?: Record<string, string>;
  livekitPorts?: { http: number; tcp: number; udp: number };
}

export interface Stack {
  /** Starts another child that is prefixed and stopped with the stack. */
  spawn(name: string, cmd: string[], cwd?: string): Bun.Subprocess;
  stop(): void;
}

// A child's own children (bun run -> vite, bun --watch) must go too: on
// Windows proc.kill() only ends the direct process.
function killTree(pid: number) {
  if (process.platform === 'win32') {
    try {
      Bun.spawnSync(['taskkill', '/pid', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' });
      return;
    } catch {
      // no taskkill: at least end the direct process below
    }
  }
  let out = '';
  try {
    out = Bun.spawnSync(['pgrep', '-P', String(pid)], { stderr: 'ignore' }).stdout.toString();
  } catch {
    // no pgrep (minimal images without procps): at least end the direct process
  }
  for (const child of out.split('\n').filter(Boolean)) killTree(Number(child));
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

async function pipe(name: string, stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream) {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of stream) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) out.write(`[${name}] ${line}\n`);
  }
  if (rest) out.write(`[${name}] ${rest}\n`);
}

async function waitFor(what: string, url: string, children: Map<string, Bun.Subprocess>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const [name, proc] of children) {
      if (proc.exitCode !== null) throw new Error(`${name} exited with code ${proc.exitCode} before ${what} was up`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what} (${url})`);
}

export async function startStack(opts: StackOptions): Promise<Stack> {
  const ports = opts.livekitPorts ?? { http: 7880, tcp: 7881, udp: 7882 };
  const livekit = await ensureLivekit();
  const children = new Map<string, Bun.Subprocess>();
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const proc of children.values()) {
      if (proc.exitCode !== null) continue;
      try {
        killTree(proc.pid);
      } catch {
        // keep stopping the others
      }
    }
  };
  process.on('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      stop();
      process.exit(130);
    });
  }

  const spawn = (name: string, cmd: string[], cwd = ROOT, env?: Record<string, string>) => {
    const proc = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.set(name, proc);
    void pipe(name, proc.stdout, process.stdout);
    void pipe(name, proc.stderr, process.stderr);
    // A dead child leaves the stack half-up; take the rest down with it.
    void proc.exited.then((code) => {
      if (stopped) return;
      console.error(`[stack] ${name} exited with code ${code}, stopping`);
      stop();
      process.exit(code || 1);
    });
    return proc;
  };

  try {
    // Loopback only, and advertised as 127.0.0.1 so ICE never leaves the machine.
    // --dev logs every packet event at debug; info keeps dev/CI output readable.
    spawn('livekit', [
      livekit,
      '--dev',
      '--bind', '127.0.0.1',
      '--node-ip', '127.0.0.1',
      '--keys', 'devkey: secret',
      '--config-body', `port: ${ports.http}\nlogging:\n  level: info\nrtc:\n  tcp_port: ${ports.tcp}\n  udp_port: ${ports.udp}\n`,
    ]);

    const env: Record<string, string> = {
      DEV_USER: opts.devUser ?? '1:Dev',
      PUBLIC_URL: opts.publicUrl,
      LISTEN: `127.0.0.1:${SERVER_PORT}`,
      COOKIE_SECRET: 'dev-only-secret',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
      GROUP_NAME: 'Dev',
      WEB_DIR: opts.webDir ?? join(ROOT, 'web', 'dist'),
      ...opts.env,
    };
    if (opts.livekitPublicUrl) env.LIVEKIT_PUBLIC_URL = opts.livekitPublicUrl;
    const entry = join('server', 'src', 'index.ts');
    spawn('server', opts.watch ? [process.execPath, '--watch', entry] : [process.execPath, entry], ROOT, env);

    await waitFor('livekit', `http://127.0.0.1:${ports.http}/`, children);
    await waitFor('server', `http://127.0.0.1:${SERVER_PORT}/healthz`, children);
  } catch (e) {
    stop();
    throw e;
  }

  return { spawn: (name, cmd, cwd) => spawn(name, cmd, cwd), stop };
}

/**
 * Stand-in page directory for a server whose real page is served by Vite: the
 * server refuses a WEB_DIR without index.html, and in dev only Vite serves /sala/.
 */
export async function placeholderWebDir(): Promise<string> {
  const dir = join(ROOT, '.cache', 'placeholder-web');
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, 'index.html'), '<!doctype html><p>dev: the page is served by Vite on http://localhost:5173/sala/</p>');
  return dir;
}

if (import.meta.main) {
  if (!process.argv.includes('--e2e')) {
    console.error('usage: bun scripts/stack.ts --e2e   (for local development use `bun run dev`)');
    process.exit(2);
  }
  // Production-like: the server serves the built page at /sala/ and the
  // browser talks to LiveKit directly.
  if (!(await Bun.file(join(ROOT, 'web', 'dist', 'index.html')).exists())) {
    console.error('web/dist is missing: run bun run build first');
    process.exit(1);
  }
  try {
    await startStack({ publicUrl: 'http://localhost:8081', livekitPublicUrl: 'ws://localhost:7880' });
    console.log('[stack] ready on http://localhost:8081/sala/');
  } catch (e) {
    console.error(`[stack] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
