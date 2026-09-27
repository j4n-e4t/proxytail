import {
  CircleX,
  Globe,
  Hourglass,
  KeyRound,
  Pause,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
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

export interface ServiceState {
  tone: keyof typeof tone;
  icon: LucideIcon;
  label: string;
  detail: string;
}

/** One overall state per service, most severe first: route, then backend health. */
export function serviceState(host: ProxyHost, traefik: TraefikStatus | null): ServiceState {
  if (!host.enabled) return { tone: "muted", icon: Pause, label: "Disabled", detail: "Removed from Traefik." };
  if (!traefik?.reachable)
    return { tone: "muted", icon: Globe, label: "Unknown", detail: "Traefik is unreachable, so the state is unknown." };
  const r = traefik.routers[host.id];
  if (!r)
    return {
      tone: "warning",
      icon: Hourglass,
      label: "Waiting for Traefik",
      detail: "Traefik picks up new routes within 5 seconds.",
    };
  if (r.status !== "enabled")
    return { tone: "danger", icon: CircleX, label: "Route error", detail: r.errors?.join("\n") ?? r.status };
  const health = traefik.health?.[host.id];
  if (health && !health.up)
    return {
      tone: "danger",
      icon: TriangleAlert,
      label: "Backend down",
      detail: `The health check of ${health.url}${host.healthCheckPath} fails, so visitors get a 503.`,
    };
  return {
    tone: "success",
    icon: Globe,
    label: "Live",
    detail: health ? "Routed by Traefik; the health check passes." : "Routed by Traefik. No health check is set up.",
  };
}

const text = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  muted: "text-muted-foreground",
};

/** The service's icon tile, tinted and swapped to reflect its state. */
export function StateTile({ state }: { state: ServiceState }) {
  const Icon = state.icon;
  return (
    <div
      className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border", tone[state.tone])}
      aria-label={state.label}
    >
      <Icon className="size-4" />
    </div>
  );
}

const dot = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

/** The service's favicon (fetched from its backend, globe if there is none) with a dot for its state. */
export function ServiceIcon({ host, state }: { host: ProxyHost; state: ServiceState }) {
  // Keyed on updatedAt so a changed target refetches instead of reusing the browser's cached icon.
  const src = `/api/hosts/${host.id}/favicon?v=${encodeURIComponent(host.updatedAt)}`;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className="relative flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
      {failed === src ? (
        <Globe className="size-4 text-muted-foreground" />
      ) : (
        <img
          src={src}
          alt=""
          className={cn("size-5 object-contain", !host.enabled && "opacity-50 grayscale")}
          onError={() => setFailed(src)}
        />
      )}
      <span
        className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-card", dot[state.tone])}
        aria-label={state.label}
      />
    </div>
  );
}

export function StateLabel({ state }: { state: ServiceState }) {
  return <span className={cn("font-medium", text[state.tone])}>{state.label}</span>;
}

/** A table cell value: a primary line with an icon and a muted second line, with details in a tooltip. */
function Cell(props: { icon?: LucideIcon; t?: keyof typeof tone; label: string; sub?: string; tip?: string }) {
  const Icon = props.icon;
  const body = (
    <div className="leading-tight">
      <p className={cn("flex items-center gap-1.5 text-sm font-medium", props.t && text[props.t])}>
        {Icon && <Icon className="size-3.5 shrink-0" />}
        {props.label}
      </p>
      {props.sub && <p className="mt-0.5 text-xs text-muted-foreground">{props.sub}</p>}
    </div>
  );
  if (!props.tip) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="w-fit cursor-default">{body}</div>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{props.tip}</TooltipContent>
    </Tooltip>
  );
}

const Empty = () => <span className="text-sm text-muted-foreground">—</span>;

function daysUntil(iso?: string) {
  return iso ? Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000) : undefined;
}

/** HTTPS certificate state as observed on Traefik's websecure entrypoint. */
export function CertCell({ host, traefik }: { host: ProxyHost; traefik: TraefikStatus | null }) {
  const cert = host.enabled && traefik?.reachable ? traefik.certificates?.[host.id] : undefined;
  if (!cert) return <Empty />;
  const days = daysUntil(cert.validTo);
  switch (cert.state) {
    case "valid":
      return <Cell icon={ShieldCheck} t="success" label="Valid" sub={`${days} days left`} tip={cert.issuer} />;
    case "untrusted":
      return (
        <Cell
          icon={ShieldAlert}
          t="warning"
          label="Untrusted"
          sub={cert.issuer ?? "Unknown issuer"}
          tip={cert.error}
        />
      );
    case "pending":
      return (
        <Cell
          icon={ShieldEllipsis}
          t="warning"
          label="Issuing"
          sub="Let's Encrypt"
          tip="Traefik is still requesting a certificate. Port 80 must be reachable from the internet for the HTTP challenge."
        />
      );
    default:
      return <Cell icon={ShieldX} t="danger" label="TLS error" sub="Hover for details" tip={cert.error} />;
  }
}

export function AccessCell({ host }: { host: ProxyHost }) {
  const names = host.basicAuthUsers.map((u) => u.username);
  const users = `${names.length} ${names.length === 1 ? "user" : "users"}`;
  if (host.clientAuth !== "off") {
    const cas = `${host.clientCaIds.length} ${host.clientCaIds.length === 1 ? "CA" : "CAs"}`;
    return (
      <Cell
        icon={ShieldCheck}
        label="Client cert"
        sub={[host.clientAuth === "require" ? "Required" : "Optional", host.basicAuth && "basic auth"].filter(Boolean).join(" + ")}
        tip={`Verified against ${cas}${host.basicAuth ? `; basic auth for ${names.join(", ")}` : ""}`}
      />
    );
  }
  if (!host.basicAuth) return <Cell label="Public" t="muted" />;
  return <Cell icon={KeyRound} label="Basic auth" sub={users} tip={names.join(", ")} />;
}
