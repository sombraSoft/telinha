// `telinha doctor [--json] [--no-phone] [--local]`: runs the checks, then (with
// the service running) the phone test: a one-time link and QR code the user
// opens on mobile data, which measures the HTTPS, LiveKit signaling, TCP and
// UDP media paths (and TURN over TLS when it is on) from outside the network.
// Exit 1 when anything failed. On a terminal it is an interactive checklist
// (loaded on demand, so plain runs and the docs generator never load the UI);
// otherwise, and with --json, a plain table.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from '../config.ts';
import { CHECKS, checkTitle, runChecks } from '../doctor/checks.ts';
import { PhoneTest, type DoctorControl, type PhoneOutcome, type PhoneTestState } from '../doctor/phone-test.ts';
import { renderQr } from '../doctor/qr.ts';
import type { Check, CheckContext, CheckResult, CheckStatus, NatProberLike, ServiceStatusFn, TrayStateLike, UpdateStateLike } from '../doctor/types.ts';
import { loadEnvFile, mergeEnv } from '../envfile.ts';
import * as nat from '../nat/index.ts';
import { serviceManager } from '../service/index.ts';
import { latestStable } from '../update/github.ts';
import { readState, statePath } from '../update/state.ts';
import { nodeFs } from '../update/types.ts';
import { GLOBAL_FLAGS, parseArgs, UsageError, type CliContext, type ParsedArgs } from './args.ts';
import { createControlClient } from './control.ts';
import { doctorStrings, type DoctorStrKey } from './doctor-strings.ts';
import { ts, type Locale } from './strings.ts';
import { createTerm, type Term, type TermOut } from './term.ts';

// --no-phone is the parser's --no-<boolean>.
export const DOCTOR_FLAGS = { json: 'boolean', phone: 'boolean', local: 'boolean' } as const;
export const DOCTOR_SPEC = { flags: { ...GLOBAL_FLAGS, ...DOCTOR_FLAGS } } as const;

const t = doctorStrings;
type StrKey = DoctorStrKey;

export interface DoctorCliDeps {
  checks?: readonly Check[];
  /** Overrides parts of the CheckContext built from ctx (tests). */
  context?: Partial<CheckContext>;
  control?: DoctorControl;
  /** Where the table and the phone test are written; JSON goes to ctx.stdout. */
  out?: TermOut;
  now?: () => number;
  qr?: (url: string) => string;
  /** Registers a Ctrl+C handler for the phone wait; returns its remover. */
  onInterrupt?: (fn: () => void) => () => void;
  checkTimeoutMs?: number;
  /** Runs the interactive doctor on a terminal (tests swap it). */
  tui?: DoctorTuiRunner;
}

export type DoctorTuiRunner = (o: { ctx: CliContext; flags: { phone?: boolean; local?: boolean }; deps: DoctorCliDeps }) => Promise<number>;

// Both imports are dynamic: nothing on the plain path may load Solid/OpenTUI.
const tuiRunner: DoctorTuiRunner = async (o) => {
  const { prepareTui } = await import('../tui/load.ts');
  await prepareTui();
  const { runDoctorTui } = await import('../tui/doctor/index.tsx');
  return runDoctorTui(o);
};

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '–' };

function readUpdateState(path: string): Promise<UpdateStateLike | null> {
  if (!existsSync(path)) return Promise.resolve(null);
  return readState(nodeFs(), path).then((s) => (Object.keys(s).length ? (s as UpdateStateLike) : null));
}

/** The tray writes this at start and removes it at a clean exit; anything unreadable counts as absent. */
function readTrayState(path: string): TrayStateLike | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Partial<TrayStateLike> | null;
    if (!j || typeof j.version !== 'string' || typeof j.pid !== 'number' || typeof j.exe !== 'string') return null;
    return { version: j.version, pid: j.pid, startedAt: typeof j.startedAt === 'number' ? j.startedAt : 0, exe: j.exe };
  } catch {
    return null;
  }
}

