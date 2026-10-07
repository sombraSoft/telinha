// What setup does once the answers are in: secrets, writing telinha.env,
// binaries, the service (one elevation on Windows, one sudo step for low
// ports as a Linux user), the router probe, start and doctor. apply.ts runs
// them as tasks. Every side effect goes through SetupDeps so tests run them
// against fakes; every line goes through Wizard.out.
import { randomBytes } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { type Config, loadConfig } from '../../config.ts';
import type { Ddns } from '../../ddns.ts';
import { firewallCommands } from '../../doctor/checks.ts';
import type { CheckResult } from '../../doctor/types.ts';
import { parseEnvFile } from '../../envfile.ts';
import { helpersOf } from '../../footprint.ts';
import type { NatProbe } from '../../nat/index.ts';
import { isCgnatIpv4, isPrivateIpv4 } from '../../netinfo.ts';
import type { Paths } from '../../paths.ts';
import { exeName } from '../../release.ts';
import {
  type InstallResult,
  must,
  ServiceInstallError,
  type ServiceManager,
  type SpawnFn,
} from '../../service/index.ts';
import { SERVICE_USER, SYSCTL_SCRIPT } from '../../service/systemd.ts';
import type { TrayLauncher } from '../../service/tray.ts';
import { parseWhoami, whoamiExe } from '../../service/windows.ts';
import type { ProcessInfo } from '../../supervisor.ts';
import type { CliContext } from '../args.ts';
import type { ControlClient } from '../control.ts';
import type { Locale, Params } from '../strings.ts';
import type { Out, Spinner, Term } from '../term.ts';
import { at } from './apply-strings.ts';
import type { DiscordSetup } from './discord.ts';
import { type EnvFs, lockWindowsHome, type PreviousEnv, renderEnvFile, writeEnvFile } from './envwrite.ts';
import { type HostInfo, type Hosting, routerLabel } from './host.ts';
import type { SKey } from './strings.ts';
import type { SetupUi } from './ui.ts';

/** Setup's answers by telinha.env key; '' = not set (the key is dropped or stays commented). */
export type Values = Record<string, string>;

/** Ends setup with a message and an exit code. */
export class SetupAbort extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'SetupAbort';
  }
}

export interface SetupFs extends EnvFs {
  /** null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  copyFile(from: string, to: string): Promise<void>;
}

export interface SetupDeps {
  term: (locale: Locale) => Term;
  fetch: typeof fetch;
  nat: { probe(): Promise<NatProbe> };
  ddns: (o: { domain: string; token: string }) => Ddns;
  discord: (token: string) => DiscordSetup;
  /** Linux: user = a user unit. null on hosts without a service manager. */
  serviceManager: (o: { user: boolean }) => ServiceManager | null;
  /** phoneTestLink/doctorWait: the phone test on the doctor screen after the install. */
  control: Pick<ControlClient, 'available' | 'shutdown' | 'status' | 'phoneTestLink' | 'doctorWait'>;
  /** progress: bytes per tool while downloading (the setup screens draw a bar). */
  bins: (
    config: Pick<Config, 'media' | 'ingress'>,
    paths: Pick<Paths, 'bin'>,
    log: (msg: string) => void,
    progress?: (tool: string, received: number, total: number | null) => void,
  ) => Promise<unknown>;
  /** Captured output, no terminal. */
  spawn: SpawnFn;
  /** Inherits the terminal (sudo asks for a password); resolves with the exit code. */
  spawnInteractive: (cmd: string[]) => Promise<number>;
  openUrl: (url: string) => Promise<void>;
  fs: SetupFs;
  platform: NodeJS.Platform;
  arch: string;
  isRoot: boolean;
  osName: () => string;
  existsSync: (path: string) => boolean;
  lookupPublicIp: () => Promise<string>;
  resolveA: (host: string) => Promise<string[]>;
  /** Something already accepts TCP on 127.0.0.1:<port>. */
  portInUse: (port: number) => Promise<boolean>;
  /** A UDP socket can bind <port>. */
  udpFree: (port: number) => Promise<boolean>;
  random: (n: number) => Uint8Array;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** `telinha doctor` with the given context (its argv carries the doctor flags). */
  doctor: (ctx: CliContext) => Promise<number>;
  /** The doctor checks as data, for the setup screens; onResult after each one. */
  doctorChecks: (
    ctx: CliContext,
    onResult?: (r: CheckResult, done: number, total: number) => void,
  ) => Promise<CheckResult[]>;
  /** The running executable (the native binary, or bun in dev). */
  execPath: string;
  /** Bun.which: a command on this process's PATH, or null. */
  which: (cmd: string) => string | null;
  /** The local listener (127.0.0.1:port) serves a valid certificate for host. */
  certReady: (host: string, port: number) => Promise<boolean>;
  /** The setup screens; without them a terminal gets the plain run. */
  ui?: SetupUi;
  /** Windows: starts the tray icon (detached, with the given environment). */
  tray?: TrayLauncher;
  /** Windows: is the pid tray.json names still the tray. Default: tasklist. */
  processInfo?: ProcessInfo;
}

