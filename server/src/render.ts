// Config files for the children, rendered from telinha.env. Pure:
// children.ts writes them to <run>/ before every (re)start. No secret goes in
// here: LiveKit gets its keys from the LIVEKIT_KEYS env of its process, Caddy
// its DuckDNS token from DUCKDNS_TOKEN through an {env.*} placeholder.
import type { Config } from './config.ts';
import { roomTimeouts } from './livekit.ts';

const HEADER = '# Rendered by telinha from telinha.env; do not edit.';

export function renderLivekitYaml(
  c: Pick<Config, 'livekitPort' | 'mediaTcpPort' | 'mediaUdpPort' | 'livekitNodeIp' | 'closeEmptySeconds' | 'turn'>,
): string {
  const timeouts = roomTimeouts(c.closeEmptySeconds);
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
    `  empty_timeout: ${timeouts.emptyTimeout}`,
    `  departure_timeout: ${timeouts.departureTimeout}`,
    ...(c.turn
      ? [
        // Caddy terminates TLS on 443 for this name and forwards plain TCP here
        // with a PROXY header, so TURN echoes the browser's address, not
        // loopback (browsers drop an allocation that reflects 127.0.0.1).
        // LiveKit advertises turns:<domain>:443 by itself. No udp_port (no
        // TURN/UDP), and bind_addresses stays LiveKit's default because the
        // relay sockets share it; the trusted proxy CIDRs default to loopback.
        'turn:',
        '  enabled: true',
        `  domain: ${c.turn.host}`,
        `  tls_port: ${c.turn.port}`,
        '  external_tls: true',
        '  proxy_protocol: true',
      ]
      : []),
    '',
  ].join('\n');
}

/** Where Caddy reaches telinha: a wildcard LISTEN host is reached on loopback. */
export function upstreamHost(listenHost: string): string {
  if (listenHost === '' || listenHost === '0.0.0.0' || listenHost === '::') return '127.0.0.1';
  return listenHost.includes(':') ? `[${listenHost}]` : listenHost;
}

export function renderCaddyfile(
  c: Pick<Config, 'publicHost' | 'httpPort' | 'httpsPort' | 'acmeEmail' | 'acmeDns' | 'host' | 'port' | 'turn'>,
): string {
  const global = [
    '\tadmin off',
    // 0 = no redirect listener; Caddy keeps its default http_port 80 for ACME then.
    c.httpPort === 0 ? '\tauto_https disable_redirects' : `\thttp_port ${c.httpPort}`,
    `\thttps_port ${c.httpsPort}`,
    // The layer4 wrapper sees every connection on 443 before TLS: turn.<host>
    // is decrypted with Caddy's certificate and sent on to LiveKit's TURN with
    // a PROXY v2 header (LiveKit requires it, see renderLivekitYaml); the rest
    // falls through to the tls wrapper and the sites. TURN implies HTTPS_PORT 443.
    ...(c.turn
      ? [
        `\tservers :${c.httpsPort} {`,
        '\t\tlistener_wrappers {',
        '\t\t\tlayer4 {',
        `\t\t\t\t@turn tls sni ${c.turn.host}`,
        '\t\t\t\troute @turn {',
        // Caddy's default ALPN list (h2, http/1.1) refuses a client that offers
        // RFC 7443's stun.turn; one that offers none still gets through.
        '\t\t\t\t\ttls {',
        '\t\t\t\t\t\tconnection_policy {',
        '\t\t\t\t\t\t\talpn stun.turn',
        '\t\t\t\t\t\t}',
        '\t\t\t\t\t}',
        `\t\t\t\t\tproxy 127.0.0.1:${c.turn.port} {`,
        '\t\t\t\t\t\tproxy_protocol v2',
        '\t\t\t\t\t}',
        '\t\t\t\t}',
        '\t\t\t}',
        '\t\t\ttls',
        '\t\t}',
        '\t}',
      ]
      : []),
    // An explicit issuer ignores the global email, so DNS-01 sets it in its own block.
    ...(c.acmeEmail && !c.acmeDns ? [`\temail ${c.acmeEmail}`] : []),
  ];
  const tls = c.acmeDns
    ? [
      '\ttls {',
      '\t\tissuer acme {',
      ...(c.acmeEmail ? [`\t\t\temail ${c.acmeEmail}`] : []),
      `\t\t\tdns ${c.acmeDns.provider} {env.DUCKDNS_TOKEN}`,
      // Otherwise Caddy may try these first: a wasted try on a closed port, and
      // a listener on 80/443 that a home connection never lets through.
      '\t\t\tdisable_http_challenge',
      '\t\t\tdisable_tlsalpn_challenge',
      // Check the TXT record on public resolvers, not the home router's cache.
      '\t\t\tresolvers 1.1.1.1 8.8.8.8',
      '\t\t}',
      '\t}',
    ]
    : [];
  // Bare host as the site address: https_port picks the bind port, so a router
  // translating 443 -> 8443 just works.
  return [
    HEADER,
    '{',
    ...global,
    '}',
    '',
    `${c.publicHost} {`,
    ...tls,
    '\tencode zstd gzip',
    `\treverse_proxy ${upstreamHost(c.host)}:${c.port}`,
    '}',
    '',
    // Only so Caddy manages the TURN name's certificate: its connections never
    // reach the HTTP app (the layer4 wrapper takes them first).
    ...(c.turn ? [`${c.turn.host} {`, '\trespond 404', '}', ''] : []),
  ].join('\n');
}
