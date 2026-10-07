// Client for the running service's local control endpoint (/internal/* on
// LISTEN, bearer token in <data>/run/control.token), plus every payload type
// that endpoint speaks, so the server, the doctor and the updater share one
// definition.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseListen } from '../config.ts';
import { loadEnvFile, mergeEnv } from '../envfile.ts';
import type { Paths } from '../paths.ts';
import { upstreamHost } from '../render.ts';

// ---------------------------------------------------------------- payloads

/** Port mapper state, structurally (the nat module's MapperStatus satisfies it). */
export interface MapperStatusLike {
  enabled: boolean;
  gateway: { kind: string; gatewayIp: string; localIp?: string } | null;
  externalIp: string | null;
  mappings: {
    protocol: 'tcp' | 'udp';
    externalPort: number;
    internalPort: number;
    description: string;
    state: 'mapped' | 'failed' | 'pending';
    leaseEndsAt?: number;
    error?: string;
  }[];
}

/** An update installed but not yet confirmed by a successful start. */
export interface UpdateStaged {
  tag: string;
  previous: string;
  previousFile: string;
  /** The tray file stage() renamed aside, when it replaced the tray. */
  trayPreviousFile?: string;
  at: number;
  failedStarts: number;
}
/** The last staged update that proved itself (its version started fine). */
export interface UpdateApplied {
  tag: string;
  previous: string;
  at: number;
}
export interface UpdateFailed {
  tag: string;
  at: number;
  reason: string;
}
/** Seen as latest but its assets were not downloadable yet (404/network): retried, never failed. */
export interface UpdatePending {
  tag: string;
  since: number;
}

export interface UpdateStatus {
  /** AUTO_UPDATE on (and compiled). */
  enabled: boolean;
  current: string;
  /** Newest stable tag at the last check; null before one or when offline. */
  latest: string | null;
  pin: string | null;
  staged: UpdateStaged | null;
  /** The last update that started fine; null before the first one. */
  applied: UpdateApplied | null;
  failed: UpdateFailed | null;
  pending: UpdatePending | null;
  /** Rooms were open when an update was due: deferring since then. */
  deferredSince: number | null;
  lastCheck: number | null;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  pin: string | null;
  /** The tag that would be installed now; null = up to date. */
  target: string | null;
  staged: UpdateStaged | null;
  failed: UpdateFailed | null;
  pending: UpdatePending | null;
  deferredSince: number | null;
}

export type UpdateAction = 'none' | 'staged' | 'deferred' | 'failed' | 'pending';
export interface UpdateResult extends UpdateCheck {
  action: UpdateAction;
  /** One line for the CLI, e.g. "2 room(s) open, will update when they close". */
  message: string;
}
/** check never writes; scheduled applies unless rooms defer it; now applies. */
export type UpdateMode = 'check' | 'scheduled' | 'now';

/** One supervised child, as the supervisor's status() reports it. */
export interface ChildStatus {
  state: 'starting' | 'up' | 'restarting' | 'stopped';
  pid: number | null;
  /** Successful crash respawns since start (restart() does not count). */
  restarts: number;
  /** Respawn attempts within the last 10 minutes, failed attempts included: the crash-loop signal. */
  recentRestarts: number;
  /** When `state` was last set (epoch ms). */
  since: number;
}

export interface ControlStatus {
  version: string;
  startedAt: number;
  pid: number;
  ingress: 'direct' | 'tunnel' | 'external';
  media: 'self' | 'cloud';
  /** Open rooms. */
  rooms: number;
  /** Child process states, e.g. { livekit: 'up' }. */
  children: Record<string, string>;
  /** Per-child detail; `children` stays for /healthz and older clients. */
  childStatus: Record<string, ChildStatus>;
  publicIp: string | null;
  upnp: MapperStatusLike | null;
  ddns: { ip: string | null; at: number; ok: boolean } | null;
  update: UpdateStatus | null;
  /** Running under `telinha service run`. */
  supervised: boolean;
  turn?: { host: string; port: number } | null;
}

/** What the phone test page measured. */
export interface DoctorReport {
  https: { ok: boolean; latencyMs: number | null };
  signaling: { ok: boolean; error?: string };
  /** The pair LiveKit picked before any forcing; null when the connection never came up. */
  initial: { protocol: string; candidateIp: string | null; rttMs: number | null } | null;
  tcp: { ok: boolean; rttMs?: number; error?: string };
  udp: { ok: boolean; rttMs?: number; error?: string };
  publish: { ok: boolean; error?: string };
  /** The forced TURN over TLS step; absent or null when the page had no such step. */
  turn?: { ok: boolean; rttMs?: number; error?: string } | null;
  client: { ua: string; ip?: string };
  startedAt: number;
  finishedAt: number;
}