export interface Wizard {
  ctx: CliContext;
  deps: SetupDeps;
  /** A terminal on the plain run; the task rows' capture under the setup screens. */
  out: Out;
  locale: Locale;
  s: (key: SKey, params?: Params) => string;
  host: HostInfo;
  docker: boolean;
}

/** Runs fn with the real terminal (the setup screens step aside); intro: what to read there first. */
export type WithTerminal = <T>(fn: () => Promise<T>, intro?: string[]) => Promise<T>;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);
const lines = (out: Out, text: string, kind: 'info' | 'warn' = 'info') => {
  for (const l of text.split('\n')) out[kind](l);
};

/**
 * How to type the program in the user's terminal: `telinha` when that resolves
 * on PATH, else the full path (PowerShell's call operator on Windows). Root on
 * Linux gets its own root-owned copy, never the service's bin/telinha.
 */
export function cliName(w: Wizard): string {
  if (!w.ctx.compiled) return 'bun server/src/index.ts';
  if (w.deps.which('telinha')) return 'telinha';
  const { platform } = w.deps;
  const exe =
    platform === 'linux' && w.deps.isRoot
      ? w.deps.execPath
      : pathFor(platform).join(w.ctx.paths.bin, exeName(platform));
  if (platform === 'win32') return `& "${exe}"`;
  return /\s/.test(exe) ? `"${exe}"` : exe;
}

/** Where the service's log is, as a command to read it. */
export function logCommand(w: Wizard): string {
  if (w.deps.platform === 'win32') return `Get-Content "${w.ctx.paths.logFile}" -Tail 50`;
  return w.deps.isRoot ? 'journalctl -u telinha -e' : 'journalctl --user -u telinha -e';
}

// --- secrets

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Generates what is missing (and the cookie secret when rotating); returns the keys it made. */
export function generateSecrets(
  values: Values,
  random: (n: number) => Uint8Array = (n) => randomBytes(n),
  rotateCookie = false,
): string[] {
  const made: string[] = [];
  if (!values.COOKIE_SECRET || rotateCookie) {
    values.COOKIE_SECRET = b64(random(48));
    made.push('COOKIE_SECRET');
  }
  // LiveKit Cloud's pair is the project's: nothing to make up.
  if (values.MEDIA !== 'cloud') {
    if (!values.LIVEKIT_API_KEY) {
      values.LIVEKIT_API_KEY = `telinha${hex(random(4))}`;
      made.push('LIVEKIT_API_KEY');
    }
    // LiveKit refuses secrets shorter than 32 characters.
    if (!values.LIVEKIT_API_SECRET || values.LIVEKIT_API_SECRET.length < 32) {
      values.LIVEKIT_API_SECRET = b64url(random(32));
      made.push('LIVEKIT_API_SECRET');
    }
  }
  return made;
}

