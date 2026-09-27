import { useCallback, useState } from "react";
import { Loader2, RefreshCw, Settings as SettingsIcon, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageHeader } from "@/components/page-header";
import { usePoll } from "@/hooks/use-poll";
import { api, type CrowdsecStats, type CrowdsecView, type Ranked, type StatsRange } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";

export const RANGES: { value: StatsRange; label: string; long: string }[] = [
  { value: "24h", label: "24 hours", long: "the last 24 hours" },
  { value: "7d", label: "7 days", long: "the last 7 days" },
  { value: "30d", label: "30 days", long: "the last 30 days" },
];

const fmt = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const regionNames = new Intl.DisplayNames(undefined, { type: "region" });

function countryName(code: string) {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The flag emoji for an ISO 3166 country code. */
const flag = (code: string) =>
  /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "";

/** "crowdsecurity/http-probing" -> "http-probing"; the namespace is noise next to the name. */
const scenarioName = (s: string) => s.replace(/^crowdsecurity\//, "");

function timeUntil(iso: string) {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 60) return "in <1m";
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

function Stat(props: { label: string; value: number; detail?: React.ReactNode }) {
  return (
    <Card className="gap-1 py-5">
      <CardContent className="space-y-1 px-5">
        <p className="text-sm text-muted-foreground">{props.label}</p>
        <p className="text-3xl font-semibold tracking-tight" title={fmt.format(props.value)}>
          {props.value >= 10_000 ? compact.format(props.value) : fmt.format(props.value)}
        </p>
        {props.detail && <p className="text-xs text-muted-foreground">{props.detail}</p>}
      </CardContent>
    </Card>
  );
}

/** Clean y-axis ticks: a 1/2/5 step that fits the maximum in about four steps. */
function axis(max: number) {
  if (max <= 4) return { top: Math.max(max, 1), ticks: Array.from({ length: Math.max(max, 1) + 1 }, (_, i) => i) };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step) };
}

