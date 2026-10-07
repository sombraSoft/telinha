import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// mise.toml is where a Bun or Go bump starts, and every other copy must follow
// it. Renovate's "bun" and "go" groups move them in one PR, but each copy comes
// from its own registry (GitHub, Docker Hub, npm), which publish at different
// times, so a group PR can arrive with a copy left behind. This test turns that
// PR red, which keeps it from automerging until the missing copy lands.

const ROOT = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const tools = (Bun.TOML.parse(read('mise.toml')) as { tools: Record<string, unknown> }).tools;
const dockerfile = read('Dockerfile');

// The version an image tag names: 1.4.2 from 1.4.2-alpine, with or without a
// digest after it. A tag without a full x.y.z (1.4-alpine, latest) gives the
// whole tag back, so it fails the comparison instead of passing loosely.
function tagVersion(tag: string): string {
  return /^(\d+\.\d+\.\d+)(?:-|$)/.exec(tag)?.[1] ?? tag;
}

// Every `<image>:<tag>` in the Dockerfile, keyed by line so a diff names the copy.
function dockerImages(image: string): Record<string, string> {
  const found: Record<string, string> = {};
  dockerfile.split('\n').forEach((line, i) => {
    const m = new RegExp(`\\b${image}:([^\\s@]+)`).exec(line);
    if (m) found[`Dockerfile:${i + 1} ${image}`] = tagVersion(m[1]!);
  });
  return found;
}

// Expects every copy to equal the mise.toml version. Comparing records rather
// than one value at a time makes a failure print every copy that drifted.
function expectAll(copies: Record<string, string>, version: string) {
  expect(Object.keys(copies)).not.toBeEmpty();
  expect(copies).toEqual(Object.fromEntries(Object.keys(copies).map((k) => [k, version])));
}

describe('mise.toml pins exact versions', () => {
  // A fuzzy selector (bun = "1.4") would leave nothing exact to compare the
  // other copies against; mise.lock would hold the real version instead.
  test.each(['bun', 'go'])('%s', (tool) => {
    expect(tools[tool]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('every Bun copy equals mise.toml', () => {
  const bun = tools.bun as string;
  const root = JSON.parse(read('package.json')) as { packageManager: string; workspaces: string[] };

  test('the Bun running this test', () => {
    // CI installs Bun from the same pins, and mise puts this one on PATH, so a
    // mismatch here means a stale Bun outside mise ran the tests.
    expect(Bun.version).toBe(bun);
  });

  test('packageManager in package.json', () => {
    // A corepack-style "+sha512..." suffix is not part of the version.
    expect(root.packageManager.replace(/\+.*$/, '')).toBe(`bun@${bun}`);
  });

  test('the oven/bun images in the Dockerfile', () => {
    expectAll(dockerImages('oven/bun'), bun);
  });

  test('@types/bun in every package.json', () => {
    // Compared as exact strings, so a caret range fails too. A caret names only
    // a floor: bun.lock may resolve newer types inside it (lock file
    // maintenance does exactly that), and those types would offer APIs the
    // pinned Bun lacks. An exact version makes bun.lock resolve that release,
    // and CI's --frozen-lockfile keeps it there.
    const copies: Record<string, string> = {};
    for (const dir of ['.', ...root.workspaces]) {
      const pkg = JSON.parse(read(join(dir, 'package.json'))) as Record<string, Record<string, string> | undefined>;
      const range = pkg.dependencies?.['@types/bun'] ?? pkg.devDependencies?.['@types/bun'];
      if (range !== undefined) copies[`${dir}/package.json`] = range;
    }
    expectAll(copies, bun);
  });

});

describe('every Go copy equals mise.toml', () => {
  test('the golang images in the Dockerfile', () => {
    // The image builds Caddy with this Go, so the Caddy a developer builds
    // locally comes from the same compiler as the shipped one.
    expectAll(dockerImages('golang'), tools.go as string);
  });
});
