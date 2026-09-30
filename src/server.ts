import { SQLiteError } from "bun:sqlite";
import { isIP } from "node:net";
import index from "./web/index.html";
import { checkBrowserOrigin } from "./guard";
import {
  accessLogStats,
  accessLogStatus,
  entries as accessLogEntries,
  FilterError,
  RANGES as ACCESS_LOG_RANGES,
  serviceTrafficSummary,
  setRetentionDays,
  type Filters,
  type Range,
} from "./accesslog";
import {
  basicAuthUsers,
  clientCas,
  domains as domainStore,
  hosts,
  settings,
  type Alias,
  type BasicAuthUser,
  type ClientAuth,
  type ClientCa,
  type ProxyHost,
  type ProxyHostInput,
} from "./db";
import {
  checkCountry,
  countriesReady,
  countryDbStatus,
  countryOf,
  isCountryCode,
  updateCountries,
  type CountryMode,
} from "./countries";
import { checkDomain, detectPublicIp, publicAddress, requiredRecord } from "./dns";
import { faviconFor } from "./favicons";
import { parseCaBundle, PkiError } from "./pki";
import {
  activeStore,
  PERIODS,
  rateLimitConfig,
  saveRateLimitConfig,
  valkeyStatus,
  type RateLimitConfig,
} from "./ratelimit";
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
import { buildConfig, rateLimitStatus, traefikStatus } from "./traefik";

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
      if (e instanceof HttpError || e instanceof TailscaleError) return json({ error: e.message }, e.status);
      if (e instanceof PkiError || e instanceof FilterError) return json({ error: e.message }, 400);
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
  const normalize = (d: unknown) => String(d ?? "").trim().toLowerCase();
  const listed: string[] = (Array.isArray(raw.domains) ? raw.domains : String(raw.domains ?? "").split(/[\s,]+/))
    .map(normalize)
    .filter(Boolean);
  const hostname = listed[0];
  if (!hostname) throw new HttpError(400, "A hostname is required");
  // Aliases with their modes; a plain list of extra hostnames (older clients) means parallel aliases.
  const rawAliases: { hostname?: unknown; mode?: unknown }[] = Array.isArray(raw.aliases)
    ? raw.aliases
    : listed.slice(1).map((h) => ({ hostname: h, mode: "parallel" }));
  const aliases: Alias[] = [];
  for (const a of rawAliases) {
    const alias = normalize(a.hostname);
    if (!alias) continue;
    const mode = a.mode ?? "redirect";
    if (mode !== "redirect" && mode !== "parallel") throw new HttpError(400, "An alias must redirect or be served in parallel");
    if (alias === hostname || aliases.some((x) => x.hostname === alias)) throw new HttpError(400, `${alias} is listed twice`);
    aliases.push({ hostname: alias, mode });
  }
  const domains = [hostname, ...aliases.map((a) => a.hostname)];
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

  const basicAuth = !!raw.basicAuth;
  const basicAuthUserIds =
    !basicAuth || !Array.isArray(raw.basicAuthUserIds) ? [] : [...new Set<number>(raw.basicAuthUserIds.map(Number))];
  // Existence is checked again atomically when the service is written (see saveHost).
  if (basicAuth) {
    if (!basicAuthUserIds.length) throw new HttpError(400, "Pick at least one user who can sign in");
    const names = new Set<string>();
    for (const id of basicAuthUserIds) {
      const user = basicAuthUsers.get(id);
      if (!user) throw new HttpError(400, `User ${id} does not exist`);
      if (names.has(user.username))
        throw new HttpError(400, `Two of the users are named ${user.username}: pick one, or rename the other`);
      names.add(user.username);
    }
  }

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

  const countryMode = (raw.countryMode ?? "off") as CountryMode;
  if (!["off", "allow", "block"].includes(countryMode)) throw new HttpError(400, "Countries must be off, allow or block");
  const countries =
    countryMode === "off" || !Array.isArray(raw.countries)
      ? []
      : [...new Set<string>(raw.countries.map((c: unknown) => String(c).trim().toUpperCase()))].sort();
  if (countryMode !== "off") {
    if (!countries.length)
      throw new HttpError(400, `Pick at least one country to ${countryMode === "allow" ? "let in" : "block"}`);
    for (const c of countries) if (!isCountryCode(c)) throw new HttpError(400, `${c} is not a country code`);
    // Traefik would answer 503 to every request until the database is there.
    if (!countriesReady() && (existing?.countryMode ?? "off") === "off")
      throw new HttpError(400, "The country database isn't loaded yet. See Settings → Countries.");
  }

  return {
    domains,
    aliases,
    deviceId,
    deviceName,
    targetIp,
    targetPort: port,
    scheme,
    insecureSkipVerify: !!raw.insecureSkipVerify,
    enabled: raw.enabled === undefined ? true : !!raw.enabled,
    basicAuth,
    basicAuthUserIds,
    clientAuth,
    clientCaIds,
    clientCertHeaders: clientAuth !== "off" && !!raw.clientCertHeaders,
    noIndex: !!raw.noIndex,
    countryMode,
    countries,
  };
}

