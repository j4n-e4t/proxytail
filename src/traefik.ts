import { certificateFor, type CertInfo } from "./certs";
import { bouncerMiddleware, MIDDLEWARE as CROWDSEC_MIDDLEWARE } from "./crowdsec";
import { clientCas, hosts, type ProxyHost } from "./db";

// Every service is served over HTTPS with a Let's Encrypt certificate; plain HTTP is redirected by Traefik.
const ENTRYPOINTS = ["websecure"];
const CERT_RESOLVER = "letsencrypt";
const TRAEFIK_API_URL = process.env.TRAEFIK_API_URL ?? "http://localhost:8080";

export const routerName = (h: Pick<ProxyHost, "id">) => `proxytail-host-${h.id}`;

/** Header the verified client certificate's details are forwarded in (URL-encoded, see Traefik's passTLSClientCert). */
export const CLIENT_CERT_INFO_HEADER = "X-Forwarded-Tls-Client-Cert-Info";
const DN_FIELDS = { commonName: true, organization: true, serialNumber: true };

const TLS_VERSIONS: Record<string, string> = { "1.2": "VersionTLS12", "1.3": "VersionTLS13" };

/** Minimum TLS version for every service, from TLS_MIN_VERSION ("1.2", the default, or "1.3"). */
function minTlsVersion() {
  const raw = (process.env.TLS_MIN_VERSION ?? "").trim() || "1.2";
  const version = TLS_VERSIONS[raw];
  if (version) return version;
  console.error(`Ignoring TLS_MIN_VERSION=${raw}: use 1.2 or 1.3`);
  return TLS_VERSIONS["1.2"]!;
}

/**
 * Settings every TLS option carries. `sniStrict` refuses handshakes for names Traefik has no certificate for, including
 * none at all, so scanners probing the IP get a refused handshake instead of Traefik's default certificate. A service's
 * own TLS option replaces the default one rather than extending it, hence both get these.
 */
export const TLS_DEFAULTS = { sniStrict: true, minVersion: minTlsVersion() };

/** Dynamic configuration served to Traefik's HTTP provider. */
export function buildConfig() {
  const routers: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  const serversTransports: Record<string, unknown> = {};
  const middlewares: Record<string, unknown> = {};
  const tlsOptions: Record<string, unknown> = {};
  const cas = new Map(clientCas.list().map((ca) => [ca.id, ca]));
  const bouncer = bouncerMiddleware();

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
    // CrowdSec goes first: a banned IP gets no further, not even to a basic auth prompt.
    const chain: string[] = bouncer ? [CROWDSEC_MIDDLEWARE] : [];
    if (h.clientAuth !== "off") {
      const caPems = h.clientCaIds.map((id) => cas.get(id)?.certPem);
      // Fail closed: a service that should verify client certificates is never published without that check. The
      // database already prevents this state; this guards against it regardless.
      if (!caPems.length || caPems.some((p) => !p)) {
        console.error(`Not routing ${h.domains[0]}: it verifies client certificates but has no CA`);
        continue;
      }
      // TLS options apply per SNI hostname, so each service gets its own. caFiles takes PEM content as well as paths.
      tlsOptions[name] = {
        ...TLS_DEFAULTS,
        clientAuth: {
          caFiles: caPems as string[],
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
    if (h.scheme === "https" && h.insecureSkipVerify) {
      serversTransports[name] = { insecureSkipVerify: true };
      loadBalancer.serversTransport = name;
    }
    services[name] = { loadBalancer };
  }

  // The default TLS option applies to every connection whose SNI no service claims, so it's served even without routes.
  const tlsConfig = { options: { default: TLS_DEFAULTS, ...tlsOptions } };
  // Traefik rejects an empty `http` element, so omit it entirely when nothing is routed.
  if (!Object.keys(routers).length) return { tls: tlsConfig };
  if (bouncer) middlewares[CROWDSEC_MIDDLEWARE] = bouncer;
  const http: Record<string, unknown> = { routers, services };
  if (Object.keys(serversTransports).length) http.serversTransports = serversTransports;
  if (Object.keys(middlewares).length) http.middlewares = middlewares;
  return { http, tls: tlsConfig };
}

export interface TraefikStatus {
  reachable: boolean;
  version?: string;
  error?: string;
  /** Router status keyed by service (proxy host) id. */
  routers: Record<number, { status: string; errors?: string[] }>;
  /** Certificate Traefik currently serves for each enabled service's primary hostname. */
  certificates: Record<number, CertInfo>;
}

const HOST_NAME_RE = /^proxytail-host-(\d+)@/;

export async function traefikStatus(): Promise<TraefikStatus> {
  try {
    const signal = AbortSignal.timeout(2000);
    const [versionRes, routersRes] = await Promise.all([
      fetch(`${TRAEFIK_API_URL}/api/version`, { signal }),
      fetch(`${TRAEFIK_API_URL}/api/http/routers?per_page=1000`, { signal }),
    ]);
    if (!routersRes.ok) throw new Error(`Traefik API returned ${routersRes.status}`);
    const version = versionRes.ok ? ((await versionRes.json()) as { Version: string }).Version : undefined;
    const list = (await routersRes.json()) as { name: string; status: string; error?: string[] }[];
    const routers: TraefikStatus["routers"] = {};
    for (const r of list) {
      const m = r.name.match(HOST_NAME_RE);
      if (m) routers[Number(m[1])] = { status: r.status, errors: r.error };
    }
    const enabled = hosts.list().filter((h) => h.enabled && routers[h.id]);
    const certs = await Promise.all(enabled.map((h) => certificateFor(h.domains[0]!)));
    const certificates = Object.fromEntries(enabled.map((h, i) => [h.id, certs[i]!]));
    return { reachable: true, version, routers, certificates };
  } catch (e) {
    return { reachable: false, error: (e as Error).message, routers: {}, certificates: {} };
  }
}

/** State of one of proxytail's middlewares in Traefik, e.g. whether the CrowdSec plugin loaded. */
export async function middlewareStatus(name: string): Promise<{ status: string; errors?: string[] } | null> {
  try {
    const res = await fetch(`${TRAEFIK_API_URL}/api/http/middlewares/${name}@http`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const m = (await res.json()) as { status: string; error?: string[] };
    return { status: m.status, errors: m.error };
  } catch {
    return null;
  }
}
