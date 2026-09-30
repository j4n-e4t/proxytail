import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { captchas, hosts, settings, type Captcha } from "./db";

/**
 * Captchas in front of services, with Cloudflare Turnstile. Traefik asks proxytail about every request to
 * a service with a captcha (a forwardAuth middleware), and proxytail answers:
 *
 * - with 200, which lets the request through, when it carries a valid clearance cookie;
 * - with a challenge page (403) otherwise. The visitor solves the captcha there, and the page sends the token to
 *   CAPTCHA_PATH on the service's own hostname. That request reaches proxytail through forwardAuth as well: proxytail
 *   checks the token with Cloudflare, sets the clearance cookie and redirects back (303).
 *
 * Nothing but forwardAuth calls reach proxytail, so it stays off the internet. The clearance cookie is signed with a
 * key only proxytail knows, and is valid for one service and captcha, for the captcha's lifetime.
 */

/** Reserved on every service with a captcha: the challenge page sends solved tokens here. */
export const CAPTCHA_PATH = "/.well-known/proxytail-captcha";
const VERIFY_PATH = `${CAPTCHA_PATH}/verify`;
/** `__Host-`: only accepted over HTTPS, for exactly the hostname that set it. */
const COOKIE = "__Host-proxytail-captcha";

export const LIFETIME = { min: 5 * 60, max: 30 * 86_400, default: 86_400 };

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";
/** Where the page loads the widget's script and frame from, for its CSP. */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
/** Form field the widget puts its token in. */
const TOKEN_FIELD = "cf-turnstile-response";
/** Turnstile's test secrets, which accept dummy tokens from any hostname and report `example.com` for it. */
const TEST_SECRET_RE = /^[123]x0{31}AA$/;

interface SiteverifyResult {
  success: boolean;
  hostname?: string;
  "error-codes"?: string[];
}

/** Asks Cloudflare whether a token is valid. Throws if Cloudflare can't be reached. */
async function siteverify(secretKey: string, token: string, remoteIp?: string): Promise<SiteverifyResult> {
  const form = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);
  const res = await fetch(VERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
  // A wrong secret is answered with 400 and the reason in the body, like any other failure.
  const result = (await res.json().catch(() => null)) as SiteverifyResult | null;
  if (typeof result?.success !== "boolean") throw new Error(`Cloudflare answered ${res.status}`);
  return result;
}

/**
 * Checks a secret key with Cloudflare before it's saved, with a token that can't be valid: Cloudflare then complains
 * about the secret if it's wrong, and about the token otherwise. Returns why the key is rejected, or null.
 */
export async function checkSecretKey(secretKey: string): Promise<string | null> {
  let result: SiteverifyResult;
  try {
    result = await siteverify(secretKey, "proxytail-secret-key-check");
  } catch (e) {
    return `Couldn't reach Cloudflare to check the secret key: ${(e as Error).message}`;
  }
  if (result["error-codes"]?.includes("invalid-input-secret")) return "Cloudflare doesn't accept this secret key";
  return null;
}

/** The key clearance cookies are signed with, generated on first use and kept in the database. */
function signingKey(): Buffer {
  const stored = settings.get("captcha_signing_key");
  if (stored) return Buffer.from(stored, "base64");
  const key = randomBytes(32);
  settings.set("captcha_signing_key", key.toString("base64"));
  return key;
}

const sign = (payload: string) => createHmac("sha256", signingKey()).update(payload).digest("base64url");

/** `<host id>.<captcha id>.<expiry, unix seconds>.<signature>` */
function clearance(hostId: number, c: Captcha, now = Date.now()) {
  const payload = `${hostId}.${c.id}.${Math.floor(now / 1000) + c.lifetime}`;
  return `${payload}.${sign(payload)}`;
}

