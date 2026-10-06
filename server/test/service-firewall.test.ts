import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRuleArgv, applyFirewallRules, deleteProgramRulesArgv, deleteRuleArgv, firewallRules, loadFirewallPorts, portsFromEnv, removeFirewallRules, RULE_NAMES } from '../src/service/firewall.ts';
import type { SpawnFn, SpawnOutcome } from '../src/service/index.ts';
import { PROD_ENV } from './helpers.ts';

const BIN = 'C:\\Users\\ana\\AppData\\Local\\Telinha\\bin';
const LIVEKIT = `${BIN}\\livekit-server.exe`;
const CADDY = `${BIN}\\caddy.exe`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function recorder(respond: (cmd: string[]) => Partial<SpawnOutcome> | undefined = () => undefined) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: '', stderr: '', ...respond(cmd) };
  };
  return { spawn, calls };
}

describe('firewallRules', () => {
  test('direct mode: media ports for livekit, HTTPS and HTTP for caddy', () => {
    expect(firewallRules(BIN, { mediaTcpPort: 7881, mediaUdpPort: 7882, ingress: 'direct', httpsPort: 443, httpPort: 80 })).toEqual([
      { name: 'Telinha LiveKit TCP', program: LIVEKIT, protocol: 'TCP', port: 7881 },
      { name: 'Telinha LiveKit UDP', program: LIVEKIT, protocol: 'UDP', port: 7882 },
      { name: 'Telinha HTTPS', program: CADDY, protocol: 'TCP', port: 443 },
      { name: 'Telinha HTTP', program: CADDY, protocol: 'TCP', port: 80 },
    ]);
  });

  test('HTTP_PORT=0 drops the HTTP rule; tunnel and external have no caddy rules', () => {
    const names = (r: { name: string }[]) => r.map((x) => x.name);
    expect(names(firewallRules(BIN, { mediaTcpPort: 7881, mediaUdpPort: 7882, ingress: 'direct', httpsPort: 8443, httpPort: 0 }))).toEqual(['Telinha LiveKit TCP', 'Telinha LiveKit UDP', 'Telinha HTTPS']);
    expect(names(firewallRules(BIN, { mediaTcpPort: 7001, mediaUdpPort: 7002, ingress: 'tunnel', httpsPort: 443, httpPort: 80 }))).toEqual(['Telinha LiveKit TCP', 'Telinha LiveKit UDP']);
    expect(names(firewallRules(BIN, { mediaTcpPort: 7881, mediaUdpPort: 7882, ingress: 'external', httpsPort: 443, httpPort: 80 }))).toEqual(['Telinha LiveKit TCP', 'Telinha LiveKit UDP']);
  });

  test('RULE_NAMES lists every rule ever created', () => {
    const all = firewallRules(BIN, { mediaTcpPort: 1, mediaUdpPort: 2, ingress: 'direct', httpsPort: 3, httpPort: 4 }).map((r) => r.name);
    expect(all).toEqual([...RULE_NAMES]);
  });
});

describe('ports from the environment', () => {
  test('a loadable config decides', () => {
    expect(portsFromEnv({ ...PROD_ENV, MEDIA_TCP_PORT: '7001', MEDIA_UDP_PORT: '7002', HTTPS_PORT: '8443', HTTP_PORT: '0' }))
      .toEqual({ mediaTcpPort: 7001, mediaUdpPort: 7002, ingress: 'direct', httpsPort: 8443, httpPort: 0 });
    expect(portsFromEnv({ ...PROD_ENV, INGRESS: 'tunnel', TUNNEL_TOKEN: 'eyJ' }).ingress).toBe('tunnel');
  });

  test('a config that does not load yet falls back to the port keys and their defaults', () => {
    expect(portsFromEnv({})).toEqual({ mediaTcpPort: 7881, mediaUdpPort: 7882, ingress: 'direct', httpsPort: 443, httpPort: 80 });
    expect(portsFromEnv({ MEDIA_TCP_PORT: '7001', HTTP_PORT: '0', INGRESS: 'tunnel', HTTPS_PORT: 'junk' }))
      .toEqual({ mediaTcpPort: 7001, mediaUdpPort: 7882, ingress: 'tunnel', httpsPort: 443, httpPort: 0 });
  });

  test('loadFirewallPorts: telinha.env with the process environment over it; no file is fine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telinha-fw-'));
    dirs.push(dir);
    const envFile = join(dir, 'telinha.env');
    writeFileSync(envFile, 'MEDIA_TCP_PORT=7001\nMEDIA_UDP_PORT=7002\nHTTP_PORT=0\n');
    expect(loadFirewallPorts(envFile, {})).toMatchObject({ mediaTcpPort: 7001, mediaUdpPort: 7002, httpPort: 0 });
    expect(loadFirewallPorts(envFile, { MEDIA_TCP_PORT: '7100' }).mediaTcpPort).toBe(7100);
    expect(loadFirewallPorts(join(dir, 'missing.env'), {}).mediaTcpPort).toBe(7881);
  });
});

