import { useCallback, useEffect, useMemo, useState } from "react";
import { FileWarning, Loader2, RefreshCw, Search, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { classColor, RequestTimeline, statusClass, TimelineLegend } from "@/components/request-timeline";
import { usePoll } from "@/hooks/use-poll";
import {
  api,
  type AccessLogEntry,
  type AccessLogFilters,
  type AccessLogRange,
  type AccessLogStats,
  type ProxyHost,
  type TopItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const LIVE_MS = 5000;
/** Stats over longer ranges take longer to add up, and change less from one refresh to the next. */
const STATS_LIVE_MS: Record<AccessLogRange, number> = { "1h": 5000, "24h": 15_000, "7d": 60_000 };
const RANGES: { value: AccessLogRange; label: string }[] = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
];
const STATUSES = ["2xx", "3xx", "4xx", "5xx", "429"];

const fmt = new Intl.NumberFormat();

export function fmtDuration(ms: number | null) {
  if (ms === null) return "–";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

const pct = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(part && part < whole / 100 ? 2 : 1)}%` : "–");

const clock = (iso: string, withDate: boolean) =>
  new Date(iso).toLocaleString(undefined, {
    ...(withDate && { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** A status code with its class color as a marker; the code itself stays in text color. */
export function StatusCode({ status }: { status: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums">
      <span className="size-2 shrink-0 rounded-full" style={{ background: classColor(statusClass(status)) }} />
      {status}
    </span>
  );
}

function Tile(props: { label: string; value: string; detail?: string }) {
  return (
    <Card className="gap-1 px-4 py-3">
      <p className="text-xs text-muted-foreground">{props.label}</p>
      <p className="text-xl font-semibold tabular-nums">{props.value}</p>
      <p className="h-4 truncate text-xs text-muted-foreground tabular-nums">{props.detail}</p>
    </Card>
  );
}

/** A ranked list; each row filters the page by its key. */
function TopList(props: {
  title: string;
  items: TopItem[] | undefined;
  label: (key: TopItem["key"]) => React.ReactNode;
  onPick: (key: TopItem["key"]) => void;
  mono?: boolean;
}) {
  const max = Math.max(1, ...(props.items ?? []).map((i) => i.requests));
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{props.title}</CardTitle>
      </CardHeader>
      <CardContent className="px-2">
        {!props.items ? (
          <Skeleton className="mx-2 h-32" />
        ) : !props.items.length ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing yet</p>
        ) : (
          <ul>
            {props.items.map((i) => (
              <li key={String(i.key)}>
                <button
                  onClick={() => props.onPick(i.key)}
                  className="group relative flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60"
                  title="Filter by this"
                >
                  <span
                    className="absolute inset-y-1 left-0 rounded-md bg-primary/8"
                    style={{ width: `${(i.requests / max) * 100}%` }}
                  />
                  <span className={cn("relative min-w-0 flex-1 truncate", props.mono && "font-mono text-xs")}>
                    {props.label(i.key)}
                  </span>
                  {i.errors > 0 && (
                    <span className="relative text-xs text-muted-foreground tabular-nums">{fmt.format(i.errors)} err</span>
                  )}
                  <span className="relative w-12 text-right tabular-nums">{fmt.format(i.requests)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function RequestsPage(props: { hosts: ProxyHost[]; initialService?: string }) {
  const [range, setRange] = useState<AccessLogRange>("24h");
  const [service, setService] = useState(props.initialService ?? "");
  const [status, setStatus] = useState("");
  const [ip, setIp] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [live, setLive] = useState(true);
  const [stats, setStats] = useState<AccessLogStats | null>(null);
  const [entries, setEntries] = useState<AccessLogEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logStatus = usePoll(api.accessLog, 30_000);

  // Typing searches after a pause, not on every key.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filters = useMemo<AccessLogFilters>(
    () => ({ range, service, status, ip, q }),
    [range, service, status, ip, q],
  );

  const names = useMemo(() => new Map(props.hosts.map((h) => [h.id, h.domains[0]!])), [props.hosts]);
  const serviceName = (id: TopItem["key"]) =>
    id === null ? "No service" : (names.get(Number(id)) ?? `Deleted service #${id}`);

  /** Refreshes the newest page, keeping older pages that were already loaded unless `reset`. */
  const refreshEntries = useCallback(
    async (reset: boolean) => {
      try {
        const page = await api.accessLogEntries(filters);
        setEntries((old) => {
          if (reset || !old) return page.entries;
          const oldest = page.entries.at(-1)?.id ?? Infinity;
          return [...page.entries, ...old.filter((e) => e.id < oldest)];
        });
        if (reset) setHasMore(page.hasMore);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [filters],
  );

  const refreshStats = useCallback(async () => {
    try {
      setStats(await api.accessLogStats(filters));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filters]);

  const reload = useCallback(() => Promise.all([refreshEntries(true), refreshStats()]), [refreshEntries, refreshStats]);

  useEffect(() => {
    setEntries(null);
    setStats(null);
    reload();
  }, [reload]);

  useEffect(() => {
    if (!live) return;
    const entriesTimer = setInterval(() => refreshEntries(false), LIVE_MS);
    const statsTimer = setInterval(refreshStats, STATS_LIVE_MS[range]);
    return () => {
      clearInterval(entriesTimer);
      clearInterval(statsTimer);
    };
  }, [live, range, refreshEntries, refreshStats]);

  const loadMore = async () => {
    if (!entries?.length) return;
    setLoadingMore(true);
    try {
      const page = await api.accessLogEntries(filters, entries.at(-1)!.id);
      setEntries([...entries, ...page.entries]);
      setHasMore(page.hasMore);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const t = stats?.totals;
  const filtered = !!(service || status || ip || q);
  const clear = () => {
    setService("");
    setStatus("");
    setIp("");
    setSearch("");
  };
  const withDate = range === "7d";

  return (
    <>
      <PageHeader title="Requests" description="Every request Traefik served, from its access log.">
        <div className="flex items-center gap-2 pr-2">
          <Switch id="requests-live" checked={live} onCheckedChange={setLive} />
          <Label htmlFor="requests-live" className="text-sm font-normal">
            Live
          </Label>
        </div>
        <Tabs value={range} onValueChange={(v) => setRange(v as AccessLogRange)}>
          <TabsList>
            {RANGES.map((r) => (
              <TabsTrigger key={r.value} value={r.value} className="text-xs">
                {r.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button variant="outline" size="icon" aria-label="Refresh" onClick={reload}>
          <RefreshCw />
        </Button>
      </PageHeader>

      {logStatus.data && logStatus.data.state !== "ok" && (
        <Alert className="mb-4">
          <FileWarning />
          <AlertTitle>
            {logStatus.data.state === "missing" ? "No access log yet" : "Can't read Traefik's access log"}
          </AlertTitle>
          <AlertDescription>
            <p>
              {logStatus.data.state === "missing" ? (
                <>
                  proxytail reads Traefik's JSON access log from{" "}
                  <code className="font-mono">{logStatus.data.path}</code>, which Traefik creates on its first request.
                  It must write it to the <code className="font-mono">traefik-logs</code> volume (see{" "}
                  <code className="font-mono">docker-compose.yml</code>).
                </>
              ) : (
                logStatus.data.error
              )}
            </p>
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Couldn't load requests</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Filters apply to everything below. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Hostname or client IP…"
            className="pl-8"
          />
        </div>
        <Select value={service || "all"} onValueChange={(v) => setService(v === "all" ? "" : v)}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All services</SelectItem>
            {props.hosts.map((h) => (
              <SelectItem key={h.id} value={String(h.id)}>
                {h.domains[0]}
              </SelectItem>
            ))}
            <SelectItem value="none">No service</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "429" ? "429 rate limited" : s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {ip && (
          <Button variant="secondary" size="sm" onClick={() => setIp("")} className="font-mono">
            {ip} <X />
          </Button>
        )}
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear filters
          </Button>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Tile label="Requests" value={t ? fmt.format(t.requests) : "–"} />
        <Tile label="Clients" value={t ? fmt.format(t.clients) : "–"} detail="distinct IPs" />
        <Tile
          label="Client errors"
          value={t ? pct(t.clientErrors, t.requests) : "–"}
          detail={t ? `${fmt.format(t.clientErrors)} × 4xx` : undefined}
        />
        <Tile
          label="Server errors"
          value={t ? pct(t.serverErrors, t.requests) : "–"}
          detail={t ? `${fmt.format(t.serverErrors)} × 5xx` : undefined}
        />
        <Tile
          label="Response time"
          value={t ? fmtDuration(t.p95Ms) : "–"}
          detail={t?.p50Ms != null ? `p95 · median ${fmtDuration(t.p50Ms)}` : "p95"}
        />
      </div>

      <Card className="mb-4 gap-4">
        <CardHeader>
          <CardTitle>Requests over time</CardTitle>
          <CardDescription>By status class. Hover a bar for its counts.</CardDescription>
          <CardAction>
            <TimelineLegend />
          </CardAction>
        </CardHeader>
        <CardContent className="pt-4">
          {stats ? <RequestTimeline stats={stats} /> : <Skeleton className="h-[180px]" />}
        </CardContent>
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <TopList
          title="Services"
          items={stats?.services}
          label={serviceName}
          onPick={(k) => setService(k === null ? "none" : String(k))}
        />
        <TopList title="Hostnames" items={stats?.hosts} label={(k) => k} onPick={(k) => setSearch(String(k))} mono />
        <TopList title="Clients" items={stats?.clients} label={(k) => k} onPick={(k) => setIp(String(k))} mono />
        <TopList
          title="Status codes"
          items={stats?.statuses.map((s) => ({ key: s.status, requests: s.requests, errors: 0 }))}
          label={(k) => <StatusCode status={Number(k)} />}
          onPick={(k) => setStatus(String(k))}
        />
      </div>

      <Card className="gap-0 py-0">
        {entries === null ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : !entries.length ? (
          <p className="px-6 py-16 text-center text-sm text-muted-foreground">
            {filtered ? "No requests match these filters." : "No requests in this period."}
          </p>
        ) : (
          <>
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-32 pl-4">Time</TableHead>
                  <TableHead className="w-24">Status</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead className="w-48">Client</TableHead>
                  <TableHead className="w-32 pr-4 text-right">Response time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="pl-4 text-xs text-muted-foreground tabular-nums">
                      {clock(e.time, withDate)}
                    </TableCell>
                    <TableCell>
                      <StatusCode status={e.status} />
                    </TableCell>
                    <TableCell className="min-w-0">
                      <p className="truncate">
                        <span className="font-mono text-xs">{e.host}</span>
                        {/* The service, when the hostname isn't its own primary one, or none matched. */}
                        {serviceName(e.serviceId) !== e.host && (
                          <span className="ml-2 text-xs text-muted-foreground">{serviceName(e.serviceId)}</span>
                        )}
                      </p>
                    </TableCell>
                    <TableCell>
                      <button
                        className="truncate font-mono text-xs hover:underline"
                        onClick={() => setIp(e.clientIp)}
                        title="Show only this client"
                      >
                        {e.clientIp}
                      </button>
                    </TableCell>
                    <TableCell className="pr-4 text-right text-xs tabular-nums">{fmtDuration(e.durationMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {hasMore && (
              <div className="flex justify-center border-t p-3">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore && <Loader2 className="animate-spin" />} Load older requests
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}
