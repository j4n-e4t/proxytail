import { SQLiteError } from "bun:sqlite";
import { isIP } from "node:net";
import index from "./web/index.html";
import { checkBrowserOrigin } from "./guard";
import { crowdsecStats, deleteDecision, RANGES, type StatsRange } from "./crowdsec-stats";
import {
  CrowdsecError,
  crowdsecConfig,
  crowdsecStatus,
  saveCrowdsecConfig,
  MIDDLEWARE as CROWDSEC_MIDDLEWARE,
  type CrowdsecConfig,
} from "./crowdsec";
import {
  clientCas,
  domains as domainStore,
  hosts,
  settings,
  type BasicAuthUser,
  type ClientAuth,
  type ClientCa,
  type ProxyHost,
  type ProxyHostInput,
} from "./db";
import { checkDomain, detectPublicIp, publicAddress, requiredRecord } from "./dns";
import { faviconFor } from "./favicons";
import { parseCaBundle, PkiError } from "./pki";
import {
  clearDeviceCache,
  deviceSource,
  isConfigured,
  listDevices,
  normalizeTag,
  tailscaleConfig,
  tailscaleVersion,
  TailscaleError,
} from "./tailscale";
import { buildConfig, middlewareStatus, traefikStatus } from "./traefik";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** Every API route: no authentication (see guard.ts), only the browser checks. */
function handle<T extends Request>(fn: (req: T) => Promise<Response> | Response) {
  return async (req: T) => {
    try {
      const rejected = checkBrowserOrigin(req);
      if (rejected) throw new HttpError(403, rejected);
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError || e instanceof TailscaleError || e instanceof CrowdsecError)
        return json({ error: e.message }, e.status);
      if (e instanceof PkiError) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: "Internal server error" }, 500);
    }
  };
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function parseId(raw: string) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Invalid id");
  return id;
}

const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

async function validateHost(raw: any, existing?: ProxyHost): Promise<ProxyHostInput> {
  const domains: string[] = (Array.isArray(raw.domains) ? raw.domains : String(raw.domains ?? "").split(/[\s,]+/))
    .map((d: unknown) => String(d).trim().toLowerCase())
    .filter(Boolean);
  if (!domains.length) throw new HttpError(400, "At least one domain is required");
  for (const d of domains) {
    if (!DOMAIN_RE.test(d) || d.length > 253) throw new HttpError(400, `Invalid domain: ${d}`);
    if (d.startsWith("*.")) throw new HttpError(400, `Wildcard domains are not supported yet: ${d}`);
  }
  // New hostnames must sit under a verified domain; pre-existing ones are grandfathered in.
  const registered = domainStore.list();
  for (const d of domains) {
    if (existing?.domains.includes(d)) continue;
    const base = domainStore.match(d, registered);
    if (!base) throw new HttpError(400, `${d} is not under one of your domains. Add it under Domains first.`);
    if (!base.verified) throw new HttpError(400, `${base.name} is not verified yet. Check its DNS under Domains.`);
  }
  const taken = hosts.list().filter((h) => h.id !== existing?.id);
  for (const d of domains) {
    const owner = taken.find((h) => h.domains.includes(d));
    if (owner) throw new HttpError(409, `${d} is already used by another service`);
  }

  const port = Number(raw.targetPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, "Port must be between 1 and 65535");

  const scheme = raw.scheme === "https" ? "https" : raw.scheme === "http" || raw.scheme == null ? "http" : null;
  if (!scheme) throw new HttpError(400, "Scheme must be http or https");

  const deviceId = String(raw.deviceId ?? "");
  if (!deviceId) throw new HttpError(400, "A target peer is required");

  let deviceName: string;
  let targetIp: string;
  const unchanged = existing && existing.deviceId === deviceId;
  try {
    const device = (await listDevices()).find((d) => d.id === deviceId);
    if (!device)
      throw new HttpError(400, `Target peer not found in tailnet or not tagged ${tailscaleConfig().backendTag}`);
    if (!device.ipv4) throw new HttpError(400, `${device.name} has no Tailscale IPv4 address`);
    deviceName = device.name;
    targetIp = device.ipv4;
  } catch (e) {
    // Allow editing other fields while the Tailscale API is unreachable.
    if (!(e instanceof TailscaleError) || !unchanged) throw e;
    deviceName = existing.deviceName;
    targetIp = existing.targetIp;
  }

  const basicAuthUsers = await validateBasicAuth(raw.basicAuthUsers, existing?.basicAuthUsers ?? []);
  const basicAuth = !!raw.basicAuth;
  if (basicAuth && !basicAuthUsers.length) throw new HttpError(400, "Add at least one user to enable basic auth");

  const clientAuth = (raw.clientAuth ?? "off") as ClientAuth;
  if (!["off", "require", "optional"].includes(clientAuth))
    throw new HttpError(400, "Client certificates must be off, require or optional");
  const clientCaIds =
    clientAuth === "off" || !Array.isArray(raw.clientCaIds) ? [] : [...new Set<number>(raw.clientCaIds.map(Number))];
  // Existence is checked again atomically when the service is written (see saveHost).
  if (clientAuth !== "off") {
    if (!clientCaIds.length) throw new HttpError(400, "Pick at least one CA to verify client certificates against");
    for (const id of clientCaIds) if (!clientCas.get(id)) throw new HttpError(400, `Client CA ${id} does not exist`);
  }

  return {
    domains: [...new Set(domains)],
    deviceId,
    deviceName,
    targetIp,
    targetPort: port,
    scheme,
    insecureSkipVerify: !!raw.insecureSkipVerify,
    enabled: raw.enabled === undefined ? true : !!raw.enabled,
    basicAuth,
    basicAuthUsers,
    clientAuth,
    clientCaIds,
    clientCertHeaders: clientAuth !== "off" && !!raw.clientCertHeaders,
  };
}

