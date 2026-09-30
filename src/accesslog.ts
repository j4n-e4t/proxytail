import { stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { listEntries, RANGES, serviceTraffic, stats, where, type Filters, type Range } from "./accesslog-query";
import { countriesReady, countryOf, onCountriesLoaded } from "./countries";
import { dataDir, db, dbPath, settings } from "./db";

/**
 * Traefik's access log, as a request log in the UI. Traefik writes one JSON object per request to a file on a volume
 * it shares with proxytail. proxytail follows the file, stores each request in SQLite, and truncates the file once it
 * has read it past TRUNCATE_BYTES, since Traefik doesn't rotate it. Requests are kept for a number of days (Settings),
 * and at most MAX_ROWS of them.
 */
const LOG_PATH = process.env.ACCESS_LOG_PATH || join(dataDir, "traefik-logs", "access.log");
const TRUNCATE_BYTES = 16 * 1024 * 1024;
/** Read at most this much per pass, so a large backlog doesn't block the server. */
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = Number(process.env.ACCESS_LOG_MAX_ROWS) || 1_000_000;
const POLL_MS = 1000;
const PRUNE_MS = 10 * 60_000;
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * Each request is stored with only its time, client IP, target (the hostname, and the service it matched), status and
 * response time. Traefik is configured to write nothing else to its access log either (see docker-compose.yml). The
 * client's country is looked up in proxytail's own database (countries.ts): NULL until one is loaded, "" for addresses
 * without a country.
 */
const SCHEMA = `(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time INTEGER NOT NULL,
  client_ip TEXT NOT NULL,
  host TEXT NOT NULL,
  host_id INTEGER,
  status INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  country TEXT
)`;
db.run(`CREATE TABLE IF NOT EXISTS access_log ${SCHEMA}`);

// The first version also stored paths, methods, user agents and more: keep only the columns above, and vacuum so the
// dropped data doesn't linger in free pages.
const logColumns = db.query<{ name: string }, []>("PRAGMA table_info(access_log)").all().map((c) => c.name);
if (logColumns.includes("path")) {
  db.transaction(() => {
    db.run(`CREATE TABLE access_log_new ${SCHEMA}`);
    db.run(
      `INSERT INTO access_log_new (id, time, client_ip, host, host_id, status, duration_ms)
       SELECT id, time, client_ip, host, host_id, status, duration_ms FROM access_log`,
    );
    db.run("DROP TABLE access_log");
    db.run("ALTER TABLE access_log_new RENAME TO access_log");
  })();
  db.run("VACUUM");
  console.log("Reduced the request log to client IP, target, status, response time and time");
}
if (!db.query<{ name: string }, []>("PRAGMA table_info(access_log)").all().some((c) => c.name === "country"))
  db.run("ALTER TABLE access_log ADD COLUMN country TEXT");
db.run("CREATE INDEX IF NOT EXISTS access_log_time ON access_log (time)");
db.run("CREATE INDEX IF NOT EXISTS access_log_host_time ON access_log (host_id, time)");

/** A line of Traefik's JSON access log: the fields it's configured to keep. */
interface TraefikEntry {
  StartUTC?: string;
  RouterName?: string;
  ClientHost?: string;
  RequestHost?: string;
  DownstreamStatus?: number;
  Duration?: number;
}

// The service's router, or the one for its redirect aliases.
const ROUTER_RE = /^proxytail-host-(\d+)(?:-redirect)?@/;

const insert = db.query(
  `INSERT INTO access_log (time, client_ip, host, host_id, status, duration_ms, country)
   VALUES ($time, $client_ip, $host, $host_id, $status, $duration_ms, $country)`,
);

function toRow(e: TraefikEntry) {
  if (typeof e.DownstreamStatus !== "number" || !e.StartUTC) return null;
  const time = Date.parse(e.StartUTC);
  if (Number.isNaN(time)) return null;
  const hostId = e.RouterName?.match(ROUTER_RE)?.[1];
  const clientIp = e.ClientHost ?? "";
  return {
    time,
    client_ip: clientIp,
    host: e.RequestHost ?? "",
    host_id: hostId ? Number(hostId) : null,
    status: e.DownstreamStatus,
    duration_ms: (e.Duration ?? 0) / 1e6,
    country: countryOf(clientIp),
  };
}

const insertLines = db.transaction((lines: string[]) => {
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = toRow(JSON.parse(line));
      if (!row) continue;
      insert.run(row);
      n++;
    } catch {
      // A line that isn't JSON, e.g. from a text-format access log: skipped.
    }
  }
  return n;
});

