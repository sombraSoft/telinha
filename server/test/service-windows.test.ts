import { describe, expect, test } from 'bun:test';
import {
  type ServiceFs,
  ServiceInstallError,
  type SpawnFn,
  type SpawnOutcome,
  serviceManager,
} from '../src/service/index.ts';
import {
  ELEVATION_TYPE_PS,
  elevationTypeCommand,
  encodeTaskXml,
  formatLastResult,
  IS_ADMIN_PS,
  isElevated,
  isSplitElevated,
  parseTaskQuery,
  parseWhoami,
  taskXml,
  whoamiExe,
} from '../src/service/windows.ts';

const HOME = 'C:\\Users\\ana\\AppData\\Local\\Telinha';
const EXE = `${HOME}\\bin\\telinha.exe`;
const SID = 'S-1-5-21-1240013230-4267942774-2319025363-1001';
const PATHS = {
  home: HOME,
  bin: `${HOME}\\bin`,
  config: `${HOME}\\config`,
  data: `${HOME}\\data`,
  run: `${HOME}\\data\\run`,
  logs: `${HOME}\\logs`,
  logFile: `${HOME}\\logs\\telinha.log`,
};
const PIDFILE = `${HOME}\\data\\run\\service.pid`;
const RESULT = `${HOME}\\service\\install-result.json`;

const WHOAMI = '\r\n"User Name","SID"\r\n"sombrio-pc\\ana","S-1-5-21-1240013230-4267942774-2319025363-1001"\r\n';
// Real schtasks /V output shape: the Task To Run column is not escaped properly.
const QUERY = [
  '"HostName","TaskName","Next Run Time","Status","Logon Mode","Last Run Time","Last Result","Author","Task To Run","Start In","Comment","Scheduled Task State","Idle Time","Power Management","Run As User","Delete Task If Not Rescheduled","Stop Task If Runs X Hours and X Mins","Schedule","Schedule Type","Start Time","Start Date","End Date","Days","Months","Repeat: Every","Repeat: Until: Time","Repeat: Until: Duration","Repeat: Stop If Still Running"',
  `"SOMBRIO-PC","\\Telinha","N/A","Running","Interactive/Background","05/10/2026 16:05:02","267009","Telinha",""${EXE}" service run --home "${HOME}"","${HOME}","Telinha screen share server","Enabled","Disabled","","sombrio-pc\\ana","Disabled","Disabled","Scheduling data is not available in this format.","At system startup","N/A","N/A","N/A","N/A","N/A","N/A","N/A","N/A","N/A"`,
  '',
].join('\r\n');

type Responder = (cmd: string[]) => Partial<SpawnOutcome> | undefined;
function recorder(respond: Responder = () => undefined) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: '', stderr: '', ...respond(cmd) };
  };
  return { spawn, calls, names: () => calls.map((c) => c.slice(0, 2).join(' ')) };
}

