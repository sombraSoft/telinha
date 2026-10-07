// editorconfig-checker-disable-file: the expected Caddyfiles are tab-indented, as Caddy formats them.
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config.ts';
import { renderCaddyfile, renderLivekitYaml, upstreamHost } from '../src/render.ts';

const PROD_ENV = {
  DISCORD_TOKEN: 'tok',
  DISCORD_CLIENT_ID: 'cid',
  DISCORD_CLIENT_SECRET: 'csecret',
  GUILD_ID: '100',
  ROLE_ID: '200',
  CHANNEL_IDS: '300',
  PUBLIC_URL: 'https://tela.example.com',
  COOKIE_SECRET: 'secret',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'lksecret',
};
const DUCK_TOKEN = 'S3CR3T-duckdns-token'; // gitleaks:allow
const HOME = {
  PUBLIC_URL: 'https://my-group.duckdns.org:8443',
  HTTPS_PORT: '8443',
  HTTP_PORT: '0',
  ACME_DNS: 'duckdns',
  DUCKDNS_TOKEN: DUCK_TOKEN,
};
// TURN=on on an own domain: the VPS has added the turn.<host> record.
const TURN_ON = { HOSTING: 'vps', TURN: 'on' };
const caddy = (env: Record<string, string> = {}) => renderCaddyfile(loadConfig({ ...PROD_ENV, ...env }));
const livekit = (env: Record<string, string> = {}) => renderLivekitYaml(loadConfig({ ...PROD_ENV, ...env }));

describe('renderCaddyfile', () => {
  test('defaults', () => {
    expect(caddy()).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	http_port 80
	https_port 443
}

tela.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}
`);
  });

  test('with ACME_EMAIL', () => {
    expect(caddy({ ACME_EMAIL: 'ops@example.com' })).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	http_port 80
	https_port 443
	email ops@example.com
}

tela.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}
`);
  });

  test('custom ports: the site address stays the bare host', () => {
    expect(
      caddy({ PUBLIC_URL: 'https://tela.example.com:8443', HTTP_PORT: '8080', HTTPS_PORT: '8443' }),
    ).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	http_port 8080
	https_port 8443
}

tela.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}
`);
  });

  test('HTTP_PORT=0 disables the redirect listener', () => {
    expect(caddy({ HTTP_PORT: '0' })).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	auto_https disable_redirects
	https_port 443
}

tela.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}
`);
  });

  test('HTTPS_PORT=8443 behind a PUBLIC_URL on 443 (router translates)', () => {
    const out = caddy({ HTTPS_PORT: '8443' });
    expect(out).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	http_port 80
	https_port 8443
}

tela.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}
`);
    expect(out).not.toContain('tela.example.com:');
  });

  test('DNS-01 through DuckDNS: the home default', () => {
    const out = caddy(HOME);
    expect(out).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	auto_https disable_redirects
	https_port 8443
}

my-group.duckdns.org {
	tls {
		issuer acme {
			dns duckdns {env.DUCKDNS_TOKEN}
			disable_http_challenge
			disable_tlsalpn_challenge
			resolvers 1.1.1.1 8.8.8.8
		}
	}
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}
`);
    expect(out).not.toContain(DUCK_TOKEN);
  });

  test('DNS-01 with ACME_EMAIL: the email moves into the issuer block', () => {
    expect(caddy({ ...HOME, ACME_EMAIL: 'ops@example.com' })).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	auto_https disable_redirects
	https_port 8443
}

my-group.duckdns.org {
	tls {
		issuer acme {
			email ops@example.com
			dns duckdns {env.DUCKDNS_TOKEN}
			disable_http_challenge
			disable_tlsalpn_challenge
			resolvers 1.1.1.1 8.8.8.8
		}
	}
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}
`);
  });

  test('DNS-01 with HTTP_PORT=80 keeps the redirect listener', () => {
    const out = caddy({ ...HOME, PUBLIC_URL: 'https://my-group.duckdns.org', HTTPS_PORT: '443', HTTP_PORT: '80' });
    expect(out).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	http_port 80
	https_port 443
}

my-group.duckdns.org {
	tls {
		issuer acme {
			dns duckdns {env.DUCKDNS_TOKEN}
			disable_http_challenge
			disable_tlsalpn_challenge
			resolvers 1.1.1.1 8.8.8.8
		}
	}
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}
`);
    expect(out).not.toContain(DUCK_TOKEN);
  });

  test('LISTEN=[::1]:8081 brackets the IPv6 upstream', () => {
    expect(caddy({ LISTEN: '[::1]:8081' })).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	http_port 80
	https_port 443
}

tela.example.com {
	encode zstd gzip
	reverse_proxy [::1]:8081
}
`);
  });

  test('LISTEN=0.0.0.0:9000 proxies to loopback', () => {
    expect(caddy({ LISTEN: '0.0.0.0:9000' })).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	http_port 80
	https_port 443
}

tela.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:9000
}
`);
  });

  test('TURN on: layer4 takes turn.<host> on 443, a second site gets its certificate', () => {
    expect(caddy(TURN_ON)).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	http_port 80
	https_port 443
	servers :443 {
		listener_wrappers {
			layer4 {
				@turn tls sni turn.tela.example.com
				route @turn {
					tls {
						connection_policy {
							alpn stun.turn
						}
					}
					proxy 127.0.0.1:5349 {
						proxy_protocol v2
					}
				}
			}
			tls
		}
	}
}

tela.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}

