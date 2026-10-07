// NAT-PMP (RFC 6886) client: external address and port mapping requests to
// the default gateway on UDP 5351. Also hosts the retransmitting UDP request
// helper PCP shares.
import type { Protocol, UdpFactory } from './index.ts';

export const NATPMP_PORT = 5351;

export class NatError extends Error {
  /** The protocol's result code; null when the gateway never answered. */
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * Sends `packet` and resends it after 250 ms, 500 ms, ... (RFC 6886 §3.1)
 * until `accept` returns a value, `maxTries` sends went out or `budgetMs` is
 * spent. null = no acceptable answer.
 */
export async function udpRequest<T>(o: {
  udp: UdpFactory;
  sleep: Sleep;
  host: string;
  port: number;
  packet: Uint8Array;
  accept: (data: Uint8Array, port: number, address: string) => T | undefined;
  firstWaitMs?: number;
  budgetMs?: number;
  maxTries?: number;
}): Promise<T | null> {
  let answered: { value: T } | null = null;
  let resolve!: (v: { value: T }) => void;
  const got = new Promise<{ value: T }>((r) => {
    resolve = r;
  });
  const socket = await o.udp({
    onMessage(data, port, address) {
      if (answered) return;
      const value = o.accept(data, port, address);
      if (value === undefined) return;
      answered = { value };
      resolve(answered);
    },
  });
  try {
    const budget = o.budgetMs ?? 5000;
    let wait = o.firstWaitMs ?? 250;
    let spent = 0;
    for (let i = 0; i < (o.maxTries ?? 8) && spent < budget; i++) {
      try {
        socket.send(o.packet, o.port, o.host);
      } catch {
        /* unreachable right now: counts as a silent try */
      }
      const ms = Math.min(wait, budget - spent);
      const timer = new AbortController();
      const r = await Promise.race([got, o.sleep(ms, timer.signal).then(() => null)]);
      timer.abort();
      if (r) return r.value;
      spent += ms;
      wait *= 2;
    }
    return (answered as { value: T } | null)?.value ?? null;
  } finally {
    socket.close();
  }
}

const RESULTS: Record<number, string> = {
  1: 'unsupported version',
  2: 'not authorized/refused',
  3: 'network failure',
  4: 'out of resources',
  5: 'unsupported opcode',
};
const resultText = (code: number) => `NAT-PMP result ${code}${RESULTS[code] ? ` (${RESULTS[code]})` : ''}`;

interface Common {
  udp: UdpFactory;
  sleep: Sleep;
  gatewayIp: string;
  budgetMs?: number;
}

const u16 = (d: Uint8Array, at: number) => (d[at]! << 8) | d[at + 1]!;
const u32 = (d: Uint8Array, at: number) => ((d[at]! << 24) | (d[at + 1]! << 16) | (d[at + 2]! << 8) | d[at + 3]!) >>> 0;

export async function natpmpExternalAddress(o: Common): Promise<string> {
  const r = await udpRequest({
    ...o,
    host: o.gatewayIp,
    port: NATPMP_PORT,
    packet: new Uint8Array([0, 0]),
    accept: (d, port, address) =>
      address === o.gatewayIp && port === NATPMP_PORT && d.length >= 4 && d[0] === 0 && d[1] === 128
        ? { code: u16(d, 2), ip: d.length >= 12 ? `${d[8]}.${d[9]}.${d[10]}.${d[11]}` : '' }
        : undefined,
  });
  if (!r) throw new NatError(null, `NAT-PMP: no answer from ${o.gatewayIp}`);
  if (r.code !== 0) throw new NatError(r.code, resultText(r.code));
  if (!r.ip || r.ip === '0.0.0.0') throw new NatError(null, 'NAT-PMP: the gateway has no external address yet');
  return r.ip;
}

function mapPacket(protocol: Protocol, internalPort: number, externalPort: number, lifetime: number): Uint8Array {
  const p = new Uint8Array(12);
  const v = new DataView(p.buffer);
  p[1] = protocol === 'udp' ? 1 : 2;
  v.setUint16(4, internalPort);
  v.setUint16(6, externalPort);
  v.setUint32(8, lifetime);
  return p;
}

async function request(
  o: Common & { protocol: Protocol; internalPort: number; externalPort: number; lifetime: number },
) {
  const op = o.protocol === 'udp' ? 1 : 2;
  return udpRequest({
    ...o,
    host: o.gatewayIp,
    port: NATPMP_PORT,
    packet: mapPacket(o.protocol, o.internalPort, o.externalPort, o.lifetime),
    accept: (d, port, address) => {
      if (address !== o.gatewayIp || port !== NATPMP_PORT || d.length < 4 || d[0] !== 0 || d[1] !== 128 + op)
        return undefined;
      const code = u16(d, 2);
      if (code !== 0) return { code, externalPort: 0, lifetime: 0 };
      if (d.length < 16 || u16(d, 8) !== o.internalPort) return undefined;
      return { code, externalPort: u16(d, 10), lifetime: u32(d, 12) };
    },
  });
}

/** Removes our mapping of `internalPort` (lifetime 0 and external port 0, RFC 6886 §3.4). */
export async function natpmpDelete(o: Common & { protocol: Protocol; internalPort: number }): Promise<void> {
  const r = await request({ ...o, externalPort: 0, lifetime: 0 });
  if (!r) throw new NatError(null, `NAT-PMP: no answer from ${o.gatewayIp}`);
  if (r.code !== 0) throw new NatError(r.code, resultText(r.code));
}

/**
 * Maps `externalPort` -> this host's `internalPort`. A gateway that grants a
 * different external port is useless to us (clients dial the exact port): that
 * mapping is removed again and the call fails.
 */
export async function natpmpMap(
  o: Common & { protocol: Protocol; internalPort: number; externalPort: number; lifetime: number },
): Promise<{ lifetime: number }> {
  const r = await request(o);
  if (!r) throw new NatError(null, `NAT-PMP: no answer from ${o.gatewayIp}`);
  if (r.code !== 0) throw new NatError(r.code, resultText(r.code));
  if (r.externalPort !== o.externalPort) {
    await natpmpDelete(o).catch(() => {});
    throw new NatError(null, `NAT-PMP gave external port ${r.externalPort} instead of ${o.externalPort}`);
  }
  return { lifetime: r.lifetime };
}