const USERNAME_RE = /^[^\s:]{1,64}$/;
const MIN_PASSWORD = 8;

/**
 * Resolves submitted basic auth users to stored credentials. A user without a password keeps the hash stored under
 * `previous` (its name before a rename) or its current name.
 */
async function validateBasicAuth(raw: unknown, existing: BasicAuthUser[]): Promise<BasicAuthUser[]> {
  if (!Array.isArray(raw)) return [];
  const users: BasicAuthUser[] = [];
  for (const u of raw as { username?: unknown; password?: unknown; previous?: unknown; hash?: unknown }[]) {
    const username = String(u.username ?? "").trim();
    if (!USERNAME_RE.test(username))
      throw new HttpError(400, `Invalid username "${username}": use up to 64 characters without spaces or colons`);
    if (users.some((x) => x.username === username)) throw new HttpError(400, `Duplicate username: ${username}`);
    const password = typeof u.password === "string" ? u.password : "";
    if (password) {
      if (password.length < MIN_PASSWORD)
        throw new HttpError(400, `Password for ${username} must be at least ${MIN_PASSWORD} characters`);
      // Traefik's htpasswd parser recognises the $2y$ bcrypt prefix; the hash itself is identical to $2b$.
      const hash = (await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 })).replace(/^\$2b\$/, "$2y$");
      users.push({ username, hash });
      continue;
    }
    const previous = typeof u.previous === "string" ? u.previous : username;
    const kept = existing.find((x) => x.username === previous);
    if (!kept) throw new HttpError(400, `Set a password for ${username}`);
    users.push({ username, hash: kept.hash });
  }
  return users;
}

/** Hosts as returned by the API: password hashes never leave the server. */
const hostView = (h: ProxyHost) => ({ ...h, basicAuthUsers: h.basicAuthUsers.map((u) => ({ username: u.username })) });

function domainView(d: ReturnType<typeof domainStore.list>[number]) {
  const all = hosts.list();
  return {
    ...d,
    record: requiredRecord(d.name),
    hostCount: all.filter((h) => h.domains.some((x) => domainStore.match(x)?.id === d.id)).length,
  };
}

