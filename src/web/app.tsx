import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  BotOff,
  ChevronDown,
  Gauge,
  Globe,
  KeyRound,
  Monitor,
  MonitorSmartphone,
  Moon,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Waypoints,
} from "lucide-react";
import { TailscaleIcon, TraefikIcon } from "@/components/brand-icons";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePoll } from "@/hooks/use-poll";
import { api } from "@/lib/api";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { BasicAuthUsersPage } from "@/pages/basic-auth-users";
import { CaptchasPage } from "@/pages/captchas";
import { ClientCasPage } from "@/pages/client-cas";
import { PeersPage } from "@/pages/peers";
import { RateLimitingPage } from "@/pages/rate-limiting";
import { RequestsPage } from "@/pages/requests";
import { ServiceEditorDialog } from "@/pages/service-editor";
import { DomainsPage } from "@/pages/domains";
import { HostsPage } from "@/pages/hosts";
import { isSettingsSection, SettingsPage } from "@/pages/settings";
import "./globals.css";

type Page =
  | "services"
  | "requests"
  | "domains"
  | "client-cas"
  | "users"
  | "captchas"
  | "peers"
  | "rate-limiting"
  | "settings";
const PAGES: Page[] = [
  "services",
  "requests",
  "domains",
  "client-cas",
  "users",
  "captchas",
  "peers",
  "rate-limiting",
  "settings",
];

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

/** A sidebar entry: a page, or a section of the Settings page. */
interface NavEntry {
  /** `page` or `settings/<section>`: also the hash it opens. */
  target: string;
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

function NavItem(props: { item: NavEntry; active: boolean; onClick: () => void }) {
  const { icon: Icon, label, count } = props.item;
  return (
    <button
      onClick={props.onClick}
      aria-current={props.active ? "page" : undefined}
      className={cn(
        "flex h-8 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
        props.active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon className={cn("size-4 shrink-0", props.active && "text-primary")} />
      {label}
      {count !== undefined && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{count}</span>}
    </button>
  );
}

/** A titled group of entries that folds away from its header. */
function NavGroup(props: {
  group: NavGroupDef;
  open: boolean;
  active: string;
  onToggle: () => void;
  onNavigate: (target: string) => void;
}) {
  const { group, open } = props;
  return (
    <div>
      <button
        onClick={props.onToggle}
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
      >
        {group.label}
        <ChevronDown className={cn("ml-auto size-3.5 transition-transform", !open && "-rotate-90")} />
      </button>
      {/* grid-rows animates the height without measuring it. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="space-y-0.5 overflow-hidden pt-0.5" inert={!open}>
          {group.items.map((item) => (
            <NavItem
              key={item.target}
              item={item}
              active={props.active === item.target}
              onClick={() => props.onNavigate(item.target)}
            />
          ))}
        </div>
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
  // Polled for the proxy host's Tailscale version on the Settings page, known once devices have been listed.
  const settings = usePoll(api.settings, 30_000);
  const domains = usePoll(api.domains, 0);
  const clientCas = usePoll(api.clientCas, 0);
  const users = usePoll(api.basicAuthUsers, 0);
  const captchas = usePoll(api.captchas, 0);
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
        { target: "users", label: "Basic auth users", icon: KeyRound, count: users.data?.length },
        { target: "client-cas", label: "Client CAs", icon: ShieldCheck, count: clientCas.data?.length },
        { target: "captchas", label: "Captchas", icon: BotOff, count: captchas.data?.length },
        { target: "rate-limiting", label: "Rate limiting", icon: Gauge },
      ],
    },
    {
      id: "monitoring",
      label: "Monitoring",
      items: [
        { target: "requests", label: "Requests", icon: Activity },
        { target: "settings/request-log", label: "Request log", icon: ScrollText },
      ],
    },
    {
      id: "settings",
      label: "Settings",
      items: [
        { target: "settings", label: "General", icon: SlidersHorizontal },
        { target: "settings/tailscale", label: "Tailscale", icon: TailscaleIcon },
        { target: "settings/traefik", label: "Traefik", icon: TraefikIcon },
      ],
    },
  ];
  // The entry for the current page: Settings sections have their own, General is plain `settings`.
  const activeTarget =
    page === "settings" ? (isSettingsSection(route.sub) && route.sub !== "general" ? `settings/${route.sub}` : "settings") : page;

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
  const activeGroup = navGroups.find((g) => g.items.some((i) => i.target === activeTarget))?.id;
  useEffect(() => {
    if (activeGroup && collapsed.includes(activeGroup)) toggleGroup(activeGroup);
    // Only when the page changes, so collapsing the current group by hand sticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTarget]);

  const refreshHosts = () => {
    hosts.reload();
    domains.reload();
    clientCas.reload();
    users.reload();
    captchas.reload();
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

        <nav aria-label="Main" className="flex-1 space-y-3 overflow-y-auto px-3 py-2">
          {navGroups.map((g) => (
            <NavGroup
              key={g.id}
              group={g}
              open={!collapsed.includes(g.id)}
              active={activeTarget}
              onToggle={() => toggleGroup(g.id)}
              onNavigate={navigate}
            />
          ))}
        </nav>

        <div className="border-t p-3">
          <div className="flex items-center justify-between px-3 py-1">
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
          {page === "users" && (
            <BasicAuthUsersPage
              users={users.data}
              hosts={hosts.data ?? []}
              onChanged={() => {
                users.reload();
                hosts.reload();
              }}
              onOpenService={(id) => navigate(`services/${id}`)}
            />
          )}
          {page === "captchas" && (
            <CaptchasPage
              captchas={captchas.data}
              hosts={hosts.data ?? []}
              onChanged={() => {
                captchas.reload();
                hosts.reload();
              }}
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
              onOpenRateLimiting={() => setPage("rate-limiting")}
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
        basicAuthUsers={users.data}
        captchas={captchas.data}
        traefik={traefik.data}
        onOpenDomains={() => setPage("domains")}
        onOpenClientCas={() => setPage("client-cas")}
        onOpenUsers={() => setPage("users")}
        onOpenCaptchas={() => setPage("captchas")}
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