/** A phone test's long-poll answer. The routes keep their older "sessions" name: an older service talks to a newer CLI. */
export interface PhoneTestPoll {
  state: 'pending' | 'opened' | 'done' | 'expired';
  openedAt?: number;
  report?: DoctorReport;
}

/** The phone test's one-time link. */
export interface PhoneTestLink {
  id: string;
  url: string;
  expiresAt: number;
}

// ---------------------------------------------------------------- client

export interface ControlClient {
  /** Token file present and GET /internal/status answers. */
  available(): Promise<boolean>;
  status(): Promise<ControlStatus>;
  doctorSession(): Promise<PhoneTestLink>;
  doctorWait(id: string, waitMs: number): Promise<PhoneTestPoll>;
  update(mode: UpdateMode): Promise<UpdateResult>;
  shutdown(reason: 'stop' | 'restart'): Promise<void>;
}

/** No token file: the service is not running (or another home is in use). */
export class ControlUnavailableError extends Error {
  constructor(message = 'telinha is not running (no control token)') {
    super(message);
    this.name = 'ControlUnavailableError';
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_LISTEN = '127.0.0.1:8081';

/** Where the running service listens: LISTEN from telinha.env plus the environment over it, like configure(). */
export function controlBaseUrl(envFile: string, env: Record<string, string | undefined> = process.env): string {
  let fileVars: Record<string, string> = {};
  try {
    fileVars = loadEnvFile(envFile)?.vars ?? {};
  } catch {
    // unreadable: the environment alone (Docker passes config that way anyway)
  }
  const merged = mergeEnv(fileVars, env);
  let listen: { host: string; port: number };
  try {
    listen = parseListen(merged.LISTEN || DEFAULT_LISTEN);
  } catch {
    listen = parseListen(DEFAULT_LISTEN);
  }
  return `http://${upstreamHost(listen.host)}:${listen.port}`;
}

/** What control.ts writes: 32 random bytes in hex. */
const TOKEN_RE = /^[0-9a-f]{64}$/;

export function createControlClient(o: {
  paths: Pick<Paths, 'run'>;
  envFile: string;
  fetch?: FetchFn;
  env?: Record<string, string | undefined>;
}): ControlClient {
  const fetchFn: FetchFn = o.fetch ?? fetch;
  const tokenFile = join(o.paths.run, 'control.token');
  // Read per call: the service writes a fresh token on every start. Only a
  // token's shape is ever sent: run/ belongs to the service user, who could
  // point control.token at a file only root can read (sudo telinha status).
  const token = (): string | null => {
    try {
      const t = readFileSync(tokenFile, 'utf8').trim();
      return TOKEN_RE.test(t) ? t : null;
    } catch {
      return null;
    }
  };

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    o2: { body?: unknown; timeoutMs: number; expect?: number },
  ): Promise<T> {
    const tok = token();
    if (!tok) throw new ControlUnavailableError();
    const url = `${controlBaseUrl(o.envFile, o.env)}${path}`;
    const res = await fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${tok}`,
        ...(o2.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: o2.body === undefined ? undefined : JSON.stringify(o2.body),
      signal: AbortSignal.timeout(o2.timeoutMs),
    });
    if (o2.expect ? res.status !== o2.expect : !res.ok)
      throw new Error(`control: ${method} ${path}: ${res.status} ${res.statusText}`.trim());
    if (res.status === 202 || res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    async available() {
      if (!token()) return false;
      try {
        await call('GET', '/internal/status', { timeoutMs: 3000 });
        return true;
      } catch {
        return false;
      }
    },
    status: () => call<ControlStatus>('GET', '/internal/status', { timeoutMs: 5000 }),
    doctorSession: () => call<PhoneTestLink>('POST', '/internal/doctor/sessions', { body: {}, timeoutMs: 5000 }),
    doctorWait(id, waitMs) {
      const wait = Math.max(0, Math.min(30_000, Math.round(waitMs)));
      return call<PhoneTestPoll>('GET', `/internal/doctor/sessions/${encodeURIComponent(id)}?wait=${wait}`, {
        timeoutMs: wait + 10_000,
      });
    },
    // The service downloads and stages synchronously: allow a slow link.
    update: (mode) => call<UpdateResult>('POST', '/internal/update', { body: { mode }, timeoutMs: 6 * 60_000 }),
    async shutdown(reason) {
      await call<void>('POST', '/internal/shutdown', { body: { reason }, timeoutMs: 10_000, expect: 202 });
    },
  };
}
