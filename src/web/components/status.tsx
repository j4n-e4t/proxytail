import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ProxyHost, TraefikStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

export function StatusDot({ status, className }: { status: "online" | "offline" | "unknown"; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {status === "online" && <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-40" />}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          status === "online" && "bg-success",
          status === "offline" && "bg-muted-foreground/40",
          status === "unknown" && "bg-warning",
        )}
      />
    </span>
  );
}

const tone = {
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/25 bg-warning/10 text-warning",
  danger: "border-destructive/25 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
};

export function ToneBadge({ t, children }: { t: keyof typeof tone; children: React.ReactNode }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", tone[t])}>
      {children}
    </Badge>
  );
}

export function RouterBadge({ host, traefik }: { host: ProxyHost; traefik: TraefikStatus | null }) {
  if (!host.enabled) return <ToneBadge t="muted">Disabled</ToneBadge>;
  if (!traefik?.reachable) return <ToneBadge t="muted">Unknown</ToneBadge>;
  const r = traefik.routers[host.id];
  if (!r)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <ToneBadge t="warning">Pending</ToneBadge>
          </span>
        </TooltipTrigger>
        <TooltipContent>Waiting for Traefik to pick up the route (polls every 5s)</TooltipContent>
      </Tooltip>
    );
  if (r.status === "enabled")
    return (
      <ToneBadge t="success">
        <span className="size-1.5 rounded-full bg-current" />
        Live
      </ToneBadge>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <ToneBadge t="danger">Error</ToneBadge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{r.errors?.join("\n") ?? r.status}</TooltipContent>
    </Tooltip>
  );
}
