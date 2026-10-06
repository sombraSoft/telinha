// The install as a list of tasks: Discord, DuckDNS, the file, the programs,
// the service, the tray icon, the router, the start, the certificate and doctor. One runner
// for the setup screens (a live task list with retry, skip or back) and for
// the plain run (lines as they come). A task's lines are the steps' own
// output, captured per task; what happens after a failure is the caller's
// decide().
import type { Config } from '../../config.ts';
import type { CheckResult } from '../../doctor/types.ts';
import type { Out } from '../term.ts';
import { at, type AKey } from './apply-strings.ts';
import { checkDiscord } from './discord.ts';
import type { PreviousEnv } from './envwrite.ts';
import type { QuestionId } from './model.ts';
import {
  doctorCli, downloadBinaries, generateSecrets, routerStep, serviceStep, startService, validateValues, waitForCertificate, writeConfig,
  type StartOutcome, type Values, type WithTerminal, type Wizard,
} from './steps.ts';
import { trayStep, type TrayChoice } from './tray.ts';

export type TaskId = 'discord' | 'duckdns' | 'config' | 'binaries' | 'service' | 'tray' | 'router' | 'start' | 'cert' | 'doctor';
export type TaskStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail' | 'skipped';
export interface TaskLine { kind: 'info' | 'ok' | 'warn' | 'fail'; text: string }
export interface TaskEvent {
  id: TaskId; status: TaskStatus;
  /** One-line detail for the row (spinner label, path, "3 of 18 checks"…). */
  detail?: string;
  /** Appended lines (what the plain output prints for this task). */
  lines?: TaskLine[];
  progress?: { done: number; total: number | null; unit: 'bytes' | 'items' | 'ms'; label?: string };
  /** The doctor task: the results so far. */
  checks?: CheckResult[];
}

/** Where the file goes: inside the image `shown` is the host's path (install-docker.sh passes it). */
export interface ApplyTarget { file: string; shown: string; previous: PreviousEnv | null }

/** Secrets a run of this session generated: a retry or a re-apply writes the same ones. */
export interface SecretMemo { made: Values; rotated?: string }

export interface ApplyOptions {
  docker: boolean; compiled: boolean;
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
  emit(e: TaskEvent): void;
  /** A task failed: what now. Plain: abort before the file, skip after it. Setup screens: the user's pick. */
  decide(id: TaskId, error: string): Promise<'retry' | 'skip' | 'back' | 'abort'>;
  /** Runs fn with the real terminal (setup screens suspended); intro: lines to show there first. Plain: fn(). */
  withTerminal: WithTerminal;
}

export type ApplyResult =
  | { kind: 'done'; code: number; values: Values; tasks: Record<TaskId, TaskStatus>; doctor: CheckResult[] | null }
  | { kind: 'back'; to: TaskId }
  | { kind: 'aborted'; wrote: boolean };

/** Task row label, the hint shown when it fails, and the question a "Back to questions" from it lands on. */
export const TASKS: Record<TaskId, { label: AKey; hint: AKey; backTo: QuestionId | 'review' }> = {
  discord: { label: 'taskDiscord', hint: 'hintDiscord', backTo: 'discordToken' },
  duckdns: { label: 'taskDuckdns', hint: 'hintDuckdns', backTo: 'duckToken' },
  config: { label: 'taskConfig', hint: 'hintConfig', backTo: 'review' },
  binaries: { label: 'taskBinaries', hint: 'hintBinaries', backTo: 'review' },
  service: { label: 'taskService', hint: 'hintService', backTo: 'sysctl' },
  tray: { label: 'taskTray', hint: 'hintTray', backTo: 'review' },
  router: { label: 'taskRouter', hint: 'hintRouter', backTo: 'upnp' },
  start: { label: 'taskStart', hint: 'hintStart', backTo: 'review' },
  cert: { label: 'taskCert', hint: 'hintCert', backTo: 'review' },
  doctor: { label: 'taskDoctor', hint: 'hintDoctor', backTo: 'review' },
};

/**
 * The lines of a finished task that still matter once it is over: every
 * warning and failure with the info lines right after it (a hint's why, the
 * manual command), and every router line (the ports to open or forward by hand).
 */
export function todoLines(id: TaskId, lines: readonly TaskLine[]): TaskLine[] {
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
  plan.push('binaries');
  if (!o.flags.noService) plan.push('service');
  // Early, so the icon shows the service coming up while the rest runs.
  if (o.tray) plan.push('tray');
  if (!o.flags.noUpnp) plan.push('router');
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
    info: nop, ok: nop, warn: nop, fail: nop, step: nop, line: nop, table: nop,
    spinner: () => ({ update: nop, stop: nop, fail: nop }),
    link: id, colors: false, style: { bold: id, dim: id, red: id, green: id, yellow: id, cyan: id },
  };
}

/** Prints through sink and reports every line, spinner and progress of one task as events. */
function taskOut(sink: Out, id: TaskId, emit: ApplyHooks['emit'], seen: TaskLine[]): Out {
  const running = (e: Omit<TaskEvent, 'id' | 'status'>) => emit({ id, status: 'running', ...e });
  const add = (kind: TaskLine['kind'], text: string) => {
    const l = { kind, text };
    seen.push(l);
    running({ lines: [l] });
  };
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
      running({ detail: label });
      return {
        update(l) {
          current = l;
          spin.update(l);
          running({ detail: l });
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
      running({ progress: { done, total, unit: 'bytes', label } });
    },
    detail(text) {
      sink.detail?.(text);
      running({ detail: text });
    },
  };
}

