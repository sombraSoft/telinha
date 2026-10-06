// Linux: a systemd unit running `telinha service run`. As root a system unit
// under a dedicated `telinha` user with the one capability caddy needs for
// ports 80/443 (a process capability: it survives every binary download);
// otherwise a user unit, kept alive after logout by lingering. Root itself runs
// a root-owned copy of the CLI (install.sh puts it in /usr/local/lib/telinha),
// never bin/telinha, which the service user can replace.
import { posix } from 'node:path';
import { attempt, must, ServiceInstallError, type InstallResult, type ServiceDeps, type ServiceManager } from './index.ts';

// Linux paths whatever the host (tests run on Windows too).
const { dirname, join } = posix;

export const UNIT_NAME = 'telinha';
export const SERVICE_USER = 'telinha';

/**
 * Lets a user unit's caddy bind 80/443: one sudo step that survives every
 * binary update and rollback (a file capability would not: bins.ts replaces
 * caddy on each version bump). Run with `sh -c`; setup and doctor both offer it.
 */
export const SYSCTL_SCRIPT = 'printf "net.ipv4.ip_unprivileged_port_start=80\\n" > /etc/sysctl.d/50-telinha.conf && sysctl --system';

/**
 * A unit-file value in double quotes: C escapes for \ and ", %% for a literal
 * % (systemd specifiers) and, in Exec lines, $$ for a literal $ (variable
 * expansion). Unquoted, a space would split the path and a % expand.
 */
export const unitQuote = (s: string, o: { exec?: boolean } = {}): string => {
  const v = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  return `"${o.exec ? v.replace(/\$/g, '$$$$') : v}"`;
};
/** WorkingDirectory= takes the rest of the line as is: only specifiers need escaping. */
const unitPathValue = (s: string): string => s.replace(/%/g, '%%');

/** What the system unit's service user may write: its binary (self-update), data and logs. Not the home or config/. */
export const serviceWritable = (home: string): string[] => [join(home, 'bin'), join(home, 'data'), join(home, 'logs')];

