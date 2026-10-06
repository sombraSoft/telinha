// Drift tests: the hand-written reference (src/data/reference.ts) against the
// server code, locale parity of the pages, and a lint over every page so prose
// cannot name an env key, flag or command that does not exist.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { KNOWN_KEYS, loadConfig } from '../../server/src/config.ts';
import { GLOBAL_FLAGS, SECRET_FLAGS, type FlagDef } from '../../server/src/cli/args.ts';
import { SETUP_FLAGS } from '../../server/src/cli/setup.ts';
import { DOCTOR_FLAGS } from '../../server/src/cli/doctor.ts';
import { UPDATE_FLAGS } from '../../server/src/cli/update.ts';
import { ACTIONS, serviceSpec } from '../../server/src/cli/service.ts';
import { TRAY_ACTIONS } from '../../server/src/cli/tray.ts';
import { CHECKS } from '../../server/src/doctor/checks.ts';
import {
  CONFIG_KEYS, DOCTOR_CHECK_DOCS, DOCTOR_FLAG_DOCS, GLOBAL_FLAG_DOCS, SECTION_TITLES, SERVICE_ACTION_DOCS, SERVICE_FLAG_DOCS,
  SETUP_FLAG_DOCS, TRAY_ACTION_DOCS, UPDATE_FLAG_DOCS,
} from '../src/data/reference.ts';
import { BASE_ENV, derivedCommands, generate } from './generate.ts';

const docsDir = join(import.meta.dir, '..');
const contentDir = join(docsDir, 'src', 'content', 'docs');
const repoDir = join(docsDir, '..');

// Read as text, not imported: the strict scripts tsconfig has no allowJs, so
// importing the .mjs config would fail the typecheck (TS7016).
function readAstroConfig(): string {
  return readFileSync(join(docsDir, 'astro.config.mjs'), 'utf8');
}

/** Folder names of the non-root locales (e.g. ['pt-br']) from the `locales` block. */
// Kept identical to the copy in workspace.test.ts (not imported: that would run its tests here too).
function localeFolders(config: string = readAstroConfig()): string[] {
  const block = /locales:\s*\{([\s\S]*?)\n\s*\},/.exec(config)?.[1] ?? '';
  return [...block.matchAll(/^\s*'?([a-z][a-z0-9-]*)'?:\s*\{[^}]*\blang:/gm)].map((m) => m[1]!).filter((k) => k !== 'root');
}

/** Every .md/.mdx under dir, as forward-slash paths relative to it. */
function pages(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.mdx?$/.test(name)) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

const readPage = (rel: string) => readFileSync(join(contentDir, rel), 'utf8').replace(/\r\n/g, '\n');

const sortedKeys = (o: Record<string, unknown>) => Object.keys(o).sort();
const same = (a: Iterable<string>, b: Iterable<string>) => expect([...a].sort()).toEqual([...b].sort());

