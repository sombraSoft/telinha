import { describe, expect, test } from 'bun:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { defaultRoute, localIpFor, parseProcNetRoute, parseRoutePrint } from '../src/nat/gateway.ts';

const PROC_ROUTE = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
wlan0\t00000000\t0100000A\t0003\t0\t0\t600\t00000000\t0\t0\t0
eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0
eth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0
docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0
`;

const ROUTE_PRINT_EN = `===========================================================================
Interface List
  3...3c 7c 3f 78 0d f0 ......Realtek Gaming GbE Family Controller
  1...........................Software Loopback Interface 1
===========================================================================

IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.50     50
          0.0.0.0          0.0.0.0      192.168.0.1    192.168.0.10     25
      192.168.0.0    255.255.255.0         On-link      192.168.0.10    281
        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331
===========================================================================
Persistent Routes:
  Network Address          Netmask  Gateway Address  Metric
          0.0.0.0          0.0.0.0      192.168.0.1  Default
===========================================================================
`;

const ROUTE_PRINT_PT_BR = `===========================================================================
Lista de interfaces
  7...a4 bb 6d 11 22 33 ......Intel(R) Wi-Fi 6 AX201 160MHz
  1...........................Software Loopback Interface 1
===========================================================================

Tabela de rotas IPv4
===========================================================================
Rotas ativas:
Endereço de rede             Máscara    Ender. gateway       Interface  Custo
          0.0.0.0          0.0.0.0      10.0.0.1         10.0.0.23     35
         10.0.0.0    255.255.255.0       No vínculo         10.0.0.23    291
        127.0.0.0        255.0.0.0       No vínculo         127.0.0.1    331
===========================================================================
Rotas persistentes:
  Nenhum
`;

const nic = (address: string, netmask: string, internal = false): NetworkInterfaceInfo =>
  ({ address, netmask, family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null }) as NetworkInterfaceInfo;

const IFACES = {
  lo: [nic('127.0.0.1', '255.0.0.0', true)],
  docker0: [nic('172.17.0.1', '255.255.0.0')],
  eth0: [nic('192.168.0.10', '255.255.255.0')],
  wlan0: [nic('10.0.0.5', '255.255.255.0')],
};

describe('parseProcNetRoute', () => {
  test('lowest-metric default route, little-endian gateway', () => {
    expect(parseProcNetRoute(PROC_ROUTE)).toEqual({ iface: 'eth0', gatewayIp: '192.168.0.1' });
  });

  test('no default route -> null', () => {
    const [header, , , local] = PROC_ROUTE.split('\n');
    expect(parseProcNetRoute(`${header}\n${local}\n`)).toBeNull();
    expect(parseProcNetRoute('')).toBeNull();
  });

  test('routes without the gateway flag are ignored', () => {
    const text =
      'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n' +
      'tun0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\n' +
      'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\n';
    expect(parseProcNetRoute(text)).toEqual({ iface: 'eth0', gatewayIp: '192.168.1.1' });
  });
});

describe('parseRoutePrint', () => {
  test('English headers: lowest metric, persistent rows ignored', () => {
    expect(parseRoutePrint(ROUTE_PRINT_EN)).toEqual({ gatewayIp: '192.168.0.1', localIp: '192.168.0.10' });
  });

  test('pt-BR headers: the numeric rows are the same', () => {
    expect(parseRoutePrint(ROUTE_PRINT_PT_BR)).toEqual({ gatewayIp: '10.0.0.1', localIp: '10.0.0.23' });
  });

  test('CRLF output', () => {
    expect(parseRoutePrint(ROUTE_PRINT_EN.replace(/\n/g, '\r\n'))).toEqual({
      gatewayIp: '192.168.0.1',
      localIp: '192.168.0.10',
    });
  });

  test('no default route -> null', () => {
    expect(
      parseRoutePrint('Active Routes:\n        127.0.0.0        255.0.0.0         On-link         127.0.0.1    331\n'),
    ).toBeNull();
  });
});

describe('localIpFor', () => {
  test('named interface wins', () => {
    expect(localIpFor('192.168.0.1', IFACES, 'eth0')).toBe('192.168.0.10');
  });

  test('else the interface whose subnet holds the gateway', () => {
    expect(localIpFor('10.0.0.1', IFACES)).toBe('10.0.0.5');
    expect(localIpFor('10.0.0.1', IFACES, 'missing0')).toBe('10.0.0.5');
  });

  test('else the first non-loopback IPv4', () => {
    expect(localIpFor('203.0.113.1', IFACES)).toBe('172.17.0.1');
    expect(localIpFor('203.0.113.1', { lo: IFACES.lo })).toBeNull();
  });
});

describe('defaultRoute', () => {
  test('linux: /proc/net/route + interface address', async () => {
    const r = await defaultRoute({
      platform: 'linux',
      readProcRoute: async () => PROC_ROUTE,
      interfaces: () => IFACES,
    });
    expect(r).toEqual({ gatewayIp: '192.168.0.1', localIp: '192.168.0.10' });
  });

  test('windows: route print', async () => {
    const r = await defaultRoute({
      platform: 'win32',
      routePrint: async () => ROUTE_PRINT_PT_BR,
      interfaces: () => IFACES,
    });
    expect(r).toEqual({ gatewayIp: '10.0.0.1', localIp: '10.0.0.23' });
  });

  test('never throws', async () => {
    expect(
      await defaultRoute({
        platform: 'linux',
        readProcRoute: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeNull();
    expect(
      await defaultRoute({
        platform: 'win32',
        routePrint: async () => {
          throw new Error('spawn failed');
        },
      }),
    ).toBeNull();
    expect(
      await defaultRoute({
        platform: 'linux',
        readProcRoute: async () => PROC_ROUTE,
        interfaces: () => {
          throw new Error('boom');
        },
      }),
    ).toBeNull();
  });
});
