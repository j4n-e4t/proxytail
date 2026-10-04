import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ChevronDown,
  Gauge,
  Globe,
  Monitor,
  MonitorSmartphone,
  Moon,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Waypoints,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import { useTheme, type Theme } from "@/lib/theme";
import { ClientCasPage } from "@/pages/client-cas";
import { PeersPage } from "@/pages/peers";
import { RateLimitingPage } from "@/pages/rate-limiting";
import { RequestsPage } from "@/pages/requests";
import { ServiceEditorDialog } from "@/pages/service-editor";
import { DomainsPage } from "@/pages/domains";
import { HostsPage } from "@/pages/hosts";
import { isSettingsSection, SettingsPage } from "@/pages/settings";
import "./globals.css";

type Page = "services" | "requests" | "domains" | "client-cas" | "peers" | "rate-limiting" | "settings";
const PAGES: Page[] = ["services", "requests", "domains", "client-cas", "peers", "rate-limiting", "settings"];

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

type NavIcon = React.ComponentType<{ className?: string }>;

/** A sidebar entry. */
interface NavEntry {
  /** The page, also the hash it opens. */
  target: Page;
  label: string;
  icon: NavIcon;
  count?: number;
}

interface NavGroupDef {
  id: string;
  label: string;
  items: NavEntry[];
}

const COLLAPSED_KEY = "proxytail.sidebar.collapsed";

function loadCollapsed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Whether the sidebar was left open, from the cookie SidebarProvider writes. */
function sidebarOpenByDefault() {
  return !document.cookie.split("; ").includes("sidebar_state=false");
}

function NavItem(props: { item: NavEntry; active: boolean; onClick: () => void }) {
  const { icon: Icon, label, count } = props.item;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={props.active}
        tooltip={label}
        onClick={props.onClick}
        aria-current={props.active ? "page" : undefined}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
      {count !== undefined && <SidebarMenuBadge>{count}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
}

/** A titled group of entries that folds away from its label. */
function NavGroup(props: {
  group: NavGroupDef;
  open: boolean;
  active: Page;
  onToggle: () => void;
  onNavigate: (target: Page) => void;
}) {
  const { group } = props;
  return (
    <Collapsible open={props.open} onOpenChange={props.onToggle} className="group/collapsible">
      <SidebarGroup>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger>
            {group.label}
            <ChevronDown className="ml-auto transition-transform group-data-[state=closed]/collapsible:-rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => (
                <NavItem
                  key={item.target}
                  item={item}
                  active={props.active === item.target}
                  onClick={() => props.onNavigate(item.target)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

function Brand() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" asChild>
          <a href="#services">
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
              <Waypoints className="size-4" />
            </div>
            <span className="font-semibold tracking-tight">proxytail</span>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="flex items-center justify-between px-2 py-1 group-data-[collapsible=icon]:hidden">
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
  const hosts = usePoll(api.hosts, 0);
  // Polled for the proxy host's Tailscale version on the Settings page, known once devices have been listed.
  const settings = usePoll(api.settings, 30_000);
  const domains = usePoll(api.domains, 0);
  const clientCas = usePoll(api.clientCas, 0);
  const traefik = usePoll(api.traefik, 5000);
  const devices = usePoll(
    useCallback(() => api.devices(), []),
    30_000,
  );

  const navGroups: NavGroupDef[] = [
    {
      id: "proxy",
      label: "Proxy",
      items: [
        { target: "services", label: "Services", icon: Waypoints, count: hosts.data?.length },
        { target: "domains", label: "Domains", icon: Globe, count: domains.data?.length },
        { target: "peers", label: "Peers", icon: MonitorSmartphone, count: devices.data?.length },
      ],
    },
    {
      id: "security",
      label: "Security",
      items: [
        { target: "client-cas", label: "Client CAs", icon: ShieldCheck, count: clientCas.data?.length },
        { target: "rate-limiting", label: "Rate limiting", icon: Gauge },
      ],
    },
    {
      id: "monitoring",
      label: "Monitoring",
      items: [
        { target: "requests", label: "Requests", icon: Activity },
      ],
    },
  ];

  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsed);
  const toggleGroup = (id: string) =>
    setCollapsed((c) => {
      const next = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // Storage unavailable (e.g. private mode): the choice lasts until reload.
      }
      return next;
    });
  // Navigating into a collapsed group (e.g. from a link on a page) opens it, so the current page is always visible.
  const activeGroup = navGroups.find((g) => g.items.some((i) => i.target === page))?.id;
  useEffect(() => {
    if (activeGroup && collapsed.includes(activeGroup)) toggleGroup(activeGroup);
    // Only when the page changes, so collapsing the current group by hand sticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

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
    <SidebarProvider defaultOpen={sidebarOpenByDefault()}>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <Brand />
        </SidebarHeader>

        <SidebarContent>
          {navGroups.map((g) => (
            <NavGroup
              key={g.id}
              group={g}
              open={!collapsed.includes(g.id)}
              active={page}
              onToggle={() => toggleGroup(g.id)}
              onNavigate={navigate}
            />
          ))}
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            {/* Settings has its own sidebar for its sections, so it's a single entry here. */}
            <NavItem
              item={{ target: "settings", label: "Settings", icon: SlidersHorizontal }}
              active={page === "settings"}
              onClick={() => setPage("settings")}
            />
          </SidebarMenu>
          <ThemeToggle />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-w-0">
        <header className="flex h-12 shrink-0 items-center border-b px-4">
          <SidebarTrigger className="-ml-1" />
        </header>
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
          {page === "rate-limiting" && <RateLimitingPage />}
          {page === "settings" && settings.data && (
            <SettingsPage
              section={isSettingsSection(route.sub) ? route.sub : "general"}
              onSection={(s) => navigate(s === "general" ? "settings" : `settings/${s}`)}
              settings={settings.data}
              traefik={traefik.data}
              devices={devices.data}
              devicesError={devices.error}
              onSaved={(s) => {
                settings.setData(s);
                devices.reload();
                domains.reload();
              }}
            />
          )}
        </div>
      </SidebarInset>

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
    </SidebarProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider delayDuration={200}>
    <App />
    <Toaster position="bottom-right" />
  </TooltipProvider>,
);
