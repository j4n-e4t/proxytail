/**
 * There is no authentication: whoever can reach the UI has full access, and access is controlled at the network
 * layer (the UI only listens on the host's loopback, published on the tailnet by `tailscale serve`, and the tailnet
 * policy decides who can reach it).
 *
 * That makes the UI's reachability ambient, like a cookie: any page a tailnet user visits could make their browser call
 * it. Rejecting unknown Host headers stops DNS rebinding, and checking Origin on writes stops cross-site requests.
 */

const extraHosts = new Set(
  (process.env.UI_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Hostnames the UI answers to: IPs, single-label names (localhost, or `app` for Traefik on the Docker network),
 * `.internal` names (host.docker.internal in development), MagicDNS names and UI_HOSTS. A rebinding attack needs a
 * public name whose DNS the attacker controls, which none of these are: `.internal` is reserved for private use.
 */
function knownHost(hostname: string) {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return true;
  if (!hostname.includes(".") || extraHosts.has(hostname)) return true;
  return hostname.endsWith(".internal") || hostname.endsWith(".ts.net");
}

/** Returns why the request is rejected, or null. */
export function checkBrowserOrigin(req: Request): string | null {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const hostname = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  if (!knownHost(hostname)) return `Unknown host ${hostname}. Add it to UI_HOSTS to allow it.`;

  if (req.method === "GET" || req.method === "HEAD") return null;
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    if (URL.parse(origin)?.host.toLowerCase() !== host) return "Cross-origin request rejected";
  } else {
    const site = req.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return "Cross-site request rejected";
    if (origin === "null") return "Cross-origin request rejected";
  }
  return null;
}