describe('reference tables match the code', () => {
  test('one row per telinha.env key', () => {
    same(Object.keys(CONFIG_KEYS), KNOWN_KEYS);
    const sections = new Set(Object.keys(SECTION_TITLES));
    for (const [key, doc] of Object.entries(CONFIG_KEYS)) expect(sections.has(doc.section), `${key}: unknown section ${doc.section}`).toBe(true);
  });

  test('every probed default equals the shown default', () => {
    const c = loadConfig(BASE_ENV, { compiled: true });
    for (const [key, doc] of Object.entries(CONFIG_KEYS)) {
      if (!doc.probe) continue;
      // A probe without a plain-string default has nothing to be compared with.
      expect(typeof doc.default, `${key}: a probe needs a string default`).toBe('string');
      expect(String(doc.probe(c)), `${key}: default drifted`).toBe(doc.default as string);
    }
  });

  test('required keys are the ones loadConfig refuses to start without', () => {
    for (const key of KNOWN_KEYS) {
      const { [key]: _, ...env } = BASE_ENV;
      const load = () => loadConfig(env, { compiled: true });
      if (CONFIG_KEYS[key]!.required === 'yes') expect(load, key).toThrow(`missing env ${key}`);
      else expect(load, key).not.toThrow();
    }
  });

  test('flag docs cover exactly the parser specs', () => {
    same(Object.keys(GLOBAL_FLAG_DOCS), Object.keys(GLOBAL_FLAGS));
    same(Object.keys(SETUP_FLAG_DOCS), Object.keys(SETUP_FLAGS));
    same(Object.keys(DOCTOR_FLAG_DOCS), Object.keys(DOCTOR_FLAGS));
    same(Object.keys(UPDATE_FLAG_DOCS), Object.keys(UPDATE_FLAGS));
    const service = new Set([...Object.keys(serviceSpec('linux').flags), ...Object.keys(serviceSpec('win32').flags)]);
    for (const g of Object.keys(GLOBAL_FLAGS)) service.delete(g);
    same(Object.keys(SERVICE_FLAG_DOCS), service);
    same(Object.keys(SERVICE_ACTION_DOCS), ACTIONS);
    same(Object.keys(TRAY_ACTION_DOCS), TRAY_ACTIONS);
  });

  test('doctor check docs are the checks, in order', () => {
    expect(Object.keys(DOCTOR_CHECK_DOCS)).toEqual(CHECKS.map((c) => c.id));
  });

  test('the generator runs and reflects the code', () => {
    const g = generate();
    expect(g.knownKeys).toEqual([...KNOWN_KEYS]);
    expect(g.doctor.checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
    expect(g.cli.commands).toEqual(derivedCommands());
    expect(sortedKeys(g.cli.service.linux)).toEqual(sortedKeys(SERVICE_FLAG_DOCS));
    expect(g.cli.tray.actions).toEqual([...TRAY_ACTIONS]);
    for (const locale of ['en', 'pt-BR'] as const) expect(g.cli.help[locale].helpTray).toStartWith(locale === 'en' ? 'Usage: telinha tray' : 'Uso: telinha tray');
    expect(g.versions.livekit).toMatch(/^\d+\.\d+\.\d+$/);
    expect(g.versions.caddy.version).toMatch(/^\d+\.\d+\.\d+$/);
    // PinnedVersions names the modules; the home certificate needs this one.
    expect(Object.keys(g.versions.caddy.modules)).toContain('github.com/caddy-dns/duckdns');
    expect(g.paths.windows.home).toBe('%LOCALAPPDATA%\\Telinha');
    expect(g.paths.linuxRoot.home).toBe('/opt/telinha');
    expect(g.paths.linuxUser.home).toBe('~/.local/share/telinha');
  });

  test('the commands derived from the help strings are the ones main.ts dispatches', () => {
    // COMMANDS is private to main.ts and server/ is not edited for the docs, so the literal is read as text.
    const main = readFileSync(join(repoDir, 'server', 'src', 'cli', 'main.ts'), 'utf8');
    const literal = /^const COMMANDS\b[^=\n]*=\s*\[([^\]]*)\]/m.exec(main)?.[1];
    expect(literal, 'const COMMANDS line not found in main.ts').toBeDefined();
    const commands = [...literal!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    expect(commands.length).toBeGreaterThan(0);
    same(derivedCommands(), commands);
  });
});

describe('every page exists in every language', () => {
  const locales = localeFolders();
  const all = pages(contentDir);
  const underLocale = (p: string) => locales.find((l) => p.startsWith(`${l}/`));
  const root = all.filter((p) => !underLocale(p));

  test('the locale folders come from astro.config.mjs', () => {
    expect(locales.length).toBeGreaterThan(0);
    expect(locales).toContain('pt-br');
  });

  test.each(locales)('%s has the same pages as the root locale', (locale) => {
    const own = all.filter((p) => p.startsWith(`${locale}/`)).map((p) => p.slice(locale.length + 1));
    const problems = [
      ...root.filter((p) => !own.includes(p)).map((p) => `${locale}/${p} is missing (root page ${p} has no translation)`),
      ...own.filter((p) => !root.includes(p)).map((p) => `${p} is missing (only ${locale}/${p} exists)`),
    ];
    expect(problems).toEqual([]);
  });

  test('every page has a title and a description', () => {
    const problems: string[] = [];
    for (const p of all) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(readPage(p))?.[1] ?? '';
      if (!/^title:\s*\S/m.test(fm)) problems.push(`${p}: no title`);
      if (!/^description:\s*\S/m.test(fm)) problems.push(`${p}: no description`);
    }
    expect(problems).toEqual([]);
  });
});

/**
 * Real variables that are not telinha.env keys but may appear in code spans:
 * the installers' and telinha-update's tunables, what children receive, and
 * the shell's own. A writer who needs another real one adds it here.
 */
