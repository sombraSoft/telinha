// `telinha service <action>`: install | uninstall | start | stop | restart |
// status through the host's service manager, and `run`, the supervised loop
// the manager itself starts.
import { posix, win32 } from 'node:path';
import { createLogger } from '../log.ts';
import { exeName } from '../release.ts';
import {
  serviceManager as defaultServiceManager,
  type InstallResult,
  NotElevatedError,
  type ServiceFs,
  ServiceInstallError,
  type ServiceManager,
  type SpawnFn,
} from '../service/index.ts';
import { runLoop as defaultRunLoop } from '../service/runloop.ts';
import { type ArgSpec, type CliContext, GLOBAL_FLAGS, type ParsedArgs, parseArgs, UsageError } from './args.ts';
import type { ControlClient } from './control.ts';
import { defineStrings, ts } from './strings.ts';

export const ACTIONS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'run'] as const;
export type Action = (typeof ACTIONS)[number];

/** `--user` takes the account on Windows (DOMAIN\user) and is a switch (user unit) on Linux. */
export function serviceSpec(platform: NodeJS.Platform = process.platform) {
  return {
    flags: {
      ...GLOBAL_FLAGS,
      firewall: 'boolean',
      user: platform === 'win32' ? 'string' : 'boolean',
      sid: 'string',
      result: 'string',
      'log-file': 'string',
    },
  } as const satisfies ArgSpec;
}

const t = defineStrings(
  {
    unknownAction: 'unknown service action {action}',
    unsupported: 'no service manager for this system ({platform}); run telinha in a console instead',
    needsBinary: 'service install needs the native Telinha binary (bun/Docker runs are not installed as a service)',
    notElevated: 'service install needs an administrator terminal. Open one and run: {cmd}',
    stepOk: '{step}: ok',
    stepFailed: '{step}: {error}',
    stepSkipped: '{step}: skipped',
    stepTask: 'service registration',
    stepFirewall: 'firewall rules',
    stepStart: 'start',
    hint: 'Still to do by hand: {cmd}',
    lingerWhy: 'Without it Telinha stops whenever you log out of this machine (an SSH session ending counts).',
    installed: 'Telinha runs as a service now ({kind}).',
    uninstalled: 'Service removed; the files in {home} stay.',
    started: 'Service started.',
    stopped: 'Service stopped.',
    restarted: 'Service restarted.',
    statusLine: 'Service ({kind}): {installed}, {running}, {enabled}',
    installedYes: 'installed',
    installedNo: 'not installed',
    runningYes: 'running',
    runningNo: 'not running',
    enabledYes: 'starts at boot',
    enabledNo: 'does not start at boot',
    failed: 'service {action} failed: {error}',
  },
  {
    unknownAction: 'ação de service desconhecida {action}',
    unsupported: 'sem gerenciador de serviço pra este sistema ({platform}); rode a telinha num console',
    needsBinary: 'service install precisa do binário nativo da Telinha (rodando com bun/Docker não vira serviço)',
    notElevated: 'service install precisa de um terminal como administrador. Abra um e rode: {cmd}',
    stepOk: '{step}: ok',
    stepFailed: '{step}: {error}',
    stepSkipped: '{step}: pulado',
    stepTask: 'registro do serviço',
    stepFirewall: 'regras de firewall',
    stepStart: 'início',
    hint: 'Falta fazer na mão: {cmd}',
    lingerWhy: 'Sem isso a Telinha para sempre que você sai desta máquina (o fim de uma sessão SSH conta).',
    installed: 'A Telinha agora roda como serviço ({kind}).',
    uninstalled: 'Serviço removido; os arquivos em {home} ficam.',
    started: 'Serviço iniciado.',
    stopped: 'Serviço parado.',
    restarted: 'Serviço reiniciado.',
    statusLine: 'Serviço ({kind}): {installed}, {running}, {enabled}',
    installedYes: 'instalado',
    installedNo: 'não instalado',
    runningYes: 'rodando',
    runningNo: 'parado',
    enabledYes: 'inicia com o sistema',
    enabledNo: 'não inicia com o sistema',
    failed: 'service {action} falhou: {error}',
  },
);

export interface ServiceCliDeps {
  /** Replaces serviceManager() (tests); null = unsupported host. */
  manager?: ServiceManager | null;
  spawn?: SpawnFn;
  fs?: ServiceFs;
  control?: Pick<ControlClient, 'available' | 'shutdown'>;
  runLoop?: typeof defaultRunLoop;
  platform?: NodeJS.Platform;
  isRoot?: boolean;
  /** The running interpreter/binary and script (dev: bun + index.ts). */
  execPath?: string;
  script?: string;
  pid?: number;
}

