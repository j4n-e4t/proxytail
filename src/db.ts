import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    verified INTEGER NOT NULL DEFAULT 0,
    last_check TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export type Scheme = "http" | "https";

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
        `INSERT INTO proxy_hosts (domains, device_id, device_name, target_ip, target_port, scheme, insecure_skip_verify, enabled)
         VALUES ($domains, $device_id, $device_name, $target_ip, $target_port, $scheme, $insecure_skip_verify, $enabled)
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
           insecure_skip_verify = $insecure_skip_verify, enabled = $enabled, updated_at = datetime('now')
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

export type SettingKey = "public_address" | "tailnet" | "ts_api_key" | "ts_oauth_client_id" | "ts_oauth_client_secret";

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
