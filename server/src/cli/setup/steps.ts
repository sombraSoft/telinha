// The wizard's steps after the questions: secrets, review, writing
// telinha.env, binaries, the service (one elevation on Windows, one sudo step
// for low ports as a Linux user), the router probe, start and doctor. Every
// side effect goes through SetupDeps so tests run them against fakes.
import { randomBytes } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { loadConfig, type Config } from '../../config.ts';
import type { Ddns } from '../../ddns.ts';
import { parseEnvFile } from '../../envfile.ts';
import type { NatProbe } from '../../nat/index.ts';
import { isCgnatIpv4, isPrivateIpv4 } from '../../netinfo.ts';
import type { Paths } from '../../paths.ts';
import { firewallCommands } from '../../doctor/checks.ts';
import { must, ServiceInstallError, type InstallResult, type ServiceManager, type SpawnFn } from '../../service/index.ts';
import { SERVICE_USER, SYSCTL_SCRIPT } from '../../service/systemd.ts';
import { parseWhoami, whoamiExe } from '../../service/windows.ts';
import { exeName } from '../../update/swap.ts';
import type { CliContext } from '../args.ts';
import type { ControlClient } from '../control.ts';
import type { Locale, Params } from '../strings.ts';
import type { Term } from '../term.ts';
import type { DiscordSetup } from './discord.ts';
import type { Target } from './domain.ts';
import { lockWindowsHome, renderEnvFile, SECRET_KEYS, writeEnvFile, type EnvFs, type PreviousEnv } from './envwrite.ts';
import { routerLabel, type HostInfo } from './host.ts';
import type { SKey } from './strings.ts';

/** The wizard's answers by telinha.env key; '' = not set (the key is dropped or stays commented). */
export type Values = Record<string, string>;

