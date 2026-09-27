import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Globe,
  Monitor,
  MonitorSmartphone,
  Moon,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldAlert,
  Sun,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TailscaleIcon, TraefikIcon } from "@/components/brand-icons";
import { StatusDot } from "@/components/status";
import { usePoll } from "@/hooks/use-poll";
import { api, type Me } from "@/lib/api";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { PeersPage } from "@/pages/peers";
import { ServiceEditorPage } from "@/pages/service-editor";
import { DomainsPage } from "@/pages/domains";
import { HostsPage } from "@/pages/hosts";
import { SettingsPage } from "@/pages/settings";
import "./globals.css";

type Page = "services" | "domains" | "peers" | "settings";
const PAGES: Page[] = ["services", "domains", "peers", "settings"];

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
    const onHash = () => {
      setRoute(read());
      scrollTo(0, 0);
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
      <div className="leading-tight">
        <p className="font-semibold tracking-tight">proxytail</p>
        <p className="text-[11px] text-muted-foreground">Tailscale × Traefik</p>
      </div>
    </div>
  );
}

function Avatar({ me }: { me: Me }) {
  const id = me.identity!;
  return id.profilePicUrl ? (
    <img src={id.profilePicUrl} alt="" className="size-7 shrink-0 rounded-full border" referrerPolicy="no-referrer" />
  ) : (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-medium uppercase">
      {id.name.slice(0, 1)}
    </div>
  );
}

function CurrentUser({ me }: { me: Me }) {
  if (me.authDisabled)
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-warning" title="UI_AUTH">
        <ShieldAlert className="size-3.5" /> Authentication bypassed
      </div>
    );
  if (!me.identity) return null;
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5" title={`${me.identity.login} on ${me.identity.device}`}>
      <Avatar me={me} />
      <div className="min-w-0 leading-tight">
        <p className="truncate text-xs font-medium">{me.identity.name}</p>
        <p className="truncate text-xs text-muted-foreground">{me.role === "admin" ? "Admin" : "Read-only"}</p>
      </div>
    </div>
  );
}

/** Shown when the caller has no role: explains the grant that gives them one. */
function AccessDenied({ me, onRetry }: { me: Me; onRetry: () => void }) {
  const grant = JSON.stringify(
    {
      grants: [
        {
          src: [me.identity && !me.identity.login.includes("tag:") ? me.identity.login : "group:admins"],
          dst: ["tag:proxytail"],
          app: { [me.capability]: [{ role: "admin" }] },
        },
      ],
    },
    null,
    2,
  );
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle>No access to proxytail</CardTitle>
          <CardDescription>
            {me.identity ? (
              <>
                Signed in as <span className="font-medium text-foreground">{me.identity.login}</span> on{" "}
                {me.identity.device}.{" "}
              </>
            ) : null}
            {me.reason}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Access is granted in your tailnet policy file. Add a grant like this, with <code>dst</code> set to the
            proxytail node's tag, and use <code>"viewer"</code> for read-only access:
          </p>
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">{grant}</pre>
        </CardContent>
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
  const me = usePoll(api.me, 0);
  if (!me.data) {
    if (!me.error) return null;
    return (
      <AccessDenied me={{ identity: null, role: null, reason: me.error, capability: "", authDisabled: false }} onRetry={me.reload} />
    );
  }
  if (!me.data.role) return <AccessDenied me={me.data} onRetry={me.reload} />;
  return <Console me={me.data} />;
}

function Console({ me }: { me: Me }) {
  const [route, navigate] = useRoute();
  const { page } = route;
  const setPage = (p: Page) => navigate(p);
  const { theme, setTheme } = useTheme();
  const hosts = usePoll(api.hosts, 0);
  const settings = usePoll(api.settings, 0);
  const domains = usePoll(api.domains, 0);
  const traefik = usePoll(api.traefik, 5000);
  const devices = usePoll(
    useCallback(() => api.devices(), []),
    30_000,
  );

  const refreshHosts = () => {
    hosts.reload();
    domains.reload();
    traefik.reload();
  };

  const configured = !!settings.data?.configured;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r bg-sidebar">
        <Brand />

        {/* Connection state of the two systems proxytail drives, right under the brand. */}
        <div className="space-y-0.5 border-b px-3 pb-3">
          <ServiceStatus
            icon={TailscaleIcon}
            ok={configured && !devices.error}
            label="Tailscale"
            detail={
              !configured
                ? "Not configured"
                : devices.error
                  ? "Error"
                  : `${devices.data?.filter((d) => d.online).length ?? "…"} ${devices.data?.filter((d) => d.online).length === 1 ? "peer" : "peers"} online`
            }
            title={devices.error ?? undefined}
          />
          <ServiceStatus
            icon={TraefikIcon}
            ok={!!traefik.data?.reachable}
            label="Traefik"
            detail={traefik.data?.reachable ? `v${traefik.data.version} · connected` : "Unreachable"}
            title={traefik.data?.error}
          />
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          <NavItem
            icon={Waypoints}
            label="Services"
            count={hosts.data?.length}
            active={page === "services"}
            onClick={() => setPage("services")}
          />
          <NavItem
            icon={Globe}
            label="Domains"
            count={domains.data?.length}
            active={page === "domains"}
            onClick={() => setPage("domains")}
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
          <CurrentUser me={me} />
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
        <div className="max-w-screen-2xl px-6 py-8 lg:px-10">
          {page === "services" && !route.sub && (
            <HostsPage
              hosts={hosts.data}
              devices={devices.data ?? []}
              traefik={traefik.data}
              onNew={() => navigate("services/new")}
              onEdit={(h) => navigate(`services/${h.id}`)}
              onChanged={refreshHosts}
            />
          )}
          {page === "services" && route.sub && (
            <ServiceEditorPage
              key={route.sub}
              hostId={route.sub === "new" ? null : Number(route.sub)}
              initialDeviceId={route.params.get("peer") ?? undefined}
              hosts={hosts.data}
              devices={devices.data ?? []}
              peerTag={settings.data?.backendTag ?? ""}
              domains={domains.data}
              traefik={traefik.data}
              onOpenDomains={() => setPage("domains")}
              onCancel={() => setPage("services")}
              onSaved={() => {
                refreshHosts();
                setPage("services");
              }}
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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider delayDuration={200}>
    <App />
    <Toaster position="bottom-right" />
  </TooltipProvider>,
);
