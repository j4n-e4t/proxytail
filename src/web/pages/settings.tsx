import { useState, type FormEvent } from "react";
import {
  Activity,
  Check,
  Copy,
  ExternalLink,
  Gauge,
  Globe,
  Loader2,
  Plug,
  Radar,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TailscaleIcon, TraefikIcon } from "@/components/brand-icons";
import { PageHeader } from "@/components/page-header";
import { ToneBadge } from "@/components/status";
import { usePoll } from "@/hooks/use-poll";
import { api, type AccessLogStatus, type Device, type RateLimitView, type Settings, type TraefikStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { AccessLogCard } from "@/pages/access-log-settings";
import { RateLimitCard } from "@/pages/rate-limit-settings";

export type SettingsSection = "general" | "tailscale" | "traefik" | "rate-limiting" | "request-log";

type Tone = "success" | "warning" | "danger" | "muted";

/** The state of one system proxytail drives, for its tile and its entry in the section list. */
interface Health {
  tone: Tone;
  state: string;
  detail?: string;
}

const DOT: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/40",
};

function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span className={cn("size-2 shrink-0 rounded-full", DOT[tone], className)} />;
}

function Field(props: { id: string; label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      {props.children}
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
    </div>
  );
}

// --- Status ---

function tailscaleHealth(settings: Settings, devices: Device[] | null, error: string | null): Health {
  if (!settings.configured) return { tone: "muted", state: "Not configured", detail: "No OAuth client" };
  if (error) return { tone: "danger", state: "Error", detail: error };
  const peers = devices ? `${devices.length} ${devices.length === 1 ? "peer" : "peers"} tagged ${settings.backendTag}` : "…";
  if (settings.mock) return { tone: "warning", state: "Mock peers", detail: peers };
  return {
    tone: "success",
    state: settings.tailscaleVersion ? `v${settings.tailscaleVersion}` : "Connected",
    detail: peers,
  };
}

function traefikHealth(traefik: TraefikStatus | null): Health {
  if (!traefik) return { tone: "muted", state: "…" };
  if (!traefik.reachable) return { tone: "danger", state: "Unreachable", detail: traefik.error };
  const routers = Object.values(traefik.routers);
  const broken = routers.filter((r) => r.status !== "enabled").length;
  return {
    tone: broken ? "warning" : "success",
    state: `v${traefik.version}`,
    detail: broken
      ? `${broken} of ${routers.length} ${routers.length === 1 ? "service" : "services"} not routed`
      : `${routers.length} ${routers.length === 1 ? "service" : "services"} routed`,
  };
}

function rateLimitHealth(view: RateLimitView | null): Health {
  if (!view) return { tone: "muted", state: "…" };
  if (!view.config.enabled) return { tone: "muted", state: "Off" };
  if (view.traefik?.errors.length) return { tone: "danger", state: "Traefik error", detail: view.traefik.errors[0] };
  const rate = `${view.config.average} per ${{ "1s": "second", "1m": "minute", "1h": "hour" }[view.config.period]}`;
  if (view.config.store === "valkey") {
    const v = view.valkey;
    if (view.activeStore !== "valkey") return { tone: "warning", state: "Valkey down", detail: "Counting in Traefik's memory" };
    return { tone: "success", state: `${v?.server ?? "Valkey"} ${v?.version ? `v${v.version}` : ""}`.trim(), detail: rate };
  }
  return { tone: "success", state: "In Traefik's memory", detail: rate };
}

function requestLogHealth(status: AccessLogStatus | null): Health {
  if (!status) return { tone: "muted", state: "…" };
  if (status.state === "error") return { tone: "danger", state: "Error", detail: status.error };
  const stored = `${status.entries.toLocaleString()} stored, ${status.retentionDays} days`;
  if (status.state === "missing") return { tone: "warning", state: "No log yet", detail: stored };
  if (status.truncateError) return { tone: "warning", state: "Can't empty the file", detail: stored };
  return { tone: "success", state: "Reading", detail: stored };
}

function StatusTile(props: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  health: Health;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      onClick={props.onClick}
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-xl border bg-card p-4 text-left shadow-xs transition-colors hover:bg-muted/40",
        props.active && "border-primary/40 ring-1 ring-primary/30",
      )}
    >
      <div className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
        <Icon className="size-4 text-foreground/80" />
        <Dot tone={props.health.tone} className="absolute -right-0.5 -bottom-0.5 ring-2 ring-card" />
      </div>
      <div className="min-w-0 leading-tight">
        <p className="text-xs text-muted-foreground">{props.label}</p>
        <p className="mt-0.5 truncate text-sm font-medium">{props.health.state}</p>
        {props.health.detail && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={props.health.detail}>
            {props.health.detail}
          </p>
        )}
      </div>
    </button>
  );
}

