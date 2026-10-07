// The command line: `telinha [run] | setup | doctor | update | service <action>
// | tray <action> | --version | help [command]`. Global flags (--lang, --home, --yes) work
// anywhere; a command's own flags go after it. Exit codes: 0 ok, 1 error,
// 2 usage, 3 restart requested (run under `service run`); doctor exits 1 when
// a check failed.
import { existsSync } from 'node:fs';
import type { RunOptions } from '../run.ts';
import { versionLine } from '../version.ts';
import { buildContext, GLOBAL_FLAGS, parseArgs, UsageError, type CliContext, type ParsedArgs } from './args.ts';
import type { SetupUi } from './setup/ui.ts';
import { pickLocale, ts, type Key } from './strings.ts';

export type Command = 'run' | 'setup' | 'doctor' | 'update' | 'service' | 'tray';
const COMMANDS: readonly Command[] = ['run', 'setup', 'doctor', 'update', 'service', 'tray'];
const HELP: Record<Command, Key> = { run: 'helpRun', setup: 'helpSetup', doctor: 'helpDoctor', update: 'helpUpdate', service: 'helpService', tray: 'helpTray' };

type Runner = (args: ParsedArgs, ctx: CliContext) => Promise<number>;
type SetupModule = Pick<typeof import('./setup.ts'), 'run' | 'offerSetup'>;

export interface MainDeps {
  env?: Record<string, string | undefined>;
  stdinTty?: boolean;
  stdoutTty?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Tests replace the commands; default: the cli/*.ts modules, loaded on use. */
  commands?: Partial<Record<Exclude<Command, 'run'>, Runner>>;
  /** Default run.ts; resolves once the service is up (the process then lives on). */
  run?: (ctx: CliContext, o: RunOptions) => Promise<void>;
  /** `telinha` alone on a TTY without a telinha.env; null = declined. Default setup.ts offerSetup. */
  offerSetup?: (ctx: CliContext) => Promise<number | null>;
  /** After that offer, before the double-clicked console closes. Default term.ts waitForEnter. */
  waitForEnter?: (prompt: string) => Promise<void>;
  /** setup.ts, loaded on use; tests pass a recorder. */
  setup?: () => Promise<SetupModule>;
  /** The setup screens, loaded only on a terminal. Default loadSetupUi. */
  loadSetupUi?: () => Promise<SetupUi>;
}

interface Globals {
  command: string | null;
  /** Positionals after the command (help's topic). */
  positionals: string[];
  home?: string;
  lang?: string;
  yes: boolean;
  nonInteractive: boolean;
  help: boolean;
  version: boolean;
}

/**
 * The global flags and the command, without knowing the command's own flags
 * (each command parses the full argv itself). Only --home and --lang take a
 * value, so the first other bare word is the command.
 */
export function scanGlobals(argv: string[]): Globals {
  const g: Globals = { command: null, positionals: [], yes: false, nonInteractive: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break;
    const m = /^--(home|lang)(?:=(.*))?$/.exec(a);
    if (m) {
      const value = m[2] ?? argv[++i];
      if (m[1] === 'home') g.home = value;
      else g.lang = value;
      continue;
    }
    if (a === '--yes' || a === '-y') g.yes = true;
    else if (a === '--non-interactive') g.nonInteractive = true;
    else if (a === '--help' || a === '-h') g.help = true;
    else if (a === '--version' || a === '-v') g.version = true;
    else if (!a.startsWith('-') || a === '-') {
      if (g.command === null) g.command = a;
      else g.positionals.push(a);
    }
  }
  return g;
}

/** The setup screens. OpenTUI and Solid load only here, on a terminal: `run` and plain runs never pull them in. */
export async function loadSetupUi(): Promise<SetupUi> {
  await (await import('../tui/load.ts')).prepareTui();
  return (await import('../tui/setup/index.tsx')).setupUi;
}

const setupModule = async (deps: MainDeps): Promise<SetupModule> => (deps.setup ?? (() => import('./setup.ts')))();
/** The screens for setup on a terminal; nothing (the plain run) otherwise. */
const setupDeps = async (ctx: CliContext, deps: MainDeps) => (ctx.tty ? { ui: await (deps.loadSetupUi ?? loadSetupUi)() } : {});

