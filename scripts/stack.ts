// Local stack: the Bun server with a fake DEV_USER login, which supervises
// livekit-server itself as in production (INGRESS=external, MEDIA=self). Used
// by `bun run dev` (scripts/dev.ts) and, as `bun scripts/stack.ts --e2e`, by
// Playwright's webServer.
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBinaries, hostArch, hostOs } from '../server/src/bins.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_PORT = 8081;
// Same tree the server uses natively (bin/, config/, data/), kept inside the repo.
const HOME = join(ROOT, '.cache', 'telinha');
const BIN_DIR = join(HOME, 'bin');

export interface StackOptions {
  /** Origin the browser opens (PUBLIC_URL); must be http://localhost or 127.0.0.1. */
  publicUrl: string;
  /** Signaling URL for the browser; unset = the server derives PUBLIC_URL + /livekit (its gated signaling proxy). */
  livekitPublicUrl?: string;
  /** "<id>:<name>" fake login. */
  devUser?: string;
  /** Restart the server on source changes (bun --watch). */
  watch?: boolean;
  /** Static page directory; unset = web/dist. */
  webDir?: string;
  /** Extra env for the server (e.g. DEV_LOCALE). */
  env?: Record<string, string>;
  /** Room lifecycle: close after this long empty, poll this often (server defaults 300 / 5). */
  closeEmptySeconds?: number;
  pollSeconds?: number;
  /** Registry, rendered livekit.yaml and pidfile; unset = .cache/telinha/data. */
  dataDir?: string;
  livekitPorts?: { http: number; tcp: number; udp: number };
}

export interface Stack {
  /** Starts another child that is prefixed and stopped with the stack. */
  spawn(name: string, cmd: string[], cwd?: string): Bun.Subprocess;
  stop(): void;
}

function host() {
  try {
    return { os: hostOs(), arch: hostArch() };
  } catch {
    throw new Error(`no LiveKit binary for ${process.platform}/${process.arch}; put livekit-server in ${BIN_DIR}`);
  }
}

// A child's own children (the server's livekit-server, bun run -> vite) must
// go too: on Windows proc.kill() only ends the direct process.
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

/** Polls `url` until it answers 2xx with a body `ok` accepts; a dead child fails fast. */
async function waitFor(
  what: string,
  url: string,
  children: Map<string, Bun.Subprocess>,
  ok: (body: unknown) => boolean,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const [name, proc] of children) {
      if (proc.exitCode !== null) throw new Error(`${name} exited with code ${proc.exitCode} before ${what} was up`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok && ok(await res.json())) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what} (${url})`);
}

export async function startStack(opts: StackOptions): Promise<Stack> {
  const ports = opts.livekitPorts ?? { http: 7880, tcp: 7881, udp: 7882 };
  // The server finds it in BIN_DIR, as a native install would.
  await ensureBinaries(['livekit'], { ...host(), outDir: BIN_DIR, log: (m) => console.log(`[stack] ${m}`) });
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
    const env: Record<string, string> = {
      TELINHA_HOME: HOME,
      BIN_DIR,
      DATA_DIR: opts.dataDir ?? join(HOME, 'data'),
      INGRESS: 'external',
      MEDIA: 'self',
      // No STUN: LiveKit advertises 127.0.0.1 (rendered as node_ip), though it can still
      // offer this host's own IPv6 addresses as ICE candidates.
      LIVEKIT_NODE_IP: '127.0.0.1',
      LIVEKIT_PORT: String(ports.http),
      MEDIA_TCP_PORT: String(ports.tcp),
      MEDIA_UDP_PORT: String(ports.udp),
      IP_WATCH_SECONDS: '0',
      // No router port mapping or self-update from a dev checkout.
      UPNP: 'off',
      AUTO_UPDATE: 'off',
      DEV_USER: opts.devUser ?? '1:Dev',
      PUBLIC_URL: opts.publicUrl,
      LISTEN: `127.0.0.1:${SERVER_PORT}`,
      COOKIE_SECRET: 'dev-only-secret',
      LIVEKIT_API_KEY: 'devkey',
      // 32+ chars, or livekit-server logs an error with a stack trace on every start.
      // e2e/streaming.e2e.ts uses the same pair.
      LIVEKIT_API_SECRET: 'dev-only-livekit-secret-0123456789',
      GROUP_NAME: 'Dev',
      WEB_DIR: opts.webDir ?? join(ROOT, 'web', 'dist'),
      ...opts.env,
    };
    if (opts.closeEmptySeconds) env.CLOSE_EMPTY_SECONDS = String(opts.closeEmptySeconds);
    if (opts.pollSeconds) env.POLL_SECONDS = String(opts.pollSeconds);
    if (opts.livekitPublicUrl) env.LIVEKIT_PUBLIC_URL = opts.livekitPublicUrl;
    const entry = join('server', 'src', 'index.ts');
    spawn('server', opts.watch ? [process.execPath, '--watch', entry] : [process.execPath, entry], ROOT, env);

    // The server listens only once LiveKit answered; the state check keeps that a contract.
    await waitFor(
      'server',
      `http://127.0.0.1:${SERVER_PORT}/healthz`,
      children,
      (b) => (b as { children?: Record<string, string> }).children?.livekit === 'up',
    );
  } catch (e) {
    stop();
    throw e;
  }

  return { spawn: (name, cmd, cwd) => spawn(name, cmd, cwd), stop };
}

/**
 * Stand-in page directory for a server whose real page is served by Vite: the
 * server refuses a WEB_DIR without index.html, and in dev only Vite serves /r/.
 */
export async function placeholderWebDir(): Promise<string> {
  const dir = join(ROOT, '.cache', 'placeholder-web');
  await mkdir(dir, { recursive: true });
  // </head> is required: the server writes the command name into it.
  await Bun.write(
    join(dir, 'index.html'),
    '<!doctype html><head></head><p>dev: the page is served by Vite on http://localhost:5173/r/</p>',
  );
  return dir;
}

if (import.meta.main) {
  if (!process.argv.includes('--e2e')) {
    console.error('usage: bun scripts/stack.ts --e2e   (for local development use `bun run dev`)');
    process.exit(2);
  }
  // Production-like: the server serves the built page at /r/ and carries the
  // browser's LiveKit signaling through its signaling proxy at /livekit,
  // behind its login gate.
  if (!(await Bun.file(join(ROOT, 'web', 'dist', 'index.html')).exists())) {
    console.error('web/dist is missing: run bun run build first');
    process.exit(1);
  }
  // Fresh registry per run; a short lifecycle so the closing spec doesn't wait 5 min.
  // Only the registry: run/children.json must survive so the server can kill a
  // livekit-server left over from a run that was killed hard.
  const dataDir = join(ROOT, '.cache', 'e2e-data');
  const entries = await readdir(dataDir).catch(() => [] as string[]);
  for (const name of entries.filter((n) => n.startsWith('telinha.sqlite')))
    await rm(join(dataDir, name), { force: true });
  try {
    await startStack({
      publicUrl: 'http://localhost:8081',
      closeEmptySeconds: Number(process.env.CLOSE_EMPTY_SECONDS) || 4,
      pollSeconds: Number(process.env.POLL_SECONDS) || 1,
      dataDir,
    });
    console.log('[stack] ready on http://localhost:8081/r/');
  } catch (e) {
    console.error(`[stack] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
