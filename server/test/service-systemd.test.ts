import { describe, expect, test } from 'bun:test';
import { ServiceInstallError, serviceManager, type ServiceFs, type SpawnFn, type SpawnOutcome } from '../src/service/index.ts';
import { parseShow, systemUnit, unitPath, unitQuote, userUnit } from '../src/service/systemd.ts';

const HOME = '/opt/telinha';
const EXE = '/opt/telinha/bin/telinha';
const paths = (home: string) => ({ home, bin: `${home}/bin`, config: `${home}/config`, data: `${home}/data`, run: `${home}/data/run`, logs: `${home}/logs`, logFile: `${home}/logs/telinha.log` });

type Responder = (cmd: string[]) => Partial<SpawnOutcome> | undefined;
function recorder(respond: Responder = () => undefined) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: '', stderr: '', ...respond(cmd) };
  };
  return { spawn, calls };
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

function host(o: { isRoot: boolean; user?: boolean; env?: Record<string, string>; respond?: Responder; available?: boolean; home?: string }) {
  const r = recorder(o.respond);
  const m = memFs();
  const logs: string[] = [];
  const manager = serviceManager({
    platform: 'linux', isRoot: o.isRoot, user: o.user, spawn: r.spawn, fs: m.fs, paths: paths(o.home ?? HOME),
    env: o.env ?? { HOME: '/home/ana', USER: 'ana' }, control: { available: async () => o.available ?? false, shutdown: async () => {} },
    log: (...a) => logs.push(a.join(' ')),
  })!;
  return { manager, calls: r.calls, files: m.files, logs };
}

