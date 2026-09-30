import { useEffect, useState, type FormEvent } from "react";
import { Download, ExternalLink, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Country } from "@/components/country-picker";
import { ToneBadge } from "@/components/status";
import { usePoll } from "@/hooks/use-poll";
import { api, type CountryDbStatus } from "@/lib/api";
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

export function countryDbHealth(s: CountryDbStatus | null) {
  if (!s) return { tone: "muted" as const, state: "…" };
  if (s.state === "ready")
    return {
      tone: "success" as const,
      state: s.edition ? `Edition ${s.edition}` : "Loaded",
      detail: `${s.countries.length} countries`,
    };
  if (s.state === "loading") return { tone: "muted" as const, state: s.downloading ? "Downloading" : "Loading" };
  if (s.state === "error") return { tone: "danger" as const, state: "Not loaded", detail: s.error };
  return { tone: "warning" as const, state: "Not loaded" };
}

/** Looks up an address, to see what a client's country check would find. */
function Lookup({ ready }: { ready: boolean }) {
  const [ip, setIp] = useState("");
  const [result, setResult] = useState<{ ip: string; country: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setResult(await api.lookupCountry(ip.trim()));
    } catch (e) {
      setResult(null);
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid content-start gap-2">
      <Label htmlFor="country-lookup">Look up an address</Label>
      <div className="flex gap-2">
        <Input
          id="country-lookup"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="203.0.113.10 or 2001:db8::1"
          className="font-mono"
          autoComplete="off"
        />
        <Button type="submit" variant="outline" disabled={!ready || busy || !ip.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : <Search />} Look up
        </Button>
      </div>
      <p className="h-5 text-sm">
        {result && (
          <>
            <span className="font-mono text-xs">{result.ip}</span>
            <span className="text-muted-foreground"> is in </span>
            {result.country ? <Country code={result.country} className="font-medium" /> : <span>no country</span>}
          </>
        )}
      </p>
    </form>
  );
}

/** The country database: its state, a lookup, and a button to fetch the newest edition. */
export function CountryDbCard({ onChanged }: { onChanged?: (s: CountryDbStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const view = usePoll(api.countryDb, 5000);
  const data = view.data;
  const health = countryDbHealth(data);

  useEffect(() => {
    if (data) onChanged?.(data);
    // Only when the state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const update = async () => {
    setBusy(true);
    try {
      const next = await api.updateCountryDb();
      view.setData(next);
      if (next.error) toast.error("Couldn't update the country database", { description: next.error });
      else toast.success("Country database updated", { description: next.edition ? `Edition ${next.edition}` : undefined });
    } catch (e) {
      toast.error("Couldn't update the country database", { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Countries</CardTitle>
        <CardDescription>
          The country of each client IP, for the <strong>Requests</strong> page and for services that only let some
          countries in. proxytail looks addresses up in its own copy of the database, so they never leave this host.
        </CardDescription>
        <CardAction>
          <ToneBadge t={health.tone}>
            {health.tone === "success" && <span className="size-1.5 rounded-full bg-current" />}
            {(data?.state === "loading" || data?.downloading) && <Loader2 className="size-3 animate-spin" />}
            {data?.downloading && data.state === "ready" ? "Updating" : health.state}
          </ToneBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <div className="grid content-start gap-4">
          {data && (
            <div className="grid grid-cols-2 gap-4 rounded-lg border bg-muted/30 p-4">
              <Stat
                label="Source"
                value={data.dbip ? "DB-IP" : data.source}
                detail={data.dbip ? "IP to Country Lite, monthly" : undefined}
              />
              <Stat
                label="Edition"
                value={data.edition ?? (data.state === "ready" ? "–" : "Not loaded")}
                detail={data.downloadedAt ? `downloaded ${timeAgo(data.downloadedAt)}` : undefined}
              />
              <Stat label="Address ranges" value={fmt.format(data.ranges)} />
              <Stat label="Countries" value={fmt.format(data.countries.length)} />
            </div>
          )}
          {data?.error && (
            <Alert variant={data.state === "ready" ? "default" : "destructive"}>
              <AlertTitle>{data.state === "ready" ? "The last update failed" : "No country database"}</AlertTitle>
              <AlertDescription>
                <p>
                  {data.error}
                  {data.state === "ready" && " proxytail keeps using the edition it has."}
                </p>
              </AlertDescription>
            </Alert>
          )}
          {data?.state === "missing" && !data.error && (
            <Alert>
              <AlertTitle>No country database yet</AlertTitle>
              <AlertDescription>
                <p>proxytail downloads it on its own. Until then, requests have no country.</p>
              </AlertDescription>
            </Alert>
          )}
        </div>
        <div className="grid content-start gap-4">
          <Lookup ready={data?.state === "ready"} />
          <p className="text-xs text-muted-foreground">
            DB-IP publishes a new edition every month, and proxytail fetches it in the background (about 5 MB, stored in{" "}
            <code className="font-mono break-all">{data?.path ?? "countries/"}</code>). Set{" "}
            <code className="font-mono">COUNTRY_DB_URL</code> to download a file in the same format from elsewhere: one
            range per line, as <code className="font-mono">first IP,last IP,country code</code>.
          </p>
        </div>
      </CardContent>
      <CardFooter className="justify-between gap-2 border-t">
        <p className="text-xs text-muted-foreground">
          {data?.dbip !== false && (
            <>
              <a href="https://db-ip.com" target="_blank" rel="noreferrer" className="underline">
                IP Geolocation by DB-IP
              </a>
              , licensed under{" "}
              <a
                href="https://creativecommons.org/licenses/by/4.0/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 underline"
              >
                CC BY 4.0 <ExternalLink className="size-3" />
              </a>
            </>
          )}
        </p>
        <Button variant="outline" onClick={update} disabled={busy || !!data?.downloading}>
          {busy || data?.downloading ? <Loader2 className="animate-spin" /> : <Download />} Update now
        </Button>
      </CardFooter>
    </Card>
  );
}
