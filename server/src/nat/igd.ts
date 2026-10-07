// UPnP IGD port mapping over SOAP (WANIPConnection / WANPPPConnection).
// AddAnyPortMapping (IGD v2) is not used: the media ports must be exact.
import type { Gateway, Mapping } from './index.ts';
import { childText, escapeXml, findAll, parseXml, readLimited } from './ssdp.ts';

export type IgdGateway = Extract<Gateway, { kind: 'igd' }>;

const SOAP_TIMEOUT_MS = 5000;
const SOAP_MAX_BYTES = 64 * 1024;

const ERROR_NAMES: Record<number, string> = {
  401: 'InvalidAction',
  402: 'InvalidArgs',
  501: 'ActionFailed',
  606: 'ActionNotAuthorized',
  714: 'NoSuchEntryInArray',
  715: 'WildCardNotPermittedInSrcIP',
  716: 'WildCardNotPermittedInExtPort',
  718: 'ConflictInMappingEntry',
  724: 'SamePortValuesRequired',
  725: 'OnlyPermanentLeasesSupported',
  726: 'RemoteHostOnlySupportsWildcard',
  727: 'ExternalPortOnlySupportsWildcard',
  728: 'NoPortMapsAvailable',
  729: 'ConflictWithOtherMechanisms',
  732: 'WildCardNotPermittedInIntPort',
};

export class SoapError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** One SOAP action; resolves to the response's arguments by name, throws SoapError with the UPnP errorCode. */
export async function soap(
  fetch: typeof globalThis.fetch,
  gw: Pick<IgdGateway, 'controlUrl' | 'serviceType'>,
  action: string,
  args: [string, string | number][] = [],
): Promise<Record<string, string>> {
  const body =
    '<?xml version="1.0"?>\r\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${escapeXml(gw.serviceType)}">` +
    args.map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  let res: Response;
  try {
    res = await fetch(gw.controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${gw.serviceType}#${action}"` },
      body,
      signal: AbortSignal.timeout(SOAP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new SoapError(null, `${action}: ${(e as Error).message}`);
  }
  const text = await readLimited(res, SOAP_MAX_BYTES).catch(() => '');
  const tree = parseXml(text);
  if (!res.ok) {
    const err = findAll(tree, 'UPnPError')[0];
    const code = Number(childText(err, 'errorCode')) || null;
    const desc = childText(err, 'errorDescription') || (code !== null ? ERROR_NAMES[code] : undefined) || '';
    throw new SoapError(
      code,
      `${action}: ${code !== null ? `UPnP error ${code}` : `HTTP ${res.status}`}${desc ? ` ${desc}` : ''}`,
    );
  }
  const reply = findAll(tree, `${action}Response`)[0];
  if (!reply) throw new SoapError(null, `${action}: unexpected response`);
  return Object.fromEntries(reply.children.map((c) => [c.name, c.text.trim()]));
}

export async function getExternalIp(fetch: typeof globalThis.fetch, gw: IgdGateway): Promise<string> {
  const ip = (await soap(fetch, gw, 'GetExternalIPAddress')).NewExternalIPAddress ?? '';
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip === '0.0.0.0')
    throw new SoapError(null, `GetExternalIPAddress: no external IP (${ip || 'empty'})`);
  return ip;
}

const proto = (m: Mapping) => m.protocol.toUpperCase();
export const mappingDescription = (m: Mapping) => m.description || `Telinha ${proto(m)} ${m.externalPort}`;

export interface PortMappingEntry {
  internalClient: string;
  internalPort: number;
  description: string;
  enabled: boolean;
  lease: number;
}

/** null when the router has no entry for that external port (714). */
export async function getSpecificEntry(
  fetch: typeof globalThis.fetch,
  gw: IgdGateway,
  m: Pick<Mapping, 'protocol' | 'externalPort'>,
): Promise<PortMappingEntry | null> {
  try {
    const r = await soap(fetch, gw, 'GetSpecificPortMappingEntry', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', m.externalPort],
      ['NewProtocol', m.protocol.toUpperCase()],
    ]);
    return {
      internalClient: r.NewInternalClient ?? '',
      internalPort: Number(r.NewInternalPort),
      description: r.NewPortMappingDescription ?? '',
      enabled: r.NewEnabled !== '0',
      lease: Number(r.NewLeaseDuration) || 0,
    };
  } catch (e) {
    if (e instanceof SoapError && e.code === 714) return null;
    throw e;
  }
}

export async function deletePortMapping(
  fetch: typeof globalThis.fetch,
  gw: IgdGateway,
  m: Pick<Mapping, 'protocol' | 'externalPort'>,
): Promise<void> {
  await soap(fetch, gw, 'DeletePortMapping', [
    ['NewRemoteHost', ''],
    ['NewExternalPort', m.externalPort],
    ['NewProtocol', m.protocol.toUpperCase()],
  ]);
}

/**
 * Adds (or renews) `m` for `gw.localIp`; resolves to the lease the router
 * accepted (0 = permanent). 725 retries as permanent; 718 is fine when the
 * existing entry is already ours, otherwise the port belongs to another device.
 */
export async function addPortMapping(
  fetch: typeof globalThis.fetch,
  gw: IgdGateway,
  m: Mapping,
  leaseSeconds: number,
): Promise<{ lease: number }> {
  const add = (lease: number) =>
    soap(fetch, gw, 'AddPortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', m.externalPort],
      ['NewProtocol', proto(m)],
      ['NewInternalPort', m.internalPort],
      ['NewInternalClient', gw.localIp],
      ['NewEnabled', 1],
      ['NewPortMappingDescription', mappingDescription(m)],
      ['NewLeaseDuration', lease],
    ]);
  const attempt = async (lease: number, retriedConflict: boolean): Promise<{ lease: number }> => {
    try {
      await add(lease);
      return { lease };
    } catch (e) {
      if (!(e instanceof SoapError)) throw e;
      if (e.code === 725 && lease !== 0) return attempt(0, retriedConflict);
      if (e.code !== 718 || retriedConflict) throw e;
      const entry = await getSpecificEntry(fetch, gw, m);
      if (!entry) return attempt(lease, true); // gone meanwhile
      if (entry.internalClient !== gw.localIp) {
        throw new SoapError(
          718,
          `port ${m.externalPort} is mapped to another device ${entry.internalClient || '(unknown)'}`,
        );
      }
      if (entry.description === mappingDescription(m) && entry.internalPort === m.internalPort)
        return { lease: entry.lease };
      // Our machine, but someone else's entry (or our old internal port): only replace our own.
      if (entry.description !== mappingDescription(m)) {
        throw new SoapError(
          718,
          `port ${m.externalPort} is already mapped to this machine by another program ("${entry.description}")`,
        );
      }
      await deletePortMapping(fetch, gw, m);
      return attempt(lease, true);
    }
  };
  return attempt(leaseSeconds, false);
}
