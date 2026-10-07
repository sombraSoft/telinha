// The phone test, run from the CLI side: ask the running service for a
// one-time link, long-poll until the phone reports (or the link expires, the
// wait runs out, or the user skips), then turn the report into rows that carry
// their status and the hint explaining them. Framework-free like SetupSession:
// the plain doctor awaits finished(), the screens subscribe() and re-read state.
import type { ControlClient, DoctorReport, PhoneTestPoll } from '../cli/control.ts';
import { type DoctorStrKey, doctorStrings } from '../cli/doctor-strings.ts';
import type { Locale } from '../cli/strings.ts';
import type { Config, Media } from '../config.ts';
import type { CheckStatus } from './types.ts';

/** What the doctor needs from the running service: its status for the checks, the phone test's link and long-poll. */
export type DoctorControl = Pick<ControlClient, 'available' | 'status' | 'doctorSession' | 'doctorWait'>;

/** How long the doctor waits for the phone. */
export const PHONE_WAIT_MS = 10 * 60_000;
// Under Bun.serve's 10 s idle timeout: the service lifts it for control calls (http.ts), this is the margin.
export const PHONE_POLL_MS = 8_000;

export type PhoneRowId = 'https' | 'signaling' | 'publish' | 'initial' | 'udp' | 'tcp' | 'turn';

/** One line of the phone report, in the order both doctors show them; hint only on a row that is not ok. */
export interface PhoneRow {
  id: PhoneRowId;
  status: CheckStatus;
  label: string;
  value: string;
  hint?: string;
}

export type PhoneTestState =
  | { kind: 'starting' }
  | { kind: 'notRunning' }
  | { kind: 'error'; message: string }
  | { kind: 'waiting'; url: string; deadline: number; opened: boolean }
  | { kind: 'done'; status: CheckStatus; rows: PhoneRow[] }
  | { kind: 'expired' }
  | { kind: 'skipped' };

/** How a run ended: done's status (worst row), expired or an error warn, skipped or not running skip. */
export interface PhoneOutcome {
  status: CheckStatus;
  report?: DoctorReport;
}

export interface PhoneTestInit {
  control: DoctorControl;
  /** Ports, media mode, LIVEKIT_NODE_IP and the TURN host the hints name; null when telinha.env did not load. */
  config: Config | null;
  locale: Locale;
  /** PHONE_WAIT_MS by default. */
  waitMs?: number;
  now?: () => number;
}

type Ports = { tcp: number; udp: number };
type Hint = { key: DoctorStrKey; params: Record<string, string | number>; rows: PhoneRowId[] };
type Say = (key: DoctorStrKey, params?: Record<string, string | number>) => string;

const RANK: Record<CheckStatus, number> = { skip: 0, ok: 1, warn: 2, fail: 3 };

export class PhoneTest {
  readonly #init: PhoneTestInit;
  readonly #now: () => number;
  readonly #listeners = new Set<() => void>();
  #locale: Locale;
  /** null until start(). */
  #state: PhoneTestState | null = null;
  #report: DoctorReport | null = null;
  /** Bumped by every start() and skip(): a run that sees another id is stale and goes quiet. */
  #run = 0;
  #cancel: () => void = () => {};
  #waiters: ((o: PhoneOutcome) => void)[] = [];
  #disposed = false;