const USERNAME_RE = /^[^\s:]{1,64}$/;
const MIN_PASSWORD = 8;

function validateUsername(raw: unknown, except?: number) {
  const username = String(raw ?? "").trim();
  if (!USERNAME_RE.test(username))
    throw new HttpError(400, `Invalid username "${username}": use up to 64 characters without spaces or colons`);
  if (basicAuthUsers.list().some((u) => u.username === username && u.id !== except))
    throw new HttpError(409, `There's already a user named ${username}`);
  return username;
}

async function hashPassword(raw: unknown) {
  const password = typeof raw === "string" ? raw : "";
  if (password.length < MIN_PASSWORD) throw new HttpError(400, `The password must be at least ${MIN_PASSWORD} characters`);
  // Traefik's htpasswd parser recognises the $2y$ bcrypt prefix; the hash itself is identical to $2b$.
  return (await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 })).replace(/^\$2b\$/, "$2y$");
}

/** Users as returned by the API, with the services they can sign in to. Password hashes never leave the server. */
function userView(u: BasicAuthUser, all = hosts.list()) {
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    hostIds: all.filter((h) => h.basicAuthUserIds.includes(u.id)).map((h) => h.id),
  };
}

function getUser(raw: string) {
  const user = basicAuthUsers.get(parseId(raw));
  if (!user) throw new HttpError(404, "User not found");
  return user;
}

/** Hosts as returned by the API, with the names of their users. */
function hostView(h: ProxyHost, users = basicAuthUsers.list()) {
  const byId = new Map(users.map((u) => [u.id, u.username]));
  return { ...h, basicAuthUsers: h.basicAuthUserIds.map((id) => ({ id, username: byId.get(id) ?? "" })) };
}

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

/** Writes a service. A CA or user deleted since validation fails the write instead of being dropped from the service. */
function saveHost<T>(write: () => T): T {
  try {
    return write();
  } catch (e) {
    if (isForeignKeyError(e))
      throw new HttpError(409, "One of the selected client CAs or users no longer exists. Reload and try again.");
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

/** A request count between 1 and 100,000. */
function parseCount(raw: unknown, label: string) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100_000) throw new HttpError(400, `${label} must be between 1 and 100,000`);
  return n;
}

