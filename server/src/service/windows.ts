// Windows: a Task Scheduler task at boot running `telinha service run` as the
// installing user (S4U: no password stored, no logon needed, plain user token).
// The task is the backstop that restarts a crashed loop; the loop itself
// restarts the server. Stopping is graceful through the control endpoint, then
// `schtasks /End` (a user termination, never a failure RestartOnFailure would
// undo), and only then a kill of the loop's tree by the pid it wrote, once
// that pid is confirmed to still be telinha.
import { win32 } from 'node:path';
import { sameExe } from '../supervisor.ts';
import { applyFirewallRules, firewallRules, loadFirewallPorts, removeFirewallRules } from './firewall.ts';
import {
  attempt,
  errorMessage,
  type InstallOptions,
  type InstallResult,
  must,
  NotElevatedError,
  type ServiceDeps,
  ServiceInstallError,
  type ServiceManager,
  type SpawnFn,
} from './index.ts';
import { setAutostart, stopTray, trayExePath } from './tray.ts';

// Windows paths whatever the host (tests run on Linux too).
const { join } = win32;

export const TASK_NAME = 'Telinha';
/** How long a graceful stop may take before the process tree is killed. */
export const STOP_WAIT_MS = 15_000;
const STOP_POLL_MS = 500;
/** How long `schtasks /End` gets to take the loop down before its tree is killed. */
const END_WAIT_MS = 5000;

export const taskXmlPath = (home: string): string => join(home, 'service', 'telinha-task.xml');

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The task definition. Priority 4 is "normal" (the default 7 is below normal,
 * bad for media); ExecutionTimeLimit PT0S means no time limit; IgnoreNew keeps
 * a second instance from starting next to a running one.
 */
export function taskXml(o: { home: string; exe: string; sid: string }): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Telinha</Author>
    <Description>Telinha screen share server</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT15S</Delay>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(o.sid)}</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${escapeXml(o.exe)}"</Command>
      <Arguments>service run --home "${escapeXml(o.home)}"</Arguments>
      <WorkingDirectory>${escapeXml(o.home)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Task Scheduler reads UTF-16 LE with a BOM. */
export function encodeTaskXml(xml: string): Uint8Array {
  return new Uint8Array(Buffer.from(`﻿${xml}`, 'utf16le'));
}

/** `whoami /user /fo csv`: "User Name","SID" then one data row. */
export function parseWhoami(csv: string): { user: string; sid: string } | null {
  const row = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[1];
  const [, user, sid] = (row ? /^"([^"]*)","(S-[^"]*)"/.exec(row) : null) ?? [];
  return user !== undefined && sid !== undefined ? { user, sid } : null;
}

/**
 * `schtasks /Query /TN <name> /FO CSV /V`: the first seven columns are
 * HostName, TaskName, Next Run Time, Status, Logon Mode, Last Run Time, Last
 * Result, whatever the display language; later columns (Task To Run) are not
 * escaped properly, so only these are read.
 */
export function parseTaskQuery(csv: string): { taskName: string; status: string; lastResult: string } | null {
  const rows = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'));
  const row = rows[1];
  const [, , taskName, , status, , , lastResult] =
    (row ? /^"([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)"/.exec(row) : null) ?? [];
  return taskName !== undefined && status !== undefined && lastResult !== undefined
    ? { taskName, status, lastResult }
    : null;
}

/** "267009" -> "0x41301"; "0" stays. Task Scheduler codes read better in hex. */
export const formatLastResult = (v: string): string => {
  const n = Number(v);
  return Number.isInteger(n) && n !== 0 ? `0x${(n >>> 0).toString(16).toUpperCase()}` : v;
};

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const powershell = (command: string) => ['powershell', '-NoProfile', '-NonInteractive', '-Command', command];

/** System32's whoami by full path: Git for Windows puts a `whoami` on PATH that knows no /user. */
export const whoamiExe = (env: Record<string, string | undefined>): string =>
  join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'whoami.exe');

export const IS_ADMIN_PS =
  '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';

/**
 * The token's Administrators membership (enabled only when elevated). `fltmc`
 * (admin only) and `net session` are fallbacks: the latter fails on any
 * machine with the Server service disabled, elevated or not.
 */
