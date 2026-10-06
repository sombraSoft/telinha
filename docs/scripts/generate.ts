// Writes src/data/generated.json before every astro dev/build: the config keys
// and their defaults, the CLI specs and help texts, the doctor checks, the
// pinned helper versions, the install paths and the firewall rule names, all
// read from the server code so the reference pages cannot drift from it.
// Pure extraction: the prose lives in src/data/reference.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_KEYS, loadConfig } from '../../server/src/config.ts';
import { GLOBAL_FLAGS, SECRET_FLAGS, type FlagDef, type FlagKind } from '../../server/src/cli/args.ts';
import { SETUP_FLAGS } from '../../server/src/cli/setup.ts';
import { DOCTOR_FLAGS } from '../../server/src/cli/doctor.ts';
import { UPDATE_FLAGS } from '../../server/src/cli/update.ts';
import { ACTIONS, serviceSpec } from '../../server/src/cli/service.ts';
import { dicts } from '../../server/src/cli/strings.ts';
import { CHECKS, checkTitle } from '../../server/src/doctor/checks.ts';
import { RULE_NAMES } from '../../server/src/service/firewall.ts';
import { resolvePaths, type Paths } from '../../server/src/paths.ts';
import versions from '../../versions.json' with { type: 'json' };
import pkg from '../../package.json' with { type: 'json' };
import { CONFIG_KEYS } from '../src/data/reference.ts';

export type Locale = 'en' | 'pt-BR';
export type HelpKey = 'help' | 'helpRun' | 'helpSetup' | 'helpDoctor' | 'helpUpdate' | 'helpService';
export interface FlagSpec { kind: FlagKind; short?: string }
export interface Generated {
  version: string;
  /** In the code's order (the tables keep it). */
  knownKeys: string[];
  /** key -> default as text, from the reference probes run against BASE_ENV. */
  defaults: Record<string, string>;
  cli: {
    commands: string[];
    global: Record<string, FlagSpec>;
    setup: Record<string, FlagSpec>;
    doctor: Record<string, FlagSpec>;
    update: Record<string, FlagSpec>;
    /** Without the global flags; `user` is a switch on Linux and takes the account on Windows. */
    service: { actions: string[]; linux: Record<string, FlagSpec>; windows: Record<string, FlagSpec> };
    /** flag -> telinha.env key. */
    secretFlags: Record<string, string>;
    help: Record<Locale, Record<HelpKey, string>>;
  };
  doctor: { checks: { id: string; title: Record<Locale, string> }[] };
  /** caddy is a build recipe (versions.json): Caddy plus the modules compiled into it. */
  versions: { livekit: string; caddy: { version: string; xcaddy: string; modules: Record<string, string> }; cloudflared: string };
  /** Default layouts with LOCALAPPDATA / HOME left as placeholders. */
  paths: { windows: Paths; linuxRoot: Paths; linuxUser: Paths };
  firewallRules: string[];
}

const LOCALES: readonly Locale[] = ['en', 'pt-BR'];

/** A complete production env: the required keys with dummy values, so every default can be probed. */
export const BASE_ENV: Record<string, string> = {
  DISCORD_TOKEN: 'docs-fixture-token', // gitleaks:allow
  DISCORD_CLIENT_ID: '100000000000000000',
  DISCORD_CLIENT_SECRET: 'docs-fixture-client-secret', // gitleaks:allow
  GUILD_ID: '200000000000000000',
  ROLE_ID: '300000000000000000',
  CHANNEL_IDS: '400000000000000000',
  PUBLIC_URL: 'https://telinha.example.com',
  COOKIE_SECRET: 'docs-fixture-cookie-secret', // gitleaks:allow
  LIVEKIT_API_KEY: 'docs-fixture-key',
  LIVEKIT_API_SECRET: 'docs-fixture-livekit-secret', // gitleaks:allow
};

/** `run, setup, ...` from the per-command help strings; main.ts keeps its list private and the test pins the two together. */
export function derivedCommands(): string[] {
  return Object.keys(dicts.en).filter((k) => /^help[A-Z]/.test(k)).map((k) => k.slice(4).toLowerCase());
}

function specOf(flags: Record<string, FlagDef>, skip: Record<string, unknown> = {}): Record<string, FlagSpec> {
  const out: Record<string, FlagSpec> = {};
  for (const [name, def] of Object.entries(flags)) {
    if (Object.hasOwn(skip, name)) continue;
    out[name] = typeof def === 'string' ? { kind: def } : def.short ? { kind: def.type, short: def.short } : { kind: def.type };
  }
  return out;
}

export function generate(): Generated {
  // compiled: the native binary's defaults (AUTO_UPDATE=on); the tables say what Docker and source do instead.
  const config = loadConfig(BASE_ENV, { compiled: true });
  const defaults: Record<string, string> = {};
  for (const [key, doc] of Object.entries(CONFIG_KEYS)) if (doc.probe) defaults[key] = String(doc.probe(config));

  const help = {} as Record<Locale, Record<HelpKey, string>>;
  for (const locale of LOCALES) {
    const d = dicts[locale];
    help[locale] = { help: d.help, helpRun: d.helpRun, helpSetup: d.helpSetup, helpDoctor: d.helpDoctor, helpUpdate: d.helpUpdate, helpService: d.helpService };
  }

  return {
    version: pkg.version,
    knownKeys: [...KNOWN_KEYS],
    defaults,
    cli: {
      commands: derivedCommands(),
      global: specOf(GLOBAL_FLAGS),
      setup: specOf(SETUP_FLAGS),
      doctor: specOf(DOCTOR_FLAGS),
      update: specOf(UPDATE_FLAGS),
      service: {
        actions: [...ACTIONS],
        linux: specOf(serviceSpec('linux').flags, GLOBAL_FLAGS),
        windows: specOf(serviceSpec('win32').flags, GLOBAL_FLAGS),
      },
      secretFlags: { ...SECRET_FLAGS },
      help,
    },
    doctor: {
      checks: CHECKS.map((c) => ({ id: c.id, title: { en: checkTitle(c.id, 'en'), 'pt-BR': checkTitle(c.id, 'pt-BR') } })),
    },
    versions: {
      livekit: versions.livekit.version,
      caddy: { version: versions.caddy.version, xcaddy: versions.caddy.xcaddy, modules: { ...versions.caddy.modules } },
      cloudflared: versions.cloudflared.version,
    },
    paths: {
      windows: resolvePaths({ LOCALAPPDATA: '%LOCALAPPDATA%' }, 'win32', false),
      linuxRoot: resolvePaths({}, 'linux', true),
      linuxUser: resolvePaths({ HOME: '~' }, 'linux', false),
    },
    firewallRules: [...RULE_NAMES],
  };
}

function main(): void {
  const dir = join(import.meta.dir, '..', 'src', 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'generated.json'), `${JSON.stringify(generate(), null, 2)}\n`);
}

if (import.meta.main) main();
