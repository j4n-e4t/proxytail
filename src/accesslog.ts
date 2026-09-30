import { stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { listEntries, RANGES, stats, where, type Filters, type Range } from "./accesslog-query";
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
 * response time. Traefik is configured to write nothing else to its access log either (see docker-compose.yml).
 */
const SCHEMA = `(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time INTEGER NOT NULL,
  client_ip TEXT NOT NULL,
  host TEXT NOT NULL,
  host_id INTEGER,
  status INTEGER NOT NULL,
  duration_ms REAL NOT NULL
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

const ROUTER_RE = /^proxytail-host-(\d+)@/;

const insert = db.query(
  `INSERT INTO access_log (time, client_ip, host, host_id, status, duration_ms)
   VALUES ($time, $client_ip, $host, $host_id, $status, $duration_ms)`,
);

function toRow(e: TraefikEntry) {
  if (typeof e.DownstreamStatus !== "number" || !e.StartUTC) return null;
  const time = Date.parse(e.StartUTC);
  if (Number.isNaN(time)) return null;
  const hostId = e.RouterName?.match(ROUTER_RE)?.[1];
  return {
    time,
    client_ip: e.ClientHost ?? "",
    host: e.RequestHost ?? "",
    host_id: hostId ? Number(hostId) : null,
    status: e.DownstreamStatus,
    duration_ms: (e.Duration ?? 0) / 1e6,
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

follow();
prune();
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
/** How long a range's stats are reused: a week of requests takes a while to add up. */
const STATS_TTL: Record<Range, number> = { "1h": 2000, "24h": 10_000, "7d": 30_000 };
const statsCache = new Map<string, { at: number; stats: Promise<Stats> }>();
const pending = new Map<number, { resolve: (s: Stats) => void; reject: (e: Error) => void }>();
let worker: Worker | null = null;
let nextId = 1;

function statsWorker() {
  if (worker) return worker;
  // A path relative to this file, which build.ts also compiles into the binary.
  const w = new Worker(new URL("./accesslog-worker.ts", import.meta.url).href);
  w.onmessage = (e: MessageEvent<{ id: number; result?: Stats; error?: string }>) => {
    const p = pending.get(e.data.id);
    pending.delete(e.data.id);
    if (e.data.error !== undefined) p?.reject(new Error(e.data.error));
    else p?.resolve(e.data.result!);
  };
  w.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message));
    pending.clear();
    worker = null;
  };
  return (worker = w);
}

/** Stats for the filters, shared by every request for the same filters while fresh. */
export function accessLogStats(f: Filters): Promise<Stats> {
  where(f); // validates, before anything reaches the worker
  const key = JSON.stringify(f);
  const now = Date.now();
  const hit = statsCache.get(key);
  if (hit && now - hit.at < STATS_TTL[f.range]) return hit.stats;
  for (const [k, v] of statsCache) if (now - v.at > 60_000) statsCache.delete(k);
  const id = nextId++;
  const result = new Promise<Stats>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    statsWorker().postMessage({ id, dbPath, filters: f });
  });
  result.catch(() => statsCache.delete(key));
  statsCache.set(key, { at: now, stats: result });
  return result;
}

export { FilterError, RANGES, type Filters, type Range } from "./accesslog-query";