/** SQLite reports a violated ON DELETE RESTRICT as SQLITE_CONSTRAINT_TRIGGER, hence the match on the message. */
const isForeignKeyError = (e: unknown) =>
  e instanceof SQLiteError && !!e.code?.startsWith("SQLITE_CONSTRAINT") && e.message.includes("FOREIGN KEY");

/** Writes a service. A CA deleted since validation fails the write instead of being dropped from the service. */
function saveHost<T>(write: () => T): T {
  try {
    return write();
  } catch (e) {
    if (isForeignKeyError(e)) throw new HttpError(409, "One of the selected client CAs no longer exists. Reload and try again.");
    throw e;
  }
}

function caView(ca: ClientCa, all = hosts.list()) {
  return { ...ca, hostIds: all.filter((h) => h.clientCaIds.includes(ca.id)).map((h) => h.id) };
}

function getCa(raw: string) {
  const ca = clientCas.get(parseId(raw));
  if (!ca) throw new HttpError(404, "CA not found");
  return ca;
}

function validateName(raw: unknown, what: string) {
  const name = String(raw ?? "").trim();
  if (!name || name.length > 64 || /[\x00-\x1f]/.test(name))
    throw new HttpError(400, `${what} must be 1 to 64 characters`);
  return name;
}

/** A file name derived from a CA name. */
const fileName = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "ca";

function settingsView() {
  const c = tailscaleConfig();
  return {
    publicAddress: publicAddress(),
    configured: isConfigured(),
    source: deviceSource(),
    mock: !!process.env.TS_MOCK_DEVICES,
    backendTag: c.backendTag,
    /** The proxy host's own Tailscale version, if it could be identified in the tailnet. */
    tailscaleVersion: tailscaleVersion(),
  };
}

/** An IP address or CIDR range, normalized; null if invalid. */
function parseIpRange(raw: string): string | null {
  const [ip = "", prefix, ...rest] = raw.split("/");
  const version = isIP(ip);
  if (!version || rest.length) return null;
  if (prefix === undefined) return ip.toLowerCase();
  const bits = Number(prefix);
  if (!/^\d+$/.test(prefix) || bits > (version === 4 ? 32 : 128)) return null;
  return `${ip.toLowerCase()}/${bits}`;
}

async function validateCrowdsec(raw: Record<string, unknown>): Promise<CrowdsecConfig> {
  const current = crowdsecConfig();
  const cacheSeconds = raw.cacheSeconds === undefined ? current.cacheSeconds : Number(raw.cacheSeconds);
  if (!Number.isInteger(cacheSeconds) || cacheSeconds < 1 || cacheSeconds > 3600)
    throw new HttpError(400, "The cache duration must be between 1 and 3600 seconds");
  const rawIps = raw.trustedIps === undefined ? current.trustedIps : raw.trustedIps;
  const trustedIps: string[] = [];
  for (const entry of Array.isArray(rawIps) ? rawIps : String(rawIps ?? "").split(/[\s,]+/)) {
    const text = String(entry).trim();
    if (!text) continue;
    const range = parseIpRange(text);
    if (!range) throw new HttpError(400, `Invalid IP address or range: ${text}`);
    if (!trustedIps.includes(range)) trustedIps.push(range);
  }
  const enabled = raw.enabled === undefined ? current.enabled : !!raw.enabled;
  // Traefik blocks every request LAPI can't answer, so don't switch it on blind.
  if (enabled && !current.enabled) {
    const { key, lapi } = await crowdsecStatus();
    if (!key) throw new HttpError(400, "proxytail has no bouncer key. Check that its CrowdSec key file is writable.");
    if (!lapi.reachable) throw new HttpError(400, `CrowdSec is unreachable: ${lapi.error}`);
    if (!lapi.keyAccepted)
      throw new HttpError(400, lapi.error ?? "CrowdSec rejected the bouncer key. See the README to re-register it.");
  }
  return {
    enabled,
    cacheSeconds,
    trustedIps,
  };
}

async function crowdsecView() {
  const config = crowdsecConfig();
  const [status, middleware] = await Promise.all([
    crowdsecStatus(),
    config.enabled ? middlewareStatus(CROWDSEC_MIDDLEWARE) : null,
  ]);
  return { config, status, middleware };
}