/** Where reading left off. `ino` tells a truncated or replaced file from the same one. */
interface Cursor {
  ino: number;
  offset: number;
}

function loadCursor(): Cursor {
  try {
    return JSON.parse(settings.get("access_log_cursor") ?? "") as Cursor;
  } catch {
    return { ino: 0, offset: 0 };
  }
}

let cursor = loadCursor();
const tail: {
  state: "ok" | "missing" | "error";
  error?: string;
  size?: number;
  /** Set when the file can't be truncated, so it grows until something else rotates it. */
  truncateError?: string;
} = { state: "missing" };

const saveCursor = () => settings.set("access_log_cursor", JSON.stringify(cursor));

async function readNew() {
  let info;
  try {
    info = await stat(LOG_PATH);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    Object.assign(tail, code === "ENOENT" ? { state: "missing", error: undefined } : { state: "error", error: (e as Error).message });
    return;
  }
  // A new file, or the same file truncated: start from its beginning.
  if (info.ino !== cursor.ino || info.size < cursor.offset) cursor = { ino: info.ino, offset: 0 };
  Object.assign(tail, { state: "ok", error: undefined, size: info.size });
  if (info.size > cursor.offset) await readChunk(info.size);
  // Everything Traefik had written is stored: the file can start over.
  if (cursor.offset === info.size && info.size > TRUNCATE_BYTES) await truncateLog();
}

async function readChunk(size: number) {
  const end = Math.min(size, cursor.offset + CHUNK_BYTES);
  const bytes = new Uint8Array(await Bun.file(LOG_PATH).slice(cursor.offset, end).arrayBuffer());
  // Only whole lines: a line Traefik is still writing is read on the next pass.
  let last = bytes.lastIndexOf(10);
  if (last < 0) {
    if (bytes.length < CHUNK_BYTES) return;
    last = bytes.length - 1; // a line longer than a whole chunk: skipped
  }
  const lines = new TextDecoder().decode(bytes.subarray(0, last)).split("\n");
  insertLines(lines);
  cursor.offset += last + 1;
  saveCursor();
}

/**
 * Empties the file once it's been read. Traefik appends (O_APPEND), so it keeps writing at the new end. A line written
 * between the last read and the truncation is lost; with the file read every second, that's rare.
 */
async function truncateLog() {
  try {
    await truncate(LOG_PATH, 0);
    cursor.offset = 0;
    saveCursor();
    tail.truncateError = undefined;
  } catch (e) {
    if (!tail.truncateError) console.error(`Couldn't truncate ${LOG_PATH}: ${(e as Error).message}`);
    tail.truncateError = (e as Error).message;
  }
}

async function follow() {
  try {
    await readNew();
  } catch (e) {
    Object.assign(tail, { state: "error", error: (e as Error).message });
  }
  setTimeout(follow, POLL_MS).unref();
}

export function retentionDays() {
  const days = Number(settings.get("access_log_retention_days"));
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
}

export function setRetentionDays(days: number) {
  settings.set("access_log_retention_days", days === DEFAULT_RETENTION_DAYS ? null : String(days));
  prune();
}