function validClearance(value: string | undefined, hostId: number, c: Captcha, now = Date.now()) {
  const parts = value?.split(".");
  if (parts?.length !== 4) return false;
  const [host, captcha, expiry, signature] = parts as [string, string, string, string];
  const expected = Buffer.from(sign(`${host}.${captcha}.${expiry}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  const secondsLeft = Number(expiry) - now / 1000;
  // A lifetime that was shortened since applies to cookies issued before, too.
  return Number(host) === hostId && Number(captcha) === c.id && secondsLeft > 0 && secondsLeft <= c.lifetime;
}

function cookieValue(req: Request, name: string) {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/**
 * Where to send the visitor once they've solved the captcha: a path on the same hostname. Anything else (another
 * host, `//host`, or the captcha's own path) goes to the root instead.
 */
function safeReturn(raw: string | null | undefined) {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\x00-\x1f\x7f]/.test(raw)) return "/";
  if (raw === CAPTCHA_PATH || raw.startsWith(`${CAPTCHA_PATH}/`) || raw.startsWith(`${CAPTCHA_PATH}?`)) return "/";
  return raw;
}

const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

/**
 * The page visitors solve the captcha on, served in place of what they asked for, with status 403: nothing but the
 * widget and a line of text, black or white with the visitor's color scheme.
 */
function challengePage(c: Captcha, returnTo: string) {
  const nonce = randomBytes(16).toString("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${TURNSTILE_ORIGIN}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    `connect-src ${TURNSTILE_ORIGIN}`,
    "style-src 'unsafe-inline'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Verifying request</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 20px; padding: 16px; box-sizing: border-box; background: #fff; color: #000;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: #000; color: #fff; } }
  p { margin: 0; }
  form { min-height: 65px; }
</style>
</head>
<body>
<p>Verifying request</p>
<form id="captcha" method="get" action="${VERIFY_PATH}">
  <input type="hidden" name="return" value="${escapeHtml(returnTo)}">
  <div class="cf-turnstile" data-sitekey="${escapeHtml(c.siteKey)}" data-callback="proxytailSolved"></div>
</form>
<script nonce="${nonce}">
  function proxytailSolved() { document.getElementById("captcha").submit(); }
</script>
<script nonce="${nonce}" src="${SCRIPT_URL}" async defer></script>
</body>
</html>`;
  return new Response(html, {
    status: 403,
    headers: {
      ...noStore,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      // Cloudflare sees the origin, never the path and query the visitor asked for.
      "Referrer-Policy": "strict-origin",
    },
  });
}

/** For requests a challenge page is no use to, e.g. from scripts or for images. */
const blocked = () =>
  new Response("This service asks visitors to complete a captcha. Open it in a browser.\n", {
    status: 403,
    headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" },
  });

/**
 * Traefik's forwardAuth call for a request to service `hostId`. It carries the original request's method, hostname,
 * path and client IP in X-Forwarded-* headers, and only its Accept and Cookie headers (see buildConfig).
 */
export async function captchaCheck(req: Request, hostId: number): Promise<Response> {
  const c = captchas.forHost(hostId);
  if (c === undefined) return new Response("Unknown service\n", { status: 404 });
  // The captcha was removed from the service; Traefik drops this middleware within seconds.
  if (c === null) return new Response(null, { status: 200 });

  const h = req.headers;
  // Set by Traefik from the request itself: forwardAuth ignores what the client sent (trustForwardHeader is off).
  const host = (h.get("x-forwarded-host") ?? "").toLowerCase();
  const hostname = host.replace(/:\d+$/, "");
  const uri = h.get("x-forwarded-uri") ?? "/";
  const method = h.get("x-forwarded-method") ?? "GET";
  const clientIp = h.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
  if (!hosts.get(hostId)?.domains.includes(hostname)) return new Response("Unknown hostname\n", { status: 404 });

  const url = new URL(uri, "https://invalid");
  if (url.pathname === VERIFY_PATH) {
    const returnTo = safeReturn(url.searchParams.get("return"));
    const token = url.searchParams.get(TOKEN_FIELD);
    // A missing or rejected token gets a fresh widget to solve.
    if (!token) return challengePage(c, returnTo);
    let result: SiteverifyResult;
    try {
      result = await siteverify(c.secretKey, token, clientIp);
    } catch (e) {
      console.error(`Captcha for ${hostname}: ${(e as Error).message}`);
      return challengePage(c, returnTo);
    }
    // A token solved on another site with the same widget doesn't count. The test secrets report a fixed hostname.
    const hostMatches = !result.hostname || result.hostname === hostname || TEST_SECRET_RE.test(c.secretKey);
    if (!result.success || !hostMatches) return challengePage(c, returnTo);
    return new Response(null, {
      status: 303,
      headers: {
        ...noStore,
        // Absolute: Traefik resolves a relative Location against proxytail's own address.
        Location: `https://${host}${returnTo}`,
        "Set-Cookie": `${COOKIE}=${clearance(hostId, c)}; Max-Age=${c.lifetime}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      },
    });
  }

  if (validClearance(cookieValue(req, COOKIE), hostId, c)) return new Response(null, { status: 200 });
  const wantsPage = (method === "GET" || method === "HEAD") && (h.get("accept") ?? "").includes("text/html");
  return wantsPage ? challengePage(c, safeReturn(uri)) : blocked();
}
