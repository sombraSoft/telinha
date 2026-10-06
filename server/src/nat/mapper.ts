// Gateway discovery (IGD, PCP, NAT-PMP), the setup/doctor probe and the port
// mapper that keeps telinha's ports forwarded while it runs.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultRoute, localIpFor } from './gateway.ts';
import { addPortMapping, deletePortMapping, getExternalIp, getSpecificEntry } from './igd.ts';
import type { Gateway, Mapping, MapperStatus, MappingState, NatDeps, NatProbe, PortMapper, UdpFactory } from './index.ts';
import { natpmpDelete, natpmpExternalAddress, natpmpMap } from './natpmp.ts';
import { pcpAnnounce, pcpDelete, pcpMap } from './pcp.ts';
import { fetchIgdService, ssdpSearch } from './ssdp.ts';

const DISCOVER_TIMEOUT_MS = 2500;
const PROBE_BUDGET_MS = 3000;
const PCP_WAIT_MS = 1000;
const NATPMP_DISCOVER_BUDGET_MS = 1250;
const NATPMP_BUDGET_MS = 5000;
/** Re-add even "permanent" or long leases this often: a router reboot forgets them. */
const RENEW_MAX_MS = 30 * 60_000;
const RENEW_MIN_MS = 30_000;
const REDISCOVER_MS = 10 * 60_000;
const STOP_CAP_MS = 3000;
/** NAT-PMP/PCP treat lifetime 0 as "delete": a 0 lease (permanent, IGD only) becomes this. */
const PMP_MIN_LEASE_S = 120;

