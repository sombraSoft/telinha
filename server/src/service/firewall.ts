// Windows Firewall rules for the children that accept connections from the
// internet: livekit-server on the media ports (MEDIA=self only; Cloud runs no
// local SFU), caddy on HTTPS/HTTP in direct mode. Created by the elevated
// `service install --firewall`, removed by `uninstall --firewall`. Install first
// deletes every Telinha rule, so a re-run after a port or MEDIA change leaves
// nothing stale, then clears every inbound rule scoped to the programs: a
// dismissed Windows Security Alert (a console `telinha run` before the service)
// leaves Block rules for them, and Block beats Allow.
import { loadConfig, type Ingress, type Media } from '../config.ts';
import { loadEnvFile, mergeEnv } from '../envfile.ts';
import type { SpawnFn } from './index.ts';

export interface FirewallRule { name: string; program: string; protocol: 'TCP' | 'UDP'; port: number }

export interface FirewallPorts {
  media: Media;
  mediaTcpPort: number;
  mediaUdpPort: number;
  ingress: Ingress;
  httpsPort: number;
  /** 0 = no HTTP listener. */
  httpPort: number;
}

export const RULE_NAMES = ['Telinha LiveKit TCP', 'Telinha LiveKit UDP', 'Telinha HTTPS', 'Telinha HTTP'] as const;

export function firewallRules(bin: string, p: FirewallPorts): FirewallRule[] {
  const livekit = `${bin}\\livekit-server.exe`;
  const caddy = `${bin}\\caddy.exe`;
  const rules: FirewallRule[] = [];
  if (p.media === 'self') {
    rules.push(
      { name: 'Telinha LiveKit TCP', program: livekit, protocol: 'TCP', port: p.mediaTcpPort },
      { name: 'Telinha LiveKit UDP', program: livekit, protocol: 'UDP', port: p.mediaUdpPort },
    );
  }
  // Tunnel and external modes never expose caddy.
  if (p.ingress === 'direct') {
    rules.push({ name: 'Telinha HTTPS', program: caddy, protocol: 'TCP', port: p.httpsPort });
    if (p.httpPort !== 0) rules.push({ name: 'Telinha HTTP', program: caddy, protocol: 'TCP', port: p.httpPort });
  }
  return rules;
}

/**
 * Ports from the merged environment, the way `run` reads them. A telinha.env
 * that does not load yet (setup half done) still gets rules from the port keys
 * and their defaults, so the firewall never blocks a later start.
 */
export function portsFromEnv(env: Record<string, string | undefined>, o: { compiled?: boolean } = {}): FirewallPorts {
  try {
    const c = loadConfig(env, { compiled: o.compiled });
    return { media: c.media, mediaTcpPort: c.mediaTcpPort, mediaUdpPort: c.mediaUdpPort, ingress: c.ingress, httpsPort: c.httpsPort, httpPort: c.httpPort };
  } catch {
    const port = (k: string, d: number) => {
      const n = Number(env[k]);
      return env[k] && Number.isInteger(n) && n >= 0 && n <= 65535 ? n : d;
    };
    const ingress = env.INGRESS === 'tunnel' || env.INGRESS === 'external' ? env.INGRESS : 'direct';
    const media = env.MEDIA === 'cloud' ? 'cloud' : 'self';
    return { media, mediaTcpPort: port('MEDIA_TCP_PORT', 7881), mediaUdpPort: port('MEDIA_UDP_PORT', 7882), ingress, httpsPort: port('HTTPS_PORT', 443), httpPort: port('HTTP_PORT', 80) };
  }
}

export function loadFirewallPorts(envFile: string, env: Record<string, string | undefined>, o: { compiled?: boolean } = {}): FirewallPorts {
  let vars: Record<string, string> = {};
  try {
    vars = loadEnvFile(envFile)?.vars ?? {};
  } catch {
    // unreadable file: the environment and the defaults decide
  }
  return portsFromEnv(mergeEnv(vars, env), o);
}

export const deleteRuleArgv = (name: string): string[] => ['netsh', 'advfirewall', 'firewall', 'delete', 'rule', `name=${name}`];

/** Every inbound rule (any name, Allow or Block) for one program; none matching is not an error. */
export const deleteProgramRulesArgv = (program: string): string[] =>
  ['netsh', 'advfirewall', 'firewall', 'delete', 'rule', 'name=all', 'dir=in', `program=${program}`];

export const addRuleArgv = (r: FirewallRule): string[] => [
  'netsh', 'advfirewall', 'firewall', 'add', 'rule',
  `name=${r.name}`, 'dir=in', 'action=allow', `protocol=${r.protocol}`, `localport=${r.port}`, `program=${r.program}`, 'profile=any', 'enable=yes',
];

/**
 * Deletes every Telinha rule (a self -> cloud switch must drop the LiveKit
 * ones), clears the programs' inbound rules (a Block left by a dismissed
 * security alert would win over ours), then adds each rule; throws on the
 * first add that fails.
 */
export async function applyFirewallRules(spawn: SpawnFn, rules: FirewallRule[]): Promise<void> {
  await removeFirewallRules(spawn);
  for (const program of new Set(rules.map((r) => r.program))) await spawn(deleteProgramRulesArgv(program));
  for (const r of rules) {
    const argv = addRuleArgv(r);
    const res = await spawn(argv);
    if (res.code !== 0) throw new Error(`netsh could not add rule "${r.name}": ${(res.stderr || res.stdout).trim()}`);
  }
}

/** Removes every Telinha rule, present or not. */
export async function removeFirewallRules(spawn: SpawnFn, names: readonly string[] = RULE_NAMES): Promise<void> {
  for (const name of names) await spawn(deleteRuleArgv(name));
}
