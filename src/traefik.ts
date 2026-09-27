import { hosts, type ProxyHost } from "./db";

const ENTRYPOINTS = (process.env.TRAEFIK_ENTRYPOINTS ?? "web").split(",").map((s) => s.trim());
const TRAEFIK_API_URL = process.env.TRAEFIK_API_URL ?? "http://localhost:8080";

export const routerName = (h: Pick<ProxyHost, "id">) => `proxytail-host-${h.id}`;

/** Dynamic configuration served to Traefik's HTTP provider. */
export function buildConfig() {
  const routers: Record<string, unknown> = {};
  const services: Record<string, unknown> = {};
  const serversTransports: Record<string, unknown> = {};

  for (const h of hosts.list()) {
    if (!h.enabled) continue;
    const name = routerName(h);
    routers[name] = {
      rule: h.domains.map((d) => `Host(\`${d}\`)`).join(" || "),
      entryPoints: ENTRYPOINTS,
      service: name,
    };
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

  // Traefik rejects an empty `http` element, so omit it entirely when nothing is routed.
  if (!Object.keys(routers).length) return {};
  const http: Record<string, unknown> = { routers, services };
  if (Object.keys(serversTransports).length) http.serversTransports = serversTransports;
  return { http };
}

export interface TraefikStatus {
  reachable: boolean;
  version?: string;
  error?: string;
  /** Router status keyed by service (proxy host) id. */
  routers: Record<number, { status: string; errors?: string[] }>;
}

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
      const m = r.name.match(/^proxytail-host-(\d+)@/);
      if (m) routers[Number(m[1])] = { status: r.status, errors: r.error };
    }
    return { reachable: true, version, routers };
  } catch (e) {
    return { reachable: false, error: (e as Error).message, routers: {} };
  }
}