function bunUdp(): UdpFactory {
  return async (o) => {
    const s = await Bun.udpSocket({
      hostname: '0.0.0.0', port: 0, binaryType: 'uint8array',
      socket: {
        data: (_s, data, port, address) => o.onMessage(data, port, address),
        // An ICMP "port unreachable" (a gateway without NAT-PMP/PCP) comes back as
        // ECONNREFUSED on the next recv. Without a handler Bun throws it as an
        // uncaught error and the process dies; the protocols already time out.
        error: () => {},
      },
    });
    if (o.multicastInterface !== undefined) {
      // Best effort: without them the M-SEARCH still leaves via the default interface.
      try { s.setMulticastTTL(2); } catch { /* ignore */ }
      if (o.multicastInterface) try { s.setMulticastInterface(o.multicastInterface); } catch { /* ignore */ }
    }
    return { send: (data, port, address) => { s.send(data, port, address); }, close: () => s.close() };
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function defaultNatDeps(): NatDeps {
  return {
    udp: bunUdp(),
    fetch: globalThis.fetch,
    routes: () => defaultRoute(),
    now: Date.now,
    sleep: defaultSleep,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
  };
}

const withDefaults = (o: Partial<NatDeps>): NatDeps => ({ ...defaultNatDeps(), ...o });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Discovery { gateways: Gateway[]; errors: string[]; route: { gatewayIp: string; localIp: string } | null }

/** SSDP and PCP/NAT-PMP run side by side; the result lists IGDs (the default gateway's first), then PCP, then NAT-PMP. */
async function discover(d: NatDeps, timeoutMs = DISCOVER_TIMEOUT_MS): Promise<Discovery> {
  const errors: string[] = [];
  const route = await d.routes().catch(() => null);
  const igds: Promise<Gateway | null>[] = [];
  const describeIgd = async (location: string): Promise<Gateway | null> => {
    const host = new URL(location).hostname;
    try {
      const s = await fetchIgdService(d.fetch, location);
      const localIp = route && route.gatewayIp === host ? route.localIp : localIpFor(host) ?? route?.localIp;
      if (!localIp) throw new Error('no local IPv4 address');
      return {
        kind: 'igd', version: s.version, location, controlUrl: s.controlUrl, serviceType: s.serviceType,
        localIp, gatewayIp: host, ...(s.name ? { name: s.name } : {}),
      };
    } catch (e) {
      // TVs and NAS boxes answer upnp:rootdevice too: not being a router is not an error.
      if (!msg(e).startsWith('no WAN')) errors.push(`UPnP device at ${host}: ${msg(e)}`);
      return null;
    }
  };
  const ssdp = ssdpSearch({
    udp: d.udp, sleep: d.sleep, localIp: route?.localIp, timeoutMs,
    onReply: (r) => { igds.push(describeIgd(r.location)); },
  }).catch((e) => { errors.push(`SSDP: ${msg(e)}`); });

  // Most routers speak only one protocol: a silent PCP/NAT-PMP is news only when nothing else answered.
  let pmpError: string | null = null;
  const pmp = (async (): Promise<Gateway[]> => {
    if (!route) return [];
    const base = { udp: d.udp, sleep: d.sleep, gatewayIp: route.gatewayIp, localIp: route.localIp };
    const pcp = await pcpAnnounce({ ...base, firstWaitMs: PCP_WAIT_MS, maxTries: 1 }).catch(() => null);
    if (pcp === 'pcp') return [{ kind: 'pcp', ...route }];
    try {
      await natpmpExternalAddress({ ...base, budgetMs: NATPMP_DISCOVER_BUDGET_MS });
      return [{ kind: 'natpmp', ...route }];
    } catch (e) {
      pmpError = `PCP/NAT-PMP at ${route.gatewayIp}: ${pcp === 'unsupported' ? msg(e) : 'no answer'}`;
      return [];
    }
  })();

  await ssdp;
  const found = (await Promise.all(igds)).filter((g): g is Gateway => g !== null);
  found.sort((a, b) => Number(b.gatewayIp === route?.gatewayIp) - Number(a.gatewayIp === route?.gatewayIp));
  const gateways = [...found, ...await pmp];
  if (!route) errors.unshift('no default IPv4 route');
  if (gateways.length === 0 && pmpError) errors.push(pmpError);
  return { gateways, errors, route };
}

/** Every gateway that answered, preferred first: UPnP IGD, then PCP, then NAT-PMP. */
export async function discoverGateways(o: NatDeps & { timeoutMs?: number }): Promise<Gateway[]> {
  return (await discover(o, o.timeoutMs)).gateways;
}

async function externalIpOf(d: NatDeps, gw: Gateway, budgetMs: number): Promise<string> {
  if (gw.kind === 'igd') return getExternalIp(d.fetch, gw);
  // PCP reports the external IP only in MAP replies; PCP gateways usually still speak NAT-PMP.
  return natpmpExternalAddress({ udp: d.udp, sleep: d.sleep, gatewayIp: gw.gatewayIp, budgetMs });
}

/** For setup and doctor: the preferred gateway and its external IP, within 3 s. */
export async function probe(o: Partial<NatDeps> = {}): Promise<NatProbe> {
  const d = withDefaults(o);
  const result: NatProbe = { gateway: null, externalIp: null, localIp: null, errors: [] };
  const work = (async () => {
    const r = await discover(d, 2000);
    result.localIp = r.route?.localIp ?? null;
    result.errors.push(...r.errors);
    result.gateway = r.gateways[0] ?? null;
    for (const gw of r.gateways) {
      try {
        result.externalIp = await externalIpOf(d, gw, 750);
        result.gateway = gw;
        break;
      } catch (e) {
        result.errors.push(`external IP from ${gw.gatewayIp}: ${msg(e)}`);
      }
    }
    result.localIp ??= result.gateway?.localIp ?? null;
  })();
  const cap = new AbortController();
  const finished = await Promise.race([work.then(() => true, () => true), d.sleep(PROBE_BUDGET_MS, cap.signal).then(() => false)]);
  cap.abort();
  if (!finished) result.errors.push(`gave up after ${PROBE_BUDGET_MS / 1000} s`);
  return { ...result, errors: [...result.errors] };
}

// --- the mapper

interface Entry {
  m: Mapping;
  state: MappingState;
  leaseEndsAt?: number;
  /** When the next renewal is due (only meaningful while mapped). */
  renewAt: number;
  error?: string;
  /** PCP mapping nonce (hex): renewals and deletes must repeat it. */
  nonce?: string;
  /** Inside a failure streak: logged once until it maps again. */
  failing: boolean;
}

interface StateFile extends MapperStatus {
  updatedAt: number;
  mappings: (MapperStatus['mappings'][number] & { nonce?: string })[];
}

const key = (m: Pick<Mapping, 'protocol' | 'externalPort' | 'internalPort'>) => `${m.protocol}/${m.externalPort}/${m.internalPort}`;
const label = (m: Mapping) => `${m.protocol.toUpperCase()} ${m.externalPort}`;
const via = (gw: Gateway) => (gw.kind === 'natpmp' ? ' via NAT-PMP' : gw.kind === 'pcp' ? ' via PCP' : '');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

export function createPortMapper(o: {
  mappings: Mapping[];
  /** data/run/upnp.json: what is mapped, for doctor and for cleanup after a crash. */
  statePath?: string;
  leaseSeconds?: number;
  log: (...a: unknown[]) => void;
} & Partial<NatDeps>): PortMapper {
  const d = withDefaults(o);
  const leaseSeconds = o.leaseSeconds ?? 3600;
  const entries: Entry[] = o.mappings.map((m) => ({ m: { ...m }, state: 'pending', renewAt: 0, failing: false }));
  let gateway: Gateway | null = null;
  let fallbacks: Gateway[] = [];
  let externalIp: string | null = null;
  let stale: StateFile['mappings'] = [];
  let started = false;
  let stopped = false;
  let noGatewayLogged = false;
  let persistFailing = false;
  let wake: AbortController | null = null;
  let chain: Promise<void> = Promise.resolve();

  const status = (): MapperStatus => ({
    enabled: true,
    gateway,
    externalIp,
    mappings: entries.map((e) => ({
      ...e.m, state: e.state,
      ...(e.leaseEndsAt !== undefined && e.state === 'mapped' ? { leaseEndsAt: e.leaseEndsAt } : {}),
      ...(e.error !== undefined && e.state === 'failed' ? { error: e.error } : {}),
    })),
  });

  const persist = () => {
    if (!o.statePath) return;
    const s = status();
    const file: StateFile = { ...s, updatedAt: d.now(), mappings: s.mappings.map((m, i) => ({ ...m, ...(entries[i]!.nonce ? { nonce: entries[i]!.nonce } : {}) })) };
    try {
      mkdirSync(dirname(o.statePath), { recursive: true });
      const tmp = `${o.statePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
      renameSync(tmp, o.statePath);
      persistFailing = false;
    } catch (e) {
      if (!persistFailing) o.log('upnp: could not save the mapping state', msg(e));
      persistFailing = true;
    }
  };

  /** Mappings a previous run left behind: ours (same key) keep their PCP nonce, the rest are removed once a gateway is known. */
  const readState = () => {
    if (!o.statePath) return;
    let file: Partial<StateFile>;
    try {
      file = JSON.parse(readFileSync(o.statePath, 'utf8'));
    } catch {
      return;
    }
    for (const m of Array.isArray(file.mappings) ? file.mappings : []) {
      if (m?.state !== 'mapped' || (m.protocol !== 'tcp' && m.protocol !== 'udp')) continue;
      const mine = entries.find((e) => key(e.m) === key(m));
      if (mine) {
        if (typeof m.nonce === 'string' && /^[0-9a-f]{24}$/.test(m.nonce)) mine.nonce = m.nonce;
      } else {
        stale.push(m);
      }
    }
  };

  const nonceOf = (e: { nonce?: string }) => {
    e.nonce ??= hex(d.random(12));
    return unhex(e.nonce);
  };

  const add = async (gw: Gateway, e: Entry): Promise<number> => {
    const pmpLease = Math.max(leaseSeconds, PMP_MIN_LEASE_S);
    const common = { udp: d.udp, sleep: d.sleep, gatewayIp: gw.gatewayIp, budgetMs: NATPMP_BUDGET_MS };
    const ports = { protocol: e.m.protocol, internalPort: e.m.internalPort, externalPort: e.m.externalPort };
    if (gw.kind === 'igd') return (await addPortMapping(d.fetch, gw, e.m, leaseSeconds)).lease;
    if (gw.kind === 'natpmp') return (await natpmpMap({ ...common, ...ports, lifetime: pmpLease })).lifetime;
    const r = await pcpMap({ ...common, localIp: gw.localIp, ...ports, lifetime: pmpLease, nonce: nonceOf(e) });
    if (r.externalIp) externalIp = r.externalIp;
    return r.lifetime;
  };

  const remove = async (gw: Gateway, m: Mapping, nonce?: string) => {
    const common = { udp: d.udp, sleep: d.sleep, gatewayIp: gw.gatewayIp, budgetMs: STOP_CAP_MS };
    if (gw.kind === 'igd') return deletePortMapping(d.fetch, gw, m);
    if (gw.kind === 'natpmp') return natpmpDelete({ ...common, protocol: m.protocol, internalPort: m.internalPort });
    // Without the nonce PCP refuses the delete (NOT_AUTHORIZED); the lease runs out instead.
    if (nonce) return pcpDelete({ ...common, localIp: gw.localIp, protocol: m.protocol, internalPort: m.internalPort, nonce: unhex(nonce) });
  };

  const removeStale = async (gw: Gateway) => {
    const list = stale;
    stale = [];
    for (const m of list) {
      try {
        // The external port may belong to another device by now: only remove our own entry.
        if (gw.kind === 'igd' && (await getSpecificEntry(d.fetch, gw, m))?.internalClient !== gw.localIp) continue;
        await remove(gw, m, m.nonce);
        o.log(`upnp: removed stale mapping ${label(m)}`);
      } catch { /* gone already, or the router forgot it */ }
    }
  };

  const mapAll = async (gw: Gateway, force: boolean) => {
    for (const e of entries) {
      if (stopped) return;
      if (!force && e.state === 'mapped' && e.renewAt > d.now()) continue;
      const before = e.state;
      try {
        const lease = await add(gw, e);
        const now = d.now();
        e.state = 'mapped';
        e.error = undefined;
        e.leaseEndsAt = lease > 0 ? now + lease * 1000 : undefined;
        e.renewAt = now + (lease > 0 ? Math.min(Math.max(lease * 500, RENEW_MIN_MS), RENEW_MAX_MS) : RENEW_MAX_MS);
        // Routine renewals stay quiet; first mappings and recoveries are worth a line.
        if (before !== 'mapped' || e.failing) {
          o.log(`upnp: mapped ${label(e.m)} -> ${gw.localIp}:${e.m.internalPort}${via(gw)} (${lease > 0 ? `lease ${lease}s` : 'permanent'})`);
        }
        e.failing = false;
      } catch (err) {
        e.state = 'failed';
        e.error = msg(err);
        e.leaseEndsAt = undefined;
        if (!e.failing) o.log(`upnp: could not map ${label(e.m)}${via(gw)}: ${e.error}`);
        e.failing = true;
      }
    }
  };

  const anyMapped = () => entries.some((e) => e.state === 'mapped');

  const cycle = async (force: boolean) => {
    if (!gateway || !anyMapped()) {
      const found = (await discover(d)).gateways;
      gateway = found[0] ?? null;
      fallbacks = found.slice(1);
    }
    if (stopped) return;
    if (!gateway) {
      // Nothing to map (only stale entries to drop): no advice, and the state file keeps them for a later run.
      if (!entries.length) return;
      for (const e of entries) {
        e.state = 'failed';
        e.error = 'no gateway';
        e.leaseEndsAt = undefined;
      }
      if (!noGatewayLogged) o.log('upnp: no UPnP/NAT-PMP gateway found; forward the ports on the router by hand');
      noGatewayLogged = true;
      persist();
      return;
    }
    noGatewayLogged = false;
    await removeStale(gateway);
    await mapAll(gateway, force);
    // The preferred gateway refused everything (UPnP disabled, IGD actions failing): try the others.
    for (const alt of fallbacks) {
      if (anyMapped() || stopped) break;
      await mapAll(alt, true);
      if (anyMapped()) {
        fallbacks = [gateway, ...fallbacks.filter((g) => g !== alt)];
        gateway = alt;
      }
    }
    if (gateway.kind !== 'pcp' && !stopped) {
      externalIp = await externalIpOf(d, gateway, 1000).catch(() => externalIp);
    }
    persist();
  };

  const runCycle = (force: boolean) => {
    chain = chain
      .then(() => (stopped ? undefined : cycle(force)))
      .catch((e) => { o.log('upnp: unexpected error', msg(e)); });
    return chain;
  };

  const nextDelay = () => {
    const mapped = entries.filter((e) => e.state === 'mapped');
    if (!gateway || mapped.length === 0) return REDISCOVER_MS;
    return Math.max(0, Math.min(...mapped.map((e) => e.renewAt)) - d.now());
  };

  // A chain of sleeps, not setInterval: the next renewal is computed after each cycle.
  const loop = async () => {
    while (!stopped) {
      const w = new AbortController();
      wake = w;
      await d.sleep(nextDelay(), w.signal);
      if (stopped) return;
      if (w.signal.aborted) continue; // refresh() just ran a cycle: recompute the delay
      await runCycle(false);
    }
  };

  /** Deletes what is mapped now; entries are 'pending' afterwards, 'mapped' again when the delete failed. */
  const deleteMapped = async () => {
    const gw = gateway;
    if (!gw) return;
    const list = entries.filter((e) => e.state === 'mapped');
    for (const e of list) e.state = 'pending';
    const results = await Promise.allSettled(list.map((e) => remove(gw, e.m, e.nonce)));
    results.forEach((r, i) => {
      const e = list[i]!;
      if (r.status === 'rejected') {
        e.state = 'mapped';
        o.log(`upnp: could not remove ${label(e.m)}: ${msg(r.reason)}`);
      } else {
        e.leaseEndsAt = undefined;
      }
    });
  };

  return {
    status,
    async start() {
      if (started) return;
      started = true;
      readState();
      // Nothing to map (LiveKit Cloud behind a tunnel, say): one cycle only to drop
      // what a previous run left, and no rediscovery loop.
      if (!entries.length) {
        if (stale.length) await runCycle(false);
        return;
      }
      await runCycle(false);
      if (!stopped) void loop();
    },
    async refresh() {
      if (!started || stopped || !entries.length) return;
      await runCycle(true);
      wake?.abort();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      // Never started: keep the state file, its stale entries are for the next start().
      // Nothing to map: nothing to delete, and stale entries no gateway took stay listed.
      if (!started || !entries.length) return;
      wake?.abort();
      const work = (async () => {
        const first = deleteMapped();
        await chain;
        await first;
        await deleteMapped(); // anything an in-flight cycle mapped meanwhile
      })();
      const cap = new AbortController();
      await Promise.race([work, d.sleep(STOP_CAP_MS, cap.signal)]);
      cap.abort();
      persist();
    },
  };
}