export async function isElevated(spawn: SpawnFn): Promise<boolean> {
  const ps = await spawn(powershell(IS_ADMIN_PS));
  const answer = ps.stdout.trim();
  if (ps.code === 0 && (answer === 'True' || answer === 'False')) return answer === 'True';
  if ((await spawn(['fltmc'])).code === 0) return true;
  return (await spawn(['net', 'session'])).code === 0;
}

/**
 * The token's TokenElevationType (18): 1 default (a standard user, UAC off, or
 * the built-in Administrator), 2 full (elevated through UAC), 3 limited.
 */
export const ELEVATION_TYPE_PS =
  `Add-Type -Namespace TelinhaProbe -Name Token -MemberDefinition '[DllImport("advapi32.dll")] public static extern bool GetTokenInformation(IntPtr token, int cls, out int value, int len, out int ret);'; ` +
  '$v = 0; $r = 0; if ([TelinhaProbe.Token]::GetTokenInformation([Security.Principal.WindowsIdentity]::GetCurrent().Token, 18, [ref]$v, 4, [ref]$r)) { $v }';

/** Encoded: the script's double quotes never meet Windows command-line quoting. */
export const elevationTypeCommand = (): string[] => [
  'powershell',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(ELEVATION_TYPE_PS, 'utf16le').toString('base64'),
];

/**
 * Elevated through UAC, the only case where a program started from here would
 * run at a higher integrity than the user's desktop (and UIPI would cut it
 * off from the shell). With UAC off, or as the built-in Administrator, nothing
 * runs any lower, so that is no reason to refuse. When the probe gives no
 * answer, the Administrators check decides.
 */
export async function isSplitElevated(spawn: SpawnFn): Promise<boolean> {
  const r = await spawn(elevationTypeCommand());
  const answer = r.stdout.trim();
  if (r.code === 0 && /^[123]$/.test(answer)) return answer === '2';
  return isElevated(spawn);
}

