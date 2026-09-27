import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CertSummary } from "./pki";

const dataDir = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, "proxytail.db"), { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

db.run(`
  CREATE TABLE IF NOT EXISTS proxy_hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domains TEXT NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    target_ip TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    scheme TEXT NOT NULL DEFAULT 'http',
    insecure_skip_verify INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
// Columns added after the initial release.
const hostColumns = db.query<{ name: string }, []>("PRAGMA table_info(proxy_hosts)").all().map((c) => c.name);
if (!hostColumns.includes("basic_auth")) {
  db.run("ALTER TABLE proxy_hosts ADD COLUMN basic_auth INTEGER NOT NULL DEFAULT 0");
  db.run("ALTER TABLE proxy_hosts ADD COLUMN basic_auth_users TEXT NOT NULL DEFAULT '[]'");
}
// Off for services created before health checks existed, so a failing check can't take a working route offline.
if (!hostColumns.includes("health_check")) {
  db.run("ALTER TABLE proxy_hosts ADD COLUMN health_check INTEGER NOT NULL DEFAULT 0");
  db.run("ALTER TABLE proxy_hosts ADD COLUMN health_check_path TEXT NOT NULL DEFAULT '/'");
}
if (!hostColumns.includes("client_auth")) {
  db.run("ALTER TABLE proxy_hosts ADD COLUMN client_auth TEXT NOT NULL DEFAULT 'off'");
  db.run("ALTER TABLE proxy_hosts ADD COLUMN client_ca_ids TEXT NOT NULL DEFAULT '[]'");
  db.run("ALTER TABLE proxy_hosts ADD COLUMN client_cert_headers INTEGER NOT NULL DEFAULT 0");
}

db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// Tailscale API credentials were removed: peers and identities come from the local tailscaled.
db.run(
  "DELETE FROM settings WHERE key IN ('tailnet', 'ts_api_key', 'ts_oauth_client_id', 'ts_oauth_client_secret')",
);

db.run(`
  CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    verified INTEGER NOT NULL DEFAULT 0,
    last_check TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS client_cas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cert_pem TEXT NOT NULL,
    key_pem TEXT,
    summary TEXT NOT NULL,
    cert_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS client_certs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ca_id INTEGER NOT NULL REFERENCES client_cas(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export type Scheme = "http" | "https";

/**
 * Client certificate (mTLS) policy of a service. `require` rejects the TLS handshake without a certificate from one of
 * the service's CAs; `optional` verifies a certificate if the client sends one, and lets the service decide.
 */
export type ClientAuth = "off" | "require" | "optional";

/** A basic auth credential; `hash` is an htpasswd-compatible bcrypt hash. */
export interface BasicAuthUser {
  username: string;
  hash: string;
}

export interface ProxyHost {
  id: number;
  domains: string[];
  deviceId: string;
  deviceName: string;
  targetIp: string;
  targetPort: number;
  scheme: Scheme;
  insecureSkipVerify: boolean;
  enabled: boolean;
  basicAuth: boolean;
  basicAuthUsers: BasicAuthUser[];
  /** Traefik probes the backend and marks it down when the check fails. */
  healthCheck: boolean;
  healthCheckPath: string;
  clientAuth: ClientAuth;
  clientCaIds: number[];
  /** Forward the verified client certificate's details to the service in X-Forwarded-Tls-Client-Cert-Info. */
  clientCertHeaders: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProxyHostInput = Omit<ProxyHost, "id" | "createdAt" | "updatedAt">;

interface ProxyHostRow {
  id: number;
  domains: string;
  device_id: string;
  device_name: string;
  target_ip: string;
  target_port: number;
  scheme: Scheme;
  insecure_skip_verify: number;
  enabled: number;
  basic_auth: number;
  basic_auth_users: string;
  health_check: number;
  health_check_path: string;
  client_auth: ClientAuth;
  client_ca_ids: string;
  client_cert_headers: number;
  created_at: string;
  updated_at: string;
}

function toHost(r: ProxyHostRow): ProxyHost {
  return {
    id: r.id,
    domains: JSON.parse(r.domains),
    deviceId: r.device_id,
    deviceName: r.device_name,
    targetIp: r.target_ip,
    targetPort: r.target_port,
    scheme: r.scheme,
    insecureSkipVerify: !!r.insecure_skip_verify,
    enabled: !!r.enabled,
    basicAuth: !!r.basic_auth,
    basicAuthUsers: JSON.parse(r.basic_auth_users),
    healthCheck: !!r.health_check,
    healthCheckPath: r.health_check_path,
    clientAuth: r.client_auth,
    clientCaIds: JSON.parse(r.client_ca_ids),
    clientCertHeaders: !!r.client_cert_headers,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toParams(h: ProxyHostInput) {
  return {
    domains: JSON.stringify(h.domains),
    device_id: h.deviceId,
    device_name: h.deviceName,
    target_ip: h.targetIp,
    target_port: h.targetPort,
    scheme: h.scheme,
    insecure_skip_verify: h.insecureSkipVerify ? 1 : 0,
    enabled: h.enabled ? 1 : 0,
    basic_auth: h.basicAuth ? 1 : 0,
    basic_auth_users: JSON.stringify(h.basicAuthUsers),
    health_check: h.healthCheck ? 1 : 0,
    health_check_path: h.healthCheckPath,
    client_auth: h.clientAuth,
    client_ca_ids: JSON.stringify(h.clientCaIds),
    client_cert_headers: h.clientCertHeaders ? 1 : 0,
  };
}

export const hosts = {
  list(): ProxyHost[] {
    return db.query<ProxyHostRow, []>("SELECT * FROM proxy_hosts ORDER BY id").all().map(toHost);
  },
  get(id: number): ProxyHost | null {
    const row = db.query<ProxyHostRow, [number]>("SELECT * FROM proxy_hosts WHERE id = ?").get(id);
    return row ? toHost(row) : null;
  },
  create(h: ProxyHostInput): ProxyHost {
    const row = db
      .query<ProxyHostRow, any>(
        `INSERT INTO proxy_hosts (domains, device_id, device_name, target_ip, target_port, scheme, insecure_skip_verify, enabled,
           basic_auth, basic_auth_users, health_check, health_check_path, client_auth, client_ca_ids, client_cert_headers)
         VALUES ($domains, $device_id, $device_name, $target_ip, $target_port, $scheme, $insecure_skip_verify, $enabled,
           $basic_auth, $basic_auth_users, $health_check, $health_check_path, $client_auth, $client_ca_ids,
           $client_cert_headers)
         RETURNING *`,
      )
      .get(toParams(h))!;
    return toHost(row);
  },
  update(id: number, h: ProxyHostInput): ProxyHost | null {
    const row = db
      .query<ProxyHostRow, any>(
        `UPDATE proxy_hosts SET domains = $domains, device_id = $device_id, device_name = $device_name,
           target_ip = $target_ip, target_port = $target_port, scheme = $scheme,
           insecure_skip_verify = $insecure_skip_verify, enabled = $enabled, basic_auth = $basic_auth,
           basic_auth_users = $basic_auth_users, health_check = $health_check, health_check_path = $health_check_path,
           client_auth = $client_auth, client_ca_ids = $client_ca_ids, client_cert_headers = $client_cert_headers,
           updated_at = datetime('now')
         WHERE id = $id RETURNING *`,
      )
      .get({ ...toParams(h), id });
    return row ? toHost(row) : null;
  },
  delete(id: number): boolean {
    return db.query("DELETE FROM proxy_hosts WHERE id = ?").run(id).changes > 0;
  },
  /** Keep stored target IPs/names in sync with the tailnet (e.g. after a node re-registers). */
  syncDevice(deviceId: string, name: string, ip: string) {
    db.query(
      `UPDATE proxy_hosts SET device_name = $name, target_ip = $ip, updated_at = datetime('now')
       WHERE device_id = $deviceId AND (device_name != $name OR target_ip != $ip)`,
    ).run({ deviceId, name, ip });
  },
};

export interface DnsCheck {
  ok: boolean;
  checkedAt: string;
  expected: string[];
  /** A random subdomain was resolved to prove a `*.domain` record exists. */
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
}

interface DomainRow {
  id: number;
  name: string;
  verified: number;
  last_check: string | null;
  created_at: string;
}

const toDomain = (r: DomainRow): Domain => ({
  id: r.id,
  name: r.name,
  verified: !!r.verified,
  lastCheck: r.last_check ? JSON.parse(r.last_check) : null,
  createdAt: r.created_at,
});

export const domains = {
  list(): Domain[] {
    return db.query<DomainRow, []>("SELECT * FROM domains ORDER BY name").all().map(toDomain);
  },
  get(id: number): Domain | null {
    const row = db.query<DomainRow, [number]>("SELECT * FROM domains WHERE id = ?").get(id);
    return row ? toDomain(row) : null;
  },
  byName(name: string): Domain | null {
    const row = db.query<DomainRow, [string]>("SELECT * FROM domains WHERE name = ?").get(name);
    return row ? toDomain(row) : null;
  },
  create(name: string): Domain {
    return toDomain(db.query<DomainRow, [string]>("INSERT INTO domains (name) VALUES (?) RETURNING *").get(name)!);
  },
  saveCheck(id: number, check: DnsCheck): Domain {
    return toDomain(
      db
        .query<DomainRow, [number, string, number]>(
          "UPDATE domains SET verified = ?, last_check = ? WHERE id = ? RETURNING *",
        )
        .get(check.ok ? 1 : 0, JSON.stringify(check), id)!,
    );
  },
  delete(id: number): boolean {
    return db.query("DELETE FROM domains WHERE id = ?").run(id).changes > 0;
  },
  /** The registered domain a hostname belongs to (longest suffix match). */
  match(hostname: string, list: Domain[] = domains.list()): Domain | undefined {
    return list
      .filter((d) => hostname === d.name || hostname.endsWith(`.${d.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
  },
};

export interface ClientCa {
  id: number;
  name: string;
  certPem: string;
  /** Only set for CAs generated here, which can issue client certificates. Never leaves the server. */
  keyPem: string | null;
  summary: CertSummary;
  /** Certificates in the bundle; imported bundles may include intermediates. */
  certCount: number;
  createdAt: string;
}

interface ClientCaRow {
  id: number;
  name: string;
  cert_pem: string;
  key_pem: string | null;
  summary: string;
  cert_count: number;
  created_at: string;
}

const toCa = (r: ClientCaRow): ClientCa => ({
  id: r.id,
  name: r.name,
  certPem: r.cert_pem,
  keyPem: r.key_pem,
  summary: JSON.parse(r.summary),
  certCount: r.cert_count,
  createdAt: r.created_at,
});

export const clientCas = {
  list(): ClientCa[] {
    return db.query<ClientCaRow, []>("SELECT * FROM client_cas ORDER BY name, id").all().map(toCa);
  },
  get(id: number): ClientCa | null {
    const row = db.query<ClientCaRow, [number]>("SELECT * FROM client_cas WHERE id = ?").get(id);
    return row ? toCa(row) : null;
  },
  create(ca: Omit<ClientCa, "id" | "createdAt">): ClientCa {
    return toCa(
      db
        .query<ClientCaRow, any>(
          `INSERT INTO client_cas (name, cert_pem, key_pem, summary, cert_count)
           VALUES ($name, $cert_pem, $key_pem, $summary, $cert_count) RETURNING *`,
        )
        .get({
          name: ca.name,
          cert_pem: ca.certPem,
          key_pem: ca.keyPem,
          summary: JSON.stringify(ca.summary),
          cert_count: ca.certCount,
        })!,
    );
  },
  rename(id: number, name: string): ClientCa | null {
    const row = db.query<ClientCaRow, [string, number]>("UPDATE client_cas SET name = ? WHERE id = ? RETURNING *").get(name, id);
    return row ? toCa(row) : null;
  },
  delete(id: number): boolean {
    return db.query("DELETE FROM client_cas WHERE id = ?").run(id).changes > 0;
  },
};

/** A client certificate issued by a generated CA. Only its public details are kept, not its key. */
export interface ClientCert {
  id: number;
  caId: number;
  summary: CertSummary;
  createdAt: string;
}

interface ClientCertRow {
  id: number;
  ca_id: number;
  summary: string;
  created_at: string;
}

const toClientCert = (r: ClientCertRow): ClientCert => ({
  id: r.id,
  caId: r.ca_id,
  summary: JSON.parse(r.summary),
  createdAt: r.created_at,
});

export const clientCerts = {
  list(): ClientCert[] {
    return db.query<ClientCertRow, []>("SELECT * FROM client_certs ORDER BY id DESC").all().map(toClientCert);
  },
  create(caId: number, summary: CertSummary): ClientCert {
    return toClientCert(
      db
        .query<ClientCertRow, [number, string]>("INSERT INTO client_certs (ca_id, summary) VALUES (?, ?) RETURNING *")
        .get(caId, JSON.stringify(summary))!,
    );
  },
  delete(id: number): boolean {
    return db.query("DELETE FROM client_certs WHERE id = ?").run(id).changes > 0;
  },
};

export type SettingKey = "public_address" | "backend_tag";

export const settings = {
  get(key: SettingKey): string | undefined {
    return db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value;
  },
  set(key: SettingKey, value: string | null) {
    if (value === null || value === "") db.query("DELETE FROM settings WHERE key = ?").run(key);
    else
      db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
        key,
        value,
      );
  },
};
