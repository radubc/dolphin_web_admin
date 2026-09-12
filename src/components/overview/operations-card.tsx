/**
 * Overview → "Operations": the last 24 hours of the metrics that say whether
 * the deployment is healthy, one row per metric with a sparkline.
 *
 * The data is one `cloudwatch:GetMetricData` call, cached for a minute
 * (`src/lib/ops/metrics.ts`), and the colours are the server's verdict —
 * `METRIC_THRESHOLDS` in `src/lib/ops/types.ts` — not this component's, so a
 * future alert and this card cannot disagree about what "warn" means.
 *
 * A row always exists, even when it has no number: `not configured` (the
 * environment does not name the resource), `no data` (CloudWatch has never
 * seen the metric, which is normal for a metric whose event has not happened)
 * or the failure text. A row that vanished when a variable was unset would
 * make "nothing is wrong" and "nothing is being watched" look identical.
 */

import { formatRelativeTimeOrNever } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import {
  formatMetric,
  thresholdFor,
  type Loaded,
  type MetricGroup,
  type MetricState,
  type OpsMetric,
  type OpsMetrics,
} from "@/lib/ops/types";
import { Divider, NotAvailable, OverviewCard } from "./card";
import Sparkline from "./sparkline";

const OPS_COLOR = featureColors.services;

/** The heading each group of rows gets, in the order the card draws them. */
const GROUP_LABELS: Record<MetricGroup, string> = {
  rds: "Database",
  ecs: "Containers",
  alb: "Load balancer",
  waf: "Firewall",
};

const GROUP_ORDER: MetricGroup[] = ["rds", "ecs", "alb", "waf"];

/** What each state is painted. `info` and the three empty states stay neutral. */
function colorFor(state: MetricState): string {
  switch (state) {
    case "ok":
      return featureColors.loan;
    case "warn":
      return featureColors.incomeBills;
    case "critical":
      return featureColors.rule;
    case "info":
      return surfaceColors.textSecondary;
    default:
      return surfaceColors.textTertiary;
  }
}

/** The short words the right-hand column shows in place of a number. */
const EMPTY_LABELS: Partial<Record<MetricState, string>> = {
  unconfigured: "not set",
  unanswered: "no data",
  failed: "—",
};

export default function OperationsCard({
  metrics,
  className,
}: {
  metrics: Loaded<OpsMetrics>;
  className?: string;
}) {
  if (!metrics.ok) {
    return (
      <OverviewCard title="Operations" accent={OPS_COLOR} className={className}>
        <NotAvailable reason={metrics.reason} />
      </OverviewCard>
    );
  }

  const { metrics: rows, region, windowHours, fetchedAt, error } = metrics.data;

  return (
    <OverviewCard
      title="Operations"
      accent={OPS_COLOR}
      className={className}
      badge={
        <>
          last {windowHours} h, hourly
          <br />
          {region === null ? "no region set" : region} · read{" "}
          {formatRelativeTimeOrNever(fetchedAt)}
        </>
      }
      footnote="One free CloudWatch GetMetricData call, cached for 60 seconds. Thresholds: free storage under 2 GiB, 20 database connections, 80% CPU or memory, any target 5xx in 24 hours, one second of response time."
    >
      {error !== null && <NotAvailable reason={error} />}

      {GROUP_ORDER.map((group, index) => {
        const groupRows = rows.filter((row) => row.group === group);
        if (groupRows.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-2">
            {index > 0 && <Divider />}
            <span
              className="text-[11px] font-medium tracking-wide uppercase"
              style={{ color: surfaceColors.textTertiary }}
            >
              {GROUP_LABELS[group]}
            </span>
            {groupRows.map((row) => (
              <MetricRow key={row.key} metric={row} />
            ))}
          </div>
        );
      })}
    </OverviewCard>
  );
}

function MetricRow({ metric }: { metric: OpsMetric }) {
  const color = colorFor(metric.state);
  const threshold = thresholdFor(metric.key);
  // A counter is judged on its 24-hour total, so that is the figure to show;
  // a gauge shows its newest hour.
  const showTotal = metric.total !== null && threshold?.basis === "total";
  const value = showTotal ? metric.total : metric.latest;
  const empty = EMPTY_LABELS[metric.state];

  const note =
    metric.note ??
    (metric.state === "warn" || metric.state === "critical" ? (threshold?.note ?? null) : null);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-sm" style={{ color: surfaceColors.text }}>
            {metric.label}
          </span>
          {metric.scope !== null && (
            <span
              className="truncate text-[11px]"
              style={{ color: surfaceColors.textTertiary }}
              title={metric.scope}
            >
              {metric.scope}
            </span>
          )}
        </span>

        <Sparkline
          points={metric.points}
          color={metric.state === "info" || metric.state === "ok" ? OPS_COLOR : color}
          label={`${metric.label}${metric.scope === null ? "" : ` (${metric.scope})`} over the last 24 hours`}
        />

        <span
          className="w-24 shrink-0 text-right text-sm font-semibold tabular-nums"
          style={{ color }}
          title={showTotal ? "Total over the last 24 hours" : "The newest hour"}
        >
          {empty ?? formatMetric(value, metric.unit)}
          {showTotal && empty === undefined && (
            <span
              className="ml-1 text-[11px] font-normal"
              style={{ color: surfaceColors.textTertiary }}
            >
              /24h
            </span>
          )}
        </span>
      </div>

      {note !== null && (
        <span
          className="pr-24 text-[11px] leading-snug"
          style={{ color: surfaceColors.textTertiary }}
        >
          {note}
        </span>
      )}
    </div>
  );
}
