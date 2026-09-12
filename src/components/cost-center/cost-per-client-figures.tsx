"use client";

/**
 * What one customer costs, for the customer detail drawer: the last two
 * months of the allocation, summed over the tenants that customer belongs to.
 *
 * It lives beside the Cost center's own components rather than under
 * `customers/` because it is the same feature seen from another page — the
 * same endpoint, the same four pools, the same caveat — and two copies of the
 * caveat would eventually disagree.
 *
 * **Summed over their tenants, and that is a choice worth knowing about.** The
 * allocation is per *tenant*; a customer is a person, and a household can have
 * several tenants while a tenant can have several members. So this is "the
 * cost of the households this person belongs to", which for a shared household
 * is the same figure two people would each see. It is the honest reading of
 * per-tenant data on a per-person page, and the note under the figures says so.
 *
 * Best-effort by design: an operator may hold the Customers actions without
 * holding a cost action, in which case the endpoint answers 403 and this
 * section says it cannot show the figures. Nothing else in the drawer depends
 * on them.
 */

import { Spin, Tag, Tooltip, Typography } from "antd";
import { DollarOutlined, PieChartOutlined } from "@ant-design/icons";
import FormSection from "@/components/form-section";
import { formatMonth } from "@/lib/costs/calendar";
import { formatUsd } from "@/lib/costs/types";
import { pluralise } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import {
  ALLOCATION_NOTE,
  PER_CLIENT_DRAWER_MONTHS,
  useTenantCosts,
} from "./cost-per-client-data";

const COST_COLOR = featureColors.costCenter;

/** The four components, in the order every cost surface lists them. */
const COMPONENTS = [
  { key: "fixedUsd" as const, label: "Shared capacity" },
  { key: "storageUsd" as const, label: "Storage" },
  { key: "requestUsd" as const, label: "Data transfer" },
  { key: "userUsd" as const, label: "Cognito" },
];

export default function CustomerCostSection({
  tenantIds,
}: {
  /** Every tenant the customer belongs to. Empty means no figure to show. */
  tenantIds: readonly string[];
}) {
  const { months, loading, available, reason } = useTenantCosts(PER_CLIENT_DRAWER_MONTHS);

  const rows = months.map((month) => {
    const parts = tenantIds.map((id) => month.rows.get(id));
    const sum = (pick: (part: NonNullable<(typeof parts)[number]>) => number) =>
      parts.reduce((total, part) => total + (part === undefined ? 0 : pick(part)), 0);
    return {
      month: month.month,
      totalUsd: sum((part) => part.totalUsd),
      fixedUsd: sum((part) => part.fixedUsd),
      storageUsd: sum((part) => part.storageUsd),
      requestUsd: sum((part) => part.requestUsd),
      userUsd: sum((part) => part.userUsd),
      monthTotalUsd: month.monthTotalUsd,
      computedAt: month.computedAt,
    };
  });

  let body: React.ReactNode;
  if (loading && months.length === 0) {
    body = (
      <Typography.Text type="secondary" className="text-sm">
        Reading…
      </Typography.Text>
    );
  } else if (!available) {
    body = (
      <Typography.Text type="secondary" className="text-sm">
        {reason ??
          "The cost allocation is not available on this deployment yet (docs/sql/015_cost_allocation.sql)."}
      </Typography.Text>
    );
  } else if (tenantIds.length === 0) {
    body = (
      <Typography.Text type="secondary" className="text-sm">
        No tenant yet, so nothing has been allocated to this customer.
      </Typography.Text>
    );
  } else {
    body = (
      <>
        <div className="flex flex-wrap gap-6">
          {rows.map((row) => (
            <span key={row.month} className="flex min-w-40 flex-col gap-1">
              <span
                className="text-[11px] font-medium tracking-wide uppercase"
                style={{ color: surfaceColors.textSecondary }}
              >
                {formatMonth(row.month)}
              </span>
              <Tooltip
                title={
                  row.computedAt === null
                    ? "This month has not been allocated yet; the nightly run writes it."
                    : `${formatUsd(row.totalUsd)} of the month's ${formatUsd(row.monthTotalUsd)} cached AWS spend.`
                }
              >
                <span
                  tabIndex={0}
                  className="text-lg leading-tight font-semibold tabular-nums"
                  style={{ color: surfaceColors.text }}
                >
                  {row.computedAt === null ? "—" : formatUsd(row.totalUsd)}
                </span>
              </Tooltip>
              <span className="mt-1 flex flex-col gap-0.5">
                {COMPONENTS.map((component) => (
                  <span
                    key={component.key}
                    className="flex items-baseline justify-between gap-3 text-xs"
                    style={{ color: surfaceColors.textTertiary }}
                  >
                    <span>{component.label}</span>
                    <span className="tabular-nums">{formatUsd(row[component.key])}</span>
                  </span>
                ))}
              </span>
            </span>
          ))}
        </div>
        <Typography.Text type="secondary" className="text-xs">
          Summed over {pluralise(tenantIds.length, "tenant")} this customer belongs to. A tenant
          shared with someone else shows the same figure on both their pages — the allocation is
          per tenant, not per person.
        </Typography.Text>
      </>
    );
  }

  return (
    <FormSection
      title="Cost (estimated)"
      icon={<DollarOutlined />}
      color={COST_COLOR}
      extra={
        loading && months.length > 0 ? (
          <Spin size="small" />
        ) : (
          <Tooltip title={ALLOCATION_NOTE}>
            <Tag color="gold" icon={<PieChartOutlined />} style={{ marginInlineEnd: 0, cursor: "help" }}>
              Allocated estimate
            </Tag>
          </Tooltip>
        )
      }
    >
      {body}
    </FormSection>
  );
}

export { CustomerCostSection };
