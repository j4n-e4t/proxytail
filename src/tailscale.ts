import { existsSync } from "node:fs";
import { hosts, settings } from "./db";

/** tailscaled's LocalAPI socket, shared with the sidecar through a volume in docker-compose.yml. */
const SOCKET = process.env.TS_SOCKET || "/var/run/tailscale/tailscaled.sock";
const DEVICE_CACHE_MS = 15_000;
const DEFAULT_BACKEND_TAG = "tag:proxytail-backend";

export interface Device {
  id: string;
  name: string;
  fqdn: string;
  hostname: string;
  ipv4: string | null;
  ipv6: string | null;
  os: string;
  user: string;
  tags: string[];
  online: boolean;
  lastSeen: string | null;
  authorized: boolean;
}

export class TailscaleError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

/** Resolved settings: values saved in the UI win over environment variables. */
export function tailscaleConfig() {
  return {
    /** Only peers carrying this ACL tag are listed and can be targeted. */
    backendTag: settings.get("backend_tag") || process.env.TS_BACKEND_TAG || DEFAULT_BACKEND_TAG,
  };
}

/** Accepts "name" or "tag:name"; returns the canonical "tag:name" or null if invalid. */
export function normalizeTag(raw: string): string | null {
  const tag = raw.trim().replace(/^tag:/, "");
  return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(tag) ? `tag:${tag}` : null;
}

/**
 * Where peers are listed from: a mock file, or the local tailscaled, which only sees peers the tailnet policy lets
 * this node reach.
 */
export type DeviceSource = "mock" | "local";

export function deviceSource(): DeviceSource | null {
  if (process.env.TS_MOCK_DEVICES) return "mock";
  return existsSync(SOCKET) ? "local" : null;
}

export function isConfigured() {
  return deviceSource() !== null;
}

/** Calls tailscaled's LocalAPI over its unix socket. */
async function localApi(path: string): Promise<Response> {
  try {
    // The LocalAPI rejects other Host headers (DNS rebinding protection).
    return await fetch(`http://local-tailscaled.sock/localapi/v0/${path}`, {
      unix: SOCKET,
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    throw new TailscaleError(`Can't reach tailscaled at ${SOCKET}: ${(e as Error).message}`, 503);
  }
}

interface LocalPeer {
  ID: string;
  HostName: string;
  DNSName: string;
  OS: string;
  UserID: number;
  TailscaleIPs?: string[];
  Tags?: string[];
  Online?: boolean;
  LastSeen?: string;
}

interface LocalStatus {
  Self: LocalPeer;
  Peer?: Record<string, LocalPeer>;
  User?: Record<string, { LoginName: string }>;
  CurrentTailnet?: { MagicDNSSuffix: string } | null;
}

export async function localStatus(): Promise<LocalStatus> {
  const res = await localApi("status");
  if (!res.ok) throw new TailscaleError(`tailscaled returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as LocalStatus;
}

/** Converts the LocalAPI's peer list to the Tailscale API's device format. */
function fromStatus(s: LocalStatus): ApiDevice[] {
  return Object.values(s.Peer ?? {}).map((p) => ({
    // StableNodeID: the same value as `nodeId` in the Tailscale API, so stored services keep matching.
    id: p.ID,
    name: p.DNSName.replace(/\.$/, "") || p.HostName,
    hostname: p.HostName,
    addresses: p.TailscaleIPs ?? [],
    os: p.OS,
    user: s.User?.[p.UserID]?.LoginName ?? "",
    tags: p.Tags,
    // Online peers report the zero time.
    lastSeen: p.LastSeen && !p.LastSeen.startsWith("0001-") ? p.LastSeen : undefined,
    connectedToControl: !!p.Online,
  }));
}

export interface WhoIs {
  Node: { Name: string; Tags?: string[] };
  UserProfile: { LoginName: string; DisplayName: string; ProfilePicURL?: string };
  /** App capabilities granted to this peer through `grants[].app` in the tailnet policy. */
  CapMap?: Record<string, unknown[] | null>;
}

/** Identifies the tailnet peer behind a Tailscale IP, or returns null if it isn't one. */
export async function whois(ip: string, port = 0): Promise<WhoIs | null> {
  const addr = ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
  const res = await localApi(`whois?addr=${encodeURIComponent(addr)}`);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new TailscaleError(`tailscaled whois returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as WhoIs;
}

/** A device in the Tailscale API's format, used by mock files and converted from the LocalAPI's status. */
interface ApiDevice {
  id: string;
  nodeId?: string;
  name: string;
  hostname: string;
  addresses: string[];
  os: string;
  user: string;
  tags?: string[];
  lastSeen?: string;
  connectedToControl?: boolean;
  authorized?: boolean;
}

function normalize(d: ApiDevice): Device {
  const lastSeen = d.lastSeen || null;
  // `connectedToControl` is only present with fields=all; fall back to a recent lastSeen.
  const online =
    d.connectedToControl ?? (lastSeen ? Date.now() - new Date(lastSeen).getTime() < 5 * 60_000 : false);
  return {
    id: d.nodeId || d.id,
    name: d.name.split(".")[0] || d.hostname,
    fqdn: d.name,
    hostname: d.hostname,
    ipv4: d.addresses.find((a) => !a.includes(":")) ?? null,
    ipv6: d.addresses.find((a) => a.includes(":")) ?? null,
    os: d.os,
    user: d.user,
    tags: d.tags ?? [],
    online,
    lastSeen,
    authorized: d.authorized ?? true,
  };
}

async function fetchDevices(): Promise<Device[]> {
  const raw: ApiDevice[] =
    deviceSource() === "mock"
      ? // Development aid: a JSON file in the Tailscale API's `{ devices: [...] }` format.
        (await Bun.file(process.env.TS_MOCK_DEVICES!).json()).devices
      : fromStatus(await localStatus());
  const { backendTag } = tailscaleConfig();
  return raw
    .filter((d) => d.tags?.includes(backendTag))
    .map(normalize)
    .sort((a, b) => a.name.localeCompare(b.name));
}

let cache: { at: number; devices: Device[] } | null = null;
let inflight: Promise<Device[]> | null = null;

export async function listDevices(force = false): Promise<Device[]> {
  if (!force && cache && Date.now() - cache.at < DEVICE_CACHE_MS) return cache.devices;
  inflight ??= fetchDevices()
    .then((devices) => {
      cache = { at: Date.now(), devices };
      for (const d of devices) if (d.ipv4) hosts.syncDevice(d.id, d.name, d.ipv4);
      return devices;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function clearDeviceCache() {
  cache = null;
}
