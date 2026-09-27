import { hosts, settings } from "./db";

const API = "https://api.tailscale.com/api/v2";
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

/**
 * Peers are listed through the Tailscale API with an OAuth client. It only needs the read-only `devices:core:read`
 * scope, so a leaked secret exposes the device list and nothing else. Credentials only come from the environment.
 */
export function tailscaleConfig() {
  return {
    tailnet: process.env.TS_TAILNET || "-",
    oauthClientId: process.env.TS_OAUTH_CLIENT_ID || "",
    oauthClientSecret: process.env.TS_OAUTH_CLIENT_SECRET || "",
    /** Only peers carrying this ACL tag are listed and can be targeted. */
    backendTag: settings.get("backend_tag") || process.env.TS_BACKEND_TAG || DEFAULT_BACKEND_TAG,
  };
}

/** Accepts "name" or "tag:name"; returns the canonical "tag:name" or null if invalid. */
export function normalizeTag(raw: string): string | null {
  const tag = raw.trim().replace(/^tag:/, "");
  return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(tag) ? `tag:${tag}` : null;
}

/** Where peers are listed from: a mock file, or the Tailscale API. */
export type DeviceSource = "mock" | "api";

export function deviceSource(): DeviceSource | null {
  if (process.env.TS_MOCK_DEVICES) return "mock";
  const c = tailscaleConfig();
  return c.oauthClientId && c.oauthClientSecret ? "api" : null;
}

export function isConfigured() {
  return deviceSource() !== null;
}

let oauthToken: { token: string; expiresAt: number } | null = null;

async function authorization(): Promise<string> {
  if (oauthToken && oauthToken.expiresAt > Date.now() + 60_000) return `Bearer ${oauthToken.token}`;
  const c = tailscaleConfig();
  if (!c.oauthClientId || !c.oauthClientSecret)
    throw new TailscaleError("Set TS_OAUTH_CLIENT_ID and TS_OAUTH_CLIENT_SECRET to list peers", 503);
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: c.oauthClientId, client_secret: c.oauthClientSecret }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new TailscaleError(`OAuth token exchange failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  oauthToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return `Bearer ${body.access_token}`;
}

/** A device in the Tailscale API's format, also used by mock files. */
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
  let raw: ApiDevice[];
  if (deviceSource() === "mock") {
    // Development aid: a JSON file in the Tailscale API's `{ devices: [...] }` format.
    raw = (await Bun.file(process.env.TS_MOCK_DEVICES!).json()).devices;
  } else {
    const { tailnet } = tailscaleConfig();
    const res = await fetch(`${API}/tailnet/${encodeURIComponent(tailnet)}/devices?fields=all`, {
      headers: { Authorization: await authorization() },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new TailscaleError(`Tailscale API returned ${res.status}: ${await res.text()}`);
    raw = ((await res.json()) as { devices: ApiDevice[] }).devices;
  }
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
  oauthToken = null;
}