function memFs() {
  const files = new Map<string, string | Uint8Array>();
  const fs: ServiceFs = {
    async readText(p) {
      const v = files.get(p);
      return v === undefined ? null : typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    async writeFile(p, d) {
      files.set(p, d);
    },
    exists: async (p) => files.has(p),
    async rm(p) {
      files.delete(p);
    },
    async mkdir() {},
  };
  return { fs, files };
}

/**
 * The admin check answers False unless `elevated`; `procs` is what runs per pid
 * (image name); everything else succeeds unless `respond` says otherwise.
 */
function host(o: { elevated?: boolean; available?: boolean; respond?: Responder; procs?: Map<number, string> } = {}) {
  const r = recorder((cmd) => {
    if (cmd[4] === IS_ADMIN_PS) return { stdout: o.elevated === false ? 'False\r\n' : 'True\r\n' };
    if (cmd[0]?.endsWith('whoami.exe')) return { stdout: WHOAMI };
    return o.respond?.(cmd);
  });
  const m = memFs();
  const shutdowns: string[] = [];
  const clock = { t: 1_700_000_000_000 };
  const control = {
    available: async () => o.available ?? false,
    shutdown: async (reason: 'stop' | 'restart') => void shutdowns.push(reason),
  };
  const logs: string[] = [];
  const procs = o.procs ?? new Map<number, string>();
  const manager = serviceManager({
    platform: 'win32',
    isRoot: false,
    spawn: r.spawn,
    fs: m.fs,
    paths: PATHS,
    envFile: `${HOME}\\config\\telinha.env`,
    env: {},
    control,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    log: (...a) => logs.push(a.join(' ')),
    processInfo: (pid) => (procs.has(pid) ? { alive: true, exe: procs.get(pid)! } : { alive: false, exe: null }),
  })!;
  return { manager, calls: r.calls, names: r.names, files: m.files, shutdowns, clock, logs, procs };
}

const install = (h: ReturnType<typeof host>, o: Partial<Parameters<typeof h.manager.install>[0]> = {}) =>
  h.manager.install({ firewall: false, exe: EXE, home: HOME, locale: 'en', ...o });

describe('task XML', () => {
  test('boot trigger, S4U principal with the given SID, LeastPrivilege, the settings and the action', () => {
    const xml = taskXml({ home: HOME, exe: EXE, sid: SID });
    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      ),
    ).toBe(true);
    expect(xml).toContain(
      '<BootTrigger>\n      <Enabled>true</Enabled>\n      <Delay>PT15S</Delay>\n    </BootTrigger>',
    );
    expect(xml).toContain(
      `<Principal id="Author">\n      <UserId>${SID}</UserId>\n      <LogonType>S4U</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>`,
    );
    expect(xml).not.toContain('HighestAvailable');
    for (const s of [
      '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
      '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '<Priority>4</Priority>',
      '<RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>999</Count>\n    </RestartOnFailure>',
      '<StartWhenAvailable>true</StartWhenAvailable>',
      '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    ]) {
      expect(xml).toContain(s);
    }
    expect(xml).toContain(
      `<Exec>\n      <Command>"${EXE}"</Command>\n      <Arguments>service run --home "${HOME}"</Arguments>\n      <WorkingDirectory>${HOME}</WorkingDirectory>\n    </Exec>`,
    );
  });

  test('escapes XML specials in paths', () => {
    const xml = taskXml({ home: 'C:\\A & B <x>', exe: 'C:\\A & B <x>\\telinha.exe', sid: SID });
    expect(xml).toContain('<WorkingDirectory>C:\\A &amp; B &lt;x&gt;</WorkingDirectory>');
    expect(xml).toContain('<Command>"C:\\A &amp; B &lt;x&gt;\\telinha.exe"</Command>');
  });

  test('encodes as UTF-16 LE with a BOM and decodes back to the same text', () => {
    const xml = taskXml({ home: HOME, exe: EXE, sid: SID });
    const bytes = encodeTaskXml(xml);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.length).toBe((xml.length + 1) * 2);
    expect(new TextDecoder('utf-16le', { ignoreBOM: true }).decode(bytes)).toBe(`\ufeff${xml}`);
    expect(new TextDecoder('utf-16le').decode(bytes)).toBe(xml);
  });
});

