import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config.ts';
import { renderCaddyfile, renderLivekitYaml, upstreamHost } from '../src/render.ts';

const PROD_ENV = {
  DISCORD_TOKEN: 'tok', DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret',
  GUILD_ID: '100', ROLE_ID: '200', CHANNEL_IDS: '300',
  PUBLIC_URL: 'https://tela.example.com', COOKIE_SECRET: 'secret',
  LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'lksecret',
};
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
    expect(caddy({ PUBLIC_URL: 'https://tela.example.com:8443', HTTP_PORT: '8080', HTTPS_PORT: '8443' }))
      .toBe(`# Rendered by telinha from telinha.env; do not edit.
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
      LIVEKIT_NODE_IP: '203.0.113.7', LIVEKIT_PORT: '7890', MEDIA_TCP_PORT: '7891', MEDIA_UDP_PORT: '7892', CLOSE_EMPTY_SECONDS: '60',
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

  test('keys never go in the file', () => {
    expect(livekit()).not.toContain('lksecret');
    expect(livekit()).not.toContain('devkey');
  });
});
