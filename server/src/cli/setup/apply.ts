// Apply, the install as a list of tasks: Discord, DuckDNS, the file, the programs,
// the service, the tray icon, the router, the start, the certificate and doctor. One runner
// for the setup screens (a live task list with retry, skip or back) and for
// the plain run (lines as they come). A task's lines are the steps' own
// output, captured per task; what happens after a failure is the caller's
// decide(). What the run did is a TaskList: one row per task, which the
// screens and the summary after them only render.
import type { Config } from '../../config.ts';
import type { CheckResult } from '../../doctor/types.ts';
import { helpersOf } from '../../footprint.ts';
import { present } from '../../present.ts';
import type { Out } from '../term.ts';
import { type AKey, at } from './apply-strings.ts';
import { checkDiscord } from './discord.ts';
import type { PreviousEnv } from './envwrite.ts';
import type { QuestionId } from './model.ts';
import {
  doctorCli,
  downloadBinaries,
  generateSecrets,
  publicPorts,
  routerStep,
  type StartOutcome,
  serviceStep,
  startService,
  type Values,
  validateValues,
  type WithTerminal,
  type Wizard,
  waitForCertificate,
  writeConfig,
} from './steps.ts';
import type { SKey } from './strings.ts';
import { type TrayChoice, trayStep } from './tray.ts';

export type TaskId =
  | 'discord'
  | 'duckdns'
  | 'config'
  | 'binaries'
  | 'service'
  | 'tray'
  | 'router'
  | 'start'
  | 'cert'
  | 'doctor';
export type TaskStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail' | 'skipped';
export interface TaskLine {
  kind: 'info' | 'ok' | 'warn' | 'fail';
  text: string;
}
/** A download's bytes, the certificate wait's milliseconds or the doctor's checks. */
export interface TaskProgress {
  done: number;
  total: number | null;
  unit: 'bytes' | 'items' | 'ms';
  label?: string;
}

/** Where the file goes: inside the image `shown` is the host's path (install-docker.sh passes it). */
export interface ApplyTarget {
  file: string;
  shown: string;
  previous: PreviousEnv | null;
}

/** Secrets this setup run generated: a retry or a re-apply writes the same ones. */
export interface SecretMemo {
  made: Values;
  rotated?: string;
}

export interface ApplyOptions {
  docker: boolean;
  compiled: boolean;
  flags: { noService: boolean; noFirewall: boolean; noUpnp: boolean; noDoctor: boolean; offline: boolean };
  sysctl: 'sudo' | 'manual' | 'auto';
  rotateCookie: boolean;
  /** The setup screens: doctor checks as data (setup's doctor screen); plain: the doctor command prints. */
  doctorMode: 'data' | 'cli';
  /** Kept by the caller across re-applies; a fresh one per run when absent. */
  secrets?: SecretMemo;
  /** The tray icon (native Windows only); null: no tray task. */
  tray: TrayChoice | null;
}

export interface ApplyHooks {
  /** A task failed: what now. Plain: abort before the file, skip after it. Setup screens: the user's pick. */
  decide(id: TaskId, error: string): Promise<'retry' | 'skip' | 'back' | 'abort'>;
  /** Runs fn with the real terminal (setup screens suspended); intro: lines to show there first. Plain: fn(). */
  withTerminal: WithTerminal;
}

export type ApplyResult =
  | { kind: 'done'; code: number; values: Values; tasks: Record<TaskId, TaskStatus>; doctor: CheckResult[] | null }
  | { kind: 'back'; to: TaskId }
  | { kind: 'aborted'; wrote: boolean };

/**
 * Task row label, the hint shown when it fails, the question a "Back to
 * questions" from it lands on, and the header the plain run prints when it
 * starts (null: its lines say enough).
 */
