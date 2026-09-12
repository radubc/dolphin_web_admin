"use client";

/**
 * The Cost center's breakdowns: the service table that fills the page's main
 * column, and the four rail cards beside it.
 *
 * The split follows the owner's layout rule. The one list — cost by service —
 * takes the width and is the only thing on the page whose rows scroll
 * (`ListTableRegion` gives it the height the ribbon, the alerts and the chart
 * leave over). Everything that is a *breakdown of* that list, or a note
 * about it, is a card down the right rail, which scrolls inside its own
 * `aside`.
 */

import { Empty, Progress, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { WarningOutlined } from "@ant-design/icons";
import { formatDay } from "@/lib/costs/calendar";
import {
  componentLabel,
  formatUsd,
  type CostAnomaly,
  type CostByComponent,
  type CostByService,
  type FreeTierState,
} from "@/lib/costs/types";
import { useListTableBodyHeight } from "@/lib/hooks/use-table-body-height";
import { cardSurfaceStyle, featureColors, surfaceColors, withAlpha } from "@/lib/theme/colors";

const COST_COLOR = featureColors.costCenter;

/* -------------------------------------------------------------------------- */
/* Card shell                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A rail card, the same surface `StatCard` uses.
 *
 * Not `StatCard` itself: that component draws labelled bars with a shared
 * denominator, and three of the four cards here are a table, a list and an
 * empty state.
 */
export function CostCard({
  title,
  extra,
  footnote,
  children,
}: {
  title: string;
  /** A count or a status, pinned to the right of the title. */
  extra?: React.ReactNode;
  footnote?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 p-4" style={cardSurfaceStyle} aria-label={title}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <Typography.Text
          strong
          className="text-[11px] tracking-wide uppercase"
          style={{ color: surfaceColors.textSecondary }}
        >
          {title}
        </Typography.Text>
        {extra}
      </div>
      {children}
      {footnote !== undefined && (
        <p className="mt-3 mb-0 text-xs" style={{ color: surfaceColors.textTertiary }}>
          {footnote}
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* By service                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The change between the month to date and the rolling 30-day window, as a
 * share of the latter.
 *
 * Deliberately *not* shown when the previous window is zero: "up ∞ %" is not
 * information, and a brand-new service is already obvious from a blank
 * previous column.
 */
function trendOf(row: CostByService): number | null {
  if (row.prev30Usd <= 0) return null;
  return (row.mtdUsd - row.prev30Usd) / row.prev30Usd;
}

function Trend({ row }: { row: CostByService }) {
  const trend = trendOf(row);
  if (trend === null) {
    return <span style={{ color: surfaceColors.textTertiary }}>—</span>;
  }
  // A month in progress is being compared with a full 30 days, so a negative
  // number early in the month is expected rather than good news. The tooltip
  // says so; the colour is reserved for the direction that costs money.
  const up = trend > 0.02;
  return (
    <Tooltip
      title={
        "This month so far against the 30 days ending yesterday. Early in a month " +
        "the month-to-date figure is naturally the smaller of the two."
      }
    >
      <span
        className="tabular-nums"
        style={{ color: up ? featureColors.rule : surfaceColors.textSecondary }}
      >
        {`${trend > 0 ? "+" : ""}${(trend * 100).toFixed(0)}%`}
      </span>
    </Tooltip>
  );
}

/** A share-of-total bar behind the amount, so the table reads at a glance. */
function ShareBar({ value, total }: { value: number; total: number }) {
  const share = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <span
      aria-hidden
      className="block overflow-hidden rounded-full"
      style={{ height: 4, backgroundColor: surfaceColors.chip }}
    >
      <span
        className="block h-full rounded-full"
        style={{ width: `${share * 100}%`, backgroundColor: COST_COLOR }}
      />
    </span>
  );
}

export function ServicesTable({ rows }: { rows: readonly CostByService[] }) {
  // Read from the region this table sits in, so the header stays put and the
  // rows are the only thing that scrolls.
  const y = useListTableBodyHeight();
  // The denominator for the share bars only; the figures strip and the
  // ribbon carry the totals a reader is actually looking for.
  const total = rows.reduce((sum, row) => sum + row.mtdUsd, 0);

  const columns: ColumnsType<CostByService> = [
    {
      title: "Service",
      dataIndex: "service",
      render: (value: string, row) => (
        <span className="flex flex-col gap-1">
          <span style={{ color: surfaceColors.text, fontWeight: 500 }}>{value}</span>
          <ShareBar value={row.mtdUsd} total={total} />
        </span>
      ),
    },
    {
      title: "Month to date",
      dataIndex: "mtdUsd",
      width: 140,
      align: "right",
      defaultSortOrder: "descend",
      sorter: (a, b) => a.mtdUsd - b.mtdUsd,
      render: (value: number) => (
        <span className="tabular-nums" style={{ color: surfaceColors.text }}>
          {formatUsd(value)}
        </span>
      ),
    },
    {
      title: "Last 30 days",
      dataIndex: "prev30Usd",
      width: 140,
      align: "right",
      sorter: (a, b) => a.prev30Usd - b.prev30Usd,
      render: (value: number) => (
        <span className="tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          {formatUsd(value)}
        </span>
      ),
    },
    {
      title: "Change",
      key: "trend",
      width: 100,
      align: "right",
      // Two rows with no trend are equal, not NaN: `-Infinity - -Infinity`
      // is NaN, and antd's comparator treats NaN as "leave it wherever it
      // happens to be", which makes the sort order of the untrended rows
      // arbitrary and unstable between clicks.
      sorter: (a, b) => {
        const left = trendOf(a);
        const right = trendOf(b);
        if (left === null && right === null) return 0;
        // A row with no previous window sorts below one that has a trend:
        // "no comparison possible" is not "no change".
        if (left === null) return -1;
        if (right === null) return 1;
        return left - right;
      },
      render: (_value, row) => <Trend row={row} />,
    },
  ];

  return (
    <Table<CostByService>
      dataSource={rows as CostByService[]}
      rowKey="service"
      columns={columns}
      size="middle"
      pagination={false}
      scroll={{ x: 720, y }}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No spend recorded for this month yet."
          />
        ),
      }}
      // No `summary` row: antd renders a summary outside `.ant-table-body`,
      // which `useTableBodyHeight` does not reserve, so a pinned totals row
      // would push the rows past the region it measured. The whole-list
      // totals are in the ribbon's trailing read-out instead.
    />
  );
}

/* -------------------------------------------------------------------------- */
/* By component                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The `Component` cost allocation tag's share of the month.
 *
 * Shown only when there is tag data: an empty table would say "we have no
 * idea" where the absence of the card, plus the note the page prints, says
 * "the tag is not switched on yet". Activation is in the Billing console and
 * is not retroactive.
 */
export function ComponentsTable({ rows }: { rows: readonly CostByComponent[] }) {
  const total = rows.reduce((sum, row) => sum + row.mtdUsd, 0);

  const columns: ColumnsType<CostByComponent> = [
    {
      title: "Component",
      dataIndex: "component",
      render: (value: string) => (
        <span style={{ color: surfaceColors.text }}>{componentLabel(value)}</span>
      ),
    },
    {
      title: "Month to date",
      dataIndex: "mtdUsd",
      align: "right",
      render: (value: number) => (
        <span className="tabular-nums" style={{ color: surfaceColors.text }}>
          {formatUsd(value)}
        </span>
      ),
    },
  ];

  return (
    <CostCard
      title="By component"
      extra={
        <span className="text-xs tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          {formatUsd(total)}
        </span>
      }
      footnote="From the Component cost allocation tag. Spend on resources the tag does not cover is shown as Untagged."
    >
      <Table<CostByComponent>
        dataSource={rows as CostByComponent[]}
        rowKey="component"
        columns={columns}
        size="small"
        pagination={false}
        showHeader={false}
      />
    </CostCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Anomalies                                                                  */
/* -------------------------------------------------------------------------- */

export function AnomaliesCard({ anomalies }: { anomalies: readonly CostAnomaly[] }) {
  return (
    <CostCard
      title="Anomalies"
      extra={
        anomalies.length === 0 ? undefined : (
          <Tag color="red" style={{ marginInlineEnd: 0 }}>
            {anomalies.length}
          </Tag>
        )
      }
      footnote="From AWS Cost Anomaly Detection, last 35 days. An account with no anomaly monitor shows nothing here either — create one (AWS services, account scope) if this should be watched."
    >
      {anomalies.length === 0 ? (
        <Typography.Text type="secondary" className="text-sm">
          Nothing unusual in the last 35 days.
        </Typography.Text>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {anomalies.map((anomaly) => (
            <li key={anomaly.id} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <WarningOutlined aria-hidden style={{ color: featureColors.rule }} />
                <span className="text-sm" style={{ color: surfaceColors.text }}>
                  {anomaly.service ?? "Unattributed"}
                </span>
                <span
                  className="ms-auto text-sm font-semibold tabular-nums"
                  style={{ color: featureColors.rule }}
                >
                  {formatUsd(anomaly.totalImpactUsd)}
                </span>
              </span>
              <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
                {anomaly.startDate === null ? "Date unknown" : formatDay(anomaly.startDate)}
                {anomaly.endDate === null ? " · still open" : ` to ${formatDay(anomaly.endDate)}`}
                {anomaly.totalExpectedUsd === null
                  ? ""
                  : ` · expected ${formatUsd(anomaly.totalExpectedUsd)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </CostCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Free tier                                                                  */
/* -------------------------------------------------------------------------- */

export function FreeTierCard({ state }: { state: FreeTierState }) {
  const offers = state.offers.slice(0, 8);
  return (
    <CostCard
      title="Free tier"
      extra={
        state.planType === null ? undefined : (
          <Tag style={{ marginInlineEnd: 0 }}>{state.planType}</Tag>
        )
      }
      footnote={
        state.expiresAt === null
          ? "Offers closest to their limit first."
          : `Plan expires ${new Date(state.expiresAt).toLocaleDateString("en-CA")}. Offers closest to their limit first.`
      }
    >
      {state.remainingCreditsUsd !== null && (
        <p className="mt-0 mb-3 text-sm" style={{ color: surfaceColors.text }}>
          {formatUsd(state.remainingCreditsUsd)} of credit left
        </p>
      )}
      {offers.length === 0 ? (
        <Typography.Text type="secondary" className="text-sm">
          No free-tier offers are being tracked for this account.
        </Typography.Text>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {offers.map((offer) => (
            <li key={`${offer.service}-${offer.description}`} className="flex flex-col gap-1">
              <span className="flex items-baseline justify-between gap-2 text-sm">
                <span style={{ color: surfaceColors.text }}>{offer.service}</span>
                <span className="tabular-nums" style={{ color: surfaceColors.textSecondary }}>
                  {offer.usedShare === null
                    ? `${offer.usedAmount ?? 0} ${offer.unit}`
                    : `${Math.round(offer.usedShare * 100)}%`}
                </span>
              </span>
              <span
                aria-hidden
                className="block overflow-hidden rounded-full"
                style={{ height: 4, backgroundColor: surfaceColors.chip }}
              >
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.min(1, offer.usedShare ?? 0) * 100}%`,
                    backgroundColor:
                      (offer.usedShare ?? 0) > 0.85 ? featureColors.rule : featureColors.loan,
                  }}
                />
              </span>
              {offer.description !== "" && (
                <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
                  {offer.description}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </CostCard>
  );
}

/* -------------------------------------------------------------------------- */
/* Budget                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The budget meter that sits in the header band beside the figures.
 *
 * Narrow on purpose — it has to share the band with three read-outs — and it
 * shows Budgets' own `CalculatedSpend`, not a figure derived here: a budget
 * can be scoped and filtered in ways this app does not model, and the number
 * in the alert email is AWS's.
 */
export function BudgetMeter({
  name,
  limitUsd,
  actualUsd,
}: {
  name: string;
  limitUsd: number | null;
  actualUsd: number | null;
}) {
  if (limitUsd === null || limitUsd <= 0) return null;
  const used = actualUsd ?? 0;
  const percent = Math.min(100, Math.round((used / limitUsd) * 100));
  const over = used > limitUsd;
  const near = !over && used > limitUsd * 0.8;

  return (
    <Tooltip
      title={`AWS budget “${name}”: ${formatUsd(used)} of ${formatUsd(limitUsd)} used, as Budgets itself calculates it.`}
    >
      <span tabIndex={0} className="flex w-44 flex-col gap-0.5">
        <span
          className="text-[11px] font-medium tracking-wide uppercase"
          style={{ color: surfaceColors.textSecondary }}
        >
          Budget
        </span>
        <Progress
          percent={percent}
          size="small"
          showInfo={false}
          strokeColor={over ? featureColors.rule : near ? featureColors.incomeBills : COST_COLOR}
          trailColor={withAlpha(COST_COLOR, 0.14)}
          style={{ marginBottom: 0 }}
        />
        <span
          className="text-[11px] tabular-nums"
          style={{ color: over ? featureColors.rule : surfaceColors.textSecondary }}
        >
          {formatUsd(used)} of {formatUsd(limitUsd)}
        </span>
      </span>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* Cost per client                                                            */
/* -------------------------------------------------------------------------- */
/**
 * The real card is `./cost-per-client-section.tsx`: the allocation exists now
 * (`admin_tenant_cost_monthly`, written nightly by `allocate_costs`), so the
 * empty placeholder that used to sit here — added and superseded the same
 * day, never shipped to a page — is gone. See docs/cost-allocation.md.
 */
