import type { ProxyHost } from "./db";

/**
 * Fetches a service's favicon straight from its backend over the tailnet (the browser can't reach 100.x addresses,
 * and going through the public hostname would need a client certificate). Results, including misses, are cached in memory.
 */

export interface Favicon {
  type: string;
  body: Uint8Array<ArrayBuffer>;
}

const HIT_TTL = 6 * 3_600_000;
const MISS_TTL = 10 * 60_000;
const TIMEOUT_MS = 3000;
const MAX_HTML = 256 * 1024;
const MAX_ICON = 512 * 1024;

const cache = new Map<number, { key: string; at: number; icon: Favicon | null }>();
const inflight = new Map<number, Promise<Favicon | null>>();

const origin = (h: ProxyHost) => `${h.scheme}://${h.targetIp}:${h.targetPort}`;

const MAX_REDIRECTS = 3;

/** An href resolved against `base`, pointed at the backend itself: only its path and query are kept. */
function onBackend(href: string, base: string, h: ProxyHost) {
  const target = new URL(href, base);
  return `${origin(h)}${target.pathname}${target.search}`;
}

/**
 * GETs a path from the backend. Redirects are followed by hand and only on the backend, like icon links: a Location
 * naming another host (usually the public hostname) is fetched from the backend too, so a backend can't make proxytail
 * request anything else, e.g. services on the Docker network or the LAN. Backends often answer on their IP with a
 * certificate for another name; an icon isn't worth failing over that.
 */
async function get(path: string, h: ProxyHost): Promise<Response | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = onBackend(path, `${origin(h)}/`, h);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, {
      headers: { Host: h.domains[0]!, "User-Agent": "proxytail favicon fetcher" },
      signal,
      redirect: "manual",
      tls: { rejectUnauthorized: false },
    });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    await res.body?.cancel();
    url = onBackend(location, url, h);
  }
  return null;
}

/** The body, or null once it exceeds `max` bytes: it's read in chunks, so a backend can't make proxytail buffer more. */
async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(res.headers.get("content-length")) > max || !res.body) {
    await res.body?.cancel();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    size += r.value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(r.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** `<link rel="icon" href="…">` candidates from the page, best first (SVG/PNG icons, then touch icons). */
function iconLinks(html: string): string[] {
  const links: { href: string; score: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    const rel = attr("rel");
    const href = attr("href");
    if (!rel || !href) continue;
    const relValue = (rel[1] ?? rel[2] ?? rel[3] ?? "").toLowerCase();
    const hrefValue = href[1] ?? href[2] ?? href[3] ?? "";
    if (!hrefValue || !/\bicon\b/.test(relValue)) continue;
    const score = relValue.includes("apple-touch-icon") ? 1 : /\.svg(\?|$)/i.test(hrefValue) ? 3 : 2;
    links.push({ href: hrefValue.replace(/&amp;/g, "&"), score });
  }
  return links.sort((a, b) => b.score - a.score).map((l) => l.href);
}

function fromDataUri(uri: string): Favicon | null {
  const m = uri.match(/^data:(image\/[\w.+-]+)(;base64)?,(.*)$/s);
  if (!m) return null;
  const body = m[2] ? Uint8Array.from(Buffer.from(m[3]!, "base64")) : new TextEncoder().encode(decodeURIComponent(m[3]!));
  return body.byteLength && body.byteLength <= MAX_ICON ? { type: m[1]!, body } : null;
}

/** Image type from the file's magic bytes; SVG is recognised by its root element. */
function sniff(b: Uint8Array): string | null {
  const starts = (...bytes: number[]) => bytes.every((x, i) => b[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return "image/webp";
  if (/<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 1024)))) return "image/svg+xml";
  return null;
}

async function fetchIcon(url: string, h: ProxyHost): Promise<Favicon | null> {
  if (url.startsWith("data:")) return fromDataUri(url);
  // Absolute links usually point at the public hostname; get() always fetches from the backend itself.
  const res = await get(url, h).catch(() => null);
  if (!res?.ok) return null;
  const body = await readCapped(res, MAX_ICON);
  if (!body?.byteLength) return null;
  const declared = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  // Icons are often served with a generic type (or an HTML error page with 200), so trust the bytes instead.
  const type = sniff(body) ?? (declared === "image/svg+xml" ? declared : null);
  return type ? { type, body } : null;
}

async function discover(h: ProxyHost): Promise<Favicon | null> {
  const candidates: string[] = [];
  const page = await get("/", h).catch(() => null);
  if (page?.ok && (page.headers.get("content-type") ?? "").includes("html")) {
    const html = await readCapped(page, MAX_HTML);
    if (html) candidates.push(...iconLinks(new TextDecoder().decode(html)));
  }
  candidates.push("/favicon.ico");
  for (const url of candidates) {
    const icon = await fetchIcon(url, h).catch(() => null);
    if (icon) return icon;
  }
  return null;
}

export async function faviconFor(h: ProxyHost): Promise<Favicon | null> {
  const key = `${origin(h)} ${h.domains[0]}`;
  const hit = cache.get(h.id);
  if (hit && hit.key === key && Date.now() - hit.at < (hit.icon ? HIT_TTL : MISS_TTL)) return hit.icon;
  let pending = inflight.get(h.id);
  if (!pending) {
    pending = discover(h)
      .then((icon) => {
        cache.set(h.id, { key, at: Date.now(), icon });
        return icon;
      })
      .finally(() => inflight.delete(h.id));
    inflight.set(h.id, pending);
  }
  return pending;
}
