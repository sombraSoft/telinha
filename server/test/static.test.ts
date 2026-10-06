import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentType, loadStatic, staticFromEntries } from '../src/static.ts';
import { ENTRIES, setup } from './helpers.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('serving /r/ (members)', () => {
  test('index.html: no-cache, html type', async () => {
    const s = setup();
    for (const p of ['/r/', '/r/index.html']) {
      const r = await s.member(p);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(r.headers.get('cache-control')).toBe('no-cache');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await r.text()).toContain('<div id="app"></div>');
    }
  });

  test('/r/<code>: the page for any valid room code, open or not', async () => {
    const s = setup();
    for (const code of ['lamo-futi', 'bafo-kiru', 'lamofu-tibare', 'tuge-dosa']) {
      const r = await s.member(`/r/${code}`);
      expect([code, r.status, r.headers.get('cache-control')]).toEqual([code, 200, 'no-cache']);
      expect(await r.text()).toContain('<div id="app"></div>');
    }
    // the query is not part of the lookup
    expect((await s.member('/r/bafo-kiru?x=1')).status).toBe(200);
  });

  test('HEAD: headers, no body', async () => {
    const s = setup();
    const r = await s.call(new Request('https://telinha.example.com/r/bafo-kiru', { method: 'HEAD', headers: { cookie: s.sessionCookie() } }));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await r.text()).toBe('');
  });

  test('assets: immutable, typed', async () => {
    const s = setup();
    const js = await s.member('/r/assets/index-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const css = await s.member('/r/assets/index-abc123.css');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const svg = await s.member('/r/favicon.svg');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('cache-control')).toBe('no-cache');
    expect(await svg.text()).toBe('<svg/>');
  });

  test('an exact file wins over a room code of the same name', async () => {
    const files = staticFromEntries([...ENTRIES, ['boba-tusa', enc('not the page')]], { command: 'telinha' });
    const s = setup({ files });
    const file = await s.member('/r/boba-tusa');
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(await file.text()).toBe('not the page');
    expect(await (await s.member('/r/bobo-tusa')).text()).toContain('<div id="app"></div>');
  });

  test('/r/%2e%2e/ normalizes to / (redirect back), never a file', async () => {
    const r = await setup().member('/r/%2e%2e/');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/r/');
  });

  test('unknown files, bad codes, deeper paths and traversal attempts -> 404', async () => {
    const s = setup();
    const paths = [
      '/r/nope.js', '/r/assets/', '/r/abc', '/r/abcd', '/r/Room_1-x', '/r/q3Jx_9aZ-kP2w', `/r/${'a'.repeat(40)}`,
      '/r/bada-kemo-pisu', '/r/Bafo-kiru', '/r/bafo-kiruba', '/r/robots', '/r/ab%20cd', '/r/ab.cd', '/r/bafo-kiru/', '/r/bafo-kiru/x',
      '/r/../package.json', '/r/%2e%2e/package.json', '/r/%2e%2e/x', '/r/..%2fpackage.json', '/r/assets/..%5c..%5cpackage.json',
      '/r/\\..\\package.json', '/r\\..\\package.json', '/r//index.html', '/r/INDEX.HTML', '/r/index.html/',
    ];
    for (const p of paths) {
      const r = await s.call(new Request(`https://telinha.example.com${p}`, { headers: { cookie: s.sessionCookie() } }));
      expect([p, r.status]).toEqual([p, 404]);
    }
  });

  test('POST is not served', async () => {
    const s = setup();
    const r = await s.call(new Request('https://telinha.example.com/r/', { method: 'POST', headers: { cookie: s.sessionCookie() } }));
    expect(r.status).toBe(404);
  });
});

describe('the command name in index.html', () => {
  const page = (html: string, command = 'telinha') =>
    dec(staticFromEntries([['index.html', enc(html)]], { command }).get('/r/index.html')!.body);

  test('a meta tag right before </head>', () => {
    expect(page('<html><head><title>T</title></head><body></body></html>', 'tela'))
      .toBe('<html><head><title>T</title><meta name="telinha-command" content="tela"></head><body></body></html>');
    expect(page('<HEAD></HEAD>', 'tela')).toBe('<HEAD><meta name="telinha-command" content="tela"></HEAD>');
  });

  test('escaped', () => {
    expect(page('<head></head>', 'a"><script>&'))
      .toBe('<head><meta name="telinha-command" content="a&#34;&#62;&#60;script&#62;&#38;"></head>');
  });

  test('only index.html is touched; /r/ is the same page', () => {
    const f = staticFromEntries([['index.html', enc('<head></head>')], ['other.html', enc('<head></head>')]], { command: 'x' });
    expect(dec(f.get('/r/other.html')!.body)).toBe('<head></head>');
    expect(f.get('/r/')).toBe(f.get('/r/index.html')!);
  });

  test('no </head> -> throws', () => {
    expect(() => page('<div id="app"></div>')).toThrow('</head>');
  });

  test('served with COMMAND_NAME', async () => {
    const s = setup({ command: 'tela' });
    expect(await (await s.member('/r/bafo-kiru')).text()).toContain('<meta name="telinha-command" content="tela"></head>');
    expect(await (await setup().member('/r/')).text()).toContain('<meta name="telinha-command" content="telinha"></head>');
  });
});

describe('loadStatic', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'telinha-static-'));
    mkdirSync(join(dir, 'assets', 'nested'), { recursive: true });
    mkdirSync(join(dir, 'nohead'));
    writeFileSync(join(dir, 'index.html'), '<head></head><div id="app"></div>');
    writeFileSync(join(dir, 'assets', 'a.js'), 'x');
    writeFileSync(join(dir, 'assets', 'nested', 'b.woff2'), 'y');
    writeFileSync(join(dir, 'nohead', 'index.html'), '<div id="app"></div>');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('reads the tree recursively with URL keys under /r/', () => {
    const f = loadStatic(dir, { command: 'tela' });
    expect([...f.keys()].sort()).toEqual([
      '/r/', '/r/assets/a.js', '/r/assets/nested/b.woff2', '/r/index.html', '/r/nohead/index.html',
    ]);
    expect(f.get('/r/assets/nested/b.woff2')!.type).toBe('font/woff2');
    expect(dec(f.get('/r/')!.body)).toBe('<head><meta name="telinha-command" content="tela"></head><div id="app"></div>');
  });

  test('missing dir, index.html or </head> throws', () => {
    expect(() => loadStatic(join(dir, 'missing'), { command: 'x' })).toThrow('WEB_DIR');
    expect(() => loadStatic(join(dir, 'assets'), { command: 'x' })).toThrow('no index.html');
    expect(() => loadStatic(join(dir, 'nohead'), { command: 'x' })).toThrow(/WEB_DIR .*nohead.*<\/head>/);
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
