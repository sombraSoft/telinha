import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkMessage, prTitleTypes } from './commit-msg.ts';

const ROOT = resolve(import.meta.dir, '..');
const TYPES = prTitleTypes(readFileSync(join(ROOT, '.github/workflows/pr-title.yml'), 'utf8'));

describe('prTitleTypes', () => {
  test('reads the types the pr-title check accepts', () => {
    expect(TYPES).toEqual(['feat', 'fix', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']);
  });
});

describe('checkMessage', () => {
  test.each([
    'feat: card says who is in the room',
    'fix(deps): update bun to 1.4.3',
    'feat!: drop the old room links',
    'chore(main)!: release 1.0.0',
    'ci: time out hung jobs\n\nA body after a blank line.',
    '# Please enter the commit message\nbuild: lint with Biome',
    "Merge branch 'main' into build/lefthook",
    'Revert "feat: something"',
    'fixup! feat: card says who is in the room',
    'squash! fix: something',
    '',
  ])('accepts %p', (message) => {
    expect(checkMessage(message, TYPES)).toBeNull();
  });

  test.each([
    'stuff',
    'Feat: capitalised type',
    'feature: not a type',
    'feat:no space',
    'feat: ',
    'feat(): empty scope',
    'wip',
  ])('rejects %p', (message) => {
    expect(checkMessage(message, TYPES)).toContain('is not a Conventional Commit');
  });
});
