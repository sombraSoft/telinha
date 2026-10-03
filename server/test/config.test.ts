import { describe, expect, test } from 'bun:test';
import { loadConfig, parseListen } from '../src/config.ts';
import { PROD_ENV } from './helpers.ts';

const DEV_ENV = { DEV_USER: '1:Dev', PUBLIC_URL: 'http://localhost:5173', COOKIE_SECRET: 'x', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' };

describe('loadConfig', () => {
  test('production defaults', () => {
    const c = loadConfig(PROD_ENV);
    expect(c.dev).toBeNull();
    expect(c.publicUrl).toBe('https://tela.example.com');
    expect(c.channelIds).toEqual(['300', '301']);
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8081);
    expect(c.sessionSeconds).toBe(7 * 86400);
    expect(c.roleTtlMs).toBe(300_000);
    expect(c.livekitUrl).toBe('wss://tela.example.com/livekit');
    expect(c.secureCookies).toBe(true);
    expect(c.groupName).toBeUndefined();
    expect(c.webDir.replaceAll('\\', '/')).toEndWith('web/dist/');
    expect(c.livekitApiUrl).toBe('http://127.0.0.1:7880');
    expect(c.dataDir.replaceAll('\\', '/')).toEndWith('.cache/data/');
    expect(c.closeEmptySeconds).toBe(300);
    expect(c.pollSeconds).toBe(5);
  });

  test('optional overrides', () => {
    const c = loadConfig({
      ...PROD_ENV, GROUP_NAME: 'Crew', LIVEKIT_PUBLIC_URL: 'wss://lk.example.com', WEB_DIR: '/srv/web',
      LISTEN: '[::1]:9000', SESSION_DAYS: '1', ROLE_CACHE_SECONDS: '10',
      LIVEKIT_API_URL: 'http://10.0.0.5:7880/', DATA_DIR: '/data', CLOSE_EMPTY_SECONDS: '4', POLL_SECONDS: '1',
    });
    expect(c.livekitApiUrl).toBe('http://10.0.0.5:7880');
    expect(c.dataDir).toBe('/data');
    expect(c.closeEmptySeconds).toBe(4);
    expect(c.pollSeconds).toBe(1);
    expect(c.groupName).toBe('Crew');
    expect(c.livekitUrl).toBe('wss://lk.example.com');
    expect(c.webDir).toBe('/srv/web');
    expect([c.host, c.port]).toEqual(['::1', 9000]);
    expect(c.sessionSeconds).toBe(86400);
    expect(c.roleTtlMs).toBe(10_000);
  });

  test('missing required env', () => {
    for (const k of Object.keys(PROD_ENV)) {
      const env: Record<string, string> = { ...PROD_ENV };
      delete env[k];
      expect(() => loadConfig(env)).toThrow(`missing env ${k}`);
    }
    expect(() => loadConfig({ ...PROD_ENV, COOKIE_SECRET: '' })).toThrow('missing env COOKIE_SECRET');
  });

  test('bad numbers and LISTEN', () => {
    expect(() => loadConfig({ ...PROD_ENV, SESSION_DAYS: 'x' })).toThrow('bad SESSION_DAYS');
    expect(() => loadConfig({ ...PROD_ENV, CLOSE_EMPTY_SECONDS: '0' })).toThrow('bad CLOSE_EMPTY_SECONDS');
    expect(() => loadConfig({ ...PROD_ENV, POLL_SECONDS: '-1' })).toThrow('bad POLL_SECONDS');
    expect(() => loadConfig({ ...PROD_ENV, LISTEN: '8081' })).toThrow('bad LISTEN');
  });
});

describe('DEV_USER guard', () => {
  test('dev mode: Discord vars not required, cookies not Secure', () => {
    const c = loadConfig(DEV_ENV);
    expect(c.dev).toEqual({ id: '1', name: 'Dev' });
    expect(c.secureCookies).toBe(false);
    expect(c.channelIds).toEqual([]);
    expect(c.livekitUrl).toBe('ws://localhost:5173/livekit');
  });

  test('accepts 127.0.0.1 and ::1 / localhost listen hosts', () => {
    expect(loadConfig({ ...DEV_ENV, PUBLIC_URL: 'http://127.0.0.1:8081', LISTEN: '[::1]:8081' }).dev).not.toBeNull();
    expect(loadConfig({ ...DEV_ENV, PUBLIC_URL: 'http://localhost', LISTEN: 'localhost:8081' }).dev).not.toBeNull();
  });

  test('rejects non-localhost PUBLIC_URL', () => {
    for (const u of ['https://tela.example.com', 'https://localhost:8081', 'http://tela.example.com', 'http://localhost.example.com', 'http://10.0.0.1:8081']) {
      expect(() => loadConfig({ ...DEV_ENV, PUBLIC_URL: u })).toThrow('DEV_USER requires PUBLIC_URL');
    }
  });

  test('rejects non-loopback LISTEN', () => {
    for (const l of ['0.0.0.0:8081', '[::]:8081', '10.0.0.2:8081']) {
      expect(() => loadConfig({ ...DEV_ENV, LISTEN: l })).toThrow('loopback');
    }
  });

  test('rejects bad DEV_USER format', () => {
    for (const d of ['Dev', 'abc:Dev', '1:', ':Dev', '1']) {
      expect(() => loadConfig({ ...DEV_ENV, DEV_USER: d })).toThrow('bad DEV_USER');
    }
  });

  test('name may contain colons and spaces', () => {
    expect(loadConfig({ ...DEV_ENV, DEV_USER: '42:Zé da Silva: 2' }).dev).toEqual({ id: '42', name: 'Zé da Silva: 2' });
  });
});

test('parseListen', () => {
  expect(parseListen('0.0.0.0:80')).toEqual({ host: '0.0.0.0', port: 80 });
  expect(parseListen('[::1]:8081')).toEqual({ host: '::1', port: 8081 });
  for (const bad of ['::1:8081', 'host:', 'host:99999', ':8081']) expect(() => parseListen(bad)).toThrow();
});
