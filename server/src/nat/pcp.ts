// PCP (RFC 6887) client: ANNOUNCE to detect a PCP server and MAP to create,
// renew (same nonce) and delete (lifetime 0) a mapping. Version 2 only; a
// NAT-PMP-only gateway answers UNSUPP_VERSION and the caller uses NAT-PMP.
import type { Protocol, UdpFactory } from './index.ts';
import { NatError, NATPMP_PORT as PCP_PORT, udpRequest } from './natpmp.ts';

export const UNSUPP_VERSION = 1;
const RESULTS: Record<number, string> = {
  1: 'UNSUPP_VERSION',
  2: 'NOT_AUTHORIZED',
  3: 'MALFORMED_REQUEST',
  4: 'UNSUPP_OPCODE',
  5: 'UNSUPP_OPTION',
  6: 'MALFORMED_OPTION',
  7: 'NETWORK_FAILURE',
  8: 'NO_RESOURCES',
  9: 'UNSUPP_PROTOCOL',
  10: 'USER_EX_QUOTA',
  11: 'CANNOT_PROVIDE_EXTERNAL',
  12: 'ADDRESS_MISMATCH',
  13: 'EXCESSIVE_REMOTE_PEERS',
};
const resultText = (code: number) => `PCP result ${code}${RESULTS[code] ? ` (${RESULTS[code]})` : ''}`;

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
interface Common {
  udp: UdpFactory;
  sleep: Sleep;
  gatewayIp: string;
  localIp: string;
  budgetMs?: number;
  firstWaitMs?: number;
  maxTries?: number;
}

/** ::ffff:a.b.c.d */
function mappedV4(ip: string): Uint8Array {
  const out = new Uint8Array(16);
  out[10] = 0xff;
  out[11] = 0xff;
  ip.split('.').forEach((p, i) => {
    out[12 + i] = Number(p) & 0xff;
  });
  return out;
}

function header(opcode: number, lifetime: number, localIp: string, extra: number): Uint8Array {
  const p = new Uint8Array(24 + extra);
  p[0] = 2;
  p[1] = opcode;
  new DataView(p.buffer).setUint32(4, lifetime);
  p.set(mappedV4(localIp), 8);
  return p;
}

const fromGateway = (o: Common, port: number, address: string) => address === o.gatewayIp && port === PCP_PORT;

/**
 * 'pcp' when a PCP server answered, 'unsupported' when the gateway answered
 * but speaks only NAT-PMP (or an older PCP), null when nothing answered.
 */
export async function pcpAnnounce(o: Common): Promise<'pcp' | 'unsupported' | null> {
  return udpRequest<'pcp' | 'unsupported'>({
    ...o,
    host: o.gatewayIp,
    port: PCP_PORT,
    packet: header(0, 0, o.localIp, 0),
    accept: (d, port, address) => {
      if (!fromGateway(o, port, address) || d.length < 4) return undefined;
      if (d[0] !== 2) return 'unsupported';
      if (d[1] !== 0x80) return undefined;
      return d[3] === 0 ? 'pcp' : d[3] === UNSUPP_VERSION ? 'unsupported' : undefined;
    },
  });
}

export interface PcpMapResult {
  externalPort: number;
  externalIp: string | null;
  lifetime: number;
}

async function map(
  o: Common & { protocol: Protocol; internalPort: number; externalPort: number; lifetime: number; nonce: Uint8Array },
) {
  const p = header(1, o.lifetime, o.localIp, 36);
  const v = new DataView(p.buffer);
  p.set(o.nonce.subarray(0, 12), 24);
  p[36] = o.protocol === 'udp' ? 17 : 6;
  v.setUint16(40, o.internalPort);
  v.setUint16(42, o.externalPort);
  p.set(mappedV4('0.0.0.0'), 44);
  const r = await udpRequest<{ code: number } & PcpMapResult>({
    ...o,
    host: o.gatewayIp,
    port: PCP_PORT,
    packet: p,
    accept: (d, port, address) => {
      if (!fromGateway(o, port, address) || d.length < 4) return undefined;
      // A NAT-PMP-only gateway answers in NAT-PMP framing: version 0, 16-bit result.
      if (d[0] !== 2) return { code: UNSUPP_VERSION, externalPort: 0, externalIp: null, lifetime: 0 };
      if (d[1] !== 0x81 || d.length < 60) return undefined;
      for (let i = 0; i < 12; i++) if (d[24 + i] !== o.nonce[i]) return undefined;
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      if (d[3] === 0 && (d[36] !== p[36] || dv.getUint16(40) !== o.internalPort)) return undefined;
      const ip = d.subarray(44, 60);
      const v4 = ip.subarray(0, 10).every((b) => b === 0) && ip[10] === 0xff && ip[11] === 0xff;
      const externalIp = v4 ? `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}` : null;
      return {
        code: d[3]!,
        lifetime: dv.getUint32(4),
        externalPort: dv.getUint16(42),
        externalIp: externalIp === '0.0.0.0' ? null : externalIp,
      };
    },
  });
  if (!r) throw new NatError(null, `PCP: no answer from ${o.gatewayIp}`);
  if (r.code !== 0) throw new NatError(r.code, resultText(r.code));
  return r;
}

/** Deletes the mapping created with `nonce` (lifetime 0, RFC 6887 §15). */
export async function pcpDelete(
  o: Common & { protocol: Protocol; internalPort: number; nonce: Uint8Array },
): Promise<void> {
  await map({ ...o, externalPort: 0, lifetime: 0 });
}

/**
 * Creates or renews (same nonce) the mapping. A different assigned external
 * port is deleted again and fails: clients dial the exact port.
 */
export async function pcpMap(
  o: Common & { protocol: Protocol; internalPort: number; externalPort: number; lifetime: number; nonce: Uint8Array },
): Promise<PcpMapResult> {
  const r = await map(o);
  if (r.externalPort !== o.externalPort) {
    await pcpDelete(o).catch(() => {});
    throw new NatError(null, `PCP gave external port ${r.externalPort} instead of ${o.externalPort}`);
  }
  return { externalPort: r.externalPort, externalIp: r.externalIp, lifetime: r.lifetime };
}
