import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOneStdin, buildContext, GLOBAL_FLAGS, parseArgs, readSecretSource, UsageError } from '../src/cli/args.ts';

const SPEC = {
  flags: {
    ...GLOBAL_FLAGS,
    json: 'boolean',
    'public-url': 'string',
    channel: 'string[]',
    'no-service': 'boolean',
    'discord-token-file': 'string',
  },
} as const;

const usage = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UsageError);
    expect((e as UsageError).exitCode).toBe(2);
    return (e as Error).message;
  }
  throw new Error('expected a UsageError');
};

describe('parseArgs', () => {
  test('booleans, strings, repeated strings, positionals', () => {
    const a = parseArgs(['setup', '--json', '--public-url', 'https://x.test', '--channel=1', '--channel', '2', 'extra'], SPEC);
    expect(a.flags.json).toBe(true);
    expect(a.flags['public-url']).toBe('https://x.test');
    expect(a.flags.channel).toEqual(['1', '2']);
    expect(a.positionals).toEqual(['setup', 'extra']);
    expect(a.rest).toEqual([]);
  });

  test('--no-x turns a boolean off; an explicit no- flag wins', () => {
    const a = parseArgs(['--no-json', '--no-service'], SPEC);
    expect(a.flags.json).toBe(false);
    expect(a.flags['no-service']).toBe(true);
    expect((a.flags as Record<string, unknown>).service).toBeUndefined();
  });

  test('--k=true|false for booleans', () => {
    expect(parseArgs(['--json=false'], SPEC).flags.json).toBe(false);
    expect(parseArgs(['--yes=1'], SPEC).flags.yes).toBe(true);
    expect(usage(() => parseArgs(['--json=maybe'], SPEC))).toBe('--json must be true or false, got maybe');
  });

  test('short flags', () => {
    const a = parseArgs(['-h', '-v', '-y'], SPEC);
    expect(a.flags).toEqual({ help: true, version: true, yes: true });
    expect(usage(() => parseArgs(['-x'], SPEC))).toBe('unknown flag -x');
  });

  test('-- passes the rest through; - is a value (stdin) or a positional', () => {
    const a = parseArgs(['--discord-token-file', '-', '-', '--', '--json', 'x'], SPEC);
    expect(a.flags['discord-token-file']).toBe('-');
    expect(a.positionals).toEqual(['-']);
    expect(a.rest).toEqual(['--json', 'x']);
  });

  test('unknown flags and missing values are usage errors', () => {
    expect(usage(() => parseArgs(['--nope'], SPEC))).toBe('unknown flag --nope');
    expect(usage(() => parseArgs(['--public-url'], SPEC))).toBe('--public-url needs a value');
    expect(usage(() => parseArgs(['--public-url', '--json'], SPEC))).toBe('--public-url needs a value');
    expect(usage(() => parseArgs(['--nope'], SPEC, { locale: 'pt-BR' }))).toBe('opção desconhecida --nope');
  });

  test('secret flags are refused, naming the env var and the -file form', () => {
    for (const [flag, env] of [['discord-token', 'DISCORD_TOKEN'], ['client-secret', 'DISCORD_CLIENT_SECRET'], ['tunnel-token', 'TUNNEL_TOKEN'], ['duckdns-token', 'DUCKDNS_TOKEN'], ['livekit-secret', 'LIVEKIT_API_SECRET']]) {
      for (const argv of [[`--${flag}`, 'abc'], [`--${flag}=abc`]]) {
        const msg = usage(() => parseArgs(argv, SPEC));
        expect(msg).toContain(env!);
        expect(msg).toContain(`--${flag}-file`);
        expect(msg).not.toContain('abc');
      }
    }
  });

  test('custom rejections', () => {
    expect(usage(() => parseArgs(['--old'], { flags: {}, rejected: { old: 'use --new' } }))).toBe('use --new');
  });
});

describe('buildContext', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const home = () => {
    const d = mkdtempSync(join(tmpdir(), 'telinha-ctx-'));
    dirs.push(d);
    return d;
  };

  test('--home sets the paths and the env file; LOCALE comes from telinha.env', () => {
    const h = home();
    const env = { LANG: 'en_US.UTF-8' };
    const ctx0 = buildContext({ argv: [], flags: { home: h }, env, stdinTty: true, stdoutTty: true });
    expect(ctx0.paths.home).toBe(h);
    expect(ctx0.env.TELINHA_HOME).toBe(h);
    expect(ctx0.envFile).toBe(join(h, 'config', 'telinha.env'));
    expect(ctx0.locale).toBe('en');
    expect(ctx0.tty).toBe(true);
    expect(ctx0.compiled).toBe(false);

    writeFileSync(join(h, 'telinha.env'), 'LOCALE=pt-BR\n');
    const ctx = buildContext({ argv: [], flags: { home: h }, env: { ...env, TELINHA_ENV: join(h, 'telinha.env') } });
    expect(ctx.envFile).toBe(join(h, 'telinha.env'));
    expect(ctx.locale).toBe('pt-BR');
    expect(buildContext({ argv: [], flags: { home: h, lang: 'en' }, env: { TELINHA_ENV: join(h, 'telinha.env') } }).locale).toBe('en');
  });

  test('tty needs both streams and no --non-interactive; --yes', () => {
    const env = { TELINHA_HOME: home() };
    expect(buildContext({ argv: [], env, stdinTty: false, stdoutTty: true }).tty).toBe(false);
    expect(buildContext({ argv: [], env, stdinTty: true, stdoutTty: true, flags: { 'non-interactive': true } }).tty).toBe(false);
    expect(buildContext({ argv: [], env, flags: { yes: true } }).yes).toBe(true);
  });

  test('--lang must be en or pt', () => {
    expect(usage(() => buildContext({ argv: [], env: { TELINHA_HOME: home() }, flags: { lang: 'fr' } }))).toContain('--lang must be en or pt-BR');
    expect(buildContext({ argv: [], env: { TELINHA_HOME: home() }, flags: { lang: 'pt' } }).locale).toBe('pt-BR');
  });
});

describe('readSecretSource', () => {
  test('env first, then the file, then stdin for -', async () => {
    const d = mkdtempSync(join(tmpdir(), 'telinha-secret-'));
    try {
      const f = join(d, 'token');
      writeFileSync(f, '﻿  from-file \r\n');
      expect(await readSecretSource({ env: ' from-env ', file: f })).toBe('from-env');
      expect(await readSecretSource({ env: '', file: f })).toBe('from-file');
      expect(await readSecretSource({ file: '-', stdin: async () => 'from-stdin\n' })).toBe('from-stdin');
      expect(await readSecretSource({})).toBeNull();
      expect(await readSecretSource({ file: '-', stdin: async () => '  \n' })).toBeNull();
      await expect(readSecretSource({ file: join(d, 'missing') })).rejects.toThrow();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test('only one secret from stdin per run', () => {
    expect(() => assertOneStdin(['-', 'file', undefined])).not.toThrow();
    expect(usage(() => assertOneStdin(['-', '-']))).toBe('only one secret can be read from stdin (-) per run');
  });
});
