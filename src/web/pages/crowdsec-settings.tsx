import { useEffect, useState, type FormEvent } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToneBadge } from "@/components/status";
import { usePoll } from "@/hooks/use-poll";
import { api, type CrowdsecConfig, type CrowdsecView } from "@/lib/api";

const fmt = new Intl.NumberFormat();

interface Draft {
  enabled: boolean;
  cacheSeconds: string;
  trustedIps: string;
}

const toDraft = (c: CrowdsecConfig): Draft => ({
  enabled: c.enabled,
  cacheSeconds: String(c.cacheSeconds),
  trustedIps: c.trustedIps.join(", "),
});

function StateBadge({ view }: { view: CrowdsecView }) {
  const { config, status, middleware } = view;
  if (!status.lapi.reachable) return <ToneBadge t="danger">Unreachable</ToneBadge>;
  if (status.lapi.keyAccepted === false) return <ToneBadge t="danger">Key rejected</ToneBadge>;
  if (!config.enabled) return <ToneBadge t="muted">Not blocking</ToneBadge>;
  if (middleware && middleware.status !== "enabled") return <ToneBadge t="danger">Bouncer error</ToneBadge>;
  return (
    <ToneBadge t="success">
      <span className="size-1.5 rounded-full bg-current" /> Blocking
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

function Problems({ view }: { view: CrowdsecView }) {
  const { config, status, middleware } = view;
  if (!status.key)
    return (
      <Alert variant="destructive">
        <AlertTitle>No bouncer key</AlertTitle>
        <AlertDescription>
          proxytail couldn't create the key it shares with CrowdSec and Traefik. Check that the{" "}
          <code className="font-mono">crowdsec-secrets</code> volume is writable.
        </AlertDescription>
      </Alert>
    );
  if (!status.lapi.reachable)
    return (
      <Alert variant="destructive">
        <AlertTitle>CrowdSec's Local API is unreachable</AlertTitle>
        <AlertDescription>
          <p>
            {status.lapi.error}
            {config.enabled && ". Traefik blocks requests to your services until it's back."}
          </p>
        </AlertDescription>
      </Alert>
    );
  if (status.lapi.keyAccepted === false)
    return (
      <Alert variant="destructive">
        <AlertTitle>CrowdSec rejected the bouncer key</AlertTitle>
        <AlertDescription>
          <p>
            CrowdSec only registers the key on its first start. Re-register it with{" "}
            <code className="font-mono">docker compose exec crowdsec cscli bouncers delete traefik</code> and{" "}
            <code className="font-mono">docker compose restart crowdsec</code>.
          </p>
        </AlertDescription>
      </Alert>
    );
  if (config.enabled && middleware && middleware.status !== "enabled")
    return (
      <Alert variant="destructive">
        <AlertTitle>Traefik couldn't load the bouncer</AlertTitle>
        <AlertDescription>
          <p>
            {middleware.errors?.join(" ") || "The middleware is disabled."} Services aren't routed until it loads. Is
            the CrowdSec plugin declared in Traefik's static configuration?
          </p>
        </AlertDescription>
      </Alert>
    );
  if (status.metrics && status.metrics.linesRead === 0)
    return (
      <Alert>
        <AlertDescription>
          <p>
            CrowdSec hasn't read any access log lines since it started. Traefik must write its access log to the shared{" "}
            <code className="font-mono">traefik-logs</code> volume.
          </p>
        </AlertDescription>
      </Alert>
    );
  return null;
}

export function CrowdsecCard({ className }: { className?: string }) {
  const view = usePoll(api.crowdsec, 10_000);
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
      const next = await api.saveCrowdsec({
        enabled: draft.enabled,
        cacheSeconds: Number(draft.cacheSeconds),
        trustedIps: draft.trustedIps.split(/[\s,]+/).filter(Boolean),
      });
      view.setData(next);
      setDraft(toDraft(next.config));
      toast.success("CrowdSec settings saved", {
        description: next.config.enabled !== view.data?.config.enabled
          ? next.config.enabled
            ? "Traefik starts blocking within about 5 seconds."
            : "Traefik stops blocking within about 5 seconds."
          : undefined,
      });
    } catch (e) {
      toast.error("Couldn't save CrowdSec settings", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const data = view.data;
  const metrics = data?.status.metrics;
  const local = (metrics?.decisions.crowdsec ?? 0) + (metrics?.decisions.cscli ?? 0);
  const community = (metrics?.decisions.CAPI ?? 0) + (metrics?.decisions.lists ?? 0);

  return (
    <form onSubmit={save} className={className}>
      <Card>
        <CardHeader>
          <CardTitle>CrowdSec</CardTitle>
          <CardDescription>
            CrowdSec reads Traefik's access log and bans IPs that scan or attack your services. The bouncer asks
            CrowdSec about every client IP before a request reaches a service, and blocks the ones with a ban.
            Community blocklist bans are blocked too.
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
                  <Label htmlFor="crowdsec-enabled">Block banned IPs</Label>
                  <p className="text-xs text-muted-foreground">
                    On every service. Detection runs either way. While CrowdSec is unreachable, every IP that isn't
                    cached as clean is blocked.
                  </p>
                </div>
                <Switch
                  id="crowdsec-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => set({ enabled })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="crowdsec-cache">Cache clean IPs for</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="crowdsec-cache"
                    type="number"
                    min={1}
                    max={3600}
                    value={draft.cacheSeconds}
                    onChange={(e) => set({ cacheSeconds: e.target.value })}
                    className="w-28 font-mono"
                  />
                  <span className="text-sm text-muted-foreground">seconds</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  How long before an IP without a ban is checked again. A new ban can take this long to apply.
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="crowdsec-trusted">Never block</Label>
                <Input
                  id="crowdsec-trusted"
                  value={draft.trustedIps}
                  onChange={(e) => set({ trustedIps: e.target.value })}
                  placeholder="203.0.113.10, 198.51.100.0/24"
                  autoComplete="off"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  IP addresses and CIDR ranges that skip the check, e.g. your home connection.
                </p>
              </div>
            </div>

            <div className="grid content-start gap-4">
              <div className="grid grid-cols-3 gap-4 rounded-lg border bg-muted/30 p-4">
                <Stat
                  label="Local API"
                  value={
                    !data.status.lapi.reachable
                      ? "Unreachable"
                      : data.status.lapi.keyAccepted === false
                        ? "Key rejected"
                        : metrics?.version
                          ? `v${metrics.version}`
                          : "Connected"
                  }
                  detail={data.status.lapi.reachable && data.status.lapi.keyAccepted ? "Key accepted" : undefined}
                />
                <Stat
                  label="Access log"
                  value={metrics ? `${fmt.format(metrics.linesRead)} lines` : "–"}
                  detail={
                    metrics && metrics.linesRead > 0
                      ? `${Math.round((metrics.linesParsed / metrics.linesRead) * 100)}% parsed`
                      : undefined
                  }
                />
                <Stat
                  label="Active bans"
                  value={metrics ? `${fmt.format(local)} local` : "–"}
                  detail={metrics ? `${fmt.format(community)} community` : undefined}
                />
              </div>
              <Problems view={data} />
            </div>
          </CardContent>
        )}

        <CardFooter className="justify-between gap-2 border-t">
          <p className="text-xs text-muted-foreground">Log counts reset when CrowdSec restarts.</p>
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
