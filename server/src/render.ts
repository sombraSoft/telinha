// Config files for the children, rendered from telinha.env. Pure:
// children.ts writes them to <run>/ before every (re)start. No secret goes in
// here: LiveKit gets its keys from the LIVEKIT_KEYS env of its process.
import type { Config } from './config.ts';

const HEADER = '# Rendered by telinha from telinha.env; do not edit.';

export function renderLivekitYaml(
  c: Pick<Config, 'livekitPort' | 'mediaTcpPort' | 'mediaUdpPort' | 'livekitNodeIp' | 'closeEmptySeconds'>,
): string {
  return [
    HEADER,
    `port: ${c.livekitPort}`,
    'bind_addresses:',
    '  - 127.0.0.1',
    'logging:',
    '  level: info',
    'rtc:',
    `  tcp_port: ${c.mediaTcpPort}`,
    `  udp_port: ${c.mediaUdpPort}`,
    // A static IP skips STUN (and the IP watch is off then).
    c.livekitNodeIp ? `  node_ip: ${c.livekitNodeIp}` : '  use_external_ip: true',
    'room:',
    // Only telinha creates rooms: a token for a closed room must not bring it back.
    '  auto_create: false',
    // Mirrors roomService.ensureRoom's emptyTimeout so one setting moves both.
    `  empty_timeout: ${c.closeEmptySeconds + 120}`,
    '  departure_timeout: 20',
    '',
  ].join('\n');
}

/** Where Caddy reaches telinha: a wildcard LISTEN host is reached on loopback. */
export function upstreamHost(listenHost: string): string {
  if (listenHost === '' || listenHost === '0.0.0.0' || listenHost === '::') return '127.0.0.1';
  return listenHost.includes(':') ? `[${listenHost}]` : listenHost;
}

export function renderCaddyfile(
  c: Pick<Config, 'publicHost' | 'httpPort' | 'httpsPort' | 'acmeEmail' | 'host' | 'port'>,
): string {
  const global = [
    '\tadmin off',
    // 0 = no redirect listener; Caddy keeps its default http_port 80 for ACME then.
    c.httpPort === 0 ? '\tauto_https disable_redirects' : `\thttp_port ${c.httpPort}`,
    `\thttps_port ${c.httpsPort}`,
    ...(c.acmeEmail ? [`\temail ${c.acmeEmail}`] : []),
  ];
  // Bare host as the site address: https_port picks the bind port, so a router
  // translating 443 -> 8443 just works.
  return [
    HEADER,
    '{',
    ...global,
    '}',
    '',
    `${c.publicHost} {`,
    '\tencode zstd gzip',
    `\treverse_proxy ${upstreamHost(c.host)}:${c.port}`,
    '}',
    '',
  ].join('\n');
}