async function defaultRunner(command: Exclude<Command, 'run'>, deps: MainDeps): Promise<Runner> {
  switch (command) {
    case 'setup': {
      const setup = await setupModule(deps);
      return async (args, ctx) => setup.run(args, ctx, await setupDeps(ctx, deps));
    }
    case 'doctor':
      return (await import('./doctor.ts')).run;
    case 'update':
      return (await import('./update.ts')).run;
    case 'service':
      return (await import('./service.ts')).run;
    case 'tray':
      return (await import('./tray.ts')).run;
  }
}

/** The exit code, or null for `run`: the service is up and the process lives on. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number | null> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const g = scanGlobals(argv);
  // Before any file is read: a broken --lang or --home must still get an answer.
  const early = pickLocale(env, g.lang && /^(en|pt)/i.test(g.lang) ? g.lang : undefined);

  if (g.version) {
    stdout(versionLine());
    return 0;
  }
  const helpTopic = g.command === 'help' ? g.positionals[0] ?? null : g.help ? g.command : undefined;
  if (helpTopic !== undefined) {
    if (helpTopic === null) stdout(ts(early, 'help'));
    else if ((COMMANDS as readonly string[]).includes(helpTopic)) stdout(ts(early, HELP[helpTopic as Command]));
    else {
      stderr(ts(early, 'unknownCommand', { cmd: helpTopic }));
      stderr(ts(early, 'usage'));
      return 2;
    }
    return 0;
  }

  const command = g.command ?? 'run';
  if (!(COMMANDS as readonly string[]).includes(command)) {
    stderr(ts(early, 'unknownCommand', { cmd: command }));
    stderr(ts(early, 'usage'));
    return 2;
  }

  let ctx: CliContext;
  try {
    ctx = buildContext({
      argv,
      flags: { home: g.home, lang: g.lang, yes: g.yes, 'non-interactive': g.nonInteractive },
      env,
      stdinTty: deps.stdinTty,
      stdoutTty: deps.stdoutTty,
      stdout,
      stderr,
    });
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr(e.message);
    stderr(ts(early, 'usage'));
    return 2;
  }

  if (command !== 'run') {
    const runner = deps.commands?.[command as Exclude<Command, 'run'>] ?? (await defaultRunner(command as Exclude<Command, 'run'>, deps));
    return runner({ flags: {}, positionals: [command, ...g.positionals], rest: [] }, ctx);
  }

  // run takes the global flags only.
  try {
    const parsed = parseArgs(argv, { flags: GLOBAL_FLAGS }, { locale: ctx.locale });
    const extra = parsed.positionals.filter((p, i) => !(i === 0 && p === 'run'));
    if (extra.length) throw new UsageError(ts(ctx.locale, 'unknownCommand', { cmd: extra[0]! }));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr(e.message);
    stderr(ts(ctx.locale, 'helpRun'));
    return 2;
  }

  // Double-clicked (no arguments, a console of its own) before anything was set
  // up: the wizard, not a config error in a window that closes at once.
  const bare = argv.length === 0 && ctx.tty;
  if (bare && !existsSync(ctx.envFile) && !ctx.env.PUBLIC_URL) {
    const offer = deps.offerSetup ?? (async (c: CliContext) => (await setupModule(deps)).offerSetup(c, await setupDeps(c, deps)));
    let code: number | null;
    try {
      code = await offer(ctx);
    } catch (e) {
      stderr(`telinha: ${e instanceof Error ? e.message : String(e)}`);
      code = 1;
    }
    // The window closes with the process: the next steps, the doctor summary
    // or the error must stay readable until the user is done with them.
    await (deps.waitForEnter ?? (await import('./term.ts')).waitForEnter)(ts(ctx.locale, 'pressEnter'));
    return code ?? 0;
  }
  await (deps.run ?? (await import('../run.ts')).run)(ctx, { pauseOnError: bare });
  return null;
}
