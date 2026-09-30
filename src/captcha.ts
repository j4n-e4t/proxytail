import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { captchas, hosts, settings, type Captcha, type CaptchaProvider } from "./db";

/**
 * Captchas in front of services, with Cloudflare Turnstile or hCaptcha. Traefik asks proxytail about every request to
 * a service with a captcha (a forwardAuth middleware), and proxytail answers:
 *
 * - with 200, which lets the request through, when it carries a valid clearance cookie;
 * - with a challenge page (403) otherwise. The visitor solves the captcha there, and the page sends the token to
 *   CAPTCHA_PATH on the service's own hostname. That request reaches proxytail through forwardAuth as well: proxytail
 *   checks the token with the provider, sets the clearance cookie and redirects back (303).
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

interface ProviderInfo {
  label: string;
  verifyUrl: string;
  script: string;
  /** Class of the widget's element, which renders it without further script. */
  widgetClass: string;
  /** Form field the widget puts its token in. */
  tokenField: string;
  /** Where the page may load scripts, frames and styles from, for its CSP. */
  origins: string[];
  /** The providers' test secrets, which accept dummy tokens from any hostname. */
  testSecrets: RegExp;
}

export const PROVIDERS: Record<CaptchaProvider, ProviderInfo> = {
  turnstile: {
    label: "Cloudflare Turnstile",
    verifyUrl: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    script: "https://challenges.cloudflare.com/turnstile/v0/api.js",
    widgetClass: "cf-turnstile",
    tokenField: "cf-turnstile-response",
    origins: ["https://challenges.cloudflare.com"],
    testSecrets: /^[123]x0{31}AA$/,
  },
  hcaptcha: {
    label: "hCaptcha",
    verifyUrl: "https://api.hcaptcha.com/siteverify",
    script: "https://js.hcaptcha.com/1/api.js",
    widgetClass: "h-captcha",
    tokenField: "h-captcha-response",
    origins: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
    testSecrets: /^0x0{40}$/,
  },
};

interface SiteverifyResult {
  success: boolean;
  hostname?: string;
  "error-codes"?: string[];
}

/** Asks the provider whether a token is valid. Throws if the provider can't be reached. */
async function siteverify(
  c: Pick<Captcha, "provider" | "siteKey" | "secretKey">,
  token: string,
  remoteIp?: string,
): Promise<SiteverifyResult> {
  const form = new URLSearchParams({ secret: c.secretKey, response: token });
  if (remoteIp) form.set("remoteip", remoteIp);
  // hCaptcha also checks that the site key belongs to the secret; Turnstile's secrets belong to one widget anyway.
  if (c.provider === "hcaptcha") form.set("sitekey", c.siteKey);
  const res = await fetch(PROVIDERS[c.provider].verifyUrl, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
  // Turnstile answers a wrong secret with 400 and the reason in the body, like any other failure.
  const result = (await res.json().catch(() => null)) as SiteverifyResult | null;
  if (typeof result?.success !== "boolean") throw new Error(`${PROVIDERS[c.provider].label} answered ${res.status}`);
  return result;
}

/**
 * Checks a secret key with the provider before it's saved, with a token that can't be valid: Turnstile then complains
 * about the secret if it's wrong, and about the token otherwise. hCaptcha only ever complains about the token, so a
 * wrong hCaptcha secret shows once someone solves the captcha. Returns why the key is rejected, or null.
 */
export async function checkSecretKey(c: Pick<Captcha, "provider" | "siteKey" | "secretKey">): Promise<string | null> {
  const label = PROVIDERS[c.provider].label;
  let result: SiteverifyResult;
  try {
    result = await siteverify(c, "proxytail-secret-key-check");
  } catch (e) {
    return `Couldn't reach ${label} to check the secret key: ${(e as Error).message}`;
  }
  const codes = result["error-codes"] ?? [];
  if (codes.includes("invalid-input-secret")) return `${label} doesn't accept this secret key`;
  if (codes.includes("sitekey-secret-mismatch")) return `The site key doesn't belong to this secret key's ${label} account`;
  if (codes.includes("invalid-sitekey")) return `${label} doesn't know this site key`;
  return null;
}

/** Messages for the challenge page, by the providers' error codes. */
function tokenError(codes: string[]) {
  if (codes.includes("timeout-or-duplicate") || codes.includes("expired-input-response") || codes.includes("already-seen-response"))
    return "The check expired. Please try again.";
  return "The check didn't pass. Please try again.";
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

/** The page visitors solve the captcha on. It's served in place of what they asked for, with status 403. */
function challengePage(c: Captcha, hostname: string, returnTo: string, error?: string) {
  const p = PROVIDERS[c.provider];
  const nonce = randomBytes(16).toString("base64");
  const origins = p.origins.join(" ");
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${origins}`,
    `frame-src ${origins}`,
    `connect-src ${origins}`,
    `style-src 'unsafe-inline' ${origins}`,
    "img-src data:",
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
<title>Just a moment…</title>
<style>
  :root { color-scheme: light dark; --bg: #f8fafc; --card: #fff; --fg: #0f172a; --muted: #64748b; --border: #e2e8f0; --danger: #dc2626; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #020617; --card: #0f172a; --fg: #f1f5f9; --muted: #94a3b8; --border: #1e293b; --danger: #f87171; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px;
    background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 28px 24px; text-align: center; }
  h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
  p { margin: 0; color: var(--muted); }
  .host { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); overflow-wrap: anywhere; }
  .widget { margin-top: 20px; min-height: 78px; display: flex; justify-content: center; }
  .error { margin-top: 16px; color: var(--danger); }
</style>
</head>
<body>
<main>
  <h1>Checking that you're human</h1>
  <p><span class="host">${escapeHtml(hostname)}</span> asks you to complete a quick check before continuing.</p>
  <form id="captcha" method="get" action="${VERIFY_PATH}">
    <input type="hidden" name="return" value="${escapeHtml(returnTo)}">
    <div class="widget"><div class="${p.widgetClass}" data-sitekey="${escapeHtml(c.siteKey)}" data-callback="proxytailSolved"></div></div>
  </form>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
  <noscript><p class="error">Turn on JavaScript to continue.</p></noscript>
</main>
<script nonce="${nonce}">
  function proxytailSolved() { document.getElementById("captcha").submit(); }
  if (matchMedia("(prefers-color-scheme: dark)").matches)
    document.querySelector("[data-sitekey]").setAttribute("data-theme", "dark");
</script>
<script nonce="${nonce}" src="${p.script}" async defer></script>
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
      // The provider sees the origin, never the path and query the visitor asked for.
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
    const token = url.searchParams.get(PROVIDERS[c.provider].tokenField);
    if (!token) return challengePage(c, hostname, returnTo, "The check didn't complete. Please try again.");
    let result: SiteverifyResult;
    try {
      result = await siteverify(c, token, clientIp);
    } catch (e) {
      console.error(`Captcha for ${hostname}: ${(e as Error).message}`);
      return challengePage(c, hostname, returnTo, "The check couldn't be verified right now. Please try again in a moment.");
    }
    // A token solved on another site with the same widget doesn't count. The test secrets report a fixed hostname.
    const hostMatches =
      !result.hostname || result.hostname === hostname || PROVIDERS[c.provider].testSecrets.test(c.secretKey);
    if (!result.success || !hostMatches)
      return challengePage(c, hostname, returnTo, tokenError(result.success ? [] : (result["error-codes"] ?? [])));
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
  return wantsPage ? challengePage(c, hostname, safeReturn(uri)) : blocked();
}