function bucketLabel(start: Date, hours: number) {
  const end = new Date(start.getTime() + hours * 3_600_000);
  if (hours >= 24) return start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const day = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time(start)}–${time(end)}`;
}

/** The x-axis label for a bucket, or null to leave it unlabeled. */
function tickLabel(start: Date, index: number, stats: CrowdsecStats) {
  const n = stats.timeline.length;
  if (stats.range === "24h")
    return index % 4 === 0 ? start.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : null;
  if (stats.range === "7d")
    // The first bucket of each local day.
    return start.getHours() < stats.bucketHours
      ? start.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })
      : null;
  return (n - 1 - index) % 5 === 0 ? start.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
}

function Timeline({ stats }: { stats: CrowdsecStats }) {
  const { top, ticks } = axis(Math.max(0, ...stats.timeline.map((b) => b.alerts)));
  return (
    <div className="flex gap-3">
      {/* Y axis */}
      <div className="relative h-48 w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {ticks.map((t) => (
          <span key={t} className="absolute right-0" style={{ bottom: `${(t / top) * 100}%`, transform: "translateY(50%)" }}>
            {fmt.format(t)}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative h-48">
          {ticks.map((t) => (
            <div key={t} className="absolute inset-x-0 border-t border-border" style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {stats.timeline.map((b) => {
              const start = new Date(b.start);
              return (
                <Tooltip key={b.start}>
                  <TooltipTrigger asChild>
                    {/* The whole column is the hit target, not just the painted bar. */}
                    <button
                      type="button"
                      className="group flex h-full min-w-0 flex-1 items-end justify-center outline-none"
                      aria-label={`${bucketLabel(start, stats.bucketHours)}: ${b.alerts} ${b.alerts === 1 ? "alert" : "alerts"}`}
                    >
                      <span
                        className={cn(
                          "w-full max-w-6 rounded-t-[4px] bg-primary transition-opacity group-hover:opacity-80 group-focus-visible:opacity-80",
                          b.alerts === 0 && "bg-transparent",
                        )}
                        style={{ height: `${(b.alerts / top) * 100}%` }}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-semibold tabular-nums">
                      {fmt.format(b.alerts)} {b.alerts === 1 ? "alert" : "alerts"}
                      <span className="font-normal opacity-80">
                        {" "}
                        · {fmt.format(b.sources)} {b.sources === 1 ? "IP" : "IPs"}
                      </span>
                    </p>
                    <p className="opacity-80">{bucketLabel(start, stats.bucketHours)}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
        {/* X axis */}
        <div className="mt-2 flex gap-[2px] text-xs text-muted-foreground">
          {stats.timeline.map((b, i) => {
            const label = tickLabel(new Date(b.start), i, stats);
            return (
              <div key={b.start} className="relative h-4 min-w-0 flex-1">
                {label && <span className="absolute left-0 whitespace-nowrap">{label}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RankedList(props: {
  title: string;
  description: string;
  items: Ranked[];
  empty: string;
  render?: (r: Ranked) => React.ReactNode;
  /** Rows it returns a handler for are clickable. */
  onSelect?: (r: Ranked) => (() => void) | undefined;
}) {
  const max = Math.max(1, ...props.items.map((i) => i.alerts));
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {props.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{props.empty}</p>
        ) : (
          <ul className="space-y-3">
            {props.items.map((r) => {
              const label = props.render?.(r) ?? r.label;
              const select = props.onSelect?.(r);
              return (
                <li key={r.key} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    {select ? (
                      <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={select}>
                        {label}
                      </button>
                    ) : (
                      <span className="min-w-0 truncate" title={r.label}>
                        {label}
                      </span>
                    )}
                    <span className="shrink-0 tabular-nums">
                      <span className="font-medium">{fmt.format(r.alerts)}</span>
                      <span className="text-xs text-muted-foreground">
                        {" "}
                        · {fmt.format(r.sources)} {r.sources === 1 ? "IP" : "IPs"}
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-r-[4px] bg-primary" style={{ width: `${(r.alerts / max) * 100}%` }} />
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Source({ ip, country, as }: { ip: string; country: string | null; as: string | null }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-sm">{ip}</p>
      <p className="truncate text-xs text-muted-foreground" title={country ? countryName(country) : undefined}>
        {country && `${flag(country)} ${country}`}
        {country && as && " · "}
        {as}
      </p>
    </div>
  );
}

function Bans({ stats, onChanged }: { stats: CrowdsecStats; onChanged: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const unban = async (decisionId: number, value: string) => {
    setBusy(decisionId);
    try {
      await api.unban(decisionId);
      toast.success(`Lifted the ban on ${value}`, {
        description: "Traefik may keep blocking it until its cached answer expires.",
      });
      onChanged();
    } catch (e) {
      toast.error("Couldn't lift the ban", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">Active bans</CardTitle>
        <CardDescription>
          IPs CrowdSec banned itself or through <code className="font-mono">cscli</code>. The community blocklist isn't
          listed.
        </CardDescription>
      </CardHeader>
      {stats.bans.length === 0 ? (
        <p className="border-t py-8 text-center text-sm text-muted-foreground">No active bans.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-6">Source</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="w-28 pr-6" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.bans.map((b) => (
              <TableRow key={b.decisionId}>
                <TableCell className="py-3 pl-6">
                  <Source ip={b.value} country={b.country} as={b.as} />
                </TableCell>
                <TableCell>
                  <p className="text-sm">{scenarioName(b.scenario)}</p>
                  <p className="text-xs text-muted-foreground">
                    {b.type} · {b.origin}
                  </p>
                </TableCell>
                <TableCell className="max-w-56 truncate text-sm text-muted-foreground">
                  {b.hosts.join(", ") || "—"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground" title={new Date(b.until).toLocaleString()}>
                  {timeUntil(b.until)}
                </TableCell>
                <TableCell className="pr-6 text-right">
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => unban(b.decisionId, b.value)}>
                    {busy === b.decisionId ? <Loader2 className="animate-spin" /> : <ShieldOff />} Unban
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function RecentAlerts({ stats, onOpenService }: { stats: CrowdsecStats; onOpenService: (id: number) => void }) {
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">Recent alerts</CardTitle>
        <CardDescription>The latest {stats.recent.length > 0 ? stats.recent.length : ""} detections, newest first.</CardDescription>
      </CardHeader>
      {stats.recent.length === 0 ? (
        <p className="border-t py-8 text-center text-sm text-muted-foreground">Nothing detected yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-6">When</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Scenario</TableHead>
              <TableHead>Target</TableHead>
              <TableHead className="text-right">Events</TableHead>
              <TableHead className="pr-6" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {stats.recent.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="pl-6 text-sm whitespace-nowrap text-muted-foreground" title={new Date(a.at).toLocaleString()}>
                  {timeAgo(a.at)}
                </TableCell>
                <TableCell className="py-3">
                  <Source ip={a.ip} country={a.country} as={a.as} />
                </TableCell>
                <TableCell className="text-sm">{scenarioName(a.scenario)}</TableCell>
                <TableCell className="max-w-72">
                  {a.hosts[0] &&
                    (a.serviceId ? (
                      <button type="button" className="block max-w-full truncate text-sm hover:underline" onClick={() => onOpenService(a.serviceId!)}>
                        {a.hosts.join(", ")}
                      </button>
                    ) : (
                      <p className="truncate text-sm">{a.hosts.join(", ")}</p>
                    ))}
                  <p className="truncate font-mono text-xs text-muted-foreground" title={a.paths.join("\n")}>
                    {a.paths.join(" ")}
                  </p>
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">{fmt.format(a.events)}</TableCell>
                <TableCell className="pr-6 text-right">
                  {a.banned && <Badge variant="outline" className="text-muted-foreground">Banned</Badge>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function Unavailable({ error, onOpenSettings, onRetry }: { error: string; onOpenSettings: () => void; onRetry: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Can't load statistics from CrowdSec</CardTitle>
        <CardDescription>{error}</CardDescription>
        <CardAction className="flex gap-2">
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw /> Retry
          </Button>
          <Button variant="outline" onClick={onOpenSettings}>
            <SettingsIcon /> Settings
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

export function SecurityPage(props: {
  range: StatsRange;
  onRange: (r: StatsRange) => void;
  crowdsec: CrowdsecView | null;
  onOpenSettings: () => void;
  onOpenService: (id: number) => void;
}) {
  const { range } = props;
  const load = useCallback(() => api.crowdsecStats(range), [range]);
  const stats = usePoll(load, 30_000);
  const [refreshing, setRefreshing] = useState(false);
  const data = stats.data;
  // While another range loads, the previous one stays on screen, dimmed.
  const stale = !!data && data.range !== range;
  const rangeLabel = RANGES.find((r) => r.value === range)!.long;

  const refresh = async () => {
    setRefreshing(true);
    try {
      stats.setData(await api.crowdsecStats(range, true));
    } catch (e) {
      toast.error("Couldn't refresh", { description: (e as Error).message });
    } finally {
      setRefreshing(false);
    }
  };

  const community = (data?.metrics?.decisions.CAPI ?? 0) + (data?.metrics?.decisions.lists ?? 0);

  return (
    <div>
      <PageHeader title="Security" description="What CrowdSec detected in Traefik's access log, and whom it banned.">
        <ToggleGroup
          type="single"
          variant="outline"
          value={range}
          onValueChange={(v) => v && props.onRange(v as StatsRange)}
          aria-label="Time range"
        >
          {RANGES.map((r) => (
            <ToggleGroupItem key={r.value} value={r.value} className="px-3">
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button variant="outline" size="icon" onClick={refresh} disabled={refreshing} aria-label="Refresh">
          <RefreshCw className={cn(refreshing && "animate-spin")} />
        </Button>
      </PageHeader>

      {props.crowdsec && !props.crowdsec.config.enabled && (
        <Alert className="mb-6">
          <AlertTitle>Detection only</AlertTitle>
          <AlertDescription>
            <p>
              CrowdSec bans IPs, but Traefik doesn't block them yet.{" "}
              <button type="button" className="underline" onClick={props.onOpenSettings}>
                Turn on blocking in Settings
              </button>
              .
            </p>
          </AlertDescription>
        </Alert>
      )}

      {!data && stats.error ? (
        <Unavailable error={stats.error} onOpenSettings={props.onOpenSettings} onRetry={stats.reload} />
      ) : !data ? (
        <div className="grid gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
          <Skeleton className="h-72 md:col-span-4" />
        </div>
      ) : (
        <div className={cn("space-y-6 transition-opacity", stale && "opacity-60")}>
          {data.truncated && (
            <Alert>
              <AlertDescription>
                <p>There were more alerts than proxytail can load at once; the oldest ones in this range are left out.</p>
              </AlertDescription>
            </Alert>
          )}
          {stats.error && (
            <Alert variant="destructive">
              <AlertDescription>
                <p>Couldn't update: {stats.error}. Showing data from {timeAgo(data.generatedAt)}.</p>
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Alerts" value={data.totals.alerts} detail={`${fmt.format(data.totals.events)} suspicious requests`} />
            <Stat
              label="Attacking IPs"
              value={data.totals.sources}
              detail={`From ${data.totals.countries} ${data.totals.countries === 1 ? "country" : "countries"}`}
            />
            <Stat label="Active bans" value={data.bans.length} detail="Detected here, right now" />
            <Stat
              label="Community blocklist"
              value={community}
              detail={data.metrics ? "IPs banned by the CrowdSec network" : "Metrics unavailable"}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Alerts over time</CardTitle>
              <CardDescription>
                {data.totals.alerts === 0
                  ? `No attacks detected in ${rangeLabel}.`
                  : `Alerts per ${data.bucketHours === 1 ? "hour" : data.bucketHours === 24 ? "day" : `${data.bucketHours} hours`} over ${rangeLabel}.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Timeline stats={data} />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
            <RankedList
              title="Scenarios"
              description="What the attackers tried."
              items={data.scenarios}
              empty="No alerts."
              render={(r) => <span title={r.key}>{scenarioName(r.label)}</span>}
            />
            <RankedList
              title="Targeted services"
              description="The hostnames the attacks were aimed at."
              items={data.services}
              empty="No alerts named a hostname."
              onSelect={(r) => (r.serviceId ? () => props.onOpenService(r.serviceId!) : undefined)}
            />
            <RankedList
              title="Countries"
              description="Where the attacking IPs are located."
              items={data.countries}
              empty="No alerts."
              render={(r) => `${flag(r.key)} ${countryName(r.key)}`}
            />
            <RankedList
              title="Networks"
              description="The autonomous systems the attacking IPs belong to."
              items={data.networks}
              empty="No alerts."
              render={(r) => (
                <>
                  {r.label} <span className="text-xs text-muted-foreground">AS{r.key}</span>
                </>
              )}
            />
          </div>

          <Bans stats={data} onChanged={refresh} />
          <RecentAlerts stats={data} onOpenService={props.onOpenService} />

          {data.metrics && (
            <p className="text-xs text-muted-foreground">
              CrowdSec {data.metrics.version && `v${data.metrics.version} `}has read {fmt.format(data.metrics.linesRead)} access log
              lines since it started ({fmt.format(data.metrics.linesParsed)} parsed). Updated {timeAgo(data.generatedAt)}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