export const TASKS: Record<TaskId, { label: AKey; hint: AKey; backTo: QuestionId | 'review'; header: SKey | null }> = {
  discord: { label: 'taskDiscord', hint: 'hintDiscord', backTo: 'discordToken', header: 'discordTitle' },
  duckdns: { label: 'taskDuckdns', hint: 'hintDuckdns', backTo: 'duckToken', header: null },
  config: { label: 'taskConfig', hint: 'hintConfig', backTo: 'review', header: null },
  binaries: { label: 'taskBinaries', hint: 'hintBinaries', backTo: 'review', header: 'binsTitle' },
  service: { label: 'taskService', hint: 'hintService', backTo: 'sysctl', header: 'serviceTitle' },
  tray: { label: 'taskTray', hint: 'hintTray', backTo: 'tray', header: null },
  router: { label: 'taskRouter', hint: 'hintRouter', backTo: 'upnp', header: 'routerTitle' },
  start: { label: 'taskStart', hint: 'hintStart', backTo: 'review', header: 'startTitle' },
  cert: { label: 'taskCert', hint: 'hintCert', backTo: 'review', header: null },
  doctor: { label: 'taskDoctor', hint: 'hintDoctor', backTo: 'review', header: 'doctorTitle' },
};

/**
 * The lines of a finished task that still matter once it is over: every
 * warning and failure with the info lines right after it (a hint's why, the
 * manual command), and every router line (the ports to open or forward by hand).
 */
function todoLines(id: TaskId, lines: readonly TaskLine[]): TaskLine[] {
  if (id === 'router') return [...lines];
  const out: TaskLine[] = [];
  let explaining = false;
  for (const l of lines) {
    const loud = l.kind === 'warn' || l.kind === 'fail';
    if (loud || (explaining && l.kind === 'info')) out.push(l);
    explaining = loud || (explaining && l.kind === 'info');
  }
  return out;
}

/** One task as its row shows it: its latest attempt (a retry starts the row over). */
export interface TaskRow {
  id: TaskId;
  status: TaskStatus;
  /** The running step's one-liner (spinner label, the UAC wait, "3 of 18 checks"). */
  detail: string;
  /** A spinner is up: its next line is the result. */
  spinning: boolean;
  /** What the plain output printed for this attempt. */
  lines: TaskLine[];
  progress: TaskProgress | null;
  /** The line that ended the task's spinner ("Service installed"): what a finished row shows. */
  result: TaskLine | null;
  /** What is left to do by hand once it is over (todoLines). */
  todo: TaskLine[];
}

/** A finished task as the summary prints it: the line that says it all, then what else is left to do. */
export interface SummaryRow {
  id: TaskId;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  headline: TaskLine | null;
  todo: TaskLine[];
}

/** What runApply tells its TaskList. */
type RowEvent =
  | { kind: 'attempt'; id: TaskId }
  | { kind: 'detail'; id: TaskId; text: string }
  | { kind: 'line'; id: TaskId; line: TaskLine }
  | { kind: 'progress'; id: TaskId; progress: TaskProgress }
  | { kind: 'end'; id: TaskId; status: TaskStatus };
type TaskEvent = { kind: 'plan'; plan: readonly TaskId[] } | RowEvent;

/** runApply's way in: nothing else changes a TaskList. */
let feed!: (list: TaskList, e: TaskEvent) => void;

type Row = Omit<TaskRow, 'todo'>;
const fresh = (id: TaskId, status: TaskStatus): Row => ({
  id,
  status,
  detail: '',
  spinning: false,
  lines: [],
  progress: null,
  result: null,
});

/** The line a finished task's summary row shows: what its spinner ended with, the failure, or the line that says it all. */
function headline(r: Row): TaskLine | null {
  // The router's lines are a list to read top down (what was found, what is left to do).
  if (r.id === 'router') return r.lines[0] ?? null;
  if (r.status === 'fail') return r.lines.findLast((l) => l.kind === 'fail') ?? r.lines.at(-1) ?? null;
  return r.result ?? r.lines.find((l) => l.kind === 'ok') ?? r.lines.at(-1) ?? null;
}

