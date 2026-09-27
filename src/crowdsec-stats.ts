import { machineJson, machineRequest, readMetrics, CrowdsecError, type CrowdsecStatus } from "./crowdsec";
import { hosts } from "./db";

/** Statistics for the Security page, built from CrowdSec's local alerts (community blocklist entries excluded). */

export const RANGES = {
  "24h": { hours: 24, bucketHours: 1 },
  "7d": { hours: 24 * 7, bucketHours: 4 },
  "30d": { hours: 24 * 30, bucketHours: 24 },
} as const;
export type StatsRange = keyof typeof RANGES;

/** More alerts than this in a range are cut off (the newest are kept) and the stats say so. */
const ALERT_LIMIT = 5000;
const CACHE_MS = 10_000;

interface LapiDecision {
  id: number;
  type: string;
  scope: string;
  value: string;
  origin: string;
  scenario: string;
  /** Time left, as a Go duration ("3h59m48s"); negative once expired. */
  duration: string;
}

interface LapiAlert {
  id: number;
  scenario: string;
  events_count: number;
  start_at: string;
  created_at: string;
  source: { scope: string; value: string; ip?: string; cn?: string; as_name?: string; as_number?: string };
  decisions: LapiDecision[] | null;
  meta: { key: string; value: string }[] | null;
}

/** Milliseconds in a Go duration string such as "1h2m3.5s" or "-4m"; NaN if it isn't one. */
export function parseGoDuration(raw: string): number {
  const m = raw.match(/^(-)?((?:\d+(?:\.\d+)?(?:h|m|s|ms|us|µs|ns))+)$/);
  if (!m) return NaN;
  const unit: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 1e-3, µs: 1e-3, ns: 1e-6 };
  let ms = 0;
  for (const [, n, u] of m[2]!.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g)) ms += Number(n) * unit[u!]!;
  return m[1] ? -ms : ms;
}

/** A context value from an alert's meta: CrowdSec stores each as a JSON array of strings. */
function metaValues(a: LapiAlert, key: string): string[] {
  const raw = a.meta?.find((m) => m.key === key)?.value;
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [String(v)];
  } catch {
    return [raw];
  }
}

export interface AlertView {
  id: number;
  at: string;
  ip: string;
  country: string | null;
  as: string | null;
  scenario: string;
  events: number;
  /** Hostnames and paths the attacker requested (from the alert context). */
  hosts: string[];
  paths: string[];
  /** The service the first hostname belongs to. */
  serviceId: number | null;
  banned: boolean;
}

export interface BanView {
  decisionId: number;
  alertId: number;
  value: string;
  scope: string;
  type: string;
  origin: string;
  scenario: string;
  country: string | null;
  as: string | null;
  until: string;
  hosts: string[];
}

export interface Ranked {
  key: string;
  label: string;
  alerts: number;
  /** Distinct source IPs. */
  sources: number;
  /** For services: the proxytail service id, if the hostname still belongs to one. */
  serviceId?: number | null;
}

export interface CrowdsecStats {
  range: StatsRange;
  generatedAt: string;
  truncated: boolean;
  totals: { alerts: number; sources: number; countries: number; events: number };
  /** Alerts per bucket, oldest first; `start` is the bucket's start time. */
  timeline: { start: string; alerts: number; sources: number }[];
  bucketHours: number;
  scenarios: Ranked[];
  countries: Ranked[];
  networks: Ranked[];
  services: Ranked[];
  recent: AlertView[];
  bans: BanView[];
  metrics?: CrowdsecStatus["metrics"];
}

const sourceOf = (a: LapiAlert) => a.source.ip ?? a.source.value;
const asOf = (a: LapiAlert) => a.source.as_name || null;

function rank(
  alerts: LapiAlert[],
  keysOf: (a: LapiAlert) => string[],
  labelOf: (key: string) => string = (k) => k,
): Ranked[] {
  const map = new Map<string, { alerts: number; sources: Set<string> }>();
  for (const a of alerts)
    for (const key of new Set(keysOf(a))) {
      const entry = map.get(key) ?? { alerts: 0, sources: new Set<string>() };
      entry.alerts++;
      entry.sources.add(sourceOf(a));
      map.set(key, entry);
    }
  return [...map]
    .map(([key, v]) => ({ key, label: labelOf(key), alerts: v.alerts, sources: v.sources.size }))
    .sort((a, b) => b.alerts - a.alerts || a.label.localeCompare(b.label));
}

function serviceFinder() {
  const all = hosts.list();
  return (fqdn: string) => all.find((h) => h.domains.includes(fqdn.toLowerCase()))?.id ?? null;
}

