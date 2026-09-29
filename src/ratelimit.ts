import { connect } from "node:net";
import { settings } from "./db";

/**
 * Per-client-IP rate limiting with Traefik's rateLimit middleware. Every service gets its own middleware, so a client
 * has a separate budget for each service. Traefik keeps the token buckets either in its own memory or in Valkey:
 *
 * - `memory`: nothing else to run, but the buckets reset whenever Traefik reloads its configuration, which happens on
 *   every change in proxytail, and on restart.
 * - `valkey`: the buckets live in the Valkey container and survive reloads and restarts. Traefik answers 500 to every
 *   request while it can't reach Valkey, so proxytail checks Valkey itself and falls back to `memory` while it's down.
 */
const VALKEY_ADDR = process.env.VALKEY_ADDR || "localhost:6379";
/** How Traefik reaches Valkey, from inside its container. */
const TRAEFIK_VALKEY_ADDR = process.env.VALKEY_TRAEFIK_ADDR || "valkey:6379";
const HEALTH_INTERVAL_MS = 5000;

export type RateLimitStore = "memory" | "valkey";
export const PERIODS = { "1s": "second", "1m": "minute", "1h": "hour" } as const;
export type RateLimitPeriod = keyof typeof PERIODS;

export interface RateLimitConfig {
  enabled: boolean;
  store: RateLimitStore;
  /** Requests a client IP may make to one service per period, on average. */
  average: number;
  period: RateLimitPeriod;
  /** Requests a client IP may make at once, before the average applies. */
  burst: number;
}

export const DEFAULT_CONFIG: RateLimitConfig = { enabled: false, store: "memory", average: 20, period: "1s", burst: 100 };

export function rateLimitConfig(): RateLimitConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(settings.get("rate_limit") ?? "{}") };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveRateLimitConfig(c: RateLimitConfig) {
  settings.set("rate_limit", JSON.stringify(c));
  await checkValkey();
}

export interface ValkeyStatus {
  addr: string;
  reachable: boolean;
  /** "Valkey", or "Redis" for a Redis server at the same address. */
  server?: string;
  version?: string;
  /** Set when Valkey is unreachable or refuses commands, e.g. because it requires a password. */
  error?: string;
}

/** Asks Valkey for its version (`INFO server`) over a plain socket, so a dead server can't stall the caller. */
export function valkeyStatus(addr = VALKEY_ADDR, timeoutMs = 2000): Promise<ValkeyStatus> {
  const sep = addr.lastIndexOf(":");
  const host = addr.slice(0, sep).replace(/^\[|\]$/g, "");
  const port = Number(addr.slice(sep + 1));
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    const socket = connect({ host, port });
    const done = (s: Omit<ValkeyStatus, "addr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ addr, ...s });
    };
    const timer = setTimeout(() => done({ reachable: false, error: "Timed out" }), timeoutMs);
    socket.on("connect", () => socket.write("*2\r\n$4\r\nINFO\r\n$6\r\nserver\r\n"));
    socket.on("error", (e) => done({ reachable: false, error: e.message }));
    socket.on("close", () => done({ reachable: false, error: "Connection closed" }));
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const eol = buf.indexOf("\r\n");
      if (eol < 0) return;
      const head = buf.subarray(0, eol).toString();
      // An error reply, e.g. "-NOAUTH Authentication required."
      if (head.startsWith("-")) return done({ reachable: true, error: head.slice(1) });
      if (!head.startsWith("$")) return done({ reachable: true, error: "Unexpected reply" });
      const length = Number(head.slice(1));
      if (buf.length < eol + 2 + length) return;
      const info = buf.subarray(eol + 2, eol + 2 + length).toString();
      const valkey = info.match(/^valkey_version:(\S+)/m)?.[1];
      done({
        reachable: true,
        server: valkey ? "Valkey" : "Redis",
        version: valkey ?? info.match(/^redis_version:(\S+)/m)?.[1],
      });
    });
  });
}

/** The last health check, while Valkey is the configured store. */
let valkeyHealth: ValkeyStatus | null = null;

async function checkValkey() {
  const c = rateLimitConfig();
  if (!c.enabled || c.store !== "valkey") {
    valkeyHealth = null;
    return;
  }
  const s = await valkeyStatus();
  const wasUp = valkeyHealth ? valkeyHealth.reachable && !valkeyHealth.error : true;
  const up = s.reachable && !s.error;
  if (wasUp !== up)
    console.log(up ? "Valkey is back: rate limiting uses it again" : `Valkey is down (${s.error}): rate limiting falls back to Traefik's memory`);
  valkeyHealth = s;
}

await checkValkey();
setInterval(checkValkey, HEALTH_INTERVAL_MS).unref();

/** Where Traefik keeps the buckets right now: Valkey, unless it's configured but down. */
export function activeStore(c = rateLimitConfig()): RateLimitStore {
  return c.store === "valkey" && valkeyHealth?.reachable && !valkeyHealth.error ? "valkey" : "memory";
}

/** A rateLimit middleware for Traefik's dynamic configuration, or null while rate limiting is off. */
export function rateLimitMiddleware() {
  const c = rateLimitConfig();
  if (!c.enabled) return null;
  return {
    rateLimit: {
      average: c.average,
      period: c.period,
      burst: c.burst,
      // Without a source criterion, Traefik limits by the client's address. Traefik is exposed directly, so that's
      // the client IP.
      ...(activeStore(c) === "valkey" && { redis: { endpoints: [TRAEFIK_VALKEY_ADDR] } }),
    },
  };
}
