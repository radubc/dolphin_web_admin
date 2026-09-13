"use client";

/**
 * Customers → Activity: how the customer population is moving, rather than
 * who is in it.
 *
 * Every figure here is history, and history is something neither source keeps
 * on its own. Cognito answers "who is in the pool right now" and has no event
 * or trigger for a deletion; the main app database knows who signed in and
 * how much they used the product, but nothing about someone who never got
 * that far. So the nightly `cognito_directory` run writes a snapshot, the
 * difference between two snapshots is the lifecycle log, and this view is a
 * read of those tables plus the app database. **Nothing on this screen calls
 * AWS.** "Take snapshot" starts the same integration run the Integrations
 * page would, and unlike the Cost center's refresh it is free, so it carries
 * no price warning.
 *
 * Two sections can be empty while the rest is full, and the view says which:
 * the account census and the funnel's first two steps come from the pool
 * snapshot, and the sign-ins chart from CloudWatch, so a deployment where the
 * SQL has run but the job has not shows those as "no snapshot yet" while the
 * active-user, churn, retention, usage and tenant figures answer normally.
 *
 * **Layout.** `ListPageFrame`, like every other screen: a sticky band with the
 * title, the figures strip and the ribbon, and below it a stack of cards that
 * scrolls in the frame's body. That is the branch of the owner's layout rule
 * for content that is not a list — the rule's "only the rows scroll" applies
 * to a page whose body *is* a table, and this one has four small tables inside
 * cards, none of which is the page. Every table is complete and unpaged: the
 * retention table is one row per month in the window (24 at most), the tenant
 * tables are ten rows each by construction, so there is nothing to scroll to.
 */

import { useState } from "react";
import { Alert, Button, Segmented, Spin, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CameraOutlined,
  CloudOutlined,
  DatabaseOutlined,
  FunnelPlotOutlined,
  LineChartOutlined,
  LoadingOutlined,
  PieChartOutlined,
  ReloadOutlined,
  RiseOutlined,
} from "@ant-design/icons";
import DayBarChart, { type DayBar } from "@/components/day-bar-chart";
import Figures, { type Figure } from "@/components/figures";
import { ListPageFrame } from "@/components/list-page-frame";
import { RibbonBar, RibbonButton, RibbonDivider } from "@/components/ribbon-bar";
import { ResponsiveTable } from "@/components/responsive-table";
import StatCard from "@/components/stat-card";
import {
  DAU_WINDOW_DAYS,
  MAU_WINDOW_DAYS,
  WAU_WINDOW_DAYS,
  type ChurnMonth,
  type RetentionMonth,
  type TenantSize,
} from "@/lib/customers/types";
import {
  formatBytes,
  formatDateTimeOrDash,
  formatIsoDay,
  formatPercentOrDash,
  formatRelativeTimeOrNever,
  pluralise,
} from "@/lib/format";
import { cardSurfaceStyle, featureColors, surfaceColors } from "@/lib/theme/colors";
import { COGNITO_STATUS_LABELS, CUSTOMERS_COLOR } from "./customers-meta";
import {
  STATISTICS_DAY_OPTIONS,
  STATISTICS_MONTH_OPTIONS,
  useCustomerStatistics,
} from "./use-customer-statistics";

/* -------------------------------------------------------------------------- */
/* Day arithmetic                                                             */
/* -------------------------------------------------------------------------- */
/**
 * Three helpers rather than an import, so this view does not reach into the
 * cost feature's calendar for generic UTC day maths. Both databases and both
 * AWS services in play measure a day as a UTC day, so none of this looks at a
 * timezone.
 */

/** Today as `YYYY-MM-DD`, UTC — the same day the server measured from. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `delta` days after (or, negative, before) a `YYYY-MM-DD` day. */
function shiftIsoDay(day: string, delta: number): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

/** `[from … to]` inclusive. Capped so a bad input cannot spin. */
function isoDaysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = from;
  for (let guard = 0; guard < 1000 && cursor <= to; guard += 1) {
    days.push(cursor);
    cursor = shiftIsoDay(cursor, 1);
  }
  return days;
}

/**
 * A series as bars: one slot per day in the range, whether or not the series
 * carries that day.
 *
 * The gaps are filled here rather than by the endpoint, which keeps the wire
 * honest — "no row" and "zero" are different facts, and for sign-ins the
 * difference is "we have not asked yet" against "nobody signed in" — while
 * the chart still draws a continuous axis.
 */
