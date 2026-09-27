export interface ProxyHost {
  id: number;
  domains: string[];
  deviceId: string;
  deviceName: string;
  targetIp: string;
  targetPort: number;
  scheme: "http" | "https";
  insecureSkipVerify: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProxyHostDraft = Pick<
  ProxyHost,
  "domains" | "deviceId" | "targetPort" | "scheme" | "insecureSkipVerify" | "enabled"
>;

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

export interface DnsCheck {
  ok: boolean;
  checkedAt: string;
  expected: string[];
  wildcard: { name: string; found: string[] };
  apex: { ok: boolean; found: string[] };
  error?: string;
}

export interface Domain {
  id: number;
  name: string;
  verified: boolean;
  lastCheck: DnsCheck | null;
  createdAt: string;
  record: { name: string; type: string; value: string } | null;
  hostCount: number;
}

export interface Settings {
  publicAddress: string;
  configured: boolean;
  mock: boolean;
  tailnet: string;
  apiKeySet: boolean;
  oauthClientId: string;
  oauthClientSecretSet: boolean;
}

export interface CertInfo {
  state: "valid" | "untrusted" | "pending" | "error";
  issuer?: string;
  subject?: string;
  validTo?: string;
  error?: string;
  checkedAt: string;
}

export interface TraefikStatus {
  reachable: boolean;
  version?: string;
  error?: string;
  routers: Record<number, { status: string; errors?: string[] }>;
  certificates: Record<number, CertInfo>;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  hosts: () => request<ProxyHost[]>("GET", "/api/hosts"),
  createHost: (h: ProxyHostDraft) => request<ProxyHost>("POST", "/api/hosts", h),
  updateHost: (id: number, h: Partial<ProxyHostDraft>) => request<ProxyHost>("PUT", `/api/hosts/${id}`, h),
  deleteHost: (id: number) => request<void>("DELETE", `/api/hosts/${id}`),
  devices: (refresh = false) => request<Device[]>("GET", `/api/devices${refresh ? "?refresh" : ""}`),
  domains: () => request<Domain[]>("GET", "/api/domains"),
  addDomain: (name: string) => request<Domain>("POST", "/api/domains", { name }),
  verifyDomain: (id: number) => request<Domain>("POST", `/api/domains/${id}/verify`),
  deleteDomain: (id: number) => request<void>("DELETE", `/api/domains/${id}`),
  detectIp: () => request<{ ip: string }>("POST", "/api/settings/detect-ip"),
  settings: () => request<Settings>("GET", "/api/settings"),
  saveSettings: (s: Record<string, string | null>) => request<Settings>("PUT", "/api/settings", s),
  testSettings: () => request<{ ok: boolean; devices: number }>("POST", "/api/settings/test"),
  traefik: () => request<TraefikStatus>("GET", "/api/traefik/status"),
};
