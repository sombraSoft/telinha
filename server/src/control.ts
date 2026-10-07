// The local control endpoint (/internal/* on LISTEN): status, doctor sessions,
// updates and shutdown for the CLI on this machine (cli/control.ts is the
// client). Callers prove they are local and allowed by reading a token only
// this process's user can read: <data>/run/control.token. Anything that is not
// exactly right (no token, a wrong one, a request that came through a proxy)
// gets the same 404 as an unknown path.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ControlStatus, PhoneTestLink, PhoneTestPoll, UpdateMode, UpdateResult } from './cli/control.ts';
import { FORWARDED } from './http.ts';

export interface ControlDeps {
  /** <data>/run/control.token */
  tokenFile: string;
  status: () => ControlStatus;
  /** Doctor sessions; null when the service has none (the routes then 404). */
  doctor?: {
    create(): PhoneTestLink;
    wait(id: string, maxMs: number): Promise<PhoneTestPoll>;
  } | null;
  update?: ((mode: UpdateMode) => Promise<UpdateResult>) | null;
  /** Called after the 202 is on its way. */
  shutdown: (reason: 'stop' | 'restart') => void;
  log?: (...a: unknown[]) => void;
  /** Tests: a fixed token. */
  token?: string;
}

export interface Control {
  handle(req: Request, url: URL): Promise<Response>;
  /** The request carries the right token and came straight to LISTEN (http.ts lifts Bun's idle timeout for it). */
  authorized(req: Request): boolean;
  /** After Bun.serve bound the port: a start that fails on a busy port never touches another instance's token. */
  writeToken(): void;
  /** At exit, only while the file still holds our token (a newer instance may own it now). */
  removeToken(): void;
}

const MAX_WAIT_MS = 30_000;
const ID_RE = /^[0-9a-f]{32}$/;
const MODES: readonly UpdateMode[] = ['check', 'scheduled', 'now'];
const notFound = () => new Response('Not found', { status: 404 });
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
// Hashing first makes the comparison constant-time whatever the lengths.
const digest = (s: string) => createHash('sha256').update(s).digest();

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createControl(deps: ControlDeps): Control {
  const token = deps.token ?? randomBytes(32).toString('hex');
  const expected = digest(`Bearer ${token}`);
  const log = deps.log ?? (() => {});

  const allowed = (req: Request) => {
    if (FORWARDED.some((h) => req.headers.has(h))) return false;
    const auth = req.headers.get('authorization');
    return auth !== null && timingSafeEqual(digest(auth), expected);
  };

  return {
    authorized: allowed,

    async handle(req, url) {
      if (!allowed(req)) return notFound();
      const path = url.pathname;
      const method = req.method;

      if (path === '/internal/status' && method === 'GET') return json(200, deps.status());

      if (path === '/internal/doctor/sessions' && method === 'POST' && deps.doctor) {
        return json(200, deps.doctor.create());
      }
      const session = /^\/internal\/doctor\/sessions\/([^/]+)$/.exec(path);
      if (session && method === 'GET' && deps.doctor) {
        if (!ID_RE.test(session[1]!)) return notFound();
        const wait = Number(url.searchParams.get('wait') ?? 0);
        const ms = Number.isFinite(wait) ? Math.max(0, Math.min(MAX_WAIT_MS, wait)) : 0;
        return json(200, await deps.doctor.wait(session[1]!, ms));
      }

      if (path === '/internal/update' && method === 'POST' && deps.update) {
        const mode = (await body(req)).mode;
        if (!MODES.includes(mode as UpdateMode)) return json(400, { error: `mode must be one of ${MODES.join(', ')}` });
        return json(200, await deps.update(mode as UpdateMode));
      }

      if (path === '/internal/shutdown' && method === 'POST') {
        const reason = (await body(req)).reason;
        if (reason !== 'stop' && reason !== 'restart') return json(400, { error: 'reason must be stop or restart' });
        // The answer first: the caller learns it was accepted before the listener goes away.
        setTimeout(() => deps.shutdown(reason), 50);
        return new Response(null, { status: 202 });
      }
      return notFound();
    },

    writeToken() {
      mkdirSync(dirname(deps.tokenFile), { recursive: true });
      // tmp + rename: a reader never sees half a token.
      const tmp = `${deps.tokenFile}.${process.pid}.tmp`;
      writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
      renameSync(tmp, deps.tokenFile);
    },

    removeToken() {
      try {
        if (readFileSync(deps.tokenFile, 'utf8').trim() !== token) return;
        unlinkSync(deps.tokenFile);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log('control: could not remove the token file', (e as Error).message);
      }
    },
  };
}
