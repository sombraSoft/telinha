// `telinha setup`: the questions that make telinha.env, then (natively) the
// binaries, the service, the router probe and doctor. On a terminal the setup
// screens ask and show the install (setup/ui.ts is their contract; main.ts
// loads them); `--non-interactive`, or no terminal, takes every answer from
// flags, the environment and the existing file (secrets never from flags) and
// prints plain lines. Both end in the same answers -> values -> tasks.
// `--docker` runs inside the image and only writes the file.
import { constants as fsc, existsSync } from 'node:fs';
import { chmod, copyFile, lchown, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { arch as osArch } from 'node:os';
import { posix } from 'node:path';
import { ensureBinariesForConfig } from '../bins.ts';
import { portInUse } from '../children.ts';
import { createDuckDns } from '../ddns.ts';
import { mergeEnv, parseEnvFile } from '../envfile.ts';
import { probe } from '../nat/index.ts';
import { lookupPublicIp, resolveA, tlsInfo } from '../netinfo.ts';
import { defaultSpawn, serviceManager } from '../service/index.ts';
import { assertOneStdin, GLOBAL_FLAGS, parseArgs, readSecretSource, UsageError, type ArgSpec, type CliContext, type ParsedArgs } from './args.ts';
import { createControlClient } from './control.ts';
import { at } from './setup/apply-strings.ts';
import { planTasks, runApply, silentOut, TASKS, todoLines, type ApplyHooks, type ApplyOptions, type ApplyResult, type ApplyTarget, type SecretMemo, type TaskId, type TaskLine, type TaskStatus } from './setup/apply.ts';
import { createDiscordSetup } from './setup/discord.ts';
import { MANAGED_KEYS } from './setup/envwrite.ts';
import { defaultOsName, detectHost, routerLabel, type HostInfo } from './setup/host.ts';
import type { ModelEnv, Text } from './setup/model.ts';
import { q } from './setup/qstrings.ts';
import { answersFromFlags, resolveValues, type ResolveBase } from './setup/resolve.ts';
import { SetupSession } from './setup/session.ts';
import { nextSteps, SetupAbort, UNPRIVILEGED_PORT_START, validateValues, type SetupDeps, type SetupFs, type Values, type Wizard } from './setup/steps.ts';
import { t, type SKey } from './setup/strings.ts';
import type { SetupUi, SetupUiResult } from './setup/ui.ts';
import { ts, type Locale, type Params } from './strings.ts';
import { createTerm, type Out } from './term.ts';

export type { SetupDeps } from './setup/steps.ts';

export const SETUP_FLAGS = {
  docker: 'boolean',
  host: 'string',
  'public-url': 'string',
  ingress: 'string',
  advanced: 'boolean',
  'http-port': 'string',
  'https-port': 'string',
  'tunnel-token-file': 'string',
  'duckdns-domain': 'string',
  'duckdns-token-file': 'string',
  'media-tcp': 'string',
  'media-udp': 'string',
  'node-ip': 'string',
  'discord-token-file': 'string',
  'client-secret-file': 'string',
  'client-id': 'string',
  guild: 'string',
  role: 'string',
  channels: 'string',
  command: 'string',
  group: 'string',
  upnp: 'string',
  'auto-update': 'string',
  'no-service': 'boolean',
  'no-firewall': 'boolean',
  'no-upnp': 'boolean',
  'no-doctor': 'boolean',
  'no-discord-check': 'boolean',
} as const;
export const SETUP_SPEC = { flags: { ...GLOBAL_FLAGS, ...SETUP_FLAGS } } as const satisfies ArgSpec;
type Flags = ParsedArgs<typeof SETUP_SPEC>['flags'];

/** Secrets: telinha.env key, its -file flag. */
const SECRETS = [
  ['DISCORD_TOKEN', 'discord-token-file'],
  ['DISCORD_CLIENT_SECRET', 'client-secret-file'],
  ['TUNNEL_TOKEN', 'tunnel-token-file'],
  ['DUCKDNS_TOKEN', 'duckdns-token-file'],
] as const;
type SecretKey = (typeof SECRETS)[number][0];

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function nodeFs(): SetupFs {
  return {
    mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
    async createFile(path, data, o) {
      // O_NOFOLLOW does not exist on Windows (and is 0 there in Node's constants).
      const fh = await open(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0), o.mode);
      try {
        if (process.platform !== 'win32') {
          // open's mode went through the umask.
          await fh.chmod(o.mode);
          if (o.uid !== undefined && o.gid !== undefined) await fh.chown(o.uid, o.gid);
        }
        await fh.writeFile(data);
      } finally {
        await fh.close();
      }
    },
    rename: (from, to) => rename(from, to),
    chmod: (path, mode) => chmod(path, mode),
    chown: (path, uid, gid) => lchown(path, uid, gid),
    async stat(path) {
      try {
        const st = await lstat(path);
        return { uid: st.uid, gid: st.gid, mode: st.mode, dir: st.isDirectory(), symlink: st.isSymbolicLink() };
      } catch {
        return null;
      }
    },
    rm: (path) => rm(path, { force: true }),
    async readText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    exists: (path) => stat(path).then(() => true, () => false),
    // Exclusive: never through a symlink someone planted at the target.
    copyFile: (from, to) => copyFile(from, to, fsc.COPYFILE_EXCL),
  };
}