// --- write

/** The file text, and the config loadConfig makes of it (the same check `run` does at start). */
export function validateValues(
  values: Values,
  previous: PreviousEnv | null,
  home: string,
  o: { compiled?: boolean } = {},
): { text: string; config: Config } {
  const text = renderEnvFile(values, previous);
  const config = loadConfig({ ...parseEnvFile(text).vars, TELINHA_HOME: home }, { compiled: o.compiled });
  return { text, config };
}

/** The Windows account that keeps access to the file and runs the task. */
export async function windowsAccount(w: Wizard): Promise<{ user: string; sid: string } | null> {
  const r = await w.deps.spawn([whoamiExe(w.ctx.env), '/user', '/fo', 'csv']).catch(() => null);
  return r && r.code === 0 ? parseWhoami(r.stdout) : null;
}

/** `shown`: the path as the user finds it (the host's, when setup runs in the image). */
export async function writeConfig(w: Wizard, file: string, text: string, shown = file): Promise<void> {
  const env = w.ctx.env;
  const account = w.deps.platform === 'win32' ? await windowsAccount(w) : null;
  const user = account?.user ?? `${env.USERDOMAIN ?? ''}\\${env.USERNAME ?? ''}`;
  if (w.deps.platform === 'win32') {
    // The whole home (control token, task XML, bin\), before the secrets land in it.
    await w.deps.fs.mkdir(w.ctx.paths.home);
    await lockWindowsHome({
      home: w.ctx.paths.home,
      user,
      spawn: w.deps.spawn,
      warn: (m) => w.out.warn(w.s('aclFailed', { error: m })),
    });
  }
  await writeEnvFile({
    file,
    text,
    fs: w.deps.fs,
    platform: w.deps.platform,
    isRoot: w.deps.isRoot,
    home: w.ctx.paths.home,
    docker: w.docker,
    spawn: w.deps.spawn,
    user,
  });
  w.out.ok(w.s('written', { file: shown }));
}

// --- binaries

const HELPER_NAMES = { livekit: 'LiveKit', caddy: 'Caddy', cloudflared: 'cloudflared' } as const;
/** The programs this config runs, by name ("LiveKit, Caddy"). */
const helperNames = (config: Pick<Config, 'media' | 'ingress'>) =>
  helpersOf(config)
    .map((t) => HELPER_NAMES[t])
    .join(', ');

export async function downloadBinaries(w: Wizard, config: Pick<Config, 'media' | 'ingress'>): Promise<boolean> {
  const { out, s } = w;
  if (!helpersOf(config).length) return true; // LiveKit Cloud behind an external proxy runs no child
  // A root install's bin/ belongs to the service user: root writing there could
  // be steered onto any file through a planted symlink. The service fetches
  // them itself at start, as that user.
  if (w.deps.platform === 'linux' && w.deps.isRoot && !w.docker) {
    const bin = await w.deps.fs.stat(w.ctx.paths.bin);
    if (bin && bin.uid !== 0) {
      out.info(s('binsByService', { tools: helperNames(config) }));
      return true;
    }
  }
  const spin = out.spinner(s('binsChecking', { tools: helperNames(config) }));
  try {
    await w.deps.bins(
      config,
      w.ctx.paths,
      (m) => spin.update(m.replace(/^\[bins\]\s*/, '')),
      (tool, received, total) => out.progress?.(received, total, tool),
    );
    spin.stop(s('binsOk', { dir: w.ctx.paths.bin }));
    return true;
  } catch (e) {
    spin.fail(s('binsFailed', { error: errMsg(e) }));
    return false;
  }
}

// --- service

export { SYSCTL_SCRIPT };
export const UNPRIVILEGED_PORT_START = '/proc/sys/net/ipv4/ip_unprivileged_port_start';
export const installResultPath = (home: string): string => win32.join(home, 'service', 'install-result.json');

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** Start-Process joins -ArgumentList with spaces and quotes nothing: arguments with spaces carry their own quotes. */
const winArg = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"` : a);

