import type { Database } from "bun:sqlite";

/**
 * Queries behind the Requests page. They take the database as an argument: the stats run in a worker
 * (accesslog-worker.ts) with its own read-only connection, so a week of requests doesn't block the server.
 */
export const RANGES = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 } as const;
export type Range = keyof typeof RANGES;
/** Bucket width of each range's timeline: 60, 96 and 84 bars. */
const BUCKETS: Record<Range, number> = { "1h": 60_000, "24h": 15 * 60_000, "7d": 2 * 3_600_000 };

export interface Filters {
  range: Range;
  /** A service id, or "none" for requests no service matched. */
  service?: string;
  /** "2xx" … "5xx", or an exact status code. */
  status?: string;
  ip?: string;
  /** A country code, or "unknown" for addresses without one. */
  country?: string;
  /** Searched in the hostname and client IP. */
  q?: string;
}

export class FilterError extends Error {}

/** The WHERE clause for the filters; throws FilterError for invalid ones. */
export function where(f: Filters) {
  const clauses = ["time >= $since"];
  const params: Record<string, string | number> = { since: Date.now() - RANGES[f.range] };
  if (f.service === "none") clauses.push("host_id IS NULL");
  else if (f.service) {
    if (!/^\d+$/.test(f.service)) throw new FilterError("Invalid service");
    clauses.push("host_id = $service");
    params.service = Number(f.service);
  }
  if (f.status) {
    const cls = f.status.match(/^([1-5])xx$/);
    if (cls) {
      clauses.push("status BETWEEN $statusFrom AND $statusTo");
      params.statusFrom = Number(cls[1]) * 100;
      params.statusTo = Number(cls[1]) * 100 + 99;
    } else if (/^\d{3}$/.test(f.status)) {
      clauses.push("status = $status");
      params.status = Number(f.status);
    } else throw new FilterError("Status must be a class like 4xx or a code like 404");
  }
  if (f.ip) {
    clauses.push("client_ip = $ip");
    params.ip = f.ip;
  }
  if (f.country === "unknown") clauses.push("(country IS NULL OR country = '')");
  else if (f.country) {
    if (!/^[A-Z]{2}$/.test(f.country)) throw new FilterError("Country must be a two-letter code like DE");
    clauses.push("country = $country");
    params.country = f.country;
  }
  if (f.q) {
    clauses.push(
      "(host LIKE $q ESCAPE '\\' OR client_ip LIKE $q ESCAPE '\\')",
    );
    params.q = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  return { sql: clauses.join(" AND "), params };
}

interface Row {
  id: number;
  time: number;
  client_ip: string;
  host: string;
  host_id: number | null;
  status: number;
  duration_ms: number;
  country: string | null;
}

const toEntry = (r: Row) => ({
  id: r.id,
  time: new Date(r.time).toISOString(),
  clientIp: r.client_ip,
  host: r.host,
  serviceId: r.host_id,
  status: r.status,
  durationMs: r.duration_ms,
  country: r.country || null,
});

/** The newest requests matching the filters, before the `before` id when paging. */
export function listEntries(db: Database, f: Filters, before: number | null, limit: number) {
  const w = where(f);
  if (before) {
    w.sql += " AND id < $before";
    w.params.before = before;
  }
  const rows = db
    .query<Row, any>(`SELECT * FROM access_log WHERE ${w.sql} ORDER BY id DESC LIMIT ${limit + 1}`)
    .all(w.params);
  return { entries: rows.slice(0, limit).map(toEntry), hasMore: rows.length > limit };
}

const BINS_PER_E = 20;

export function stats(db: Database, f: Filters) {
  const w = where(f);
  const q = <T>(sql: string) => db.query<T, any>(sql);
  const totals = q<{ requests: number; clients: number; countries: number; clientErrors: number; serverErrors: number }>(
    `SELECT count(*) AS requests, count(DISTINCT client_ip) AS clients, count(DISTINCT nullif(country, '')) AS countries,
       coalesce(sum(status BETWEEN 400 AND 499), 0) AS clientErrors,
       coalesce(sum(status >= 500), 0) AS serverErrors
     FROM access_log WHERE ${w.sql}`,
  ).get(w.params)!;
  // Percentiles from a histogram of log-scaled durations (5% wide bins), rather than sorting every request.
  const bins = q<{ b: number; n: number }>(
    `SELECT CAST(round(ln(duration_ms + 0.001) * ${BINS_PER_E}) AS INT) AS b, count(*) AS n
     FROM access_log WHERE ${w.sql} GROUP BY b ORDER BY b`,
  ).all(w.params);
  const percentile = (p: number) => {
    let seen = 0;
    for (const { b, n } of bins) if ((seen += n) > totals.requests * p) return Math.exp(b / BINS_PER_E) - 0.001;
    return null;
  };

  const bucket = BUCKETS[f.range];
  const now = Date.now();
  // The first bucket is partly before the range.
  const first = Math.floor((now - RANGES[f.range]) / bucket) * bucket;
  const timeline = new Map<number, { start: string; "2xx": number; "3xx": number; "4xx": number; "5xx": number }>();
  for (let t = first; t <= now; t += bucket)
    timeline.set(t, { start: new Date(t).toISOString(), "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 });
  const grouped = q<{ t: number; cls: number; n: number }>(
    `SELECT (time / ${bucket}) * ${bucket} AS t, status / 100 AS cls, count(*) AS n
     FROM access_log WHERE ${w.sql} GROUP BY t, cls`,
  ).all(w.params);
  for (const g of grouped) {
    const b = timeline.get(g.t);
    // 1xx (e.g. WebSocket upgrades) counts as 2xx.
    const key = `${Math.min(Math.max(g.cls, 2), 5)}xx` as "2xx";
    if (b) b[key] += g.n;
  }

  const top = (expr: string) =>
    q<{ key: string | number | null; requests: number; errors: number }>(
      `SELECT ${expr} AS key, count(*) AS requests, coalesce(sum(status >= 400), 0) AS errors
       FROM access_log WHERE ${w.sql} GROUP BY key ORDER BY requests DESC LIMIT 8`,
    ).all(w.params);

  return {
    range: f.range,
    bucketMs: bucket,
    totals: { ...totals, p50Ms: percentile(0.5), p95Ms: percentile(0.95) },
    timeline: [...timeline.values()],
    services: top("host_id"),
    hosts: top("host"),
    clients: top("client_ip"),
    // Unknown and not looked up yet are one entry.
    countries: top("nullif(country, '')"),
    statuses: q<{ status: number; requests: number }>(
      `SELECT status, count(*) AS requests FROM access_log WHERE ${w.sql} GROUP BY status ORDER BY requests DESC LIMIT 8`,
    ).all(w.params),
  };
}

/** The Services list's traffic column: each service's last 24 hours, in hourly buckets. */
export function serviceTraffic(db: Database) {
  const hour = 3_600_000;
  // 24 buckets, the last one being the current hour.
  const first = Math.floor(Date.now() / hour) * hour - 23 * hour;
  const params = { since: first };
  const q = <T>(sql: string) => db.query<T, any>(sql).all(params);

  const services = new Map<
    number,
    { requests: number; clientErrors: number; serverErrors: number; hourly: number[]; lastRequest: string | null; p95Ms: number | null }
  >();
  const service = (id: number) => {
    let s = services.get(id);
    if (!s) services.set(id, (s = { requests: 0, clientErrors: 0, serverErrors: 0, hourly: Array(24).fill(0), lastRequest: null, p95Ms: null }));
    return s;
  };

  for (const r of q<{ id: number; t: number; n: number; c4: number; c5: number }>(
    `SELECT host_id AS id, (time / ${hour}) * ${hour} AS t, count(*) AS n,
       sum(status BETWEEN 400 AND 499) AS c4, sum(status >= 500) AS c5
     FROM access_log WHERE time >= $since AND host_id IS NOT NULL GROUP BY id, t`,
  )) {
    const s = service(r.id);
    s.requests += r.n;
    s.clientErrors += r.c4;
    s.serverErrors += r.c5;
    const i = (r.t - first) / hour;
    if (i >= 0 && i < 24) s.hourly[i] = (s.hourly[i] ?? 0) + r.n;
  }

  // p95 per service, from the same log-scaled histogram as the Requests page.
  const bins = q<{ id: number; b: number; n: number }>(
    `SELECT host_id AS id, CAST(round(ln(duration_ms + 0.001) * ${BINS_PER_E}) AS INT) AS b, count(*) AS n
     FROM access_log WHERE time >= $since AND host_id IS NOT NULL GROUP BY id, b ORDER BY id, b`,
  );
  const seen = new Map<number, number>();
  for (const { id, b, n } of bins) {
    const s = service(id);
    const total = (seen.get(id) ?? 0) + n;
    seen.set(id, total);
    if (s.p95Ms === null && total > s.requests * 0.95) s.p95Ms = Math.exp(b / BINS_PER_E) - 0.001;
  }

  // Also for services without requests today, so a quiet service shows when it was last used.
  for (const r of db
    .query<{ id: number; last: number }, []>(
      "SELECT host_id AS id, max(time) AS last FROM access_log WHERE host_id IS NOT NULL GROUP BY host_id",
    )
    .all())
    service(r.id).lastRequest = new Date(r.last).toISOString();

  return { hourStart: new Date(first).toISOString(), services: Object.fromEntries(services) };
}
