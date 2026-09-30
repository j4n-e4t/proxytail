import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CertSummary } from "./pki";

export const dataDir = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
mkdirSync(dataDir, { recursive: true });

export const dbPath = join(dataDir, "proxytail.db");
export const db = new Database(dbPath, { create: true, strict: true });
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
    client_auth TEXT NOT NULL DEFAULT 'off',
    client_cert_headers INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
// Captchas, shared by the services they're attached to. `secret_key` is the provider's secret for verifying solved
// challenges; it never leaves the server.
db.run(`
  CREATE TABLE IF NOT EXISTS captchas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    site_key TEXT NOT NULL,
    secret_key TEXT NOT NULL,
    lifetime INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Columns added after the initial release.
const hostColumns = db.query<{ name: string }, []>("PRAGMA table_info(proxy_hosts)").all().map((c) => c.name);
if (!hostColumns.includes("basic_auth")) {
  db.run("ALTER TABLE proxy_hosts ADD COLUMN basic_auth INTEGER NOT NULL DEFAULT 0");
}
// Every hostname after the first became an alias, served in parallel unless set otherwise.
if (!hostColumns.includes("alias_modes")) {
  db.run("ALTER TABLE proxy_hosts ADD COLUMN alias_modes TEXT NOT NULL DEFAULT '{}'");
}
if (!hostColumns.includes("no_index")) {
  db.run("ALTER TABLE proxy_hosts ADD COLUMN no_index INTEGER NOT NULL DEFAULT 0");
}
// The captcha visitors solve first, if any. Like CAs and users, a captcha that's in use can't be deleted.
if (!hostColumns.includes("captcha_id")) {
  db.run("ALTER TABLE proxy_hosts ADD COLUMN captcha_id INTEGER REFERENCES captchas(id) ON DELETE RESTRICT");
}
// Custom request headers and framing were removed; only "hide from search engines" stays.
if (hostColumns.includes("headers")) {
  db.run("UPDATE proxy_hosts SET no_index = coalesce(json_extract(headers, '$.noIndex'), 0) = 1");
  db.run("ALTER TABLE proxy_hosts DROP COLUMN headers");
}
// Backend health checks were removed.
if (hostColumns.includes("health_check")) {
  db.run("ALTER TABLE proxy_hosts DROP COLUMN health_check");
  db.run("ALTER TABLE proxy_hosts DROP COLUMN health_check_path");
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
// CrowdSec was replaced by rate limiting.
db.run("DELETE FROM settings WHERE key LIKE 'crowdsec%'");

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
    summary TEXT NOT NULL,
    cert_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Which CAs a service trusts. The foreign keys make a CA that's in use impossible to delete, and a service impossible to
// attach to a CA that doesn't exist, whatever the order of concurrent requests.
db.run(`
  CREATE TABLE IF NOT EXISTS host_client_cas (
    host_id INTEGER NOT NULL REFERENCES proxy_hosts(id) ON DELETE CASCADE,
    ca_id INTEGER NOT NULL REFERENCES client_cas(id) ON DELETE RESTRICT,
    PRIMARY KEY (host_id, ca_id)
  )
`);

// Basic auth users, shared by the services they're attached to. `hash` is an htpasswd-compatible bcrypt hash. Usernames
// are unique, except for users migrated from services that each had their own user of the same name.
const hadUserTables = !!db
  .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'host_basic_auth_users'")
  .get();
db.transaction(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS basic_auth_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Which users can sign in to a service. Like CAs, a user that's in use can't be deleted, so no service is left with
  // basic auth on and nobody to let in.
  db.run(`
    CREATE TABLE IF NOT EXISTS host_basic_auth_users (
      host_id INTEGER NOT NULL REFERENCES proxy_hosts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES basic_auth_users(id) ON DELETE RESTRICT,
      PRIMARY KEY (host_id, user_id)
    )
  `);
  if (hadUserTables || !hostColumns.includes("basic_auth_users")) return;
  // Users used to be stored per service, in basic_auth_users. Each becomes a shared user, attached to its service if
  // basic auth is on there; the same username with the same hash (e.g. a copied service) becomes one user. Passwords
  // can't be compared otherwise, so same-named users with different hashes stay separate. The old column is left as it
  // was, so main still runs on this database after a rollback, with the users from before.
  const rows = db
    .query<{ id: number; basic_auth: number; basic_auth_users: string }, []>(
      "SELECT id, basic_auth, basic_auth_users FROM proxy_hosts",
    )
    .all();
  const find = db.query<{ id: number }, [string, string]>("SELECT id FROM basic_auth_users WHERE username = ? AND hash = ?");
  const insert = db.query<{ id: number }, [string, string]>(
    "INSERT INTO basic_auth_users (username, hash) VALUES (?, ?) RETURNING id",
  );
  const link = db.query("INSERT OR IGNORE INTO host_basic_auth_users (host_id, user_id) VALUES (?, ?)");
  for (const row of rows) {
    for (const u of JSON.parse(row.basic_auth_users) as { username: string; hash: string }[]) {
      const id = (find.get(u.username, u.hash) ?? insert.get(u.username, u.hash)!).id;
      if (row.basic_auth) link.run(row.id, id);
    }
  }
})();

export type Scheme = "http" | "https";

/**
 * Client certificate (mTLS) policy of a service. `require` rejects the TLS handshake without a certificate from one of
 * the service's CAs; `optional` verifies a certificate if the client sends one, and lets the service decide.
 */
export type ClientAuth = "off" | "require" | "optional";

/**
 * How an alias hostname reaches the service. `redirect` sends the visitor to the service's hostname; `parallel` serves
 * the service under the alias too, with the Host header rewritten to the service's hostname. The path is kept either way.
 */
export type AliasMode = "redirect" | "parallel";

export interface Alias {
  hostname: string;
  mode: AliasMode;
}

/** Where visitors solve a captcha: Cloudflare Turnstile or hCaptcha. */
export type CaptchaProvider = "turnstile" | "hcaptcha";

/** A captcha widget at its provider, shared by the services it's attached to. */
export interface Captcha {
  id: number;
  name: string;
  provider: CaptchaProvider;
  siteKey: string;
  /** The provider's secret for verifying solved challenges. Never sent to the browser. */
  secretKey: string;
  /** Seconds a visitor who solved it can use the service before being asked again. */
  lifetime: number;
  createdAt: string;
  updatedAt: string;
}

/** A basic auth user; `hash` is an htpasswd-compatible bcrypt hash. */
export interface BasicAuthUser {
  id: number;
  username: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyHost {
  id: number;
  /** Every hostname: the service's own first, then its aliases. */
  domains: string[];
  /** The hostnames after the first, and how each reaches the service. */
  aliases: Alias[];
  deviceId: string;
  deviceName: string;
  targetIp: string;
  targetPort: number;
  scheme: Scheme;
  insecureSkipVerify: boolean;
  enabled: boolean;
  basicAuth: boolean;
  /** The users who can sign in, when `basicAuth` is on. */
  basicAuthUserIds: number[];
  clientAuth: ClientAuth;
  clientCaIds: number[];
  /** Forward the verified client certificate's details to the service in X-Forwarded-Tls-Client-Cert-Info. */
  clientCertHeaders: boolean;
  /** Sends `X-Robots-Tag: noindex, nofollow`, so search engines don't index the service. */
  noIndex: boolean;
  /** The captcha visitors have to solve before reaching the service, or null for none. */
  captchaId: number | null;
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
  client_auth: ClientAuth;
  client_cert_headers: number;
  no_index: number;
  captcha_id: number | null;
  alias_modes: string;
  created_at: string;
  updated_at: string;
}

type Links = Map<number, number[]>;

/** Ids of a join table's other side, per host id. */
function linksOf(table: "host_client_cas" | "host_basic_auth_users", column: "ca_id" | "user_id", hostId?: number): Links {
  const select = `SELECT host_id, ${column} AS id FROM ${table}`;
  const rows =
    hostId === undefined
      ? db.query<{ host_id: number; id: number }, []>(`${select} ORDER BY ${column}`).all()
      : db.query<{ host_id: number; id: number }, [number]>(`${select} WHERE host_id = ? ORDER BY ${column}`).all(hostId);
  const links: Links = new Map();
  for (const r of rows) links.set(r.host_id, [...(links.get(r.host_id) ?? []), r.id]);
  return links;
}

const allLinks = (hostId?: number) => ({
  cas: linksOf("host_client_cas", "ca_id", hostId),
  users: linksOf("host_basic_auth_users", "user_id", hostId),
});

function toHost(r: ProxyHostRow, links = allLinks(r.id)): ProxyHost {
  const domains: string[] = JSON.parse(r.domains);
  const modes: Record<string, AliasMode> = JSON.parse(r.alias_modes);
  return {
    id: r.id,
    domains,
    aliases: domains.slice(1).map((hostname) => ({ hostname, mode: modes[hostname] ?? "parallel" })),
    deviceId: r.device_id,
    deviceName: r.device_name,
    targetIp: r.target_ip,
    targetPort: r.target_port,
    scheme: r.scheme,
    insecureSkipVerify: !!r.insecure_skip_verify,
    enabled: !!r.enabled,
    basicAuth: !!r.basic_auth,
    basicAuthUserIds: links.users.get(r.id) ?? [],
    clientAuth: r.client_auth,
    clientCaIds: links.cas.get(r.id) ?? [],
    clientCertHeaders: !!r.client_cert_headers,
    noIndex: !!r.no_index,
    captchaId: r.captcha_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toParams(h: ProxyHostInput) {
  return {
    domains: JSON.stringify(h.domains),
    alias_modes: JSON.stringify(Object.fromEntries(h.aliases.map((a) => [a.hostname, a.mode]))),
    device_id: h.deviceId,
    device_name: h.deviceName,
    target_ip: h.targetIp,
    target_port: h.targetPort,
    scheme: h.scheme,
    insecure_skip_verify: h.insecureSkipVerify ? 1 : 0,
    enabled: h.enabled ? 1 : 0,
    basic_auth: h.basicAuth ? 1 : 0,
    client_auth: h.clientAuth,
    client_cert_headers: h.clientCertHeaders ? 1 : 0,
    no_index: h.noIndex ? 1 : 0,
    captcha_id: h.captchaId,
  };
}

function setLinks(hostId: number, h: ProxyHostInput) {
  db.query("DELETE FROM host_client_cas WHERE host_id = ?").run(hostId);
  const ids = h.clientAuth === "off" ? [] : h.clientCaIds;
  // Checked here too, so no caller can store a policy that requires certificates without a CA to verify them.
  if (h.clientAuth !== "off" && !ids.length) throw new Error("Client certificates need at least one CA");
  const insert = db.query("INSERT INTO host_client_cas (host_id, ca_id) VALUES (?, ?)");
  for (const caId of ids) insert.run(hostId, caId);

  db.query("DELETE FROM host_basic_auth_users WHERE host_id = ?").run(hostId);
  const userIds = h.basicAuth ? h.basicAuthUserIds : [];
  // Likewise, basic auth without users would leave the service open.
  if (h.basicAuth && !userIds.length) throw new Error("Basic auth needs at least one user");
  const insertUser = db.query("INSERT INTO host_basic_auth_users (host_id, user_id) VALUES (?, ?)");
  for (const userId of userIds) insertUser.run(hostId, userId);
}

export const hosts = {
  list(): ProxyHost[] {
    const links = allLinks();
    return db
      .query<ProxyHostRow, []>("SELECT * FROM proxy_hosts ORDER BY id")
      .all()
      .map((r) => toHost(r, links));
  },
  get(id: number): ProxyHost | null {
    const row = db.query<ProxyHostRow, [number]>("SELECT * FROM proxy_hosts WHERE id = ?").get(id);
    return row ? toHost(row) : null;
  },
  /**
   * Throws a SQLite foreign key error if one of the CAs or users, or the captcha, doesn't exist (anymore); nothing is
   * written then.
   */
  create: db.transaction((h: ProxyHostInput): ProxyHost => {
    const row = db
      .query<ProxyHostRow, any>(
        `INSERT INTO proxy_hosts (domains, device_id, device_name, target_ip, target_port, scheme, insecure_skip_verify, enabled,
           basic_auth, client_auth, client_cert_headers, no_index, captcha_id, alias_modes)
         VALUES ($domains, $device_id, $device_name, $target_ip, $target_port, $scheme, $insecure_skip_verify, $enabled,
           $basic_auth, $client_auth, $client_cert_headers, $no_index, $captcha_id, $alias_modes)
         RETURNING *`,
      )
      .get(toParams(h))!;
    setLinks(row.id, h);
    return toHost(row);
  }),
  update: db.transaction((id: number, h: ProxyHostInput): ProxyHost | null => {
    const row = db
      .query<ProxyHostRow, any>(
        `UPDATE proxy_hosts SET domains = $domains, device_id = $device_id, device_name = $device_name,
           target_ip = $target_ip, target_port = $target_port, scheme = $scheme,
           insecure_skip_verify = $insecure_skip_verify, enabled = $enabled, basic_auth = $basic_auth,
           client_auth = $client_auth, client_cert_headers = $client_cert_headers,
           no_index = $no_index, captcha_id = $captcha_id, alias_modes = $alias_modes, updated_at = datetime('now')
         WHERE id = $id RETURNING *`,
      )
      .get({ ...toParams(h), id });
    if (!row) return null;
    setLinks(id, h);
    return toHost(row);
  }),
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
  /** One or more PEM certificates: the CA, plus any intermediates. */
  certPem: string;
  summary: CertSummary;
  certCount: number;
  createdAt: string;
}

interface ClientCaRow {
  id: number;
  name: string;
  cert_pem: string;
  summary: string;
  cert_count: number;
  created_at: string;
}

const toCa = (r: ClientCaRow): ClientCa => ({
  id: r.id,
  name: r.name,
  certPem: r.cert_pem,
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
          `INSERT INTO client_cas (name, cert_pem, summary, cert_count)
           VALUES ($name, $cert_pem, $summary, $cert_count) RETURNING *`,
        )
        .get({ name: ca.name, cert_pem: ca.certPem, summary: JSON.stringify(ca.summary), cert_count: ca.certCount })!,
    );
  },
  rename(id: number, name: string): ClientCa | null {
    const row = db.query<ClientCaRow, [string, number]>("UPDATE client_cas SET name = ? WHERE id = ? RETURNING *").get(name, id);
    return row ? toCa(row) : null;
  },
  /** Throws a SQLite foreign key error while a service still trusts the CA. */
  delete(id: number): boolean {
    return db.query("DELETE FROM client_cas WHERE id = ?").run(id).changes > 0;
  },
};

interface BasicAuthUserRow {
  id: number;
  username: string;
  hash: string;
  created_at: string;
  updated_at: string;
}

const toUser = (r: BasicAuthUserRow): BasicAuthUser => ({
  id: r.id,
  username: r.username,
  hash: r.hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const basicAuthUsers = {
  list(): BasicAuthUser[] {
    return db.query<BasicAuthUserRow, []>("SELECT * FROM basic_auth_users ORDER BY username, id").all().map(toUser);
  },
  get(id: number): BasicAuthUser | null {
    const row = db.query<BasicAuthUserRow, [number]>("SELECT * FROM basic_auth_users WHERE id = ?").get(id);
    return row ? toUser(row) : null;
  },
  create(username: string, hash: string): BasicAuthUser {
    return toUser(
      db
        .query<BasicAuthUserRow, [string, string]>("INSERT INTO basic_auth_users (username, hash) VALUES (?, ?) RETURNING *")
        .get(username, hash)!,
    );
  },
  update(id: number, patch: { username: string; hash: string }): BasicAuthUser | null {
    const row = db
      .query<BasicAuthUserRow, [string, string, number]>(
        "UPDATE basic_auth_users SET username = ?, hash = ?, updated_at = datetime('now') WHERE id = ? RETURNING *",
      )
      .get(patch.username, patch.hash, id);
    return row ? toUser(row) : null;
  },
  /** Throws a SQLite foreign key error while a service still uses the user. */
  delete(id: number): boolean {
    return db.query("DELETE FROM basic_auth_users WHERE id = ?").run(id).changes > 0;
  },
};

interface CaptchaRow {
  id: number;
  name: string;
  provider: CaptchaProvider;
  site_key: string;
  secret_key: string;
  lifetime: number;
  created_at: string;
  updated_at: string;
}

const toCaptcha = (r: CaptchaRow): Captcha => ({
  id: r.id,
  name: r.name,
  provider: r.provider,
  siteKey: r.site_key,
  secretKey: r.secret_key,
  lifetime: r.lifetime,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type CaptchaInput = Omit<Captcha, "id" | "createdAt" | "updatedAt">;

const captchaParams = (c: CaptchaInput) => ({
  name: c.name,
  provider: c.provider,
  site_key: c.siteKey,
  secret_key: c.secretKey,
  lifetime: c.lifetime,
});

export const captchas = {
  list(): Captcha[] {
    return db.query<CaptchaRow, []>("SELECT * FROM captchas ORDER BY name, id").all().map(toCaptcha);
  },
  get(id: number): Captcha | null {
    const row = db.query<CaptchaRow, [number]>("SELECT * FROM captchas WHERE id = ?").get(id);
    return row ? toCaptcha(row) : null;
  },
  /** The captcha a service asks for, looked up on every request to it; `undefined` if the service doesn't exist. */
  forHost(hostId: number): Captcha | null | undefined {
    const row = db
      .query<CaptchaRow & { host_id: number }, [number]>(
        `SELECT h.id AS host_id, c.* FROM proxy_hosts h LEFT JOIN captchas c ON c.id = h.captcha_id WHERE h.id = ?`,
      )
      .get(hostId);
    if (!row) return undefined;
    return row.id === null ? null : toCaptcha(row);
  },
  create(c: CaptchaInput): Captcha {
    return toCaptcha(
      db
        .query<CaptchaRow, any>(
          `INSERT INTO captchas (name, provider, site_key, secret_key, lifetime)
           VALUES ($name, $provider, $site_key, $secret_key, $lifetime) RETURNING *`,
        )
        .get(captchaParams(c))!,
    );
  },
  update(id: number, c: CaptchaInput): Captcha | null {
    const row = db
      .query<CaptchaRow, any>(
        `UPDATE captchas SET name = $name, provider = $provider, site_key = $site_key, secret_key = $secret_key,
           lifetime = $lifetime, updated_at = datetime('now')
         WHERE id = $id RETURNING *`,
      )
      .get({ ...captchaParams(c), id });
    return row ? toCaptcha(row) : null;
  },
  /** Throws a SQLite foreign key error while a service still uses the captcha. */
  delete(id: number): boolean {
    return db.query("DELETE FROM captchas WHERE id = ?").run(id).changes > 0;
  },
};

export type SettingKey =
  | "public_address"
  | "captcha_signing_key"
  | "backend_tag"
  | "rate_limit"
  | "access_log_retention_days"
  | "access_log_cursor";

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
