import { useMemo, useState } from "react";
import { Activity, Copy, ExternalLink, Globe, Lock, MonitorSmartphone, MoreHorizontal, Pencil, Plus, Search, Trash2, Waypoints } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { DeviceBadge } from "@/components/device-badge";
import { TrafficCell } from "@/components/traffic-cell";
import { usePoll } from "@/hooks/use-poll";
import { AccessCell, CertCell, ServiceIcon, serviceState, StateLabel } from "@/components/status";
import { api, type Device, type ProxyHost, type TraefikStatus } from "@/lib/api";
import { cn, targetUrl } from "@/lib/utils";

function Stat({ icon: Icon, label, value, hint }: { icon: typeof Globe; label: string; value: React.ReactNode; hint: string }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <span className="text-sm font-medium text-muted-foreground">{label}</span>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="px-4">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

export function HostsPage(props: {
  hosts: ProxyHost[] | null;
  devices: Device[];
  traefik: TraefikStatus | null;
  onNew: () => void;
  onEdit: (h: ProxyHost) => void;
  onViewRequests: (h: ProxyHost) => void;
  onChanged: () => void;
}) {
  const { hosts, devices, traefik } = props;
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<ProxyHost | null>(null);
  const byId = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const traffic = usePoll(api.serviceTraffic, 60_000);

  const shown = (hosts ?? []).filter((h) =>
    [...h.domains, h.deviceName, h.targetIp, String(h.targetPort)].join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  const enabledCount = hosts?.filter((h) => h.enabled).length ?? 0;
  const states = (hosts ?? []).map((h) => serviceState(h, traefik).label);
  const liveCount = states.filter((l) => l === "Live").length;
  const downCount = states.filter((l) => l === "Backend down").length;
  const onlineCount = devices.filter((d) => d.online).length;

  const toggle = async (h: ProxyHost, enabled: boolean) => {
    try {
      await api.updateHost(h.id, { enabled });
      toast.success(`${h.domains[0]} ${enabled ? "enabled" : "disabled"}`);
      props.onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const remove = async (h: ProxyHost) => {
    try {
      await api.deleteHost(h.id);
      toast.success(`Deleted ${h.domains[0]}`);
      props.onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success("Copied to clipboard"));

  return (
    <>
      <PageHeader title="Services" description="Public hostnames routed by Traefik to services on your tailnet.">
        <Button onClick={props.onNew}>
          <Plus /> Add service
        </Button>
      </PageHeader>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat icon={Waypoints} label="Services" value={hosts?.length ?? "–"} hint={`${enabledCount} enabled`} />
        <Stat
          icon={Activity}
          label="Live routes"
          value={traefik?.reachable ? liveCount : "–"}
          hint={
            !traefik?.reachable
              ? "Traefik unreachable"
              : downCount
                ? `${downCount} ${downCount === 1 ? "backend" : "backends"} down`
                : `Traefik ${traefik.version ?? ""}`
          }
        />
        <Stat
          icon={MonitorSmartphone}
          label="Peers online"
          value={devices.length ? `${onlineCount}/${devices.length}` : "–"}
          hint="in your tailnet"
        />
      </div>

      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2 border-b p-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search services…"
              className="h-8 pl-8"
            />
          </div>
        </div>

        {hosts === null ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : hosts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border bg-muted">
              <Waypoints className="size-5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">No services yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Create one to expose a service on a tailnet peer under a public domain.
              </p>
            </div>
            <Button onClick={props.onNew} className="mt-2">
              <Plus /> Add service
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Service</TableHead>
                <TableHead className="w-[22%]">Target</TableHead>
                <TableHead className="w-44">Traffic (24h)</TableHead>
                <TableHead className="w-36">Certificate</TableHead>
                <TableHead className="w-32">Access</TableHead>
                <TableHead className="w-20">Enabled</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((h) => {
                const device = byId.get(h.deviceId);
                const state = serviceState(h, traefik);
                const extra = h.aliases.length;
                return (
                  <TableRow key={h.id}>
                    <TableCell className="py-3 pl-4">
                      <div className="flex items-center gap-3">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div>
                              <ServiceIcon host={h} state={state} />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm">{state.detail}</TooltipContent>
                        </Tooltip>
                        <div className="min-w-0 leading-tight">
                          <a
                            href={`https://${h.domains[0]}`}
                            target="_blank"
                            rel="noreferrer"
                            className={cn(
                              "group inline-flex max-w-full items-center gap-1.5 font-medium hover:underline",
                              !h.enabled && "text-muted-foreground",
                            )}
                          >
                            <span className="truncate">{h.domains[0]}</span>
                            <ExternalLink className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                          </a>
                          {/* Live services let the green tile speak; anything else names the problem. */}
                          {(state.tone !== "success" || extra > 0) && (
                            <p className="mt-0.5 truncate text-xs">
                              {state.tone !== "success" && <StateLabel state={state} />}
                              {state.tone !== "success" && extra > 0 && <span className="text-muted-foreground"> · </span>}
                              {extra > 0 && (
                                <span
                                  className="text-muted-foreground"
                                  title={h.aliases
                                    .map((a) => `${a.hostname} (${a.mode === "redirect" ? "redirects" : "parallel"})`)
                                    .join(", ")}
                                >
                                  +{extra} {extra === 1 ? "alias" : "aliases"}
                                </span>
                              )}
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className={cn("flex items-center gap-1.5", !h.enabled && "opacity-60")}>
                        <DeviceBadge device={device} name={h.deviceName} ip={h.targetIp} />
                        <code className="font-mono text-xs text-muted-foreground">:{h.targetPort}</code>
                        {h.scheme === "https" && (
                          <Lock className="size-3.5 text-muted-foreground" aria-label="HTTPS upstream" />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <TrafficCell traffic={traffic.data?.services[h.id]} onClick={() => props.onViewRequests(h)} />
                    </TableCell>
                    <TableCell>
                      <CertCell host={h} traefik={traefik} />
                    </TableCell>
                    <TableCell>
                      <AccessCell host={h} />
                    </TableCell>
                    <TableCell>
                      <Switch checked={h.enabled} onCheckedChange={(v) => toggle(h, v)} aria-label="Enabled" />
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="Actions">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onSelect={() => props.onEdit(h)}>
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <a href={`https://${h.domains[0]}`} target="_blank" rel="noreferrer">
                              <ExternalLink /> Open
                            </a>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => props.onViewRequests(h)}>
                            <Activity /> View requests
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => copy(targetUrl(h))}>
                            <Copy /> Copy target URL
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(h)}>
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
              {shown.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    No services match “{query}”.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.domains[0]}?</AlertDialogTitle>
            <AlertDialogDescription>
              The route is removed from Traefik within a few seconds. The service on {deleting?.deviceName} is not
              affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deleting && remove(deleting)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
