import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ServiceTraffic } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat();

function fmtMs(ms: number) {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const W = 72;
const H = 22;
const GAP = 1;

/** Requests per hour over the last 24 hours, one bar each; the current hour is on the right. */
function Sparkline({ hourly }: { hourly: number[] }) {
  const max = Math.max(1, ...hourly);
  const step = W / hourly.length;
  return (
    <svg width={W} height={H} className="shrink-0" aria-hidden>
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-border" />
      {hourly.map((n, i) =>
        n ? (
          <rect
            key={i}
            x={i * step}
            y={H - Math.max(1.5, (n / max) * H)}
            width={step - GAP}
            height={Math.max(1.5, (n / max) * H)}
            rx={0.75}
            className="fill-primary/70"
          />
        ) : null,
      )}
    </svg>
  );
}

/** A service's last 24 hours on the Services list. `traffic` is undefined when it had no requests at all. */
export function TrafficCell({ traffic, onClick }: { traffic: ServiceTraffic | undefined; onClick: () => void }) {
  if (!traffic?.requests)
    return (
      <button onClick={onClick} className="text-left text-sm text-muted-foreground hover:underline">
        {traffic?.lastRequest ? `Last request ${timeAgo(traffic.lastRequest)}` : "No requests yet"}
      </button>
    );

  const errorRate = traffic.serverErrors / traffic.requests;
  const detail = [
    traffic.serverErrors ? `${(errorRate * 100).toFixed(errorRate < 0.01 ? 2 : 1)}% 5xx` : null,
    traffic.p95Ms !== null ? `p95 ${fmtMs(traffic.p95Ms)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={onClick} className="flex items-center gap-2.5 rounded-md text-left" aria-label="View requests">
          <Sparkline hourly={traffic.hourly} />
          <span className="min-w-0 leading-tight">
            <span className="block text-sm font-medium tabular-nums">{compact.format(traffic.requests)}</span>
            <span
              className={cn(
                "block truncate text-xs tabular-nums",
                errorRate >= 0.05 ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {detail}
            </span>
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p>
          {full.format(traffic.requests)} requests in the last 24 hours
          {traffic.clientErrors || traffic.serverErrors
            ? `: ${full.format(traffic.clientErrors)} × 4xx, ${full.format(traffic.serverErrors)} × 5xx`
            : ""}
          .
        </p>
        {traffic.p95Ms !== null && <p>95% answered within {fmtMs(traffic.p95Ms)}.</p>}
        {traffic.lastRequest && <p>Last request {timeAgo(traffic.lastRequest)}. Click for the requests.</p>}
      </TooltipContent>
    </Tooltip>
  );
}