/** Fills in the generated secrets, reusing what this session made before. */
function applySecrets(values: Values, random: (n: number) => Uint8Array, rotate: boolean, memo: SecretMemo): void {
  const reuse = (key: string, need: boolean) => {
    if (need && memo.made[key]) values[key] = memo.made[key]!;
  };
  if (rotate && memo.rotated) values.COOKIE_SECRET = memo.rotated;
  else if (!rotate) reuse('COOKIE_SECRET', !values.COOKIE_SECRET);
  reuse('LIVEKIT_API_KEY', !values.LIVEKIT_API_KEY);
  reuse('LIVEKIT_API_SECRET', !values.LIVEKIT_API_SECRET || values.LIVEKIT_API_SECRET.length < 32);
  const rotateNow = rotate && !memo.rotated;
  for (const k of generateSecrets(values, random, rotateNow)) {
    if (k === 'COOKIE_SECRET' && rotateNow) memo.rotated = values[k];
    else memo.made[k] = values[k]!;
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Outcome = { status: 'ok' | 'warn' | 'fail' | 'skipped'; error?: string };

/**
 * Runs `plan` in order. A failure asks hooks.decide: retry runs the task
 * again, skip marks it skipped and goes on, back and abort stop. values gets
 * what the install learns (the client id from Discord, the generated secrets).
 */
export async function runApply(w: Wizard, target: ApplyTarget, values: Values, plan: TaskId[], o: ApplyOptions, hooks: ApplyHooks): Promise<ApplyResult> {
  const { deps, ctx, s } = w;
  const memo = o.secrets ?? { made: {} };
  const tasks = Object.fromEntries((Object.keys(TASKS) as TaskId[]).map((id) => [id, 'skipped'])) as Record<TaskId, TaskStatus>;
  let config: Config | null = null;
  let wrote = false;
  let installed = false;
  let wasRunning: boolean | null = null;
  let started: StartOutcome | null = null;
  let doctor: CheckResult[] | null = null;
  // Asked before the install starts the service: a running one restarts to read the new file.
  const running = async () => (wasRunning ??= await deps.control.available().catch(() => false));

  /** A task that does not run at all (no 'running' event, no header), with the line saying why; null = it runs. */
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
      const ddns = deps.ddns({ domain: values.DUCKDNS_DOMAIN!, token: values.DUCKDNS_TOKEN! });
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
      return { status: (await downloadBinaries(tw, config!)) ? 'ok' : 'warn' };
    },
    async service(tw) {
      await running();
      installed = await serviceStep(tw, values, { firewall: !o.flags.noFirewall, sysctl: o.sysctl, withTerminal: hooks.withTerminal });
      if (!ctx.compiled) return { status: 'skipped' };
      return { status: installed ? 'ok' : 'fail' };
    },
    async tray(tw) {
      await trayStep(tw, o.tray!);
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
      const ok = await waitForCertificate(tw, values, (waited, limit) => hooks.emit({ id: 'cert', status: 'running', progress: { done: waited, total: limit, unit: 'ms' } }));
      return { status: ok ? 'ok' : 'warn' };
    },
    async doctor(tw) {
      if (o.doctorMode === 'cli') return { status: (await doctorCli(tw)) ? 'ok' : 'warn' };
      const got: CheckResult[] = [];
      let results: CheckResult[];
      try {
        results = await deps.doctorChecks({ ...ctx, locale: w.locale }, (r, done, total) => {
          got.push(r);
          hooks.emit({
            id: 'doctor', status: 'running', detail: at(w.locale, 'checksProgress', { done, total }),
            progress: { done, total, unit: 'items' }, checks: [...got],
          });
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

  for (const id of plan) {
    tasks[id] = 'pending';
    hooks.emit({ id, status: 'pending' });
  }
  for (const id of plan) {
    const skipped = skip(id);
    if (skipped) {
      tasks[id] = 'skipped';
      hooks.emit({ id, status: 'skipped', ...(skipped.why ? { lines: [{ kind: 'info', text: skipped.why }] } : {}) });
      continue;
    }
    for (;;) {
      const seen: TaskLine[] = [];
      hooks.emit({ id, status: 'running' });
      const tw: Wizard = { ...w, out: taskOut(w.out, id, hooks.emit, seen) };
      let r: Outcome;
      try {
        r = await body[id](tw);
      } catch (e) {
        tw.out.fail(errMsg(e));
        r = { status: 'fail', error: errMsg(e) };
      }
      // Warnings on the way (hints, a skipped redirect, a busy router) make an ok task a warning.
      const status = r.status === 'ok' && seen.some((l) => l.kind === 'warn' || l.kind === 'fail') ? 'warn' : r.status;
      tasks[id] = status;
      hooks.emit({ id, status });
      if (status !== 'fail') break;
      const error = r.error ?? [...seen].reverse().find((l) => l.kind === 'fail' || l.kind === 'warn')?.text ?? at(w.locale, TASKS[id].hint);
      const next = await hooks.decide(id, error);
      if (next === 'retry') continue;
      if (next === 'back') return { kind: 'back', to: id };
      // Without the file nothing after it can run: skipping it is stopping.
      if (next === 'abort' || id === 'config') return { kind: 'aborted', wrote };
      tasks[id] = 'skipped';
      hooks.emit({ id, status: 'skipped' });
      break;
    }
  }
  return { kind: 'done', code: 0, values, tasks, doctor };
}