describe('netsh', () => {
  const rule = { name: 'Telinha LiveKit TCP', program: LIVEKIT, protocol: 'TCP' as const, port: 7881 };

  test('argv for delete and add', () => {
    expect(deleteRuleArgv('Telinha HTTP')).toEqual(['netsh', 'advfirewall', 'firewall', 'delete', 'rule', 'name=Telinha HTTP']);
    expect(addRuleArgv(rule)).toEqual([
      'netsh', 'advfirewall', 'firewall', 'add', 'rule',
      'name=Telinha LiveKit TCP', 'dir=in', 'action=allow', 'protocol=TCP', 'localport=7881', `program=${LIVEKIT}`, 'profile=any', 'enable=yes',
    ]);
  });

  test("apply: each program's inbound rules cleared (a Block from a dismissed alert), then delete and add per rule, in order", async () => {
    const r = recorder((cmd) => (cmd[3] === 'delete' ? { code: 1, stdout: 'No rules match the specified criteria.' } : undefined));
    const rules = firewallRules(BIN, { mediaTcpPort: 7881, mediaUdpPort: 7882, ingress: 'direct', httpsPort: 443, httpPort: 0 });
    await applyFirewallRules(r.spawn, rules);
    expect(r.calls.slice(0, 2)).toEqual([deleteProgramRulesArgv(LIVEKIT), deleteProgramRulesArgv(CADDY)]);
    expect(deleteProgramRulesArgv(CADDY)).toEqual(['netsh', 'advfirewall', 'firewall', 'delete', 'rule', 'name=all', 'dir=in', `program=${CADDY}`]);
    expect(r.calls.slice(2).map((c) => `${c[3]} ${c[5]}`)).toEqual([
      'delete name=Telinha LiveKit TCP', 'add name=Telinha LiveKit TCP',
      'delete name=Telinha LiveKit UDP', 'add name=Telinha LiveKit UDP',
      'delete name=Telinha HTTPS', 'add name=Telinha HTTPS',
    ]);
    expect(r.calls[7]).toEqual(addRuleArgv({ name: 'Telinha HTTPS', program: CADDY, protocol: 'TCP', port: 443 }));
  });

  test('apply: a failing add throws with the rule name and netsh output', async () => {
    const r = recorder((cmd) => (cmd[3] === 'add' && cmd[5] === 'name=Telinha LiveKit UDP' ? { code: 1, stdout: 'The requested operation requires elevation (Run as administrator).' } : undefined));
    await expect(applyFirewallRules(r.spawn, firewallRules(BIN, { mediaTcpPort: 7881, mediaUdpPort: 7882, ingress: 'tunnel', httpsPort: 443, httpPort: 80 })))
      .rejects.toThrow('netsh could not add rule "Telinha LiveKit UDP": The requested operation requires elevation (Run as administrator).');
    expect(r.calls).toHaveLength(5);
  });

  test('remove: one delete per known rule name, failures ignored', async () => {
    const r = recorder(() => ({ code: 1 }));
    await removeFirewallRules(r.spawn);
    expect(r.calls).toEqual(RULE_NAMES.map((n) => deleteRuleArgv(n)));
  });
});
