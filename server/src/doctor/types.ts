// Contract between the doctor checks and whoever runs them (CLI, setup). The
// router probe, service manager, control client and update state are described
// structurally here, so this library depends on none of those modules.
import type { Config } from '../config.ts';
import type { Locale } from '../i18n.ts';
import type { Paths } from '../paths.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** One plain-language sentence. */
  summary: string;
  detail?: string[];
  /** What to do about a warn/fail. */
  fix?: string;
}

export interface GatewayLike {
  kind: 'igd' | 'pcp' | 'natpmp';
  gatewayIp: string;
  localIp: string;
}

export interface NatProbeLike {
  gateway: GatewayLike | null;
  externalIp: string | null;
  localIp: string | null;
  errors: string[];
}

/** Anything with probe(), e.g. the nat module itself. */
export interface NatProberLike {
  probe(): Promise<NatProbeLike>;
}

export interface ServiceStatusLike {
  installed: boolean;
  running: boolean;
  enabled: boolean;
  detail: string;
}
export type ServiceStatusFn = () => Promise<ServiceStatusLike>;

export interface MappingLike {
  protocol: string;
  externalPort: number;
  internalPort: number;
  state: string;
  error?: string;
}

export interface MapperStatusLike {
  enabled: boolean;
  mappings: MappingLike[];
}

/** The running updater's view; every field optional so any richer status fits. */
export interface UpdateStatusLike {
  latest?: string | null;
  staged?: { tag: string } | null;
  failed?: { tag: string; reason?: string } | null;
  pending?: { tag: string } | null;
}

export interface ControlStatusLike {
  version?: string;
  upnp?: MapperStatusLike | null;
  update?: UpdateStatusLike | null;
}

export interface ControlClientLike {
  available(): Promise<boolean>;
  status(): Promise<ControlStatusLike>;
}

/** data/run/update.json, the fields the doctor reads. */
export interface UpdateStateLike {
  staged?: { tag: string; previous: string; at: number; failedStarts: number };
  failed?: { tag: string; at: number; reason: string };
  pending?: { tag: string; since: number };
}

/** data/run/tray.json, written by the tray at start. */
export interface TrayStateLike {
  version: string;
  pid: number;
  startedAt: number;
  exe: string;
}

/** The network probes, injectable so tests never touch the network. */
export interface NetLike {
  lookupPublicIp(fetch: typeof globalThis.fetch, timeoutMs?: number): Promise<string>;
  resolveA(host: string): Promise<string[]>;
  tlsInfo(host: string, port: number): Promise<{ validTo: number; issuer: string; subjectAltNames: string[]; authorized: boolean; error?: string }>;
  tcpOpen(host: string, port: number, timeoutMs?: number): Promise<boolean>;
}

/** Host access the checks need; defaults read the real machine. */
export interface SysLike {
  platform: NodeJS.Platform;
  isRoot: boolean;
  /** File contents, or null when it does not exist. */
  readText(path: string): string | null;
  /** st_mode, or null when the file does not exist. */
  fileMode(path: string): number | null;
  /** Owner uid, or null when the file does not exist (or on Windows). */
  fileUid?(path: string): number | null;
  /** `icacls <path>` output, or null when it could not run. */
  icacls(path: string): Promise<string | null>;
  /** Full path of a command on PATH, or null. */
  which(name: string): string | null;
  exists(path: string): boolean;
  /**
   * A file's bytes, or null when it cannot be read or is larger than maxBytes.
   * Checks read helper binaries instead of running them: doctor may run as root
   * (setup ends with it) while bin/ belongs to the service user.
   */
  readBytes?(path: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Is `pid` alive, and which executable runs there. */
  processInfo?(pid: number): { alive: boolean; exe: string | null };
  /** A string value under HKCU (key without the hive), or null when absent or unreadable. */
  registryValue?(key: string, name: string): Promise<string | null>;
  /** Authenticode state of an executable, or null when it cannot be asked. */
  signature?(path: string): Promise<{ status: string; signer: string | null } | null>;
}

export interface CheckContext {
  /** process.env merged over telinha.env (mergeEnv). */
  env: Record<string, string | undefined>;
  envFile: string;
  paths: Paths;
  config: Config | null;
  configError: string | null;
  fetch: typeof fetch;
  locale: Locale;
  /** --local: checks that need the internet report 'skip'. */
  local: boolean;
  log?: (m: string) => void;
  nat: NatProberLike | null;
  service: ServiceStatusFn | null;
  control: ControlClientLike | null;
  compiled: boolean;
  version: string;
  /** Newest stable tag, or null when unknown/offline. */
  latestTag: (() => Promise<string | null>) | null;
  /** data/run/update.json; null when absent. */
  updateState: UpdateStateLike | null;
  /** data/run/tray.json; null when absent or unreadable. */
  trayState: TrayStateLike | null;
  /** Defaults to netinfo.ts. */
  net?: NetLike;
  /** Defaults to the real host. */
  sys?: Partial<SysLike>;
  /** Pinned child binary versions; defaults to versions.json. */
  versions?: Record<string, { version: string }>;
}

export interface Check {
  id: string;
  /** Needs the internet: skipped with --local. */
  internet?: boolean;
  run(ctx: CheckContext): Promise<CheckResult>;
}
