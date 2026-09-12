"use client";

/**
 * Cost center: what AWS is charging this account, where it goes, and what the
 * month is projected to cost.
 *
 * **The page never calls AWS.** Every figure on it comes from
 * `admin_cost_daily` and `admin_cost_snapshots`, which the `aws_costs`
 * integration fills once a day. Cost Explorer charges $0.01 per request and
 * its data lags about a day, so asking on every page load would cost real
 * money for numbers that had not changed. The one control that does spend
 * anything — "Refresh now" — says so in its tooltip.
 *
 * The layout is the app's own, from `ListPageFrame`: a sticky band with the
 * title, the month's read-outs and the budget meter, then the ribbon; below
 * it the daily bars and the one list — cost by service — whose rows are the
 * only thing that scrolls; and down the right rail the breakdowns and the
 * notes, in their own scroller.
 *
 * Three things the page says rather than implies:
 *
 * - **Nothing is counted for today.** Every window ends yesterday, the last
 *   day AWS has totalled. On the 1st of a month the month-to-date figures are
 *   genuinely zero.
 * - **Credits and refunds are excluded**, so these are usage figures and the
 *   invoice can be lower.
 * - **How fresh this is.** The ribbon's read-out is the age of the snapshot,
 *   not of the page load, and an alert appears when the last run failed or
 *   when there has never been one.
 *
 * One control is permission-gated: **Refresh now** starts an `aws_costs` run
 * through the Integrations endpoint, so `can_write_integrations` decides it —
 * not a cost action. Without it the button is not drawn at all, exactly as
 * Customers does with "Invite customer", and the ribbon says why in its place.
 * The server checks the action again on the run request; this is only so an
 * operator is not offered a button that can only fail.
 */

import { Alert, Button, Progress, Segmented, Spin, Tag, Tooltip, Typography } from "antd";
import { CloudDownloadOutlined, DollarOutlined, ReloadOutlined } from "@ant-design/icons";
import Figures, { type Figure } from "@/components/figures";
import { ListPageFrame, ListPanel, ListTableRegion } from "@/components/list-page-frame";
import { RibbonBar, RibbonButton, RibbonDivider } from "@/components/ribbon-bar";
import { canDo, type AdminCapabilities } from "@/lib/admin-access/types";
import { daysBetween, formatDay, formatMonth, shiftDay, todayUtc } from "@/lib/costs/calendar";
import { COST_DAYS_DEFAULT, formatUsd, formatUsdRounded, type CostDay } from "@/lib/costs/types";
import { formatRelativeTimeOrNever, pluralise } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import CostBarChart, { type CostBar } from "./cost-bar-chart";
import {
  AnomaliesCard,
  BudgetMeter,
  ComponentsTable,
  CostCard,
  FreeTierCard,
  ServicesTable,
} from "./cost-breakdowns";
// The per-tenant allocation. See docs/cost-allocation.md.
import CostPerClientSection from "./cost-per-client-section";
import { REFRESH_PRICE_NOTE, useCostData } from "./use-cost-data";

const COST_COLOR = featureColors.costCenter;

