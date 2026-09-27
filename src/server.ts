import type { Server } from "bun";
import index from "./web/index.html";
import { authenticate, CAPABILITY, checkBrowserOrigin, type Role, type Session } from "./auth";
import { domains as domainStore, hosts, settings, type BasicAuthUser, type ProxyHost, type ProxyHostInput } from "./db";
import { checkDomain, detectPublicIp, publicAddress, requiredRecord } from "./dns";
import { faviconFor } from "./favicons";
import {
  clearDeviceCache,
  deviceSource,
  isConfigured,
  listDevices,
  normalizeTag,
  tailscaleConfig,
  TailscaleError,
} from "./tailscale";
import { buildConfig, traefikStatus, writeConfig } from "./traefik";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** Who may call a route: a tailnet user with at least that role. */
async function authorize(req: Request, server: Server<unknown>, access: Role): Promise<Session> {
  const rejected = await checkBrowserOrigin(req);
  if (rejected) throw new HttpError(403, rejected);
  const session = await authenticate(req, server);
  if (!session.role) throw new HttpError(403, session.reason ?? "Access denied");
  if (access !== "viewer" && session.role !== "admin")
    throw new HttpError(403, `Read-only access: this needs the admin role in ${CAPABILITY}`);
  return session;
}

function handle<T extends Request>(access: Role, fn: (req: T, session: Session) => Promise<Response> | Response) {
  return async (req: T, server: Server<unknown>) => {
    try {
      return await fn(req, await authorize(req, server, access));
    } catch (e) {
      if (e instanceof HttpError || e instanceof TailscaleError) return json({ error: e.message }, e.status);
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

  const healthCheck = raw.healthCheck === undefined ? true : !!raw.healthCheck;
  const healthCheckPath = String(raw.healthCheckPath ?? "/").trim() || "/";
  if (!healthCheckPath.startsWith("/") || /\s/.test(healthCheckPath))
    throw new HttpError(400, "Health check path must start with / and contain no spaces");

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
    healthCheck,
    healthCheckPath,
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

function settingsView() {
  const c = tailscaleConfig();
  return {
    publicAddress: publicAddress(),
    configured: isConfigured(),
    source: deviceSource(),
    mock: !!process.env.TS_MOCK_DEVICES,
    backendTag: c.backendTag,
  };
}

const port = Number(process.env.PORT ?? 3000);

// Traefik reads its routing table from a file (see writeConfig). Rewritten after every change and reconciled
// periodically, which also retries failed writes.
writeConfig();
setInterval(writeConfig, 30_000);

const server = Bun.serve({
  port,
  // Loopback only: the UI is published on the tailnet by `tailscale serve` in the sidecar.
  hostname: process.env.HOST ?? "127.0.0.1",
  routes: {
    "/*": index,

    "/api/hosts": {
      GET: handle("viewer", () => json(hosts.list().map(hostView))),
      POST: handle("admin", async (req) => {
        const h = hosts.create(await validateHost(await body(req)));
        writeConfig();
        return json(hostView(h), 201);
      }),
    },
    "/api/hosts/:id/favicon": {
      GET: handle("viewer", async (req) => {
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
      GET: handle("viewer", (req) => {
        const h = hosts.get(parseId(req.params.id));
        if (!h) throw new HttpError(404, "Service not found");
        return json(hostView(h));
      }),
      PUT: handle("admin", async (req) => {
        const existing = hosts.get(parseId(req.params.id));
        if (!existing) throw new HttpError(404, "Service not found");
        const patch = await body<Record<string, unknown>>(req);
        const h = hosts.update(existing.id, await validateHost({ ...existing, ...patch }, existing))!;
        writeConfig();
        return json(hostView(h));
      }),
      DELETE: handle("admin", (req) => {
        if (!hosts.delete(parseId(req.params.id))) throw new HttpError(404, "Service not found");
        writeConfig();
        return new Response(null, { status: 204 });
      }),
    },

    "/api/domains": {
      GET: handle("viewer", () => json(domainStore.list().map(domainView))),
      POST: handle("admin", async (req) => {
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
      POST: handle("admin", async (req) => {
        const d = domainStore.get(parseId(req.params.id));
        if (!d) throw new HttpError(404, "Domain not found");
        return json(domainView(domainStore.saveCheck(d.id, await checkDomain(d.name))));
      }),
    },
    "/api/domains/:id": {
      DELETE: handle("admin", (req) => {
        const d = domainStore.get(parseId(req.params.id));
        if (!d) throw new HttpError(404, "Domain not found");
        const used = hosts.list().filter((h) => h.domains.some((x) => domainStore.match(x)?.id === d.id));
        if (used.length)
          throw new HttpError(409, `${d.name} is used by ${used.map((h) => h.domains[0]).join(", ")}. Delete those services first.`);
        domainStore.delete(d.id);
        return new Response(null, { status: 204 });
      }),
    },

    "/api/devices": {
      GET: handle("viewer", async (req) => json(await listDevices(new URL(req.url).searchParams.has("refresh")))),
    },

    "/api/settings": {
      GET: handle("viewer", () => json(settingsView())),
      PUT: handle("admin", async (req) => {
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
      POST: handle("admin", async () => json({ ip: await detectPublicIp() })),
    },
    "/api/settings/test": {
      POST: handle("viewer", async () => {
        const devices = await listDevices(true);
        return json({ ok: true, devices: devices.length });
      }),
    },

    "/api/health": { GET: () => json({ ok: true }) },

    // The current user; also answers when access is denied, so the UI can explain why.
    "/api/me": {
      GET: async (req, server) => {
        const rejected = await checkBrowserOrigin(req);
        const session: Session = rejected ? { identity: null, role: null, reason: rejected } : await authenticate(req, server);
        // No identity but a role: authentication is bypassed (UI_AUTH).
        return json({ ...session, capability: CAPABILITY, authDisabled: !!session.role && !session.identity });
      },
    },

    // The generated Traefik config, for admins only: it contains basic auth hashes.
    "/api/traefik/config": { GET: handle("admin", () => json(buildConfig())) },
    "/api/traefik/status": { GET: handle("viewer", async () => json(await traefikStatus())) },
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`proxytail listening on ${server.url}`);