const LINT_ALLOW_ENV = new Set([
  'TELINHA_VERSION', 'TELINHA_NO_SETUP', 'TELINHA_INSTALL', 'TELINHA_BASE_URL', // install.ps1 / install.sh
  'TELINHA_DIR', 'TELINHA_DIGEST', 'MAX_DEFER_HOURS', 'VERIFY_ATTESTATION', 'ALLOW_UNVERIFIED', // telinha-update
  'LIVEKIT_KEYS', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', // what the children get
  'TELINHA_THEME', 'NO_COLOR', // the terminal screens' colours
  'LOCALAPPDATA', 'GH_TOKEN', 'GITHUB_TOKEN', 'CAP_NET_BIND_SERVICE', 'SHA256SUMS', 'LC_ALL', 'LC_MESSAGES', 'NODE_ENV',
]);
const ENV_LIKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

const flagKind = (d: FlagDef) => (typeof d === 'string' ? d : d.type);
const ALL_FLAGS: Record<string, FlagDef> = {
  ...GLOBAL_FLAGS, ...SETUP_FLAGS, ...DOCTOR_FLAGS, ...UPDATE_FLAGS, ...serviceSpec('linux').flags, ...serviceSpec('win32').flags,
};
const SECRET_FILE_FLAGS = new Set(Object.keys(SECRET_FLAGS).map((f) => `${f}-file`));
const COMMANDS = new Set([...derivedCommands(), 'help']);

function knownFlag(flag: string): boolean {
  const name = flag.slice(2);
  if (Object.hasOwn(ALL_FLAGS, name) || SECRET_FILE_FLAGS.has(name)) return true;
  const base = name.startsWith('no-') ? name.slice(3) : null;
  return base !== null && Object.hasOwn(ALL_FLAGS, base) && flagKind(ALL_FLAGS[base]!) === 'boolean';
}

/** Problems in one `telinha ...` command text (a code span or a fenced line). */
function lintCommand(text: string): string[] {
  const out: string[] = [];
  if (text.startsWith('telinha-update')) {
    for (const f of text.match(/--[a-z][a-z-]*/g) ?? []) if (f !== '--now') out.push(`telinha-update has no ${f}`);
    return out;
  }
  const cmd = /^telinha ([a-z][a-z-]*)/.exec(text)?.[1];
  if (cmd && !COMMANDS.has(cmd)) out.push(`unknown command "telinha ${cmd}"`);
  for (const f of text.match(/--[a-z][a-z-]*/g) ?? []) if (!knownFlag(f)) out.push(`unknown flag ${f}`);
  return out;
}

describe('pages name only things that exist', () => {
  const all = pages(contentDir);

  test.each(all)('%s', (page) => {
    const problems: string[] = [];
    const text = readPage(page);
    const fenced: string[] = [];
    // Fenced blocks go first: their backticks would otherwise pair up with inline spans.
    const prose = text.replace(/^(`{3,})[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm, (_, __, body: string) => {
      fenced.push(body);
      return '';
    });
    for (const [, span] of prose.matchAll(/`([^`\n]+)`/g)) {
      const s = span!.trim();
      if (ENV_LIKE.test(s) && !KNOWN_KEYS.has(s) && !LINT_ALLOW_ENV.has(s)) problems.push(`\`${s}\` is not a telinha.env key (add it to LINT_ALLOW_ENV if it is a real variable)`);
      if (/^telinha[ -]/.test(s)) problems.push(...lintCommand(s).map((m) => `\`${s}\`: ${m}`));
    }
    for (const line of fenced.join('\n').split('\n')) {
      const t = line.trim().replace(/^sudo /, '');
      if (/^telinha[ -]/.test(t)) problems.push(...lintCommand(t).map((m) => `code line "${line.trim()}": ${m}`));
    }
    // Astro `base`: an internal link must carry /telinha/ (Starlight prefixes only the links it generates).
    for (const [, href] of [...prose.matchAll(/\]\(([^)\s]+)\)/g), ...prose.matchAll(/\bhref="([^"]+)"/g)]) {
      if (href!.startsWith('http') || href!.startsWith('#') || href!.startsWith('mailto:')) continue;
      if (href!.includes('/telinha/') && !href!.startsWith('/telinha/')) problems.push(`link ${href} must start with /telinha/`);
      else if (href!.startsWith('/') && !href!.startsWith('/telinha/')) problems.push(`link ${href} is missing the /telinha/ base`);
    }
    expect(problems).toEqual([]);
  });
});