/** Ends the wizard with a message and an exit code (declined review, Discord unreachable...). */
export class SetupAbort extends Error {
  constructor(message: string, readonly code: number) {
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
  control: Pick<ControlClient, 'available' | 'shutdown' | 'status'>;
  bins: (config: Pick<Config, 'media' | 'ingress'>, paths: Pick<Paths, 'bin'>, log: (msg: string) => void) => Promise<unknown>;
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
  /** The running executable (the native binary, or bun in dev). */
  execPath: string;
  /** Bun.which: a command on this process's PATH, or null. */
  which: (cmd: string) => string | null;
  /** The local listener (127.0.0.1:port) serves a valid certificate for host. */
  certReady: (host: string, port: number) => Promise<boolean>;
}

export interface Wizard {
  ctx: CliContext;
  deps: SetupDeps;
  term: Term;
  locale: Locale;
  s: (key: SKey, params?: Params) => string;
  /** "(keep current)" in the wizard's language. */
  keepCurrent: string;
  host: HostInfo;
  interactive: boolean;
  docker: boolean;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);
const lines = (term: Term, text: string, kind: 'info' | 'warn' = 'info') => {
  for (const l of text.split('\n')) term[kind](l);
};

/** A masked prompt; with a current value, first "keep it or type a new one" (Enter keeps). */
export async function askSecret(w: Wizard, o: { id: string; question: string; current?: string; validate?: (v: string) => string | null }): Promise<string> {
  if (o.current) {
    const keep = await w.term.select(o.question, [
      { value: true, label: w.keepCurrent },
      { value: false, label: w.s('secretNew') },
    ], 0, { id: o.id });
    if (keep) return o.current;
  }
  return w.term.secret(o.question, { id: o.id, validate: o.validate });
}

/**
 * "Press Enter when done": a line read for real even with --yes (no default:
 * there is nothing to accept, and answering it at once would loop the step).
 */
export async function pause(w: Wizard, q: string, id: string): Promise<void> {
  await w.term.text(q, { id });
}

/**
 * How to type the program in the user's terminal: `telinha` when that resolves
 * on PATH, else the full path (PowerShell's call operator on Windows). Root on
 * Linux gets its own root-owned copy, never the service's bin/telinha.
 */
export function cliName(w: Wizard): string {
  if (!w.ctx.compiled) return 'bun server/src/index.ts';
  if (w.deps.which('telinha')) return 'telinha';
  const { platform } = w.deps;
  const exe = platform === 'linux' && w.deps.isRoot ? w.deps.execPath : pathFor(platform).join(w.ctx.paths.bin, exeName(platform));
  if (platform === 'win32') return `& "${exe}"`;
  return /\s/.test(exe) ? `"${exe}"` : exe;
}

/** Where the service's log is, as a command to read it. */
export function logCommand(w: Wizard): string {
  if (w.deps.platform === 'win32') return `Get-Content "${w.ctx.paths.logFile}" -Tail 50`;
  return w.deps.isRoot ? 'journalctl -u telinha -e' : 'journalctl --user -u telinha -e';
}

// --- media ports

const portOk = (v: string) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

export async function askMediaPorts(w: Wizard, values: Values): Promise<void> {
  const { term, s } = w;
  term.step(s('mediaTitle'));
  let tcp = values.MEDIA_TCP_PORT || '7881';
  let udp = values.MEDIA_UDP_PORT || '7882';
  lines(term, s('mediaHelp', { tcp, udp }));
  if (await term.confirm(s('mediaChangeQ'), false, { id: 'media' })) {
    tcp = await term.text(s('mediaTcpQ'), { default: tcp, id: 'media-tcp', validate: (v) => (portOk(v) ? null : s('portBad')) });
    udp = await term.text(s('mediaUdpQ'), { default: udp, id: 'media-udp', validate: (v) => (portOk(v) ? null : s('portBad')) });
  }
  // Defaults stay commented in the file.
  values.MEDIA_TCP_PORT = tcp === '7881' ? '' : tcp;
  values.MEDIA_UDP_PORT = udp === '7882' ? '' : udp;
  if (w.docker) return;
  if (await w.deps.portInUse(Number(tcp))) term.warn(s('mediaBusy', { proto: 'TCP', port: tcp }));
  if (!(await w.deps.udpFree(Number(udp)))) term.warn(s('mediaBusy', { proto: 'UDP', port: udp }));
}

// --- secrets

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Generates what is missing (and the cookie secret when rotating); returns the keys it made. */
export function generateSecrets(values: Values, random: (n: number) => Uint8Array = (n) => randomBytes(n), rotateCookie = false): string[] {
  const made: string[] = [];
  if (!values.COOKIE_SECRET || rotateCookie) {
    values.COOKIE_SECRET = b64(random(48));
    made.push('COOKIE_SECRET');
  }
  if (!values.LIVEKIT_API_KEY) {
    values.LIVEKIT_API_KEY = `telinha${hex(random(4))}`;
    made.push('LIVEKIT_API_KEY');
  }
  // LiveKit refuses secrets shorter than 32 characters.
  if (!values.LIVEKIT_API_SECRET || values.LIVEKIT_API_SECRET.length < 32) {
    values.LIVEKIT_API_SECRET = b64url(random(32));
    made.push('LIVEKIT_API_SECRET');
  }
  return made;
}

// --- review and write

/** The file text, and the config loadConfig makes of it (the same check `run` does at start). */
export function validateValues(values: Values, previous: PreviousEnv | null, home: string, o: { compiled?: boolean } = {}): { text: string; config: Config } {
  const text = renderEnvFile(values, previous);
  const config = loadConfig({ ...parseEnvFile(text).vars, TELINHA_HOME: home }, { compiled: o.compiled });
  return { text, config };
}

/** Review table; returns whether to rotate the cookie secret. Declining aborts. */
export async function review(w: Wizard, values: Values, o: { made: string[]; previous: PreviousEnv | null }): Promise<boolean> {
  const { term, s } = w;
  term.step(s('reviewTitle'));
  const rows: string[][] = [];
  for (const [k, v] of Object.entries(values)) {
    if (!v) continue;
    const shown = SECRET_KEYS.has(k) ? (o.made.includes(k) ? s('secretGenerated') : o.previous?.vars[k] === v ? s('secretKept') : s('secretSet')) : v;
    rows.push([term.style.dim(k), shown]);
  }
  term.table(rows);
  const canRotate = !!o.previous?.vars.COOKIE_SECRET && !o.made.includes('COOKIE_SECRET');
  const items: { value: 'write' | 'rotate' | 'abort'; label: string; hint?: string }[] = [{ value: 'write', label: s('reviewWrite') }];
  if (canRotate) items.push({ value: 'rotate', label: s('reviewRotate'), hint: s('reviewRotateHint') });
  items.push({ value: 'abort', label: s('reviewAbort') });
  const answer = await term.select(s('reviewQ'), items, 0, { id: 'review' });
  if (answer === 'abort') throw new SetupAbort(s('aborted'), 1);
  return answer === 'rotate';
}

/** The Windows account that keeps access to the file and runs the task. */
export async function windowsAccount(w: Wizard): Promise<{ user: string; sid: string } | null> {
  const r = await w.deps.spawn([whoamiExe(w.ctx.env), '/user', '/fo', 'csv']).catch(() => null);
  return r && r.code === 0 ? parseWhoami(r.stdout) : null;
}

/** `shown`: the path as the user finds it (the host's, when the wizard runs in the image). */
export async function writeConfig(w: Wizard, file: string, text: string, shown = file): Promise<void> {
  const env = w.ctx.env;
  const account = w.deps.platform === 'win32' ? await windowsAccount(w) : null;
  const user = account?.user ?? `${env.USERDOMAIN ?? ''}\\${env.USERNAME ?? ''}`;
  if (w.deps.platform === 'win32') {
    // The whole home (control token, task XML, bin\), before the secrets land in it.
    await w.deps.fs.mkdir(w.ctx.paths.home);
    await lockWindowsHome({ home: w.ctx.paths.home, user, spawn: w.deps.spawn, warn: (m) => w.term.warn(w.s('aclFailed', { error: m })) });
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
  w.term.ok(w.s('written', { file: shown }));
}

// --- binaries

export async function downloadBinaries(w: Wizard, config: Pick<Config, 'media' | 'ingress'>): Promise<boolean> {
  const { term, s } = w;
  term.step(s('binsTitle'));
  // A root install's bin/ belongs to the service user: root writing there could
  // be steered onto any file through a planted symlink. The service fetches
  // them itself at start, as that user.
  if (w.deps.platform === 'linux' && w.deps.isRoot && !w.docker) {
    const bin = await w.deps.fs.stat(w.ctx.paths.bin);
    if (bin && bin.uid !== 0) {
      term.info(s('binsByService'));
      return true;
    }
  }
  const spin = term.spinner(s('binsChecking'));
  try {
    await w.deps.bins(config, w.ctx.paths, (m) => spin.update(m.replace(/^\[bins\]\s*/, '')));
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
    if (outcome === 'ok') w.term.ok(step);
    else if (outcome === 'skipped') w.term.info(w.s('stepSkipped', { step }));
    else w.term.fail(`${step}: ${outcome.replace(/^failed: /, '')}`);
  }
  if (r.error) w.term.fail(r.error);
  for (const h of r.hints ?? []) {
    w.term.warn(w.s('stepHint', { cmd: h }));
    if (h.includes('enable-linger')) w.term.info(w.s('lingerWhy'));
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
    w.term.ok(w.s('exeCopied', { path: target }));
  }
  // The hints from here on say `telinha ...`; a double-clicked exe has no PATH entry yet.
  if (platform === 'win32' && (await addToUserPath(w.deps.spawn, w.ctx.paths.bin))) w.term.ok(w.s('pathAdded', { dir: w.ctx.paths.bin }));
  return target;
}

async function windowsInstall(w: Wizard, exe: string, firewall: boolean): Promise<boolean> {
  const { term, s, deps } = w;
  const home = w.ctx.paths.home;
  const account = await windowsAccount(w);
  const manual = (who: { user: string; sid: string } | null) =>
    elevationHint(exe, ['service', 'install', ...(firewall ? ['--firewall'] : []), '--home', home, '--lang', w.locale, ...(who ? ['--user', who.user, '--sid', who.sid] : [])]);
  if (!account) {
    term.warn(s('whoamiFailed'));
    term.info(s('serviceManual', { cmd: manual(null) }));
    return false;
  }
  const result = installResultPath(home);
  await deps.fs.mkdir(win32.dirname(result));
  await deps.fs.rm(result).catch(() => {});
  const args = ['service', 'install', ...(firewall ? ['--firewall'] : []), '--home', home, '--lang', w.locale, '--user', account.user, '--sid', account.sid, '--result', result];
  lines(term, s('uacExplain'));
  const r = await deps.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', elevationCommand(exe, args)]);
  const text = await deps.fs.readText(result).catch(() => null);
  if (!text) {
    // Declined UAC: Start-Process throws (exit 1) or reports ERROR_CANCELLED (1223).
    term.warn(r.code === 1223 || r.code === 1 ? s('uacDeclined') : s('uacNoResult', { code: r.code }));
    term.info(s('serviceManual', { cmd: manual(account) }));
    return false;
  }
  let parsed: InstallResult;
  try {
    parsed = JSON.parse(text) as InstallResult;
  } catch {
    term.warn(s('uacNoResult', { code: r.code }));
    term.info(s('serviceManual', { cmd: manual(account) }));
    return false;
  }
  printInstall(w, parsed);
  return parsed.steps?.task === 'ok';
}

async function linuxInstall(w: Wizard, exe: string): Promise<boolean> {
  const { term, s, deps } = w;
  const manager = deps.serviceManager({ user: !deps.isRoot });
  if (!manager) {
    term.warn(s('serviceUnsupported'));
    return false;
  }
  const spin = term.spinner(s('serviceInstalling', { kind: manager.kind }));
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
 * Linux user install, direct mode, a port below 1024: the unprivileged-port
 * sysctl (one sudo step, survives every binary update), else high ports with
 * the router translating 443 -> 8443. `rewrite` re-writes telinha.env.
 */
export async function unprivilegedPorts(w: Wizard, values: Values, rewrite: (v: Values) => Promise<void>): Promise<void> {
  const { term, s, deps } = w;
  if ((values.INGRESS || 'direct') !== 'direct') return;
  const low = [Number(values.HTTP_PORT || 80), Number(values.HTTPS_PORT || 443)].filter((p) => p > 0 && p < 1024);
  if (!low.length) return;
  const start = Number((await deps.fs.readText(UNPRIVILEGED_PORT_START).catch(() => null))?.trim() ?? NaN);
  if (Number.isInteger(start) && start <= Math.min(...low)) return;
  lines(term, s('sysctlExplain', { ports: low.join(', ') }));
  let ok = false;
  if (w.interactive) {
    if (await term.confirm(s('sysctlQ'), true, { id: 'sysctl' })) ok = (await deps.spawnInteractive(['sudo', 'sh', '-c', SYSCTL_SCRIPT]).catch(() => 1)) === 0;
  } else {
    ok = (await deps.spawn(['sudo', '-n', 'sh', '-c', SYSCTL_SCRIPT]).catch(() => ({ code: 1 }))).code === 0;
  }
  if (ok) {
    term.ok(s('sysctlOk'));
    return;
  }
  term.warn(s('sysctlFailed'));
  lines(term, s('highPortsExplain'));
  if (w.interactive && (await term.confirm(s('highPortsQ'), true, { id: 'high-ports' }))) {
    values.HTTPS_PORT = '8443';
    values.HTTP_PORT = '0';
    await rewrite(values);
    term.ok(s('highPortsOk'));
  } else {
    term.info(s('sysctlManual', { cmd: `sudo sh -c '${SYSCTL_SCRIPT}'` }));
  }
}

/** Installs and starts the service (and the Windows firewall rules); true when it is registered. */
export async function serviceStep(w: Wizard, values: Values, o: { firewall: boolean; rewrite: (v: Values) => Promise<void> }): Promise<boolean> {
  const { term, s, deps } = w;
  term.step(s('serviceTitle'));
  if (!w.ctx.compiled) {
    term.info(s('serviceNeedsBinary'));
    return false;
  }
  if (deps.platform === 'linux' && !deps.isRoot) await unprivilegedPorts(w, values, o.rewrite);
  let exe: string;
  try {
    exe = await installedExe(w);
  } catch (e) {
    term.fail(s('serviceFailed', { error: errMsg(e) }));
    return false;
  }
  if (deps.platform === 'win32') return windowsInstall(w, exe, o.firewall);
  if (deps.platform === 'linux') return linuxInstall(w, exe);
  term.warn(s('serviceUnsupported'));
  return false;
}

// --- router

/** The ports the internet must reach, as the router sees them. */
export function publicPorts(values: Values): string[] {
  const out = [`TCP ${values.MEDIA_TCP_PORT || '7881'}`, `UDP ${values.MEDIA_UDP_PORT || '7882'}`];
  if ((values.INGRESS || 'direct') === 'direct') {
    const https = values.HTTPS_PORT || '443';
    out.push(https === '443' ? 'TCP 443' : `TCP 443 -> ${https}`);
    if ((values.HTTP_PORT || '80') !== '0') out.push(`TCP ${values.HTTP_PORT || '80'}`);
  }
  return out;
}

/** What this host listens on, for its own firewall (ufw/firewalld take the internal ports). */
export function hostPorts(values: Values): string[] {
  const out = [`${values.MEDIA_TCP_PORT || '7881'}/tcp`, `${values.MEDIA_UDP_PORT || '7882'}/udp`];
  if ((values.INGRESS || 'direct') === 'direct') {
    out.push(`${values.HTTPS_PORT || '443'}/tcp`);
    if ((values.HTTP_PORT || '80') !== '0') out.push(`${values.HTTP_PORT || '80'}/tcp`);
  }
  return out;
}

export async function routerStep(w: Wizard, values: Values, target: Target = 'home'): Promise<void> {
  const { term, s } = w;
  term.step(s('routerTitle'));
  const ports = publicPorts(values).join(', ');
  // A VPS has no router: its provider's firewall and its own are what block.
  if (target === 'vps') {
    term.info(s('routerVps', { ports }));
    if (w.deps.platform === 'linux') {
      const cmds = firewallCommands(hostPorts(values), (c) => w.deps.which(c));
      if (cmds.ufw) term.info(s('routerVpsUfw', { cmd: cmds.ufw }));
      if (cmds.firewalld) term.info(s('routerVpsFirewalld', { cmd: cmds.firewalld }));
    }
    return;
  }
  const nat = w.host.nat ?? (await w.deps.nat.probe().catch(() => null));
  if (!nat?.gateway) {
    term.warn(s('routerNone'));
    term.info(s('forwardByHand', { ports }));
    return;
  }
  term.ok(s('routerFound', { router: routerLabel(nat) ?? '?', ip: nat.externalIp ?? '?' }));
  const ext = nat.externalIp;
  if (ext && isCgnatIpv4(ext)) lines(term, s('cgnat'), 'warn');
  else if (ext && isPrivateIpv4(ext)) lines(term, s('doubleNat'), 'warn');
  term.info(values.UPNP === 'off' ? s('forwardByHand', { ports }) : s('upnpWillMap', { ports }));
}

// --- start, doctor, next steps

/** The service did not come up: its log says why (caddy cannot bind 80, a bad tunnel token...). */
function notAnswering(w: Wizard, spin: { fail(label?: string): void }): void {
  const [first, ...rest] = w.s('notAnswering', { log: logCommand(w), telinha: cliName(w) }).split('\n');
  spin.fail(first);
  for (const l of rest) w.term.info(l);
}

async function waitForService(w: Wizard, timeoutMs: number): Promise<boolean> {
  const end = w.deps.now() + timeoutMs;
  while (w.deps.now() < end) {
    if (await w.deps.control.available().catch(() => false)) return true;
    await w.deps.sleep(1000);
  }
  return false;
}

/**
 * A service that was already running restarts to read the new file; a fresh
 * one was started by its install. Then doctor (phone test only interactively).
 */
/** How long setup waits for Caddy's first certificate before doctor runs. */
export const CERT_WAIT_MS = 90_000;

/**
 * Direct mode: Caddy gets its certificate after the start, which takes from
 * seconds to minutes. Doctor before that flags a correct install as broken;
 * wait for the local listener to serve a valid one (asked by name on
 * 127.0.0.1, so a router without hairpin NAT does not matter).
 */
async function waitForCertificate(w: Wizard, values: Values): Promise<void> {
  const { term, s, deps } = w;
  let host: string;
  try {
    host = new URL(values.PUBLIC_URL ?? '').hostname;
  } catch {
    return;
  }
  const port = Number(values.HTTPS_PORT || 443);
  const spin = term.spinner(s('certWaiting'));
  const end = deps.now() + CERT_WAIT_MS;
  for (;;) {
    if (await deps.certReady(host, port).catch(() => false)) {
      spin.stop(s('certOk'));
      return;
    }
    if (deps.now() >= end) break;
    await deps.sleep(3000);
  }
  spin.fail(s('certPending', { telinha: cliName(w) }));
}

export async function startAndDoctor(w: Wizard, o: { installed: boolean; wasRunning: boolean; doctor: boolean; values?: Values }): Promise<number> {
  const { term, s, deps } = w;
  term.step(s('startTitle'));
  let running = false;
  if (o.wasRunning) {
    const supervised = await deps.control.status().then((st) => st.supervised, () => true);
    if (supervised) {
      try {
        await deps.control.shutdown('restart');
      } catch (e) {
        term.warn(errMsg(e));
      }
      // The old process answers a little longer; give it time to go.
      await deps.sleep(3000);
      const spin = term.spinner(s('restarting'));
      running = await waitForService(w, 60_000);
      if (running) spin.stop(s('running'));
      else notAnswering(w, spin);
    } else {
      term.warn(s('consoleRestart'));
    }
  } else if (o.installed) {
    const spin = term.spinner(s('waitingStart'));
    running = await waitForService(w, 60_000);
    if (running) spin.stop(s('running'));
    else notAnswering(w, spin);
  } else {
    term.info(s('startByHand', { cmd: `${cliName(w)} run` }));
  }
  if (!o.doctor) return 0;
  if (running && o.values && (o.values.INGRESS || 'direct') === 'direct') await waitForCertificate(w, o.values);
  term.step(s('doctorTitle'));
  const argv = ['doctor', ...(w.interactive && running ? [] : ['--no-phone'])];
  try {
    const code = await deps.doctor({ ...w.ctx, argv, locale: w.locale });
    if (code !== 0) term.warn(s('doctorProblems', { telinha: cliName(w) }));
  } catch (e) {
    term.warn(s('doctorFailed', { error: errMsg(e) }));
  }
  return 0;
}

export function nextSteps(w: Wizard, values: Values, o: { file: string }): void {
  const { term, s } = w;
  term.step(s('nextTitle'));
  if (w.docker) {
    lines(term, s('nextDocker'));
    return;
  }
  lines(term, s('nextNative', { url: values.PUBLIC_URL ?? '', command: values.COMMAND_NAME || 'telinha', file: o.file, telinha: cliName(w) }));
}
