import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KNOWN_KEYS, loadConfig, parseListen, turnIneligibility, upnpMappings } from '../src/config.ts';
import { ENV_TEMPLATE, renderEnvFile } from '../src/cli/setup/envwrite.ts';
import { parseEnvFile } from '../src/envfile.ts';
import { resolvePaths } from '../src/paths.ts';

// Own fixtures (not helpers.ts) so this suite pins exactly what loadConfig sees.
const PROD_ENV = {
  DISCORD_TOKEN: 'tok', DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'csecret',
  GUILD_ID: '100', ROLE_ID: '200', CHANNEL_IDS: '300, 301,,',
  PUBLIC_URL: 'https://tela.example.com/', COOKIE_SECRET: 'secret',
  LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'lksecret',
};
const DEV_ENV = { DEV_USER: '1:Dev', PUBLIC_URL: 'http://localhost:5173', COOKIE_SECRET: 'x', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' };
const TUNNEL_ENV = { ...PROD_ENV, INGRESS: 'tunnel', TUNNEL_TOKEN: 'tt' };
// What the wizard writes for a home without a domain: DuckDNS name, HTTPS on 8443, DNS-01.
const HOME_ENV = {
  ...PROD_ENV, PUBLIC_URL: 'https://g.duckdns.org:8443', HTTPS_PORT: '8443', HTTP_PORT: '0', ACME_DNS: 'duckdns',
  DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'g', DUCKDNS_TOKEN: 'duck-secret-token', // gitleaks:allow
};
const CLOUD_ENV = { ...PROD_ENV, MEDIA: 'cloud', LIVEKIT_CLOUD_URL: 'wss://proj-abc123.livekit.cloud' };
// What the wizard writes for a VPS on a DuckDNS name: HTTPS on 443, HTTP challenge on 80.
const VPS_DUCK_ENV = { ...PROD_ENV, PUBLIC_URL: 'https://g.duckdns.org', HOSTING: 'vps' };

describe('loadConfig', () => {
  test('production defaults', () => {
    const c = loadConfig(PROD_ENV);
    expect(c.dev).toBeNull();
    expect(c.publicUrl).toBe('https://tela.example.com');
    expect(c.channelIds).toEqual(['300', '301']);
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8081);
    expect(c.sessionSeconds).toBe(7 * 86400);
    expect(c.roleTtlMs).toBe(300_000);
    expect(c.livekitUrl).toBe('wss://tela.example.com/livekit');
    expect(c.secureCookies).toBe(true);
    expect(c.groupName).toBeUndefined();
    expect(c.webDir.replaceAll('\\', '/')).toEndWith('web/dist/');
    expect(c.livekitApiUrl).toBe('http://127.0.0.1:7880');
    expect(c.closeEmptySeconds).toBe(300);
    expect(c.pollSeconds).toBe(5);
  });

  test('defaults of the deploy-anywhere keys', () => {
    const c = loadConfig(PROD_ENV);
    expect(c.commandName).toBe('telinha');
    expect(c.ingress).toBe('direct');
    expect(c.media).toBe('self');
    expect(c.publicHost).toBe('tela.example.com');
    expect(c.httpPort).toBe(80);
    expect(c.httpsPort).toBe(443);
    expect(c.acmeEmail).toBeUndefined();
    expect(c.acmeDns).toBeNull();
    expect(c.hosting).toBeNull();
    expect(c.tunnelToken).toBeUndefined();
    expect(c.livekitPort).toBe(7880);
    expect(c.mediaTcpPort).toBe(7881);
    expect(c.mediaUdpPort).toBe(7882);
    expect(c.livekitNodeIp).toBeUndefined();
    expect(c.ipWatchSeconds).toBe(300);
    expect(c.warnings).toEqual([]);
    expect(c.paths).toEqual(resolvePaths(PROD_ENV));
    expect(c.dataDir).toBe(c.paths.data);
    expect(c.upnp).toBe(true);
    expect(c.ddns).toBeNull();
    expect(c.autoUpdate).toBe(false);
    expect(c.updatePin).toBeUndefined();
    expect([c.updateCheckHours, c.updateMaxDeferHours]).toEqual([6, 12]);
    expect(c.locale).toBeUndefined();
    expect(c.livekitCloudHost).toBeUndefined();
    expect(c.turnSetting).toBe('auto');
    expect(c.turnPort).toBe(5349);
    expect(c.turn).toBeNull();
  });

  test('optional overrides', () => {
    const c = loadConfig({
      ...PROD_ENV, GROUP_NAME: 'Crew', LIVEKIT_PUBLIC_URL: 'wss://lk.example.com', WEB_DIR: '/srv/web',
      LISTEN: '[::1]:9000', SESSION_DAYS: '1', ROLE_CACHE_SECONDS: '10',
      LIVEKIT_API_URL: 'http://10.0.0.5:7880/', DATA_DIR: '/data', CLOSE_EMPTY_SECONDS: '4', POLL_SECONDS: '1',
      COMMAND_NAME: 'tela', HTTP_PORT: '8080', HTTPS_PORT: '443', ACME_EMAIL: 'a@b.c',
      LIVEKIT_PORT: '7990', MEDIA_TCP_PORT: '7891', MEDIA_UDP_PORT: '7892', IP_WATCH_SECONDS: '60',
    });
    expect(c.livekitApiUrl).toBe('http://10.0.0.5:7880');
    expect(c.dataDir).toBe('/data');
    expect(c.paths.data).toBe('/data');
    expect(c.closeEmptySeconds).toBe(4);
    expect(c.pollSeconds).toBe(1);
    expect(c.groupName).toBe('Crew');
    expect(c.livekitUrl).toBe('wss://lk.example.com');
    expect(c.webDir).toBe('/srv/web');
    expect([c.host, c.port]).toEqual(['::1', 9000]);
    expect(c.sessionSeconds).toBe(86400);
    expect(c.roleTtlMs).toBe(10_000);
    expect(c.commandName).toBe('tela');
    expect([c.httpPort, c.httpsPort]).toEqual([8080, 443]);
    expect(c.acmeEmail).toBe('a@b.c');
    expect([c.livekitPort, c.mediaTcpPort, c.mediaUdpPort]).toEqual([7990, 7891, 7892]);
    expect(c.ipWatchSeconds).toBe(60);
  });

  test('LIVEKIT_API_URL follows LIVEKIT_PORT', () => {
    expect(loadConfig({ ...PROD_ENV, LIVEKIT_PORT: '7990' }).livekitApiUrl).toBe('http://127.0.0.1:7990');
  });

  test('bad LIVEKIT_API_URL fails at startup, not per join', () => {
    for (const bad of ['ftp://x', 'http://bad host', '127.0.0.1:7880', 'wss://lk.example.com']) {
      expect(() => loadConfig({ ...PROD_ENV, LIVEKIT_API_URL: bad })).toThrow('bad LIVEKIT_API_URL');
    }
    expect(loadConfig({ ...PROD_ENV, LIVEKIT_API_URL: 'https://lk.example.com' }).livekitApiUrl).toBe('https://lk.example.com');
  });

  test('missing required env', () => {
    for (const k of Object.keys(PROD_ENV)) {
      const env: Record<string, string> = { ...PROD_ENV };
      delete env[k];
      expect(() => loadConfig(env)).toThrow(`missing env ${k}`);
    }
    expect(() => loadConfig({ ...PROD_ENV, COOKIE_SECRET: '' })).toThrow('missing env COOKIE_SECRET');
  });

  test('bad numbers and LISTEN', () => {
    expect(() => loadConfig({ ...PROD_ENV, SESSION_DAYS: 'x' })).toThrow('bad SESSION_DAYS');
    expect(() => loadConfig({ ...PROD_ENV, CLOSE_EMPTY_SECONDS: '0' })).toThrow('bad CLOSE_EMPTY_SECONDS');
    expect(() => loadConfig({ ...PROD_ENV, POLL_SECONDS: '-1' })).toThrow('bad POLL_SECONDS');
    expect(() => loadConfig({ ...PROD_ENV, LISTEN: '8081' })).toThrow('bad LISTEN');
    expect(() => loadConfig({ ...PROD_ENV, PUBLIC_URL: 'tela.example.com' })).toThrow('bad PUBLIC_URL');
    expect(() => loadConfig({ ...PROD_ENV, PUBLIC_URL: 'ftp://tela.example.com' })).toThrow('bad PUBLIC_URL');
  });

  test('bad ports', () => {
    for (const k of ['LIVEKIT_PORT', 'MEDIA_TCP_PORT', 'MEDIA_UDP_PORT', 'HTTPS_PORT']) {
      for (const v of ['0', '65536', '1.5', 'x', '-1']) expect(() => loadConfig({ ...PROD_ENV, [k]: v })).toThrow(`bad ${k}`);
    }
    for (const v of ['65536', '1.5', 'x', '-1']) expect(() => loadConfig({ ...PROD_ENV, HTTP_PORT: v })).toThrow('bad HTTP_PORT');
  });

  test('INGRESS and MEDIA values', () => {
    expect(() => loadConfig({ ...PROD_ENV, INGRESS: 'caddy' })).toThrow('bad INGRESS caddy');
    expect(() => loadConfig({ ...PROD_ENV, MEDIA: 'sfu' })).toThrow('bad MEDIA sfu');
    expect(loadConfig(CLOUD_ENV).media).toBe('cloud');
  });

  test('LIVEKIT_CLOUD_URL is ignored silently with MEDIA=self', () => {
    const c = loadConfig({ ...PROD_ENV, LIVEKIT_CLOUD_URL: 'wss://x.livekit.cloud' });
    expect(c.warnings).toEqual([]);
    expect(c.livekitCloudHost).toBeUndefined();
    expect(c.livekitUrl).toBe('wss://tela.example.com/livekit');
  });

  test('KNOWN_KEYS covers the schema, not the removed LIVEKIT_KEYS or TURN_TLS_PORT', () => {
    for (const k of [...Object.keys(PROD_ENV), 'INGRESS', 'MEDIA', 'TUNNEL_TOKEN', 'TELINHA_ENV', 'BIN_DIR', 'DEV_USER', 'DUCKDNS_TOKEN', 'HOSTING', 'ACME_DNS', 'LIVEKIT_CLOUD_URL', 'TURN', 'TURN_PORT']) {
      expect(KNOWN_KEYS.has(k)).toBe(true);
    }
    expect(KNOWN_KEYS.has('LIVEKIT_KEYS')).toBe(false);
    // TURN_PORT took its place; the public TURN port is always 443.
    expect(KNOWN_KEYS.has('TURN_TLS_PORT')).toBe(false);
    expect(KNOWN_KEYS.has('PATH')).toBe(false);
  });

  test('telinha.env.example lists exactly KNOWN_KEYS and parses without warnings', () => {
    const text = readFileSync(new URL('../../deploy/telinha.env.example', import.meta.url), 'utf8');
    const listed = [...text.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(new Set(listed)).toEqual(new Set(KNOWN_KEYS));
    expect(listed.length).toBe(KNOWN_KEYS.size);
    expect(parseEnvFile(text).warnings).toEqual([]);
  });

  test('the wizard writes the documented layout: same sections and keys as telinha.env.example', () => {
    const example = readFileSync(new URL('../../deploy/telinha.env.example', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(ENV_TEMPLATE).toBe(example);
    const rendered = renderEnvFile({}, null);
    const sections = (t: string) => [...t.matchAll(/^# --- (.+?) -+$/gm)].map((m) => m[1]);
    const keys = (t: string) => [...t.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect(sections(rendered)).toEqual(sections(example));
    expect(keys(rendered)).toEqual(keys(example));
  });
});

describe('UPnP, DuckDNS, updates, LOCALE', () => {
  test('UPNP auto | off', () => {
    expect(loadConfig({ ...PROD_ENV, UPNP: 'auto' }).upnp).toBe(true);
    expect(loadConfig({ ...PROD_ENV, UPNP: 'off' }).upnp).toBe(false);
    expect(() => loadConfig({ ...PROD_ENV, UPNP: 'on' })).toThrow('bad UPNP on');
  });

  test('DDNS_PROVIDER=duckdns needs both DUCKDNS keys; none ignores them', () => {
    const duck = { ...PROD_ENV, PUBLIC_URL: 'https://gang.duckdns.org', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'gang', DUCKDNS_TOKEN: 'tk' };
    const c = loadConfig(duck);
    expect(c.ddns).toEqual({ provider: 'duckdns', domain: 'gang', token: 'tk' });
    expect(c.warnings).toEqual([]);
    expect(() => loadConfig({ ...duck, DUCKDNS_TOKEN: '' })).toThrow('missing env DUCKDNS_TOKEN');
    expect(() => loadConfig({ ...duck, DUCKDNS_DOMAIN: '' })).toThrow('missing env DUCKDNS_DOMAIN');
    expect(loadConfig({ ...PROD_ENV, DUCKDNS_DOMAIN: 'gang', DUCKDNS_TOKEN: 'tk' }).ddns).toBeNull();
    expect(() => loadConfig({ ...PROD_ENV, DDNS_PROVIDER: 'noip' })).toThrow('bad DDNS_PROVIDER noip');
  });

  test('DUCKDNS_DOMAIN: suffix stripped with a warning, bad names refused, host mismatch warned', () => {
    const duck = { ...PROD_ENV, PUBLIC_URL: 'https://gang.duckdns.org', DDNS_PROVIDER: 'duckdns', DUCKDNS_TOKEN: 'tk' };
    const c = loadConfig({ ...duck, DUCKDNS_DOMAIN: 'Gang.duckdns.org' });
    expect(c.ddns?.domain).toBe('gang');
    expect(c.warnings).toEqual(['config: DUCKDNS_DOMAIN is the subdomain alone; using gang']);
    for (const bad of ['a.b', 'with space', 'x'.repeat(64), 'ü']) {
      expect(() => loadConfig({ ...duck, DUCKDNS_DOMAIN: bad })).toThrow('bad DUCKDNS_DOMAIN');
    }
    expect(loadConfig({ ...duck, DUCKDNS_DOMAIN: 'other' }).warnings).toEqual([
      "config: DuckDNS updates other.duckdns.org but PUBLIC_URL's host is gang.duckdns.org",
    ]);
  });

  test('AUTO_UPDATE: on by default in the native binary, forced off from source with a warning', () => {
    expect(loadConfig(PROD_ENV, { compiled: true }).autoUpdate).toBe(true);
    expect(loadConfig({ ...PROD_ENV, AUTO_UPDATE: 'off' }, { compiled: true }).autoUpdate).toBe(false);
    const dev = loadConfig({ ...PROD_ENV, AUTO_UPDATE: 'on' });
    expect(dev.autoUpdate).toBe(false);
    expect(dev.warnings[0]).toContain('AUTO_UPDATE=on applies to the native binary only');
    expect(loadConfig({ ...PROD_ENV, AUTO_UPDATE: 'off' }).warnings).toEqual([]);
    expect(() => loadConfig({ ...PROD_ENV, AUTO_UPDATE: 'yes' })).toThrow('bad AUTO_UPDATE yes');
  });

  test('UPDATE_PIN is a release tag; hours are bounded', () => {
    expect(loadConfig({ ...PROD_ENV, UPDATE_PIN: 'v1.2.3' }).updatePin).toBe('v1.2.3');
    expect(loadConfig({ ...PROD_ENV, UPDATE_PIN: 'v1.2.3-rc.1' }).updatePin).toBe('v1.2.3-rc.1');
    for (const bad of ['1.2.3', 'v1.2', 'latest', 'v1.2.3 ']) {
      expect(() => loadConfig({ ...PROD_ENV, UPDATE_PIN: bad })).toThrow('bad UPDATE_PIN');
    }
    const c = loadConfig({ ...PROD_ENV, UPDATE_CHECK_HOURS: '1', UPDATE_MAX_DEFER_HOURS: '0' });
    expect([c.updateCheckHours, c.updateMaxDeferHours]).toEqual([1, 0]);
    for (const v of ['0', '169', '1.5']) expect(() => loadConfig({ ...PROD_ENV, UPDATE_CHECK_HOURS: v })).toThrow('bad UPDATE_CHECK_HOURS');
    for (const v of ['-1', '721']) expect(() => loadConfig({ ...PROD_ENV, UPDATE_MAX_DEFER_HOURS: v })).toThrow('bad UPDATE_MAX_DEFER_HOURS');
  });

  test('LOCALE: en or pt-BR, as people spell them', () => {
    expect(loadConfig({ ...PROD_ENV, LOCALE: 'pt-BR' }).locale).toBe('pt-BR');
    expect(loadConfig({ ...PROD_ENV, LOCALE: 'pt_BR' }).locale).toBe('pt-BR');
    expect(loadConfig({ ...PROD_ENV, LOCALE: 'en' }).locale).toBe('en');
    expect(() => loadConfig({ ...PROD_ENV, LOCALE: 'fr' })).toThrow('bad LOCALE fr');
  });

  test('WEB_DIR wins; the source tree is the fallback when no page is embedded', () => {
    expect(loadConfig({ ...PROD_ENV, WEB_DIR: '/srv/web' }, { compiled: true }).webDir).toBe('/srv/web');
    // A test run is not the binary: nothing embedded, so web/dist even with compiled set.
    expect(loadConfig(PROD_ENV, { compiled: true }).webDir.replaceAll('\\', '/')).toEndWith('web/dist/');
  });
});

describe('INGRESS=direct', () => {
  test('requires an https PUBLIC_URL', () => {
    expect(() => loadConfig({ ...PROD_ENV, PUBLIC_URL: 'http://tela.example.com' })).toThrow('INGRESS=direct requires an https:// PUBLIC_URL');
  });

  test('publicHost is the bare hostname, with or without a URL port', () => {
    expect(loadConfig(PROD_ENV).publicHost).toBe('tela.example.com');
    const c = loadConfig(HOME_ENV);
    expect(c.publicHost).toBe('g.duckdns.org');
    expect(c.warnings).toEqual([]);
  });

  test('URL port != HTTPS_PORT is a warning, not an error', () => {
    const c = loadConfig({ ...PROD_ENV, HTTPS_PORT: '8443' });
    expect(c.httpsPort).toBe(8443);
    expect(c.warnings).toEqual(['config: PUBLIC_URL port 443 differs from HTTPS_PORT 8443; assuming the router translates 443 -> 8443']);
    expect(loadConfig({ ...HOME_ENV, HTTPS_PORT: '443' }).warnings)
      .toEqual(['config: PUBLIC_URL port 8443 differs from HTTPS_PORT 443; assuming the router translates 8443 -> 443']);
  });

  test('a high PUBLIC_URL port without DNS-01 is refused with HTTP_PORT=0, warned otherwise', () => {
    const high = { ...PROD_ENV, PUBLIC_URL: 'https://x.example.com:8443', HTTPS_PORT: '8443', HTTP_PORT: '0' };
    expect(() => loadConfig(high)).toThrow(
      "PUBLIC_URL uses port 8443 and HTTP_PORT=0: Let's Encrypt validates only over public port 80 or 443, so this needs ACME_DNS=duckdns (a DuckDNS name) or a PUBLIC_URL on port 443",
    );
    expect(loadConfig({ ...high, HTTP_PORT: '80' }).warnings)
      .toEqual(['config: PUBLIC_URL uses port 8443; without ACME_DNS the certificate needs public port 80 reaching HTTP_PORT 80']);
    // Port 443 with HTTP_PORT=0 still has the TLS-ALPN challenge.
    expect(loadConfig({ ...PROD_ENV, HTTP_PORT: '0' }).warnings).toEqual([]);
    // Outside direct mode Caddy fetches no certificate.
    expect(() => loadConfig({ ...high, INGRESS: 'external' })).not.toThrow();
  });

  test('ACME_EMAIL only in direct mode', () => {
    expect(loadConfig({ ...PROD_ENV, ACME_EMAIL: 'a@b.c' }).acmeEmail).toBe('a@b.c');
    expect(loadConfig({ ...TUNNEL_ENV, ACME_EMAIL: 'a@b.c' }).acmeEmail).toBeUndefined();
  });

  test('HTTP_PORT=0 disables the redirect listener', () => {
    expect(loadConfig({ ...PROD_ENV, HTTP_PORT: '0' }).httpPort).toBe(0);
  });
});

describe('HOSTING and ACME_DNS', () => {
  test('HOSTING: home | vps | unset', () => {
    expect(loadConfig({ ...PROD_ENV, HOSTING: 'home' }).hosting).toBe('home');
    expect(loadConfig({ ...PROD_ENV, HOSTING: 'vps' }).hosting).toBe('vps');
    expect(loadConfig({ ...PROD_ENV, HOSTING: '' }).hosting).toBeNull();
    expect(() => loadConfig({ ...PROD_ENV, HOSTING: 'cloud' })).toThrow('bad HOSTING cloud (want home | vps)');
  });

  test('the home default loads with no warnings', () => {
    const c = loadConfig(HOME_ENV);
    expect(c.acmeDns).toEqual({ provider: 'duckdns', token: 'duck-secret-token' }); // gitleaks:allow
    expect([c.httpsPort, c.httpPort]).toEqual([8443, 0]);
    expect(c.warnings).toEqual([]);
  });

  test('ACME_DNS=duckdns needs DUCKDNS_TOKEN and a duckdns.org host', () => {
    expect(() => loadConfig({ ...HOME_ENV, DUCKDNS_TOKEN: '', DDNS_PROVIDER: 'none' })).toThrow('missing env DUCKDNS_TOKEN');
    expect(() => loadConfig({ ...HOME_ENV, DDNS_PROVIDER: 'none', PUBLIC_URL: 'https://tela.example.com:8443' }))
      .toThrow('ACME_DNS=duckdns needs a PUBLIC_URL host under duckdns.org (got tela.example.com)');
    // DNS-01 without the DDNS updater (a static IP) is fine.
    expect(loadConfig({ ...HOME_ENV, DDNS_PROVIDER: 'none' }).acmeDns?.provider).toBe('duckdns');
    expect(() => loadConfig({ ...HOME_ENV, ACME_DNS: 'cloudflare' })).toThrow('bad ACME_DNS cloudflare (want none | duckdns)');
    expect(loadConfig({ ...PROD_ENV, ACME_DNS: 'none' }).acmeDns).toBeNull();
  });

  test('ACME_DNS outside direct mode is ignored with a warning; no warning holds the token', () => {
    const c = loadConfig({ ...TUNNEL_ENV, ACME_DNS: 'duckdns', DUCKDNS_TOKEN: 'duck-secret-token' }); // gitleaks:allow
    expect(c.acmeDns).toBeNull();
    expect(c.warnings).toEqual(['config: ACME_DNS only applies to INGRESS=direct; ignored']);
    const translated = loadConfig({ ...HOME_ENV, HTTPS_PORT: '9443', DUCKDNS_DOMAIN: 'other' });
    expect(translated.warnings.length).toBe(2);
    expect(translated.warnings.join(' ')).not.toContain('duck-secret-token');
  });

  test('dev mode ignores ACME_DNS', () => {
    const c = loadConfig({ ...DEV_ENV, ACME_DNS: 'duckdns' });
    expect(c.acmeDns).toBeNull();
    expect(c.warnings).toEqual([]);
  });
});

describe('INGRESS=tunnel', () => {
  test('requires TUNNEL_TOKEN and an https PUBLIC_URL', () => {
    const c = loadConfig(TUNNEL_ENV);
    expect(c.ingress).toBe('tunnel');
    expect(c.tunnelToken).toBe('tt');
    expect(c.warnings).toEqual([]);
    expect(() => loadConfig({ ...TUNNEL_ENV, TUNNEL_TOKEN: '' })).toThrow('missing env TUNNEL_TOKEN');
    expect(() => loadConfig({ ...TUNNEL_ENV, PUBLIC_URL: 'http://tela.example.com' })).toThrow('INGRESS=tunnel requires an https:// PUBLIC_URL');
  });

  test('HTTPS_PORT is not compared with the URL port', () => {
    expect(loadConfig({ ...TUNNEL_ENV, HTTPS_PORT: '8443' }).warnings).toEqual([]);
  });

  test('TUNNEL_TOKEN is ignored outside tunnel mode', () => {
    expect(loadConfig({ ...PROD_ENV, TUNNEL_TOKEN: 'tt' }).tunnelToken).toBeUndefined();
  });
});

describe('INGRESS=external', () => {
  test('no extra rule: plain http and any HTTPS_PORT are fine', () => {
    const c = loadConfig({ ...PROD_ENV, INGRESS: 'external', PUBLIC_URL: 'http://tela.lan:8000', HTTPS_PORT: '8443' });
    expect(c.ingress).toBe('external');
    expect(c.publicHost).toBe('tela.lan');
    expect(c.secureCookies).toBe(false);
    expect(c.warnings).toEqual([]);
  });
});

describe('port collisions', () => {
  test('media, LiveKit and LISTEN ports in every mode', () => {
    for (const env of [PROD_ENV, TUNNEL_ENV, { ...PROD_ENV, INGRESS: 'external' }, DEV_ENV]) {
      expect(() => loadConfig({ ...env, MEDIA_UDP_PORT: '7881' })).toThrow('ports collide: MEDIA_TCP_PORT=7881, MEDIA_UDP_PORT=7881');
      expect(() => loadConfig({ ...env, LIVEKIT_PORT: '7882' })).toThrow('ports collide: MEDIA_UDP_PORT=7882, LIVEKIT_PORT=7882');
      expect(() => loadConfig({ ...env, LISTEN: '127.0.0.1:7880' })).toThrow('ports collide: LIVEKIT_PORT=7880, LISTEN=7880');
    }
  });

  test('HTTPS_PORT and HTTP_PORT join the set in direct mode', () => {
    expect(() => loadConfig({ ...PROD_ENV, HTTPS_PORT: '8081' })).toThrow('ports collide: LISTEN=8081, HTTPS_PORT=8081');
    expect(() => loadConfig({ ...PROD_ENV, HTTP_PORT: '8081' })).toThrow('ports collide: LISTEN=8081, HTTP_PORT=8081');
    expect(() => loadConfig({ ...PROD_ENV, HTTPS_PORT: '7880' })).toThrow('ports collide: LIVEKIT_PORT=7880, HTTPS_PORT=7880');
    expect(() => loadConfig({ ...PROD_ENV, HTTP_PORT: '7881' })).toThrow('ports collide: MEDIA_TCP_PORT=7881, HTTP_PORT=7881');
    expect(() => loadConfig({ ...PROD_ENV, MEDIA_UDP_PORT: '443' })).toThrow('ports collide: MEDIA_UDP_PORT=443, HTTPS_PORT=443');
    expect(() => loadConfig({ ...PROD_ENV, HTTP_PORT: '443' })).toThrow('ports collide: HTTPS_PORT=443, HTTP_PORT=443');
  });

  test('HTTP_PORT=0 is not a port', () => {
    expect(loadConfig({ ...PROD_ENV, HTTP_PORT: '0', LISTEN: '127.0.0.1:8081' }).httpPort).toBe(0);
  });
});

describe('MEDIA=cloud', () => {
  test('defaults: browsers and RoomService go straight to the Cloud host', () => {
    const c = loadConfig(CLOUD_ENV);
    expect(c.media).toBe('cloud');
    expect(c.livekitCloudHost).toBe('proj-abc123.livekit.cloud');
    expect(c.livekitUrl).toBe('wss://proj-abc123.livekit.cloud');
    expect(c.livekitApiUrl).toBe('https://proj-abc123.livekit.cloud');
    expect(c.livekitKey).toBe('devkey');
    expect(c.turn).toBeNull();
    expect(c.warnings).toEqual([]);
  });

  test('LIVEKIT_CLOUD_URL is required', () => {
    expect(() => loadConfig({ ...CLOUD_ENV, LIVEKIT_CLOUD_URL: '' })).toThrow('missing env LIVEKIT_CLOUD_URL');
  });

  test('https:// accepted; path, query and trailing slash dropped', () => {
    for (const u of ['https://proj-abc123.livekit.cloud', 'wss://proj-abc123.livekit.cloud/', 'wss://proj-abc123.livekit.cloud/rtc?x=1', 'https://proj-abc123.livekit.cloud/a/b/']) {
      const c = loadConfig({ ...CLOUD_ENV, LIVEKIT_CLOUD_URL: u });
      expect([c.livekitUrl, c.livekitApiUrl]).toEqual(['wss://proj-abc123.livekit.cloud', 'https://proj-abc123.livekit.cloud']);
    }
  });

  test('bad schemes and hostless values are refused', () => {
    for (const bad of ['proj.livekit.cloud', 'ws://proj.livekit.cloud', 'http://proj.livekit.cloud', 'ftp://proj.livekit.cloud', 'wss://', 'not a url']) {
      expect(() => loadConfig({ ...CLOUD_ENV, LIVEKIT_CLOUD_URL: bad })).toThrow('bad LIVEKIT_CLOUD_URL');
    }
  });

  test('dev may point at a plain ws/http stand-in', () => {
    const c = loadConfig({ ...DEV_ENV, MEDIA: 'cloud', LIVEKIT_CLOUD_URL: 'ws://localhost:7880' });
    expect([c.livekitUrl, c.livekitApiUrl, c.livekitCloudHost]).toEqual(['ws://localhost:7880', 'http://localhost:7880', 'localhost:7880']);
    expect(loadConfig({ ...DEV_ENV, MEDIA: 'cloud', LIVEKIT_CLOUD_URL: 'http://127.0.0.1:7880/' }).livekitUrl).toBe('ws://127.0.0.1:7880');
  });

  test('self-only keys are warned and ignored when set to something else than their default', () => {
    const c = loadConfig({
      ...CLOUD_ENV, LIVEKIT_PORT: '7990', MEDIA_TCP_PORT: '7891', MEDIA_UDP_PORT: '7892',
      LIVEKIT_API_URL: 'http://10.0.0.5:7880', LIVEKIT_PUBLIC_URL: 'wss://lk.example.com',
    });
    expect(c.warnings).toEqual(['LIVEKIT_PORT', 'MEDIA_TCP_PORT', 'MEDIA_UDP_PORT', 'LIVEKIT_API_URL', 'LIVEKIT_PUBLIC_URL']
      .map((k) => `config: ${k} only applies to MEDIA=self; ignored`));
    expect(c.livekitUrl).toBe('wss://proj-abc123.livekit.cloud');
    expect(c.livekitApiUrl).toBe('https://proj-abc123.livekit.cloud');
    const same = loadConfig({ ...CLOUD_ENV, LIVEKIT_PORT: '7880', MEDIA_TCP_PORT: '7881', MEDIA_UDP_PORT: '7882', LIVEKIT_API_URL: 'http://127.0.0.1:7880/' });
    expect(same.warnings).toEqual([]);
    // Not validated either: nothing uses it.
    expect(loadConfig({ ...CLOUD_ENV, LIVEKIT_API_URL: 'ftp://x' }).warnings).toEqual(['config: LIVEKIT_API_URL only applies to MEDIA=self; ignored']);
  });

  test('LIVEKIT_NODE_IP and IP_WATCH_SECONDS keep their meaning, no warning', () => {
    expect(loadConfig({ ...CLOUD_ENV, IP_WATCH_SECONDS: '60' })).toMatchObject({ ipWatchSeconds: 60, warnings: [] });
    expect(loadConfig({ ...CLOUD_ENV, LIVEKIT_NODE_IP: '203.0.113.7' })).toMatchObject({ livekitNodeIp: '203.0.113.7', ipWatchSeconds: 0, warnings: [] });
  });

  test('works with a tunnel', () => {
    expect(loadConfig({ ...CLOUD_ENV, INGRESS: 'tunnel', TUNNEL_TOKEN: 'tt' }).livekitUrl).toBe('wss://proj-abc123.livekit.cloud');
  });
});

describe('TURN', () => {
  const NOT_HERE = (why: string) =>
    `TURN=on is not possible here: ${why}. TURN over TLS on 443 is for a VPS in direct mode on port 443.`;

  test('auto on a DuckDNS VPS in direct mode on 443: on, turn.<host> on 5349', () => {
    const c = loadConfig(VPS_DUCK_ENV);
    expect(c.turnSetting).toBe('auto');
    expect(c.turn).toEqual({ host: 'turn.g.duckdns.org', port: 5349 });
    expect(c.warnings).toEqual([]);
    expect(loadConfig({ ...VPS_DUCK_ENV, HTTP_PORT: '0' }).turn?.host).toBe('turn.g.duckdns.org');
  });

  test('auto on sslip.io: on', () => {
    expect(loadConfig({ ...PROD_ENV, PUBLIC_URL: 'https://1-2-3-4.sslip.io', HOSTING: 'vps' }).turn)
      .toEqual({ host: 'turn.1-2-3-4.sslip.io', port: 5349 });
  });

  test('auto on an own domain: off until TURN=on (turn.<host> needs a record)', () => {
    expect(loadConfig({ ...PROD_ENV, HOSTING: 'vps' }).turn).toBeNull();
    expect(loadConfig({ ...PROD_ENV, HOSTING: 'vps', TURN: 'on' }).turn).toEqual({ host: 'turn.tela.example.com', port: 5349 });
  });

  test('auto with HOSTING unset: off; TURN=on there: on', () => {
    const env = { ...PROD_ENV, PUBLIC_URL: 'https://g.duckdns.org' };
    expect(loadConfig(env).turn).toBeNull();
    expect(loadConfig({ ...env, TURN: 'on' }).turn).toEqual({ host: 'turn.g.duckdns.org', port: 5349 });
  });

  test('auto where not eligible: off, no error', () => {
    for (const env of [HOME_ENV, { ...VPS_DUCK_ENV, HOSTING: 'home' }, { ...VPS_DUCK_ENV, INGRESS: 'tunnel', TUNNEL_TOKEN: 'tt' },
      { ...VPS_DUCK_ENV, MEDIA: 'cloud', LIVEKIT_CLOUD_URL: 'wss://p.livekit.cloud' }, { ...VPS_DUCK_ENV, HTTPS_PORT: '8443' }, DEV_ENV]) {
      expect(loadConfig(env).turn).toBeNull();
    }
  });

  test('TURN=off: never', () => {
    expect(loadConfig({ ...VPS_DUCK_ENV, TURN: 'off' })).toMatchObject({ turnSetting: 'off', turn: null });
    // Off is off even where TURN=on would be refused.
    expect(loadConfig({ ...HOME_ENV, TURN: 'off' }).turn).toBeNull();
  });

  test('TURN=on where it cannot run: each reason', () => {
    const on = { ...VPS_DUCK_ENV, TURN: 'on' };
    expect(() => loadConfig({ ...on, MEDIA: 'cloud', LIVEKIT_CLOUD_URL: 'wss://p.livekit.cloud' }))
      .toThrow(NOT_HERE("MEDIA=cloud brings LiveKit Cloud's own TURN"));
    expect(() => loadConfig({ ...on, INGRESS: 'tunnel', TUNNEL_TOKEN: 'tt' }))
      .toThrow(NOT_HERE('it needs INGRESS=direct (Caddy must own port 443)'));
    expect(() => loadConfig({ ...on, INGRESS: 'external' }))
      .toThrow(NOT_HERE('it needs INGRESS=direct (Caddy must own port 443)'));
    expect(() => loadConfig({ ...HOME_ENV, HOSTING: 'home', TURN: 'on' }))
      .toThrow(NOT_HERE('home installs get no TURN: home connections do not let port 443 in'));
    // Advanced home layout on 80/443: still refused.
    expect(() => loadConfig({ ...on, HOSTING: 'home' }))
      .toThrow(NOT_HERE('home installs get no TURN: home connections do not let port 443 in'));
    const port443 = NOT_HERE('it needs HTTPS on port 443 (HTTPS_PORT=443 and a PUBLIC_URL without a port)');
    expect(() => loadConfig({ ...on, HTTPS_PORT: '8443' })).toThrow(port443);
    expect(() => loadConfig({ ...on, PUBLIC_URL: 'https://g.duckdns.org:8443', HTTPS_PORT: '8443' })).toThrow(port443);
    expect(() => loadConfig({ ...on, PUBLIC_URL: 'https://g.duckdns.org:8443' })).toThrow(port443);
    const dns = NOT_HERE('it needs a DNS name in PUBLIC_URL (turn.<host> must resolve)');
    for (const u of ['https://203.0.113.7', 'https://[2001:db8::1]', 'https://localhost', 'https://tela']) {
      expect(() => loadConfig({ ...on, PUBLIC_URL: u })).toThrow(dns);
    }
  });

  test('turnIneligibility: reasons in order, hosting null allowed', () => {
    const base = { media: 'self', ingress: 'direct', hosting: null, httpsPort: 443, publicUrl: 'https://g.duckdns.org', publicHost: 'g.duckdns.org' } as const;
    expect(turnIneligibility(base)).toBeNull();
    expect(turnIneligibility({ ...base, hosting: 'vps' })).toBeNull();
    // The first failing rule wins.
    expect(turnIneligibility({ ...base, media: 'cloud', ingress: 'tunnel', hosting: 'home' })).toBe("MEDIA=cloud brings LiveKit Cloud's own TURN");
    expect(turnIneligibility({ ...base, ingress: 'tunnel', hosting: 'home' })).toBe('it needs INGRESS=direct (Caddy must own port 443)');
    expect(turnIneligibility({ ...base, hosting: 'home', httpsPort: 8443 })).toBe('home installs get no TURN: home connections do not let port 443 in');
    expect(turnIneligibility({ ...base, httpsPort: 8443, publicHost: '1.2.3.4' }))
      .toBe('it needs HTTPS on port 443 (HTTPS_PORT=443 and a PUBLIC_URL without a port)');
    expect(turnIneligibility({ ...base, publicUrl: 'https://1.2.3.4', publicHost: '1.2.3.4' }))
      .toBe('it needs a DNS name in PUBLIC_URL (turn.<host> must resolve)');
  });

  test('TURN values and TURN_PORT', () => {
    expect(() => loadConfig({ ...PROD_ENV, TURN: 'yes' })).toThrow('bad TURN yes (want auto | on | off)');
    for (const v of ['0', '65536', '1.5', 'x']) expect(() => loadConfig({ ...PROD_ENV, TURN_PORT: v })).toThrow('bad TURN_PORT');
    expect(loadConfig({ ...VPS_DUCK_ENV, TURN_PORT: '15349' }).turn).toEqual({ host: 'turn.g.duckdns.org', port: 15349 });
    // Parsed with TURN off too.
    expect(loadConfig({ ...PROD_ENV, TURN_PORT: '6000' }).turnPort).toBe(6000);
  });

  test('TURN_PORT joins the collision set only when TURN is on', () => {
    expect(() => loadConfig({ ...VPS_DUCK_ENV, TURN_PORT: '8081' })).toThrow('ports collide: LISTEN=8081, TURN_PORT=8081');
    expect(() => loadConfig({ ...VPS_DUCK_ENV, LISTEN: '127.0.0.1:5349' })).toThrow('ports collide: LISTEN=5349, TURN_PORT=5349');
    expect(() => loadConfig({ ...VPS_DUCK_ENV, MEDIA_TCP_PORT: '5349' })).toThrow('ports collide: MEDIA_TCP_PORT=5349, TURN_PORT=5349');
    expect(() => loadConfig({ ...VPS_DUCK_ENV, TURN_PORT: '443' })).toThrow('ports collide: HTTPS_PORT=443, TURN_PORT=443');
    expect(loadConfig({ ...VPS_DUCK_ENV, TURN: 'off', TURN_PORT: '8081' }).turn).toBeNull();
    expect(loadConfig({ ...PROD_ENV, TURN_PORT: '8081' }).turn).toBeNull();
  });
});

describe('COMMAND_NAME', () => {
  test('lowercase unicode letters, digits, - and _', () => {
    for (const n of ['tela', 'tela-2', 'tela_x', 'ção', 'a', 'x'.repeat(32)]) expect(loadConfig({ ...PROD_ENV, COMMAND_NAME: n }).commandName).toBe(n);
  });

  test('rejects uppercase, spaces, symbols and 33 chars', () => {
    for (const n of ['Tela', 'TELA', 'tela x', 'tela!', 'x'.repeat(33), 'Ção']) {
      expect(() => loadConfig({ ...PROD_ENV, COMMAND_NAME: n })).toThrow('bad COMMAND_NAME (Discord: lowercase, 1-32 chars)');
    }
  });
});

describe('IP watch and LIVEKIT_NODE_IP', () => {
  test('IP_WATCH_SECONDS=0 turns the watch off', () => {
    expect(loadConfig({ ...PROD_ENV, IP_WATCH_SECONDS: '0' }).ipWatchSeconds).toBe(0);
    for (const v of ['-1', '1.5', 'x']) expect(() => loadConfig({ ...PROD_ENV, IP_WATCH_SECONDS: v })).toThrow('bad IP_WATCH_SECONDS');
  });

  test('a static node IP forces the watch off', () => {
    const c = loadConfig({ ...PROD_ENV, LIVEKIT_NODE_IP: '203.0.113.7', IP_WATCH_SECONDS: '60' });
    expect(c.livekitNodeIp).toBe('203.0.113.7');
    expect(c.ipWatchSeconds).toBe(0);
  });

  test('LIVEKIT_NODE_IP must be an IPv4 dotted quad', () => {
    expect(loadConfig({ ...PROD_ENV, LIVEKIT_NODE_IP: '127.0.0.1' }).livekitNodeIp).toBe('127.0.0.1');
    for (const ip of ['::1', '256.1.1.1', '1.2.3', '1.2.3.4.5', 'example.com', '01.2.3.4']) {
      expect(() => loadConfig({ ...PROD_ENV, LIVEKIT_NODE_IP: ip })).toThrow('bad LIVEKIT_NODE_IP');
    }
  });
});

describe('DEV_USER guard', () => {
  test('dev mode: Discord vars not required, cookies not Secure', () => {
    const c = loadConfig(DEV_ENV);
    expect(c.dev).toEqual({ id: '1', name: 'Dev' });
    expect(c.secureCookies).toBe(false);
    expect(c.channelIds).toEqual([]);
    expect(c.livekitUrl).toBe('ws://localhost:5173/livekit');
    expect(c.publicHost).toBe('localhost');
    expect(c.warnings).toEqual([]);
  });

  test('INGRESS defaults to external and must stay external', () => {
    expect(loadConfig(DEV_ENV).ingress).toBe('external');
    expect(loadConfig({ ...DEV_ENV, INGRESS: 'external' }).ingress).toBe('external');
    for (const i of ['direct', 'tunnel']) {
      expect(() => loadConfig({ ...DEV_ENV, INGRESS: i, TUNNEL_TOKEN: 'tt' })).toThrow('DEV_USER requires INGRESS=external');
    }
  });

  test('accepts 127.0.0.1 and ::1 / localhost listen hosts', () => {
    expect(loadConfig({ ...DEV_ENV, PUBLIC_URL: 'http://127.0.0.1:8081', LISTEN: '[::1]:8081' }).dev).not.toBeNull();
    expect(loadConfig({ ...DEV_ENV, PUBLIC_URL: 'http://localhost', LISTEN: 'localhost:8081' }).dev).not.toBeNull();
  });

  test('rejects non-localhost PUBLIC_URL', () => {
    for (const u of ['https://tela.example.com', 'https://localhost:8081', 'http://tela.example.com', 'http://localhost.example.com', 'http://10.0.0.1:8081']) {
      expect(() => loadConfig({ ...DEV_ENV, PUBLIC_URL: u })).toThrow('DEV_USER requires PUBLIC_URL');
    }
  });

  test('rejects non-loopback LISTEN', () => {
    for (const l of ['0.0.0.0:8081', '[::]:8081', '10.0.0.2:8081']) {
      expect(() => loadConfig({ ...DEV_ENV, LISTEN: l })).toThrow('loopback');
    }
  });

  test('rejects bad DEV_USER format', () => {
    for (const d of ['Dev', 'abc:Dev', '1:', ':Dev', '1']) {
      expect(() => loadConfig({ ...DEV_ENV, DEV_USER: d })).toThrow('bad DEV_USER');
    }
  });

  test('name may contain colons and spaces', () => {
    expect(loadConfig({ ...DEV_ENV, DEV_USER: '42:Zé da Silva: 2' }).dev).toEqual({ id: '42', name: 'Zé da Silva: 2' });
  });
});

test('parseListen', () => {
  expect(parseListen('0.0.0.0:80')).toEqual({ host: '0.0.0.0', port: 80 });
  expect(parseListen('[::1]:8081')).toEqual({ host: '::1', port: 8081 });
  for (const bad of ['::1:8081', 'host:', 'host:99999', ':8081']) expect(() => parseListen(bad)).toThrow();
});

describe('upnpMappings', () => {
  const ports = (env: Record<string, string>) => upnpMappings(loadConfig(env)).map((m) => `${m.protocol} ${m.externalPort}->${m.internalPort}`);

  test('direct: media ports, plus HTTPS only from a high PUBLIC_URL port', () => {
    expect(ports(HOME_ENV)).toEqual(['tcp 7881->7881', 'udp 7882->7882', 'tcp 8443->8443']);
    expect(ports({ ...HOME_ENV, HTTPS_PORT: '9443' })).toEqual(['tcp 7881->7881', 'udp 7882->7882', 'tcp 8443->9443']);
    expect(ports(PROD_ENV)).toEqual(['tcp 7881->7881', 'udp 7882->7882']);
    expect(ports({ ...PROD_ENV, HTTPS_PORT: '8443' })).toEqual(['tcp 7881->7881', 'udp 7882->7882']);
  });

  test('never an external 80 or 443 entry', () => {
    const envs = [PROD_ENV, { ...PROD_ENV, HTTP_PORT: '8080' }, { ...HOME_ENV, HTTP_PORT: '8080' }, { ...PROD_ENV, PUBLIC_URL: 'https://tela.example.com:80' }];
    for (const env of envs) {
      const external = upnpMappings(loadConfig(env)).map((m) => m.externalPort);
      expect(external).not.toContain(80);
      expect(external).not.toContain(443);
    }
  });
});
