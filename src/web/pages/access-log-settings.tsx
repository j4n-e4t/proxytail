import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToneBadge } from "@/components/status";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/utils";

const fmt = new Intl.NumberFormat();

function Stat(props: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-xs text-muted-foreground">{props.label}</p>
      <p className="truncate text-sm font-medium tabular-nums">{props.value}</p>
      {props.detail && <p className="truncate text-xs text-muted-foreground">{props.detail}</p>}
    </div>
  );
}

export function AccessLogCard({ className }: { className?: string }) {
  const view = usePoll(api.accessLog, 10_000);
  const [days, setDays] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = view.data;

  useEffect(() => {
    if (data && days === null) setDays(String(data.retentionDays));
  }, [data, days]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const next = await api.saveAccessLog(Number(days));
      view.setData(next);
      setDays(String(next.retentionDays));
      toast.success("Request log saved");
    } catch (e) {
      toast.error("Couldn't save the request log settings", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className={className}>
      <Card>
        <CardHeader>
          <CardTitle>Request log</CardTitle>
          <CardDescription>
            proxytail reads Traefik's access log and keeps each request for the <strong>Requests</strong> page.
          </CardDescription>
          <CardAction>
            {data &&
              (data.state === "ok" ? (
                <ToneBadge t="success">
                  <span className="size-1.5 rounded-full bg-current" /> Reading
                </ToneBadge>
              ) : data.state === "missing" ? (
                <ToneBadge t="warning">No log yet</ToneBadge>
              ) : (
                <ToneBadge t="danger">Error</ToneBadge>
              ))}
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <div className="grid content-start gap-2">
            <Label htmlFor="access-log-days">Keep requests for</Label>
            <div className="flex items-center gap-2">
              <Input
                id="access-log-days"
                type="number"
                min={1}
                max={90}
                value={days ?? ""}
                onChange={(e) => setDays(e.target.value)}
                className="w-28 font-mono"
              />
              <span className="text-sm text-muted-foreground">days</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Older requests are deleted, and at most a million are kept. They include client IPs and user agents.
            </p>
          </div>
          <div className="grid content-start gap-4">
            {data && (
              <div className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/30 p-4">
                <Stat
                  label="Stored requests"
                  value={fmt.format(data.entries)}
                  detail={data.oldest ? `since ${new Date(data.oldest).toLocaleDateString()}` : undefined}
                />
                <Stat
                  label="Latest request"
                  value={data.newest ? timeAgo(new Date(data.newest).toISOString()) : "–"}
                  detail={<span className="font-mono">{data.path}</span>}
                />
              </div>
            )}
            {data?.state === "error" && (
              <Alert variant="destructive">
                <AlertTitle>Can't read the access log</AlertTitle>
                <AlertDescription>{data.error}</AlertDescription>
              </Alert>
            )}
            {data?.truncateError && (
              <Alert>
                <AlertTitle>The access log file keeps growing</AlertTitle>
                <AlertDescription>
                  proxytail empties it once read, but couldn't: {data.truncateError}. Mount the{" "}
                  <code className="font-mono">traefik-logs</code> volume writable for proxytail.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t">
          <Button type="submit" disabled={busy || !data || days === String(data.retentionDays)}>
            {busy && <Loader2 className="animate-spin" />} Save
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
