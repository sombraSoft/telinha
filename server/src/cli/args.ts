// Argument parsing and the context every subcommand runs with. No dependency:
// boolean / string / string[] flags, --k=v, --k v, --no-k, positionals, `--`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile, mergeEnv } from '../envfile.ts';
import { homeOfExe, type Paths, resolvePaths } from '../paths.ts';
import { isCompiled, version } from '../version.ts';
import { type Locale, pickLocale, ts } from './strings.ts';

type Env = Record<string, string | undefined>;

export type FlagKind = 'boolean' | 'string' | 'string[]';
export type FlagDef = FlagKind | { type: FlagKind; short?: string };
export interface ArgSpec {
  /** Long names without dashes, e.g. 'non-interactive'. */
  flags: Record<string, FlagDef>;
  /** Flags refused with a usage message (name -> message). The secret flags are always refused. */
  rejected?: Record<string, string>;
}
type KindOf<D> = D extends FlagKind ? D : D extends { type: infer K } ? K : never;
type ValueOf<K> = K extends 'boolean' ? boolean : K extends 'string' ? string : string[];
export type Flags<S extends ArgSpec> = { -readonly [N in keyof S['flags']]?: ValueOf<KindOf<S['flags'][N]>> };
export interface ParsedArgs<S extends ArgSpec = ArgSpec> {
  flags: Flags<S>;
  positionals: string[];
  /** Everything after `--`. */
  rest: string[];
}

/** Bad command line: the message is for the user, the exit code is 2. */
export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Flags every command accepts. */
export const GLOBAL_FLAGS = {
  lang: 'string',
  home: 'string',
  yes: { type: 'boolean', short: 'y' },
  'non-interactive': 'boolean',
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const satisfies Record<string, FlagDef>;

/** Secret-taking flags that must never exist (argv shows in the process list): flag -> telinha.env key. */
export const SECRET_FLAGS: Readonly<Record<string, string>> = {
  'discord-token': 'DISCORD_TOKEN',
  'client-secret': 'DISCORD_CLIENT_SECRET',
  'tunnel-token': 'TUNNEL_TOKEN',
  'duckdns-token': 'DUCKDNS_TOKEN',
  'livekit-secret': 'LIVEKIT_API_SECRET',
};

export function secretRejections(locale: Locale = 'en'): Record<string, string> {
  return Object.fromEntries(
    Object.entries(SECRET_FLAGS).map(([flag, env]) => [flag, ts(locale, 'argSecretFlag', { flag: `--${flag}`, env })]),
  );
}

const kindOf = (d: FlagDef): FlagKind => (typeof d === 'string' ? d : d.type);

export function parseArgs<const S extends ArgSpec>(
  argv: string[],
  spec: S,
  o: { locale?: Locale } = {},
): ParsedArgs<S> {
  const locale = o.locale ?? 'en';
  const rejected = { ...secretRejections(locale), ...spec.rejected };
  const shorts = new Map<string, string>();
  for (const [name, d] of Object.entries(spec.flags)) if (typeof d !== 'string' && d.short) shorts.set(d.short, name);
  const flags: Record<string, boolean | string | string[]> = {};
  const positionals: string[] = [];
  let rest: string[] = [];

  const set = (name: string, flag: string, inline: string | undefined, next: () => string | undefined) => {
    if (Object.hasOwn(rejected, name)) throw new UsageError(rejected[name]!);
    const def = spec.flags[name];
    if (def === undefined) throw new UsageError(ts(locale, 'argUnknownFlag', { flag }));
    const kind = kindOf(def);
    if (kind === 'boolean') {
      if (inline === undefined) flags[name] = true;
      else if (/^(true|1|yes|on)$/i.test(inline)) flags[name] = true;
      else if (/^(false|0|no|off)$/i.test(inline)) flags[name] = false;
      else throw new UsageError(ts(locale, 'argBadBoolean', { flag, value: inline }));
      return;
    }
    const value = inline ?? next();
    if (value === undefined) throw new UsageError(ts(locale, 'argNeedsValue', { flag }));
    if (kind === 'string') flags[name] = value;
    else flags[name] = [...((flags[name] as string[] | undefined) ?? []), value];
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // A value may be "-" (stdin) but never another flag.
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('-') && v !== '-')) return undefined;
      i++;
      return v;
    };
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const inline = eq < 0 ? undefined : a.slice(eq + 1);
      const base = name.slice(3);
      // --no-x: an explicit flag of that name wins, else it turns boolean x off.
      if (
        name.startsWith('no-') &&
        !Object.hasOwn(spec.flags, name) &&
        Object.hasOwn(spec.flags, base) &&
        kindOf(spec.flags[base]!) === 'boolean'
      ) {
        if (inline !== undefined) throw new UsageError(ts(locale, 'argNoValue', { flag: `--${name}` }));
        flags[base] = false;
        continue;
      }
      set(name, `--${name}`, inline, next);
    } else if (a.startsWith('-') && a !== '-') {
      const name = shorts.get(a.slice(1));
      if (!name) throw new UsageError(ts(locale, 'argUnknownFlag', { flag: a }));
      set(name, a, undefined, next);
    } else {
      positionals.push(a);
    }
  }
  return { flags: flags as Flags<S>, positionals, rest };
}