async function build(range: StatsRange, utcOffsetMin: number): Promise<CrowdsecStats> {
  const { hours, bucketHours } = RANGES[range];
  const [alerts, active, metrics] = await Promise.all([
    machineJson<LapiAlert[] | null>(`/v1/alerts?since=${hours}h&include_capi=false&limit=${ALERT_LIMIT}`),
    machineJson<LapiAlert[] | null>(`/v1/alerts?has_active_decision=true&include_capi=false&limit=${ALERT_LIMIT}`),
    readMetrics(),
  ]).then(([a, b, m]) => [a ?? [], b ?? [], m] as const);
  const now = Date.now();
  const serviceOf = serviceFinder();

  // Buckets end with the current one, aligned to the viewer's local midnight.
  const bucketMs = bucketHours * 3_600_000;
  const count = hours / bucketHours;
  const offsetMs = utcOffsetMin * 60_000;
  const lastStart = Math.floor((now + offsetMs) / bucketMs) * bucketMs - offsetMs;
  const firstStart = lastStart - (count - 1) * bucketMs;
  const buckets = Array.from({ length: count }, () => ({ alerts: 0, sources: new Set<string>() }));
  for (const a of alerts) {
    const i = Math.floor((new Date(a.start_at).getTime() - firstStart) / bucketMs);
    if (i < 0 || i >= count) continue;
    buckets[i]!.alerts++;
    buckets[i]!.sources.add(sourceOf(a));
  }

  const bans: BanView[] = [];
  for (const a of active)
    for (const d of a.decisions ?? []) {
      const left = parseGoDuration(d.duration);
      if (!(left > 0)) continue;
      bans.push({
        decisionId: d.id,
        alertId: a.id,
        value: d.value,
        scope: d.scope,
        type: d.type,
        origin: d.origin,
        scenario: d.scenario,
        country: a.source.cn || null,
        as: asOf(a),
        until: new Date(now + left).toISOString(),
        hosts: metaValues(a, "target_fqdn"),
      });
    }
  bans.sort((a, b) => b.until.localeCompare(a.until));
  const bannedValues = new Set(bans.map((b) => b.value));

  const byTime = [...alerts].sort((a, b) => b.start_at.localeCompare(a.start_at));
  const services = rank(alerts, (a) => metaValues(a, "target_fqdn")).map((r) => ({
    ...r,
    serviceId: serviceOf(r.key),
  }));

  return {
    range,
    generatedAt: new Date(now).toISOString(),
    truncated: alerts.length >= ALERT_LIMIT,
    totals: {
      alerts: alerts.length,
      sources: new Set(alerts.map(sourceOf)).size,
      countries: new Set(alerts.map((a) => a.source.cn).filter(Boolean)).size,
      events: alerts.reduce((n, a) => n + (a.events_count ?? 0), 0),
    },
    timeline: buckets.map((b, i) => ({
      start: new Date(firstStart + i * bucketMs).toISOString(),
      alerts: b.alerts,
      sources: b.sources.size,
    })),
    bucketHours,
    scenarios: rank(alerts, (a) => [a.scenario]).slice(0, 8),
    countries: rank(alerts, (a) => (a.source.cn ? [a.source.cn] : [])).slice(0, 8),
    networks: rank(alerts, (a) => (asOf(a) ? [`${a.source.as_number ?? ""}|${asOf(a)}`] : []), (k) => k.split("|")[1]!)
      .slice(0, 8)
      .map((r) => ({ ...r, key: r.key.split("|")[0] || r.label })),
    services: services.slice(0, 8),
    recent: byTime.slice(0, 50).map((a) => {
      const fqdns = metaValues(a, "target_fqdn");
      return {
        id: a.id,
        at: a.start_at,
        ip: sourceOf(a),
        country: a.source.cn || null,
        as: asOf(a),
        scenario: a.scenario,
        events: a.events_count,
        hosts: fqdns,
        paths: metaValues(a, "target_uri").slice(0, 5),
        serviceId: fqdns[0] ? serviceOf(fqdns[0]) : null,
        banned: bannedValues.has(sourceOf(a)),
      };
    }),
    bans,
    metrics,
  };
}

const cache = new Map<string, { at: number; stats: Promise<CrowdsecStats> }>();

/** `utcOffsetMin`: the viewer's offset from UTC in minutes (+120 for UTC+2), which buckets align to. */
export function crowdsecStats(range: StatsRange, utcOffsetMin = 0, fresh = false): Promise<CrowdsecStats> {
  const key = `${range}|${utcOffsetMin}`;
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.stats;
  const stats = build(range, utcOffsetMin);
  cache.set(key, { at: Date.now(), stats });
  stats.catch(() => cache.delete(key));
  return stats;
}

/** Lifts a ban. Deleting a decision needs a machine, which is why the bouncer key isn't enough. */
export async function deleteDecision(id: number) {
  const res = await machineRequest(`/v1/decisions/${id}`, { method: "DELETE" });
  if (res.status === 404) throw new CrowdsecError("That ban no longer exists", 404);
  if (!res.ok) throw new CrowdsecError(`CrowdSec couldn't lift the ban (status ${res.status})`);
  cache.clear();
}
