import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Database,
  Globe,
  Monitor,
  MonitorSmartphone,
  Moon,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TailscaleIcon, TraefikIcon } from "@/components/brand-icons";
import { StatusDot } from "@/components/status";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { ClientCasPage } from "@/pages/client-cas";
import { PeersPage } from "@/pages/peers";
import { RequestsPage } from "@/pages/requests";
import { ServiceEditorDialog } from "@/pages/service-editor";
import { DomainsPage } from "@/pages/domains";
import { HostsPage } from "@/pages/hosts";
import { SettingsPage } from "@/pages/settings";
import "./globals.css";

type Page = "services" | "requests" | "domains" | "client-cas" | "peers" | "settings";
const PAGES: Page[] = ["services", "requests", "domains", "client-cas", "peers", "settings"];

interface Route {
  page: Page;
  /** Path below the page, e.g. "new" or "12" in `#services/12`. */
  sub?: string;
  params: URLSearchParams;
}

/** Hash routing: `#page[/sub][?query]`. */
function useRoute() {
  const read = (): Route => {
    const [path = "", query] = location.hash.slice(1).split("?");
    const [p, sub] = path.split("/") as [Page, string | undefined];
    if (!PAGES.includes(p)) return { page: "services", params: new URLSearchParams() };
    return { page: p, sub, params: new URLSearchParams(query) };
  };
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const onHash = (e: HashChangeEvent) => {
      const next = read();
      // Opening or closing the service editor keeps the list where it was.
      if (new URL(e.oldURL).hash.slice(1).split(/[/?]/)[0] !== next.page) scrollTo(0, 0);
      setRoute(next);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return [route, (hash: string) => (location.hash = hash)] as const;
}

function NavItem(props: { icon: LucideIcon; label: string; active: boolean; count?: number; onClick: () => void }) {
  const Icon = props.icon;
  return (
    <button
      onClick={props.onClick}
      className={cn(
        "flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
        props.active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon className={cn("size-4", props.active && "text-primary")} />
      {props.label}
      {props.count !== undefined && (
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{props.count}</span>
      )}
    </button>
  );
}

function ServiceStatus(props: {
  icon: React.ComponentType<{ className?: string }>;
  ok: boolean;
  label: string;
  detail: string;
  title?: string;
}) {
  const Icon = props.icon;
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5" title={props.title}>
      <div className="relative flex size-7 shrink-0 items-center justify-center rounded-md border bg-background">
        <Icon className="size-3.5 text-foreground/80" />
        <StatusDot
          status={props.ok ? "online" : "offline"}
          className={cn(
            "absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-sidebar",
            !props.ok && "[&>span]:bg-destructive",
          )}
        />
      </div>
      <div className="min-w-0 leading-tight">
        <p className="text-xs font-medium">{props.label}</p>
        <p className="truncate text-xs text-muted-foreground">{props.detail}</p>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex h-16 items-center gap-2.5 px-5">
      <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <Waypoints className="size-4" />
      </div>
      <p className="font-semibold tracking-tight">proxytail</p>
    </div>
  );
}

/** Shown when the UI can't load its data, e.g. when opened under a hostname that isn't allowed. */
function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle>Can't open proxytail</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
        <CardFooter className="justify-end border-t">
          <Button variant="outline" onClick={onRetry}>
            <RefreshCw /> Retry
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function App() {
  const settings = usePoll(api.settings, 0);
  if (!settings.data) return settings.error ? <LoadError error={settings.error} onRetry={settings.reload} /> : null;
  return <Console />;
}

function Console() {
  const [route, navigate] = useRoute();
  const page = route.page;
  const setPage = (p: Page) => navigate(p);
  const { theme, setTheme } = useTheme();
  const hosts = usePoll(api.hosts, 0);
  // Polled for the proxy host's Tailscale version, known once devices have been listed.
  const settings = usePoll(api.settings, 30_000);
  const domains = usePoll(api.domains, 0);
  const clientCas = usePoll(api.clientCas, 0);
  const traefik = usePoll(api.traefik, 5000);
  const rateLimit = usePoll(api.rateLimit, 30_000);
  const valkey = rateLimit.data?.config.enabled && rateLimit.data.config.store === "valkey" ? rateLimit.data.valkey : null;
  const devices = usePoll(
    useCallback(() => api.devices(), []),
    30_000,
  );

  const refreshHosts = () => {
    hosts.reload();
    domains.reload();
    clientCas.reload();
    traefik.reload();
  };

  const configured = !!settings.data?.configured;

  // `#services/new` and `#services/<id>` open the editor over the list. The last one stays rendered while it closes.
  const editorOpen = page === "services" && !!route.sub;
  const lastEditor = useRef({ sub: "new", params: new URLSearchParams() });
  if (editorOpen) lastEditor.current = { sub: route.sub!, params: route.params };
  const editor = lastEditor.current;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r bg-sidebar">
        <Brand />

        <nav className="flex-1 space-y-1 px-3 py-2">
          <NavItem
            icon={Waypoints}
            label="Services"
            count={hosts.data?.length}
            active={page === "services"}
            onClick={() => setPage("services")}
          />
          <NavItem
            icon={Activity}
            label="Requests"
            active={page === "requests"}
            onClick={() => setPage("requests")}
          />
          <NavItem
            icon={Globe}
            label="Domains"
            count={domains.data?.length}
            active={page === "domains"}
            onClick={() => setPage("domains")}
          />
          <NavItem
            icon={ShieldCheck}
            label="Client CAs"
            count={clientCas.data?.length}
            active={page === "client-cas"}
            onClick={() => setPage("client-cas")}
          />
          <NavItem
            icon={MonitorSmartphone}
            label="Peers"
            count={devices.data?.length}
            active={page === "peers"}
            onClick={() => setPage("peers")}
          />
          <NavItem
            icon={SettingsIcon}
            label="Settings"
            active={page === "settings"}
            onClick={() => setPage("settings")}
          />
        </nav>

        <div className="space-y-1 border-t p-3">
          {/* Connection state of the systems proxytail drives. */}
          <div className="space-y-0.5">
            <ServiceStatus
              icon={TailscaleIcon}
              ok={configured && !devices.error}
              label="Tailscale"
              detail={
                !configured
                  ? "Not configured"
                  : devices.error
                    ? "Error"
                    : settings.data?.tailscaleVersion
                      ? `v${settings.data.tailscaleVersion}`
                      : "Connected"
              }
              title={devices.error ?? undefined}
            />
            <ServiceStatus
              icon={TraefikIcon}
              ok={!!traefik.data?.reachable}
              label="Traefik"
              detail={traefik.data?.reachable ? `v${traefik.data.version}` : "Unreachable"}
              title={traefik.data?.error}
            />
            {/* Only while rate limiting counts in Valkey. */}
            {valkey && (
              <ServiceStatus
                icon={Database}
                ok={valkey.reachable && !valkey.error}
                label={valkey.server ?? "Valkey"}
                detail={!valkey.reachable ? "Unreachable" : valkey.error ? "Error" : valkey.version ? `v${valkey.version}` : "Connected"}
                title={valkey.error}
              />
            )}
          </div>
          <div className="flex items-center justify-between px-3 pt-2">
            <span className="text-xs text-muted-foreground">Theme</span>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={theme}
              onValueChange={(v) => v && setTheme(v as Theme)}
              aria-label="Theme"
            >
              {(
                [
                  ["light", Sun, "Light"],
                  ["dark", Moon, "Dark"],
                  ["system", Monitor, "System"],
                ] as const
              ).map(([value, Icon, label]) => (
                <ToggleGroupItem key={value} value={value} aria-label={label} title={label} className="px-2">
                  <Icon className="size-3.5" />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="px-6 py-8 lg:px-10">
          {page === "services" && (
            <HostsPage
              hosts={hosts.data}
              devices={devices.data ?? []}
              traefik={traefik.data}
              onNew={() => navigate("services/new")}
              onEdit={(h) => navigate(`services/${h.id}`)}
              onViewRequests={(h) => navigate(`requests?service=${h.id}`)}
              onChanged={refreshHosts}
            />
          )}
          {page === "requests" && (
            <RequestsPage
              // A new link from a service starts over with that service's filter.
              key={route.params.get("service") ?? ""}
              hosts={hosts.data ?? []}
              initialService={route.params.get("service") ?? undefined}
            />
          )}
          {page === "domains" && (
            <DomainsPage
              domains={domains.data}
              publicAddress={settings.data?.publicAddress ?? ""}
              onChanged={() => {
                domains.reload();
                hosts.reload();
              }}
              onOpenSettings={() => setPage("settings")}
            />
          )}
          {page === "client-cas" && (
            <ClientCasPage
              cas={clientCas.data}
              hosts={hosts.data ?? []}
              onChanged={clientCas.reload}
              onOpenService={(id) => navigate(`services/${id}`)}
            />
          )}
          {page === "peers" && (
            <PeersPage
              devices={devices.data}
              tag={settings.data?.backendTag ?? ""}
              error={devices.error}
              configured={configured}
              hosts={hosts.data ?? []}
              onRefresh={async () => devices.setData(await api.devices(true))}
              onExpose={(d) => navigate(`services/new?peer=${encodeURIComponent(d.id)}`)}
              onOpenSettings={() => setPage("settings")}
            />
          )}
          {page === "settings" && settings.data && (
            <SettingsPage
              settings={settings.data}
              traefik={traefik.data}
              onSaved={(s) => {
                settings.setData(s);
                devices.reload();
                domains.reload();
              }}
            />
          )}
        </div>
      </main>

      <ServiceEditorDialog
        open={editorOpen}
        hostId={editor.sub === "new" ? null : Number(editor.sub)}
        initialDeviceId={editor.params.get("peer") ?? undefined}
        hosts={hosts.data}
        devices={devices.data ?? []}
        peerTag={settings.data?.backendTag ?? ""}
        domains={domains.data}
        clientCas={clientCas.data}
        traefik={traefik.data}
        onOpenDomains={() => setPage("domains")}
        onOpenClientCas={() => setPage("client-cas")}
        onCancel={() => setPage("services")}
        onSaved={() => {
          refreshHosts();
          setPage("services");
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider delayDuration={200}>
    <App />
    <Toaster position="bottom-right" />
  </TooltipProvider>,
);