const port = Number(process.env.PORT ?? 3000);


const server = Bun.serve({
  port,
  // Loopback by default: whoever can connect has full access. docker-compose.yml listens on the container's network
  // and publishes the port on the host's loopback only, for `tailscale serve`.
  hostname: process.env.HOST ?? "127.0.0.1",
  routes: {
    "/*": index,

    "/api/hosts": {
      GET: handle(() => json(hosts.list().map(hostView))),
      POST: handle(async (req) => {
        const input = await validateHost(await body(req));
        const h = saveHost(() => hosts.create(input));
        return json(hostView(h), 201);
      }),
    },
    "/api/hosts/:id/favicon": {
      GET: handle(async (req) => {
        const h = hosts.get(parseId(req.params.id));
        if (!h) throw new HttpError(404, "Service not found");
        const icon = await faviconFor(h);
        if (!icon) return new Response(null, { status: 404, headers: { "Cache-Control": "private, max-age=600" } });
        return new Response(icon.body, {
          headers: {
            "Content-Type": icon.type,
            "Cache-Control": "private, max-age=3600",
            // The bytes come from the backend: never let an SVG run script if it's opened directly.
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }),
    },
    "/api/hosts/:id": {
      GET: handle((req) => {
        const h = hosts.get(parseId(req.params.id));
        if (!h) throw new HttpError(404, "Service not found");
        return json(hostView(h));
      }),
      PUT: handle(async (req) => {
        const existing = hosts.get(parseId(req.params.id));
        if (!existing) throw new HttpError(404, "Service not found");
        const patch = await body<Record<string, unknown>>(req);
        const input = await validateHost({ ...existing, ...patch }, existing);
        const h = saveHost(() => hosts.update(existing.id, input))!;
        return json(hostView(h));
      }),
      DELETE: handle((req) => {
        if (!hosts.delete(parseId(req.params.id))) throw new HttpError(404, "Service not found");
        return new Response(null, { status: 204 });
      }),
    },

    "/api/domains": {
      GET: handle(() => json(domainStore.list().map(domainView))),
      POST: handle(async (req) => {
        const name = String((await body<{ name?: string }>(req)).name ?? "")
          .trim()
          .toLowerCase()
          .replace(/^\*\./, "")
          .replace(/\.$/, "");
        if (!DOMAIN_RE.test(name) || !name.includes(".")) throw new HttpError(400, `Invalid domain: ${name || "(empty)"}`);
        if (domainStore.byName(name)) throw new HttpError(409, `${name} is already added`);
        const parent = domainStore.match(name);
        if (parent) throw new HttpError(409, `${name} is already covered by ${parent.name}`);
        const d = domainStore.create(name);
        return json(domainView(domainStore.saveCheck(d.id, await checkDomain(name))), 201);
      }),
    },
    "/api/domains/:id/verify": {
      POST: handle(async (req) => {
        const d = domainStore.get(parseId(req.params.id));
        if (!d) throw new HttpError(404, "Domain not found");
        return json(domainView(domainStore.saveCheck(d.id, await checkDomain(d.name))));
      }),
    },
    "/api/domains/:id": {
      DELETE: handle((req) => {
        const d = domainStore.get(parseId(req.params.id));
        if (!d) throw new HttpError(404, "Domain not found");
        const used = hosts.list().filter((h) => h.domains.some((x) => domainStore.match(x)?.id === d.id));
        if (used.length)
          throw new HttpError(409, `${d.name} is used by ${used.map((h) => h.domains[0]).join(", ")}. Delete those services first.`);
        domainStore.delete(d.id);
        return new Response(null, { status: 204 });
      }),
    },

    "/api/client-cas": {
      GET: handle(() => {
        const all = hosts.list();
        return json(clientCas.list().map((ca) => caView(ca, all)));
      }),
      // Only CA certificates are accepted: proxytail verifies client certificates but never holds a key to issue them.
      POST: handle(async (req) => {
        const b = await body<{ name?: string; pem?: string }>(req);
        const name = validateName(b.name, "Name");
        const bundle = parseCaBundle(String(b.pem ?? ""));
        const created = clientCas.create({ name, certPem: bundle.pem, summary: bundle.summary, certCount: bundle.count });
        return json(caView(created), 201);
      }),
    },
    "/api/client-cas/:id": {
      PATCH: handle(async (req) => {
        const ca = getCa(req.params.id);
        return json(caView(clientCas.rename(ca.id, validateName((await body<{ name?: string }>(req)).name, "Name"))!));
      }),
      DELETE: handle((req) => {
        const ca = getCa(req.params.id);
        const inUse = () => {
          const used = hosts.list().filter((h) => h.clientCaIds.includes(ca.id));
          return new HttpError(409, `${ca.name} is used by ${used.map((h) => h.domains[0]).join(", ") || "a service"}. Remove it from those services first.`);
        };
        if (hosts.list().some((h) => h.clientCaIds.includes(ca.id))) throw inUse();
        try {
          clientCas.delete(ca.id);
        } catch (e) {
          // A service started using it since the check above.
          if (isForeignKeyError(e)) throw inUse();
          throw e;
        }
        return new Response(null, { status: 204 });
      }),
    },
    "/api/client-cas/:id/cert.pem": {
      GET: handle((req) => {
        const ca = getCa(req.params.id);
        return new Response(ca.certPem, {
          headers: {
            "Content-Type": "application/x-pem-file",
            "Content-Disposition": `attachment; filename="${fileName(ca.name)}.pem"`,
          },
        });
      }),
    },

    "/api/devices": {
      GET: handle(async (req) => json(await listDevices(new URL(req.url).searchParams.has("refresh")))),
    },

    "/api/settings": {
      GET: handle(() => json(settingsView())),
      PUT: handle(async (req) => {
        const b = await body<Record<string, string | null | undefined>>(req);
        // `undefined` leaves a value untouched, `null`/"" clears it (falls back to env).
        if (b.publicAddress !== undefined) settings.set("public_address", b.publicAddress?.trim() ?? null);
        if (b.backendTag !== undefined) {
          const tag = b.backendTag?.trim() ? normalizeTag(b.backendTag) : null;
          if (b.backendTag?.trim() && !tag)
            throw new HttpError(400, "Tags must start with a letter and contain only letters, numbers and dashes");
          settings.set("backend_tag", tag);
        }
        clearDeviceCache();
        return json(settingsView());
      }),
    },
    "/api/settings/detect-ip": {
      POST: handle(async () => json({ ip: await detectPublicIp() })),
    },
    "/api/settings/test": {
      POST: handle(async () => {
        const devices = await listDevices(true);
        return json({ ok: true, devices: devices.length });
      }),
    },

    "/api/crowdsec": {
      GET: handle(async () => json(await crowdsecView())),
      PUT: handle(async (req) => {
        saveCrowdsecConfig(await validateCrowdsec(await body(req)));
        return json(await crowdsecView());
      }),
    },

    "/api/crowdsec/stats": {
      GET: handle(async (req) => {
        const params = new URL(req.url).searchParams;
        const range = (params.get("range") ?? "24h") as StatsRange;
        if (!(range in RANGES)) throw new HttpError(400, `Range must be one of ${Object.keys(RANGES).join(", ")}`);
        const offset = Number(params.get("utcOffset") ?? 0);
        if (!Number.isInteger(offset) || Math.abs(offset) > 14 * 60) throw new HttpError(400, "Invalid UTC offset");
        return json(await crowdsecStats(range, offset, params.has("fresh")));
      }),
    },
    "/api/crowdsec/decisions/:id": {
      DELETE: handle(async (req) => {
        await deleteDecision(parseId(req.params.id));
        return new Response(null, { status: 204 });
      }),
    },

    "/api/health": { GET: () => json({ ok: true }) },

    // Polled by Traefik's HTTP provider over the Docker network.
    "/api/traefik/config": { GET: handle(() => json(buildConfig())) },
    "/api/traefik/status": { GET: handle(async () => json(await traefikStatus())) },
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`proxytail listening on ${server.url}`);
