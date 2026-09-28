import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir, settings } from "./db";

/**
 * CrowdSec reads Traefik's access log and runs the Local API (LAPI); Traefik's bouncer plugin asks LAPI about every
 * client IP ("live" mode, with a short cache). Live mode fails closed: while LAPI is unreachable, every request that
 * isn't cached as clean is blocked.
 *
 * proxytail generates two secrets in a directory that CrowdSec and Traefik mount at /run/secrets:
 * - `bouncer_key_traefik`: CrowdSec registers it on start as the bouncer "traefik"; Traefik's plugin reads it.
 * - `registration_token`: CrowdSec's auto-registration token, which proxytail uses to register itself as a machine.
 *   Machines can read alerts, which the Security page is built from, and delete decisions.
 */
const LAPI_URL = process.env.CROWDSEC_LAPI_URL ?? "http://localhost:8081";
const METRICS_URL = process.env.CROWDSEC_METRICS_URL ?? "http://localhost:6060/metrics";
const SECRETS_DIR = process.env.CROWDSEC_SECRETS_DIR ?? join(dataDir, "crowdsec");
/** How Traefik reaches LAPI and the key, from inside its container. */
const TRAEFIK_LAPI_HOST = process.env.CROWDSEC_TRAEFIK_LAPI_HOST ?? "crowdsec:8080";
const TRAEFIK_KEY_FILE = "/run/secrets/bouncer_key_traefik";
/** The plugin name in Traefik's static configuration (`--experimental.plugins.crowdsec...`). */
const PLUGIN = "crowdsec";

export const MIDDLEWARE = "proxytail-crowdsec";
export const DEFAULT_CACHE_SECONDS = 60;

/** Secrets are created once and never rotated: CrowdSec only registers a bouncer name that it doesn't know yet. */
async function loadSecret(name: string): Promise<string | null> {
  const path = join(SECRETS_DIR, name);
  try {
    const file = Bun.file(path);
    if (await file.exists()) return (await file.text()).trim() || null;
    const secret = randomBytes(32).toString("base64url");
    mkdirSync(SECRETS_DIR, { recursive: true });
    await Bun.write(path, secret);
    // Traefik and CrowdSec run as root without CAP_DAC_OVERRIDE, and the file belongs to proxytail's user.
    chmodSync(path, 0o644);
    console.log(`Created ${path}`);
    return secret;
  } catch (e) {
    console.error(`Couldn't load the CrowdSec secret ${path}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * CrowdSec is opt-in (CROWDSEC_ENABLED): without it, proxytail creates no secrets, never adds the bouncer to Traefik
 * (whose static configuration then lacks the plugin), and the UI leaves CrowdSec out.
 */
export const crowdsecIntegration = /^(1|true|yes|on)$/i.test(process.env.CROWDSEC_ENABLED?.trim() ?? "");

const bouncerKey = crowdsecIntegration ? await loadSecret("bouncer_key_traefik") : null;
const registrationToken = crowdsecIntegration ? await loadSecret("registration_token") : null;

export interface CrowdsecConfig {
  /** Traefik blocks IPs CrowdSec has a decision for, on every service. */
  enabled: boolean;
  /** How long Traefik caches that an IP isn't banned before asking LAPI again. */
  cacheSeconds: number;
  /** IPs and CIDR ranges that are never checked. */
  trustedIps: string[];
}

export function crowdsecConfig(): CrowdsecConfig {
  const cache = Number(settings.get("crowdsec_cache_seconds"));
  return {
    enabled: settings.get("crowdsec_enabled") === "1",
    cacheSeconds: Number.isInteger(cache) && cache > 0 ? cache : DEFAULT_CACHE_SECONDS,
    trustedIps: JSON.parse(settings.get("crowdsec_trusted_ips") ?? "[]"),
  };
}

export function saveCrowdsecConfig(c: CrowdsecConfig) {
  settings.set("crowdsec_enabled", c.enabled ? "1" : null);
  settings.set("crowdsec_cache_seconds", c.cacheSeconds === DEFAULT_CACHE_SECONDS ? null : String(c.cacheSeconds));
  settings.set("crowdsec_trusted_ips", c.trustedIps.length ? JSON.stringify(c.trustedIps) : null);
}

/** The bouncer middleware for Traefik's dynamic configuration, or null while it's off. */
export function bouncerMiddleware() {
  const c = crowdsecConfig();
  // Blocking may have been turned on while the integration was, and stays saved while it's off.
  if (!crowdsecIntegration || !c.enabled) return null;
  return {
    plugin: {
      [PLUGIN]: {
        enabled: true,
        crowdsecMode: "live",
        crowdsecLapiScheme: "http",
        crowdsecLapiHost: TRAEFIK_LAPI_HOST,
        // A file rather than the key itself: Traefik's API shows middleware options to anyone on the Docker network.
        crowdsecLapiKeyFile: TRAEFIK_KEY_FILE,
        defaultDecisionSeconds: c.cacheSeconds,
        ...(c.trustedIps.length && { clientTrustedIps: c.trustedIps }),
      },
    },
  };
}

export interface CrowdsecStatus {
  /** proxytail has a bouncer key to share with CrowdSec and Traefik. */
  key: boolean;
  lapi: { reachable: boolean; keyAccepted?: boolean; error?: string };
  /** From CrowdSec's Prometheus endpoint; absent when it can't be reached. */
  metrics?: {
    version?: string;
    /** Access log lines read, and how many of them parsed. */
    linesRead: number;
    linesParsed: number;
    /** Active decisions by origin: "crowdsec" (local detections), "cscli", "CAPI" (community blocklist), "lists". */
    decisions: Record<string, number>;
  };
}

async function checkLapi(): Promise<CrowdsecStatus["lapi"]> {
  try {
    // A bouncer's only read: the decisions for an address that never has one.
    const res = await fetch(`${LAPI_URL}/v1/decisions?ip=127.0.0.1`, {
      headers: { "X-Api-Key": bouncerKey ?? "" },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return { reachable: true, keyAccepted: true };
    if (res.status === 403) return { reachable: true, keyAccepted: false };
    return { reachable: true, error: `LAPI returned ${res.status}` };
  } catch (e) {
    return { reachable: false, error: (e as Error).message };
  }
}

/** Sums the samples of each metric in Prometheus' text format, optionally split by one label. */
function sumMetric(text: string, name: string, by?: string) {
  const totals: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line.startsWith(name) || (line[name.length] !== "{" && line[name.length] !== " ")) continue;
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    const key = by ? (line.match(new RegExp(`[{,]${by}="([^"]*)"`))?.[1] ?? "") : "";
    totals[key] = (totals[key] ?? 0) + value;
  }
  return totals;
}

