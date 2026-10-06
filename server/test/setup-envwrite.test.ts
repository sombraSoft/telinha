import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config.ts';
import { parseEnvFile } from '../src/envfile.ts';
import { ENV_TEMPLATE, icaclsArgv, icaclsHomeArgv, lockWindowsHome, quoteValue, renderEnvFile, writeEnvFile, type EnvFs } from '../src/cli/setup/envwrite.ts';

const VALUES = {
  DISCORD_TOKEN: 'tok.en-1', DISCORD_CLIENT_ID: '111111111111111111', DISCORD_CLIENT_SECRET: 'sec$ret',
  GUILD_ID: '222222222222222222', ROLE_ID: '333333333333333333', CHANNEL_IDS: '444444444444444441,444444444444444443',
  COOKIE_SECRET: 'abc+/=', PUBLIC_URL: 'https://telinha.example.com', INGRESS: 'direct',
  LIVEKIT_API_KEY: 'telinha0011aabb', LIVEKIT_API_SECRET: 'x'.repeat(43), GROUP_NAME: "Joe's group", COMMAND_NAME: '',
};

describe('quoteValue', () => {
  test('plain values stay bare, secrets are always single-quoted', () => {
    expect(quoteValue('GUILD_ID', '123')).toBe('123');
    expect(quoteValue('DISCORD_TOKEN', 'abc')).toBe("'abc'");
  });
  test('$ \\ # whitespace and quotes are single-quoted', () => {
    for (const v of ['a$b', 'a\\b', 'a#b', 'a b', 'a"b']) expect(quoteValue('GROUP_NAME', v)).toBe(`'${v}'`);
  });
  test("a ' falls back to double quotes, and is refused next to $ \\ \"", () => {
    expect(quoteValue('GROUP_NAME', "Joe's")).toBe('"Joe\'s"');
    expect(() => quoteValue('GROUP_NAME', "Joe's $5")).toThrow();
    expect(() => quoteValue('GROUP_NAME', 'a\nb')).toThrow();
  });
});

describe('renderEnvFile', () => {
  test('fills the documented places and parses back to the same values', () => {
    const text = renderEnvFile(VALUES, null);
    expect(text).toContain("DISCORD_TOKEN='tok.en-1'\n");
    expect(text).toContain("DISCORD_CLIENT_SECRET='sec$ret'\n");
    expect(text).toContain('INGRESS=direct\n');
    // Unset optional keys keep their commented default line.
    expect(text).toContain('#COMMAND_NAME=telinha\n');
    expect(text).toContain("#TUNNEL_TOKEN=''\n");
    expect(text).not.toContain('Other settings');
    const parsed = parseEnvFile(text);
    expect(parsed.warnings).toEqual([]);
    for (const [k, v] of Object.entries(VALUES)) if (v) expect(parsed.vars[k]).toBe(v);
    expect(() => loadConfig({ ...parsed.vars, TELINHA_HOME: '/srv/telinha' })).not.toThrow();
  });

  test('every template key line appears once, comments untouched', () => {
    const text = renderEnvFile({}, null);
    expect(text).toBe(ENV_TEMPLATE);
  });

  test('unmanaged keys of the previous file are kept verbatim under Other settings; dropped managed keys go', () => {
    const previous = "SESSION_DAYS=14\nexport ACME_EMAIL=\"me@example.com\"\nMY_NOTE='keep # me'\nTUNNEL_TOKEN='eyJold'\n# a comment\n";
    const text = renderEnvFile({ ...VALUES, TUNNEL_TOKEN: '' }, { vars: parseEnvFile(previous).vars, text: previous });
    const other = text.slice(text.indexOf('# --- Other settings'));
    expect(other).toContain('SESSION_DAYS=14\n');
    expect(other).toContain('export ACME_EMAIL="me@example.com"\n');
    expect(other).toContain("MY_NOTE='keep # me'\n");
    expect(text).not.toContain('eyJold');
    expect(parseEnvFile(text).vars.SESSION_DAYS).toBe('14');
  });

  test('without the previous text, kept values are re-quoted', () => {
    const text = renderEnvFile(VALUES, { vars: { MY_NOTE: 'a b' } });
    expect(text).toContain("MY_NOTE='a b'\n");
  });
});

type Entry = { uid: number; gid: number; mode: number; dir?: boolean; symlink?: boolean };

