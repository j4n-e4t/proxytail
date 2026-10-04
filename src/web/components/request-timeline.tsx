import { useEffect, useRef, useState } from "react";
import type { AccessLogRange, AccessLogStats, StatusClass } from "@/lib/api";

/** Stacked bottom to top: errors sit on the baseline, where they're easiest to compare. */
export const CLASSES: { key: StatusClass; label: string }[] = [
  { key: "5xx", label: "5xx" },
  { key: "4xx", label: "4xx" },
  { key: "3xx", label: "3xx" },
  { key: "2xx", label: "2xx" },
];

export const classColor = (c: StatusClass) => `var(--status-${c})`;
export const statusClass = (status: number): StatusClass =>
  status >= 500 ? "5xx" : status >= 400 ? "4xx" : status >= 300 ? "3xx" : "2xx";

const HEIGHT = 180;
const PAD = { top: 8, right: 0, bottom: 22, left: 40 };
const GAP = 2;
const TOOLTIP_W = 176;
const fmtCount = new Intl.NumberFormat(undefined, { notation: "compact" });

/** A round axis maximum: 1, 2 or 5 times a power of ten. */
function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

function timeLabel(iso: string, range: AccessLogRange) {
  return new Date(iso).toLocaleString(
    undefined,
    range === "7d" ? { weekday: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" },
  );
}

/** A bar segment with rounded top corners. */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function RequestTimeline({ stats }: { stats: AccessLogStats }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const buckets = stats.timeline;
  const totals = buckets.map((b) => CLASSES.reduce((s, c) => s + b[c.key], 0));
  const max = niceMax(Math.max(0, ...totals));
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const step = buckets.length ? plotW / buckets.length : 0;
  const barW = Math.max(1, step - GAP);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(plotW / 90))));
  const hovered = hover === null ? null : buckets[hover];

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      <svg width={width} height={HEIGHT} role="img" aria-label="Requests over time by status class">
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px]">
              {fmtCount.format(t)}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = PAD.left + i * step + GAP / 2;
          let top = y(0);
          const segments = CLASSES.filter((c) => b[c.key] > 0);
          return (
            <g key={b.start} opacity={hover === null || hover === i ? 1 : 0.45}>
              {segments.map((c, j) => {
                const h = Math.max(1, (b[c.key] / max) * plotH - (j ? GAP : 0));
                top -= h + (j ? GAP : 0);
                const last = j === segments.length - 1;
                return last ? (
                  <path key={c.key} d={topRounded(x, top, barW, h, 4)} fill={classColor(c.key)} />
                ) : (
                  <rect key={c.key} x={x} y={top} width={barW} height={h} fill={classColor(c.key)} />
                );
              })}
              {i % labelEvery === 0 && (
                <text
                  x={x + barW / 2}
                  y={HEIGHT - 6}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[11px]"
                >
                  {timeLabel(b.start, stats.range)}
                </text>
              )}
              {/* The whole column is the hover target, not just the bar. */}
              <rect
                x={PAD.left + i * step}
                y={PAD.top}
                width={step}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
      </svg>

      {!totals.some(Boolean) && (
        <p className="absolute inset-0 flex items-center justify-center pb-6 pl-10 text-sm text-muted-foreground">
          No requests in this period
        </p>
      )}

      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 w-44 rounded-md border bg-popover p-2.5 text-xs"
          style={{
            top: PAD.top,
            // Beside the bar, on whichever side has room.
            left:
              PAD.left + (hover + 1) * step + TOOLTIP_W + 8 <= width
                ? PAD.left + (hover + 1) * step + 8
                : Math.max(0, PAD.left + hover * step - TOOLTIP_W - 8),
          }}
        >
          <p className="mb-1.5 font-medium">
            {timeLabel(hovered.start, stats.range)} –{" "}
            {timeLabel(new Date(new Date(hovered.start).getTime() + stats.bucketMs).toISOString(), stats.range)}
          </p>
          {[...CLASSES].reverse().map((c) => (
            <div key={c.key} className="flex items-center gap-2 py-0.5">
              <span className="size-2 rounded-sm" style={{ background: classColor(c.key) }} />
              <span className="text-muted-foreground">{c.label}</span>
              <span className="ml-auto tabular-nums">{hovered[c.key].toLocaleString()}</span>
            </div>
          ))}
          <div className="mt-1 flex border-t pt-1 font-medium">
            Total <span className="ml-auto tabular-nums">{totals[hover]!.toLocaleString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function TimelineLegend() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      {[...CLASSES].reverse().map((c) => (
        <span key={c.key} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: classColor(c.key) }} />
          {c.label}
        </span>
      ))}
    </div>
  );
}
