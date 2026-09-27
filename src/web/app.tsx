import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Globe, Monitor, MonitorSmartphone, Moon, Settings as SettingsIcon, Sun, Waypoints, type LucideIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HostDialog, type HostDialogInitial } from "@/components/host-dialog";
import { StatusDot } from "@/components/status";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { DevicesPage } from "@/pages/devices";
import { DomainsPage } from "@/pages/domains";
import { HostsPage } from "@/pages/hosts";
import { SettingsPage } from "@/pages/settings";
import "./globals.css";

type Page = "services" | "domains" | "devices" | "settings";
const PAGES: Page[] = ["services", "domains", "devices", "settings"];

function usePage() {
  const read = () => {
    const p = location.hash.slice(1) as Page;
    return PAGES.includes(p) ? p : "services";
  };
  const [page, setPage] = useState<Page>(read);
  useEffect(() => {
    const onHash = () => setPage(read());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return [page, (p: Page) => (location.hash = p)] as const;
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

function ServiceStatus(props: { ok: boolean; label: string; detail: string; title?: string }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5" title={props.title}>
      <StatusDot status={props.ok ? "online" : "offline"} className={cn(!props.ok && "[&>span]:bg-destructive")} />
      <div className="min-w-0 leading-tight">
        <p className="text-xs font-medium">{props.label}</p>
        <p className="truncate text-xs text-muted-foreground">{props.detail}</p>
      </div>
    </div>
  );
}

function App() {
  const [page, setPage] = usePage();
  const { theme, setTheme } = useTheme();
  const hosts = usePoll(api.hosts, 0);
  const settings = usePoll(api.settings, 0);
  const domains = usePoll(api.domains, 0);
  const traefik = usePoll(api.traefik, 5000);
  const devices = usePoll(
    useCallback(() => api.devices(), []),
    30_000,
  );
  const [editing, setEditing] = useState<HostDialogInitial | null>(null);

  const refreshHosts = () => {
    hosts.reload();
    domains.reload();
    traefik.reload();
  };

  const configured = !!settings.data?.configured;

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Waypoints className="size-4" />
          </div>
          <div className="leading-tight">
            <p className="font-semibold tracking-tight">proxytail</p>
            <p className="text-[11px] text-muted-foreground">Tailscale × Traefik</p>
          </div>
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
            label="Devices"
            count={devices.data?.length}
            active={page === "devices"}
            onClick={() => setPage("devices")}
          />
          <NavItem
            icon={SettingsIcon}
            label="Settings"
            active={page === "settings"}
            onClick={() => setPage("settings")}
          />
        </nav>

        <div className="space-y-1 border-t p-3">
          <ServiceStatus
            ok={configured && !devices.error}
            label="Tailscale"
            detail={
              !configured
                ? "Not configured"
                : devices.error
                  ? "API error"
                  : `${devices.data?.filter((d) => d.online).length ?? "…"} devices online`
            }
            title={devices.error ?? undefined}
          />
          <ServiceStatus
            ok={!!traefik.data?.reachable}
            label="Traefik"
            detail={traefik.data?.reachable ? `v${traefik.data.version} · connected` : "Unreachable"}
            title={traefik.data?.error}
          />
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
        <div className="mx-auto max-w-6xl px-8 py-8">
          {page === "services" && (
            <HostsPage
              hosts={hosts.data}
              devices={devices.data ?? []}
              traefik={traefik.data}
              onNew={() => setEditing({})}
              onEdit={setEditing}
              onChanged={refreshHosts}
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
          {page === "devices" && (
            <DevicesPage
              devices={devices.data}
              error={devices.error}
              configured={configured}
              hosts={hosts.data ?? []}
              onRefresh={async () => devices.setData(await api.devices(true))}
              onExpose={(d) => {
                setEditing({ deviceId: d.id });
              }}
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

      <HostDialog
        initial={editing}
        devices={devices.data ?? []}
        domains={domains.data ?? []}
        onOpenDomains={() => {
          setEditing(null);
          setPage("domains");
        }}
        onOpenChange={(open) => !open && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refreshHosts();
        }}
      />
      <Toaster position="bottom-right" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider delayDuration={200}>
    <App />
  </TooltipProvider>,
);