async function validateRateLimit(raw: Record<string, unknown>): Promise<RateLimitConfig> {
  const current = rateLimitConfig();
  const next: RateLimitConfig = {
    enabled: raw.enabled === undefined ? current.enabled : !!raw.enabled,
    store: (raw.store ?? current.store) as RateLimitConfig["store"],
    average: parseCount(raw.average ?? current.average, "The average"),
    period: (raw.period ?? current.period) as RateLimitConfig["period"],
    burst: parseCount(raw.burst ?? current.burst, "The burst"),
  };
  if (next.store !== "memory" && next.store !== "valkey") throw new HttpError(400, "Store must be memory or valkey");
  if (!Object.hasOwn(PERIODS, next.period)) throw new HttpError(400, `Period must be one of ${Object.keys(PERIODS).join(", ")}`);
  // Don't switch to a Valkey that isn't there: Traefik would only ever use the in-memory fallback.
  if (next.enabled && next.store === "valkey" && !(current.enabled && current.store === "valkey")) {
    const valkey = await valkeyStatus();
    if (!valkey.reachable) throw new HttpError(400, `Valkey is unreachable at ${valkey.addr}: ${valkey.error}`);
    if (valkey.error) throw new HttpError(400, `Valkey refused proxytail's check: ${valkey.error}`);
  }
  return next;
}

async function rateLimitView() {
  const config = rateLimitConfig();
  const [valkey, traefik] = await Promise.all([
    config.store === "valkey" ? valkeyStatus() : null,
    config.enabled ? rateLimitStatus() : null,
  ]);
  return { config, activeStore: config.enabled ? activeStore(config) : null, valkey, traefik };
}

/** Access log filters from the query string. */
function accessLogFilters(params: URLSearchParams): Filters {
  const range = (params.get("range") ?? "24h") as Range;
  if (!Object.hasOwn(ACCESS_LOG_RANGES, range))
    throw new HttpError(400, `Range must be one of ${Object.keys(ACCESS_LOG_RANGES).join(", ")}`);
  const get = (key: string) => params.get(key)?.trim() || undefined;
  return { range, service: get("service"), status: get("status"), ip: get("ip"), country: get("country"), q: get("q") };
}

const port = Number(process.env.PORT ?? 3000);

/**
 * The UI has no authentication, so a page that frames it could be clickjacked into acting with full access. These
 * headers forbid framing outright (and stop MIME sniffing / referrer leakage).
 */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const secured = (b: BodyInit | null, headers: Record<string, string> = {}) =>
  new Response(b, { headers: { ...headers, ...SECURITY_HEADERS } });

interface BundleFile {
  path: string;
  loader: string;
  isEntry: boolean;
  headers: Record<string, string>;
}

/**
 * Frontend routes that carry SECURITY_HEADERS. Bun's HTML-import route can't set response headers, so in production
 * (a compiled binary, where `index.files` is populated) proxytail serves the bundle's files itself and adds them.
 * In development it keeps Bun's native route, so hot reload works; the dev server is loopback-only and not exposed.
 */
function pageRoutes(): Record<string, Response | (() => Response) | Bun.HTMLBundle> {
  const files = (index as { files?: BundleFile[] }).files;
  const html = files?.find((f) => f.loader === "html" && f.isEntry);
  if (!files || !html) return { "/*": index };
  const routes: Record<string, Response | (() => Response)> = {};
  for (const f of files) {
    if (f !== html) routes[`/${f.path.split("/").pop()}`] = secured(Bun.file(f.path), f.headers);
  }
  // The SPA document, for the root and every client-side route; the asset routes above are matched first.
  routes["/*"] = () => secured(Bun.file(html.path), { "Content-Type": "text/html;charset=utf-8" });
  return routes;
}

