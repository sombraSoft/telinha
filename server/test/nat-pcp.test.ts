import { describe, expect, test } from 'bun:test';
import type { UdpFactory } from '../src/nat/index.ts';
import { pcpAnnounce, pcpDelete, pcpMap } from '../src/nat/pcp.ts';

const GW = '192.168.0.1';
const LOCAL = '192.168.0.10';
const NONCE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

type Reply = (data: Uint8Array) => void;
function fakeUdp(answer: (data: Uint8Array, reply: Reply) => void) {
  const sent: Uint8Array[] = [];
  const udp: UdpFactory = async (o) => {
    let closed = false;
    return {
      send(data, port, address) {
        expect([port, address]).toEqual([5351, GW]);
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        sent.push(bytes);
        answer(bytes, (d) =>
          queueMicrotask(() => {
            if (!closed) o.onMessage(d, 5351, GW);
          }),
        );
      },
      close() {
        closed = true;
      },
    };
  };
  return { udp, sent };
}
const sleep = async () => {
  await new Promise((r) => setTimeout(r, 0));
};

/** A PCP server's MAP answer to `req`: the request's MAP payload echoed with the assigned port and IP. */
function mapReply(
  req: Uint8Array,
  o: { result?: number; lifetime?: number; port?: number; ip?: number[] } = {},
): Uint8Array {
  const r = new Uint8Array(60);
  const v = new DataView(r.buffer);
  r[0] = 2;
  r[1] = 0x81;
  r[3] = o.result ?? 0;
  v.setUint32(4, o.lifetime ?? new DataView(req.buffer, req.byteOffset).getUint32(4));
  v.setUint32(8, 4242);
  r.set(req.subarray(24, 60), 24);
  if (o.port !== undefined) v.setUint16(42, o.port);
  r.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...(o.ip ?? [203, 0, 113, 9])], 44);
  return r;
}

const base = { sleep, gatewayIp: GW, localIp: LOCAL };

describe('PCP', () => {
  test('MAP request layout and success', async () => {
    const net = fakeUdp((req, reply) => reply(mapReply(req)));
    const r = await pcpMap({
      ...base,
      udp: net.udp,
      protocol: 'udp',
      internalPort: 7882,
      externalPort: 7882,
      lifetime: 3600,
      nonce: NONCE,
    });
    expect(r).toEqual({ externalPort: 7882, externalIp: '203.0.113.9', lifetime: 3600 });
    const req = net.sent[0]!;
    const v = new DataView(req.buffer, req.byteOffset);
    expect(req.length).toBe(60);
    expect([req[0], req[1], v.getUint32(4)]).toEqual([2, 1, 3600]);
    expect([...req.subarray(8, 24)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 168, 0, 10]);
    expect([...req.subarray(24, 36)]).toEqual([...NONCE]);
    expect([req[36], v.getUint16(40), v.getUint16(42)]).toEqual([17, 7882, 7882]);
    expect([...req.subarray(44, 60)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0]);
  });

  test('server-shortened lifetime is reported; TCP is protocol 6', async () => {
    const net = fakeUdp((req, reply) => reply(mapReply(req, { lifetime: 600 })));
    const r = await pcpMap({
      ...base,
      udp: net.udp,
      protocol: 'tcp',
      internalPort: 7881,
      externalPort: 7881,
      lifetime: 3600,
      nonce: NONCE,
    });
    expect(r.lifetime).toBe(600);
    expect(net.sent[0]![36]).toBe(6);
  });

  test('a reply with another nonce is not ours', async () => {
    const net = fakeUdp((req, reply) => {
      const other = mapReply(req);
      other[24] = 99;
      reply(other);
      reply(mapReply(req));
    });
    expect(
      (
        await pcpMap({
          ...base,
          udp: net.udp,
          protocol: 'tcp',
          internalPort: 7881,
          externalPort: 7881,
          lifetime: 3600,
          nonce: NONCE,
        })
      ).externalPort,
    ).toBe(7881);
  });

  test('UNSUPP_VERSION from a NAT-PMP-only gateway', async () => {
    // RFC 6887 §9: a NAT-PMP server answers in its own framing, version 0, result 1.
    const pmp = fakeUdp((_req, reply) => reply(new Uint8Array([0, 0x81, 0, 1, 0, 0, 0, 1])));
    const err = await pcpMap({
      ...base,
      udp: pmp.udp,
      protocol: 'tcp',
      internalPort: 7881,
      externalPort: 7881,
      lifetime: 3600,
      nonce: NONCE,
    }).catch((e) => e);
    expect([err.code, err.message]).toEqual([1, 'PCP result 1 (UNSUPP_VERSION)']);
    expect(await pcpAnnounce({ ...base, udp: pmp.udp })).toBe('unsupported');
  });

  test('error result codes', async () => {
    for (const [code, text] of [
      [8, 'NO_RESOURCES'],
      [11, 'CANNOT_PROVIDE_EXTERNAL'],
      [2, 'NOT_AUTHORIZED'],
    ] as const) {
      const net = fakeUdp((req, reply) => reply(mapReply(req, { result: code, lifetime: 30 })));
      const err = await pcpMap({
        ...base,
        udp: net.udp,
        protocol: 'tcp',
        internalPort: 7881,
        externalPort: 7881,
        lifetime: 3600,
        nonce: NONCE,
      }).catch((e) => e);
      expect(err.message).toBe(`PCP result ${code} (${text})`);
    }
  });

  test('a different assigned port is deleted (same nonce, lifetime 0) and fails', async () => {
    const net = fakeUdp((req, reply) =>
      reply(mapReply(req, { port: new DataView(req.buffer, req.byteOffset).getUint32(4) ? 40000 : 0 })),
    );
    const err = await pcpMap({
      ...base,
      udp: net.udp,
      protocol: 'tcp',
      internalPort: 443,
      externalPort: 443,
      lifetime: 3600,
      nonce: NONCE,
    }).catch((e) => e);
    expect(err.message).toBe('PCP gave external port 40000 instead of 443');
    const del = net.sent[1]!;
    expect(new DataView(del.buffer, del.byteOffset).getUint32(4)).toBe(0);
    expect([...del.subarray(24, 36)]).toEqual([...NONCE]);
  });

  test('delete', async () => {
    const net = fakeUdp((req, reply) => reply(mapReply(req)));
    await pcpDelete({ ...base, udp: net.udp, protocol: 'udp', internalPort: 7882, nonce: NONCE });
    expect(new DataView(net.sent[0]!.buffer).getUint32(4)).toBe(0);
  });

  test('ANNOUNCE: PCP server, or silence', async () => {
    const pcp = fakeUdp((req, reply) => {
      expect([req.length, req[0], req[1]]).toEqual([24, 2, 0]);
      const r = new Uint8Array(24);
      r[0] = 2;
      r[1] = 0x80;
      reply(r);
    });
    expect(await pcpAnnounce({ ...base, udp: pcp.udp })).toBe('pcp');
    const silent = fakeUdp(() => {});
    expect(await pcpAnnounce({ ...base, udp: silent.udp, firstWaitMs: 1000, maxTries: 1 })).toBeNull();
    expect(silent.sent).toHaveLength(1);
  });
});
