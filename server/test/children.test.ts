import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childBaseEnv, childSpecs, portInUse, type FindBinary } from '../src/children.ts';
import { KNOWN_KEYS, loadConfig } from '../src/config.ts';
import { resolvePaths } from '../src/paths.ts';

// Distinctive so a scan can't match anything by accident.
const SECRETS = {
  DISCORD_TOKEN: 'S3CR3T-discord-token', DISCORD_CLIENT_SECRET: 'S3CR3T-client-secret',
  COOKIE_SECRET: 'S3CR3T-cookie', LIVEKIT_API_SECRET: 'S3CR3T-livekit', TUNNEL_TOKEN: 'S3CR3T-tunnel', // gitleaks:allow
};
const tmp = mkdtempSync(join(tmpdir(), 'telinha-children-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function setup(ingress: 'direct' | 'tunnel' | 'external') {
  const home = join(tmp, `home${n++}`);
  const env = {
    ...SECRETS, DISCORD_CLIENT_ID: 'cid', GUILD_ID: '100', ROLE_ID: '200', CHANNEL_IDS: '300',
    PUBLIC_URL: 'https://tela.example.com', LIVEKIT_API_KEY: 'devkey', INGRESS: ingress, TELINHA_HOME: home,
  };
  const config = loadConfig(env);
  return { config, paths: resolvePaths(env) };
}
const fake: FindBinary = (name, paths) => join(paths.bin, name);
// prepare() must not depend on what this machine runs on 7880/7881.
const free = async () => false;
const specsFor = (ingress: 'direct' | 'tunnel' | 'external', find = fake) => {
  const { config, paths } = setup(ingress);
  return { config, paths, specs: childSpecs(config, paths, find, free) };
};

describe('childSpecs', () => {
  test('direct: livekit then caddy', () => {
    const { paths, specs } = specsFor('direct');
    expect(specs.map((s) => s.name)).toEqual(['livekit', 'caddy']);
    const [lk, caddy] = specs;
    expect(lk!.cmd).toEqual([join(paths.bin, 'livekit-server'), '--config', join(paths.run, 'livekit.yaml')]);
    expect(lk!.ready).toEqual({ url: 'http://127.0.0.1:7880/', timeoutMs: 30_000 });
    expect(caddy!.cmd).toEqual([join(paths.bin, 'caddy'), 'run', '--config', join(paths.run, 'Caddyfile'), '--adapter', 'caddyfile']);
    const storage = join(paths.data, 'caddy');
    expect(caddy!.env).toEqual({ XDG_DATA_HOME: storage, XDG_CONFIG_HOME: storage, HOME: storage });
    expect(caddy!.ready).toBeUndefined();
  });

  test('tunnel: livekit then cloudflared, token only via env', () => {
    const { specs } = specsFor('tunnel');
    expect(specs.map((s) => s.name)).toEqual(['livekit', 'cloudflared']);
    const [lk, cf] = specs;
    expect(cf!.cmd.slice(1)).toEqual(['tunnel', '--no-autoupdate', 'run']);
    expect(cf!.env).toEqual({ TUNNEL_TOKEN: SECRETS.TUNNEL_TOKEN });
    expect(lk!.env).not.toHaveProperty('TUNNEL_TOKEN');
    expect(cf!.ready).toBeUndefined();
  });

  test('external: livekit only', () => {
    expect(specsFor('external').specs.map((s) => s.name)).toEqual(['livekit']);
  });

  test('livekit gets its keys as LIVEKIT_KEYS env', () => {
    const lk = specsFor('direct').specs[0]!;
    expect(lk.env).toEqual({ LIVEKIT_KEYS: `devkey: ${SECRETS.LIVEKIT_API_SECRET}` });
  });

  test('no cmd element of any spec contains any secret', () => {
    for (const mode of ['direct', 'tunnel', 'external'] as const) {
      for (const spec of specsFor(mode).specs) {
        for (const arg of spec.cmd) {
          for (const secret of Object.values(SECRETS)) expect(arg).not.toContain(secret);
        }
      }
    }
  });

  test('prepare renders the files, without secrets, and creates the caddy storage', async () => {
    const { paths, specs } = specsFor('direct');
    for (const s of specs) await s.prepare?.();
    expect(readFileSync(join(paths.run, 'livekit.yaml'), 'utf8')).toContain('port: 7880\n');
    expect(readFileSync(join(paths.run, 'Caddyfile'), 'utf8')).toContain('tela.example.com {\n');
    expect(statSync(join(paths.data, 'caddy')).isDirectory()).toBe(true);
    for (const f of readdirSync(paths.run)) {
      const text = readFileSync(join(paths.run, f), 'utf8');
      for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    }
  });

  test('tunnel mode renders no Caddyfile', async () => {
    const { paths, specs } = specsFor('tunnel');
    for (const s of specs) await s.prepare?.();
    expect(existsSync(join(paths.run, 'livekit.yaml'))).toBe(true);
    expect(existsSync(join(paths.run, 'Caddyfile'))).toBe(false);
  });

  test('livekit refuses to start when its signaling or ICE/TCP port is taken', async () => {
    for (const taken of [7880, 7881]) {
      const { config, paths } = setup('external');
      const [lk] = childSpecs(config, paths, fake, async (p) => p === taken);
      const key = taken === 7880 ? 'LIVEKIT_PORT' : 'MEDIA_TCP_PORT';
      await expect(lk!.prepare!()).rejects.toThrow(`port ${taken} (${key}) already in use (another LiveKit?)`);
    }
  });

  test('portInUse: true for a listener, false for a free port', async () => {
    const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = l.port;
    try {
      expect(await portInUse(port)).toBe(true);
    } finally {
      l.stop(true);
    }
    expect(await portInUse(port)).toBe(false);
  });

  test('missing binary', () => {
    const { config, paths } = setup('direct');
    expect(() => childSpecs(config, paths, () => null))
      .toThrow(`livekit-server not found: put it in ${paths.bin} (bun scripts/bins.ts livekit) or on PATH`);
    const noCaddy: FindBinary = (name, p) => (name === 'caddy' ? null : fake(name, p));
    expect(() => childSpecs(config, paths, noCaddy))
      .toThrow(`caddy not found: put it in ${paths.bin} (bun scripts/bins.ts caddy) or on PATH`);
  });
});

describe('childBaseEnv', () => {
  test('drops telinha keys and Go-flag prefixes, keeps the rest', () => {
    const env: Record<string, string | undefined> = {
      PATH: '/usr/bin', HOME: '/home/u', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
      LIVEKIT_FOO: 'x', TUNNEL_FOO: 'x', DISCORD_FOO: 'x', TELINHA_FOO: 'x', LIVEKIT_KEYS: 'k: s',
      tunnel_token: 'lowercase still reaches Go on Windows',
      UNSET: undefined,
    };
    for (const k of KNOWN_KEYS) env[k] = 'x';
    expect(childBaseEnv(env)).toEqual({
      PATH: '/usr/bin', HOME: '/home/u', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp', LANG: 'C.UTF-8',
      HTTPS_PROXY: 'http://proxy:3128',
    });
  });

  test('every KNOWN_KEYS key is dropped, secrets included', () => {
    const env = Object.fromEntries([...KNOWN_KEYS].map((k) => [k, 'v']));
    expect(childBaseEnv({ ...env, ...SECRETS })).toEqual({});
  });
});