/**
 * The install's tasks as rows, kept across re-applies: each run starts the
 * rows over with its plan. Shaped like SetupState and PhoneTest: subscribe()
 * hears every change, the getters read the current state.
 */
export class TaskList {
  static {
    feed = (list, e) => list.#fold(e);
  }

  readonly #listeners = new Set<() => void>();
  #rows: Row[] = [];
  #wroteAny = false;

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  /** The latest run's tasks in plan order; a copy, safe to keep. */
  get rows(): TaskRow[] {
    const copy = (l: TaskLine) => ({ ...l });
    return this.#rows.map((r) => ({
      ...r,
      lines: r.lines.map(copy),
      progress: r.progress && { ...r.progress },
      result: r.result && copy(r.result),
      todo: todoLines(r.id, r.lines).map(copy),
    }));
  }

  /** The latest run's finished tasks in plan order: each one's headline, and what is left to do besides it. */
  summary(): SummaryRow[] {
    return this.#rows.flatMap((r) => {
      if (r.status === 'pending' || r.status === 'running') return [];
      const head = headline(r);
      return [{ id: r.id, status: r.status, headline: head, todo: todoLines(r.id, r.lines).filter((l) => l !== head) }];
    });
  }

  /** The latest run wrote telinha.env. */
  get wrote(): boolean {
    const status = this.#rows.find((r) => r.id === 'config')?.status;
    return status === 'ok' || status === 'warn';
  }

  /** Some run wrote telinha.env: it stays on disk whatever a later one did. */
  get wroteAny(): boolean {
    return this.#wroteAny;
  }

  #fold(e: TaskEvent): void {
    if (e.kind === 'plan') this.#rows = e.plan.map((id) => fresh(id, 'pending'));
    else if (!this.#foldRow(e)) return;
    for (const fn of [...this.#listeners]) fn();
  }

  /** False when the event's task has no row. */
  #foldRow(e: RowEvent): boolean {
    const i = this.#rows.findIndex((r) => r.id === e.id);
    const r = this.#rows[i];
    if (!r) return false;
    switch (e.kind) {
      case 'attempt':
        // A retry's row starts clean.
        this.#rows[i] = fresh(e.id, 'running');
        break;
      case 'detail':
        r.detail = e.text;
        r.spinning = true;
        break;
      case 'line':
        // The first line after a spinner is how it ended.
        if (r.spinning) r.result = e.line;
        r.spinning = false;
        r.lines.push(e.line);
        break;
      case 'progress':
        r.progress = { ...e.progress };
        break;
      case 'end':
        r.status = e.status;
        if (e.id === 'config' && (e.status === 'ok' || e.status === 'warn')) this.#wroteAny = true;
        break;
    }
    return true;
  }
}

/** Where "Back to questions" lands: the task's question while it is asked, else the Review (sysctl and UPnP are not always). */
export function backTarget(id: TaskId, flow: readonly QuestionId[]): QuestionId | 'review' {
  const to = TASKS[id].backTo;
  return to === 'review' || flow.includes(to) ? to : 'review';
}

/**
 * The tasks for these values, in order. Docker writes the file only (the host
 * runs the container). From source the service row still runs: it says why
 * nothing is installed.
 */
export function planTasks(values: Values, o: ApplyOptions): TaskId[] {
  const plan: TaskId[] = [];
  if (!o.flags.offline) plan.push('discord');
  if (values.DDNS_PROVIDER === 'duckdns') plan.push('duckdns');
  plan.push('config');
  if (o.docker) return plan;
  const ingress = (values.INGRESS || 'direct') as Config['ingress'];
  // LiveKit Cloud behind a proxy runs no child; behind a tunnel nothing reaches this machine.
  if (helpersOf({ media: values.MEDIA === 'cloud' ? 'cloud' : 'self', ingress }).length) plan.push('binaries');
  if (!o.flags.noService) plan.push('service');
  // Early, so the icon shows the service coming up while the rest runs.
  if (o.tray) plan.push('tray');
  if (!o.flags.noUpnp && publicPorts(values).length) plan.push('router');
  plan.push('start');
  if (!o.flags.noDoctor) {
    // Only direct mode has a certificate of its own to wait for.
    if ((values.INGRESS || 'direct') === 'direct') plan.push('cert');
    plan.push('doctor');
  }
  return plan;
}