export function systemUnit(o: { home: string; exe: string; writable?: string[] }): string {
  const writable = o.writable ?? serviceWritable(o.home);
  return `[Unit]
Description=Telinha screen share server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
Environment=${unitQuote(`TELINHA_HOME=${o.home}`)}
WorkingDirectory=${unitPathValue(o.home)}
ExecStart=${unitQuote(o.exe, { exec: true })} service run
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=20
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${writable.map((p) => unitQuote(p)).join(' ')}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

export function userUnit(o: { home: string; exe: string }): string {
  return `[Unit]
Description=Telinha screen share server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
Environment=${unitQuote(`TELINHA_HOME=${o.home}`)}
WorkingDirectory=${unitPathValue(o.home)}
ExecStart=${unitQuote(o.exe, { exec: true })} service run
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

/** Where the unit file lives: /etc/systemd/system, or the user's XDG config dir. */
export function unitPath(user: boolean, env: Record<string, string | undefined>): string {
  if (!user) return `/etc/systemd/system/${UNIT_NAME}.service`;
  const config = env.XDG_CONFIG_HOME || join(env.HOME || '/root', '.config');
  return join(config, 'systemd', 'user', `${UNIT_NAME}.service`);
}

/** `systemctl show -p A -p B` output: KEY=value per line. */
export function parseShow(out: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) o[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return o;
}

export function createSystemd(d: ServiceDeps, user: boolean): ServiceManager {
  const { spawn, fs, log } = d;
  const unit = unitPath(user, d.env);
  const sc = (...a: string[]) => ['systemctl', ...(user ? ['--user'] : []), ...a];
  const run = async (cmd: string[]) => must(cmd, await spawn(cmd));

  async function userName(): Promise<string> {
    const fromEnv = d.env.USER || d.env.LOGNAME;
    if (fromEnv) return fromEnv;
    return (await spawn(['id', '-un'])).stdout.trim();
  }

  async function writeUnit(o: { home: string; exe: string }): Promise<void> {
    await fs.mkdir(dirname(unit));
    await fs.writeFile(unit, user ? userUnit(o) : systemUnit(o));
    await run(sc('daemon-reload'));
  }

  const manager: ServiceManager = {
    kind: user ? 'systemd-user' : 'systemd-system',

    async install(o) {
      const result: InstallResult = { ok: false, steps: { task: 'skipped', firewall: 'skipped', start: 'skipped' }, hints: [] };
      result.steps.task = await attempt(async () => {
        if (!user) {
          if ((await spawn(['id', '-u', SERVICE_USER])).code !== 0) {
            await run(['useradd', '--system', '--home-dir', o.home, '--no-create-home', '--shell', '/usr/sbin/nologin', SERVICE_USER]);
          }
          // The home and config/ stay root's: root writes telinha.env there (setup)
          // and must never write into, or run anything from, a directory the
          // service user controls. That user owns only what it writes: bin/ (it
          // updates itself), data/ and logs/. config/ is readable by its group.
          const writable = serviceWritable(o.home);
          for (const dir of writable) await fs.mkdir(dir);
          await run(['chown', 'root:root', o.home]);
          await run(['chmod', '755', o.home]);
          await run(['chown', '-hR', `${SERVICE_USER}:${SERVICE_USER}`, ...writable]);
          const config = join(o.home, 'config');
          await fs.mkdir(config);
          await run(['chown', '-h', `root:${SERVICE_USER}`, config]);
          await run(['chmod', '750', config]);
          const envFile = join(config, 'telinha.env');
          if (await fs.exists(envFile)) {
            await run(['chown', '-h', `root:${SERVICE_USER}`, envFile]);
            await run(['chmod', '640', envFile]);
          }
        }
        await writeUnit(o);
      });
      if (result.steps.task === 'ok') {
        result.steps.start = await attempt(async () => void (await run(sc('enable', '--now', UNIT_NAME))));
        if (user) {
          // Without lingering the user manager (and the service) stops at logout; this may prompt for authentication.
          const name = await userName();
          const linger = await spawn(['loginctl', 'enable-linger', name]);
          if (linger.code !== 0) result.hints.push(`sudo loginctl enable-linger ${name}`);
        }
      }
      result.ok = Object.values(result.steps).every((s) => s === 'ok' || s === 'skipped');
      if (!result.ok) throw new ServiceInstallError(result);
      return result;
    },

    async uninstall() {
      const r = await spawn(sc('disable', '--now', UNIT_NAME));
      if (r.code !== 0) log(`service: systemctl disable: ${(r.stderr || r.stdout).trim()}`);
      await fs.rm(unit);
      await run(sc('daemon-reload'));
    },

    start: () => run(sc('start', UNIT_NAME)).then(() => {}),
    stop: () => run(sc('stop', UNIT_NAME)).then(() => {}),
    restart: () => run(sc('restart', UNIT_NAME)).then(() => {}),

    async status() {
      const installed = await fs.exists(unit);
      const active = (await spawn(sc('is-active', UNIT_NAME))).stdout.trim();
      const enabled = (await spawn(sc('is-enabled', UNIT_NAME))).stdout.trim() === 'enabled';
      const show = parseShow((await spawn(sc('show', '-p', 'MainPID', '-p', 'ActiveState', '-p', 'SubState', UNIT_NAME))).stdout);
      const running = active === 'active' || (await d.control.available());
      const state = show.ActiveState ? `${show.ActiveState}${show.SubState ? ` (${show.SubState})` : ''}` : active || 'unknown';
      const pid = show.MainPID && show.MainPID !== '0' ? `, pid ${show.MainPID}` : '';
      const detail = installed
        ? `${manager.kind}: ${state}${pid}, ${enabled ? 'enabled' : 'not enabled'}`
        : `no unit at ${unit}; telinha ${running ? 'running (console)' : 'not running'}`;
      return { installed, running, enabled, detail };
    },
  };
  return manager;
}
