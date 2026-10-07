import { describe, expect, test } from 'bun:test';
import type { UdpFactory } from '../src/nat/index.ts';
import { NatError, natpmpDelete, natpmpExternalAddress, natpmpMap } from '../src/nat/natpmp.ts';

const GW = '192.168.0.1';

type Reply = (data: Uint8Array, port?: number, address?: string) => void;
/** A scripted LAN: `answer` sees every datagram sent and may reply (asynchronously, like the network). */
function fakeUdp(answer: (data: Uint8Array, port: number, address: string, reply: Reply) => void) {
  const sent: Uint8Array[] = [];
  let open = 0;
  const udp: UdpFactory = async (o) => {
    open++;
    let closed = false;
    return {
      send(data, port, address) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        sent.push(bytes);
        answer(bytes, port, address, (d, p = 5351, a = GW) =>
          queueMicrotask(() => {
            if (!closed) o.onMessage(d, p, a);
          }),
        );
      },
      close() {
        if (!closed) open--;
        closed = true;
      },
    };
  };
  return { udp, sent, open: () => open };
}

function clock() {
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { slept, sleep };
}

const bytes = (...parts: (number | [number, 2 | 4])[]) => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'number') out.push(p);
    else for (let i = p[1] - 1; i >= 0; i--) out.push((p[0] >>> (8 * i)) & 0xff);
  }
  return new Uint8Array(out);
};

describe('NAT-PMP', () => {
  test('external address request and reply', async () => {
    const c = clock();
    const net = fakeUdp((data, port, address, reply) => {
      expect([port, address]).toEqual([5351, GW]);
      expect([...data]).toEqual([0, 0]);
      reply(bytes(0, 128, [0, 2], [1234, 4], 203, 0, 113, 9));
    });
    expect(await natpmpExternalAddress({ udp: net.udp, sleep: c.sleep, gatewayIp: GW })).toBe('203.0.113.9');
    expect(net.open()).toBe(0);
  });

  test('answers from other hosts are ignored', async () => {
    const c = clock();
    const net = fakeUdp((_d, _p, _a, reply) => {
      reply(bytes(0, 128, [0, 2], [1, 4], 6, 6, 6, 6), 5351, '192.168.0.66');
      reply(bytes(0, 128, [0, 2], [1, 4], 203, 0, 113, 9));
    });
    expect(await natpmpExternalAddress({ udp: net.udp, sleep: c.sleep, gatewayIp: GW })).toBe('203.0.113.9');
  });

  test('silent gateway: 250 ms doubling retransmissions within the budget', async () => {
    const c = clock();
    const net = fakeUdp(() => {});
    const err = await natpmpExternalAddress({ udp: net.udp, sleep: c.sleep, gatewayIp: GW }).catch((e) => e);
    expect(err).toBeInstanceOf(NatError);
    expect(err.code).toBeNull();
    expect(c.slept).toEqual([250, 500, 1000, 2000, 1250]);
    expect(net.sent).toHaveLength(5);
    expect(net.open()).toBe(0);
  });

  test('a reply after the first retransmission still counts', async () => {
    const c = clock();
    let n = 0;
    const net = fakeUdp((_d, _p, _a, reply) => {
      if (++n === 2) reply(bytes(0, 128, [0, 2], [1, 4], 198, 51, 100, 7));
    });
    expect(await natpmpExternalAddress({ udp: net.udp, sleep: c.sleep, gatewayIp: GW })).toBe('198.51.100.7');
    expect(c.slept).toEqual([250, 500]);
  });

  test('result codes become readable errors', async () => {
    const c = clock();
    const net = fakeUdp((_d, _p, _a, reply) => reply(bytes(0, 128, [2, 2], [1, 4], 0, 0, 0, 0)));
    const err = await natpmpExternalAddress({ udp: net.udp, sleep: c.sleep, gatewayIp: GW }).catch((e) => e);
    expect(err.code).toBe(2);
    expect(err.message).toBe('NAT-PMP result 2 (not authorized/refused)');
  });

  test('map TCP: request layout, granted lifetime', async () => {
    const c = clock();
    const net = fakeUdp((data, _p, _a, reply) => {
      expect([...data]).toEqual([...bytes(0, 2, 0, 0, [7881, 2], [7881, 2], [3600, 4])]);
      reply(bytes(0, 130, [0, 2], [99, 4], [7881, 2], [7881, 2], [1800, 4]));
    });
    expect(
      await natpmpMap({
        udp: net.udp,
        sleep: c.sleep,
        gatewayIp: GW,
        protocol: 'tcp',
        internalPort: 7881,
        externalPort: 7881,
        lifetime: 3600,
      }),
    ).toEqual({ lifetime: 1800 });
  });

  test('map UDP: a different external port is deleted and fails', async () => {
    const c = clock();
    const requests: number[][] = [];
    const net = fakeUdp((data, _p, _a, reply) => {
      requests.push([...data]);
      const lifetime = new DataView(data.buffer, data.byteOffset).getUint32(8);
      reply(bytes(0, 129, [0, 2], [99, 4], [7882, 2], [lifetime ? 50000 : 0, 2], [lifetime, 4]));
    });
    const err = await natpmpMap({
      udp: net.udp,
      sleep: c.sleep,
      gatewayIp: GW,
      protocol: 'udp',
      internalPort: 7882,
      externalPort: 7882,
      lifetime: 3600,
    }).catch((e) => e);
    expect(err.message).toBe('NAT-PMP gave external port 50000 instead of 7882');
    expect(requests).toEqual([
      [...bytes(0, 1, 0, 0, [7882, 2], [7882, 2], [3600, 4])],
      [...bytes(0, 1, 0, 0, [7882, 2], [0, 2], [0, 4])],
    ]);
  });

  test('delete', async () => {
    const c = clock();
    const net = fakeUdp((data, _p, _a, reply) => {
      expect([...data]).toEqual([...bytes(0, 2, 0, 0, [8443, 2], [0, 2], [0, 4])]);
      reply(bytes(0, 130, [0, 2], [99, 4], [8443, 2], [0, 2], [0, 4]));
    });
    await natpmpDelete({ udp: net.udp, sleep: c.sleep, gatewayIp: GW, protocol: 'tcp', internalPort: 8443 });
  });
});