/** The one-liner that runs `exe args` elevated (UAC), waits and exits with its code. */
export function elevationCommand(exe: string, args: string[]): string {
  return `$p = Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${args.map((a) => psQuote(winArg(a))).join(',')} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
}

/**
 * The same for a person to paste into PowerShell (the default Windows 10/11
 * terminal): it asks for elevation itself, so no administrator terminal is
 * needed, and a quoted path at the start of a line (a string expression to
 * PowerShell) is avoided.
 */
export function elevationHint(exe: string, args: string[]): string {
  return `Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${psQuote(args.map(winArg).join(' '))} -Verb RunAs`;
}

/** Adds dir to the user's PATH (the raw REG_EXPAND_SZ value, entries kept unexpanded); true when it was missing. */
export async function addToUserPath(spawn: SpawnFn, dir: string): Promise<boolean> {
  const script = [
    `$d = ${psQuote(dir)}`,
    "$p = [string](Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
    "if (@($p -split ';' | Where-Object { $_.TrimEnd('\\') -ieq $d.TrimEnd('\\') }).Count -eq 0) {",
    "  $n = if ($p) { $p.TrimEnd(';') + ';' + $d } else { $d }",
    "  Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name Path -Value $n -Type ExpandString",
    // Setting a user variable through .NET broadcasts WM_SETTINGCHANGE: Explorer's new terminals see the PATH.
    "  [Environment]::SetEnvironmentVariable('TELINHA_INSTALL_REFRESH', '1', 'User')",
    "  [Environment]::SetEnvironmentVariable('TELINHA_INSTALL_REFRESH', $null, 'User')",
    "  'added'",
    '}',
  ].join('\n');
  const r = await spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', script]).catch(() => null);
  return !!r && r.code === 0 && r.stdout.trim() === 'added';
}

function printInstall(w: Wizard, r: InstallResult): void {
  const names = { task: 'stepTask', firewall: 'stepFirewall', start: 'stepStart' } as const;
  for (const [key, outcome] of Object.entries(r.steps) as [keyof InstallResult['steps'], string][]) {
    const step = w.s(names[key]);
    if (outcome === 'ok') w.out.ok(step);
    else if (outcome === 'skipped') w.out.info(w.s('stepSkipped', { step }));
    else w.out.fail(`${step}: ${outcome.replace(/^failed: /, '')}`);
  }
  if (r.error) w.out.fail(r.error);
  for (const h of r.hints ?? []) {
    w.out.warn(w.s('stepHint', { cmd: h }));
    if (h.includes('enable-linger')) w.out.info(w.s('lingerWhy'));
  }
}

/** The native binary in <home>/bin, copied there when setup runs from elsewhere (a downloaded exe). */
async function installedExe(w: Wizard): Promise<string> {
  const { platform, fs, execPath } = w.deps;
  const p = pathFor(platform);
  const target = p.join(w.ctx.paths.bin, exeName(platform));
  const same = platform === 'win32' ? execPath.toLowerCase() === target.toLowerCase() : execPath === target;
  if (!same && !(await fs.exists(target))) {
    const bin = await fs.stat(w.ctx.paths.bin);
    if (platform === 'linux' && w.deps.isRoot && bin && bin.uid !== 0) {
      // bin/ is the service user's (it updates itself there): the copy runs as
      // that user, never as root inside a directory someone else controls.
      const cmd = ['runuser', '-u', SERVICE_USER, '--', 'install', '-m', '755', execPath, target];
      must(cmd, await w.deps.spawn(cmd));
    } else {
      await fs.mkdir(w.ctx.paths.bin);
      await fs.copyFile(execPath, target);
      if (platform !== 'win32') await fs.chmod(target, 0o755);
    }
    w.out.ok(w.s('exeCopied', { path: target }));
  }
  // The hints from here on say `telinha ...`; a double-clicked exe has no PATH entry yet.
  if (platform === 'win32' && (await addToUserPath(w.deps.spawn, w.ctx.paths.bin)))
    w.out.ok(w.s('pathAdded', { dir: w.ctx.paths.bin }));
  return target;
}

async function windowsInstall(w: Wizard, exe: string, firewall: boolean): Promise<boolean> {
  const { out, s, deps } = w;
  const home = w.ctx.paths.home;
  const account = await windowsAccount(w);
  const manual = (who: { user: string; sid: string } | null) =>
    elevationHint(exe, [
      'service',
      'install',
      ...(firewall ? ['--firewall'] : []),
      '--home',
      home,
      '--lang',
      w.locale,
      ...(who ? ['--user', who.user, '--sid', who.sid] : []),
    ]);
  if (!account) {
    out.warn(s('whoamiFailed'));
    out.info(s('serviceManual', { cmd: manual(null) }));
    return false;
  }
  const result = installResultPath(home);
  await deps.fs.mkdir(win32.dirname(result));
  await deps.fs.rm(result).catch(() => {});
  const args = [
    'service',
    'install',
    ...(firewall ? ['--firewall'] : []),
    '--home',
    home,
    '--lang',
    w.locale,
    '--user',
    account.user,
    '--sid',
    account.sid,
    '--result',
    result,
  ];
  lines(out, s('uacExplain'));
  // The elevated child runs behind UAC's secure desktop and never reads this
  // terminal: the setup screens stay up and say what they wait for.
  out.detail?.(at(w.locale, 'uacWaiting'));
  const r = await deps.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', elevationCommand(exe, args)]);
  const text = await deps.fs.readText(result).catch(() => null);
  if (!text) {
    // Declined UAC: Start-Process throws (exit 1) or reports ERROR_CANCELLED (1223).
    out.warn(r.code === 1223 || r.code === 1 ? s('uacDeclined') : s('uacNoResult', { code: r.code }));
    out.info(s('serviceManual', { cmd: manual(account) }));
    return false;
  }
  let parsed: InstallResult;
  try {
    parsed = JSON.parse(text) as InstallResult;
  } catch {
    out.warn(s('uacNoResult', { code: r.code }));
    out.info(s('serviceManual', { cmd: manual(account) }));
    return false;
  }
  printInstall(w, parsed);
  return parsed.steps?.task === 'ok';
}

async function linuxInstall(w: Wizard, exe: string): Promise<boolean> {
  const { out, s, deps } = w;
  const manager = deps.serviceManager({ user: !deps.isRoot });
  if (!manager) {
    out.warn(s('serviceUnsupported'));
    return false;
  }
  const spin = out.spinner(s('serviceInstalling', { kind: manager.kind }));
  try {
    const r = await manager.install({ firewall: false, exe, home: w.ctx.paths.home, locale: w.locale });
    spin.stop(s('serviceInstalled', { kind: manager.kind }));
    printInstall(w, r);
    return true;
  } catch (e) {
    spin.fail(s('serviceFailed', { error: errMsg(e) }));
    if (e instanceof ServiceInstallError) {
      printInstall(w, e.result);
      return e.result.steps.task === 'ok';
    }
    return false;
  }
}

/**
 * Linux user install, direct mode, a port below 1024 (a VPS, or a home that
 * opened 80/443 itself): the unprivileged-port sysctl, one sudo step that
 * survives every binary update. sudo asks for the password on the real
 * terminal (the setup screens step aside); auto is sudo -n (nobody to ask);
 * manual, or a refusal, prints the command for later.
 */
export async function unprivilegedPorts(
  w: Wizard,
  values: Values,
  o: { mode: 'sudo' | 'manual' | 'auto'; withTerminal?: WithTerminal },
): Promise<void> {
  const { out, s, deps } = w;
  if ((values.INGRESS || 'direct') !== 'direct') return;
  const low = [Number(values.HTTP_PORT || 80), Number(values.HTTPS_PORT || 443)].filter((p) => p > 0 && p < 1024);
  if (!low.length) return;
  const start = Number((await deps.fs.readText(UNPRIVILEGED_PORT_START).catch(() => null))?.trim() ?? NaN);
  if (Number.isInteger(start) && start <= Math.min(...low)) return;
  const explain = s('sysctlExplain', { ports: low.join(', ') });
  lines(out, explain);
  let ok = false;
  if (o.mode === 'sudo') {
    const sudo = () => deps.spawnInteractive(['sudo', 'sh', '-c', SYSCTL_SCRIPT]).catch(() => 1);
    ok = (await (o.withTerminal ? o.withTerminal(sudo, explain.split('\n')) : sudo())) === 0;
  } else if (o.mode === 'auto') {
    ok = (await deps.spawn(['sudo', '-n', 'sh', '-c', SYSCTL_SCRIPT]).catch(() => ({ code: 1 }))).code === 0;
  }
  if (ok) {
    out.ok(s('sysctlOk'));
    return;
  }
  out.warn(s('sysctlFailed'));
  out.info(s('sysctlManual', { cmd: `sudo sh -c '${SYSCTL_SCRIPT}'` }));
}

/** Installs and starts the service (and the Windows firewall rules); true when it is registered. */
export async function serviceStep(
  w: Wizard,
  values: Values,
  o: { firewall: boolean; sysctl: 'sudo' | 'manual' | 'auto'; withTerminal?: WithTerminal },
): Promise<boolean> {
  const { out, s, deps } = w;
  if (!w.ctx.compiled) {
    out.info(s('serviceNeedsBinary'));
    return false;
  }
  if (deps.platform === 'linux' && !deps.isRoot)
    await unprivilegedPorts(w, values, { mode: o.sysctl, withTerminal: o.withTerminal });
  let exe: string;
  try {
    exe = await installedExe(w);
  } catch (e) {
    out.fail(s('serviceFailed', { error: errMsg(e) }));
    return false;
  }
  if (deps.platform === 'win32') return windowsInstall(w, exe, o.firewall);
  if (deps.platform === 'linux') return linuxInstall(w, exe);
  out.warn(s('serviceUnsupported'));
  return false;
}

// --- router

/** The port in PUBLIC_URL, as a string; 443 when it carries none (or is unreadable). */
function publicUrlPort(url: string | undefined): string {
  try {
    return new URL(url ?? '').port || '443';
  } catch {
    return '443';
  }
}

/**
 * The ports the internet must reach, as the router sees them (public port ->
 * this machine's when they differ), and whether the UPnP mapper asks for each:
 * the rule of upnpMappings, so never for a public 80 or 443.
 */
function routerEntries(values: Values): { port: string; mapper: boolean }[] {
  // LiveKit Cloud carries the media: nothing of it reaches this machine.
  const out: { port: string; mapper: boolean }[] =
    values.MEDIA === 'cloud'
      ? []
      : [
          { port: `TCP ${values.MEDIA_TCP_PORT || '7881'}`, mapper: true },
          { port: `UDP ${values.MEDIA_UDP_PORT || '7882'}`, mapper: true },
        ];
  if ((values.INGRESS || 'direct') === 'direct') {
    const https = values.HTTPS_PORT || '443';
    const pub = publicUrlPort(values.PUBLIC_URL);
    out.push({ port: pub === https ? `TCP ${pub}` : `TCP ${pub} -> ${https}`, mapper: pub !== '443' && pub !== '80' });
    if ((values.HTTP_PORT || '80') !== '0') out.push({ port: `TCP ${values.HTTP_PORT || '80'}`, mapper: false });
  }
  return out;
}

/** The ports the internet must reach, as the router sees them (public port -> this machine's when they differ). */
export function publicPorts(values: Values): string[] {
  return routerEntries(values).map((e) => e.port);
}

/** What this host listens on, for its own firewall (ufw/firewalld take the internal ports). */
export function hostPorts(values: Values): string[] {
  const out: string[] =
    values.MEDIA === 'cloud'
      ? []
      : [`${values.MEDIA_TCP_PORT || '7881'}/tcp`, `${values.MEDIA_UDP_PORT || '7882'}/udp`];
  if ((values.INGRESS || 'direct') === 'direct') {
    out.push(`${values.HTTPS_PORT || '443'}/tcp`);
    if ((values.HTTP_PORT || '80') !== '0') out.push(`${values.HTTP_PORT || '80'}/tcp`);
  }
  return out;
}

export async function routerStep(w: Wizard, values: Values, hosting: Hosting = 'home'): Promise<void> {
  const { out, s } = w;
  if (!routerEntries(values).length) return; // LiveKit Cloud behind a tunnel or a proxy: nothing to open
  const ports = publicPorts(values).join(', ');
  if (values.MEDIA === 'cloud') out.info(s('routerNoMedia'));
  // A VPS has no router: its provider's firewall and its own are what block.
  if (hosting === 'vps') {
    out.info(s('routerVps', { ports }));
    if (w.deps.platform === 'linux') {
      const cmds = firewallCommands(hostPorts(values), (c) => w.deps.which(c));
      if (cmds.ufw) out.info(s('routerVpsUfw', { cmd: cmds.ufw }));
      if (cmds.firewalld) out.info(s('routerVpsFirewalld', { cmd: cmds.firewalld }));
    }
    return;
  }
  const nat = w.host.nat ?? (await w.deps.nat.probe().catch(() => null));
  if (!nat?.gateway) {
    out.warn(s('routerNone'));
    out.info(s('forwardByHand', { ports }));
    return;
  }
  out.ok(s('routerFound', { router: routerLabel(nat) ?? '?', ip: nat.externalIp ?? '?' }));
  const ext = nat.externalIp;
  // LiveKit Cloud takes the media ports off the router; the HTTPS port still needs it.
  if (ext && isCgnatIpv4(ext)) lines(out, s(values.MEDIA === 'cloud' ? 'cgnatCloud' : 'cgnat'), 'warn');
  else if (ext && isPrivateIpv4(ext)) lines(out, s('doubleNat'), 'warn');
  if (values.UPNP === 'off') {
    out.info(s('forwardByHand', { ports }));
    return;
  }
  // The mapper never asks for 80/443 (the advanced path forwards them by hand): name only what it owns.
  const entries = routerEntries(values);
  if (entries.some((e) => e.mapper))
    out.info(
      s('upnpWillMap', {
        ports: entries
          .filter((e) => e.mapper)
          .map((e) => e.port)
          .join(', '),
      }),
    );
  const byHand = entries.filter((e) => !e.mapper).map((e) => e.port);
  if (byHand.length) out.info(s('forwardByHand', { ports: byHand.join(', ') }));
}

// --- start, certificate, doctor, next steps

/** The service did not come up: its log says why (caddy cannot bind 80, a bad tunnel token...). */
function notAnswering(w: Wizard, spin: { fail(label?: string): void }): void {
  const [first, ...rest] = w.s('notAnswering', { log: logCommand(w), telinha: cliName(w) }).split('\n');
  spin.fail(first);
  for (const l of rest) w.out.info(l);
}

async function waitForService(w: Wizard, timeoutMs: number): Promise<boolean> {
  const end = w.deps.now() + timeoutMs;
  while (w.deps.now() < end) {
    if (await w.deps.control.available().catch(() => false)) return true;
    await w.deps.sleep(1000);
  }
  return false;
}

/** How long setup waits for the service to answer after an install or a restart. */
export const START_WAIT_MS = 60_000;
/** How long setup waits for Caddy's first certificate before doctor runs. */
export const CERT_WAIT_MS = 90_000;
/** Through the DuckDNS API: the TXT record must propagate first (up to two minutes), then issuance. */
export const CERT_WAIT_DNS_MS = 240_000;

/** Running; a console run to restart by hand; nothing installed to start; or no answer in time. */
export type StartOutcome = 'running' | 'console' | 'byHand' | 'notAnswering';

/** A service that was already running restarts to read the new file; a fresh one was started by its install. */
export async function startService(w: Wizard, o: { installed: boolean; wasRunning: boolean }): Promise<StartOutcome> {
  const { out, s, deps } = w;
  let spin: Spinner;
  if (o.wasRunning) {
    const supervised = await deps.control.status().then(
      (st) => st.supervised,
      () => true,
    );
    if (!supervised) {
      out.warn(s('consoleRestart'));
      return 'console';
    }
    try {
      await deps.control.shutdown('restart');
    } catch (e) {
      out.warn(errMsg(e));
    }
    // The old process answers a little longer; give it time to go.
    await deps.sleep(3000);
    spin = out.spinner(s('restarting'));
  } else if (o.installed) {
    spin = out.spinner(s('waitingStart'));
  } else {
    out.info(s('startByHand', { cmd: `${cliName(w)} run` }));
    return 'byHand';
  }
  if (await waitForService(w, START_WAIT_MS)) {
    spin.stop(s('running'));
    return 'running';
  }
  notAnswering(w, spin);
  return 'notAnswering';
}

/**
 * Direct mode: Caddy gets its certificate after the start, which takes from
 * seconds to minutes. Doctor before that flags a correct install as broken;
 * wait for the local listener to serve a valid one (asked by name on
 * 127.0.0.1, so a router without hairpin NAT does not matter). True once it
 * is there; progress hears the time waited against the limit.
 */
export async function waitForCertificate(
  w: Wizard,
  values: Values,
  progress?: (waitedMs: number, limitMs: number) => void,
): Promise<boolean> {
  const { out, s, deps } = w;
  let host: string;
  try {
    host = new URL(values.PUBLIC_URL ?? '').hostname;
  } catch {
    return false;
  }
  const port = Number(values.HTTPS_PORT || 443);
  const dns = values.ACME_DNS === 'duckdns';
  const spin = out.spinner(s(dns ? 'certWaitingDns' : 'certWaiting'));
  const limit = dns ? CERT_WAIT_DNS_MS : CERT_WAIT_MS;
  const begin = deps.now();
  for (;;) {
    if (await deps.certReady(host, port).catch(() => false)) {
      spin.stop(s('certOk'));
      return true;
    }
    const waited = deps.now() - begin;
    if (waited >= limit) break;
    progress?.(waited, limit);
    await deps.sleep(3000);
  }
  spin.fail(s('certPending', { telinha: cliName(w) }));
  return false;
}

/**
 * The doctor command after the install, plain and without the phone test:
 * tty false keeps its full-screen checklist out of the middle of setup's
 * lines. True when nothing failed.
 */
export async function doctorCli(w: Wizard): Promise<boolean> {
  try {
    const code = await w.deps.doctor({ ...w.ctx, tty: false, argv: ['doctor', '--no-phone'], locale: w.locale });
    if (code === 0) return true;
    w.out.warn(w.s('doctorProblems', { telinha: cliName(w) }));
  } catch (e) {
    w.out.warn(w.s('doctorFailed', { error: errMsg(e) }));
  }
  return false;
}

export function nextSteps(w: Wizard, values: Values, o: { file: string }): void {
  const { out, s } = w;
  out.step(s('nextTitle'));
  if (w.docker) {
    lines(out, s('nextDocker'));
    return;
  }
  lines(
    out,
    s('nextNative', {
      url: values.PUBLIC_URL ?? '',
      command: values.COMMAND_NAME || 'telinha',
      file: o.file,
      telinha: cliName(w),
    }),
  );
}