// --- Sections ---

function PublicAddressCard({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const [value, setValue] = useState(settings.publicAddress);
  const [busy, setBusy] = useState<"save" | "detect" | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("save");
    try {
      onSaved(await api.saveSettings({ publicAddress: value.trim() || null }));
      toast.success("Public address saved", { description: "Re-check your domains if it changed." });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const detect = async () => {
    setBusy("detect");
    try {
      setValue((await api.detectIp()).ip);
    } catch (e) {
      toast.error("Couldn't detect public IP", { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <form onSubmit={save}>
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
            hint="Domains are verified by checking that *.domain resolves to this address. It also identifies the proxy host in your tailnet, for its Tailscale version."
          >
            <div className="flex gap-2">
              <Input
                id="public-address"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="203.0.113.10 or proxy.example.com"
                className="font-mono"
              />
              <Button type="button" variant="outline" onClick={detect} disabled={!!busy}>
                {busy === "detect" ? <Loader2 className="animate-spin" /> : <Radar />} Detect
              </Button>
            </div>
          </Field>
        </CardContent>
        <CardFooter className="justify-end border-t">
          <Button type="submit" disabled={!!busy || value.trim() === settings.publicAddress}>
            {busy === "save" && <Loader2 className="animate-spin" />} Save
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

function TailscaleCard(props: {
  settings: Settings;
  health: Health;
  devicesError: string | null;
  onSaved: (s: Settings) => void;
}) {
  const { settings } = props;
  const [tag, setTag] = useState(settings.backendTag);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);

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
      props.onSaved(saved);
      setTag(saved.backendTag);
      toast.success("Settings saved");
      await test(saved.backendTag);
    });
  };

  return (
    <form onSubmit={save}>
      <Card>
        <CardHeader>
          <CardTitle>Tailscale</CardTitle>
          <CardDescription>
            Peers are listed through the Tailscale API with a read-only OAuth client (scope{" "}
            <code className="font-mono">devices:core:read</code>).
          </CardDescription>
          <CardAction>
            <ToneBadge t={props.health.tone}>
              {props.health.tone === "success" && <span className="size-1.5 rounded-full bg-current" />}
              {props.health.state}
            </ToneBadge>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4">
          {settings.mock && (
            <Alert>
              <AlertDescription>
                <p>
                  Peers are loaded from <code className="font-mono">TS_MOCK_DEVICES</code> instead of the Tailscale API.
                </p>
              </AlertDescription>
            </Alert>
          )}
          {!settings.configured && (
            <Alert>
              <AlertDescription>
                <p>
                  No OAuth client is configured. Create one with the{" "}
                  <code className="font-mono">devices:core:read</code> scope and set{" "}
                  <code className="font-mono">TS_OAUTH_CLIENT_ID</code> and{" "}
                  <code className="font-mono">TS_OAUTH_CLIENT_SECRET</code>.
                </p>
              </AlertDescription>
            </Alert>
          )}
          {props.devicesError && (
            <Alert variant="destructive">
              <AlertTitle>Couldn't list peers</AlertTitle>
              <AlertDescription>{props.devicesError}</AlertDescription>
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
          {settings.configured && !settings.tailscaleVersion && !settings.mock && (
            <p className="text-xs text-muted-foreground">
              The proxy host's own Tailscale version shows once its public address is set under General and matches one
              of its endpoints.
            </p>
          )}
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
  );
}

function TraefikCard({ traefik, health }: { traefik: TraefikStatus | null; health: Health }) {
  const [copied, setCopied] = useState(false);
  // Traefik polls proxytail over the Docker network (docker-compose.yml), or the host in development.
  const endpoint = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? `${location.origin}/api/traefik/config`.replace(/\/\/(localhost|127\.0\.0\.1)/, "//host.docker.internal")
    : "http://app:3000/api/traefik/config";
  const snippet = `providers:\n  http:\n    endpoint: "${endpoint}"\n    pollInterval: "5s"`;
  const broken = Object.entries(traefik?.routers ?? {}).filter(([, r]) => r.status !== "enabled");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Traefik</CardTitle>
        <CardDescription>
          Traefik pulls its routing table from proxytail through the HTTP provider, and reaches 100.x addresses through
          the host's Tailscale (see <code className="font-mono">docker-compose.yml</code>).
        </CardDescription>
        <CardAction>
          <ToneBadge t={health.tone}>
            {health.tone === "success" && <span className="size-1.5 rounded-full bg-current" />}
            {health.state}
          </ToneBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        {traefik && !traefik.reachable && (
          <Alert variant="destructive">
            <AlertTitle>Traefik's API is unreachable</AlertTitle>
            <AlertDescription>{traefik.error}</AlertDescription>
          </Alert>
        )}
        {broken.length > 0 && (
          <Alert>
            <AlertTitle>
              {broken.length} {broken.length === 1 ? "service isn't" : "services aren't"} routed
            </AlertTitle>
            <AlertDescription>
              <p>{[...new Set(broken.flatMap(([, r]) => r.errors ?? []))].join(" ") || "See the Services page."}</p>
            </AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-2">
          <Label>HTTP provider</Label>
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
              {snippet}
            </pre>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-2 right-2"
              aria-label="Copy"
              onClick={() =>
                navigator.clipboard.writeText(snippet).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            docker-compose.yml already sets this up. Traefik picks up changes within about 5 seconds.
          </p>
        </div>
      </CardContent>
      <CardFooter className="border-t">
        <Button variant="link" className="h-auto px-0" asChild>
          <a href="/api/traefik/config" target="_blank" rel="noreferrer">
            View generated config <ExternalLink />
          </a>
        </Button>
      </CardFooter>
    </Card>
  );
}

// --- Page ---

const SECTIONS: { id: SettingsSection; label: string; icon: React.ComponentType<{ className?: string }>; hint: string }[] =
  [
    { id: "general", label: "General", icon: Globe, hint: "Public address" },
    { id: "tailscale", label: "Tailscale", icon: TailscaleIcon, hint: "Peers and tag" },
    { id: "traefik", label: "Traefik", icon: TraefikIcon, hint: "Routing" },
    { id: "rate-limiting", label: "Rate limiting", icon: Gauge, hint: "Requests per client" },
    { id: "request-log", label: "Request log", icon: Activity, hint: "Retention" },
  ];

export function SettingsPage(props: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  settings: Settings;
  traefik: TraefikStatus | null;
  devices: Device[] | null;
  devicesError: string | null;
  onSaved: (s: Settings) => void;
}) {
  const rateLimit = usePoll(api.rateLimit, 15_000);
  const accessLog = usePoll(api.accessLog, 15_000);

  const health: Record<SettingsSection, Health> = {
    general: props.settings.publicAddress
      ? { tone: "success", state: props.settings.publicAddress }
      : { tone: "warning", state: "No public address" },
    tailscale: tailscaleHealth(props.settings, props.devices, props.devicesError),
    traefik: traefikHealth(props.traefik),
    "rate-limiting": rateLimitHealth(rateLimit.data),
    "request-log": requestLogHealth(accessLog.data),
  };

  const section = props.section;
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <>
      <PageHeader title="Settings" description="The systems proxytail drives, and how it handles your traffic." />

      {/* Health of everything proxytail depends on; each tile opens its section. */}
      <div className="mb-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SECTIONS.filter((s) => s.id !== "general").map((s) => (
          <StatusTile
            key={s.id}
            icon={s.icon}
            label={s.label}
            health={health[s.id]}
            active={section === s.id}
            onClick={() => props.onSection(s.id)}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start">
        <nav aria-label="Settings" className="flex gap-1 overflow-x-auto lg:sticky lg:top-8 lg:flex-col">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                onClick={() => props.onSection(s.id)}
                aria-current={section === s.id ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  section === s.id
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block">{s.label}</span>
                  <span className="hidden truncate text-xs font-normal text-muted-foreground lg:block">{s.hint}</span>
                </span>
                <Dot tone={health[s.id].tone} className="hidden lg:block" />
              </button>
            );
          })}
        </nav>

        <section aria-label={current.label} className="grid min-w-0 max-w-4xl grid-cols-1 gap-6">
          {section === "general" && <PublicAddressCard settings={props.settings} onSaved={props.onSaved} />}
          {section === "tailscale" && (
            <TailscaleCard
              settings={props.settings}
              health={health.tailscale}
              devicesError={props.devicesError}
              onSaved={props.onSaved}
            />
          )}
          {section === "traefik" && <TraefikCard traefik={props.traefik} health={health.traefik} />}
          {section === "rate-limiting" && <RateLimitCard onChanged={rateLimit.setData} />}
          {section === "request-log" && <AccessLogCard onChanged={accessLog.setData} />}
        </section>
      </div>
    </>
  );
}

export const isSettingsSection = (s: string | undefined): s is SettingsSection =>
  SECTIONS.some((x) => x.id === s);