export interface CliContext {
  /** Raw user args. */
  argv: string[];
  env: Env;
  /** resolvePaths(env) honouring --home. */
  paths: Paths;
  /** TELINHA_ENV || <config>/telinha.env */
  envFile: string;
  locale: Locale;
  /** stdin AND stdout are TTYs and not --non-interactive. */
  tty: boolean;
  /** --yes: accept defaults. */
  yes: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** The `bun build --compile` binary (BUILD_VERSION defined). */
  compiled: boolean;
  version: string;
}

export interface ContextOptions {
  argv: string[];
  flags?: { home?: string; lang?: string; yes?: boolean; 'non-interactive'?: boolean };
  env?: Env;
  stdinTty?: boolean;
  stdoutTty?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export function buildContext(o: ContextOptions): CliContext {
  const flags = o.flags ?? {};
  // --home is TELINHA_HOME for everything downstream (loadConfig reads env too).
  const env: Env = flags.home ? { ...(o.env ?? process.env), TELINHA_HOME: flags.home } : { ...(o.env ?? process.env) };
  if (flags.lang !== undefined && !/^(en|pt)([-_][A-Za-z]+)?$/i.test(flags.lang)) {
    throw new UsageError(ts(pickLocale(env), 'argBadLang', { value: flags.lang }));
  }
  // An installed binary (<home>/bin/telinha) belongs to that home: a custom
  // TELINHA_HOME is honoured in every new terminal without the variable.
  if (!env.TELINHA_HOME && isCompiled()) {
    const home = homeOfExe(process.execPath);
    if (home) env.TELINHA_HOME = home;
  }
  const paths = resolvePaths(env);
  const envFile = env.TELINHA_ENV || join(paths.config, 'telinha.env');
  let fileVars: Record<string, string> = {};
  try {
    fileVars = loadEnvFile(envFile)?.vars ?? {};
  } catch {
    // Unreadable file: the language falls back; the command reports the file itself.
  }
  const stdinTty = o.stdinTty ?? !!process.stdin.isTTY;
  const stdoutTty = o.stdoutTty ?? !!process.stdout.isTTY;
  return {
    argv: o.argv,
    env,
    paths,
    envFile,
    locale: pickLocale(mergeEnv(fileVars, env), flags.lang),
    tty: stdinTty && stdoutTty && !flags['non-interactive'],
    yes: !!flags.yes,
    stdout: o.stdout ?? ((line) => console.log(line)),
    stderr: o.stderr ?? ((line) => console.error(line)),
    compiled: isCompiled(),
    version: version(),
  };
}

const readStdin = async () => await Bun.stdin.text();

/**
 * A secret from the environment (its telinha.env name), else from a file given
 * as --<name>-file (`-` = stdin); trimmed like telinha.env values. null when
 * neither is set or the source is empty.
 */
export async function readSecretSource(o: {
  env?: string | undefined;
  file?: string | undefined;
  stdin?: () => Promise<string>;
}): Promise<string | null> {
  const clean = (s: string) => s.replace(/^﻿/, '').trim() || null;
  if (o.env) return clean(o.env);
  if (!o.file) return null;
  const text = o.file === '-' ? await (o.stdin ?? readStdin)() : await readFile(o.file, 'utf8');
  return clean(text);
}

/** Stdin can hold one secret per run: refuse a second `-`. */
export function assertOneStdin(files: (string | undefined)[], locale: Locale = 'en'): void {
  if (files.filter((f) => f === '-').length > 1) throw new UsageError(ts(locale, 'argOneStdin'));
}
