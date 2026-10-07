// Router port mapping without dependencies: UPnP IGD (SSDP + SOAP), PCP and
// NAT-PMP. `createPortMapper` keeps the media (and, in direct mode, HTTPS)
// ports forwarded while telinha runs; `probe` answers "is there a router we
// can talk to, and what is its external IP" for setup and doctor.

export type Protocol = 'tcp' | 'udp';

export interface Mapping {
  protocol: Protocol;
  externalPort: number;
  internalPort: number;
  description: string;
}

export type Gateway =
  | {
      kind: 'igd';
      version: 1 | 2;
      location: string;
      controlUrl: string;
      serviceType: string;
      localIp: string;
      gatewayIp: string;
      /** The router's friendlyName from its device description, when it has one. */
      name?: string;
    }
  | { kind: 'pcp' | 'natpmp'; gatewayIp: string; localIp: string };

export interface NatProbe {
  gateway: Gateway | null;
  externalIp: string | null;
  localIp: string | null;
  errors: string[];
}

export type MappingState = 'mapped' | 'failed' | 'pending';

export interface MapperStatus {
  enabled: boolean;
  gateway: Gateway | null;
  externalIp: string | null;
  mappings: (Mapping & { state: MappingState; leaseEndsAt?: number; error?: string })[];
}

export interface PortMapper {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): MapperStatus;
  refresh(): Promise<void>;
}

/** The slice of a UDP socket the protocols need; the default wraps Bun.udpSocket bound to 0.0.0.0:<ephemeral>. */
export interface UdpSocket {
  send(data: Uint8Array | string, port: number, address: string): void;
  close(): void;
}
export type UdpFactory = (o: {
  onMessage: (data: Uint8Array, port: number, address: string) => void;
  /** Set for SSDP: outgoing interface of the multicast M-SEARCH (TTL 2). */
  multicastInterface?: string | null;
}) => Promise<UdpSocket>;

export interface NatDeps {
  udp: UdpFactory;
  fetch: typeof fetch;
  /** The default route; null when there is none. */
  routes: () => Promise<{ gatewayIp: string; localIp: string } | null>;
  now: () => number;
  /** Must resolve early when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** n random bytes (PCP nonces). */
  random: (n: number) => Uint8Array;
}

export { defaultRoute } from './gateway.ts';
export { createPortMapper, defaultNatDeps, discoverGateways, probe } from './mapper.ts';
