import { useState, type FormEvent } from "react";
import { Check, Copy, ExternalLink, Loader2, Plug, Radar } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/page-header";
import { ToneBadge } from "@/components/status";
import { api, type Settings, type TraefikStatus } from "@/lib/api";

function Field(props: { id: string; label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

export function SettingsPage({
  settings,
  traefik,
  onSaved,
}: {
  settings: Settings;
  traefik: TraefikStatus | null;
  onSaved: (s: Settings) => void;
}) {
  const [tag, setTag] = useState(settings.backendTag);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [copied, setCopied] = useState(false);

  const test = async (backendTag = settings.backendTag) => {
    const t = await api.testSettings();
    toast.success("Connected to Tailscale", { description: `Found ${t.devices} peers tagged ${backendTag}.` });
  };

  const run = async (kind: "save" | "test", fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast.error(kind === "test" ? "Connection failed" : "Couldn't save settings", {
        description: (e as Error).message,
      });
    } finally {
      setBusy(null);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    run("save", async () => {
      const saved = await api.saveSettings({ backendTag: tag || null });
      onSaved(saved);
      setTag(saved.backendTag);
      toast.success("Settings saved");
      await test(saved.backendTag);
    });
  };

  const [publicAddr, setPublicAddr] = useState(settings.publicAddress);
  const [addrBusy, setAddrBusy] = useState<"save" | "detect" | null>(null);

  const savePublicAddress = async (e: FormEvent) => {
    e.preventDefault();
    setAddrBusy("save");
    try {
      onSaved(await api.saveSettings({ publicAddress: publicAddr.trim() || null }));
      toast.success("Public address saved", { description: "Re-check your domains if it changed." });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAddrBusy(null);
    }
  };

  const detect = async () => {
    setAddrBusy("detect");
    try {
      setPublicAddr((await api.detectIp()).ip);
    } catch (e) {
      toast.error("Couldn't detect public IP", { description: (e as Error).message });
    } finally {
      setAddrBusy(null);
    }
  };

  // Traefik has to poll from loopback (it shares the sidecar's network namespace), or from the host in development.
  const endpoint = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? `${location.origin}/api/traefik/config`.replace(/\/\/(localhost|127\.0\.0\.1)/, "//host.docker.internal")
    : "http://127.0.0.1:3000/api/traefik/config";
  const providerSnippet = `providers:\n  http:\n    endpoint: "${endpoint}"\n    pollInterval: "5s"`;

  return (
    <div className="max-w-3xl xl:max-w-none">
      <PageHeader title="Settings" description="Connect proxytail to your tailnet and Traefik." />

      <div className="grid gap-6 xl:grid-cols-2 xl:items-start">
      <form onSubmit={savePublicAddress} className="xl:col-start-1 xl:row-start-1">
        <Card>
          <CardHeader>
            <CardTitle>Public address</CardTitle>
            <CardDescription>
              Where your domains' DNS should point: the public IP (or hostname) that reaches Traefik on ports 80 and 443.
            </CardDescription>
            <CardAction>
              {settings.publicAddress ? (
                <ToneBadge t="success">
                  <span className="size-1.5 rounded-full bg-current" /> Set
                </ToneBadge>
              ) : (
                <ToneBadge t="warning">Not set</ToneBadge>
              )}
            </CardAction>
          </CardHeader>
          <CardContent>
            <Field
              id="public-address"
              label="IP address or hostname"
              hint="Domains are verified by checking that *.domain resolves to this address."
            >
              <div className="flex gap-2">
                <Input
                  id="public-address"
                  value={publicAddr}
                  onChange={(e) => setPublicAddr(e.target.value)}
                  placeholder="203.0.113.10 or proxy.example.com"
                  className="font-mono"
                />
                <Button type="button" variant="outline" onClick={detect} disabled={!!addrBusy}>
                  {addrBusy === "detect" ? <Loader2 className="animate-spin" /> : <Radar />} Detect
                </Button>
              </div>
            </Field>
          </CardContent>
          <CardFooter className="justify-end border-t">
            <Button type="submit" disabled={!!addrBusy || publicAddr.trim() === settings.publicAddress}>
              {addrBusy === "save" && <Loader2 className="animate-spin" />} Save
            </Button>
          </CardFooter>
        </Card>
      </form>

      {/* Wide screens: the Tailscale card fills the right column next to the two shorter cards. */}
      <form onSubmit={save} className="xl:col-start-2 xl:row-span-2 xl:row-start-1">
        <Card>
          <CardHeader>
            <CardTitle>Tailscale</CardTitle>
            <CardDescription>
              Peers are read from the tailscaled sidecar, which lists every peer the tailnet policy lets proxytail reach.
            </CardDescription>
            <CardAction>
              {settings.source === "mock" ? (
                <ToneBadge t="warning">Mock peers</ToneBadge>
              ) : settings.source ? (
                <ToneBadge t="success">
                  <span className="size-1.5 rounded-full bg-current" /> Connected
                </ToneBadge>
              ) : (
                <ToneBadge t="muted">Not connected</ToneBadge>
              )}
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-4">
            {settings.mock && (
              <Alert>
                <AlertDescription>
                  <p>
                    Peers are loaded from <code className="font-mono">TS_MOCK_DEVICES</code> instead of tailscaled.
                  </p>
                </AlertDescription>
              </Alert>
            )}
            {!settings.source && (
              <Alert>
                <AlertDescription>
                  <p>
                    tailscaled's socket isn't available. Share it with proxytail (<code className="font-mono">TS_SOCKET</code>
                    , see <code className="font-mono">docker-compose.yml</code>).
                  </p>
                </AlertDescription>
              </Alert>
            )}
            <Field
              id="backend-tag"
              label="Peer tag"
              hint={
                <>
                  Only peers with this tag are listed and can be targeted. Define it under{" "}
                  <code className="font-mono">tagOwners</code> in your tailnet policy.
                </>
              }
            >
              <Input
                id="backend-tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="tag:proxytail-backend"
                autoComplete="off"
                className="font-mono"
              />
            </Field>
          </CardContent>
          <CardFooter className="justify-between gap-2 border-t">
            <p className="text-xs text-muted-foreground">Values saved here override environment variables.</p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!!busy || !settings.configured}
                onClick={() => run("test", () => test())}
              >
                {busy === "test" ? <Loader2 className="animate-spin" /> : <Plug />} Test connection
              </Button>
              <Button type="submit" disabled={!!busy}>
                {busy === "save" && <Loader2 className="animate-spin" />} Save
              </Button>
            </div>
          </CardFooter>
        </Card>
      </form>

      <Card className="xl:col-start-1 xl:row-start-2">
        <CardHeader>
          <CardTitle>Traefik</CardTitle>
          <CardDescription>
            Traefik pulls its routing table from proxytail through the HTTP provider. It has to run inside the tailnet
            (see <code className="font-mono">docker-compose.yml</code>) to reach 100.x addresses.
          </CardDescription>
          <CardAction>
            {traefik?.reachable ? (
              <ToneBadge t="success">
                <span className="size-1.5 rounded-full bg-current" /> v{traefik.version}
              </ToneBadge>
            ) : (
              <ToneBadge t="danger">Unreachable</ToneBadge>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
              {providerSnippet}
            </pre>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-2"
              aria-label="Copy"
              onClick={() =>
                navigator.clipboard.writeText(providerSnippet).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          {traefik && !traefik.reachable && traefik.error && (
            <p className="text-xs text-muted-foreground">Status check failed: {traefik.error}</p>
          )}
        </CardContent>
        <CardFooter className="border-t">
          <Button variant="link" className="h-auto px-0" asChild>
            <a href="/api/traefik/config" target="_blank" rel="noreferrer">
              View generated config <ExternalLink />
            </a>
          </Button>
        </CardFooter>
      </Card>
      </div>
    </div>
  );
}
