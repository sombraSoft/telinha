import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortMapper, defaultNatDeps, discoverGateways, probe, type Mapping, type NatDeps, type UdpFactory } from '../src/nat/index.ts';

const GW = '192.168.0.1';
const LOCAL = '192.168.0.10';
const LOCATION = `http://${GW}:49152/desc.xml`;
const CONTROL = `http://${GW}:49152/ctl/IPConn`;
const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';
const MIN = 60_000;

const DESC = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><friendlyName>Test Router</friendlyName>
<deviceList><device><deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType><deviceList><device>
<deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType><serviceList><service>
<serviceType>${SERVICE}</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList>
</device></deviceList></device></deviceList></device></root>`;

const MAPPINGS: Mapping[] = [
  { protocol: 'tcp', externalPort: 7881, internalPort: 7881, description: 'Telinha TCP 7881' },
  { protocol: 'udp', externalPort: 7882, internalPort: 7882, description: 'Telinha UDP 7882' },
];

const soapOk = (action: string, fields: Record<string, string | number> = {}) => new Response(
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${SERVICE}">`
  + Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('') + `</u:${action}Response></s:Body></s:Envelope>`,
);
const soapFault = (code: number) => new Response(
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode>`
  + `<errorDescription>err ${code}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`, { status: 500 },
);

interface IgdEntry { client: string; internalPort: number; description: string; lease: number }

/**
 * A scripted LAN with a fake clock: a router that may speak UPnP IGD (SSDP +
 * HTTP), PCP and/or NAT-PMP. Every sleep is a fake timer; advance() fires them
 * in order, letting the async work in between run.
 */
function lan(o: { igd?: boolean; pcp?: boolean; natpmp?: boolean; addFault?: number; pmpRemapTo?: number } = {}) {
  const net = { igd: false, pcp: false, natpmp: false, ...o };
  const igdTable: Record<string, IgdEntry> = {};
  const pmpTable: Record<string, { externalPort: number; lifetime: number; nonce?: string }> = {};
  const soap: { action: string; args: Record<string, string> }[] = [];
  const pcpRequests: { lifetime: number; nonce: string; port: number }[] = [];

  let now = 1_700_000_000_000;
  const timers: { at: number; fire: () => void }[] = [];
  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = { at: now + ms, fire: () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); resolve(); } };
    timers.push(t);
    signal?.addEventListener('abort', () => t.fire(), { once: true });
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  const advance = async (ms: number) => {
    const target = now + ms;
    await flush();
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > target) break;
      now = Math.max(now, t.at);
      t.fire();
      await flush();
    }
    now = target;
    await flush();
  };

  const udp: UdpFactory = async (h) => {
    let closed = false;
    const reply = (d: Uint8Array, port: number, address: string) => queueMicrotask(() => { if (!closed) h.onMessage(d, port, address); });
    return {
      close() { closed = true; },
      send(data, port, address) {
        const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        if (port === 1900 && net.igd) {
          const st = /\r\nST: (.*)\r\n/.exec(new TextDecoder().decode(b))?.[1];
          reply(new TextEncoder().encode(`HTTP/1.1 200 OK\r\nLOCATION: ${LOCATION}\r\nST: ${st}\r\nUSN: uuid:r::${st}\r\n\r\n`), 1900, GW);
        }
        if (port !== 5351 || address !== GW) return;
        const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
        if (b[0] === 2) {
          if (!net.pcp) {
            if (net.natpmp) reply(new Uint8Array([0, 128 + b[1]!, 0, 1, 0, 0, 0, 0]), 5351, GW);
            return;
          }
          const r = new Uint8Array(b.length);
          r.set(b);
          r[1] = 0x80 | b[1]!;
          r.fill(0, 8, 24);
          if (b[1] === 1) {
            const nonce = Buffer.from(b.subarray(24, 36)).toString('hex');
            const lifetime = v.getUint32(4);
            const key = `${b[36] === 6 ? 'tcp' : 'udp'}/${v.getUint16(40)}`;
            pcpRequests.push({ lifetime, nonce, port: v.getUint16(40) });
            if (lifetime === 0) delete pmpTable[key];
            else pmpTable[key] = { externalPort: v.getUint16(42), lifetime, nonce };
            r.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 203, 0, 113, 50], 44);
          }
          reply(r, 5351, GW);
          return;
        }
        if (!net.natpmp) return;
        if (b[1] === 0) return reply(new Uint8Array([0, 128, 0, 0, 0, 0, 0, 1, 203, 0, 113, 9]), 5351, GW);
        const proto = b[1] === 1 ? 'udp' : 'tcp';
        const internalPort = v.getUint16(4);
        const lifetime = v.getUint32(8);
        let externalPort = v.getUint16(6);
        if (lifetime === 0) delete pmpTable[`${proto}/${internalPort}`];
        else {
          if (o.pmpRemapTo && proto === 'udp') externalPort = o.pmpRemapTo;
          pmpTable[`${proto}/${internalPort}`] = { externalPort, lifetime };
        }
        const r = new Uint8Array(16);
        const rv = new DataView(r.buffer);
        r[1] = 128 + b[1]!;
        rv.setUint16(8, internalPort);
        rv.setUint16(10, lifetime ? externalPort : 0);
        rv.setUint32(12, lifetime);
        reply(r, 5351, GW);
      },
    };
  };

  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!net.igd) throw new Error('connect ECONNREFUSED');
    if (url === LOCATION) return new Response(DESC);
    if (url !== CONTROL) return new Response('', { status: 404 });
    const action = /#(\w+)"$/.exec(new Headers(init?.headers).get('SOAPAction') ?? '')?.[1] ?? '';
    const args = Object.fromEntries([...String(init?.body).matchAll(/<(New\w+)>([^<]*)<\/New\w+>/g)].map((m) => [m[1]!, m[2]!]));
    soap.push({ action, args });
    const key = `${args.NewProtocol}/${args.NewExternalPort}`;
    if (action === 'GetExternalIPAddress') return soapOk(action, { NewExternalIPAddress: '203.0.113.9' });
    if (action === 'AddPortMapping') {
      if (o.addFault) return soapFault(o.addFault);
      igdTable[key] = { client: args.NewInternalClient!, internalPort: Number(args.NewInternalPort), description: args.NewPortMappingDescription!, lease: Number(args.NewLeaseDuration) };
      return soapOk(action);
    }
    if (action === 'GetSpecificPortMappingEntry') {
      const e = igdTable[key];
      return e ? soapOk(action, { NewInternalClient: e.client, NewInternalPort: e.internalPort, NewPortMappingDescription: e.description, NewEnabled: 1, NewLeaseDuration: e.lease }) : soapFault(714);
    }
    if (action === 'DeletePortMapping') {
      if (!igdTable[key]) return soapFault(714);
      delete igdTable[key];
      return soapOk(action);
    }
    return soapFault(401);
  };

  const logs: string[] = [];
  const deps: NatDeps = {
    udp,
    fetch: fetchFn as unknown as typeof fetch,
    routes: async () => ({ gatewayIp: GW, localIp: LOCAL }),
    now: () => now,
    sleep,
    random: (n) => new Uint8Array(n).fill(7),
  };
  return {
    net, deps, igdTable, pmpTable, soap, pcpRequests, logs, advance,
    now: () => now,
    adds: () => soap.filter((s) => s.action === 'AddPortMapping').length,
    mapper: (extra: { statePath?: string; leaseSeconds?: number } = {}) =>
      createPortMapper({ mappings: MAPPINGS, log: (...a) => logs.push(a.join(' ')), ...deps, ...extra }),
  };
}

/** start() needs fake time to pass (SSDP collects for 2.5 s). */
async function started(env: ReturnType<typeof lan>, extra: Parameters<ReturnType<typeof lan>['mapper']>[0] = {}) {
  const m = env.mapper(extra);
  const p = m.start();
  await env.advance(3000);
  await p;
  return m;
}

const tmp = mkdtempSync(join(tmpdir(), 'telinha-nat-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('discovery and probe', () => {
  test('discoverGateways lists IGD, then PCP', async () => {
    const env = lan({ igd: true, pcp: true });
    const p = discoverGateways(env.deps);
    await env.advance(3000);
    const gws = await p;
    expect(gws.map((g) => g.kind)).toEqual(['igd', 'pcp']);
    expect(gws[0]).toEqual({
      kind: 'igd', version: 1, location: LOCATION, controlUrl: CONTROL, serviceType: SERVICE,
      localIp: LOCAL, gatewayIp: GW, name: 'Test Router',
    });
  });

  test('NAT-PMP only when PCP is unsupported', async () => {
    const env = lan({ natpmp: true });
    const p = discoverGateways(env.deps);
    await env.advance(3000);
    expect(await p).toEqual([{ kind: 'natpmp', gatewayIp: GW, localIp: LOCAL }]);
  });

  test('probe: gateway and external IP within the budget', async () => {
    const env = lan({ igd: true });
    const p = probe(env.deps);
    await env.advance(3000);
    const r = await p;
    expect(r.gateway?.kind).toBe('igd');
    expect(r.externalIp).toBe('203.0.113.9');
    expect(r.localIp).toBe(LOCAL);
  });

  test('probe: nothing answers', async () => {
    const env = lan();
    const p = probe(env.deps);
    await env.advance(3000);
    const r = await p;
    expect(r).toEqual({ gateway: null, externalIp: null, localIp: LOCAL, errors: ['PCP/NAT-PMP at 192.168.0.1: no answer'] });
  });

  test('probe: NAT-PMP external address', async () => {
    const env = lan({ natpmp: true });
    const p = probe(env.deps);
    await env.advance(3000);
    expect((await p).externalIp).toBe('203.0.113.9');
  });
});

describe('createPortMapper', () => {
  test('maps every port with one log line each', async () => {
    const env = lan({ igd: true });
    const m = await started(env);
    expect(env.logs).toEqual([
      'upnp: mapped TCP 7881 -> 192.168.0.10:7881 (lease 3600s)',
      'upnp: mapped UDP 7882 -> 192.168.0.10:7882 (lease 3600s)',
    ]);
    expect(Object.keys(env.igdTable).sort()).toEqual(['TCP/7881', 'UDP/7882']);
    const s = m.status();
    expect(s.enabled).toBe(true);
    expect(s.externalIp).toBe('203.0.113.9');
    expect(s.gateway?.kind).toBe('igd');
    expect(s.mappings.map((x) => [x.state, x.leaseEndsAt! - env.now() > 3590_000])).toEqual([['mapped', true], ['mapped', true]]);
    await m.stop();
  });

  test('renews at half the lease, quietly', async () => {
    const env = lan({ igd: true });
    const m = await started(env);
    expect(env.adds()).toBe(2);
    await env.advance(30 * MIN - 1000); // mapped 2.5 s after start, renewal due 30 min later
    expect(env.adds()).toBe(2);
    await env.advance(2000);
    expect(env.adds()).toBe(4);
    await env.advance(30 * MIN);
    expect(env.adds()).toBe(6);
    expect(env.logs).toHaveLength(2);
    await m.stop();
  });

  test('a short lease renews sooner; a permanent one every 30 min', async () => {
    const short = lan({ igd: true });
    const m1 = await started(short, { leaseSeconds: 600 });
    await short.advance(5 * MIN);
    expect(short.adds()).toBe(4);
    await m1.stop();

    const perm = lan({ igd: true });
    const m2 = await started(perm, { leaseSeconds: 0 });
    expect(perm.logs[0]).toBe('upnp: mapped TCP 7881 -> 192.168.0.10:7881 (permanent)');
    expect(m2.status().mappings[0]!.leaseEndsAt).toBeUndefined();
    await perm.advance(29 * MIN);
    expect(perm.adds()).toBe(2);
    await perm.advance(2 * MIN);
    expect(perm.adds()).toBe(4);
    await m2.stop();
  });

  test('a failed renewal logs once per streak, recovery logs again', async () => {
    const env = lan({ igd: true });
    const m = await started(env);
    env.net.igd = false; // router unreachable
    await env.advance(30 * MIN);
    await env.advance(13 * MIN); // nothing mapped -> rediscovery after 10 min, still nothing
    const fails = env.logs.filter((l) => l.startsWith('upnp: could not map'));
    expect(fails).toEqual([
      'upnp: could not map TCP 7881: AddPortMapping: connect ECONNREFUSED',
      'upnp: could not map UDP 7882: AddPortMapping: connect ECONNREFUSED',
    ]);
    expect(env.logs.filter((l) => l.includes('no UPnP/NAT-PMP gateway'))).toHaveLength(1);
    env.net.igd = true;
    await env.advance(11 * MIN);
    expect(env.logs.slice(-2)).toEqual([
      'upnp: mapped TCP 7881 -> 192.168.0.10:7881 (lease 3600s)',
      'upnp: mapped UDP 7882 -> 192.168.0.10:7882 (lease 3600s)',
    ]);
    expect(m.status().mappings.every((x) => x.state === 'mapped')).toBe(true);
    await m.stop();
  });

  test('refresh() re-adds everything now', async () => {
    const env = lan({ igd: true });
    const m = await started(env);
    for (const k of Object.keys(env.igdTable)) delete env.igdTable[k]; // WAN reconnect wiped the table
    await m.refresh();
    expect(env.adds()).toBe(4);
    expect(Object.keys(env.igdTable)).toHaveLength(2);
    // The renewal clock restarted from the refresh.
    await env.advance(30 * MIN - 1000);
    expect(env.adds()).toBe(4);
    await env.advance(2000);
    expect(env.adds()).toBe(6);
    await m.stop();
  });

  test('stop() deletes every mapping', async () => {
    const env = lan({ igd: true });
    const m = await started(env);
    await m.stop();
    expect(env.soap.filter((s) => s.action === 'DeletePortMapping').map((s) => `${s.args.NewProtocol}/${s.args.NewExternalPort}`).sort())
      .toEqual(['TCP/7881', 'UDP/7882']);
    expect(env.igdTable).toEqual({});
    expect(m.status().mappings.map((x) => x.state)).toEqual(['pending', 'pending']);
    await env.advance(60 * MIN);
    expect(env.adds()).toBe(2); // no renewals after stop
  });

  test('no gateway: logged once, all failed, rediscovery every 10 min', async () => {
    const env = lan();
    const m = await started(env);
    expect(env.logs).toEqual(['upnp: no UPnP/NAT-PMP gateway found; forward the ports on the router by hand']);
    expect(m.status().mappings.map((x) => [x.state, x.error])).toEqual([['failed', 'no gateway'], ['failed', 'no gateway']]);
    await env.advance(25 * MIN);
    expect(env.logs).toHaveLength(1);
    env.net.natpmp = true;
    await env.advance(10 * MIN);
    expect(env.logs.slice(1)).toEqual([
      'upnp: mapped TCP 7881 -> 192.168.0.10:7881 via NAT-PMP (lease 3600s)',
      'upnp: mapped UDP 7882 -> 192.168.0.10:7882 via NAT-PMP (lease 3600s)',
    ]);
    await m.stop();
    expect(env.pmpTable).toEqual({});
  });

  test('IGD refuses everything -> NAT-PMP fallback', async () => {
    const env = lan({ igd: true, natpmp: true, addFault: 606 });
    const m = await started(env);
    expect(m.status().gateway?.kind).toBe('natpmp');
    expect(m.status().mappings.every((x) => x.state === 'mapped')).toBe(true);
    expect(env.logs[0]).toBe('upnp: could not map TCP 7881: AddPortMapping: UPnP error 606 err 606');
    await m.stop();
  });

  test('NAT-PMP granting another external port is a failure', async () => {
    const env = lan({ natpmp: true, pmpRemapTo: 50000 });
    const m = await started(env);
    expect(m.status().mappings.map((x) => x.state)).toEqual(['mapped', 'failed']);
    expect(env.logs).toContain('upnp: could not map UDP 7882 via NAT-PMP: NAT-PMP gave external port 50000 instead of 7882');
    expect(env.pmpTable['udp/7882']).toBeUndefined();
    const stop = m.stop();
    await env.advance(1000);
    await stop;
  });

  test('PCP: external IP from the MAP reply, nonce kept for renewals and delete', async () => {
    const statePath = join(tmp, 'pcp', 'upnp.json');
    const env = lan({ pcp: true });
    const m = await started(env, { statePath });
    expect(m.status().gateway?.kind).toBe('pcp');
    expect(m.status().externalIp).toBe('203.0.113.50');
    const nonce = '07'.repeat(12);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).mappings.map((x: { nonce: string }) => x.nonce)).toEqual([nonce, nonce]);
    await env.advance(30 * MIN);
    const stop = m.stop();
    await env.advance(1000);
    await stop;
    expect(env.pcpRequests.map((r) => [r.port, r.lifetime, r.nonce])).toEqual([
      [7881, 3600, nonce], [7882, 3600, nonce], [7881, 3600, nonce], [7882, 3600, nonce], [7881, 0, nonce], [7882, 0, nonce],
    ]);
    expect(env.pmpTable).toEqual({});
  });

  test('state file: written while running, stale entries of a crashed run removed at start', async () => {
    const statePath = join(tmp, 'run', 'upnp.json');
    const env = lan({ igd: true });
    // A previous run mapped 9999 (since removed from the config) and died without stop().
    env.igdTable['TCP/9999'] = { client: LOCAL, internalPort: 9999, description: 'Telinha TCP 9999', lease: 3600 };
    env.igdTable['TCP/9998'] = { client: '192.168.0.77', internalPort: 9998, description: 'Xbox', lease: 0 };
    const stale = (port: number) => ({ protocol: 'tcp', externalPort: port, internalPort: port, description: `Telinha TCP ${port}`, state: 'mapped' });
    mkdirSync(join(tmp, 'run'), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ enabled: true, gateway: null, externalIp: null, updatedAt: 0, mappings: [stale(9999), stale(9998), { ...MAPPINGS[0], state: 'mapped' }] }));
    const m = await started(env, { statePath });
    expect(env.logs[0]).toBe('upnp: removed stale mapping TCP 9999');
    expect(Object.keys(env.igdTable).sort()).toEqual(['TCP/7881', 'TCP/9998', 'UDP/7882']);
    const file = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(file.externalIp).toBe('203.0.113.9');
    expect(file.updatedAt).toBe(env.now() - 500); // written when the cycle ended, 2.5 s in
    expect(file.mappings.map((x: { externalPort: number; state: string }) => [x.externalPort, x.state])).toEqual([[7881, 'mapped'], [7882, 'mapped']]);
    await m.stop();
    expect(JSON.parse(readFileSync(statePath, 'utf8')).mappings.map((x: { state: string }) => x.state)).toEqual(['pending', 'pending']);
  });

  test('nothing to map: no discovery, no rediscovery loop, no "forward by hand" line', async () => {
    const env = lan();
    let sockets = 0;
    const udp = env.deps.udp;
    const m = createPortMapper({
      mappings: [], statePath: join(tmp, 'none', 'upnp.json'), log: (...a) => env.logs.push(a.join(' ')),
      ...env.deps, udp: async (h) => { sockets++; return udp(h); },
    });
    await m.start();
    await m.refresh();
    await env.advance(60 * MIN);
    expect(sockets).toBe(0);
    expect(env.logs).toEqual([]);
    expect(m.status().mappings).toEqual([]);
    await m.stop();
  });

  test('nothing to map, mappings left by a previous run: one cycle removes them, then nothing more', async () => {
    const statePath = join(tmp, 'cloud', 'upnp.json');
    const env = lan({ igd: true });
    env.igdTable['TCP/7881'] = { client: LOCAL, internalPort: 7881, description: 'Telinha TCP 7881', lease: 0 };
    mkdirSync(join(tmp, 'cloud'), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ enabled: true, gateway: null, externalIp: null, updatedAt: 0, mappings: [{ ...MAPPINGS[0], state: 'mapped' }] }));
    const m = createPortMapper({ mappings: [], statePath, log: (...a) => env.logs.push(a.join(' ')), ...env.deps });
    const p = m.start();
    await env.advance(3000);
    await p;
    expect(env.logs).toEqual(['upnp: removed stale mapping TCP 7881']);
    expect(env.igdTable).toEqual({});
    expect(JSON.parse(readFileSync(statePath, 'utf8')).mappings).toEqual([]);
    const soaps = env.soap.length;
    await env.advance(60 * MIN);
    expect(env.soap.length).toBe(soaps);
    expect(env.logs).toHaveLength(1);
    await m.stop();
  });

  test('nothing to map, stale entries and no gateway: silent, and the state file keeps them', async () => {
    const statePath = join(tmp, 'cloud-nogw', 'upnp.json');
    const env = lan();
    mkdirSync(join(tmp, 'cloud-nogw'), { recursive: true });
    const state = JSON.stringify({ enabled: true, gateway: null, externalIp: null, updatedAt: 0, mappings: [{ ...MAPPINGS[0], state: 'mapped' }] });
    writeFileSync(statePath, state);
    const m = createPortMapper({ mappings: [], statePath, log: (...a) => env.logs.push(a.join(' ')), ...env.deps });
    const p = m.start();
    await env.advance(3000);
    await p;
    expect(env.logs).toEqual([]);
    await env.advance(60 * MIN);
    await m.stop();
    expect(env.logs).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(state);
  });

  test('stop() before start() leaves the state file for the next run', async () => {
    const statePath = join(tmp, 'early', 'upnp.json');
    mkdirSync(join(tmp, 'early'), { recursive: true });
    writeFileSync(statePath, '{"mappings":[]}');
    await lan({ igd: true }).mapper({ statePath }).stop();
    expect(readFileSync(statePath, 'utf8')).toBe('{"mappings":[]}');
  });
});

describe('the default UDP socket', () => {
  test('a refused datagram (ICMP port unreachable) is not an uncaught error', async () => {
    // A port nobody listens on: bind one, note it, let it go.
    const probe = await Bun.udpSocket({ hostname: '127.0.0.1', port: 0 });
    const closed = probe.port;
    probe.close();
    const s = await defaultNatDeps().udp({ onMessage: () => {} });
    try {
      // On Linux the second recv after a refused send fails with ECONNREFUSED.
      for (let i = 0; i < 3; i++) {
        s.send(new Uint8Array([0, 0]), closed, '127.0.0.1');
        await Bun.sleep(50);
      }
    } finally {
      s.close();
    }
  });
});
