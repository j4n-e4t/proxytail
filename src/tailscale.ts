import { hosts, settings } from "./db";

const API = "https://api.tailscale.com/api/v2";
const DEVICE_CACHE_MS = 15_000;

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

/** Resolved credentials: values saved in the UI win over environment variables. */
export function tailscaleConfig() {
  return {
    tailnet: settings.get("tailnet") || process.env.TS_TAILNET || "-",
    apiKey: settings.get("ts_api_key") || process.env.TS_API_KEY || "",
    oauthClientId: settings.get("ts_oauth_client_id") || process.env.TS_OAUTH_CLIENT_ID || "",
    oauthClientSecret: settings.get("ts_oauth_client_secret") || process.env.TS_OAUTH_CLIENT_SECRET || "",
  };
}

export function isConfigured() {
  const c = tailscaleConfig();
  return !!process.env.TS_MOCK_DEVICES || !!c.apiKey || !!(c.oauthClientId && c.oauthClientSecret);
}

let oauthToken: { clientId: string; token: string; expiresAt: number } | null = null;

async function authorization(): Promise<string> {
  const c = tailscaleConfig();
  if (c.oauthClientId && c.oauthClientSecret) {
    if (oauthToken && oauthToken.clientId === c.oauthClientId && oauthToken.expiresAt > Date.now() + 60_000) {
      return `Bearer ${oauthToken.token}`;
    }
    const res = await fetch(`${API}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: c.oauthClientId, client_secret: c.oauthClientSecret }),
    });
    if (!res.ok) throw new TailscaleError(`OAuth token exchange failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    oauthToken = { clientId: c.oauthClientId, token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return `Bearer ${body.access_token}`;
  }
  if (c.apiKey) return `Bearer ${c.apiKey}`;
  throw new TailscaleError("Tailscale API credentials are not configured", 503);
}

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
  if (process.env.TS_MOCK_DEVICES) {
    // Development aid: a JSON file in the Tailscale API's `{ devices: [...] }` format.
    raw = (await Bun.file(process.env.TS_MOCK_DEVICES).json()).devices;
  } else {
    const { tailnet } = tailscaleConfig();
    const res = await fetch(`${API}/tailnet/${encodeURIComponent(tailnet)}/devices?fields=all`, {
      headers: { Authorization: await authorization() },
    });
    if (!res.ok) throw new TailscaleError(`Tailscale API returned ${res.status}: ${await res.text()}`);
    raw = ((await res.json()) as { devices: ApiDevice[] }).devices;
  }
  return raw.map(normalize).sort((a, b) => a.name.localeCompare(b.name));
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
