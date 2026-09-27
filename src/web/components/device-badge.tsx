import { OsIcon } from "@/components/os-icon";
import { StatusDot } from "@/components/status";
import type { Device } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Compact device chip: OS icon, name and online state instead of a raw 100.x address. */
export function DeviceBadge(props: { device?: Device; name: string; ip?: string; className?: string }) {
  const { device } = props;
  const status = device ? (device.online ? "online" : "offline") : "unknown";
  return (
    <span
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-2 rounded-md border bg-muted/50 pr-2.5 pl-2 text-sm font-medium",
        props.className,
      )}
      title={[device?.fqdn ?? props.name, device?.ipv4 ?? props.ip, device ? status : "not found in tailnet"]
        .filter(Boolean)
        .join(" · ")}
    >
      <OsIcon os={device?.os ?? ""} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{props.name}</span>
      <StatusDot status={status} className="size-1.5 [&>span]:size-1.5" />
    </span>
  );
}