type Flags = { firewall?: boolean; user?: string | boolean; sid?: string; result?: string; 'log-file'?: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function printInstall(ctx: CliContext, r: InstallResult): void {
  const names = { task: 'stepTask', firewall: 'stepFirewall', start: 'stepStart' } as const;
  for (const [key, outcome] of Object.entries(r.steps) as [keyof InstallResult['steps'], string][]) {
    const step = t(ctx.locale, names[key]);
    if (outcome === 'ok') ctx.stdout(t(ctx.locale, 'stepOk', { step }));
    else if (outcome === 'skipped') ctx.stdout(t(ctx.locale, 'stepSkipped', { step }));
    else ctx.stdout(t(ctx.locale, 'stepFailed', { step, error: outcome.replace(/^failed: /, '') }));
  }
  for (const h of r.hints) {
    ctx.stdout(t(ctx.locale, 'hint', { cmd: h }));
    if (h.includes('enable-linger')) ctx.stdout(t(ctx.locale, 'lingerWhy'));
  }
}

export async function run(_args: ParsedArgs, ctx: CliContext, deps: ServiceCliDeps = {}): Promise<number> {
  const platform = deps.platform ?? process.platform;
  const spec = serviceSpec(platform);
  let parsed: { flags: Flags; positionals: string[] };
  try {
    parsed = parseArgs(ctx.argv, spec, { locale: ctx.locale });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    ctx.stderr(e.message);
    ctx.stderr(ts(ctx.locale, 'helpService'));
    return 2;
  }
  const { flags } = parsed;
  const positionals = parsed.positionals[0] === 'service' ? parsed.positionals.slice(1) : parsed.positionals;
  const action = positionals[0];
  if (!action) {
    ctx.stderr(ts(ctx.locale, 'helpService'));
    return 2;
  }
  if (!(ACTIONS as readonly string[]).includes(action)) {
    ctx.stderr(t(ctx.locale, 'unknownAction', { action }));
    ctx.stderr(ts(ctx.locale, 'helpService'));
    return 2;
  }
  const { paths } = ctx;
  // Joined with the target platform's rules: the paths are that platform's.
  const join = (platform === 'win32' ? win32 : posix).join;
  const exe = join(paths.bin, exeName(platform));

  if (action === 'run') {
    const execPath = deps.execPath ?? process.execPath;
    const cmd = ctx.compiled
      ? [exe, 'run', '--home', paths.home]
      : [execPath, deps.script ?? process.argv[1] ?? '', 'run', '--home', paths.home];
    // Windows has no journal: the file is the log. Linux writes to stdout (the journal) unless asked for a file.
    const file = flags['log-file'] ?? (platform === 'win32' ? paths.logFile : undefined);
    const logger = createLogger({ stdout: true, file });
    try {
      return await (deps.runLoop ?? defaultRunLoop)({
        cmd,
        env: { ...ctx.env, TELINHA_HOME: paths.home },
        paths,
        platform,
        pid: deps.pid,
        log: logger.log,
      });
    } finally {
      logger.close();
    }
  }

  const manager =
    deps.manager !== undefined
      ? deps.manager
      : defaultServiceManager({
          platform,
          isRoot: deps.isRoot ?? process.getuid?.() === 0,
          user: platform !== 'win32' && flags.user === true,
          spawn: deps.spawn,
          fs: deps.fs,
          paths,
          envFile: ctx.envFile,
          env: ctx.env,
          control: deps.control,
          log: (...a) => ctx.stderr(a.map(String).join(' ')),
        });
  if (!manager) {
    ctx.stderr(t(ctx.locale, 'unsupported', { platform }));
    return 1;
  }

  try {
    switch (action as Exclude<Action, 'run'>) {
      case 'install': {
        if (!ctx.compiled) {
          ctx.stderr(t(ctx.locale, 'needsBinary'));
          return 1;
        }
        const r = await manager.install({
          firewall: !!flags.firewall,
          exe,
          home: paths.home,
          locale: ctx.locale,
          user: typeof flags.user === 'string' ? flags.user : undefined,
          sid: flags.sid,
          resultFile: flags.result,
        });
        printInstall(ctx, r);
        ctx.stdout(t(ctx.locale, 'installed', { kind: manager.kind }));
        return 0;
      }
      case 'uninstall':
        await manager.uninstall({ firewall: !!flags.firewall });
        ctx.stdout(t(ctx.locale, 'uninstalled', { home: paths.home }));
        return 0;
      case 'start':
        await manager.start();
        ctx.stdout(t(ctx.locale, 'started'));
        return 0;
      case 'stop':
        await manager.stop();
        ctx.stdout(t(ctx.locale, 'stopped'));
        return 0;
      case 'restart':
        await manager.restart();
        ctx.stdout(t(ctx.locale, 'restarted'));
        return 0;
      case 'status': {
        const s = await manager.status();
        ctx.stdout(
          t(ctx.locale, 'statusLine', {
            kind: manager.kind,
            installed: t(ctx.locale, s.installed ? 'installedYes' : 'installedNo'),
            running: t(ctx.locale, s.running ? 'runningYes' : 'runningNo'),
            enabled: t(ctx.locale, s.enabled ? 'enabledYes' : 'enabledNo'),
          }),
        );
        ctx.stdout(`  ${s.detail}`);
        return s.installed && s.running ? 0 : 1;
      }
    }
  } catch (e) {
    if (e instanceof ServiceInstallError) {
      printInstall(ctx, e.result);
      if (e.result.error) ctx.stderr(t(ctx.locale, 'failed', { action, error: e.result.error }));
      return 1;
    }
    if (e instanceof NotElevatedError) {
      ctx.stderr(t(ctx.locale, 'notElevated', { cmd: elevateCommand(e.exe, ctx.argv) }));
      return 1;
    }
    ctx.stderr(t(ctx.locale, 'failed', { action, error: message(e) }));
    return 1;
  }
}

/** The same command line, elevated: a PowerShell one-liner the user can paste into any terminal. */
export function elevateCommand(exe: string, argv: string[]): string {
  const list = argv.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
  return `powershell -Command "Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${list} -Verb RunAs"`;
}