describe('parsing', () => {
  test('whoami /user /fo csv', () => {
    expect(parseWhoami(WHOAMI)).toEqual({ user: 'sombrio-pc\\ana', sid: SID });
    expect(parseWhoami('garbage')).toBeNull();
  });

  test('schtasks /Query CSV: positional columns, the unescaped Task To Run does no harm', () => {
    expect(parseTaskQuery(QUERY)).toEqual({ taskName: '\\Telinha', status: 'Running', lastResult: '267009' });
    expect(parseTaskQuery('ERROR: The system cannot find the file specified.')).toBeNull();
    expect(parseTaskQuery(QUERY.split('\r\n')[0]!)).toBeNull();
  });

  test('last result in hex when nonzero', () => {
    expect(formatLastResult('0')).toBe('0');
    expect(formatLastResult('267009')).toBe('0x41301');
    expect(formatLastResult('-2147023511')).toBe('0x80070569');
    expect(formatLastResult('N/A')).toBe('N/A');
  });

  test('whoami comes from System32, never from PATH', () => {
    expect(whoamiExe({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\whoami.exe');
    expect(whoamiExe({})).toBe('C:\\Windows\\System32\\whoami.exe');
  });

  test('isElevated reads the token (Administrators role); fltmc, then `net session` when PowerShell gives no answer', async () => {
    const ps = (stdout: string) => recorder((cmd) => (cmd[0] === 'powershell' ? { stdout } : { code: 1 }));
    const yes = ps('True\r\n');
    expect(await isElevated(yes.spawn)).toBe(true);
    expect(yes.calls).toEqual([['powershell', '-NoProfile', '-NonInteractive', '-Command', IS_ADMIN_PS]]);
    // The Server service disabled: `net session` would say no even when elevated; the token decides.
    expect(await isElevated(ps('False').spawn)).toBe(false);
    const noPs = (fltmc: number, net: number) =>
      recorder((cmd) => ({ code: cmd[0] === 'fltmc' ? fltmc : cmd[0] === 'net' ? net : 1 }));
    expect(await isElevated(noPs(0, 2).spawn)).toBe(true);
    const viaNet = noPs(1, 0);
    expect(await isElevated(viaNet.spawn)).toBe(true);
    expect(viaNet.calls.map((c) => c[0])).toEqual(['powershell', 'fltmc', 'net']);
    expect(await isElevated(noPs(1, 2).spawn)).toBe(false);
  });

  test('isSplitElevated refuses only a UAC elevation; no answer falls back to the Administrators check', async () => {
    const cmd = elevationTypeCommand();
    expect(cmd.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(cmd[4]!, 'base64').toString('utf16le')).toBe(ELEVATION_TYPE_PS);
    const probe = (answer: string, admin = 'False') =>
      recorder((c) =>
        c[3] === '-EncodedCommand' ? { stdout: answer } : c[4] === IS_ADMIN_PS ? { stdout: admin } : { code: 1 },
      );
    expect(await isSplitElevated(probe('2\r\n').spawn)).toBe(true);
    // UAC off or the built-in Administrator: no less privileged session exists to run it from.
    expect(await isSplitElevated(probe('1\r\n', 'True').spawn)).toBe(false);
    expect(await isSplitElevated(probe('3\r\n').spawn)).toBe(false);
    const silent = probe('', 'True');
    expect(await isSplitElevated(silent.spawn)).toBe(true);
    expect(silent.calls.map((c) => c[3])).toEqual(['-EncodedCommand', '-Command']);
  });
});

describe('install', () => {
  test('registers through PowerShell with the XML written as UTF-16, SID from whoami, then starts the task', async () => {
    const h = host({ elevated: true });
    const r = await install(h);
    expect(r).toEqual({ ok: true, steps: { task: 'ok', firewall: 'skipped', start: 'ok' }, hints: [] });
    expect(h.names()).toEqual([
      'powershell -NoProfile',
      'C:\\Windows\\System32\\whoami.exe /user',
      'powershell -NoProfile',
      'schtasks /Run',
    ]);
    expect(h.calls[1]).toEqual(['C:\\Windows\\System32\\whoami.exe', '/user', '/fo', 'csv']);
    const ps = h.calls[2]!;
    expect(ps.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command']);
    expect(ps[4]).toBe(
      `Register-ScheduledTask -TaskName 'Telinha' -Xml (Get-Content -Raw -LiteralPath '${HOME}\\service\\telinha-task.xml') -Force | Out-Null`,
    );
    expect(h.calls[3]).toEqual(['schtasks', '/Run', '/TN', 'Telinha']);
    const xml = h.files.get(`${HOME}\\service\\telinha-task.xml`) as Uint8Array;
    expect(xml[0]).toBe(0xff);
    expect(new TextDecoder('utf-16le').decode(xml)).toContain(`<UserId>${SID}</UserId>`);
  });

  test('--sid skips whoami; the result file records every step', async () => {
    const h = host({ elevated: true });
    await install(h, { sid: 'S-1-5-21-9-9-9-1002', user: 'PC\\other', resultFile: RESULT });
    expect(h.names()).toEqual(['powershell -NoProfile', 'powershell -NoProfile', 'schtasks /Run']);
    expect(
      new TextDecoder('utf-16le').decode(h.files.get(`${HOME}\\service\\telinha-task.xml`) as Uint8Array),
    ).toContain('<UserId>S-1-5-21-9-9-9-1002</UserId>');
    expect(JSON.parse(h.files.get(RESULT) as string)).toEqual({
      ok: true,
      steps: { task: 'ok', firewall: 'skipped', start: 'ok' },
      hints: [],
    });
  });

  test('falls back to schtasks /Create /XML when the cmdlet fails', async () => {
    const h = host({
      elevated: true,
      respond: (cmd) => (cmd[0] === 'powershell' ? { code: 1, stderr: 'not recognized' } : undefined),
    });
    await install(h, { sid: SID });
    expect(h.calls[2]).toEqual([
      'schtasks',
      '/Create',
      '/TN',
      'Telinha',
      '/XML',
      `${HOME}\\service\\telinha-task.xml`,
      '/F',
    ]);
    expect(h.logs.join('\n')).toContain('Register-ScheduledTask failed (not recognized)');
  });

  test('refuses when not elevated: no task touched, result file written with the error', async () => {
    const h = host({ elevated: false });
    const err = await install(h, { resultFile: RESULT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceInstallError);
    const { result } = err as ServiceInstallError;
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual({ task: 'skipped', firewall: 'skipped', start: 'skipped' });
    expect(result.error).toContain('elevated');
    expect(h.names()).toEqual(['powershell -NoProfile']);
    expect(JSON.parse(h.files.get(RESULT) as string)).toEqual(result);
  });

  test('a failing firewall step is recorded, the task is still started, the install still fails', async () => {
    const h = host({
      elevated: true,
      respond: (cmd) =>
        cmd[0] === 'netsh' && cmd[3] === 'add' && String(cmd[5]).includes('UDP')
          ? { code: 1, stdout: 'The parameter is incorrect.' }
          : undefined,
    });
    const err = await install(h, { firewall: true, sid: SID, resultFile: RESULT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceInstallError);
    const { result } = err as ServiceInstallError;
    expect(result.steps.task).toBe('ok');
    expect(result.steps.firewall).toBe(
      'failed: netsh could not add rule "Telinha LiveKit UDP": The parameter is incorrect.',
    );
    expect(result.steps.start).toBe('ok');
    expect(result.error).toBeUndefined();
    expect(JSON.parse(h.files.get(RESULT) as string).steps.firewall).toContain('Telinha LiveKit UDP');
    // Rules from the defaults (no telinha.env): media ports, then caddy's 443/80 in direct mode.
    const adds = h.calls.filter((c) => c[0] === 'netsh' && c[3] === 'add').map((c) => c[5]);
    expect(adds).toEqual(['name=Telinha LiveKit TCP', 'name=Telinha LiveKit UDP']);
  });

  test('task registration failing skips the start', async () => {
    const h = host({
      elevated: true,
      respond: (cmd) =>
        cmd[0] === 'powershell' || cmd[0] === 'schtasks' ? { code: 1, stderr: 'ERROR: Access is denied.' } : undefined,
    });
    const err = (await install(h, { sid: SID }).catch((e: unknown) => e)) as ServiceInstallError;
    expect(err.result.steps).toEqual({
      task: 'failed: schtasks exited with code 1: ERROR: Access is denied.',
      firewall: 'skipped',
      start: 'skipped',
    });
    expect(h.names()).not.toContain('schtasks /Run');
  });
});

describe('stop, status, uninstall', () => {
  test('stop: graceful through the control endpoint, waits for the pidfile, schtasks /End, then taskkill /T /F a loop still there', async () => {
    const h = host({ available: true, procs: new Map([[4242, 'telinha.exe']]) });
    h.files.set(PIDFILE, '4242\r\n');
    const t0 = h.clock.t;
    await h.manager.stop();
    expect(h.shutdowns).toEqual(['stop']);
    expect(h.clock.t - t0).toBe(15_000 + 5000);
    expect(h.calls).toEqual([
      ['schtasks', '/End', '/TN', 'Telinha'],
      ['taskkill', '/T', '/F', '/PID', '4242'],
    ]);
    expect(h.files.has(PIDFILE)).toBe(false);
  });

  test('stop: schtasks /End takes the loop down -> no taskkill (Task Scheduler records a user stop, no restart on failure)', async () => {
    const procs = new Map([[4242, 'telinha.exe']]);
    const h = host({
      available: false,
      procs,
      respond: (cmd) => (cmd[1] === '/End' ? (procs.clear(), undefined) : undefined),
    });
    h.files.set(PIDFILE, '4242');
    await h.manager.stop();
    expect(h.calls).toEqual([['schtasks', '/End', '/TN', 'Telinha']]);
    expect(h.files.has(PIDFILE)).toBe(false);
  });

  test('stop: the loop exits on its own (pidfile gone) -> no taskkill, schtasks /End for good measure', async () => {
    const h = host({ available: true });
    h.files.set(PIDFILE, '4242');
    const original = h.manager.stop;
    // The loop removes its pidfile 2 s into the wait.
    const sleep = async () => {
      h.clock.t += 500;
      if (h.clock.t >= 1_700_000_000_000 + 2000) h.files.delete(PIDFILE);
    };
    const manager = serviceManager({
      platform: 'win32',
      isRoot: false,
      spawn: async (cmd) => (h.calls.push(cmd), { code: 0, stdout: '', stderr: '' }),
      fs: {
        readText: async (p) => (h.files.get(p) as string | undefined) ?? null,
        writeFile: async () => {},
        exists: async (p) => h.files.has(p),
        rm: async (p) => void h.files.delete(p),
        mkdir: async () => {},
      },
      paths: PATHS,
      env: {},
      control: { available: async () => true, shutdown: async () => {} },
      now: () => h.clock.t,
      sleep,
      processInfo: () => ({ alive: true, exe: 'telinha.exe' }),
    })!;
    await manager.stop();
    expect(h.calls).toEqual([['schtasks', '/End', '/TN', 'Telinha']]);
    expect(original).toBeDefined();
  });

  test('stop with a stale pidfile whose pid now runs something else: nothing killed, the pidfile removed', async () => {
    const h = host({ available: false, procs: new Map([[4242, 'chrome.exe']]) });
    h.files.set(PIDFILE, '4242');
    await h.manager.stop();
    expect(h.shutdowns).toEqual([]);
    expect(h.calls).toEqual([['schtasks', '/End', '/TN', 'Telinha']]);
    expect(h.files.has(PIDFILE)).toBe(false);
    expect(h.logs.join('\n')).toContain('no telinha runs as pid 4242');
  });

  test('status: schtasks CSV plus the control endpoint', async () => {
    const running = host({
      available: true,
      respond: (cmd) => (cmd[0] === 'schtasks' ? { stdout: QUERY } : undefined),
    });
    expect(await running.manager.status()).toEqual({
      installed: true,
      running: true,
      enabled: true,
      detail: 'task Running, last result 0x41301; telinha answering',
    });
    expect(running.calls[0]).toEqual(['schtasks', '/Query', '/TN', 'Telinha', '/FO', 'CSV', '/V']);

    const disabled = host({
      available: false,
      respond: (cmd) =>
        cmd[0] === 'schtasks'
          ? { stdout: QUERY.replace('"Running"', '"Disabled"').replace('"267009"', '"0"') }
          : undefined,
    });
    expect(await disabled.manager.status()).toEqual({
      installed: true,
      running: false,
      enabled: false,
      detail: 'task Disabled, last result 0; telinha not answering',
    });

    const missing = host({
      available: false,
      respond: (cmd) =>
        cmd[0] === 'schtasks' ? { code: 1, stderr: 'ERROR: The system cannot find the file specified.' } : undefined,
    });
    expect(await missing.manager.status()).toEqual({
      installed: false,
      running: false,
      enabled: false,
      detail: 'no scheduled task Telinha; telinha not running',
    });

    const console = host({ available: true, respond: (cmd) => (cmd[0] === 'schtasks' ? { code: 1 } : undefined) });
    expect((await console.manager.status()).detail).toBe('no scheduled task Telinha; telinha running (console)');
  });

  test('uninstall: stop, Unregister-ScheduledTask (schtasks /Delete fallback), firewall rules removed, files kept', async () => {
    const h = host({ available: false, respond: (cmd) => (cmd[0] === 'powershell' ? { code: 1 } : undefined) });
    h.files.set(`${HOME}\\service\\telinha-task.xml`, 'xml');
    await h.manager.uninstall({ firewall: true });
    expect(h.names()).toEqual([
      'schtasks /End',
      'powershell -NoProfile',
      'schtasks /Delete',
      'reg delete',
      'netsh advfirewall',
      'netsh advfirewall',
      'netsh advfirewall',
      'netsh advfirewall',
    ]);
    expect(h.calls[1]![4]).toBe("Unregister-ScheduledTask -TaskName 'Telinha' -Confirm:$false");
    expect(h.calls[2]).toEqual(['schtasks', '/Delete', '/TN', 'Telinha', '/F']);
    // No tray.json: nothing to stop; the sign-in Run value goes either way.
    expect(h.calls[3]).toEqual([
      'reg',
      'delete',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v',
      'Telinha',
      '/f',
    ]);
    expect(h.calls.slice(4).map((c) => c[5])).toEqual([
      'name=Telinha LiveKit TCP',
      'name=Telinha LiveKit UDP',
      'name=Telinha HTTPS',
      'name=Telinha HTTP',
    ]);
    expect(h.files.has(`${HOME}\\service\\telinha-task.xml`)).toBe(true);
  });

  test('uninstall: a running tray icon is closed (taskkill, then /F when it stays) and its Run value removed', async () => {
    const h = host({ available: false, procs: new Map([[777, 'telinha-tray.exe']]) });
    h.files.set(
      `${HOME}\\data\\run\\tray.json`,
      JSON.stringify({ version: '0.7.0', pid: 777, startedAt: 1, exe: `${HOME}\\bin\\telinha-tray.exe` }),
    );
    const t0 = h.clock.t;
    await h.manager.uninstall({ firewall: false });
    expect(h.calls.slice(2)).toEqual([
      ['taskkill', '/PID', '777'],
      ['taskkill', '/F', '/PID', '777'],
      ['reg', 'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Telinha', '/f'],
    ]);
    expect(h.clock.t - t0).toBe(5000);
    expect(h.files.has(`${HOME}\\data\\run\\tray.json`)).toBe(false);
    expect(h.logs).toContain('service: tray icon stopped');
  });

  test('uninstall: tray trouble is logged, never fatal', async () => {
    const h = host({
      available: false,
      respond: (cmd) => (cmd[1] === 'delete' ? { code: 1, stderr: 'ERROR: Access is denied.' } : undefined),
    });
    await h.manager.uninstall({ firewall: false });
    expect(
      h.logs.some((l) =>
        l.startsWith('service: tray autostart: reg delete exited with code 1: ERROR: Access is denied.'),
      ),
    ).toBe(true);
  });

  test('restart is stop then start', async () => {
    const h = host({ available: false });
    await h.manager.restart();
    expect(h.names()).toEqual(['schtasks /End', 'schtasks /Run']);
  });

  test('start surfaces schtasks errors', async () => {
    const h = host({
      respond: (cmd) =>
        cmd[1] === '/Run' ? { code: 1, stderr: 'ERROR: The system cannot find the file specified.' } : undefined,
    });
    await expect(h.manager.start()).rejects.toThrow(
      'schtasks exited with code 1: ERROR: The system cannot find the file specified.',
    );
  });
});
