import { describe, expect, test } from 'bun:test';
import { addPortMapping, deletePortMapping, getExternalIp, getSpecificEntry, type IgdGateway, SoapError } from '../src/nat/igd.ts';
import type { Mapping } from '../src/nat/index.ts';

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';
const GW: IgdGateway = {
  kind: 'igd', version: 1, location: 'http://192.168.0.1:5000/rootDesc.xml', controlUrl: 'http://192.168.0.1:5000/ctl/IPConn',
  serviceType: SERVICE, localIp: '192.168.0.10', gatewayIp: '192.168.0.1',
};
const MEDIA: Mapping = { protocol: 'tcp', externalPort: 7881, internalPort: 7881, description: 'Telinha TCP 7881' };

const ok = (action: string, fields: Record<string, string | number> = {}) => new Response(
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
  + `<s:Body><u:${action}Response xmlns:u="${SERVICE}">`
  + Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('')
  + `</u:${action}Response></s:Body></s:Envelope>`,
);
const fault = (code: number, desc: string) => new Response(
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>`
  + `<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">`
  + `<errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`,
  { status: 500 },
);

interface Entry { client: string; internalPort: number; description: string; lease: number }
/** A miniature IGD: a port mapping table behind SOAP, with switchable quirks. */
function router(o: { permanentOnly?: boolean; table?: Record<string, Entry> } = {}) {
  const table: Record<string, Entry> = { ...o.table };
  const calls: { action: string; args: Record<string, string>; headers: Headers }[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(GW.controlUrl);
    const headers = new Headers(init?.headers);
    const action = /#(\w+)"$/.exec(headers.get('SOAPAction') ?? '')?.[1] ?? '';
    const args = Object.fromEntries([...String(init?.body).matchAll(/<(New\w+)>([^<]*)<\/New\w+>/g)].map((m) => [m[1]!, m[2]!]));
    calls.push({ action, args, headers });
    const k = `${args.NewProtocol}/${args.NewExternalPort}`;
    switch (action) {
      case 'GetExternalIPAddress':
        return ok(action, { NewExternalIPAddress: '203.0.113.9' });
      case 'AddPortMapping': {
        if (o.permanentOnly && args.NewLeaseDuration !== '0') return fault(725, 'OnlyPermanentLeasesSupported');
        const cur = table[k];
        if (cur && cur.client !== args.NewInternalClient) return fault(718, 'ConflictInMappingEntry');
        table[k] = { client: args.NewInternalClient!, internalPort: Number(args.NewInternalPort), description: args.NewPortMappingDescription!, lease: Number(args.NewLeaseDuration) };
        return ok(action);
      }
      case 'GetSpecificPortMappingEntry': {
        const cur = table[k];
        if (!cur) return fault(714, 'NoSuchEntryInArray');
        return ok(action, { NewInternalPort: cur.internalPort, NewInternalClient: cur.client, NewEnabled: 1, NewPortMappingDescription: cur.description, NewLeaseDuration: cur.lease });
      }
      case 'DeletePortMapping':
        if (!table[k]) return fault(714, 'NoSuchEntryInArray');
        delete table[k];
        return ok(action);
      default:
        return fault(401, 'Invalid Action');
    }
  };
  return { fetch: fetchFn as unknown as typeof fetch, calls, table };
}

describe('IGD SOAP', () => {
  test('GetExternalIPAddress: SOAPAction header and parsed answer', async () => {
    const r = router();
    expect(await getExternalIp(r.fetch, GW)).toBe('203.0.113.9');
    expect(r.calls[0]!.headers.get('SOAPAction')).toBe(`"${SERVICE}#GetExternalIPAddress"`);
    expect(r.calls[0]!.headers.get('Content-Type')).toBe('text/xml; charset="utf-8"');
  });

  test('AddPortMapping success: exact arguments', async () => {
    const r = router();
    expect(await addPortMapping(r.fetch, GW, MEDIA, 3600)).toEqual({ lease: 3600 });
    expect(r.calls.map((c) => c.action)).toEqual(['AddPortMapping']);
    expect(r.calls[0]!.args).toEqual({
      NewRemoteHost: '', NewExternalPort: '7881', NewProtocol: 'TCP', NewInternalPort: '7881', NewInternalClient: '192.168.0.10',
      NewEnabled: '1', NewPortMappingDescription: 'Telinha TCP 7881', NewLeaseDuration: '3600',
    });
    expect(r.table['TCP/7881']).toEqual({ client: '192.168.0.10', internalPort: 7881, description: 'Telinha TCP 7881', lease: 3600 });
  });

  test('725 OnlyPermanentLeasesSupported -> retried with lease 0', async () => {
    const r = router({ permanentOnly: true });
    expect(await addPortMapping(r.fetch, GW, MEDIA, 3600)).toEqual({ lease: 0 });
    expect(r.calls.map((c) => c.args.NewLeaseDuration)).toEqual(['3600', '0']);
  });

  test('718 with our own entry (another lease of ours) -> mapped', async () => {
    const r = router({ table: { 'TCP/7881': { client: '192.168.0.10', internalPort: 7881, description: 'Telinha TCP 7881', lease: 1200 } } });
    // This router answers 718 even for the same client, like some firmware does.
    const strict = (async (input: string, init?: RequestInit) => {
      if (String(init?.body).includes('u:AddPortMapping ')) return fault(718, 'ConflictInMappingEntry');
      return r.fetch(input, init);
    }) as unknown as typeof fetch;
    expect(await addPortMapping(strict, GW, MEDIA, 3600)).toEqual({ lease: 1200 });
    expect(r.calls.map((c) => c.action)).toEqual(['GetSpecificPortMappingEntry']);
  });

  test('718 with a foreign client -> readable failure', async () => {
    const r = router({ table: { 'TCP/7881': { client: '192.168.0.77', internalPort: 7881, description: 'Xbox', lease: 0 } } });
    const err = await addPortMapping(r.fetch, GW, MEDIA, 3600).catch((e) => e);
    expect(err).toBeInstanceOf(SoapError);
    expect(err.message).toBe('port 7881 is mapped to another device 192.168.0.77');
    expect(r.table['TCP/7881']!.client).toBe('192.168.0.77');
  });

  test('other errors keep the UPnP code and text', async () => {
    const f = (async () => fault(606, 'Action not authorized')) as unknown as typeof fetch;
    const err = await addPortMapping(f, GW, MEDIA, 3600).catch((e) => e);
    expect(err.code).toBe(606);
    expect(err.message).toBe('AddPortMapping: UPnP error 606 Action not authorized');
    const net = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    expect((await addPortMapping(net, GW, MEDIA, 3600).catch((e) => e)).message).toBe('AddPortMapping: connect ECONNREFUSED');
  });

  test('GetSpecificPortMappingEntry: 714 -> null; DeletePortMapping removes', async () => {
    const r = router();
    expect(await getSpecificEntry(r.fetch, GW, MEDIA)).toBeNull();
    await addPortMapping(r.fetch, GW, MEDIA, 3600);
    expect(await getSpecificEntry(r.fetch, GW, MEDIA)).toEqual({ internalClient: '192.168.0.10', internalPort: 7881, description: 'Telinha TCP 7881', enabled: true, lease: 3600 });
    await deletePortMapping(r.fetch, GW, MEDIA);
    expect(r.table).toEqual({});
  });
});
