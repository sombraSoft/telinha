import { describe, expect, test } from 'bun:test';
import { loadConfig, turnIneligibility, type Hosting, type Ingress, type Media } from '../src/config.ts';
import { footprintOf, helpersOf, type Footprint } from '../src/footprint.ts';
import { PROD_ENV } from './helpers.ts';

// A DuckDNS name on 443: TURN can run here, on a VPS in direct mode with MEDIA=self.
const BASE = { ...PROD_ENV, PUBLIC_URL: 'https://g.duckdns.org' };
const MODE_ENV: Record<Media | Ingress, Record<string, string>> = {
  self: {}, cloud: { MEDIA: 'cloud', LIVEKIT_CLOUD_URL: 'wss://proj.livekit.cloud' },
  direct: {}, tunnel: { INGRESS: 'tunnel', TUNNEL_TOKEN: 'tt' }, external: { INGRESS: 'external' },
};

interface Shape { helpers: string[]; ports: string[]; exposures: string[]; relay: boolean }
const shape = (f: Footprint): Shape => ({
  helpers: f.helpers.map((h) => `${h.name}(${h.binary}): ${h.ports.map((p) => p.key).join(' ')}`),
  ports: f.ports.map((p) => p.key),
  exposures: f.exposures.map((e) => `${e.helper} ${e.key}/${e.protocol}`),
  relay: f.relay,
});

const LIVEKIT = 'livekit(livekit-server): LIVEKIT_PORT MEDIA_TCP_PORT MEDIA_UDP_PORT';
const CADDY = 'caddy(caddy): HTTPS_PORT HTTP_PORT';
const CLOUDFLARED = 'cloudflared(cloudflared): ';
const MEDIA_PORTS = ['MEDIA_TCP_PORT', 'MEDIA_UDP_PORT', 'LIVEKIT_PORT'];
const WEB_PORTS = ['HTTPS_PORT', 'HTTP_PORT'];
const MEDIA_EXPOSED = ['livekit MEDIA_TCP_PORT/tcp', 'livekit MEDIA_UDP_PORT/udp'];
const WEB_EXPOSED = ['caddy HTTPS_PORT/tcp', 'caddy HTTP_PORT/tcp'];

// Every mode, as loadConfig produces it; HOSTING changes the footprint only through TURN.
const TABLE: [Media, Ingress, turn: boolean, Shape][] = [
  ['self', 'direct', false, { helpers: [LIVEKIT, CADDY], ports: [...MEDIA_PORTS, 'LISTEN', ...WEB_PORTS], exposures: [...MEDIA_EXPOSED, ...WEB_EXPOSED], relay: true }],
  ['self', 'direct', true, {
    // TURN binds loopback only (Caddy reaches it through 443): a port, no exposure.
    helpers: [`${LIVEKIT} TURN_PORT`, CADDY], ports: [...MEDIA_PORTS, 'LISTEN', ...WEB_PORTS, 'TURN_PORT'], exposures: [...MEDIA_EXPOSED, ...WEB_EXPOSED], relay: true,
  }],
  ['self', 'tunnel', false, { helpers: [LIVEKIT, CLOUDFLARED], ports: [...MEDIA_PORTS, 'LISTEN'], exposures: MEDIA_EXPOSED, relay: true }],
  ['self', 'external', false, { helpers: [LIVEKIT], ports: [...MEDIA_PORTS, 'LISTEN'], exposures: MEDIA_EXPOSED, relay: true }],
  ['cloud', 'direct', false, { helpers: [CADDY], ports: ['LISTEN', ...WEB_PORTS], exposures: WEB_EXPOSED, relay: false }],
  ['cloud', 'tunnel', false, { helpers: [CLOUDFLARED], ports: ['LISTEN'], exposures: [], relay: false }],
  ['cloud', 'external', false, { helpers: [], ports: ['LISTEN'], exposures: [], relay: false }],
];

describe('footprintOf', () => {
  for (const [media, ingress, turn, want] of TABLE) {
    for (const hosting of ['home', 'vps'] as Hosting[]) {
      const name = `${media} ${ingress} ${hosting}${turn ? ' TURN' : ''}`;
      const env = { ...BASE, ...MODE_ENV[media], ...MODE_ENV[ingress], HOSTING: hosting, TURN: turn ? 'on' : 'off' };
      const config = { media, ingress, hosting, httpsPort: 443, publicUrl: BASE.PUBLIC_URL, publicHost: 'g.duckdns.org' };
      if (turn && turnIneligibility(config)) {
        test(`${name}: refused by loadConfig`, () => expect(() => loadConfig(env)).toThrow('TURN=on is not possible here'));
        continue;
      }
      test(name, () => {
        const c = loadConfig(env);
        expect(c.turn !== null).toBe(turn);
        expect(shape(footprintOf(c))).toEqual(want);
        expect(helpersOf(c)).toEqual(footprintOf(c).helpers.map((h) => h.name));
      });
    }
  }

  test('port numbers; Caddy exposures carry the port the outside dials', () => {
    const f = footprintOf(loadConfig({
      ...BASE, HOSTING: 'vps', PUBLIC_URL: 'https://g.duckdns.org:8443', HTTPS_PORT: '9443', HTTP_PORT: '8080',
      MEDIA_TCP_PORT: '7001', MEDIA_UDP_PORT: '7002', LIVEKIT_PORT: '7000', LISTEN: '127.0.0.1:8000',
    }));
    expect(f.ports.map((p) => `${p.key}=${p.port}/${p.protocol}`)).toEqual([
      'MEDIA_TCP_PORT=7001/tcp', 'MEDIA_UDP_PORT=7002/udp', 'LIVEKIT_PORT=7000/tcp', 'LISTEN=8000/tcp', 'HTTPS_PORT=9443/tcp', 'HTTP_PORT=8080/tcp',
    ]);
    expect(f.exposures).toEqual([
      { helper: 'livekit', key: 'MEDIA_TCP_PORT', protocol: 'tcp', port: 7001 },
      { helper: 'livekit', key: 'MEDIA_UDP_PORT', protocol: 'udp', port: 7002 },
      { helper: 'caddy', key: 'HTTPS_PORT', protocol: 'tcp', port: 9443, externalPort: 8443 },
      { helper: 'caddy', key: 'HTTP_PORT', protocol: 'tcp', port: 8080, externalPort: 80 },
    ]);
    expect(footprintOf(loadConfig({ ...BASE, HOSTING: 'vps' })).helpers[0]!.ports.at(-1)).toEqual({ key: 'TURN_PORT', protocol: 'tcp', port: 5349 });
  });

  test('HTTP_PORT=0: no redirect listener, nothing bound or exposed', () => {
    const f = footprintOf(loadConfig({ ...BASE, HTTP_PORT: '0' }));
    expect(f.ports.map((p) => p.key)).not.toContain('HTTP_PORT');
    expect(f.exposures.map((e) => e.key)).not.toContain('HTTP_PORT');
  });

  test('ipWatch: on unless IP_WATCH_SECONDS=0 or a static LIVEKIT_NODE_IP, Cloud included', () => {
    for (const media of ['self', 'cloud'] as const) {
      const env = { ...BASE, ...MODE_ENV[media] };
      expect(footprintOf(loadConfig(env)).ipWatch).toBe(true);
      expect(footprintOf(loadConfig({ ...env, IP_WATCH_SECONDS: '0' })).ipWatch).toBe(false);
      expect(footprintOf(loadConfig({ ...env, LIVEKIT_NODE_IP: '203.0.113.7' })).ipWatch).toBe(false);
    }
  });
});
