import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentType, loadStatic } from '../src/static.ts';
import { setup } from './helpers.ts';

describe('serving /sala/', () => {
  test('index.html: no-cache, html type', async () => {
    const s = setup();
    for (const p of ['/sala/', '/sala/index.html']) {
      const r = await s.get(p);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(r.headers.get('cache-control')).toBe('no-cache');
      expect(await r.text()).toContain('<div id="app"></div>');
    }
    // the query is the room, not part of the lookup
    expect((await s.get('/sala/?room=abcd')).status).toBe(200);
  });

  test('assets: immutable, typed', async () => {
    const s = setup();
    const js = await s.get('/sala/assets/index-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const css = await s.get('/sala/assets/index-abc123.css');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const svg = await s.get('/sala/favicon.svg');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('cache-control')).toBe('no-cache');
  });

  test('/sala/%2e%2e/ normalizes to / (redirect back), never a file', async () => {
    const r = await setup().get('/sala/%2e%2e/');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/sala/');
  });

  test('unknown files and traversal attempts -> 404', async () => {
    const s = setup();
    const paths = [
      '/sala/nope.js', '/sala/assets/', '/sala/room', '/sala/../package.json', '/sala/%2e%2e/package.json',
      '/sala/%2e%2e/x', '/sala/..%2fpackage.json', '/sala/assets/..%5c..%5cpackage.json', '/sala/\\..\\package.json',
      '/sala\\..\\package.json', '/sala//index.html', '/sala/INDEX.HTML', '/sala/index.html/',
    ];
    for (const p of paths) {
      const r = await s.handler(new Request(`https://tela.example.com${p}`));
      expect([p, r.status]).toEqual([p, 404]);
    }
  });

  test('POST is not served', async () => {
    const s = setup();
    expect((await s.handler(new Request('https://tela.example.com/sala/', { method: 'POST' }))).status).toBe(404);
  });
});

describe('loadStatic', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'telinha-static-'));
    mkdirSync(join(dir, 'assets', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<div id="app"></div>');
    writeFileSync(join(dir, 'assets', 'a.js'), 'x');
    writeFileSync(join(dir, 'assets', 'nested', 'b.woff2'), 'y');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('reads the tree recursively with URL keys', () => {
    const f = loadStatic(dir);
    expect([...f.keys()].sort()).toEqual(['/sala/', '/sala/assets/a.js', '/sala/assets/nested/b.woff2', '/sala/index.html']);
    expect(f.get('/sala/assets/nested/b.woff2')!.type).toBe('font/woff2');
  });

  test('missing dir or index.html throws', () => {
    expect(() => loadStatic(join(dir, 'missing'))).toThrow('WEB_DIR');
    expect(() => loadStatic(join(dir, 'assets'))).toThrow('no index.html');
  });
});

test('contentType', () => {
  expect(contentType('a.webmanifest')).toBe('application/manifest+json');
  expect(contentType('a.PNG')).toBe('image/png');
  expect(contentType('a.webp')).toBe('image/webp');
  expect(contentType('a.ico')).toBe('image/x-icon');
  expect(contentType('a.json')).toBe('application/json');
  expect(contentType('a.bin')).toBe('application/octet-stream');
});