/** The ranges the bar chart offers. 35 is the job's own fetch window. */
const RANGE_OPTIONS = [
  { value: COST_DAYS_DEFAULT, label: "35 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
];

/**
 * The series as bars: one slot per day in the range, whether or not AWS
 * reported anything for it.
 *
 * The gaps are filled here rather than by the endpoint, which keeps the wire
 * honest — "no rows" and "$0.00" are different facts — while the chart still
 * draws a continuous axis. The range is measured from the browser's UTC date,
 * which is the same day the server measured from.
 */
function toBars(days: readonly CostDay[], range: number): CostBar[] {
  const today = todayUtc();
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  return daysBetween(shiftDay(today, -range), shiftDay(today, -1)).map((day) => {
    const entry = byDay.get(day);
    return { day, amountUsd: entry?.totalUsd ?? null, estimated: entry?.estimated ?? false };
  });
}

/** Yesterday's total and the day before it, for the day-over-day read-out. */
function lastTwoDays(days: readonly CostDay[]): {
  latest: CostDay | null;
  previous: CostDay | null;
} {
  // The endpoint sends them oldest first; sorting here costs nothing and means
  // the read-out cannot silently invert if that ever changes.
  const ordered = [...days].sort((a, b) => a.day.localeCompare(b.day));
  return { latest: ordered.at(-1) ?? null, previous: ordered.at(-2) ?? null };
}

export interface CostCenterPageProps {
  /** The signed-in operator, resolved on the server by the route. */
  capabilities: AdminCapabilities;
}

function CostCenterPage({ capabilities }: CostCenterPageProps) {
  const { summary, daily, loading, error, days, setDays, reload, liveRun, refreshing, refreshNow } =
    useCostData();

  // Presentation only: `POST /api/v1/admin/integrations/aws_costs/run` checks
  // the same action, and it is the Integrations endpoint's rule because there
  // is deliberately only one way to start this job.
  const canRefresh = canDo(capabilities, "can_write_integrations");

  const snapshot = summary?.snapshot ?? null;
  const lastRun = summary?.lastRun ?? null;
  const { latest, previous } = lastTwoDays(daily);
  const services = summary?.byService ?? [];
  const monthTotal = services.reduce((sum, row) => sum + row.mtdUsd, 0);

  /* ------------------------------- Figures -------------------------------- */

  const dayOverDay =
    latest !== null && previous !== null && previous.totalUsd > 0
      ? (latest.totalUsd - previous.totalUsd) / previous.totalUsd
      : null;

  const figureList: Figure[] = [
    {
      label: "Month to date",
      // The snapshot's own figure when there is one: the job computed it from
      // the same rows, so the strip and the snapshot cannot disagree. Summed
      // from the table only before the first run has written a snapshot.
      value: formatUsd(snapshot?.monthToDateUsd ?? monthTotal),
      color: COST_COLOR,
      tooltip:
        snapshot === null
          ? "Summed from the cached daily rows: the 1st of this month to yesterday, credits and refunds excluded."
          : `${formatMonth(snapshot.month)}, the 1st to yesterday. Credits and refunds are excluded, so this is usage rather than the invoice.`,
    },
    {
      label: "Forecast",
      value: snapshot?.forecastUsd == null ? "—" : formatUsd(snapshot.forecastUsd),
      tooltip:
        snapshot?.forecastUsd == null
          ? "Cost Explorer makes no forecast for an account with too little history, and none is recorded when the call failed."
          : "What the whole month is projected to cost: the month to date, the 1st to yesterday, plus Cost Explorer's forecast for today and the days that are left.",
    },
    {
      label: "Yesterday",
      value: latest === null ? "—" : formatUsd(latest.totalUsd),
      // Red only for a real jump: a few percent of daily noise is not news.
      color: dayOverDay !== null && dayOverDay > 0.1 ? featureColors.rule : undefined,
      tooltip:
        latest === null
          ? "No daily figure has been cached yet."
          : `${formatDay(latest.day)}${latest.estimated ? " — AWS still calls this an estimate" : ""}` +
            (dayOverDay === null
              ? ""
              : ` · ${dayOverDay > 0 ? "up" : "down"} ${Math.abs(dayOverDay * 100).toFixed(0)}% on the day before`),
      separatorBefore: true,
    },
  ];

  const figures = (
    <div className="flex items-center gap-5">
      <Figures label="Cost totals" figures={figureList} />
      {snapshot?.budget != null && (
        <BudgetMeter
          name={snapshot.budget.name}
          limitUsd={snapshot.budget.limitUsd}
          actualUsd={snapshot.budget.actualUsd}
        />
      )}
      {snapshot?.freeTier?.planType != null && (
        <Tooltip
          title={
            snapshot.freeTier.remainingCreditsUsd === null
              ? "The account's AWS plan, from the Free Tier API."
              : `${formatUsd(snapshot.freeTier.remainingCreditsUsd)} of free-tier credit left.`
          }
        >
          <Tag color="green" style={{ marginInlineEnd: 0 }}>
            {snapshot.freeTier.planType}
            {snapshot.freeTier.remainingCreditsUsd === null
              ? ""
              : ` · ${formatUsdRounded(snapshot.freeTier.remainingCreditsUsd)} left`}
          </Tag>
        </Tooltip>
      )}
    </div>
  );

  /* -------------------------------- Ribbon -------------------------------- */

  const ribbon = (
    <RibbonBar
      trailing={
        <span
          className="flex shrink-0 flex-col items-end pr-1 text-[11px]"
          style={{ color: surfaceColors.textSecondary }}
        >
          <span className="tabular-nums">
            {formatUsd(monthTotal)} across {pluralise(services.length, "service")}
          </span>
          <span style={{ color: surfaceColors.textTertiary }}>
            {snapshot === null
              ? "never refreshed"
              : `as of ${formatRelativeTimeOrNever(snapshot.takenAt)}`}
          </span>
        </span>
      }
    >
      {canRefresh ? (
        <RibbonButton
          label="Refresh now"
          icon={<CloudDownloadOutlined />}
          onClick={refreshNow}
          disabled={refreshing}
          tooltip={REFRESH_PRICE_NOTE}
        />
      ) : (
        <Tooltip title="Asking AWS again needs the can_write_integrations action, because it starts the aws_costs integration run. The figures below are the cached ones.">
          <span
            tabIndex={0}
            className="flex items-center px-2 text-[11px]"
            style={{ color: surfaceColors.textTertiary }}
          >
            Refresh not permitted
          </span>
        </Tooltip>
      )}
      <RibbonButton
        label="Reload"
        icon={<ReloadOutlined />}
        onClick={reload}
        tooltip="Re-read the cached figures. Costs nothing — it does not touch AWS."
      />
      <RibbonDivider />
      {/* The chart's range only. Every other figure on the page is measured
          over a window the server fixes, so there is nothing else to choose. */}
      <span className="flex items-center px-2" role="group" aria-label="Chart range">
        <Segmented<number> value={days} onChange={setDays} options={RANGE_OPTIONS} />
      </span>
    </RibbonBar>
  );

  /* --------------------------------- Rail --------------------------------- */

  // The per-client card is **not** gated on `summary`: it reads its own
  // endpoint, so a failed or empty cost summary says nothing about whether
  // the allocation can be shown. Hiding it with the rest of the rail would
  // have hidden the one card that can still answer.
  const rail = (
    <>
      {summary !== null && (
        <>
          {summary.byComponent.length > 0 ? (
            <ComponentsTable rows={summary.byComponent} />
          ) : (
            <CostCard
              title="By component"
              footnote="Activate the Application, Environment and Component cost allocation tags in the AWS Billing console. Activation takes up to 24 hours and is not retroactive, so only spend from then on can ever be split."
            >
              <Typography.Text type="secondary" className="text-sm">
                No cost allocation tag data yet.
              </Typography.Text>
            </CostCard>
          )}
          <AnomaliesCard anomalies={snapshot?.anomalies ?? []} />
          {snapshot?.freeTier != null && <FreeTierCard state={snapshot.freeTier} />}
        </>
      )}
      <CostPerClientSection />
    </>
  );

  /* --------------------------------- Body --------------------------------- */

  let body: React.ReactNode;
  if (loading) {
    body = (
      <ListPanel>
        <div className="flex items-center justify-center py-16">
          <Spin />
        </div>
      </ListPanel>
    );
  } else if (error !== null && summary === null) {
    body = (
      <Alert
        type="error"
        showIcon
        title="The cost figures could not be loaded."
        description={error}
        action={
          <Button size="small" onClick={reload}>
            Retry
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        {snapshot === null && (
          <Alert
            type="info"
            showIcon
            title="No AWS cost data has been cached yet."
            description={
              "The daily job writes it at 09:00 Toronto time. Refresh now fills it immediately, " +
              "for about five cents in Cost Explorer requests. Cost Explorer also has to have " +
              "been opened once in the AWS console before it will answer at all."
            }
          />
        )}

        {lastRun !== null && (lastRun.status === "failed" || lastRun.status === "interrupted") && (
          <Alert
            type="warning"
            showIcon
            title={`The last cost refresh ${lastRun.status === "failed" ? "failed" : "was interrupted"}.`}
            description={
              lastRun.error ??
              "The run stopped before it finished. Whatever it had already written is still shown below."
            }
          />
        )}

        {liveRun !== null && (
          <div
            className="flex items-center gap-3 rounded-lg px-4 py-3"
            style={{
              backgroundColor: surfaceColors.panel,
              border: `1px solid ${surfaceColors.separator}`,
            }}
          >
            <Spin size="small" />
            <span className="text-sm" style={{ color: surfaceColors.text }}>
              Asking AWS…
            </span>
            <Progress
              percent={
                liveRun.total === null || liveRun.total === 0
                  ? 0
                  : Math.round((liveRun.processed / liveRun.total) * 100)
              }
              size="small"
              showInfo={false}
              strokeColor={COST_COLOR}
              style={{ flex: 1, marginBottom: 0 }}
            />
            <span className="text-xs tabular-nums" style={{ color: surfaceColors.textSecondary }}>
              {liveRun.processed} of {liveRun.total ?? "?"} calls
            </span>
          </div>
        )}

        <ListPanel>
          <div className="px-4 pt-3 pb-4">
            <div className="mb-2 flex items-center gap-2">
              <DollarOutlined aria-hidden style={{ color: COST_COLOR }} />
              <Typography.Text
                strong
                className="text-[11px] tracking-wide uppercase"
                style={{ color: surfaceColors.textSecondary }}
              >
                Daily spend
              </Typography.Text>
            </div>
            <CostBarChart bars={toBars(daily, days)} color={COST_COLOR} />
          </div>
        </ListPanel>

        {/* The one list on the page, and the only thing on it that scrolls. */}
        <ListTableRegion>
          <ListPanel>
            <ServicesTable rows={services} />
          </ListPanel>
        </ListTableRegion>
      </>
    );
  }

  return (
    <ListPageFrame
      title="Cost center"
      caption="AWS spend from Cost Explorer, cached once a day. Credits and refunds excluded; nothing is counted for today."
      figures={loading ? undefined : figures}
      ribbon={ribbon}
      rail={loading ? undefined : rail}
    >
      {body}
    </ListPageFrame>
  );
}

export { CostCenterPage };
export default CostCenterPage;
