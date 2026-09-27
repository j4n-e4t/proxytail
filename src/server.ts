import index from "./web/index.html";
import { domains as domainStore, hosts, settings, type ProxyHost, type ProxyHostInput } from "./db";
import { checkDomain, detectPublicIp, publicAddress, requiredRecord } from "./dns";
import { clearDeviceCache, isConfigured, listDevices, tailscaleConfig, TailscaleError } from "./tailscale";
import { buildConfig, traefikStatus } from "./traefik";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

function handle<T extends Request>(fn: (req: T) => Promise<Response> | Response) {
  return async (req: T) => {
    try {
      return await fn(req);
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
  if (!deviceId) throw new HttpError(400, "A target device is required");

  let deviceName: string;
  let targetIp: string;
  const unchanged = existing && existing.deviceId === deviceId;
  try {
    const device = (await listDevices()).find((d) => d.id === deviceId);
    if (!device) throw new HttpError(400, "Target device not found in tailnet");
    if (!device.ipv4) throw new HttpError(400, `${device.name} has no Tailscale IPv4 address`);
    deviceName = device.name;
    targetIp = device.ipv4;
  } catch (e) {
    // Allow editing other fields while the Tailscale API is unreachable.
    if (!(e instanceof TailscaleError) || !unchanged) throw e;
    deviceName = existing.deviceName;
    targetIp = existing.targetIp;
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
  };
}

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
    mock: !!process.env.TS_MOCK_DEVICES,
    tailnet: c.tailnet,
    apiKeySet: !!c.apiKey,
    oauthClientId: c.oauthClientId,
    oauthClientSecretSet: !!c.oauthClientSecret,
  };
}

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  hostname: process.env.HOST ?? "0.0.0.0",
  routes: {
    "/*": index,

    "/api/hosts": {
      GET: () => json(hosts.list()),
      POST: handle(async (req) => json(hosts.create(await validateHost(await body(req))), 201)),
    },
    "/api/hosts/:id": {
      GET: handle((req) => {
        const h = hosts.get(parseId(req.params.id));
        if (!h) throw new HttpError(404, "Service not found");
        return json(h);
      }),
      PUT: handle(async (req) => {
        const existing = hosts.get(parseId(req.params.id));
        if (!existing) throw new HttpError(404, "Service not found");
        const patch = await body<Record<string, unknown>>(req);
        return json(hosts.update(existing.id, await validateHost({ ...existing, ...patch }, existing)));
      }),
      DELETE: handle((req) => {
        if (!hosts.delete(parseId(req.params.id))) throw new HttpError(404, "Service not found");
        return new Response(null, { status: 204 });
      }),
    },

    "/api/domains": {
      GET: () => json(domainStore.list().map(domainView)),
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

    "/api/devices": {
      GET: handle(async (req) => json(await listDevices(new URL(req.url).searchParams.has("refresh")))),
    },

    "/api/settings": {
      GET: () => json(settingsView()),
      PUT: handle(async (req) => {
        const b = await body<Record<string, string | null | undefined>>(req);
        // `undefined` leaves a value untouched, `null`/"" clears it (falls back to env).
        if (b.publicAddress !== undefined) settings.set("public_address", b.publicAddress?.trim() ?? null);
        if (b.tailnet !== undefined) settings.set("tailnet", b.tailnet?.trim() ?? null);
        if (b.apiKey !== undefined) settings.set("ts_api_key", b.apiKey?.trim() ?? null);
        if (b.oauthClientId !== undefined) settings.set("ts_oauth_client_id", b.oauthClientId?.trim() ?? null);
        if (b.oauthClientSecret !== undefined)
          settings.set("ts_oauth_client_secret", b.oauthClientSecret?.trim() ?? null);
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

    "/api/health": { GET: () => json({ ok: true }) },

    // Polled by Traefik's HTTP provider.
    "/api/traefik/config": { GET: () => json(buildConfig()) },
    "/api/traefik/status": { GET: async () => json(await traefikStatus()) },
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`proxytail listening on ${server.url}`);
