import { describe, expect, test } from 'bun:test';
import type { UdpFactory } from '../src/nat/index.ts';
import {
  acceptableLocation, fetchIgdService, findAll, parseDeviceDescription, parseSsdpReply, parseXml, SEARCH_TARGETS, ssdpSearch,
} from '../src/nat/ssdp.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

type Reply = (data: string, port: number, address: string) => void;
/** A scripted LAN: `answer` sees every datagram sent and may reply (delivered asynchronously, like the network). */
function fakeUdp(answer: (data: Uint8Array, port: number, address: string, reply: Reply) => void) {
  const sent: { data: string; port: number; address: string }[] = [];
  const opts: Parameters<UdpFactory>[0][] = [];
  let open = 0;
  const udp: UdpFactory = async (o) => {
    opts.push(o);
    open++;
    let closed = false;
    return {
      send(data, port, address) {
        const bytes = typeof data === 'string' ? enc(data) : data;
        sent.push({ data: dec(bytes), port, address });
        answer(bytes, port, address, (d, p, a) => queueMicrotask(() => { if (!closed) o.onMessage(enc(d), p, a); }));
      },
      close() {
        if (!closed) open--;
        closed = true;
      },
    };
  };
  return { udp, sent, opts, open: () => open };
}

const sleeps: number[] = [];
const sleep = async (ms: number) => {
  sleeps.push(ms);
  await new Promise((r) => setTimeout(r, 0));
};

const ssdpReply = (location: string, st: string) =>
  `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: ${location}\r\nSERVER: Linux UPnP/1.0 test\r\nST: ${st}\r\nUSN: uuid:abc::${st}\r\n\r\n`;

describe('ssdpSearch', () => {
  test('M-SEARCH per target, twice; replies parsed and deduped by location', async () => {
    sleeps.length = 0;
    const net = fakeUdp((data, _port, _address, reply) => {
      const st = /\r\nST: (.*)\r\n/.exec(dec(data))?.[1] ?? '';
      if (st.includes('InternetGatewayDevice')) reply(ssdpReply('http://192.168.0.1:49152/desc.xml', st), 1900, '192.168.0.1');
      if (st === 'upnp:rootdevice') reply(ssdpReply('http://192.168.0.20:8080/tv.xml', st), 1900, '192.168.0.20');
    });
    const seen: string[] = [];
    const found = await ssdpSearch({ udp: net.udp, sleep, localIp: '192.168.0.10', timeoutMs: 2500, onReply: (r) => seen.push(r.location) });
    expect(net.sent.map((s) => `${s.address}:${s.port}`)).toEqual(Array(SEARCH_TARGETS.length * 2).fill('239.255.255.250:1900'));
    expect(net.sent[0]!.data).toBe('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\n'
      + 'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:2\r\n\r\n');
    expect(sleeps).toEqual([300, 2200]);
    expect(found).toEqual([
      { location: 'http://192.168.0.1:49152/desc.xml', st: 'urn:schemas-upnp-org:device:InternetGatewayDevice:2', usn: 'uuid:abc::urn:schemas-upnp-org:device:InternetGatewayDevice:2', address: '192.168.0.1' },
      { location: 'http://192.168.0.20:8080/tv.xml', st: 'upnp:rootdevice', usn: 'uuid:abc::upnp:rootdevice', address: '192.168.0.20' },
    ]);
    expect(seen).toEqual(['http://192.168.0.1:49152/desc.xml', 'http://192.168.0.20:8080/tv.xml']);
    expect(net.opts[0]!.multicastInterface).toBe('192.168.0.10');
    expect(net.open()).toBe(0);
  });

  test('garbage and off-LAN locations are ignored', async () => {
    const net = fakeUdp((_d, _p, _a, reply) => {
      reply('NOTIFY * HTTP/1.1\r\nLOCATION: http://192.168.0.1/x.xml\r\n\r\n', 1900, '192.168.0.1');
      reply('HTTP/1.1 200 OK\r\nST: x\r\n\r\n', 1900, '192.168.0.1');
      reply(ssdpReply('http://203.0.113.5/evil.xml', 'upnp:rootdevice'), 1900, '192.168.0.1');
      reply(ssdpReply('file:///etc/passwd', 'upnp:rootdevice'), 1900, '192.168.0.1');
    });
    expect(await ssdpSearch({ udp: net.udp, sleep, timeoutMs: 500 })).toEqual([]);
  });
});

