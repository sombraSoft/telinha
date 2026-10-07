// Windows Firewall rules for the footprint's exposures, the helpers that accept
// connections from the internet: livekit-server on the media ports (MEDIA=self only; Cloud runs no
// local SFU), caddy on HTTPS/HTTP in direct mode. Created by the elevated
// `service install --firewall`, removed by `uninstall --firewall`. Install first
// deletes every Telinha rule, so a re-run after a port or MEDIA change leaves
// nothing stale, then clears every inbound rule scoped to the programs: a
// dismissed Windows Security Alert (a console `telinha run` before the service)
// leaves Block rules for them, and Block beats Allow.
import { loadConfig } from '../config.ts';
import { loadEnvFile, mergeEnv } from '../envfile.ts';
import { type ExposedKey, type FootprintInput, footprintOf } from '../footprint.ts';
import type { SpawnFn } from './index.ts';

export interface FirewallRule {
  name: string;
  program: string;
  protocol: 'TCP' | 'UDP';
  port: number;
}

export const RULE_NAMES = ['Telinha LiveKit TCP', 'Telinha LiveKit UDP', 'Telinha HTTPS', 'Telinha HTTP'] as const;
const RULE_FOR: Record<ExposedKey, (typeof RULE_NAMES)[number]> = {
  MEDIA_TCP_PORT: 'Telinha LiveKit TCP',
  MEDIA_UDP_PORT: 'Telinha LiveKit UDP',
  HTTPS_PORT: 'Telinha HTTPS',
  HTTP_PORT: 'Telinha HTTP',
};

/** One Allow rule per exposure, scoped to the helper's program in bin. */
export function firewallRules(bin: string, c: FootprintInput): FirewallRule[] {
  const { helpers, exposures } = footprintOf(c);
  return exposures.map((e) => ({
    name: RULE_FOR[e.key],
    program: `${bin}\\${helpers.find((h) => h.name === e.helper)!.binary}.exe`,
    protocol: e.protocol === 'tcp' ? 'TCP' : 'UDP',
    port: e.port,
  }));
}

/**
 * The footprint input from the merged environment, the way `run` reads it. A
 * telinha.env that does not load yet (setup half done) still gets one from
 * the keys and their defaults, so the firewall never blocks a later start.
 */
export function portsFromEnv(env: Record<string, string | undefined>, o: { compiled?: boolean } = {}): FootprintInput {
  try {
    return loadConfig(env, { compiled: o.compiled });
  } catch {
    const port = (k: string, d: number) => {
      const n = Number(env[k]);
      return env[k] && Number.isInteger(n) && n >= 0 && n <= 65535 ? n : d;
    };
    // A rule names a local port only: PUBLIC_URL is left out, and LISTEN,
    // LIVEKIT_PORT, TURN and the IP watch (never exposed) keep loadConfig's defaults.
    return {
      media: env.MEDIA === 'cloud' ? 'cloud' : 'self',
      ingress: env.INGRESS === 'tunnel' || env.INGRESS === 'external' ? env.INGRESS : 'direct',
      turn: null,
      port: 8081,
      livekitPort: 7880,
      mediaTcpPort: port('MEDIA_TCP_PORT', 7881),
      mediaUdpPort: port('MEDIA_UDP_PORT', 7882),
      httpsPort: port('HTTPS_PORT', 443),
      httpPort: port('HTTP_PORT', 80),
      ipWatchSeconds: 300,
    };
  }
}

export function loadFirewallPorts(
  envFile: string,
  env: Record<string, string | undefined>,
  o: { compiled?: boolean } = {},
): FootprintInput {
  let vars: Record<string, string> = {};
  try {
    vars = loadEnvFile(envFile)?.vars ?? {};
  } catch {
    // unreadable file: the environment and the defaults decide
  }
  return portsFromEnv(mergeEnv(vars, env), o);
}

export const deleteRuleArgv = (name: string): string[] => [
  'netsh',
  'advfirewall',
  'firewall',
  'delete',
  'rule',
  `name=${name}`,
];

/** Every inbound rule (any name, Allow or Block) for one program; none matching is not an error. */
export const deleteProgramRulesArgv = (program: string): string[] => [
  'netsh',
  'advfirewall',
  'firewall',
  'delete',
  'rule',
  'name=all',
  'dir=in',
  `program=${program}`,
];

export const addRuleArgv = (r: FirewallRule): string[] => [
  'netsh',
  'advfirewall',
  'firewall',
  'add',
  'rule',
  `name=${r.name}`,
  'dir=in',
  'action=allow',
  `protocol=${r.protocol}`,
  `localport=${r.port}`,
  `program=${r.program}`,
  'profile=any',
  'enable=yes',
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
