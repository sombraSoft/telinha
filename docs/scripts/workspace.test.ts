import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const docsDir = join(import.meta.dir, '..');

// Read as text, not imported: the strict scripts tsconfig has no allowJs, so
// importing the .mjs config would fail the typecheck (TS7016).
export function readAstroConfig(): string {
  return readFileSync(join(docsDir, 'astro.config.mjs'), 'utf8');
}

/** Folder names of the non-root locales (e.g. ['pt-br']) from the `locales` block. */
// Kept identical to the copy in reference.test.ts: quoted or bare keys, `root` skipped.
export function localeFolders(config: string = readAstroConfig()): string[] {
  const block = /locales:\s*\{([\s\S]*?)\n\s*\},/.exec(config)?.[1] ?? '';
  return [...block.matchAll(/^\s*'?([a-z][a-z0-9-]*)'?:\s*\{[^}]*\blang:/gm)].map((m) => m[1]!).filter((k) => k !== 'root');
}

describe('docs workspace', () => {
  const config = readAstroConfig();

  test('serves the site under the GitHub Pages project path', () => {
    expect(config).toMatch(/site:\s*'https:\/\/sombrasoft\.github\.io'/);
    expect(config).toMatch(/base:\s*'\/telinha'/);
  });

  test('has a pt-BR locale with its own content folder', () => {
    expect(config).toMatch(/'pt-br':\s*\{[^}]*lang:\s*'pt-BR'/);
    expect(localeFolders(config)).toContain('pt-br');
    expect(existsSync(join(docsDir, 'src', 'content', 'docs', 'pt-br'))).toBe(true);
  });
});
