// `telinha setup`: the questions that make telinha.env, then (natively) the
// binaries, the service, the router probe and doctor. On a terminal the setup
// screens ask and show the install (setup/ui.ts is their contract; main.ts
// loads them); `--non-interactive`, or no terminal, takes every answer from
// flags, the environment and the existing file (secrets never from flags) and
// prints plain lines. Both end in the same answers -> values -> tasks.
// `--docker` runs inside the image and only writes the file.
import { existsSync, constants as fsc } from 'node:fs';
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
import { autostartEnabled, defaultTrayLauncher, trayDistPath, trayExePath } from '../service/tray.ts';
import {
  type ArgSpec,
  assertOneStdin,
  type CliContext,
  GLOBAL_FLAGS,
  type ParsedArgs,
  parseArgs,
  readSecretSource,
  UsageError,
} from './args.ts';
import { createControlClient } from './control.ts';
import {
  type ApplyHooks,
  type ApplyOptions,
  type ApplyResult,
  type ApplyTarget,
  planTasks,
  runApply,
  type SecretMemo,
  type SummaryRow,
  silentOut,
  TASKS,
  type TaskLine,
  TaskList,
} from './setup/apply.ts';
import { at } from './setup/apply-strings.ts';
import { createDiscordSetup } from './setup/discord.ts';
import { MANAGED_KEYS } from './setup/envwrite.ts';
import { defaultOsName, detectHost, type HostInfo, routerLabel } from './setup/host.ts';
import { type ModelEnv, type Text, type TrayState, trayHere } from './setup/model.ts';
import { q } from './setup/qstrings.ts';
import { answersFromFlags, type ResolveBase, resolveValues, trayFromFlags } from './setup/resolve.ts';
import { SetupState } from './setup/state.ts';
import {
  nextSteps,
  SetupAbort,
  type SetupDeps,
  type SetupFs,
  UNPRIVILEGED_PORT_START,
  type Values,
  validateValues,
  type Wizard,
} from './setup/steps.ts';
import { type SKey, t } from './setup/strings.ts';
import type { SetupUi, SetupUiResult } from './setup/ui.ts';
import { type Locale, type Params, ts } from './strings.ts';
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
  media: 'string',
  'cloud-url': 'string',
  'livekit-key': 'string',
  'livekit-secret-file': 'string',
  turn: 'string',
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
  'no-tray': 'boolean',
  'tray-autostart': 'boolean',
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
  ['LIVEKIT_API_SECRET', 'livekit-secret-file'],
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
    exists: (path) =>
      stat(path).then(
        () => true,
        () => false,
      ),
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
    serviceManager: ({ user }) =>
      serviceManager({ platform, isRoot, user, paths: ctx.paths, envFile: ctx.envFile, env: ctx.env }),
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
      const [{ buildCheckContext }, { CHECKS, runChecks }] = await Promise.all([
        import('./doctor.ts'),
        import('../doctor/checks.ts'),
      ]);
      let done = 0;
      return runChecks(CHECKS, await buildCheckContext(c, { local: false, control }), (r) =>
        onResult?.(r, ++done, CHECKS.length),
      );
    },
    execPath: process.execPath,
    which: (cmd) => Bun.which(cmd),
    certReady: async (host, port) => (await tlsInfo(host, port, 5000, '127.0.0.1')).authorized,
    tray: defaultTrayLauncher,
  };
}