/** An Out that prints nothing: under the setup screens the task rows are the output. */
export function silentOut(): Out {
  const id = (s: string) => s;
  const nop = () => {};
  return {
    info: nop,
    ok: nop,
    warn: nop,
    fail: nop,
    step: nop,
    line: nop,
    table: nop,
    spinner: () => ({ update: nop, stop: nop, fail: nop }),
    link: id,
    colors: false,
    style: { bold: id, dim: id, red: id, green: id, yellow: id, cyan: id },
  };
}

/** Prints through sink and tells the list every line, spinner and progress of one task. */
function taskOut(sink: Out, id: TaskId, tell: (e: TaskEvent) => void, seen: TaskLine[]): Out {
  const add = (kind: TaskLine['kind'], text: string) => {
    const line = { kind, text };
    seen.push(line);
    tell({ kind: 'line', id, line });
  };
  const detail = (text: string) => tell({ kind: 'detail', id, text });
  return {
    colors: sink.colors,
    style: sink.style,
    link: (url) => sink.link(url),
    info: (m) => (sink.info(m), add('info', m)),
    ok: (m) => (sink.ok(m), add('ok', m)),
    warn: (m) => (sink.warn(m), add('warn', m)),
    fail: (m) => (sink.fail(m), add('fail', m)),
    // Task headers are the runner's (the row label on the setup screens).
    step: (title) => sink.step(title),
    line: (m = '') => {
      sink.line(m);
      if (m) add('info', m);
    },
    table: (rows) => {
      sink.table(rows);
      for (const r of rows) add('info', r.join('  '));
    },
    spinner(label) {
      const spin = sink.spinner(label);
      let current = label;
      detail(label);
      return {
        update(l) {
          current = l;
          spin.update(l);
          detail(l);
        },
        stop(l) {
          spin.stop(l);
          add('ok', l ?? current);
        },
        fail(l) {
          spin.fail(l);
          add('fail', l ?? current);
        },
      };
    },
    progress(done, total, label) {
      sink.progress?.(done, total, label);
      tell({ kind: 'progress', id, progress: { done, total, unit: 'bytes', label } });
    },
    detail(text) {
      sink.detail?.(text);
      detail(text);
    },
  };
}

