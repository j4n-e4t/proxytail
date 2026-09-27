import { ShieldAlert, ShieldCheck, ShieldEllipsis } from "lucide-react";
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

function daysUntil(iso?: string) {
  return iso ? Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000) : undefined;
}

/** HTTPS certificate state as observed on Traefik's websecure entrypoint. */
export function CertBadge({ host, traefik }: { host: ProxyHost; traefik: TraefikStatus | null }) {
  if (!host.enabled || !traefik?.reachable) return null;
  const cert = traefik.certificates?.[host.id];
  if (!cert) return null;
  const days = daysUntil(cert.validTo);
  const [t, Icon, label, detail] =
    cert.state === "valid"
      ? (["success", ShieldCheck, "HTTPS", `${cert.issuer} · expires in ${days} days`] as const)
      : cert.state === "untrusted"
        ? (["warning", ShieldAlert, "Untrusted", `${cert.issuer ?? "Unknown issuer"} — ${cert.error}`] as const)
        : cert.state === "pending"
          ? ([
              "warning",
              ShieldEllipsis,
              "Issuing",
              "Traefik is still requesting a Let's Encrypt certificate. Port 80 must be reachable from the internet for the HTTP challenge.",
            ] as const)
          : (["danger", ShieldAlert, "TLS error", cert.error ?? "Could not check the certificate"] as const);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <ToneBadge t={t}>
            <Icon className="size-3" /> {label}
          </ToneBadge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{detail}</TooltipContent>
    </Tooltip>
  );
}