function fakeFs(o: { files?: Record<string, string>; entries?: Record<string, Entry> } = {}) {
  const files = new Map(Object.entries(o.files ?? {}));
  const entries = new Map(Object.entries(o.entries ?? {}));
  const calls: string[] = [];
  const fs: EnvFs = {
    mkdir: async (d) => {
      calls.push(`mkdir ${d}`);
      if (!entries.has(d)) entries.set(d, { uid: 0, gid: 0, mode: 0o40755, dir: true });
    },
    createFile: async (p, data, c) => {
      if (files.has(p) || entries.has(p)) throw new Error(`EEXIST: ${p}`);
      calls.push(`create ${p} ${c.mode.toString(8)}${c.uid !== undefined ? ` ${c.uid}:${c.gid}` : ''}`);
      files.set(p, data);
    },
    rename: async (a, b) => {
      calls.push(`rename ${a} ${b}`);
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    chmod: async (p, m) => void calls.push(`chmod ${p} ${m.toString(8)}`),
    chown: async (p, u, g) => void calls.push(`chown ${p} ${u}:${g}`),
    stat: async (p) => entries.get(p) ?? (files.has(p) ? { uid: 0, gid: 0, mode: 0o100600 } : null),
    rm: async (p) => {
      if (files.has(p) || entries.has(p)) calls.push(`rm ${p}`);
      files.delete(p);
      entries.delete(p);
    },
  };
  return { fs, files, calls };
}

const spawnOk = async () => ({ code: 0, stdout: '', stderr: '' });
const DIR = (uid: number, mode = 0o40700): Entry => ({ uid, gid: uid, mode, dir: true });

describe('writeEnvFile', () => {
  const base = { text: 'A=1\n', home: '/opt/telinha', spawn: spawnOk, user: 'X\\y' };

  test('Linux root re-run: atomic, exclusive create with mode and owner on the handle, owner of the previous file kept', async () => {
    const f = fakeFs({ entries: {
      '/opt/telinha': DIR(0, 0o40755),
      '/opt/telinha/config': { uid: 0, gid: 998, mode: 0o40750, dir: true },
      '/opt/telinha/config/telinha.env': { uid: 0, gid: 998, mode: 0o100640 },
    } });
    await writeEnvFile({ ...base, file: '/opt/telinha/config/telinha.env', fs: f.fs, platform: 'linux', isRoot: true, docker: false });
    expect(f.calls).toEqual([
      'mkdir /opt/telinha/config',
      // root:telinha 0750 / 0640 (the system install's layout) stays group-readable for the service.
      'chmod /opt/telinha/config 750',
      'create /opt/telinha/config/telinha.env.tmp 640 0:998',
      'rename /opt/telinha/config/telinha.env.tmp /opt/telinha/config/telinha.env',
    ]);
    expect(f.files.get('/opt/telinha/config/telinha.env')).toBe('A=1\n');
  });

  test('Linux root, new file: the home dir owner owns file and new config dir, 0700/0600', async () => {
    const f = fakeFs({ entries: { '/srv/t': DIR(1000) } });
    await writeEnvFile({ ...base, home: '/srv/t', file: '/srv/t/config/telinha.env', fs: f.fs, platform: 'linux', isRoot: true, docker: false });
    expect(f.calls).toContain('chmod /srv/t/config 700');
    expect(f.calls).toContain('chown /srv/t/config 1000:1000');
    expect(f.calls).toContain('create /srv/t/config/telinha.env.tmp 600 1000:1000');
  });

  test('a planted tmp (a symlink to /etc/passwd) is unlinked, never written through', async () => {
    const f = fakeFs({ entries: {
      '/opt/telinha': DIR(0, 0o40755), '/opt/telinha/config': DIR(0),
      '/opt/telinha/config/telinha.env.tmp': { uid: 999, gid: 999, mode: 0o120777, symlink: true },
    } });
    await writeEnvFile({ ...base, file: '/opt/telinha/config/telinha.env', fs: f.fs, platform: 'linux', isRoot: true, docker: false });
    expect(f.calls.slice(2, 4)).toEqual(['rm /opt/telinha/config/telinha.env.tmp', 'create /opt/telinha/config/telinha.env.tmp 600 0:0']);
  });

  test('as root, a config dir someone else controls is refused before anything is written', async () => {
    const refuse = async (dir: Entry) => {
      const f = fakeFs({ entries: { '/opt/telinha': DIR(0, 0o40755), '/opt/telinha/config': dir } });
      await expect(writeEnvFile({ ...base, file: '/opt/telinha/config/telinha.env', fs: f.fs, platform: 'linux', isRoot: true, docker: false }))
        .rejects.toThrow('refusing to write into /opt/telinha/config as root');
      expect(f.calls.filter((c) => !c.startsWith('mkdir'))).toEqual([]);
    };
    await refuse(DIR(999));
    await refuse({ uid: 0, gid: 0, mode: 0o120777, symlink: true });
    await refuse(DIR(0, 0o40770));
    await refuse(DIR(0, 0o40703));
  });

  test('not root: no chown', async () => {
    const f = fakeFs({ entries: { '/home/u/.local/share/telinha': DIR(1000) } });
    await writeEnvFile({ ...base, home: '/home/u/.local/share/telinha', file: '/home/u/.local/share/telinha/config/telinha.env', fs: f.fs, platform: 'linux', isRoot: false, docker: false });
    expect(f.calls.some((c) => c.startsWith('chown'))).toBe(false);
    expect(f.calls).toContain('create /home/u/.local/share/telinha/config/telinha.env.tmp 600');
  });

  test('Docker: only the file mode, the mounted dir is the host\'s', async () => {
    const f = fakeFs();
    await writeEnvFile({ ...base, home: '/telinha', file: '/telinha/config/telinha.env', fs: f.fs, platform: 'linux', isRoot: true, docker: true });
    expect(f.calls).toEqual([
      'mkdir /telinha/config',
      'create /telinha/config/telinha.env.tmp 600',
      'rename /telinha/config/telinha.env.tmp /telinha/config/telinha.env',
    ]);
  });

  test('Windows: the tmp file\'s ACL is reset before it takes the real name', async () => {
    const f = fakeFs();
    const spawned: string[][] = [];
    const file = 'C:\\Users\\J\\AppData\\Local\\Telinha\\config\\telinha.env';
    await writeEnvFile({
      ...base, file, home: 'C:\\Users\\J\\AppData\\Local\\Telinha', fs: f.fs, platform: 'win32', isRoot: false, docker: false, user: 'PC\\J',
      spawn: async (cmd) => (spawned.push(cmd), { code: 0, stdout: '', stderr: '' }),
    });
    expect(f.calls.some((c) => c.startsWith('chmod') || c.startsWith('chown'))).toBe(false);
    expect(spawned).toEqual([icaclsArgv(`${file}.tmp`, 'PC\\J')]);
    expect(spawned[0]).toEqual(['icacls', `${file}.tmp`, '/inheritance:r', '/grant:r', 'PC\\J:(F)', '*S-1-5-18:(F)', '*S-1-5-32-544:(F)']);
    expect(f.files.get(file)).toBe('A=1\n');
  });

  test('Windows: an icacls failure is fatal, the secrets never get the real name', async () => {
    const f = fakeFs();
    const file = 'C:\\Telinha\\config\\telinha.env';
    await expect(writeEnvFile({
      ...base, file, home: 'C:\\Telinha', fs: f.fs, platform: 'win32', isRoot: false, docker: false, user: 'PC\\J',
      spawn: async () => ({ code: 5, stdout: '', stderr: 'Access is denied.' }),
    })).rejects.toThrow('Access is denied.');
    expect(f.files.has(file)).toBe(false);
    expect(f.files.has(`${file}.tmp`)).toBe(false);
  });

  test('the Windows home lock: inheritable full control for the user, SYSTEM and Administrators only; a failure warns', async () => {
    expect(icaclsHomeArgv('C:\\Telinha', 'PC\\J')).toEqual(['icacls', 'C:\\Telinha', '/inheritance:r', '/grant:r', 'PC\\J:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
    const warnings: string[] = [];
    await lockWindowsHome({ home: 'C:\\Telinha', user: 'PC\\J', spawn: async () => ({ code: 5, stdout: '', stderr: 'Access is denied.' }), warn: (m) => warnings.push(m) });
    expect(warnings).toEqual(['icacls C:\\Telinha: Access is denied.']);
  });

  test('a failed write leaves no .tmp behind', async () => {
    const f = fakeFs();
    f.fs.rename = async () => {
      throw new Error('EXDEV');
    };
    await expect(writeEnvFile({ ...base, file: '/x/config/telinha.env', fs: f.fs, platform: 'linux', isRoot: false, docker: false })).rejects.toThrow('EXDEV');
    expect(f.files.has('/x/config/telinha.env.tmp')).toBe(false);
  });
});
