import { certificateFor, type CertInfo } from "./certs";
import { clientCas, hosts, type ProxyHost } from "./db";
import { rateLimitMiddleware } from "./ratelimit";

// Every service is served over HTTPS with a Let's Encrypt certificate; plain HTTP is redirected by Traefik.
const ENTRYPOINTS = ["websecure"];
const CERT_RESOLVER = "letsencrypt";
const TRAEFIK_API_URL = process.env.TRAEFIK_API_URL ?? "http://localhost:8080";

/**
 * HSTS on every service: after the first HTTPS response a browser refuses plain HTTP to that host, closing the
 * SSL-strip window that Traefik's 80→443 redirect alone leaves open. One year, without includeSubDomains, so a
 * service never asserts HSTS for sibling names it doesn't control.
 */
const HSTS_MIDDLEWARE = "proxytail-hsts";
const HSTS_SECONDS = 31_536_000;

const hostRule = (hostnames: string[]) => hostnames.map((d) => `Host(\`${d}\`)`).join(" || ");

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
  const rateLimit = rateLimitMiddleware();

  for (const h of hosts.list()) {
    if (!h.enabled) continue;
    const name = routerName(h);
    const tls: Record<string, unknown> = { certResolver: CERT_RESOLVER };
    const hostname = h.domains[0]!;
    const parallel = h.aliases.filter((a) => a.mode === "parallel").map((a) => a.hostname);
    const redirected = h.aliases.filter((a) => a.mode === "redirect").map((a) => a.hostname);
    const router: Record<string, unknown> = {
      rule: hostRule([hostname, ...parallel]),
      entryPoints: ENTRYPOINTS,
      service: name,
      tls,
    };
    const chain: string[] = [];
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
    // Parallel aliases: the service sees its own hostname, whichever one the client asked for.
    if (parallel.length) {
      middlewares[`${name}-host`] = { headers: { customRequestHeaders: { Host: hostname } } };
      chain.push(`${name}-host`);
    }
    // Rate limiting goes first. Each service has its own middleware, and so its own buckets.
    if (rateLimit) {
      middlewares[`${name}-ratelimit`] = rateLimit;
      chain.unshift(`${name}-ratelimit`);
    }
    // Hide from search engines (Advanced in the editor). First, so it's also on responses the middlewares answer
    // themselves (429).
    if (h.noIndex) {
      middlewares[`${name}-noindex`] = { headers: { customResponseHeaders: { "X-Robots-Tag": "noindex, nofollow" } } };
      chain.unshift(`${name}-noindex`);
    }
    // HSTS applies to every service, whatever else is in the chain.
    chain.push(HSTS_MIDDLEWARE);
    router.middlewares = chain;
    routers[name] = router;
    // Redirect aliases get their own router (and certificate), which sends the client to the service's hostname. The
    // port, path and query stay. Temporary, so browsers don't hold on to it if the alias changes; 307 keeps the method.
    if (redirected.length) {
      middlewares[`${name}-redirect`] = {
        redirectRegex: { regex: "^https://[^/:]+(:[0-9]+)?(.*)$", replacement: `https://${hostname}\${1}\${2}`, permanent: false },
      };
      routers[`${name}-redirect`] = {
        rule: hostRule(redirected),
        entryPoints: ENTRYPOINTS,
        // Never reached: the redirect answers every request.
        service: name,
        tls,
        // HSTS first: the redirect answers the request itself, so nothing after it would run.
        middlewares: [HSTS_MIDDLEWARE, `${name}-redirect`],
      };
    }
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
  middlewares[HSTS_MIDDLEWARE] = { headers: { stsSeconds: HSTS_SECONDS } };
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

const RATE_LIMIT_NAME_RE = /^proxytail-host-(\d+)-ratelimit@http$/;

/** Traefik's state of the services' rate limit middlewares; null while its API is unreachable. */
export async function rateLimitStatus(): Promise<{ enabled: number; errors: string[] } | null> {
  try {
    const res = await fetch(`${TRAEFIK_API_URL}/api/http/middlewares?search=-ratelimit&per_page=1000`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const list = (await res.json()) as { name: string; status: string; error?: string[] }[];
    const ours = list.filter((m) => RATE_LIMIT_NAME_RE.test(m.name));
    return {
      enabled: ours.filter((m) => m.status === "enabled").length,
      errors: [...new Set(ours.flatMap((m) => m.error ?? []))],
    };
  } catch {
    return null;
  }
}
