import { useEffect, useState, type FormEvent } from "react";
import { Database, Loader2, MemoryStick, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToneBadge } from "@/components/status";
import { usePoll } from "@/hooks/use-poll";
import { api, type RateLimitConfig, type RateLimitPeriod, type RateLimitStore, type RateLimitView } from "@/lib/api";
import { cn } from "@/lib/utils";

const PERIODS: Record<RateLimitPeriod, string> = { "1s": "second", "1m": "minute", "1h": "hour" };

const STORES: { value: RateLimitStore; label: string; icon: typeof Database; description: string }[] = [
  {
    value: "memory",
    label: "Traefik",
    icon: MemoryStick,
    description: "In Traefik's memory. Counts reset whenever a service changes and when Traefik restarts.",
  },
  {
    value: "valkey",
    label: "Valkey",
    icon: Database,
    description: "In the Valkey container. Counts survive configuration changes and Traefik restarts.",
  },
];

interface Draft {
  enabled: boolean;
  store: RateLimitStore;
  average: string;
  period: RateLimitPeriod;
  burst: string;
}

const toDraft = (c: RateLimitConfig): Draft => ({
  enabled: c.enabled,
  store: c.store,
  average: String(c.average),
  period: c.period,
  burst: String(c.burst),
});

const valkeyUp = (view: RateLimitView) => !!view.valkey?.reachable && !view.valkey.error;

function StateBadge({ view }: { view: RateLimitView }) {
  if (!view.config.enabled) return <ToneBadge t="muted">Off</ToneBadge>;
  if (view.traefik?.errors.length) return <ToneBadge t="danger">Traefik error</ToneBadge>;
  if (view.config.store === "valkey" && view.activeStore !== "valkey") return <ToneBadge t="warning">Fallback</ToneBadge>;
  return (
    <ToneBadge t="success">
      <span className="size-1.5 rounded-full bg-current" /> Limiting
    </ToneBadge>
  );
}

function Stat(props: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-xs text-muted-foreground">{props.label}</p>
      <p className="truncate text-sm font-medium tabular-nums">{props.value}</p>
      {props.detail && <p className="truncate text-xs text-muted-foreground tabular-nums">{props.detail}</p>}
    </div>
  );
}

function Problems({ view }: { view: RateLimitView }) {
  const { config, valkey, traefik } = view;
  if (config.enabled && traefik?.errors.length)
    return (
      <Alert variant="destructive">
        <AlertTitle>Traefik rejected the rate limit</AlertTitle>
        <AlertDescription>
          <p>{traefik.errors.join(" ")} Services with the error aren't routed until it's fixed.</p>
        </AlertDescription>
      </Alert>
    );
  if (config.store === "valkey" && valkey && !valkeyUp(view))
    return (
      <Alert variant={config.enabled ? "destructive" : "default"}>
        <AlertTitle>{valkey.reachable ? "Valkey refused proxytail's check" : "Valkey is unreachable"}</AlertTitle>
        <AlertDescription>
          <p>
            {valkey.error} ({valkey.addr}).
            {config.enabled && " Traefik counts requests in its own memory until Valkey is back."}
          </p>
        </AlertDescription>
      </Alert>
    );
  return null;
}

