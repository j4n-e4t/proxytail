import type { Server } from "bun";
import { localStatus, TailscaleError, whois, type WhoIs } from "./tailscale";

/**
 * UI authentication through Tailscale identity: the UI is only reachable over the tailnet, every request is attributed
 * to a tailnet user with the LocalAPI's whois, and roles come from app capability grants in the tailnet policy:
 *
 *   "grants": [{ "src": ["group:admins"], "dst": ["tag:proxytail"],
 *                "app": { "proxytail.dev/cap/ui": [{ "role": "admin" }] } }]
 */

export type Role = "admin" | "viewer";

export const CAPABILITY = process.env.TS_APP_CAPABILITY || "proxytail.dev/cap/ui";

/** `UI_AUTH=off` makes every request an admin. Meant for `bun run dev` only. */
export const authDisabled = process.env.UI_AUTH === "off";

export interface Identity {
  login: string;
  name: string;
  profilePicUrl: string | null;
  /** MagicDNS name of the device the request came from. */
  device: string;
}

export interface Session {
  identity: Identity | null;
  role: Role | null;
  /** Why the request has no role, shown on the access denied screen. */
  reason?: string;
}

function roleFrom(who: WhoIs): Role | null {
  const grants = who.CapMap?.[CAPABILITY] ?? [];
  const roles = grants.map((g) => (g as { role?: unknown } | null)?.role);
  if (roles.includes("admin")) return "admin";
  if (roles.includes("viewer")) return "viewer";
  return null;
}

const isLoopback = (ip: string) => ip === "::1" || ip.startsWith("127.");

/** The peer's IP, unwrapping IPv4-mapped IPv6 addresses (seen when listening on "::"). */
function remoteIp(req: Request, server: Server<unknown>) {
  const addr = server.requestIP(req);
  if (!addr) return null;
  return { ip: addr.address.replace(/^::ffff:(?=\d+\.)/, ""), port: addr.port };
}

/**
 * Resolves the caller. Tailnet clients connect directly and are looked up by their source IP. `tailscale serve`
 * connects from loopback and puts the client's Tailscale IP into X-Forwarded-For, replacing any value the client
 * sent, so that header is only trusted on loopback connections. Only proxytail and its Tailscale sidecar share that
 * loopback: Traefik is internet-facing and runs in a separate network namespace (docker-compose.yml), so it can't
 * reach this server at all, let alone forge the header.
 */
export async function authenticate(req: Request, server: Server<unknown>): Promise<Session> {
  if (authDisabled) return { identity: null, role: "admin" };
  const remote = remoteIp(req, server);
  if (!remote) return { identity: null, role: null, reason: "Unknown client address." };

  let target = remote;
  if (isLoopback(remote.ip)) {
    const forwarded = req.headers.get("x-forwarded-for")?.trim();
    if (!forwarded || forwarded.includes(","))
      return { identity: null, role: null, reason: "Open proxytail through its tailnet address." };
    target = { ip: forwarded, port: 0 };
  }

  let who: WhoIs | null;
  try {
    who = await whois(target.ip, target.port);
  } catch (e) {
    return { identity: null, role: null, reason: e instanceof TailscaleError ? e.message : "Identity lookup failed." };
  }
  if (!who) return { identity: null, role: null, reason: `${target.ip} is not a device on this tailnet.` };

  const tagged = !!who.Node.Tags?.length;
  const identity: Identity = {
    login: tagged ? who.Node.Tags!.join(", ") : who.UserProfile.LoginName,
    name: tagged ? who.Node.Name.split(".")[0]! : who.UserProfile.DisplayName || who.UserProfile.LoginName,
    profilePicUrl: (!tagged && who.UserProfile.ProfilePicURL) || null,
    device: who.Node.Name.replace(/\.$/, ""),
  };
  const role = roleFrom(who);
  return role
    ? { identity, role }
    : { identity, role: null, reason: `No ${CAPABILITY} grant for ${identity.login} in the tailnet policy.` };
}

let selfNames: { at: number; names: Set<string> } | null = null;

/** This node's MagicDNS name and short name, refreshed every minute. */
async function ownHostnames(): Promise<Set<string>> {
  if (selfNames && Date.now() - selfNames.at < 60_000) return selfNames.names;
  const names = new Set<string>();
  try {
    const fqdn = (await localStatus()).Self.DNSName.replace(/\.$/, "").toLowerCase();
    if (fqdn) names.add(fqdn).add(fqdn.split(".")[0]!);
  } catch {
    // tailscaled unreachable: only IPs and UI_HOSTS are accepted, and whois fails anyway.
  }
  selfNames = { at: Date.now(), names };
  return names;
}

const extraHosts = new Set(
  (process.env.UI_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Identity is ambient, like a cookie: any page the user visits could make their browser call the UI. Rejecting
 * unknown Host headers stops DNS rebinding, and checking Origin on writes stops cross-site requests.
 */
export async function checkBrowserOrigin(req: Request): Promise<string | null> {
  if (authDisabled) return null;
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const hostname = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  const isIp = /^[\d.]+$/.test(hostname) || hostname.includes(":");
  if (!isIp && hostname !== "localhost" && !extraHosts.has(hostname) && !(await ownHostnames()).has(hostname))
    return `Unknown host ${hostname}. Add it to UI_HOSTS to allow it.`;

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
