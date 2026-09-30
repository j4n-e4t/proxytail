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
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CertInfo, ProxyHost, TraefikStatus } from "@/lib/api";
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

/** One overall state per service, most severe first. */
export function serviceState(host: ProxyHost, traefik: TraefikStatus | null): ServiceState {
  if (!host.enabled) return { tone: "muted", icon: Pause, label: "Disabled", detail: "Removed from Traefik." };
  // Mirrors buildConfig, which fails closed rather than publishing the route without the client certificate check.
  if (host.clientAuth !== "off" && !host.clientCaIds.length)
    return {
      tone: "danger",
      icon: ShieldX,
      label: "Not routed",
      detail: "Client certificates are required but no CA is attached, so Traefik doesn't serve this service.",
    };
  if (host.basicAuth && !host.basicAuthUserIds.length)
    return {
      tone: "danger",
      icon: ShieldX,
      label: "Not routed",
      detail: "Basic auth is on but no user is attached, so Traefik doesn't serve this service.",
    };
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
  return { tone: "success", icon: Globe, label: "Live", detail: "Routed by Traefik." };
}

const text = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  muted: "text-muted-foreground",
};

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

/** A table cell value: a label with an icon, with details in a tooltip. */
function Cell(props: { icon?: LucideIcon; t?: keyof typeof tone; label: string; tip?: string }) {
  const Icon = props.icon;
  const body = (
    <p className={cn("flex items-center gap-1.5 text-sm font-medium", props.t && text[props.t])}>
      {Icon && <Icon className="size-3.5 shrink-0" />}
      {props.label}
    </p>
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

const bar = { success: "bg-success", warning: "bg-warning", danger: "bg-destructive" };

/**
 * Days left on a valid certificate, with a bar for the share of its lifetime that's left. Traefik renews Let's Encrypt
 * certificates 30 days before they expire, so one that gets much closer than that isn't being renewed.
 */
function CertLifetime({ cert, days }: { cert: CertInfo; days: number }) {
  const start = cert.validFrom ? new Date(cert.validFrom).getTime() : NaN;
  const end = cert.validTo ? new Date(cert.validTo).getTime() : NaN;
  const lifetime = (end - start) / 86_400_000;
  const left = Number.isFinite(lifetime) && lifetime > 0 ? Math.min(1, Math.max(0, days / lifetime)) : null;
  const t = days < 7 ? "danger" : days < 21 ? "warning" : "success";
  const expires = cert.validTo
    ? new Date(cert.validTo).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "an unknown date";
  const tip = [
    `Expires ${expires}${cert.issuer ? `, issued by ${cert.issuer}` : ""}.`,
    t === "success"
      ? "Traefik renews it about 30 days before it expires."
      : "Traefik should have renewed it by now: check that port 80 is reachable from the internet.",
  ].join(" ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="w-28 cursor-default space-y-1.5">
          <p className={cn("flex items-center gap-1.5 text-sm font-medium tabular-nums", text[t])}>
            <ShieldCheck className="size-3.5 shrink-0" />
            {days === 1 ? "1 day left" : `${days} days left`}
          </p>
          {left !== null && (
            <div className="h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className={cn("h-full rounded-full", bar[t])} style={{ width: `${left * 100}%` }} />
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** HTTPS certificate state as observed on Traefik's websecure entrypoint. */
export function CertCell({ host, traefik }: { host: ProxyHost; traefik: TraefikStatus | null }) {
  const cert = host.enabled && traefik?.reachable ? traefik.certificates?.[host.id] : undefined;
  if (!cert) return <Empty />;
  const days = daysUntil(cert.validTo);
  switch (cert.state) {
    case "valid":
      return <CertLifetime cert={cert} days={days ?? 0} />;
    case "untrusted":
      return (
        <Cell
          icon={ShieldAlert}
          t="warning"
          label="Untrusted"
          tip={[cert.issuer ?? "Unknown issuer", cert.error].filter(Boolean).join(": ")}
        />
      );
    case "pending":
      return (
        <Cell
          icon={ShieldEllipsis}
          t="warning"
          label="Issuing"
          tip="Traefik is still requesting a certificate from Let's Encrypt. Port 80 must be reachable from the internet for the HTTP challenge."
        />
      );
    default:
      return <Cell icon={ShieldX} t="danger" label="TLS error" tip={cert.error} />;
  }
}

export function AccessCell({ host }: { host: ProxyHost }) {
  const names = host.basicAuthUsers.map((u) => u.username);
  if (host.clientAuth !== "off") {
    const cas = `${host.clientCaIds.length} ${host.clientCaIds.length === 1 ? "CA" : "CAs"}`;
    return (
      <Cell
        icon={ShieldCheck}
        label="Client cert"
        tip={`${host.clientAuth === "require" ? "Required" : "Optional"}, verified against ${cas}${host.basicAuth ? `; basic auth for ${names.join(", ")}` : ""}`}
      />
    );
  }
  if (!host.basicAuth) return <Cell label="Public" t="muted" />;
  return <Cell icon={KeyRound} label="Basic auth" tip={names.join(", ")} />;
}