export async function readMetrics(): Promise<CrowdsecStatus["metrics"]> {
  try {
    const res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    const text = await res.text();
    return {
      version: text.match(/^cs_info\{version="v?([^"-]+)/m)?.[1],
      linesRead: sumMetric(text, "cs_filesource_hits_total")[""] ?? 0,
      linesParsed: sumMetric(text, "cs_parser_hits_ok_total")[""] ?? 0,
      decisions: sumMetric(text, "cs_active_decisions", "origin"),
    };
  } catch {
    return undefined;
  }
}

export async function crowdsecStatus(): Promise<CrowdsecStatus> {
  const [lapi, metrics] = await Promise.all([checkLapi(), readMetrics()]);
  return { key: !!bouncerKey, lapi, metrics };
}

export class CrowdsecError extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

/** proxytail's machine account. The id is random, so a new proxytail database never collides with an old machine. */
function machineCredentials() {
  let id = settings.get("crowdsec_machine_id");
  let password = settings.get("crowdsec_machine_password");
  if (!id || !password) {
    id = `proxytail-${randomBytes(4).toString("hex")}`;
    password = randomBytes(32).toString("base64url");
    settings.set("crowdsec_machine_id", id);
    settings.set("crowdsec_machine_password", password);
  }
  return { id, password };
}

async function lapi(path: string, init: RequestInit = {}) {
  try {
    return await fetch(`${LAPI_URL}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
  } catch (e) {
    throw new CrowdsecError(`CrowdSec is unreachable: ${(e as Error).message}`);
  }
}

const message = async (res: Response) =>
  ((await res.json().catch(() => ({}))) as { message?: string }).message ?? `status ${res.status}`;

async function login(id: string, password: string) {
  return lapi("/v1/watchers/login", {
    method: "POST",
    body: JSON.stringify({ machine_id: id, password, scenarios: [] }),
  });
}

let session: { token: string; expires: number } | null = null;
let pending: Promise<string> | null = null;

/** A JWT for proxytail's machine. Concurrent callers share one login, so they never register twice. */
function machineToken(): Promise<string> {
  if (session && session.expires > Date.now()) return Promise.resolve(session.token);
  pending ??= newSession().finally(() => (pending = null));
  return pending;
}

/** Logs in, registering the machine through CrowdSec's auto-registration on first use. */
async function newSession(): Promise<string> {
  const { id, password } = machineCredentials();
  let res = await login(id, password);
  if (res.status === 401 || res.status === 403) {
    if (!registrationToken) throw new CrowdsecError("proxytail has no CrowdSec registration token");
    const reg = await lapi("/v1/watchers", {
      method: "POST",
      body: JSON.stringify({ machine_id: id, password, registration_token: registrationToken }),
    });
    // 202: registered and validated. 201 would mean registered but waiting for `cscli machines validate`.
    if (reg.status === 201)
      throw new CrowdsecError(`CrowdSec registered ${id} without validating it. Run cscli machines validate ${id}.`);
    if (!reg.ok) throw new CrowdsecError(`CrowdSec refused to register proxytail: ${await message(reg)}`);
    console.log(`Registered with CrowdSec as machine ${id}`);
    res = await login(id, password);
  }
  if (!res.ok) throw new CrowdsecError(`CrowdSec rejected proxytail's login: ${await message(res)}`);
  const { token, expire } = (await res.json()) as { token: string; expire: string };
  session = { token, expires: Math.min(new Date(expire).getTime() - 60_000, Date.now() + 30 * 60_000) };
  return token;
}

/** A request to LAPI as proxytail's machine. */
export async function machineRequest(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await lapi(path, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${await machineToken()}` },
    });
    if (res.status !== 401 || attempt) return res;
    session = null;
  }
}

export async function machineJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await machineRequest(path, init);
  if (!res.ok) throw new CrowdsecError(`CrowdSec returned an error: ${await message(res)}`);
  return (await res.json()) as T;
}