function prune() {
  db.query("DELETE FROM access_log WHERE time < ?").run(Date.now() - retentionDays() * 86_400_000);
  const max = db.query<{ id: number | null }, []>("SELECT max(id) AS id FROM access_log").get()?.id;
  if (max) db.query("DELETE FROM access_log WHERE id <= ?").run(max - MAX_ROWS);
}

/**
 * Looks up the countries of requests stored while no country database was loaded, a batch at a time so the server
 * keeps answering meanwhile.
 */
const missingCountry = db.query<{ id: number; client_ip: string }, [number]>(
  "SELECT id, client_ip FROM access_log WHERE id > ? AND country IS NULL ORDER BY id LIMIT 5000",
);
const setCountry = db.query("UPDATE access_log SET country = ? WHERE id = ?");
const fillBatch = db.transaction((rows: { id: number; client_ip: string }[]) => {
  for (const r of rows) setCountry.run(countryOf(r.client_ip), r.id);
});
let filling = false;

function fillCountries(after = 0) {
  if (filling && !after) return;
  const rows = countriesReady() ? missingCountry.all(after) : [];
  filling = rows.length > 0;
  if (!filling) return;
  fillBatch(rows);
  setTimeout(() => fillCountries(rows.at(-1)!.id), 20).unref();
}

follow();
prune();
onCountriesLoaded(() => fillCountries());
setInterval(prune, PRUNE_MS).unref();

export function accessLogStatus() {
  const counts = db
    .query<{ entries: number; oldest: number | null; newest: number | null }, []>(
      "SELECT count(*) AS entries, min(time) AS oldest, max(time) AS newest FROM access_log",
    )
    .get()!;
  return { path: LOG_PATH, ...tail, ...counts, retentionDays: retentionDays() };
}

export const entries = (f: Filters, before: number | null, limit: number) => listEntries(db, f, before, limit);

// --- Stats, computed in a worker ---

type Stats = ReturnType<typeof stats>;
type Traffic = ReturnType<typeof serviceTraffic>;
/** What the worker computes: the Requests page's stats, or the Services list's traffic column. */
export type WorkerJob = { kind: "stats"; filters: Filters } | { kind: "traffic" };

/** How long a range's stats are reused: a week of requests takes a while to add up. */
const STATS_TTL: Record<Range, number> = { "1h": 2000, "24h": 10_000, "7d": 30_000 };
const TRAFFIC_TTL = 30_000;
const cache = new Map<string, { at: number; ttl: number; result: Promise<unknown> }>();
const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
let worker: Worker | null = null;
let nextId = 1;

function statsWorker() {
  if (worker) return worker;
  // A path relative to this file, which build.ts also compiles into the binary.
  const w = new Worker(new URL("./accesslog-worker.ts", import.meta.url).href);
  w.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    if (e.data.error !== undefined) p?.reject(new Error(e.data.error));
    else p?.resolve(e.data.result);
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message));
    pending.clear();
    worker = null;
  };
  return (worker = w);
}

/** Runs a job in the worker, sharing its result with every caller asking the same while it's fresh. */
function inWorker<T>(job: WorkerJob, ttl: number): Promise<T> {
  const key = JSON.stringify(job);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.result as Promise<T>;
  for (const [k, v] of cache) if (now - v.at > Math.max(v.ttl, 60_000)) cache.delete(k);
  const id = nextId++;
  const result = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
    statsWorker().postMessage({ id, dbPath, job });
  });
  result.catch(() => cache.delete(key));
  cache.set(key, { at: now, ttl, result });
  return result;
}

/** Stats for the filters on the Requests page. */
export function accessLogStats(f: Filters): Promise<Stats> {
  where(f); // validates, before anything reaches the worker
  return inWorker<Stats>({ kind: "stats", filters: f }, STATS_TTL[f.range]);
}

/** Each service's last 24 hours, for the Services list. */
export const serviceTrafficSummary = () => inWorker<Traffic>({ kind: "traffic" }, TRAFFIC_TTL);

export { FilterError, RANGES, type Filters, type Range } from "./accesslog-query";
