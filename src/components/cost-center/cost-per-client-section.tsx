"use client";

/**
 * Cost per client: the rail card on the Cost center page, and the drawer that
 * holds the whole table.
 *
 * **It sits in the rail, so it is a summary and a door.** The owner's layout
 * rule gives the page's width to one list — cost by service — and the rail to
 * the breakdowns of it, each in its own card. A per-tenant table with ten
 * columns does not fit in a 320-pixel column, so the card shows the month's
 * four pool totals and the ten most expensive tenants, and "See all" opens the
 * full table in a drawer where the rows are the only thing that scrolls
 * (`ListTableRegion`, exactly as the runs drawer does it).
 *
 * **Everything here is labelled an estimate, in words, every time.** AWS bills
 * per resource and every resource except an S3 object is shared by all
 * tenants, so a per-client figure is an allocation of the month's bill over
 * measured usage — never an invoice. The tag says "Allocated estimate", the
 * tooltip says how the split is made, and the card names the nightly run that
 * computed it and when. See `docs/cost-allocation.md`.
 *
 * The page never recomputes: the `allocate_costs` integration writes
 * `admin_tenant_cost_monthly` once a night and this reads it.
 */

import { useState } from "react";
import { Alert, Button, Drawer, Empty, Select, Spin, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PieChartOutlined, TeamOutlined } from "@ant-design/icons";
import { ListTableRegion } from "@/components/list-page-frame";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import type { PerClientTenant } from "@/lib/costs/allocation";
import { formatMonth } from "@/lib/costs/calendar";
import { formatUsd } from "@/lib/costs/types";
import { formatBytes, formatRelativeTimeOrNever, pluralise } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import { CostCard } from "./cost-breakdowns";
import {
  ALLOCATION_NOTE,
  PER_CLIENT_TOP,
  monthOptions,
  usePerClient,
} from "./cost-per-client-data";

const COST_COLOR = featureColors.costCenter;

/** The four pools, in the order the card and the drawer both list them. */
const POOLS = [
  {
    key: "fixedUsd" as const,
    label: "Shared capacity",
    hint: "ECS, RDS, the load balancer, NAT, WAF, Route 53, Secrets Manager, CloudWatch — and any service the pools map does not recognise. Split by requests and sync rows, after every tenant still live at the end of the month is given a small floor (all the floors together take at most half the pool).",
  },
  {
    key: "storageUsd" as const,
    label: "Storage",
    hint: "S3. Split by attachment bytes plus an estimated 512 bytes per transaction row, as a stand-in for the database footprint.",
  },
  {
    key: "requestUsd" as const,
    label: "Data transfer",
    hint: "Data transfer and CDN charges, split by requests. Usually zero: this account's traffic is small enough that what is charged arrives inside EC2 - Other instead.",
  },
  {
    key: "userUsd" as const,
    label: "Cognito",
    hint: "Cognito bills per monthly active user, so this pool is split by the tenant's active users in the month. A tenant nobody signed in to gets none of it.",
  },
];

/** A label, an amount, and a tooltip saying what the amount is. */
function PoolLine({
  label,
  hint,
  amountUsd,
  emphasis,
}: {
  label: string;
  hint: string;
  amountUsd: number;
  emphasis?: boolean;
}) {
  return (
    <Tooltip title={hint}>
      <span tabIndex={0} className="flex items-baseline justify-between gap-3 text-sm">
        <span style={{ color: emphasis ? surfaceColors.text : surfaceColors.textSecondary }}>
          {label}
        </span>
        <span
          className="tabular-nums"
          style={{
            color: emphasis ? surfaceColors.text : surfaceColors.textSecondary,
            fontWeight: emphasis ? 600 : 400,
          }}
        >
          {formatUsd(amountUsd)}
        </span>
      </span>
    </Tooltip>
  );
}

/** A share-of-the-month bar behind a tenant's amount. */
function ShareBar({ share }: { share: number }) {
  return (
    <span
      aria-hidden
      className="block overflow-hidden rounded-full"
      style={{ height: 4, backgroundColor: surfaceColors.chip }}
    >
      <span
        className="block h-full rounded-full"
        style={{
          width: `${Math.max(1, Math.min(100, share))}%`,
          backgroundColor: COST_COLOR,
        }}
      />
    </span>
  );
}

/** What a row calls the tenant: its name, else the bare id. */
function tenantLabel(tenant: PerClientTenant): string {
  return tenant.tenantName ?? `${tenant.tenantId.slice(0, 8)}…`;
}

/* -------------------------------------------------------------------------- */
/* The full table, in a drawer                                                */
/* -------------------------------------------------------------------------- */

/**
 * The drawer's columns: the tenant, its total and share, the four pool
 * components, and the three drivers the split was made from.
 *
 * A function rather than a module constant only because the cells close over
 * the row type; there is no state in here.
 */
