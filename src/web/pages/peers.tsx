import { useMemo, useState } from "react";
import { Copy, KeyRound, Plus, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OsIcon } from "@/components/os-icon";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/status";
import type { Device, ProxyHost } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";

type Filter = "all" | "online" | "offline";



export function PeersPage(props: {
  devices: Device[] | null;
  tag: string;
  error: string | null;
  configured: boolean;
  hosts: ProxyHost[];
  onRefresh: () => Promise<void>;
  onExpose: (d: Device) => void;
  onOpenSettings: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const hostCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of props.hosts) m.set(h.deviceId, (m.get(h.deviceId) ?? 0) + 1);
    return m;
  }, [props.hosts]);

  const all = props.devices ?? [];
  const tag = <code className="font-mono">{props.tag}</code>;
  const description = <>Tailnet peers tagged {tag} that proxytail can reach.</>;
  const shown = all.filter(
    (d) =>
      (filter === "all" || (filter === "online") === d.online) &&
      [d.name, d.ipv4, d.os, d.user, ...d.tags].join(" ").toLowerCase().includes(query.toLowerCase()),
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await props.onRefresh();
      toast.success("Peer list refreshed");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  if (!props.configured) {
    return (
      <>
        <PageHeader title="Peers" description={description} />
        <Card className="items-center gap-3 px-6 py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-full border bg-muted">
            <KeyRound className="size-5 text-muted-foreground" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">Connect your tailnet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Share tailscaled's socket with proxytail to list the peers you can route to.
            </p>
          </div>
          <Button onClick={props.onOpenSettings} className="mt-2">
            Open settings
          </Button>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Peers" description={description}>
        <Button variant="outline" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={cn(refreshing && "animate-spin")} /> Refresh
        </Button>
      </PageHeader>

      {props.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertTitle>Couldn't list peers</AlertTitle>
          <AlertDescription>{props.error}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search peers…"
              className="h-8 pl-8"
            />
          </div>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="ml-auto">
            <TabsList className="h-8">
              <TabsTrigger value="all" className="text-xs">
                All <span className="text-muted-foreground tabular-nums">{all.length}</span>
              </TabsTrigger>
              <TabsTrigger value="online" className="text-xs">
                Online <span className="text-muted-foreground tabular-nums">{all.filter((d) => d.online).length}</span>
              </TabsTrigger>
              <TabsTrigger value="offline" className="text-xs">
                Offline
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {props.devices === null && !props.error ? (
          <div className="space-y-3 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Peer</TableHead>
                <TableHead>Tailscale IP</TableHead>
                <TableHead>Owner / tags</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((d) => {
                const count = hostCounts.get(d.id);
                return (
                  <TableRow key={d.id}>
                    <TableCell className="py-3 pl-4">
                      <div className="flex items-center gap-3">
                        <div className="relative flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted">
                          <OsIcon os={d.os} className="size-4 text-muted-foreground" />
                          <StatusDot
                            status={d.online ? "online" : "offline"}
                            className="absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-card"
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium">{d.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {d.os} · {d.fqdn}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {d.ipv4 ? (
                        <button
                          className="group inline-flex items-center gap-1.5 font-mono text-sm"
                          onClick={() =>
                            navigator.clipboard.writeText(d.ipv4!).then(() => toast.success(`Copied ${d.ipv4}`))
                          }
                        >
                          {d.ipv4}
                          <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
                        </button>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {d.tags.length > 1 ? (
                        <div className="flex flex-wrap gap-1">
                          {d.tags.filter((t) => t !== props.tag).map((t) => (
                            <Badge key={t} variant="secondary" className="font-mono text-[11px]">
                              {t.replace(/^tag:/, "")}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">{d.user}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {d.online ? <span className="text-success">Connected</span> : timeAgo(d.lastSeen)}
                    </TableCell>
                    <TableCell className="pr-4">
                      <div className="flex items-center justify-end gap-2">
                        {count ? (
                          <Badge variant="outline" className="text-muted-foreground">
                            {count} service{count > 1 ? "s" : ""}
                          </Badge>
                        ) : null}
                        <Button variant="outline" size="sm" onClick={() => props.onExpose(d)} disabled={!d.ipv4}>
                          <Plus /> Expose
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {shown.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                    {all.length ? (
                      "No peers found."
                    ) : (
                      <>No peers tagged {tag} yet.</>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
