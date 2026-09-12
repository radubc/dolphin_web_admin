/**
 * Overview → "This month": what AWS has cost so far, what the month is
 * projected to end at, and where that leaves the budget.
 *
 * Reads the **cached** cost tables through `getCostSummary()` and
 * `getCostDaily()`, never AWS: Cost Explorer charges $0.01 a request, so only
 * the daily `aws_costs` integration calls it (`docs/costs.md`). The figures
 * are therefore as fresh as the last run, which the badge says, and every
 * window ends yesterday because today's spend has barely happened.
 *
 * The three figures are the same ones the Cost center's header strip shows,
 * measured the same way, so the dashboard and the page cannot disagree.
 */

import {
  formatUsd,
  formatUsdRounded,
  type CostDailyResponse,
  type CostSummaryResponse,
} from "@/lib/costs/types";
import { formatIsoDay, formatRelativeTimeOrNever } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import type { Loaded } from "@/lib/ops/types";
import { Figure, FigureRow, NotAvailable, OverviewCard, ShareBar, Waiting } from "./card";

const COST_COLOR = featureColors.costCenter;

export default function CostCard({
  summary,
  daily,
  className,
}: {
  summary: Loaded<CostSummaryResponse>;
  daily: Loaded<CostDailyResponse>;
  className?: string;
}) {
  if (!summary.ok) {
    return (
      <OverviewCard title="This month" accent={COST_COLOR} className={className}>
        <NotAvailable reason={summary.reason} />
      </OverviewCard>
    );
  }

  const { snapshot, byService, lastRun } = summary.data;
  const monthTotal = byService.reduce((sum, row) => sum + row.mtdUsd, 0);
  // The daily series is a second read and is allowed to fail on its own; the
  // rest of the card is unaffected.
  const days = daily.ok ? daily.data : [];
  const yesterday = days.length > 0 ? days[days.length - 1] : null;
  const budget = snapshot?.budget ?? null;

  const nothingYet = snapshot === null && byService.length === 0;

  return (
    <OverviewCard
      title="This month"
      accent={COST_COLOR}
      className={className}
      badge={
        snapshot === null
          ? lastRun === null
            ? "never refreshed"
            : `run ${formatRelativeTimeOrNever(lastRun.startedAt)}`
          : `as of ${formatRelativeTimeOrNever(snapshot.takenAt)}`
      }
      footnote="Cached from Cost Explorer by the daily aws_costs run. USD, credits and refunds excluded, every window ending yesterday."
    >
      {nothingYet ? (
        <Waiting>
          No spend has been cached yet. Run the <strong>aws_costs</strong> integration from the
          Integrations page, or open the Cost center and press Refresh now.
        </Waiting>
      ) : (
        <>
          <FigureRow>
            <Figure
              label="Month to date"
              value={formatUsd(snapshot?.monthToDateUsd ?? monthTotal)}
              help="The 1st of this month to yesterday inclusive, in USD."
            />
            <Figure
              label="Forecast"
              value={snapshot?.forecastUsd == null ? "—" : formatUsd(snapshot.forecastUsd)}
              help={
                snapshot?.forecastUsd == null
                  ? "Cost Explorer makes no forecast on the last day of a month, or when the account has too little history."
                  : "Month to date plus Cost Explorer's forecast for the days that are left."
              }
            />
            <Figure
              label="Yesterday"
              value={yesterday === null ? "—" : formatUsd(yesterday.totalUsd)}
              hint={yesterday === null ? undefined : formatIsoDay(yesterday.day)}
              help={
                daily.ok
                  ? "The newest cached day. AWS may still revise it."
                  : `The daily series could not be read: ${daily.reason}`
              }
            />
          </FigureRow>

          {budget !== null && budget.limitUsd !== null && budget.limitUsd > 0 ? (
            <BudgetBar
              name={budget.name}
              limitUsd={budget.limitUsd}
              actualUsd={budget.actualUsd ?? snapshot?.monthToDateUsd ?? monthTotal}
            />
          ) : (
            <span className="text-[11px]" style={{ color: surfaceColors.textTertiary }}>
              No AWS budget is configured, so there is nothing to measure the month against.
            </span>
          )}
        </>
      )}
    </OverviewCard>
  );
}

/**
 * The budget's actual against its limit.
 *
 * Amber from 80% and red past 100%: a budget is a warning device, and the
 * colour has to change before the line is crossed to be one.
 */
function BudgetBar({
  name,
  limitUsd,
  actualUsd,
}: {
  name: string;
  limitUsd: number;
  actualUsd: number;
}) {
  const share = actualUsd / limitUsd;
  const color =
    share >= 1 ? featureColors.rule : share >= 0.8 ? featureColors.incomeBills : COST_COLOR;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[11px]" style={{ color: surfaceColors.textSecondary }}>
          Budget · {name}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums" style={{ color }}>
          {formatUsdRounded(actualUsd)} of {formatUsdRounded(limitUsd)} ({Math.round(share * 100)}%)
        </span>
      </div>
      <ShareBar share={share} color={color} label={`${Math.round(share * 100)}% of the budget`} />
    </div>
  );
}