function perClientColumns(): ColumnsType<PerClientTenant> {
  return [
    {
      title: "Tenant",
      key: "tenant",
      width: 220,
      fixed: "left",
      render: (_value, row) => (
        <span className="flex flex-col">
          <span className="truncate" style={{ color: surfaceColors.text, fontWeight: 500 }}>
            {tenantLabel(row)}
            {row.deleted && (
              <Tag color="red" style={{ marginInlineStart: 6, marginInlineEnd: 0 }}>
                Deleted
              </Tag>
            )}
          </span>
          <span className="truncate text-xs" style={{ color: surfaceColors.textTertiary }}>
            {row.ownerEmail ?? "no member"}
          </span>
        </span>
      ),
    },
    {
      title: "Total",
      dataIndex: "totalUsd",
      width: 120,
      align: "right",
      defaultSortOrder: "descend",
      sorter: (a, b) => a.totalUsd - b.totalUsd,
      render: (value: number, row) => (
        <span className="flex flex-col items-end gap-1">
          <span className="tabular-nums" style={{ color: surfaceColors.text, fontWeight: 600 }}>
            {formatUsd(value)}
          </span>
          <span className="block w-full">
            <ShareBar share={row.sharePct} />
          </span>
        </span>
      ),
    },
    {
      title: "Share",
      dataIndex: "sharePct",
      width: 90,
      align: "right",
      sorter: (a, b) => a.sharePct - b.sharePct,
      render: (value: number) => (
        <span className="tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          {value.toFixed(2)}%
        </span>
      ),
    },
    ...POOLS.map((pool) => ({
      title: pool.label,
      dataIndex: pool.key,
      width: 130,
      align: "right" as const,
      sorter: (a: PerClientTenant, b: PerClientTenant) => a[pool.key] - b[pool.key],
      render: (value: number) => (
        <Tooltip title={pool.hint}>
          <span
            tabIndex={0}
            className="tabular-nums"
            style={{ color: surfaceColors.textSecondary }}
          >
            {formatUsd(value)}
          </span>
        </Tooltip>
      ),
    })),
    {
      title: "Requests",
      dataIndex: "requests",
      width: 110,
      align: "right",
      sorter: (a, b) => a.requests - b.requests,
      render: (value: number) => (
        <span className="tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          {value.toLocaleString()}
        </span>
      ),
    },
    {
      title: "Data",
      dataIndex: "storageBytes",
      width: 110,
      align: "right",
      sorter: (a, b) => a.storageBytes - b.storageBytes,
      render: (value: number) => (
        <Tooltip title="Live attachment bytes plus an estimated 512 bytes per transaction row. Measured now, not as it was during the month.">
          <span
            tabIndex={0}
            className="tabular-nums"
            style={{ color: surfaceColors.textSecondary }}
          >
            {formatBytes(value)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "Active users",
      dataIndex: "activeUsers",
      width: 110,
      align: "right",
      sorter: (a, b) => a.activeUsers - b.activeUsers,
      render: (value: number) => (
        <Tooltip title="Distinct people of this tenant who signed in, or recorded any usage, inside the month. The Cognito pool is split by this.">
          <span
            tabIndex={0}
            className="tabular-nums"
            style={{ color: surfaceColors.textSecondary }}
          >
            {value.toLocaleString()}
          </span>
        </Tooltip>
      ),
    },
  ];
}

/** The full table, given the height its region measured. */
function PerClientTableRegion({ tenants }: { tenants: readonly PerClientTenant[] }) {
  return (
    // No `ListPanel` around it: the table sits directly in the drawer body, so
    // there is no panel border for the region to reserve.
    <ListTableRegion panelBorder={false}>
      {(y) => (
        <Table<PerClientTenant>
          dataSource={tenants as PerClientTenant[]}
          rowKey="tenantId"
          columns={perClientColumns()}
          size="small"
          pagination={false}
          scroll={{ x: 1200, y }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No tenant has been allocated any of this month yet."
              />
            ),
          }}
        />
      )}
    </ListTableRegion>
  );
}

/* -------------------------------------------------------------------------- */
/* The card                                                                   */
/* -------------------------------------------------------------------------- */

