export type ClientAuth = "off" | "require" | "optional";

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
  basicAuth: boolean;
  basicAuthUsers: { username: string }[];
  healthCheck: boolean;
  healthCheckPath: string;
  clientAuth: ClientAuth;
  clientCaIds: number[];
  clientCertHeaders: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProxyHostDraft = Pick<
  ProxyHost,
    | "domains"
  | "deviceId"
  | "targetPort"
  | "scheme"
  | "insecureSkipVerify"
  | "enabled"
  | "basicAuth"
  | "healthCheck"
  | "healthCheckPath"
  | "clientAuth"
  | "clientCaIds"
  | "clientCertHeaders"
> & {
  /** Omit `password` to keep the stored one; `previous` is the username before a rename. */
  basicAuthUsers: { username: string; password?: string; previous?: string }[];
};

export interface CertSummary {
  subject: string;
  issuer: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  fingerprint: string;
}

export interface ClientCa {
  id: number;
  name: string;
  certPem: string;
  summary: CertSummary;
  certCount: number;
  createdAt: string;
  /** Services that verify client certificates against this CA. */
  hostIds: number[];
}

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
  /** Where peers are listed from: the Tailscale API or a mock file. */
  source: "api" | "mock" | null;
  mock: boolean;
  /** Only peers with this ACL tag are listed and can be targeted. */
  backendTag: string;
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
  /** Only present for services with a health check. */
  health: Record<number, { up: boolean; url: string }>;
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
  clientCas: () => request<ClientCa[]>("GET", "/api/client-cas"),
  /** `pem`: the CA certificate, or a bundle with intermediates. Never a key. */
  createClientCa: (ca: { name: string; pem: string }) => request<ClientCa>("POST", "/api/client-cas", ca),
  renameClientCa: (id: number, name: string) => request<ClientCa>("PATCH", `/api/client-cas/${id}`, { name }),
  deleteClientCa: (id: number) => request<void>("DELETE", `/api/client-cas/${id}`),
  detectIp: () => request<{ ip: string }>("POST", "/api/settings/detect-ip"),
  settings: () => request<Settings>("GET", "/api/settings"),
  saveSettings: (s: Record<string, string | null>) => request<Settings>("PUT", "/api/settings", s),
  testSettings: () => request<{ ok: boolean; devices: number }>("POST", "/api/settings/test"),
  traefik: () => request<TraefikStatus>("GET", "/api/traefik/status"),
};