describe('parsing', () => {
  test('parseSsdpReply: case-insensitive headers', () => {
    expect(parseSsdpReply('HTTP/1.1 200 OK\r\nlocation: http://10.0.0.1:1900/igd.xml\r\nst: upnp:rootdevice\r\n\r\n'))
      .toEqual({ location: 'http://10.0.0.1:1900/igd.xml', st: 'upnp:rootdevice', usn: '' });
    expect(parseSsdpReply('HTTP/1.1 404 Not Found\r\nLOCATION: http://x/\r\n\r\n')).toBeNull();
  });

  test('acceptableLocation: http(s) on the LAN or the sender itself', () => {
    expect(acceptableLocation('http://192.168.0.1:5000/rootDesc.xml', '192.168.0.1')).toBe(true);
    expect(acceptableLocation('http://172.20.0.1/d.xml', '192.168.0.1')).toBe(true);
    expect(acceptableLocation('http://100.64.0.1/d.xml', '100.64.0.1')).toBe(true);
    expect(acceptableLocation('http://100.64.0.1/d.xml', '192.168.0.1')).toBe(false);
    expect(acceptableLocation('ftp://192.168.0.1/d.xml', '192.168.0.1')).toBe(false);
    expect(acceptableLocation('not a url', '192.168.0.1')).toBe(false);
  });

  test('parseXml: prefixes dropped, entities and CDATA decoded, comments skipped', () => {
    const t = parseXml('<?xml version="1.0"?><!-- hi --><s:a xmlns:s="x"><s:b>1 &amp; 2</s:b><c><![CDATA[<raw>]]></c><d/><B>x</B></s:a>');
    expect(findAll(t, 'b').map((n) => n.text)).toEqual(['1 & 2', 'x']);
    expect(findAll(t, 'c')[0]!.text).toBe('<raw>');
    expect(findAll(t, 'd')[0]!.children).toEqual([]);
  });
});

const DESC_FRITZ = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:2</deviceType>
<friendlyName>FRITZ!Box 7590</friendlyName>
<serviceList><service><serviceType>urn:schemas-any-com:service:Any:1</serviceType><controlURL>/igdupnp/control/any</controlURL></service></serviceList>
<deviceList><device>
 <deviceType>urn:schemas-upnp-org:device:WANDevice:2</deviceType>
 <serviceList><service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/igdupnp/control/WANCommonIFC1</controlURL></service></serviceList>
 <deviceList><device>
  <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:2</deviceType>
  <serviceList>
   <service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>/igdupnp/control/WANPPPConn1</controlURL></service>
   <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType><controlURL>/igdupnp/control/WANIPConn1</controlURL></service>
  </serviceList>
 </device></deviceList>
</device></deviceList>
</device>
</root>`;

// miniupnpd style with URLBase and a relative control URL, plus namespace prefixes.
const DESC_URLBASE = `<?xml version="1.0"?>
<ns0:root xmlns:ns0="urn:schemas-upnp-org:device-1-0">
<ns0:URLBase>http://192.168.1.1:5000/</ns0:URLBase>
<ns0:device><ns0:deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</ns0:deviceType>
<ns0:deviceList><ns0:device><ns0:deviceType>urn:schemas-upnp-org:device:WANDevice:1</ns0:deviceType>
<ns0:deviceList><ns0:device><ns0:deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</ns0:deviceType>
<ns0:serviceList><ns0:service>
<ns0:serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</ns0:serviceType>
<ns0:controlURL>ctl/IPConn</ns0:controlURL>
</ns0:service></ns0:serviceList>
</ns0:device></ns0:deviceList></ns0:device></ns0:deviceList></ns0:device></ns0:root>`;

const DESC_PPP = `<root><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType>
<controlURL>http://192.168.2.1:80/upnp/control/WANPPPConnection</controlURL></service></serviceList></device></root>`;

const DESC_TV = `<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
<serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service></serviceList></device></root>`;

describe('parseDeviceDescription', () => {
  test('nested devices: WANIPConnection:2 preferred over PPP, path resolved against the location', () => {
    expect(parseDeviceDescription(DESC_FRITZ, 'http://192.168.178.1:49000/igd2desc.xml')).toEqual({
      controlUrl: 'http://192.168.178.1:49000/igdupnp/control/WANIPConn1',
      serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:2',
      version: 2,
      name: 'FRITZ!Box 7590',
    });
  });

  test('URLBase and a relative control URL', () => {
    expect(parseDeviceDescription(DESC_URLBASE, 'http://192.168.1.1:39000/rootDesc.xml')).toEqual({
      controlUrl: 'http://192.168.1.1:5000/ctl/IPConn',
      serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
      version: 1,
    });
  });

  test('WANPPPConnection:1 with an absolute control URL', () => {
    expect(parseDeviceDescription(DESC_PPP, 'http://192.168.2.1:1900/d.xml')).toMatchObject({
      controlUrl: 'http://192.168.2.1/upnp/control/WANPPPConnection',
      serviceType: 'urn:schemas-upnp-org:service:WANPPPConnection:1',
      version: 1,
    });
  });

  test('no WAN connection service -> null', () => {
    expect(parseDeviceDescription(DESC_TV, 'http://192.168.0.20/tv.xml')).toBeNull();
  });
});

describe('fetchIgdService', () => {
  const fetchOf = (r: Response | Error) => (async () => {
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;

  test('fetches and parses', async () => {
    const s = await fetchIgdService(fetchOf(new Response(DESC_URLBASE)), 'http://192.168.1.1:39000/rootDesc.xml');
    expect(s.controlUrl).toBe('http://192.168.1.1:5000/ctl/IPConn');
  });

  test('readable failures: HTTP status, size cap, no WAN service', async () => {
    await expect(fetchIgdService(fetchOf(new Response('', { status: 404 })), 'http://192.168.0.1/d.xml')).rejects.toThrow('HTTP 404');
    await expect(fetchIgdService(fetchOf(new Response('x'.repeat(300 * 1024))), 'http://192.168.0.1/d.xml')).rejects.toThrow('larger than');
    await expect(fetchIgdService(fetchOf(new Response(DESC_TV)), 'http://192.168.0.1/d.xml')).rejects.toThrow('no WANIPConnection');
  });
});