export default function CostPerClientSection() {
  const { month, setMonth, data, loading, error } = usePerClient();
  const [open, setOpen] = useState(false);

  const tenants = data?.tenants ?? [];
  const top = tenants.slice(0, PER_CLIENT_TOP);
  const unallocated = data?.pools.unallocatedUsd ?? 0;

  const picker = (
    <Select<string>
      size="small"
      value={month}
      onChange={setMonth}
      options={monthOptions()}
      style={{ width: 132 }}
      aria-label="Allocation month"
    />
  );

  let body: React.ReactNode;
  if (loading && data === null) {
    body = (
      <div className="flex items-center justify-center py-8">
        <Spin size="small" />
      </div>
    );
  } else if (error !== null) {
    body = (
      <Alert
        type="warning"
        showIcon
        title="The allocation could not be read."
        description={error}
      />
    );
  } else if (data === null || (tenants.length === 0 && data.monthTotalUsd === 0)) {
    body = (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span style={{ color: surfaceColors.textTertiary }}>
            No cost cached for {formatMonth(month)} yet. The daily AWS costs run fills it; the
            allocation follows overnight.
          </span>
        }
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          {POOLS.map((pool) => (
            <PoolLine
              key={pool.key}
              label={pool.label}
              hint={pool.hint}
              amountUsd={data.pools[pool.key]}
            />
          ))}
          {unallocated > 0 && (
            <PoolLine
              label="Unallocated"
              hint="Spend no tenant was given: a pool whose driver was zero for every tenant (nobody signed in, no attachments anywhere), or a bill that has been revised since the allocation was last computed."
              amountUsd={unallocated}
            />
          )}
          <span
            aria-hidden
            className="my-1 block"
            style={{ height: 1, backgroundColor: surfaceColors.separator }}
          />
          <PoolLine
            label={`Month total · ${pluralise(tenants.length, "tenant")}`}
            hint="The month's whole cached bill, the sum of the four pools. Nothing is counted for today."
            amountUsd={data.monthTotalUsd}
            emphasis
          />
        </div>

        {tenants.length === 0 ? (
          <Typography.Text type="secondary" className="text-sm">
            {formatMonth(month)} has a bill but no allocation yet — the nightly run writes it, or
            press Run now on the Cost allocation integration.
          </Typography.Text>
        ) : (
          <>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {top.map((tenant) => (
                <li key={tenant.tenantId} className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate" style={{ color: surfaceColors.text }}>
                        {tenantLabel(tenant)}
                      </span>
                      {tenant.deleted && (
                        <Tag color="red" style={{ marginInlineEnd: 0 }}>
                          Deleted
                        </Tag>
                      )}
                    </span>
                    <span
                      className="shrink-0 tabular-nums"
                      style={{ color: surfaceColors.text }}
                    >
                      {formatUsd(tenant.totalUsd)}
                    </span>
                  </span>
                  <ShareBar share={tenant.sharePct} />
                </li>
              ))}
            </ul>
            <Button
              size="small"
              icon={<TeamOutlined />}
              onClick={() => setOpen(true)}
              style={{ alignSelf: "flex-start" }}
            >
              See all {tenants.length > PER_CLIENT_TOP ? tenants.length : ""}
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <CostCard
        title="Cost per client"
        extra={picker}
        footnote={
          <>
            <Tooltip title={ALLOCATION_NOTE}>
              <Tag
                color="gold"
                icon={<PieChartOutlined />}
                style={{ marginInlineEnd: 6, cursor: "help" }}
              >
                Allocated estimate
              </Tag>
            </Tooltip>
            {data?.computedAt == null
              ? "Not computed yet; the allocate_costs run writes it nightly at 03:30 Toronto time."
              : `Computed ${formatRelativeTimeOrNever(data.computedAt)} by the nightly allocate_costs run. AWS cannot bill per tenant — this is the month's spend divided by measured usage.`}
          </>
        }
      >
        {body}
      </CostCard>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        placement="right"
        // Wider than the entry drawers: the table has ten columns, and the
        // point of the drawer is that they all fit.
        size={Math.min(1100, ENTRY_DRAWER_WIDTH * 2)}
        destroyOnHidden
        title={
          <span className="flex items-center gap-2">
            <TeamOutlined style={{ fontSize: 18, color: COST_COLOR }} />
            <span>Cost per client · {formatMonth(month)}</span>
            <Tooltip title={ALLOCATION_NOTE}>
              <Tag color="gold" style={{ marginInlineEnd: 0, cursor: "help" }}>
                Allocated estimate
              </Tag>
            </Tooltip>
          </span>
        }
        // A column, so the table region below can be given a definite height.
        styles={{
          body: {
            background: surfaceColors.page,
            display: "flex",
            flexDirection: "column",
          },
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 [&>*]:shrink-0">
          <Typography.Text type="secondary" className="text-xs">
            {formatUsd(data?.monthTotalUsd ?? 0)} of cached AWS spend for {formatMonth(month)},
            divided over {pluralise(tenants.length, "tenant")}
            {unallocated > 0 ? `, with ${formatUsd(unallocated)} left unallocated` : ""}. The
            four money columns sum to the total; the last three are the drivers the split was made
            from.
          </Typography.Text>
          <PerClientTableRegion tenants={tenants} />
        </div>
      </Drawer>
    </>
  );
}

export { CostPerClientSection };