export function createWindowsTask(d: ServiceDeps): ServiceManager {
  const { spawn, fs, paths, log } = d;
  const pidfile = join(paths.run, 'service.pid');

  async function resolveSid(given?: string): Promise<string> {
    if (given) return given;
    const who = parseWhoami((await spawn([whoamiExe(d.env), '/user', '/fo', 'csv'])).stdout);
    if (!who) throw new Error('could not read the current user SID (whoami /user)');
    return who.sid;
  }

  async function register(o: InstallOptions): Promise<void> {
    const sid = await resolveSid(o.sid);
    const xmlPath = taskXmlPath(o.home);
    await fs.mkdir(join(o.home, 'service'));
    await fs.writeFile(xmlPath, encodeTaskXml(taskXml({ home: o.home, exe: o.exe, sid })));
    const ps = await spawn(
      powershell(
        `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Xml (Get-Content -Raw -LiteralPath ${psQuote(xmlPath)}) -Force | Out-Null`,
      ),
    );
    if (ps.code === 0) return;
    // No ScheduledTasks module (stripped-down editions): schtasks reads the same XML.
    log(`service: Register-ScheduledTask failed (${(ps.stderr || ps.stdout).trim()}); trying schtasks`);
    const cmd = ['schtasks', '/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/F'];
    must(cmd, await spawn(cmd));
  }

  async function unregister(): Promise<void> {
    const ps = await spawn(powershell(`Unregister-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Confirm:$false`));
    if (ps.code === 0) return;
    const cmd = ['schtasks', '/Delete', '/TN', TASK_NAME, '/F'];
    const r = await spawn(cmd);
    // Already gone is fine.
    if (r.code !== 0 && !/cannot find|não foi possível encontrar|does not exist/i.test(r.stderr + r.stdout))
      must(cmd, r);
  }

  const manager: ServiceManager = {
    kind: 'windows-task',

    async install(o) {
      const result: InstallResult = {
        ok: false,
        steps: { task: 'skipped', firewall: 'skipped', start: 'skipped' },
        hints: [],
      };
      try {
        if (!(await isElevated(spawn))) throw new NotElevatedError(o.exe);
        result.steps.task = await attempt(() => register(o));
        if (o.firewall) {
          result.steps.firewall = await attempt(async () => {
            // Only the native binary installs a service (cli/service.ts refuses otherwise).
            const ports = loadFirewallPorts(d.envFile, d.env, { compiled: true });
            await applyFirewallRules(spawn, firewallRules(paths.bin, ports));
          });
        }
        // Nothing to start when the task is not there.
        if (result.steps.task === 'ok') result.steps.start = await attempt(() => manager.start());
        result.ok = Object.values(result.steps).every((s) => s === 'ok' || s === 'skipped');
      } catch (e) {
        result.error = errorMessage(e);
      }
      if (o.resultFile) {
        try {
          await fs.writeFile(o.resultFile, `${JSON.stringify(result, null, 2)}\n`);
        } catch (e) {
          log(`service: could not write ${o.resultFile}: ${errorMessage(e)}`);
        }
      }
      if (!result.ok) throw new ServiceInstallError(result);
      return result;
    },

    async uninstall(o) {
      try {
        await manager.stop();
      } catch (e) {
        log(`service: stop before uninstall: ${errorMessage(e)}`);
      }
      await unregister();
      // The tray icon would only report a service that is gone; its file goes with the folder.
      try {
        if ((await stopTray(d)) === 'stopped') log('service: tray icon stopped');
      } catch (e) {
        log(`service: stopping the tray icon: ${errorMessage(e)}`);
      }
      try {
        await setAutostart(spawn, trayExePath(paths), false);
      } catch (e) {
        log(`service: tray autostart: ${errorMessage(e)}`);
      }
      if (o.firewall) await removeFirewallRules(spawn);
    },

    async start() {
      const cmd = ['schtasks', '/Run', '/TN', TASK_NAME];
      must(cmd, await spawn(cmd));
    },

    // Graceful first: the server shuts down, the loop exits 0 and removes its
    // pidfile. Then Task Scheduler ends the instance: recorded as terminated
    // by the user (0x41306), not a failure, so RestartOnFailure does not start
    // it again a minute later, and the task's job object takes the children.
    // A loop still alive after that (a console `service run`) is killed with
    // its tree, but only while the recorded pid is still a telinha: a loop
    // killed outright leaves service.pid behind, and pids get reused.
    async stop() {
      if (await d.control.available()) {
        try {
          await d.control.shutdown('stop');
        } catch (e) {
          log(`service: shutdown request failed: ${errorMessage(e)}`);
        }
        const deadline = d.now() + STOP_WAIT_MS;
        while ((await fs.exists(pidfile)) && d.now() < deadline) await d.sleep(STOP_POLL_MS);
      }
      await spawn(['schtasks', '/End', '/TN', TASK_NAME]);
      const text = await fs.readText(pidfile);
      const pid = text ? Number(text.trim()) : NaN;
      if (!Number.isInteger(pid) || pid <= 0) return;
      const isLoop = () => {
        const info = d.processInfo(pid);
        return info.alive && sameExe('telinha.exe', info.exe, 'win32');
      };
      if (!isLoop()) {
        log(`service: no telinha runs as pid ${pid} (from service.pid); removed the stale file`);
        await fs.rm(pidfile);
        return;
      }
      const deadline = d.now() + END_WAIT_MS;
      while (isLoop() && d.now() < deadline) await d.sleep(STOP_POLL_MS);
      if (isLoop()) await spawn(['taskkill', '/T', '/F', '/PID', String(pid)]);
      await fs.rm(pidfile);
    },

    async restart() {
      await manager.stop();
      await manager.start();
    },

    async status() {
      const q = await spawn(['schtasks', '/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/V']);
      const installed = q.code === 0;
      const task = installed ? parseTaskQuery(q.stdout) : null;
      const running = await d.control.available();
      const enabled = installed && !/disabled|desabilitad|desativad/i.test(task?.status ?? '');
      const detail = installed
        ? `task ${task?.status ?? '?'}, last result ${formatLastResult(task?.lastResult ?? '?')}; telinha ${running ? 'answering' : 'not answering'}`
        : `no scheduled task ${TASK_NAME}; telinha ${running ? 'running (console)' : 'not running'}`;
      return { installed, running, enabled, detail };
    },
  };
  return manager;
}
