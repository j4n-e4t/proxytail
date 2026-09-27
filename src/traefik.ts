import { certificateFor, type CertInfo } from "./certs";
import { clientCas, hosts, type ProxyHost } from "./db";

// Every service is served over HTTPS with a Let's Encrypt certificate; plain HTTP is redirected by Traefik.
const ENTRYPOINTS = ["websecure"];
const CERT_RESOLVER = "letsencrypt";
const TRAEFIK_API_URL = process.env.TRAEFIK_API_URL ?? "http://localhost:8080";
export const HEALTH_CHECK_INTERVAL = "10s";
const HEALTH_CHECK_TIMEOUT = "5s";

export const routerName = (h: Pick<ProxyHost, "id">) => `proxytail-host-${h.id}`;

/** Header the verified client certificate's details are forwarded in (URL-encoded, see Traefik's passTLSClientCert). */
export const CLIENT_CERT_INFO_HEADER = "X-Forwarded-Tls-Client-Cert-Info";
const DN_FIELDS = { commonName: true, organization: true, serialNumber: true };

/** Dynamic configuration served to Traefik's HTTP provider. */
export function buildConfig() {
  const routers: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  const serversTransports: Record<string, unknown> = {};
  const middlewares: Record<string, unknown> = {};
  const tlsOptions: Record<string, unknown> = {};
  const cas = new Map(clientCas.list().map((ca) => [ca.id, ca]));

  for (const h of hosts.list()) {
    if (!h.enabled) continue;
    const name = routerName(h);
    const tls: Record<string, unknown> = { certResolver: CERT_RESOLVER };
    const router: Record<string, unknown> = {
      rule: h.domains.map((d) => `Host(\`${d}\`)`).join(" || "),
      entryPoints: ENTRYPOINTS,
      service: name,
      tls,
    };
    const chain: string[] = [];
    const caPems = h.clientCaIds.map((id) => cas.get(id)?.certPem).filter((p): p is string => !!p);
    if (h.clientAuth !== "off" && caPems.length) {
      // TLS options apply per SNI hostname, so each service gets its own. caFiles takes PEM content as well as paths.
      tlsOptions[name] = {
        clientAuth: {
          caFiles: caPems,
          clientAuthType: h.clientAuth === "require" ? "RequireAndVerifyClientCert" : "VerifyClientCertIfGiven",
        },
      };
      tls.options = name;
      if (h.clientCertHeaders) {
        // Drop whatever the client sent in the header first, so the service can trust it.
        middlewares[`${name}-client-cert-strip`] = { headers: { customRequestHeaders: { [CLIENT_CERT_INFO_HEADER]: "" } } };
        middlewares[`${name}-client-cert`] = {
          passTLSClientCert: {
            info: { notAfter: true, notBefore: true, serialNumber: true, subject: DN_FIELDS, issuer: DN_FIELDS },
          },
        };
        chain.push(`${name}-client-cert-strip`, `${name}-client-cert`);
      }
    }
    if (h.basicAuth && h.basicAuthUsers.length) {
      middlewares[`${name}-auth`] = {
        basicAuth: {
          users: h.basicAuthUsers.map((u) => `${u.username}:${u.hash}`),
          realm: h.domains[0],
          // Don't leak the credentials to the upstream service.
          removeHeader: true,
        },
      };
      chain.push(`${name}-auth`);
    }
    if (chain.length) router.middlewares = chain;
    routers[name] = router;
    const loadBalancer: Record<string, unknown> = {
      servers: [{ url: `${h.scheme}://${h.targetIp}:${h.targetPort}` }],
      passHostHeader: true,
    };
    if (h.healthCheck) {
      // Any 2xx/3xx answer counts as healthy. The Host header matches what real requests carry.
      loadBalancer.healthCheck = {
        path: h.healthCheckPath,
        interval: HEALTH_CHECK_INTERVAL,
        timeout: HEALTH_CHECK_TIMEOUT,
        hostname: h.domains[0],
      };
    }
    if (h.scheme === "https" && h.insecureSkipVerify) {
      serversTransports[name] = { insecureSkipVerify: true };
      loadBalancer.serversTransport = name;
    }
    services[name] = { loadBalancer };
  }

  // Traefik rejects an empty `http` element, so omit it entirely when nothing is routed.
  if (!Object.keys(routers).length) return {};
  const http: Record<string, unknown> = { routers, services };
  if (Object.keys(serversTransports).length) http.serversTransports = serversTransports;
  if (Object.keys(middlewares).length) http.middlewares = middlewares;
  return Object.keys(tlsOptions).length ? { http, tls: { options: tlsOptions } } : { http };
}

export interface TraefikStatus {
  reachable: boolean;
  version?: string;
  error?: string;
  /** Router status keyed by service (proxy host) id. */
  routers: Record<number, { status: string; errors?: string[] }>;
  /** Certificate Traefik currently serves for each enabled service's primary hostname. */
  certificates: Record<number, CertInfo>;
  /** Health check result for services with a health check, keyed by service id. */
  health: Record<number, { up: boolean; url: string }>;
}

const HOST_NAME_RE = /^proxytail-host-(\d+)@/;

export async function traefikStatus(): Promise<TraefikStatus> {
  try {
    const signal = AbortSignal.timeout(2000);
    const [versionRes, routersRes, servicesRes] = await Promise.all([
      fetch(`${TRAEFIK_API_URL}/api/version`, { signal }),
      fetch(`${TRAEFIK_API_URL}/api/http/routers?per_page=1000`, { signal }),
      fetch(`${TRAEFIK_API_URL}/api/http/services?per_page=1000`, { signal }),
    ]);
    if (!routersRes.ok) throw new Error(`Traefik API returned ${routersRes.status}`);
    const version = versionRes.ok ? ((await versionRes.json()) as { Version: string }).Version : undefined;
    const list = (await routersRes.json()) as { name: string; status: string; error?: string[] }[];
    const routers: TraefikStatus["routers"] = {};
    for (const r of list) {
      const m = r.name.match(HOST_NAME_RE);
      if (m) routers[Number(m[1])] = { status: r.status, errors: r.error };
    }
    const all = hosts.list();
    // Without a health check Traefik always reports "UP", so only trust the status of checked services.
    const checked = new Set(all.filter((h) => h.enabled && h.healthCheck).map((h) => h.id));
    const health: TraefikStatus["health"] = {};
    const services = servicesRes.ok
      ? ((await servicesRes.json()) as { name: string; serverStatus?: Record<string, string> }[])
      : [];
    for (const s of services) {
      const id = Number(s.name.match(HOST_NAME_RE)?.[1]);
      const [url, state] = Object.entries(s.serverStatus ?? {})[0] ?? [];
      if (checked.has(id) && url) health[id] = { up: state === "UP", url };
    }
    const enabled = all.filter((h) => h.enabled && routers[h.id]);
    const certs = await Promise.all(enabled.map((h) => certificateFor(h.domains[0]!)));
    const certificates = Object.fromEntries(enabled.map((h, i) => [h.id, certs[i]!]));
    return { reachable: true, version, routers, certificates, health };
  } catch (e) {
    return { reachable: false, error: (e as Error).message, routers: {}, certificates: {}, health: {} };
  }
}