/** Fills in the generated secrets, reusing what this setup run made before. */
function applySecrets(values: Values, random: (n: number) => Uint8Array, rotate: boolean, memo: SecretMemo): void {
  const reuse = (key: string, need: boolean) => {
    const made = memo.made[key];
    if (need && made) values[key] = made;
  };
  if (rotate && memo.rotated) values.COOKIE_SECRET = memo.rotated;
  else if (!rotate) reuse('COOKIE_SECRET', !values.COOKIE_SECRET);
  reuse('LIVEKIT_API_KEY', !values.LIVEKIT_API_KEY);
  reuse('LIVEKIT_API_SECRET', !values.LIVEKIT_API_SECRET || values.LIVEKIT_API_SECRET.length < 32);
  const rotateNow = rotate && !memo.rotated;
  for (const k of generateSecrets(values, random, rotateNow)) {
    if (k === 'COOKIE_SECRET' && rotateNow) memo.rotated = values[k];
    else memo.made[k] = present(values[k], k);
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Outcome = { status: 'ok' | 'warn' | 'fail' | 'skipped'; error?: string };

/**
 * Runs `plan` in order. A failure asks hooks.decide: retry runs the task
 * again, skip marks it skipped and goes on, back and abort stop. values gets
 * what the install learns (the client id from Discord, the generated secrets);
 * tasks gets the rows (the plain run needs none: its lines are the output).
 */
export async function runApply(
  w: Wizard,
  target: ApplyTarget,
  values: Values,
  plan: TaskId[],
  o: ApplyOptions,
  hooks: ApplyHooks,
  tasks = new TaskList(),
): Promise<ApplyResult> {
  const { deps, ctx, s } = w;
  const tell = (e: TaskEvent) => feed(tasks, e);
  const memo = o.secrets ?? { made: {} };
  const status = Object.fromEntries((Object.keys(TASKS) as TaskId[]).map((id) => [id, 'skipped'])) as Record<
    TaskId,
    TaskStatus
  >;
  let config: Config | null = null;
  let wrote = false;
  let installed = false;
  let wasRunning: boolean | null = null;
  let started: StartOutcome | null = null;
  let doctor: CheckResult[] | null = null;
  // Asked before the install starts the service: a running one restarts to read the new file.
  const running = async () => (wasRunning ??= await deps.control.available().catch(() => false));

  /** A task that does not run at all (no attempt, no header), with the line saying why; null = it runs. */
  const skip = (id: TaskId): { why?: string } | null => {
    if (id === 'discord' || id === 'duckdns' || id === 'config') return null;
    if (!wrote) return { why: at(w.locale, 'notWritten') };
    // The certificate is only worth waiting for once the service answers.
    if (id === 'cert' && started !== 'running') return {};
    return null;
  };

  const body: Record<TaskId, (tw: Wizard) => Promise<Outcome>> = {
    async discord(tw) {
      const problems = await checkDiscord(tw, values, values.PUBLIC_URL ?? '');
      for (const p of problems) tw.out.fail(p);
      return problems.length ? { status: 'fail', error: problems.join('\n') } : { status: 'ok' };
    },
    async duckdns(tw) {
      const ddns = deps.ddns({
        domain: present(values.DUCKDNS_DOMAIN, 'DUCKDNS_DOMAIN'),
        token: present(values.DUCKDNS_TOKEN, 'DUCKDNS_TOKEN'),
      });
      await ddns.update(w.host.publicIp ?? '');
      const last = ddns.last();
      if (!last?.ok) {
        const error = s('duckFailed', { error: last?.error ?? '?' });
        tw.out.fail(error);
        return { status: 'fail', error };
      }
      tw.out.ok(s('duckOk', { name: `${values.DUCKDNS_DOMAIN}.duckdns.org`, ip: w.host.publicIp ?? '?' }));
      return { status: 'ok' };
    },
    async config(tw) {
      applySecrets(values, deps.random, o.rotateCookie, memo);
      try {
        // A config loadConfig rejects is never written.
        const v = validateValues(values, target.previous, ctx.paths.home, { compiled: ctx.compiled });
        await writeConfig(tw, target.file, v.text, target.shown);
        config = v.config;
        wrote = true;
        return { status: 'ok' };
      } catch (e) {
        const error = s('configInvalid', { error: errMsg(e) });
        tw.out.fail(error);
        return { status: 'fail', error };
      }
    },
    async binaries(tw) {
      return { status: (await downloadBinaries(tw, present(config, 'the written config'))) ? 'ok' : 'warn' };
    },
    async service(tw) {
      await running();
      installed = await serviceStep(tw, values, {
        firewall: !o.flags.noFirewall,
        sysctl: o.sysctl,
        withTerminal: hooks.withTerminal,
      });
      if (!ctx.compiled) return { status: 'skipped' };
      return { status: installed ? 'ok' : 'fail' };
    },
    async tray(tw) {
      await trayStep(tw, present(o.tray, 'the tray choice'));
      return { status: 'ok' };
    },
    async router(tw) {
      await routerStep(tw, values, values.HOSTING === 'vps' ? 'vps' : 'home');
      return { status: 'ok' };
    },
    async start(tw) {
      started = await startService(tw, { installed, wasRunning: await running() });
      if (started === 'running') return { status: 'ok' };
      return { status: started === 'notAnswering' ? 'fail' : 'warn' };
    },
    async cert(tw) {
      const ok = await waitForCertificate(tw, values, (waited, limit) =>
        tell({ kind: 'progress', id: 'cert', progress: { done: waited, total: limit, unit: 'ms' } }),
      );
      return { status: ok ? 'ok' : 'warn' };
    },
    async doctor(tw) {
      if (o.doctorMode === 'cli') return { status: (await doctorCli(tw)) ? 'ok' : 'warn' };
      let results: CheckResult[];
      try {
        results = await deps.doctorChecks({ ...ctx, locale: w.locale }, (_r, done, total) => {
          tell({ kind: 'detail', id: 'doctor', text: at(w.locale, 'checksProgress', { done, total }) });
          tell({ kind: 'progress', id: 'doctor', progress: { done, total, unit: 'items' } });
        });
      } catch (e) {
        tw.out.warn(s('doctorFailed', { error: errMsg(e) }));
        return { status: 'warn' };
      }
      doctor = results;
      const n = (st: CheckResult['status']) => results.filter((r) => r.status === st).length;
      const count = (one: AKey, many: AKey, k: number) => (k === 1 ? at(w.locale, one) : at(w.locale, many, { n: k }));
      const summary = [
        at(w.locale, 'doctorOk', { n: n('ok') }),
        count('doctorWarn1', 'doctorWarnN', n('warn')),
        at(w.locale, 'doctorFail', { n: n('fail') }),
        count('doctorSkip1', 'doctorSkipN', n('skip')),
      ].join(' · ');
      // Problems only warn: the file is written and the report says what to fix.
      if (n('fail')) tw.out.warn(summary);
      else tw.out.ok(summary);
      return { status: n('fail') ? 'warn' : 'ok' };
    },
  };

  for (const id of plan) status[id] = 'pending';
  tell({ kind: 'plan', plan });
  for (const id of plan) {
    const skipped = skip(id);
    if (skipped) {
      status[id] = 'skipped';
      tell({ kind: 'end', id, status: 'skipped' });
      if (skipped.why) tell({ kind: 'line', id, line: { kind: 'info', text: skipped.why } });
      continue;
    }
    const header = TASKS[id].header;
    if (header) w.out.step(s(header));
    for (;;) {
      const seen: TaskLine[] = [];
      tell({ kind: 'attempt', id });
      const tw: Wizard = { ...w, out: taskOut(w.out, id, tell, seen) };
      let r: Outcome;
      try {
        r = await body[id](tw);
      } catch (e) {
        tw.out.fail(errMsg(e));
        r = { status: 'fail', error: errMsg(e) };
      }
      // Warnings on the way (hints, a skipped redirect, a busy router) make an ok task a warning.
      const ended = r.status === 'ok' && seen.some((l) => l.kind === 'warn' || l.kind === 'fail') ? 'warn' : r.status;
      status[id] = ended;
      tell({ kind: 'end', id, status: ended });
      if (ended !== 'fail') break;
      const error =
        r.error ??
        [...seen].reverse().find((l) => l.kind === 'fail' || l.kind === 'warn')?.text ??
        at(w.locale, TASKS[id].hint);
      const next = await hooks.decide(id, error);
      if (next === 'retry') continue;
      if (next === 'back') return { kind: 'back', to: id };
      // Without the file nothing after it can run: skipping it is stopping.
      if (next === 'abort' || id === 'config') return { kind: 'aborted', wrote };
      status[id] = 'skipped';
      tell({ kind: 'end', id, status: 'skipped' });
      break;
    }
  }
  return { kind: 'done', code: 0, values, tasks: status, doctor };
}