function toBars(
  days: readonly string[],
  values: Map<string, number>,
  mutedDay?: string,
): DayBar[] {
  return days.map((day) => ({
    day,
    value: values.get(day) ?? null,
    muted: day === mutedDay,
  }));
}

/* -------------------------------------------------------------------------- */
/* Small pieces                                                               */
/* -------------------------------------------------------------------------- */

/** A card on the page's stack: the app's card surface with a titled header. */
function Card({
  title,
  icon,
  caption,
  extra,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  caption?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="p-4" style={cardSurfaceStyle} aria-label={title}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span aria-hidden style={{ color: CUSTOMERS_COLOR }}>
              {icon}
            </span>
            <Typography.Text
              strong
              className="text-[11px] tracking-wide uppercase"
              style={{ color: surfaceColors.textSecondary }}
            >
              {title}
            </Typography.Text>
          </span>
          {caption !== undefined && (
            <Typography.Text type="secondary" className="text-xs">
              {caption}
            </Typography.Text>
          )}
        </span>
        {extra !== undefined && <span className="shrink-0">{extra}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * One step of the funnel: a labelled bar whose width is its share of the first
 * step, with the drop from the step above it named underneath.
 *
 * Drawn as measured, never forced to descend — the first two steps are counted
 * in Cognito and the last three in the app database, so a step wider than the
 * one above it is a real inconsistency worth seeing rather than a rendering
 * problem worth hiding.
 */
function FunnelStep({
  label,
  value,
  top,
  previous,
  tooltip,
  color,
}: {
  label: string;
  value: number;
  /** The first step, which is the bar's denominator. */
  top: number;
  /** The step above this one, for the drop. `null` for the first. */
  previous: number | null;
  tooltip: string;
  color: string;
}) {
  const share = top > 0 ? Math.min(1, value / top) : 0;
  const drop = previous === null || previous <= 0 ? null : previous - value;
  return (
    <Tooltip title={tooltip}>
      <div className="flex min-w-0 flex-1 flex-col gap-1" tabIndex={0}>
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-xs" style={{ color: surfaceColors.textSecondary }}>
            {label}
          </span>
          <span
            className="text-base leading-none font-semibold tabular-nums"
            style={{ color: surfaceColors.text }}
          >
            {value.toLocaleString()}
          </span>
        </span>
        <span
          className="h-1.5 w-full overflow-hidden rounded-full"
          style={{ backgroundColor: surfaceColors.chip }}
          aria-hidden
        >
          <span
            className="block h-full rounded-full"
            style={{ width: `${share * 100}%`, backgroundColor: color }}
          />
        </span>
        <span className="text-[11px]" style={{ color: surfaceColors.textTertiary }}>
          {previous === null
            ? `${formatPercentOrDash(top > 0 ? 100 : null)} of the pool`
            : drop === null
              ? "—"
              : `${formatPercentOrDash(top > 0 ? (value / top) * 100 : null)} · ${drop >= 0 ? `${drop.toLocaleString()} did not` : `${Math.abs(drop).toLocaleString()} more`}`}
        </span>
      </div>
    </Tooltip>
  );
}

/** The label for a Cognito status the console knows, else the raw value. */
function statusLabel(status: string): string {
  const known = COGNITO_STATUS_LABELS as Record<string, string | undefined>;
  return known[status] ?? status;
}

/** `2026-09` → `September 2026`. */
function monthLabel(month: string): string {
  const time = Date.parse(`${month}-01T00:00:00Z`);
  if (Number.isNaN(time)) return month;
  return new Intl.DateTimeFormat("en-CA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(time));
}

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

interface ActivityViewProps {
  /** The view segmented control, drawn in the ribbon by every view. */
  switcher: React.ReactNode;
  /** Whether this operator may start an integration run ("Take snapshot"). */
  canSnapshot: boolean;
}

export default function ActivityView({ switcher, canSnapshot }: ActivityViewProps) {
  const store = useCustomerStatistics();
  const stats = store.statistics;
  const [tenantsBy, setTenantsBy] = useState<"bytes" | "transactions">("bytes");

  /* -------------------------------- Figures ------------------------------- */

  const thisMonth = (series: { month: string; count: number }[]) =>
    series.length === 0 ? 0 : (series.at(-1)?.count ?? 0);
  const currentChurn: ChurnMonth | null = stats?.churnPerMonth.at(-1) ?? null;

  const figureList: Figure[] = [
    {
      label: "Accounts",
      value: (stats?.accounts.total ?? 0).toLocaleString(),
      color: CUSTOMERS_COLOR,
      tooltip:
        stats?.accounts.snapshotDay === null || stats === null
          ? "Accounts in the customer Cognito pool. Empty until the cognito_directory job has taken its first snapshot."
          : `Accounts in the customer Cognito pool as of the snapshot on ${formatIsoDay(stats.accounts.snapshotDay)}.`,
    },
    {
      label: "MAU",
      value: (stats?.mau ?? 0).toLocaleString(),
      color: (stats?.mau ?? 0) > 0 ? featureColors.loan : undefined,
      tooltip: `Live customers whose last_seen_at is inside the last ${MAU_WINDOW_DAYS} days. Sign-ins, not changes — the consumer app stamps the column at sign-in and refreshes it hourly.`,
      separatorBefore: true,
    },
    {
      label: "WAU",
      value: (stats?.wau ?? 0).toLocaleString(),
      tooltip: `Live customers seen in the last ${WAU_WINDOW_DAYS} days.`,
    },
    {
      label: "DAU",
      value: (stats?.dau ?? 0).toLocaleString(),
      tooltip: `Live customers seen in the last ${DAU_WINDOW_DAYS === 1 ? "24 hours" : `${DAU_WINDOW_DAYS} days`}.`,
    },
    {
      label: "Churn",
      value: formatPercentOrDash(currentChurn?.churnPct ?? null),
      color:
        currentChurn !== null && currentChurn.churnPct !== null && currentChurn.churnPct > 0
          ? featureColors.rule
          : undefined,
      tooltip:
        currentChurn === null
          ? "Departures this month over the customers the month began with."
          : `${currentChurn.deleted} ${currentChurn.deleted === 1 ? "departure" : "departures"} this month over the ${currentChurn.activeAtStart.toLocaleString()} customers it began with. A partial month — it grows until the 1st.`,
      separatorBefore: true,
    },
    {
      label: "New",
      value: thisMonth(stats?.newPerMonth ?? []).toLocaleString(),
      tooltip: "New customer rows this month: people who signed in to the consumer app for the first time.",
    },
    {
      label: "Deleted",
      value: thisMonth(stats?.deletedPerMonth ?? []).toLocaleString(),
      color: thisMonth(stats?.deletedPerMonth ?? []) > 0 ? featureColors.rule : undefined,
      tooltip:
        "Accounts that went away this month: removed from the pool, or deleted through the consumer app. One person counts once.",
    },
  ];

  /* --------------------------------- Rail -------------------------------- */

  const byStatus = Object.entries(stats?.accounts.byStatus ?? {})
    .map(([status, count]) => ({
      label: statusLabel(status),
      value: count,
      color:
        status === "confirmed"
          ? featureColors.loan
          : status === "force_change_password"
            ? "#D4A017"
            : featureColors.neutral,
      tooltip: `${count.toLocaleString()} ${count === 1 ? "account" : "accounts"} with Cognito status ${status}.`,
    }))
    .sort((a, b) => b.value - a.value);

  const rail = (
    <div className="flex flex-col gap-4">
      <StatCard
        title="Pool accounts by status"
        icon={<PieChartOutlined style={{ color: CUSTOMERS_COLOR }} />}
        total={Math.max(1, stats?.accounts.total ?? 0)}
        rows={byStatus}
        footnote={
          stats === null || stats.accounts.snapshotDay === null
            ? "No directory snapshot yet. Press Take snapshot, or wait for the nightly run at 02:30 Toronto time."
            : `From the snapshot on ${formatIsoDay(stats.accounts.snapshotDay)}. ${stats.accounts.disabled.toLocaleString()} ${stats.accounts.disabled === 1 ? "account is" : "accounts are"} disabled.`
        }
      />
      <StatCard
        title="Requests and errors"
        icon={<DatabaseOutlined style={{ color: CUSTOMERS_COLOR }} />}
        rows={[
          {
            label: "Requests",
            value: (stats?.usage.requestsPerDay ?? []).reduce((sum, day) => sum + day.requests, 0),
            color: featureColors.banking,
            tooltip: "Consumer-app API requests in the window, from usage_daily.",
          },
          {
            label: "Errors",
            value: (stats?.usage.errorsPerDay ?? []).reduce((sum, day) => sum + day.errors, 0),
            color: featureColors.rule,
            tooltip: "Requests the consumer app answered with an error. A support signal before anyone writes in.",
          },
          {
            label: "Sync rows",
            value: (stats?.usage.requestsPerDay ?? []).reduce((sum, day) => sum + day.syncRows, 0),
            color: featureColors.asset,
            tooltip: "Rows written through the consumer app's /sync routes.",
          },
        ]}
        footnote={`Totals over the last ${pluralise(stats?.days ?? 0, "day")}, every tenant together. Uploads: ${formatBytes((stats?.usage.requestsPerDay ?? []).reduce((sum, day) => sum + day.bytesUploaded, 0))}.`}
      />
    </div>
  );

  /* -------------------------------- Ribbon ------------------------------- */

  const ribbon = (
    <RibbonBar
      trailing={
        <span
          className="shrink-0 pr-1 text-right text-[11px] tabular-nums"
          style={{ color: surfaceColors.textSecondary }}
        >
          {store.refreshing && (
            <>
              <LoadingOutlined aria-hidden /> Loading…{" · "}
            </>
          )}
          {store.liveRun !== null
            ? `Snapshot ${store.liveRun.status}…`
            : stats === null
              ? ""
              : `snapshot ${stats.accounts.snapshotDay === null ? "never" : formatRelativeTimeOrNever(`${stats.accounts.snapshotDay}T00:00:00Z`)}`}
        </span>
      }
    >
      {canSnapshot && (
        <>
          <RibbonButton
            label="Take Snapshot"
            icon={store.snapshotting ? <LoadingOutlined /> : <CameraOutlined />}
            onClick={store.snapshotNow}
            disabled={store.snapshotting}
            tooltip="Read the Cognito pool now, record what changed since the last snapshot, and re-read the pool's CloudWatch counters. Free — no AWS call on this path is charged."
          />
          <RibbonDivider />
        </>
      )}

      <RibbonButton
        label="Refresh"
        icon={store.refreshing ? <LoadingOutlined /> : <ReloadOutlined />}
        onClick={store.reload}
        disabled={store.refreshing}
        tooltip="Re-read the figures. Costs nothing and calls no provider."
      />

      <RibbonDivider />
      <span role="group" aria-label="Months covered" className="inline-block min-w-max">
        <Segmented<number>
          value={store.months}
          onChange={store.setMonths}
          options={[...STATISTICS_MONTH_OPTIONS]}
        />
      </span>
      <span role="group" aria-label="Days covered" className="inline-block min-w-max">
        <Segmented<number>
          value={store.days}
          onChange={store.setDays}
          options={[...STATISTICS_DAY_OPTIONS]}
        />
      </span>

      <RibbonDivider />
      {switcher}
    </RibbonBar>
  );

  /* --------------------------------- Body -------------------------------- */

  let body: React.ReactNode;

  if (store.loading) {
    body = (
      <section className="p-4" style={cardSurfaceStyle}>
        <div className="flex items-center justify-center py-16">
          <Spin />
        </div>
      </section>
    );
  } else if (stats === null) {
    body = (
      <Alert
        type="error"
        showIcon
        title="The customer statistics could not be loaded."
        description={store.error ?? undefined}
        action={
          <Button size="small" onClick={store.reload}>
            Retry
          </Button>
        }
      />
    );
  } else {
    const today = todayUtc();
    const yesterday = shiftIsoDay(today, -1);
    const chartFrom = shiftIsoDay(today, -stats.days);

    const signInDays = isoDaysBetween(chartFrom, yesterday);
    const signInBars = toBars(
      signInDays,
      new Map(stats.poolMetrics.map((day) => [day.day, day.signIns])),
    );
    const usageDays = isoDaysBetween(chartFrom, today);
    const requestBars = toBars(
      usageDays,
      new Map(stats.usage.requestsPerDay.map((day) => [day.day, day.requests])),
      today,
    );

    const churnColumns: ColumnsType<ChurnMonth> = [
      {
        title: "Month",
        dataIndex: "month",
        width: 150,
        render: (value: string) => monthLabel(value),
      },
      {
        title: "Began with",
        dataIndex: "activeAtStart",
        width: 110,
        align: "right",
        render: (value: number) => <span className="tabular-nums">{value.toLocaleString()}</span>,
      },
      {
        title: "Left",
        dataIndex: "deleted",
        width: 90,
        align: "right",
        render: (value: number) => (
          <span className="tabular-nums" style={{ color: value > 0 ? featureColors.rule : undefined }}>
            {value.toLocaleString()}
          </span>
        ),
      },
      {
        title: "Churn",
        dataIndex: "churnPct",
        width: 90,
        align: "right",
        render: (value: number | null) => (
          <span className="tabular-nums">{formatPercentOrDash(value)}</span>
        ),
      },
      {
        title: "New",
        key: "new",
        width: 90,
        align: "right",
        render: (_value, row) => {
          const entry = stats.newPerMonth.find((month) => month.month === row.month);
          return <span className="tabular-nums">{(entry?.count ?? 0).toLocaleString()}</span>;
        },
      },
    ];

    const retentionColumns: ColumnsType<RetentionMonth> = [
      {
        title: "Signed up",
        dataIndex: "month",
        width: 150,
        render: (value: string) => monthLabel(value),
      },
      {
        title: "Cohort",
        dataIndex: "cohort",
        width: 100,
        align: "right",
        render: (value: number) => <span className="tabular-nums">{value.toLocaleString()}</span>,
      },
      {
        title: `Seen in ${MAU_WINDOW_DAYS}d`,
        dataIndex: "retained",
        width: 120,
        align: "right",
        render: (value: number) => <span className="tabular-nums">{value.toLocaleString()}</span>,
      },
      {
        title: "Retained",
        dataIndex: "retainedPct",
        width: 160,
        render: (value: number | null) => (
          <span className="flex items-center gap-2">
            <span
              className="h-1.5 flex-1 overflow-hidden rounded-full"
              style={{ backgroundColor: surfaceColors.chip }}
              aria-hidden
            >
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.min(100, value ?? 0)}%`,
                  backgroundColor: featureColors.loan,
                }}
              />
            </span>
            <span className="w-12 shrink-0 text-right tabular-nums">
              {formatPercentOrDash(value)}
            </span>
          </span>
        ),
      },
    ];

    const tenantColumns: ColumnsType<TenantSize> = [
      {
        title: "Tenant",
        dataIndex: "name",
        render: (value: string | null, row) => (
          <span className="flex flex-col">
            <span className="truncate" style={{ color: surfaceColors.text }}>
              {value ?? "(deleted tenant)"}
            </span>
            <code className="text-[10px]" style={{ color: surfaceColors.textTertiary }}>
              {row.tenantId}
            </code>
          </span>
        ),
      },
      {
        title: "Attachments",
        dataIndex: "bytes",
        width: 120,
        align: "right",
        render: (value: number) => <span className="tabular-nums">{formatBytes(value)}</span>,
      },
      {
        title: "Transactions",
        dataIndex: "transactions",
        width: 120,
        align: "right",
        render: (value: number) => <span className="tabular-nums">{value.toLocaleString()}</span>,
      },
    ];

    const funnel = stats.funnel;

    body = (
      <>
        {store.error !== null && <Alert type="warning" showIcon closable title={store.error} />}

        {funnel.snapshotDay === null && (
          <Alert
            type="info"
            showIcon
            title="No Cognito directory snapshot yet."
            description="Account counts, the funnel's first two steps and the sign-ins chart stay empty until the cognito_directory integration has run once. It runs nightly at 02:30 Toronto time; Take snapshot does it now, and costs nothing."
          />
        )}

        <Card
          title="Sign-ins per day"
          icon={<CloudOutlined />}
          caption={`From the customer pool's AWS/Cognito CloudWatch counters, one bar per UTC day, ending yesterday. Pool-wide: Cognito bills per-user activity on a tier this deployment does not use, so "who signed in" comes from last_seen_at instead.`}
        >
          <DayBarChart
            bars={signInBars}
            color={CUSTOMERS_COLOR}
            formatValue={(value) => value.toLocaleString()}
            note="per day, UTC · sign-in successes"
            missingLabel="no figure from CloudWatch"
            emptyLabel="No pool metrics yet."
            summary={(count, peak) =>
              `Successful sign-ins per day for the last ${count} days. Peak ${peak} in a day.`
            }
          />
        </Card>

        <Card
          title="Consumer-app requests per day"
          icon={<DatabaseOutlined />}
          caption="Summed from usage_daily across every tenant. Today is still being counted and is drawn lighter."
        >
          <DayBarChart
            bars={requestBars}
            color={featureColors.banking}
            formatValue={(value) => value.toLocaleString()}
            note="per day, UTC · lighter bar is today, still counting"
            mutedSuffix="(today, still counting)"
            missingLabel="no requests recorded"
            emptyLabel="No usage recorded yet."
            summary={(count, peak) =>
              `Consumer-app requests per day for the last ${count} days. Peak ${peak} in a day.`
            }
          />
        </Card>

        <Card
          title="Invitation funnel"
          icon={<FunnelPlotOutlined />}
          caption={
            funnel.snapshotDay === null
              ? "The first two steps need a directory snapshot; the last three are live from the app database."
              : `The first two steps are the pool as of ${formatIsoDay(funnel.snapshotDay)}; the last three are live from the app database. Shown as measured, never forced to descend.`
          }
        >
          <div className="flex flex-wrap items-start gap-6">
            <FunnelStep
              label="Invited"
              value={funnel.invited}
              top={funnel.invited}
              previous={null}
              color={CUSTOMERS_COLOR}
              tooltip="Accounts in the customer pool. There is no self-service sign-up, so every one of them was invited by an operator."
            />
            <FunnelStep
              label="Confirmed"
              value={funnel.confirmed}
              top={funnel.invited}
              previous={funnel.invited}
              color={featureColors.asset}
              tooltip="Pool accounts whose status is CONFIRMED: the person set their own password."
            />
            <FunnelStep
              label="Onboarded"
              value={funnel.onboarded}
              top={funnel.invited}
              previous={funnel.confirmed}
              color={featureColors.budget}
              tooltip="Live users with at least one live tenant membership: they got through onboarding."
            />
            <FunnelStep
              label="First transaction"
              value={funnel.firstTransaction}
              top={funnel.invited}
              previous={funnel.onboarded}
              color={featureColors.incomeBills}
              tooltip="Of those, the ones whose tenant holds at least one live transaction."
            />
            <FunnelStep
              label="First attachment"
              value={funnel.firstAttachment}
              top={funnel.invited}
              previous={funnel.firstTransaction}
              color={featureColors.loan}
              tooltip="Of those, the ones whose tenant holds at least one live file. The last step anyone reaches."
            />
          </div>
        </Card>

        <Card
          title="New, lost and churn by month"
          icon={<RiseOutlined />}
          caption={`Churn is departures divided by the customers the month began with — everyone who existed and had not been deleted at 00:00 UTC on the 1st, plus anyone seen in the ${MAU_WINDOW_DAYS} days before it. The last row is the month in progress.`}
        >
          <ResponsiveTable<ChurnMonth>
            dataSource={[...stats.churnPerMonth].reverse()}
            rowKey="month"
            columns={churnColumns}
            size="small"
            pagination={false}
            scroll={{ x: 540 }}
          />
        </Card>

        <Card
          title="Retention by sign-up month"
          icon={<LineChartOutlined />}
          caption={`Of everyone whose account was created in a month, how many have been seen in the last ${MAU_WINDOW_DAYS} days. A deleted account stays in the cohort and can never be retained, so a cohort that left reads as retention falling.`}
        >
          <ResponsiveTable<RetentionMonth>
            dataSource={[...stats.retentionBySignupMonth].reverse()}
            rowKey="month"
            columns={retentionColumns}
            size="small"
            pagination={false}
            scroll={{ x: 540 }}
          />
        </Card>

        <Card
          title="Largest tenants"
          icon={<DatabaseOutlined />}
          caption="Who holds the most data, and who uses the product hardest. Both are live row counts from the app database — no AWS call and no allocation."
          extra={
            <span role="group" aria-label="Rank largest tenants by">
              <Segmented<"bytes" | "transactions">
                size="small"
                value={tenantsBy}
                onChange={setTenantsBy}
                options={[
                  { value: "bytes", label: "Attachments" },
                  { value: "transactions", label: "Transactions" },
                ]}
              />
            </span>
          }
        >
          <ResponsiveTable<TenantSize>
            dataSource={
              tenantsBy === "bytes"
                ? stats.largestTenants.byBytes
                : stats.largestTenants.byTransactions
            }
            rowKey="tenantId"
            columns={tenantColumns}
            size="small"
            pagination={false}
            scroll={{ x: 520 }}
          />
        </Card>

        <Typography.Text type="secondary" className="text-xs">
          Assembled {formatDateTimeOrDash(stats.generatedAt)} UTC. Pool figures are as fresh as the
          last snapshot; everything else is live.
        </Typography.Text>
      </>
    );
  }

  return (
    <ListPageFrame
      title="Customers"
      caption="How the customer population is moving: who is active, who arrived, who left, and where a new person stalls."
      figures={stats !== null ? <Figures label="Customer activity" figures={figureList} /> : undefined}
      ribbon={ribbon}
      rail={stats !== null ? rail : undefined}
    >
      {body}
    </ListPageFrame>
  );
}