/** The checks' context from the merged environment (telinha.env, then the process environment over it). */
export async function buildCheckContext(ctx: CliContext, o: { local: boolean; control: DoctorControl }): Promise<CheckContext> {
  let fileVars: Record<string, string> = {};
  let configError: string | null = null;
  try {
    fileVars = loadEnvFile(ctx.envFile)?.vars ?? {};
  } catch (e) {
    configError = `${ctx.envFile}: ${(e as Error).message}`;
  }
  const env = mergeEnv(fileVars, ctx.env);
  let config: Config | null = null;
  if (!configError) {
    try {
      config = loadConfig(env, { compiled: ctx.compiled });
    } catch (e) {
      configError = (e as Error).message;
    }
  }
  const manager = serviceManager({
    platform: process.platform, isRoot: process.getuid?.() === 0, paths: ctx.paths, envFile: ctx.envFile, env: ctx.env,
  });
  // Only a native install has a service to report on: Docker and dev skip the check.
  const service: ServiceStatusFn | null = ctx.compiled && manager ? () => manager.status() : null;
  const natProbe: NatProberLike = { probe: () => nat.probe() };
  return {
    env, envFile: ctx.envFile, paths: ctx.paths, config, configError, fetch, locale: ctx.locale, local: o.local,
    nat: natProbe, service, control: o.control, compiled: ctx.compiled, version: ctx.version,
    latestTag: () => latestStable(),
    updateState: await readUpdateState(statePath(ctx.paths)),
    trayState: readTrayState(join(ctx.paths.run, 'tray.json')),
  };
}

export async function run(args: ParsedArgs, ctx: CliContext, deps: DoctorCliDeps = {}): Promise<number> {
  let flags: { json?: boolean; phone?: boolean; local?: boolean };
  try {
    flags = parseArgs(ctx.argv, DOCTOR_SPEC, { locale: ctx.locale }).flags;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    ctx.stderr(e.message);
    ctx.stderr(ts(ctx.locale, 'helpDoctor'));
    return 2;
  }
  const json = !!flags.json;
  const local = !!flags.local;
  if (!json && ctx.tty) return (deps.tui ?? tuiRunner)({ ctx, flags: { phone: flags.phone, local }, deps });
  const now = deps.now ?? Date.now;
  const L = ctx.locale;
  const s = (key: StrKey, params?: Record<string, string | number>) => t(L, key, params);
  // JSON owns stdout; the human side (phone link, QR) goes to stderr then.
  const out: TermOut = deps.out ?? (json ? process.stderr : process.stdout);
  const term = createTerm({ stdout: out, tty: ctx.tty, yes: ctx.yes, locale: L, env: ctx.env });
  const control = deps.control ?? createControlClient({ paths: ctx.paths, envFile: ctx.envFile, env: ctx.env });

  const checkCtx: CheckContext = { ...(await buildCheckContext(ctx, { local, control })), ...deps.context, local };
  const checks = deps.checks ?? CHECKS;

  // Live table: a "Checking ..." line that the result replaces (TTY with colours only).
  const width = Math.max(0, ...checks.map((c) => checkTitle(c.id, L).length));
  const live = !json && term.colors;
  const paintPending = (i: number) => {
    const c = checks[i];
    if (live && c) out.write(`  ${term.style.dim(s('checking', { title: checkTitle(c.id, L) }))}`);
  };
  let index = 0;
  paintPending(index);
  const results = await runChecks(checks, checkCtx, (r) => {
    if (!json) {
      if (live) out.write('\r\x1b[2K');
      printResult(term, r, width);
    }
    paintPending(++index);
  }, deps.checkTimeoutMs ? { timeoutMs: deps.checkTimeoutMs } : {});

  const count = (st: CheckStatus) => results.filter((r) => r.status === st).length;
  if (!json) {
    term.line();
    term.info(s('summary', { ok: count('ok'), warn: count('warn'), fail: count('fail'), skip: count('skip') }));
  }

  let phone: PhoneOutcome | null = null;
  if (flags.phone !== false && !local) {
    if (!ctx.tty) {
      if (!json) term.info(s('phoneNoTty'));
    } else {
      phone = await phoneTest({ term, s, locale: L, control, now, qr: deps.qr ?? ((u) => renderQr(u, { env: ctx.env })), onInterrupt: deps.onInterrupt ?? sigint, config: checkCtx.config });
    }
  }

  if (json) {
    ctx.stdout(JSON.stringify({ checks: results, ...(phone?.report ? { phone: phone.report } : {}) }, null, 2));
  }
  return count('fail') > 0 || phone?.status === 'fail' ? 1 : 0;
}