  constructor(init: PhoneTestInit) {
    this.#init = init;
    this.#now = init.now ?? Date.now;
    this.#locale = init.locale;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  /** null until start(). */
  get state(): PhoneTestState | null {
    return this.#state;
  }

  /** done's rows follow the language. */
  setLocale(locale: Locale): void {
    if (locale === this.#locale) return;
    this.#locale = locale;
    const s = this.#state;
    if (s?.kind === 'done' && this.#report)
      this.#set({ ...s, rows: phoneRows(this.#report, this.#init.config, locale) });
  }

  /** Resolves when the current run (or the next one, before start()) ends. */
  finished(): Promise<PhoneOutcome> {
    const o = this.#outcome();
    if (o) return Promise.resolve(o);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Starts a run; one already running is dropped without a word. */
  async start(): Promise<void> {
    if (this.#disposed) return;
    this.#cancel();
    const id = ++this.#run;
    const stale = () => id !== this.#run || this.#disposed;
    let cancelled = false;
    const interrupted = new Promise<null>((resolve) => {
      this.#cancel = () => {
        cancelled = true;
        resolve(null);
      };
    });
    this.#report = null;
    this.#set({ kind: 'starting' });
    const ctl = this.#init.control;
    // A broken token file or socket is the same as a stopped service here.
    const up = await ctl.available().catch(() => false);
    if (stale()) return;
    if (!up) return this.#set({ kind: 'notRunning' });
    let link: { id: string; url: string };
    try {
      link = await ctl.doctorSession();
    } catch (e) {
      if (!stale()) this.#set({ kind: 'error', message: (e as Error).message });
      return;
    }
    if (stale()) return;
    const deadline = this.#now() + (this.#init.waitMs ?? PHONE_WAIT_MS);
    this.#set({ kind: 'waiting', url: link.url, deadline, opened: false });
    let poll: PhoneTestPoll = { state: 'pending' };
    try {
      while (!cancelled && this.#now() < deadline) {
        const next = await Promise.race([
          ctl.doctorWait(link.id, Math.min(PHONE_POLL_MS, deadline - this.#now())),
          interrupted,
        ]);
        if (!next || stale()) return;
        // A report means the phone opened the link, even when no poll saw it open.
        const s = this.#state;
        if ((next.state === 'opened' || next.state === 'done') && s?.kind === 'waiting' && !s.opened)
          this.#set({ ...s, opened: true });
        poll = next;
        if (poll.state === 'done' || poll.state === 'expired') break;
      }
    } catch (e) {
      if (!stale()) this.#set({ kind: 'error', message: (e as Error).message });
      return;
    }
    if (stale()) return;
    if (poll.state === 'done' && poll.report) {
      const r = poll.report;
      this.#report = r;
      const rows = phoneRows(r, this.#init.config, this.#locale);
      this.#set({
        kind: 'done',
        status: rows.reduce<CheckStatus>((w, row) => (RANK[row.status] > RANK[w] ? row.status : w), 'ok'),
        rows,
      });
    } else this.#set({ kind: poll.state === 'expired' ? 'expired' : 'skipped' });
  }

  /** Stops waiting for the phone; only while the link is being made or shown. */
  skip(): void {
    const k = this.#state?.kind;
    if (k !== 'waiting' && k !== 'starting') return;
    this.#run++;
    this.#cancel();
    this.#set({ kind: 'skipped' });
  }

  /** Drops the run and every listener. */
  dispose(): void {
    this.#disposed = true;
    this.#cancel();
    this.#listeners.clear();
  }

  #outcome(): PhoneOutcome | null {
    const s = this.#state;
    switch (s?.kind) {
      case 'done':
        return { status: s.status, ...(this.#report ? { report: this.#report } : {}) };
      case 'expired':
      case 'error':
        return { status: 'warn' };
      case 'skipped':
      case 'notRunning':
        return { status: 'skip' };
      default:
        return null;
    }
  }

  #set(s: PhoneTestState): void {
    this.#state = s;
    this.#emit();
    const o = this.#outcome();
    if (o) for (const w of this.#waiters.splice(0)) w(o);
  }

  #emit(): void {
    if (this.#disposed) return;
    for (const fn of [...this.#listeners]) fn();
  }
}

/** The media ports the phone tested; null with LiveKit Cloud, whose ports are not the user's to open. */
function mediaPorts(config: Config | null): Ports | null {
  if (config?.media === 'cloud') return null;
  return { tcp: config?.mediaTcpPort ?? 7881, udp: config?.mediaUdpPort ?? 7882 };
}

/** Plain-language hints for a report, each with the rows it explains. */
function phoneHints(
  r: DoctorReport,
  ports: Ports | null,
  publicIp: string | null,
  media: Media,
  turnHost: string | null | undefined,
): Hint[] {
  const p: Record<string, number> = ports ? { tcp: ports.tcp, udp: ports.udp } : {};
  const cloud = media === 'cloud';
  // In cloud mode the page already loaded from PUBLIC_URL: signaling goes straight to Cloud.
  if (!r.signaling.ok) return [{ key: cloud ? 'hintCloudSignaling' : 'hintSignaling', params: p, rows: ['signaling'] }];
  const out: Hint[] = [];
  if (!r.tcp.ok && !r.udp.ok) out.push({ key: cloud ? 'hintCloudBoth' : 'hintBoth', params: p, rows: ['udp', 'tcp'] });
  else if (!r.udp.ok) out.push({ key: cloud ? 'hintCloudUdp' : 'hintUdp', params: p, rows: ['udp'] });
  else if (!r.tcp.ok) out.push({ key: cloud ? 'hintCloudTcp' : 'hintTcp', params: p, rows: ['tcp'] });
  // In cloud mode the candidate is Cloud's address, never this network's.
  const ip = r.initial?.candidateIp;
  if (!cloud && ip && publicIp && ip !== publicIp && /^\d+\.\d+\.\d+\.\d+$/.test(ip))
    out.push({ key: 'hintIp', params: { ip, publicIp }, rows: ['initial'] });
  if (r.turn && !r.turn.ok)
    out.push({ key: 'hintTurn', params: { turnHost: turnHost ?? 'turn.<host>' }, rows: ['turn'] });
  return out;
}

function rowStatus(id: PhoneRowId, ok: boolean, r: DoctorReport, hinted: boolean): CheckStatus {
  if (ok) return hinted ? 'warn' : 'ok';
  // One media path is enough to watch: only both closed fails.
  if (id === 'udp' || id === 'tcp') return !r.udp.ok && !r.tcp.ok ? 'fail' : 'warn';
  // TURN is the fallback for strict networks: its failure alone never fails the run.
  if (id === 'publish' || id === 'initial' || id === 'turn') return 'warn';
  return 'fail';
}

function phoneRows(r: DoctorReport, config: Config | null, locale: Locale): PhoneRow[] {
  const s: Say = (key, params) => doctorStrings(locale, key, params);
  const ports = mediaPorts(config);
  const hints = phoneHints(r, ports, config?.livekitNodeIp ?? null, config?.media ?? 'self', config?.turn?.host);
  const ok = (v: boolean, rtt?: number) =>
    v ? (rtt !== undefined ? s('worksRtt', { ms: rtt }) : s('works')) : s('failed');
  const why = (v: { ok: boolean; error?: string }) => (!v.ok && v.error ? `: ${v.error}` : '');
  const raw: { id: PhoneRowId; ok: boolean; label: string; value: string }[] = [
    {
      id: 'https',
      ok: r.https.ok,
      label: s('rowHttps'),
      value: r.https.ok
        ? r.https.latencyMs !== null
          ? s('latency', { ms: r.https.latencyMs })
          : s('works')
        : s('failed'),
    },
    {
      id: 'signaling',
      ok: r.signaling.ok,
      label: s('rowSignaling'),
      value: r.signaling.ok ? s('works') : `${s('failed')}${why(r.signaling)}`,
    },
    {
      id: 'publish',
      ok: r.publish.ok,
      label: s('rowPublish'),
      value: r.publish.ok ? s('works') : `${s('failed')}${why(r.publish)}`,
    },
    {
      id: 'initial',
      ok: !!r.initial,
      label: s('rowInitial'),
      value: r.initial
        ? s('initialPath', {
            protocol: r.initial.protocol.toUpperCase(),
            ip: r.initial.candidateIp ?? '?',
            ms: r.initial.rttMs ?? '?',
          })
        : s('initialNone'),
    },
    {
      id: 'udp',
      ok: r.udp.ok,
      label: ports ? s('rowUdp', { port: ports.udp }) : s('rowUdpCloud'),
      value: `${ok(r.udp.ok, r.udp.rttMs)}${why(r.udp)}`,
    },
    {
      id: 'tcp',
      ok: r.tcp.ok,
      label: ports ? s('rowTcp', { port: ports.tcp }) : s('rowTcpCloud'),
      value: `${ok(r.tcp.ok, r.tcp.rttMs)}${why(r.tcp)}`,
    },
    ...(r.turn
      ? [
          {
            id: 'turn' as const,
            ok: r.turn.ok,
            label: s('rowTurn'),
            value: `${ok(r.turn.ok, r.turn.rttMs)}${why(r.turn)}`,
          },
        ]
      : []),
  ];
  return raw.map((row) => {
    const mine = hints.filter((h) => h.rows.includes(row.id)).map((h) => s(h.key, h.params));
    const status = rowStatus(row.id, row.ok, r, mine.length > 0);
    return {
      id: row.id,
      status,
      label: row.label,
      value: row.value,
      ...(mine.length && status !== 'ok' ? { hint: mine.join('\n') } : {}),
    };
  });
}