turn.tela.example.com {
	respond 404
}
`);
  });

  test('TURN on with HTTP_PORT=0 and a custom TURN_PORT', () => {
    expect(
      caddy({ ...TURN_ON, HTTP_PORT: '0', TURN_PORT: '15349' }),
    ).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	auto_https disable_redirects
	https_port 443
	servers :443 {
		listener_wrappers {
			layer4 {
				@turn tls sni turn.tela.example.com
				route @turn {
					tls {
						connection_policy {
							alpn stun.turn
						}
					}
					proxy 127.0.0.1:15349 {
						proxy_protocol v2
					}
				}
			}
			tls
		}
	}
}

tela.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}

turn.tela.example.com {
	respond 404
}
`);
  });

  test('TURN on with ACME_EMAIL', () => {
    expect(
      caddy({ ...TURN_ON, ACME_EMAIL: 'ops@example.com' }),
    ).toBe(`# Rendered by telinha from telinha.env; do not edit.
{
	admin off
	http_port 80
	https_port 443
	servers :443 {
		listener_wrappers {
			layer4 {
				@turn tls sni turn.tela.example.com
				route @turn {
					tls {
						connection_policy {
							alpn stun.turn
						}
					}
					proxy 127.0.0.1:5349 {
						proxy_protocol v2
					}
				}
			}
			tls
		}
	}
	email ops@example.com
}

tela.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}

turn.tela.example.com {
	respond 404
}
`);
  });

  test('TURN=auto on a DuckDNS VPS turns the block on, TURN=off leaves the file as before', () => {
    const duck = { PUBLIC_URL: 'https://g.duckdns.org', HOSTING: 'vps' };
    expect(caddy(duck)).toContain('@turn tls sni turn.g.duckdns.org');
    expect(caddy(duck)).toContain('turn.g.duckdns.org {\n\trespond 404\n}\n');
    expect(caddy({ ...duck, TURN: 'off' })).not.toContain('turn');
  });

  test('upstreamHost', () => {
    expect(upstreamHost('0.0.0.0')).toBe('127.0.0.1');
    expect(upstreamHost('::')).toBe('127.0.0.1');
    expect(upstreamHost('')).toBe('127.0.0.1');
    expect(upstreamHost('::1')).toBe('[::1]');
    expect(upstreamHost('fd00::5')).toBe('[fd00::5]');
    expect(upstreamHost('10.0.0.2')).toBe('10.0.0.2');
    expect(upstreamHost('telinha.lan')).toBe('telinha.lan');
  });
});

describe('renderLivekitYaml', () => {
  test('defaults: public IP via STUN', () => {
    expect(livekit()).toBe(`# Rendered by telinha from telinha.env; do not edit.
port: 7880
bind_addresses:
  - 127.0.0.1
logging:
  level: info
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
room:
  auto_create: false
  empty_timeout: 420
  departure_timeout: 20
`);
  });

  test('LIVEKIT_NODE_IP and custom ports', () => {
    const out = livekit({
      LIVEKIT_NODE_IP: '203.0.113.7',
      LIVEKIT_PORT: '7890',
      MEDIA_TCP_PORT: '7891',
      MEDIA_UDP_PORT: '7892',
      CLOSE_EMPTY_SECONDS: '60',
    });
    expect(out).toBe(`# Rendered by telinha from telinha.env; do not edit.
port: 7890
bind_addresses:
  - 127.0.0.1
logging:
  level: info
rtc:
  tcp_port: 7891
  udp_port: 7892
  node_ip: 203.0.113.7
room:
  auto_create: false
  empty_timeout: 180
  departure_timeout: 20
`);
    expect(out).not.toContain('use_external_ip');
  });

  test('TURN on: plain TCP behind Caddy, PROXY header required', () => {
    const out = livekit(TURN_ON);
    expect(out).toBe(`# Rendered by telinha from telinha.env; do not edit.
port: 7880
bind_addresses:
  - 127.0.0.1
logging:
  level: info
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
room:
  auto_create: false
  empty_timeout: 420
  departure_timeout: 20
turn:
  enabled: true
  domain: turn.tela.example.com
  tls_port: 5349
  external_tls: true
  proxy_protocol: true
`);
    // The relay sockets share TURN's bind_addresses: loopback would break relaying.
    expect(out.split('turn:')[1]).not.toContain('bind_addresses');
    expect(out).not.toMatch(/^\s+udp_port: (?!7882)/m);
  });

  test('TURN off: no turn block', () => {
    expect(livekit({ ...TURN_ON, TURN: 'off' })).not.toContain('turn:');
  });

  test('keys never go in the file', () => {
    expect(livekit()).not.toContain('lksecret');
    expect(livekit()).not.toContain('devkey');
  });
});

describe('PROXY protocol contract', () => {
  // LiveKit closes TURN connections without the header, so both sides flip together.
  test('both files from one TURN config agree', () => {
    const c = loadConfig({ ...PROD_ENV, ...TURN_ON, TURN_PORT: '6000' });
    const yaml = renderLivekitYaml(c);
    const caddyfile = renderCaddyfile(c);
    expect(yaml).toContain('  proxy_protocol: true\n');
    expect(yaml).toContain('  tls_port: 6000\n');
    expect(caddyfile).toContain('\t\t\t\t\tproxy 127.0.0.1:6000 {\n\t\t\t\t\t\tproxy_protocol v2\n\t\t\t\t\t}\n');
    expect(yaml).toContain(`  domain: ${c.turn!.host}\n`);
    expect(caddyfile).toContain(`@turn tls sni ${c.turn!.host}\n`);
  });
});