describe('unit files', () => {
  test('system unit: dedicated user, the one capability caddy needs, hardening, Restart=on-failure', () => {
    const unit = systemUnit({ home: HOME, exe: EXE });
    expect(unit).toBe(`[Unit]
Description=Telinha screen share server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=telinha
Group=telinha
Environment="TELINHA_HOME=/opt/telinha"
WorkingDirectory=/opt/telinha
ExecStart="/opt/telinha/bin/telinha" service run
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=20
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths="/opt/telinha/bin" "/opt/telinha/data" "/opt/telinha/logs"
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`);
  });

  test('a custom home lands in Environment, WorkingDirectory, ExecStart and ReadWritePaths', () => {
    const unit = systemUnit({ home: '/srv/tl', exe: '/srv/tl/bin/telinha' });
    expect(unit).toContain('Environment="TELINHA_HOME=/srv/tl"\n');
    expect(unit).toContain('WorkingDirectory=/srv/tl\n');
    expect(unit).toContain('ExecStart="/srv/tl/bin/telinha" service run\n');
    expect(unit).toContain('ReadWritePaths="/srv/tl/bin" "/srv/tl/data" "/srv/tl/logs"\n');
  });

  test('spaces, quotes, % and $ in a home survive systemd\'s splitting, specifiers and expansion', () => {
    const home = '/srv/my tl/100%$x"y';
    const unit = userUnit({ home, exe: `${home}/bin/telinha` });
    expect(unit).toContain('Environment="TELINHA_HOME=/srv/my tl/100%%$x\\"y"\n');
    expect(unit).toContain('WorkingDirectory=/srv/my tl/100%%$x"y\n');
    expect(unit).toContain('ExecStart="/srv/my tl/100%%$$x\\"y/bin/telinha" service run\n');
    expect(unitQuote('a\\b')).toBe('"a\\\\b"');
  });

  test('user unit: no User/capabilities/ProtectSystem, default.target, Restart=on-failure', () => {
    const unit = userUnit({ home: '/home/ana/.local/share/telinha', exe: '/home/ana/.local/share/telinha/bin/telinha' });
    expect(unit).toContain('Restart=on-failure\n');
    expect(unit).toContain('WantedBy=default.target\n');
    expect(unit).toContain('ExecStart="/home/ana/.local/share/telinha/bin/telinha" service run\n');
    for (const absent of ['User=', 'Group=', 'AmbientCapabilities', 'CapabilityBoundingSet', 'ProtectSystem', 'Restart=always']) expect(unit).not.toContain(absent);
  });

  test('unit paths: system dir, else the XDG config dir', () => {
    expect(unitPath(false, {})).toBe('/etc/systemd/system/telinha.service');
    expect(unitPath(true, { HOME: '/home/ana' })).toBe('/home/ana/.config/systemd/user/telinha.service');
    expect(unitPath(true, { HOME: '/home/ana', XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/systemd/user/telinha.service');
  });

  test('setcap appears nowhere in the service code', async () => {
    for (const f of ['index.ts', 'systemd.ts', 'windows.ts', 'firewall.ts', 'runloop.ts']) {
      expect(await Bun.file(new URL(`../src/service/${f}`, import.meta.url)).text()).not.toContain('setcap');
    }
  });
});

describe('system unit install (root)', () => {
  test('creates the user when missing; root keeps the home and config/, the service user gets bin/ data/ logs/; unit, reload, enable --now', async () => {
    const h = host({ isRoot: true, respond: (cmd) => (cmd[0] === 'id' ? { code: 1, stderr: 'id: ‘telinha’: no such user' } : undefined) });
    const r = await h.manager.install({ firewall: false, exe: EXE, home: HOME, locale: 'en' });
    expect(h.manager.kind).toBe('systemd-system');
    expect(r).toEqual({ ok: true, steps: { task: 'ok', firewall: 'skipped', start: 'ok' }, hints: [] });
    expect(h.calls).toEqual([
      ['id', '-u', 'telinha'],
      ['useradd', '--system', '--home-dir', '/opt/telinha', '--no-create-home', '--shell', '/usr/sbin/nologin', 'telinha'],
      ['chown', 'root:root', '/opt/telinha'],
      ['chmod', '755', '/opt/telinha'],
      ['chown', '-hR', 'telinha:telinha', '/opt/telinha/bin', '/opt/telinha/data', '/opt/telinha/logs'],
      ['chown', '-h', 'root:telinha', '/opt/telinha/config'],
      ['chmod', '750', '/opt/telinha/config'],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', '--now', 'telinha'],
    ]);
    expect(h.files.get('/etc/systemd/system/telinha.service')).toBe(systemUnit({ home: HOME, exe: EXE }));
  });

  test('an existing user is kept; a failing enable is reported as the start step', async () => {
    const h = host({ isRoot: true, respond: (cmd) => (cmd[1] === 'enable' ? { code: 1, stderr: 'Failed to enable unit' } : undefined) });
    h.files.set('/opt/telinha/config/telinha.env', 'A=1');
    const err = (await h.manager.install({ firewall: true, exe: EXE, home: HOME, locale: 'en' }).catch((e: unknown) => e)) as ServiceInstallError;
    expect(err).toBeInstanceOf(ServiceInstallError);
    // Linux has no firewall step: it stays skipped even when asked.
    expect(err.result.steps).toEqual({ task: 'ok', firewall: 'skipped', start: 'failed: systemctl exited with code 1: Failed to enable unit' });
    expect(h.calls.map((c) => c[0])).toEqual(['id', 'chown', 'chmod', 'chown', 'chown', 'chmod', 'chown', 'chmod', 'systemctl', 'systemctl']);
    // telinha.env exists here: root:telinha 0640, readable by the service through its group.
    expect(h.calls.slice(6, 8)).toEqual([['chown', '-h', 'root:telinha', '/opt/telinha/config/telinha.env'], ['chmod', '640', '/opt/telinha/config/telinha.env']]);
  });

  test('status: is-active, is-enabled and show', async () => {
    const h = host({
      isRoot: true,
      respond: (cmd) => {
        if (cmd[1] === 'is-active') return { stdout: 'active\n' };
        if (cmd[1] === 'is-enabled') return { stdout: 'enabled\n' };
        if (cmd[1] === 'show') return { stdout: 'MainPID=1234\nActiveState=active\nSubState=running\n' };
        return undefined;
      },
    });
    h.files.set('/etc/systemd/system/telinha.service', 'unit');
    expect(await h.manager.status()).toEqual({ installed: true, running: true, enabled: true, detail: 'systemd-system: active (running), pid 1234, enabled' });
    expect(h.calls).toEqual([
      ['systemctl', 'is-active', 'telinha'],
      ['systemctl', 'is-enabled', 'telinha'],
      ['systemctl', 'show', '-p', 'MainPID', '-p', 'ActiveState', '-p', 'SubState', 'telinha'],
    ]);
  });

  test('status: stopped and disabled; not installed at all', async () => {
    const stopped = host({
      isRoot: true,
      respond: (cmd) => {
        if (cmd[1] === 'is-active') return { code: 3, stdout: 'inactive\n' };
        if (cmd[1] === 'is-enabled') return { code: 1, stdout: 'disabled\n' };
        if (cmd[1] === 'show') return { stdout: 'MainPID=0\nActiveState=inactive\nSubState=dead\n' };
        return undefined;
      },
    });
    stopped.files.set('/etc/systemd/system/telinha.service', 'unit');
    expect(await stopped.manager.status()).toEqual({ installed: true, running: false, enabled: false, detail: 'systemd-system: inactive (dead), not enabled' });

    const none = host({ isRoot: true, available: true, respond: (cmd) => (cmd[1] === 'is-enabled' ? { code: 1, stderr: 'Failed to get unit file state for telinha.service: No such file or directory' } : { code: 3, stdout: 'inactive' }) });
    expect(await none.manager.status()).toEqual({ installed: false, running: true, enabled: false, detail: 'no unit at /etc/systemd/system/telinha.service; telinha running (console)' });
  });

  test('start/stop/restart map to systemctl; uninstall disables, removes the unit, reloads', async () => {
    const h = host({ isRoot: true });
    h.files.set('/etc/systemd/system/telinha.service', 'unit');
    await h.manager.start();
    await h.manager.stop();
    await h.manager.restart();
    await h.manager.uninstall({ firewall: true });
    expect(h.calls).toEqual([
      ['systemctl', 'start', 'telinha'],
      ['systemctl', 'stop', 'telinha'],
      ['systemctl', 'restart', 'telinha'],
      ['systemctl', 'disable', '--now', 'telinha'],
      ['systemctl', 'daemon-reload'],
    ]);
    expect(h.files.has('/etc/systemd/system/telinha.service')).toBe(false);
  });

  test('parseShow', () => {
    expect(parseShow('MainPID=12\nActiveState=active\nDescription=a=b\n\n')).toEqual({ MainPID: '12', ActiveState: 'active', Description: 'a=b' });
  });
});

describe('user unit', () => {
  const home = '/home/ana/.local/share/telinha';

  test('not root (or --user): unit under ~/.config, systemctl --user, lingering enabled', async () => {
    const h = host({ isRoot: false, home });
    const r = await h.manager.install({ firewall: false, exe: `${home}/bin/telinha`, home, locale: 'pt-BR' });
    expect(h.manager.kind).toBe('systemd-user');
    expect(r).toEqual({ ok: true, steps: { task: 'ok', firewall: 'skipped', start: 'ok' }, hints: [] });
    expect(h.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'telinha'],
      ['loginctl', 'enable-linger', 'ana'],
    ]);
    expect(h.files.get('/home/ana/.config/systemd/user/telinha.service')).toBe(userUnit({ home, exe: `${home}/bin/telinha` }));
  });

  test('linger failing becomes a hint, not an error', async () => {
    const h = host({ isRoot: false, home, respond: (cmd) => (cmd[0] === 'loginctl' ? { code: 1, stderr: 'Could not enable linger: Access denied' } : undefined) });
    const r = await h.manager.install({ firewall: false, exe: `${home}/bin/telinha`, home, locale: 'en' });
    expect(r.ok).toBe(true);
    expect(r.hints).toEqual(['sudo loginctl enable-linger ana']);
  });

  test('root with --user still installs a user unit; the user name falls back to id -un', async () => {
    const h = host({ isRoot: true, user: true, home, env: { HOME: '/root' }, respond: (cmd) => (cmd[0] === 'id' ? { stdout: 'root\n' } : undefined) });
    await h.manager.install({ firewall: false, exe: `${home}/bin/telinha`, home, locale: 'en' });
    expect(h.manager.kind).toBe('systemd-user');
    expect(h.calls.map((c) => c.join(' '))).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now telinha', 'id -un', 'loginctl enable-linger root']);
    expect(h.files.has('/root/.config/systemd/user/telinha.service')).toBe(true);
  });

  test('status and uninstall use --user', async () => {
    const h = host({ isRoot: false, home, respond: (cmd) => (cmd[1] === '--user' && cmd[2] === 'is-active' ? { stdout: 'activating' } : undefined) });
    await h.manager.status();
    await h.manager.uninstall({ firewall: false });
    expect(h.calls.map((c) => c.slice(0, 3).join(' '))).toEqual([
      'systemctl --user is-active', 'systemctl --user is-enabled', 'systemctl --user show', 'systemctl --user disable', 'systemctl --user daemon-reload',
    ]);
  });
});

describe('serviceManager()', () => {
  const p = paths(HOME);
  test('kinds per host', () => {
    expect(serviceManager({ platform: 'win32', isRoot: false, paths: p, env: {} })?.kind).toBe('windows-task');
    expect(serviceManager({ platform: 'linux', isRoot: true, paths: p, env: {} })?.kind).toBe('systemd-system');
    expect(serviceManager({ platform: 'linux', isRoot: true, user: true, paths: p, env: {} })?.kind).toBe('systemd-user');
    expect(serviceManager({ platform: 'linux', isRoot: false, paths: p, env: {} })?.kind).toBe('systemd-user');
    expect(serviceManager({ platform: 'darwin', isRoot: false, paths: p, env: {} })).toBeNull();
    expect(serviceManager({ platform: 'freebsd', isRoot: true, paths: p, env: {} })).toBeNull();
  });
});