const server = Bun.serve({
  port,
  // Loopback by default: whoever can connect has full access. docker-compose.yml listens on the container's network
  // and publishes the port on the host's loopback only, for `tailscale serve`.
  hostname: process.env.HOST ?? "127.0.0.1",
  routes: {
    ...pageRoutes(),

    "/api/hosts": {
      GET: handle(() => {
        const users = basicAuthUsers.list();
        return json(hosts.list().map((h) => hostView(h, users)));
      }),
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

    "/api/basic-auth-users": {
      GET: handle(() => {
        const all = hosts.list();
        return json(basicAuthUsers.list().map((u) => userView(u, all)));
      }),
      POST: handle(async (req) => {
        const b = await body<{ username?: string; password?: string }>(req);
        const username = validateUsername(b.username);
        return json(userView(basicAuthUsers.create(username, await hashPassword(b.password))), 201);
      }),
    },
    "/api/basic-auth-users/:id": {
      // A new username, a new password, or both. An empty password keeps the current one.
      PATCH: handle(async (req) => {
        const user = getUser(req.params.id);
        const b = await body<{ username?: string; password?: string }>(req);
        const username = b.username === undefined ? user.username : validateUsername(b.username, user.id);
        const hash = b.password ? await hashPassword(b.password) : user.hash;
        return json(userView(basicAuthUsers.update(user.id, { username, hash })!));
      }),
      DELETE: handle((req) => {
        const user = getUser(req.params.id);
        const inUse = () => {
          const used = hosts.list().filter((h) => h.basicAuthUserIds.includes(user.id));
          return new HttpError(
            409,
            `${user.username} can sign in to ${used.map((h) => h.domains[0]).join(", ") || "a service"}. Remove them from those services first.`,
          );
        };
        if (hosts.list().some((h) => h.basicAuthUserIds.includes(user.id))) throw inUse();
        try {
          basicAuthUsers.delete(user.id);
        } catch (e) {
          // A service started using it since the check above.
          if (isForeignKeyError(e)) throw inUse();
          throw e;
        }
        return new Response(null, { status: 204 });
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

    "/api/rate-limit": {
      GET: handle(async () => json(await rateLimitView())),
      PUT: handle(async (req) => {
        await saveRateLimitConfig(await validateRateLimit(await body(req)));
        return json(await rateLimitView());
      }),
    },

    "/api/access-log": {
      GET: handle(() => json(accessLogStatus())),
      PUT: handle(async (req) => {
        const days = Number((await body<{ retentionDays?: unknown }>(req)).retentionDays);
        if (!Number.isInteger(days) || days < 1 || days > 90)
          throw new HttpError(400, "Keep requests for 1 to 90 days");
        setRetentionDays(days);
        return json(accessLogStatus());
      }),
    },
    "/api/access-log/entries": {
      GET: handle((req) => {
        const params = new URL(req.url).searchParams;
        const before = params.get("before") ? parseId(params.get("before")!) : null;
        const limit = Math.min(Math.max(Number(params.get("limit")) || 100, 1), 500);
        return json(accessLogEntries(accessLogFilters(params), before, limit));
      }),
    },
    "/api/access-log/services": {
      GET: handle(async () => json(await serviceTrafficSummary())),
    },
    "/api/access-log/stats": {
      GET: handle(async (req) => json(await accessLogStats(accessLogFilters(new URL(req.url).searchParams)))),
    },

    "/api/countries": {
      GET: handle(async () => json(await countryDbStatus())),
    },
    "/api/countries/update": {
      POST: handle(async () => json(await updateCountries())),
    },
    "/api/countries/lookup": {
      GET: handle((req) => {
        const ip = new URL(req.url).searchParams.get("ip")?.trim() ?? "";
        if (!isIP(ip)) throw new HttpError(400, `${ip || "(empty)"} is not an IP address`);
        if (!countriesReady()) throw new HttpError(503, "The country database isn't loaded yet");
        return json({ ip, country: countryOf(ip) || null });
      }),
    },

    "/api/health": { GET: () => json({ ok: true }) },

    // Polled by Traefik's HTTP provider over the Docker network.
    "/api/traefik/config": { GET: handle(() => json(buildConfig())) },
    "/api/traefik/status": { GET: handle(async () => json(await traefikStatus())) },
    // Traefik's forwardAuth check for services with country restrictions, on every request to them.
    "/api/traefik/country": { GET: handle(checkCountry) },
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`proxytail listening on ${server.url}`);