function makeWizard(
  ctx: CliContext,
  deps: SetupDeps,
  locale: Locale,
  host: HostInfo,
  o: { docker: boolean; out: Out },
): Wizard {
  return {
    ctx,
    deps,
    out: o.out,
    locale,
    s: (key: SKey, params?: Params) => t(locale, key, params),
    host,
    docker: o.docker,
  };
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
interface Loaded extends ApplyTarget {
  values: Values;
}

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
async function readSecrets(
  ctx: CliContext,
  flags: Flags,
  stdin?: () => Promise<string>,
): Promise<Partial<Record<SecretKey, string>>> {
  assertOneStdin(
    SECRETS.map(([, f]) => flags[f]),
    ctx.locale,
  );
  const out: Partial<Record<SecretKey, string>> = {};
  for (const [key, fileFlag] of SECRETS) {
    const v = await readSecretSource({ env: ctx.env[key], file: flags[fileFlag], stdin });
    if (v) out[key] = v;
  }
  return out;
}

/** What the questions may look at besides the answers (the machine comes later). */
function modelEnv(
  ctx: CliContext,
  deps: SetupDeps,
  flags: Flags,
  file: Values,
  o: { docker: boolean; portStart: number | null; tray?: TrayState },
): Omit<ModelEnv, 'lookups' | 'host'> {
  return {
    platform: deps.platform,
    isRoot: deps.isRoot,
    docker: o.docker,
    compiled: ctx.compiled,
    offline: !!flags['no-discord-check'],
    langFlag: !!flags.lang,
    flags: {
      noService: !!flags['no-service'],
      noUpnp: !!flags['no-upnp'],
      noFirewall: !!flags['no-firewall'],
      noDoctor: !!flags['no-doctor'],
    },
    file,
    unprivilegedPortStart: o.portStart,
    locale: ctx.locale,
    ...(o.tray && { tray: o.tray }),
  };
}

/** The tray icon as this machine has it, for the tray questions' defaults (native Windows only). */
async function trayState(ctx: CliContext, deps: SetupDeps, docker: boolean): Promise<TrayState | undefined> {
  if (!trayHere({ platform: deps.platform, compiled: ctx.compiled, docker })) return undefined;
  const exe = trayExePath(ctx.paths);
  const [installed, optedOut, autostart] = await Promise.all([
    deps.fs.exists(exe),
    deps.fs.exists(trayDistPath(ctx.paths)),
    autostartEnabled(deps.spawn, exe).catch(() => false),
  ]);
  return { installed, optedOut, autostart };
}

function applyOptions(
  ctx: CliContext,
  flags: Flags,
  docker: boolean,
  o: Pick<ApplyOptions, 'sysctl' | 'rotateCookie' | 'doctorMode' | 'secrets' | 'tray'>,
): ApplyOptions {
  return {
    docker,
    compiled: ctx.compiled,
    flags: {
      noService: !!flags['no-service'],
      noFirewall: !!flags['no-firewall'],
      noUpnp: !!flags['no-upnp'],
      noDoctor: !!flags['no-doctor'],
      offline: !!flags['no-discord-check'],
    },
    ...o,
  };
}

const textOf = (locale: Locale, x: Text) => ('raw' in x ? x.raw : q(locale, x.key, x.params));

/** No one to ask: up to the file a failure leaves nothing written; after it, what is left still helps. */
const plainHooks: ApplyHooks = {
  decide: async (id) => (id === 'discord' || id === 'duckdns' || id === 'config' ? 'abort' : 'skip'),
  withTerminal: (fn) => fn(),
};

async function nonInteractive(
  ctx: CliContext,
  deps: SetupDeps,
  flags: Flags,
  o: { stdin?: () => Promise<string> },
): Promise<number> {
  const docker = !!flags.docker;
  const l = await load(ctx, deps, docker);
  // The machine first: without --host it is what tells home from VPS.
  const host = await detect(ctx, deps, docker);
  const secrets = await readSecrets(ctx, flags, o.stdin);
  const env: ModelEnv = { ...modelEnv(ctx, deps, flags, l.values, { docker, portStart: null }), host, lookups: {} };
  const r = answersFromFlags(flags, env, {
    secrets,
    locale: ctx.locale,
    lenient: false,
    advanced: !!flags.advanced,
    env: ctx.env,
  });
  if (r.errors.length || r.missing.length) {
    for (const e of r.errors) ctx.stderr(textOf(ctx.locale, e));
    if (r.missing.length) ctx.stderr(q(ctx.locale, 'missing', { list: r.missing.join(', ') }));
    return 2;
  }
  const values = resolveValues(r.answers, env, {
    file: l.values,
    host,
    locale: ctx.locale,
    langFlag: !!flags.lang,
    docker,
    compiled: ctx.compiled,
  });
  const w = makeWizard(ctx, deps, ctx.locale, host, { docker, out: deps.term(ctx.locale) });
  w.out.info(hostLine(w));
  const opts = applyOptions(ctx, flags, docker, {
    sysctl: 'auto',
    rotateCookie: false,
    doctorMode: 'cli',
    tray: trayFromFlags(flags, env),
  });
  const result = await runApply(w, l, values, planTasks(values, opts), opts, plainHooks);
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

/** One row per finished task: ✓/!/✗/– label: its headline; under it what else is left to do. */
function summary(out: Out, locale: Locale, rows: SummaryRow[]): void {
  if (!rows.length) return;
  out.step(at(locale, 'summaryTitle'));
  const mark = (k: TaskLine['kind']) =>
    k === 'ok' ? out.style.green('✓') : k === 'warn' ? out.style.yellow('!') : k === 'fail' ? out.style.red('✗') : ' ';
  for (const r of rows) {
    const label = at(locale, TASKS[r.id].label);
    const [first = '', ...more] = r.headline?.text.split('\n') ?? [];
    const line = r.headline ? `${label}: ${first}` : label;
    if (r.status === 'ok') out.ok(line);
    else if (r.status === 'warn') out.warn(line);
    else if (r.status === 'fail') out.fail(line);
    else out.line(`${out.style.dim('–')} ${line}`);
    for (const m of more) out.line(`  ${m}`);
    for (const l of r.todo) {
      const [a = '', ...rest] = l.text.split('\n');
      out.line(`    ${mark(l.kind)} ${a}`);
      for (const x of rest) out.line(`      ${x}`);
    }
  }
}

async function interactive(
  ctx: CliContext,
  deps: SetupDeps,
  ui: SetupUi,
  flags: Flags,
  o: { stdin?: () => Promise<string>; offer: { envFile: string } | null },
): Promise<number | null> {
  const docker = !!flags.docker;
  const l = await load(ctx, deps, docker);
  // Detection takes seconds offline: the first question shows while it runs.
  const detecting = detect(ctx, deps, docker);
  const secrets = await readSecrets(ctx, flags, o.stdin);
  const envBase = modelEnv(ctx, deps, flags, l.values, {
    docker,
    portStart: await portStart(deps),
    tray: await trayState(ctx, deps, docker),
  });
  // Flags next to a terminal are the questions' defaults; a rule they break is a notice on the first card, not an exit.
  const pre = answersFromFlags(
    flags,
    { ...envBase, host: null, lookups: {} },
    { secrets, locale: ctx.locale, lenient: true, advanced: !!flags.advanced, env: ctx.env },
  );
  const base: ResolveBase = {
    file: l.values,
    host: null,
    locale: ctx.locale,
    langFlag: !!flags.lang,
    docker,
    compiled: ctx.compiled,
  };
  const state = new SetupState({
    env: envBase,
    host: null,
    base,
    locale: ctx.locale,
    deps,
    preset: pre.answers,
    presetErrors: pre.errors,
    acceptDefaults: ctx.yes,
    rerun: l.previous !== null,
  });
  const host = detecting.then((h) => {
    state.setHost(h);
    return h;
  });
  host.catch(() => {});

  const memo: SecretMemo = { made: {} };
  // Across re-applies: an earlier attempt's telinha.env stays on disk whatever the last one did.
  const tasks = new TaskList();
  let applied: Values | null = null;
  const apply = async (a: { rotateCookie: boolean }, hooks: ApplyHooks): Promise<ApplyResult> => {
    const h = await host;
    const values = state.values();
    const chosen = state.applyOptions();
    const opts = applyOptions(ctx, flags, docker, {
      sysctl: chosen.sysctl ?? 'auto',
      rotateCookie: a.rotateCookie,
      doctorMode: 'data',
      secrets: memo,
      tray: chosen.tray,
    });
    applied = values;
    const w = makeWizard(ctx, deps, state.locale, h, { docker, out: silentOut() });
    return runApply(w, l, values, planTasks(values, opts), opts, hooks, tasks);
  };
  const doctor =
    docker || flags['no-doctor']
      ? null
      : {
          buildContext: async () =>
            (await import('./doctor.ts')).buildCheckContext(
              { ...ctx, locale: state.locale },
              { local: false, control: deps.control },
            ),
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
    result = await ui.run({
      ctx,
      version: ctx.version,
      docker,
      state,
      tasks,
      apply,
      offer: o.offer,
      doctor,
      shownFile: l.shown,
    });
  } finally {
    state.dispose();
  }

  // The screens are gone: what stays in the terminal is plain.
  const locale = state.locale;
  const out = deps.term(locale);
  if (result.kind === 'declined') return null;
  // The last attempt did not get to the file, an earlier one did: say so instead of "nothing was written".
  const notWritten = () =>
    tasks.wroteAny ? out.warn(t(locale, 'wroteEarlier', { file: l.shown })) : ctx.stderr(t(locale, 'aborted'));
  if (result.kind === 'quit' || result.result.kind === 'back') {
    if (tasks.wroteAny) summary(out, locale, tasks.summary());
    if (!tasks.wrote) notWritten();
    return result.kind === 'quit' && result.reason === 'ctrl-c' ? 130 : 1;
  }
  const r = result.result;
  summary(out, locale, tasks.summary());
  if (r.kind === 'aborted') {
    if (!r.wrote) notWritten();
    return 1;
  }
  nextSteps(makeWizard(ctx, deps, locale, await host, { docker, out }), r.values, { file: l.shown });
  return r.code;
}

async function setup(
  ctx: CliContext,
  deps: Partial<SetupDeps>,
  o: { stdin?: () => Promise<string>; offer: { envFile: string } | null },
): Promise<number | null> {
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

export async function run(
  _args: ParsedArgs,
  ctx: CliContext,
  deps: Partial<SetupDeps> = {},
  o: { stdin?: () => Promise<string> } = {},
): Promise<number> {
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