function printResult(term: Term, r: CheckResult, width: number) {
  const st = term.style;
  const paint = { ok: st.green, warn: st.yellow, fail: st.red, skip: st.dim }[r.status];
  term.line(`${paint(ICON[r.status])} ${r.title.padEnd(width)}  ${r.status === 'skip' ? st.dim(r.summary) : r.summary}`);
  const pad = ' '.repeat(width + 4);
  for (const d of r.detail ?? []) term.line(`${pad}${st.dim(d)}`);
  if (r.fix && r.status !== 'ok') term.line(`${pad}${st.cyan('→')} ${r.fix}`);
}

function sigint(fn: () => void): () => void {
  process.on('SIGINT', fn);
  return () => void process.off('SIGINT', fn);
}

type Say = (key: StrKey, params?: Record<string, string | number>) => string;

async function phoneTest(o: {
  term: Term;
  s: Say;
  locale: Locale;
  control: DoctorControl;
  now: () => number;
  qr: (url: string) => string;
  onInterrupt: (fn: () => void) => () => void;
  config: Config | null;
}): Promise<PhoneOutcome> {
  o.term.step(o.s('phoneTitle'));
  const test = new PhoneTest({ control: o.control, config: o.config, locale: o.locale, now: o.now });
  let shown: PhoneTestState | null = null;
  test.subscribe(() => {
    const st = test.state;
    if (st) printPhone(o.term, o.s, o.qr, st, shown);
    shown = st;
  });
  const remove = o.onInterrupt(() => test.skip());
  try {
    void test.start();
    return await test.finished();
  } finally {
    remove();
    test.dispose();
  }
}

/** Prints what changed since the last state; the rows as the checks' table draws them, each hint under the row it explains. */
function printPhone(term: Term, s: Say, qr: (url: string) => string, st: PhoneTestState, prev: PhoneTestState | null) {
  switch (st.kind) {
    case 'notRunning':
      return term.warn(s('phoneNotRunning'));
    case 'error':
      return term.warn(s('phoneError', { error: st.message }));
    case 'waiting':
      if (prev?.kind !== 'waiting') {
        term.line(s('phoneOpen'));
        term.line(`  ${term.link(st.url)}`);
        term.line();
        term.line(qr(st.url));
        term.info(s('phoneWaiting'));
      }
      if (st.opened && !(prev?.kind === 'waiting' && prev.opened)) term.info(s('phoneOpened'));
      return;
    case 'done': {
      const w = Math.max(...st.rows.map((row) => row.label.length));
      st.rows.forEach((row, i) => {
        // UDP and TCP share the hint when both are closed: once, under the second.
        const hint = row.hint && st.rows[i + 1]?.hint !== row.hint ? { fix: row.hint } : {};
        printResult(term, { id: row.id, title: row.label, status: row.status, summary: row.value, ...hint }, w);
      });
      if (st.status === 'ok') term.ok(s('phoneAllGood'));
      return;
    }
    case 'expired':
      return term.warn(s('phoneExpired'));
    case 'skipped':
      return term.info(s('phoneSkipped'));
  }
}