/** A UDP bind test: the port is free when nothing holds it. */
async function udpFree(port: number): Promise<boolean> {
  try {
    const sock = await Bun.udpSocket({ port });
    sock.close();
    return true;
  } catch {
    return false;
  }
}

async function openUrl(url: string, platform: NodeJS.Platform): Promise<void> {
  // rundll32 hands the URL to the default browser without cmd's & parsing.
  const cmd = platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
  const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} exited with ${proc.exitCode}`);
}

export function defaultDeps(ctx: CliContext, o: { tty: boolean }): SetupDeps {
  const platform = process.platform;
  const isRoot = process.getuid?.() === 0;
  const control = createControlClient({ paths: ctx.paths, envFile: ctx.envFile, env: ctx.env });
  return {
    term: (locale) => createTerm({ tty: o.tty, yes: ctx.yes, locale }),
    fetch,
    nat: { probe: () => probe() },
    ddns: ({ domain, token }) => createDuckDns({ domain, token, fetch, log: () => {} }),
    discord: (token) => createDiscordSetup({ token, fetch, version: ctx.version }),
    serviceManager: ({ user }) => serviceManager({ platform, isRoot, user, paths: ctx.paths, envFile: ctx.envFile, env: ctx.env }),
    control,
    bins: (config, paths, log, progress) => ensureBinariesForConfig(config, paths, log, { progress }),
    spawn: defaultSpawn,
    spawnInteractive: async (cmd) => {
      try {
        return (await Bun.spawn(cmd, { stdio: ['inherit', 'inherit', 'inherit'] }).exited) ?? 1;
      } catch {
        return 127;
      }
    },
    openUrl: (url) => openUrl(url, platform),
    fs: nodeFs(),
    platform,
    arch: osArch(),
    isRoot,
    osName: () => defaultOsName(platform),
    existsSync,
    lookupPublicIp: () => lookupPublicIp(fetch, 5000),
    resolveA: (host) => resolveA(host),
    portInUse,
    udpFree,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    // Imported on use: doctor pulls in the checks and the QR renderer.
    doctor: async (c) => (await import('./doctor.ts')).run({ flags: {}, positionals: c.argv.slice(1), rest: [] }, c),
    async doctorChecks(c, onResult) {
      const [{ buildCheckContext }, { CHECKS, runChecks }] = await Promise.all([import('./doctor.ts'), import('../doctor/checks.ts')]);
      let done = 0;
      return runChecks(CHECKS, await buildCheckContext(c, { local: false, control }), (r) => onResult?.(r, ++done, CHECKS.length));
    },
    execPath: process.execPath,
    which: (cmd) => Bun.which(cmd),
    certReady: async (host, port) => (await tlsInfo(host, port, 5000, '127.0.0.1')).authorized,
  };
}

function makeWizard(ctx: CliContext, deps: SetupDeps, locale: Locale, host: HostInfo, o: { docker: boolean; out: Out }): Wizard {
  return { ctx, deps, out: o.out, locale, s: (key: SKey, params?: Params) => t(locale, key, params), host, docker: o.docker };
}

/** Managed keys from the file, overridden by the environment (the rule `run` applies). */
function currentValues(fileVars: Record<string, string>, env: Record<string, string | undefined>): Values {
  const merged = mergeEnv(fileVars, Object.fromEntries(MANAGED_KEYS.map((k) => [k, env[k]])));
  return Object.fromEntries(MANAGED_KEYS.filter((k) => merged[k]).map((k) => [k, merged[k]!]));
}

function hostLine(w: Wizard): string {
  const h = w.host;
  const parts = [h.docker ? `${h.osName} (Docker)` : h.osName, h.arch];
  parts.push(h.publicIp ? w.s('hostPublicIp', { ip: h.publicIp }) : w.s('hostNoPublicIp'));
  const router = h.nat && routerLabel(h.nat);
  const line = w.s('hostLine', { what: parts.join(', ') });
  return router ? `${line} ${w.s('hostRouter', { router })}` : line;
}

async function detect(ctx: CliContext, deps: SetupDeps, docker: boolean): Promise<HostInfo> {
  return detectHost({
    platform: deps.platform,
    arch: deps.arch,
    isRoot: deps.isRoot,
    env: ctx.env,
    dockerFlag: docker,
    exists: deps.existsSync,
    osName: deps.osName,
    lookupPublicIp: deps.lookupPublicIp,
    probe: () => deps.nat.probe(),
  });
}

/** The file to write and the managed values it holds now. */
interface Loaded extends ApplyTarget { values: Values }

/** install-docker.sh's layout, for an image run without TELINHA_HOST_ENV. */
const DOCKER_HOST_ENV = '/opt/telinha/config/telinha.env';

async function load(ctx: CliContext, deps: SetupDeps, docker: boolean): Promise<Loaded> {
  // Inside the image only the mounted config dir is the host's.
  const file = docker ? posix.join(ctx.paths.config, 'telinha.env') : ctx.envFile;
  const text = await deps.fs.readText(file);
  const previous = text === null ? null : { vars: parseEnvFile(text).vars, text };
  const shown = docker ? ctx.env.TELINHA_HOST_ENV || DOCKER_HOST_ENV : file;
  return { file, shown, previous, values: currentValues(previous?.vars ?? {}, ctx.env) };
}

/** Secrets from the environment or their -file flags (env wins); never from a flag's value. */
async function readSecrets(ctx: CliContext, flags: Flags, stdin?: () => Promise<string>): Promise<Partial<Record<SecretKey, string>>> {
  assertOneStdin(SECRETS.map(([, f]) => flags[f]), ctx.locale);
  const out: Partial<Record<SecretKey, string>> = {};
  for (const [key, fileFlag] of SECRETS) {
    const v = await readSecretSource({ env: ctx.env[key], file: flags[fileFlag], stdin });
    if (v) out[key] = v;
  }
  return out;
}

/** What the questions may look at besides the answers (the machine comes later). */
function modelEnv(ctx: CliContext, deps: SetupDeps, flags: Flags, file: Values, o: { docker: boolean; portStart: number | null }): Omit<ModelEnv, 'lookups' | 'host'> {
  return {
    platform: deps.platform, isRoot: deps.isRoot, docker: o.docker, compiled: ctx.compiled,
    offline: !!flags['no-discord-check'], langFlag: !!flags.lang,
    flags: { noService: !!flags['no-service'], noUpnp: !!flags['no-upnp'], noFirewall: !!flags['no-firewall'], noDoctor: !!flags['no-doctor'] },
    file, unprivilegedPortStart: o.portStart, locale: ctx.locale,
  };
}

function applyOptions(ctx: CliContext, flags: Flags, docker: boolean, o: Pick<ApplyOptions, 'sysctl' | 'rotateCookie' | 'doctorMode' | 'secrets'>): ApplyOptions {
  return {
    docker, compiled: ctx.compiled,
    flags: { noService: !!flags['no-service'], noFirewall: !!flags['no-firewall'], noUpnp: !!flags['no-upnp'], noDoctor: !!flags['no-doctor'], offline: !!flags['no-discord-check'] },
    ...o,
  };
}

const textOf = (locale: Locale, x: Text) => ('raw' in x ? x.raw : q(locale, x.key, x.params));

/** The plain run's task headers (the setup screens show the task labels instead). */
const HEADERS: Partial<Record<TaskId, SKey>> = {
  discord: 'discordTitle', binaries: 'binsTitle', service: 'serviceTitle', router: 'routerTitle', start: 'startTitle', doctor: 'doctorTitle',
};

/** Lines as they come, a header when a task starts, and no one to ask. */
function plainHooks(w: Wizard): ApplyHooks {
  const started = new Set<TaskId>();
  return {
    emit(e) {
      if (e.status !== 'running' || started.has(e.id)) return;
      started.add(e.id);
      const header = HEADERS[e.id];
      if (header) w.out.step(w.s(header));
    },
    // Up to the file a failure leaves nothing written; after it, what is left still helps.
    decide: async (id) => (id === 'discord' || id === 'duckdns' || id === 'config' ? 'abort' : 'skip'),
    withTerminal: (fn) => fn(),
  };
}

async function nonInteractive(ctx: CliContext, deps: SetupDeps, flags: Flags, o: { stdin?: () => Promise<string> }): Promise<number> {
  const docker = !!flags.docker;
  const l = await load(ctx, deps, docker);
  // The machine first: without --host it is what tells home from VPS.
  const host = await detect(ctx, deps, docker);
  const secrets = await readSecrets(ctx, flags, o.stdin);
  const env: ModelEnv = { ...modelEnv(ctx, deps, flags, l.values, { docker, portStart: null }), host, lookups: {} };
  const r = answersFromFlags(flags, env, { secrets, locale: ctx.locale, lenient: false, advanced: !!flags.advanced, env: ctx.env });
  if (r.errors.length || r.missing.length) {
    for (const e of r.errors) ctx.stderr(textOf(ctx.locale, e));
    if (r.missing.length) ctx.stderr(q(ctx.locale, 'missing', { list: r.missing.join(', ') }));
    return 2;
  }
  const values = resolveValues(r.answers, env, { file: l.values, host, locale: ctx.locale, langFlag: !!flags.lang, docker, compiled: ctx.compiled });
  const w = makeWizard(ctx, deps, ctx.locale, host, { docker, out: deps.term(ctx.locale) });
  w.out.info(hostLine(w));
  const opts = applyOptions(ctx, flags, docker, { sysctl: 'auto', rotateCookie: false, doctorMode: 'cli' });
  const result = await runApply(w, l, values, planTasks(values, opts), opts, plainHooks(w));
  if (result.kind !== 'done') return 1;
  nextSteps(w, values, { file: l.shown });
  return result.code;
}

/** ip_unprivileged_port_start, read once: whether a Linux user needs the sudo step for 80/443. */
async function portStart(deps: SetupDeps): Promise<number | null> {
  if (deps.platform !== 'linux') return null;
  const n = Number((await deps.fs.readText(UNPRIVILEGED_PORT_START).catch(() => null))?.trim() ?? NaN);
  return Number.isInteger(n) ? n : null;
}

/** One task's latest attempt, as the setup screens' row has it. */
interface RanTask {
  status: TaskStatus;
  lines: TaskLine[];
  /** The line that ended the task's spinner ("Service installed"). */
  result: TaskLine | null;
  spinning: boolean;
}

/** What the plain epilogue needs from the task list the screens showed. */
interface Ran { plan: TaskId[]; tasks: Map<TaskId, RanTask> }

function tracker(): { ran: Ran; track(plan: TaskId[]): (e: Parameters<ApplyHooks['emit']>[0]) => void } {
  const ran: Ran = { plan: [], tasks: new Map() };
  return {
    ran,
    track(plan) {
      ran.plan = plan;
      ran.tasks.clear();
      return (e) => {
        let t = ran.tasks.get(e.id);
        // A bare 'running' starts an attempt (a retry starts clean), as on the screens.
        if (!t || (e.status === 'running' && !e.detail && !e.lines && !e.progress && !e.checks)) {
          t = { status: e.status, lines: [], result: null, spinning: false };
          ran.tasks.set(e.id, t);
        }
        t.status = e.status;
        if (e.detail !== undefined) t.spinning = true;
        if (e.lines?.length) {
          if (t.spinning) t.result = e.lines[0]!;
          t.spinning = false;
          t.lines.push(...e.lines);
        }
      };
    },
  };
}

/** The line a task's summary row shows: what its spinner ended with, the failure, or the line that says it all. */
function headline(id: TaskId, t: RanTask): TaskLine | undefined {
  // The router's lines are a list to read top down (what was found, what is left to do).
  if (id === 'router') return t.lines[0];
  if (t.status === 'fail') return t.lines.findLast((l) => l.kind === 'fail') ?? t.lines.at(-1);
  return t.result ?? t.lines.find((l) => l.kind === 'ok') ?? t.lines.at(-1);
}

/** One row per task that ran: ✓/!/✗/– label: its headline; under it what is left to do (todoLines). */
function summary(out: Out, locale: Locale, ran: Ran): void {
  const rows = ran.plan.filter((id) => ['ok', 'warn', 'fail', 'skipped'].includes(ran.tasks.get(id)?.status ?? ''));
  if (!rows.length) return;
  out.step(at(locale, 'summaryTitle'));
  const mark = (k: TaskLine['kind']) => (k === 'ok' ? out.style.green('✓') : k === 'warn' ? out.style.yellow('!') : k === 'fail' ? out.style.red('✗') : ' ');
  for (const id of rows) {
    const t = ran.tasks.get(id)!;
    const label = at(locale, TASKS[id].label);
    const head = headline(id, t);
    const [first = '', ...more] = head?.text.split('\n') ?? [];
    const line = head ? `${label}: ${first}` : label;
    if (t.status === 'ok') out.ok(line);
    else if (t.status === 'warn') out.warn(line);
    else if (t.status === 'fail') out.fail(line);
    else out.line(`${out.style.dim('–')} ${line}`);
    for (const m of more) out.line(`  ${m}`);
    for (const l of todoLines(id, t.lines)) {
      if (l === head) continue;
      const [a = '', ...rest] = l.text.split('\n');
      out.line(`    ${mark(l.kind)} ${a}`);
      for (const r of rest) out.line(`      ${r}`);
    }
  }
}

async function interactive(ctx: CliContext, deps: SetupDeps, ui: SetupUi, flags: Flags, o: { stdin?: () => Promise<string>; offer: { envFile: string } | null }): Promise<number | null> {
  const docker = !!flags.docker;
  const l = await load(ctx, deps, docker);
  // Detection takes seconds offline: the first question shows while it runs.
  const detecting = detect(ctx, deps, docker);
  const secrets = await readSecrets(ctx, flags, o.stdin);
  const envBase = modelEnv(ctx, deps, flags, l.values, { docker, portStart: await portStart(deps) });
  // Flags next to a terminal are the questions' defaults; a rule they break is a notice on the first card, not an exit.
  const pre = answersFromFlags(flags, { ...envBase, host: null, lookups: {} }, { secrets, locale: ctx.locale, lenient: true, advanced: !!flags.advanced, env: ctx.env });
  const base: ResolveBase = { file: l.values, host: null, locale: ctx.locale, langFlag: !!flags.lang, docker, compiled: ctx.compiled };
  const session = new SetupSession({
    env: envBase, host: null, base, locale: ctx.locale, deps,
    preset: pre.answers, presetErrors: pre.errors, acceptDefaults: ctx.yes, rerun: l.previous !== null,
  });
  const host = detecting.then((h) => {
    session.setHost(h);
    return h;
  });
  host.catch(() => {});

  const memo: SecretMemo = { made: {} };
  const { ran, track } = tracker();
  let applied: Values | null = null;
  // Across re-applies: an earlier attempt's telinha.env stays on disk whatever the last one did.
  let wroteAny = false;
  const apply = async (a: { rotateCookie: boolean }, hooks: ApplyHooks): Promise<ApplyResult> => {
    const h = await host;
    const values = session.values();
    const opts = applyOptions(ctx, flags, docker, { sysctl: session.applyOptions().sysctl ?? 'auto', rotateCookie: a.rotateCookie, doctorMode: 'data', secrets: memo });
    const plan = planTasks(values, opts);
    const record = track(plan);
    applied = values;
    const w = makeWizard(ctx, deps, session.locale, h, { docker, out: silentOut() });
    const emit: ApplyHooks['emit'] = (e) => {
      record(e);
      if (e.id === 'config' && (e.status === 'ok' || e.status === 'warn')) wroteAny = true;
      hooks.emit(e);
    };
    return runApply(w, l, values, plan, opts, { ...hooks, emit });
  };
  const doctor = docker || flags['no-doctor'] ? null : {
    buildContext: async () => (await import('./doctor.ts')).buildCheckContext({ ...ctx, locale: session.locale }, { local: false, control: deps.control }),
    control: deps.control,
    config: () => {
      if (!applied) return null;
      try {
        return validateValues(applied, l.previous, ctx.paths.home, { compiled: ctx.compiled }).config;
      } catch {
        return null;
      }
    },
  };

  let result: SetupUiResult;
  try {
    result = await ui.run({ ctx, version: ctx.version, docker, session, apply, offer: o.offer, doctor, shownFile: l.shown });
  } finally {
    session.dispose();
  }

  // The screens are gone: what stays in the terminal is plain.
  const locale = session.locale;
  const out = deps.term(locale);
  if (result.kind === 'declined') return null;
  const config = ran.tasks.get('config')?.status;
  const wrote = config === 'ok' || config === 'warn';
  // The last attempt did not get to the file, an earlier one did: say so instead of "nothing was written".
  const notWritten = () => (wroteAny ? out.warn(t(locale, 'wroteEarlier', { file: l.shown })) : ctx.stderr(t(locale, 'aborted')));
  if (result.kind === 'quit' || result.result.kind === 'back') {
    if (wrote || wroteAny) summary(out, locale, ran);
    if (!wrote) notWritten();
    return result.kind === 'quit' && result.reason === 'ctrl-c' ? 130 : 1;
  }
  const r = result.result;
  summary(out, locale, ran);
  if (r.kind === 'aborted') {
    if (!r.wrote) notWritten();
    return 1;
  }
  nextSteps(makeWizard(ctx, deps, locale, await host, { docker, out }), r.values, { file: l.shown });
  return r.code;
}

async function setup(ctx: CliContext, deps: Partial<SetupDeps>, o: { stdin?: () => Promise<string>; offer: { envFile: string } | null }): Promise<number | null> {
  let flags: Flags;
  try {
    flags = parseArgs(ctx.argv, SETUP_SPEC, { locale: ctx.locale }).flags;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    ctx.stderr(e.message);
    ctx.stderr(ts(ctx.locale, 'helpSetup'));
    return 2;
  }
  // ctx.tty is false with --non-interactive or without a terminal.
  const tty = ctx.tty && !flags['non-interactive'];
  const d: SetupDeps = { ...defaultDeps(ctx, { tty }), ...deps };
  try {
    if (tty && d.ui) return await interactive(ctx, d, d.ui, flags, o);
    // A terminal without the setup screens (main.ts always passes them) runs the plain path.
    if (o.offer) d.term(ctx.locale).warn(ts(ctx.locale, 'noConfig', { path: o.offer.envFile }));
    return await nonInteractive(ctx, d, flags, o);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.stderr(e.message);
      return 2;
    }
    if (e instanceof SetupAbort) {
      ctx.stderr(e.message);
      return e.code;
    }
    ctx.stderr(t(ctx.locale, 'failed', { error: errMsg(e) }));
    return 1;
  }
}

export async function run(_args: ParsedArgs, ctx: CliContext, deps: Partial<SetupDeps> = {}, o: { stdin?: () => Promise<string> } = {}): Promise<number> {
  // Only the welcome card declines, and run never shows it.
  return (await setup(ctx, deps, { ...o, offer: null })) ?? 1;
}

/**
 * `telinha` with no arguments on a TTY and no telinha.env: setup with a
 * welcome card first. Resolves with setup's exit code, or null when the user
 * declined.
 */
export async function offerSetup(ctx: CliContext, deps: Partial<SetupDeps> = {}): Promise<number | null> {
  return setup({ ...ctx, argv: ['setup'] }, deps, { offer: { envFile: ctx.envFile } });
}