export function RateLimitCard({ className }: { className?: string }) {
  const view = usePoll(api.rateLimit, 10_000);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  // The form starts from the saved configuration; polling only refreshes the status.
  useEffect(() => {
    if (view.data && !draft) setDraft(toDraft(view.data.config));
  }, [view.data, draft]);

  const set = (patch: Partial<Draft>) => setDraft((d) => d && { ...d, ...patch });
  const saved = view.data && toDraft(view.data.config);
  const dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      const next = await api.saveRateLimit({
        enabled: draft.enabled,
        store: draft.store,
        average: Number(draft.average),
        period: draft.period,
        burst: Number(draft.burst),
      });
      view.setData(next);
      setDraft(toDraft(next.config));
      toast.success("Rate limiting saved", { description: "Traefik picks it up within about 5 seconds." });
    } catch (e) {
      toast.error("Couldn't save rate limiting", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const data = view.data;

  return (
    <form onSubmit={save} className={className}>
      <Card>
        <CardHeader>
          <CardTitle>Rate limiting</CardTitle>
          <CardDescription>
            Limits how many requests each client IP can make to each service. Requests over the limit get{" "}
            <code className="font-mono">429 Too Many Requests</code>.
          </CardDescription>
          <CardAction>{data && <StateBadge view={data} />}</CardAction>
        </CardHeader>

        {!data || !draft ? (
          <CardContent>
            {view.error ? (
              <p className="text-sm text-destructive">{view.error}</p>
            ) : (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
          </CardContent>
        ) : (
          <CardContent className="grid gap-6 lg:grid-cols-2">
            <div className="grid content-start gap-5">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="rate-limit-enabled">Limit requests</Label>
                  <p className="text-xs text-muted-foreground">
                    On every service, before basic auth. Each client IP has its own budget per service.
                  </p>
                </div>
                <Switch
                  id="rate-limit-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => set({ enabled })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="rate-limit-average">Average</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="rate-limit-average"
                    type="number"
                    min={1}
                    max={100000}
                    value={draft.average}
                    onChange={(e) => set({ average: e.target.value })}
                    className="w-28 font-mono"
                  />
                  <span className="text-sm text-muted-foreground">requests per</span>
                  <Select value={draft.period} onValueChange={(period) => set({ period: period as RateLimitPeriod })}>
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PERIODS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground">The rate a client can keep up.</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="rate-limit-burst">Burst</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="rate-limit-burst"
                    type="number"
                    min={1}
                    max={100000}
                    value={draft.burst}
                    onChange={(e) => set({ burst: e.target.value })}
                    className="w-28 font-mono"
                  />
                  <span className="text-sm text-muted-foreground">requests</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  How many requests a client can make at once, e.g. when a page loads its scripts and images.
                </p>
              </div>
            </div>

            <div className="grid content-start gap-4">
              <div className="grid gap-2">
                <Label id="rate-limit-store">Count requests in</Label>
                <div role="radiogroup" aria-labelledby="rate-limit-store" className="grid gap-2 sm:grid-cols-2">
                  {STORES.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      role="radio"
                      aria-checked={draft.store === s.value}
                      onClick={() => set({ store: s.value })}
                      className={cn(
                        "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                        draft.store === s.value ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/40",
                      )}
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <s.icon className="size-4 text-muted-foreground" /> {s.label}
                      </span>
                      <span className="text-xs text-muted-foreground">{s.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              {data.config.enabled && (
                <div className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/30 p-4">
                  <Stat
                    label="Counting in"
                    value={data.activeStore === "valkey" ? "Valkey" : "Traefik's memory"}
                    detail={
                      data.config.store === "valkey" && data.activeStore !== "valkey"
                        ? "Fallback: Valkey is down"
                        : data.valkey?.version && `${data.valkey.server} ${data.valkey.version}`
                    }
                  />
                  <Stat
                    label="Limited services"
                    value={data.traefik ? data.traefik.enabled : "–"}
                    detail={data.traefik ? "in Traefik" : "Traefik is unreachable"}
                  />
                </div>
              )}
              <Problems view={data} />
            </div>
          </CardContent>
        )}

        <CardFooter className="justify-between gap-2 border-t">
          <p className="text-xs text-muted-foreground">
            Traefik falls back to its memory while Valkey is unreachable.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={view.reload}>
              <RefreshCw /> Refresh
            </Button>
            <Button type="submit" disabled={busy || !dirty}>
              {busy && <Loader2 className="animate-spin" />} Save
            </Button>
          </div>
        </CardFooter>
      </Card>
    </form>
  );
}
