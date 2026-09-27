import { useState, type FormEvent } from "react";
import { Check, Copy, ExternalLink, Loader2, Plug, Radar } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

function SecretInput(props: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  saved: boolean;
  placeholder: string;
  onClear: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Input
        id={props.id}
        type="password"
        autoComplete="off"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.saved ? "•••••••••••••••• (saved)" : props.placeholder}
        className="font-mono"
      />
      {props.saved && (
        <Button type="button" variant="outline" onClick={props.onClear}>
          Clear
        </Button>
      )}
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
  const [tailnet, setTailnet] = useState(settings.tailnet === "-" ? "" : settings.tailnet);
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState(settings.oauthClientId);
  const [clientSecret, setClientSecret] = useState("");
  const [method, setMethod] = useState(settings.oauthClientId ? "oauth" : "token");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [copied, setCopied] = useState(false);

  const test = async () => {
    const t = await api.testSettings();
    toast.success("Connected to Tailscale", { description: `Found ${t.devices} devices in your tailnet.` });
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
      const body: Record<string, string | null> = { tailnet: tailnet || null, oauthClientId: clientId || null };
      if (apiKey) body.apiKey = apiKey;
      if (clientSecret) body.oauthClientSecret = clientSecret;
      onSaved(await api.saveSettings(body));
      setApiKey("");
      setClientSecret("");
      toast.success("Settings saved");
      await test();
    });
  };

  const clear = (key: "apiKey" | "oauthClientSecret") =>
    run("save", async () => {
      onSaved(await api.saveSettings({ [key]: null }));
      toast.success("Credential cleared");
    });

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

  const endpoint = `${location.origin}/api/traefik/config`.replace(
    /\/\/(localhost|127\.0\.0\.1)/,
    "//host.docker.internal",
  );
  const providerSnippet = `providers:\n  http:\n    endpoint: "${endpoint}"\n    pollInterval: "5s"`;

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" description="Connect proxytail to your tailnet and Traefik." />

      <form onSubmit={savePublicAddress}>
        <Card className="mb-6">
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

      <form onSubmit={save}>
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Tailscale API</CardTitle>
            <CardDescription>Used to list devices and resolve their Tailscale IPs.</CardDescription>
            <CardAction>
              {settings.mock ? (
                <ToneBadge t="warning">Mock devices</ToneBadge>
              ) : settings.configured ? (
                <ToneBadge t="success">
                  <span className="size-1.5 rounded-full bg-current" /> Configured
                </ToneBadge>
              ) : (
                <ToneBadge t="muted">Not configured</ToneBadge>
              )}
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-6">
            {settings.mock && (
              <Alert>
                <AlertDescription>
                  Devices are loaded from <code className="font-mono">TS_MOCK_DEVICES</code>; credentials below are
                  ignored.
                </AlertDescription>
              </Alert>
            )}
            <Field id="tailnet" label="Tailnet" hint="Leave empty to use the default tailnet of the credentials.">
              <Input id="tailnet" value={tailnet} onChange={(e) => setTailnet(e.target.value)} placeholder="example.com" />
            </Field>

            <Tabs value={method} onValueChange={setMethod}>
              <TabsList className="mb-2">
                <TabsTrigger value="token">API access token</TabsTrigger>
                <TabsTrigger value="oauth">OAuth client</TabsTrigger>
              </TabsList>
              <TabsContent value="token">
                <Field
                  id="api-key"
                  label="Access token"
                  hint="Admin console → Settings → Keys. Tokens expire after at most 90 days."
                >
                  <SecretInput
                    id="api-key"
                    value={apiKey}
                    onChange={setApiKey}
                    saved={settings.apiKeySet}
                    placeholder="tskey-api-…"
                    onClear={() => clear("apiKey")}
                  />
                </Field>
              </TabsContent>
              <TabsContent value="oauth" className="grid gap-4">
                <Field id="client-id" label="Client ID">
                  <Input
                    id="client-id"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    autoComplete="off"
                    className="font-mono"
                  />
                </Field>
                <Field
                  id="client-secret"
                  label="Client secret"
                  hint={
                    <>
                      Needs the <code className="font-mono">devices:core:read</code> scope. Doesn't expire; takes
                      precedence over an access token.
                    </>
                  }
                >
                  <SecretInput
                    id="client-secret"
                    value={clientSecret}
                    onChange={setClientSecret}
                    saved={settings.oauthClientSecretSet}
                    placeholder="tskey-client-…"
                    onClear={() => clear("oauthClientSecret")}
                  />
                </Field>
              </TabsContent>
            </Tabs>
          </CardContent>
          <CardFooter className="justify-between gap-2 border-t">
            <p className="text-xs text-muted-foreground">Values saved here override environment variables.</p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!!busy || !settings.configured}
                onClick={() => run("test", test)}
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

      <Card>
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
  );
}
