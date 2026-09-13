"use client";

/**
 * The customer list: everyone with an account in the consumer app, what state
 * that account is in, and how far they have got with it.
 *
 * Two sources, one row. The identity, the tenants and the activity numbers come
 * from the main app database, which the consumer app owns and this console only
 * reads; the status comes from the customer Cognito pool, which is the only
 * place that knows whether an invitation has been accepted or an account
 * switched off. When the pool cannot be reached the list still works — every
 * status reads "Unknown" and a banner says why — because a table of real
 * customers with one missing column beats an error page.
 *
 * The figures in the header are whole-list numbers from the server. The rail
 * card is not: it breaks down the page on screen, and says so, because the
 * server sends one page rather than a per-status census.
 *
 * Two columns say how recently someone was here, and they are not the same
 * thing. "Last seen" is `users.last_seen_at`, which the consumer app stamps
 * at sign-in — the only fact in either database that means the person
 * themselves was present. Under it is the older derived figure, the newest
 * change anywhere in their tenants, which is all this console could measure
 * before that column existed and is still the answer for a row that has no
 * sign-in recorded.
 *
 * Everything is server-paged, searched and filtered: this is the consumer app's
 * entire user table, and it is only going to get longer.
 */

import { useEffect, useState } from "react";
import { Alert, Button, Input, Segmented, Spin, Switch, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ContactsOutlined,
  LoadingOutlined,
  PieChartOutlined,
  ReloadOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import { NOT_COMPUTED_NOTE, useTenantCosts } from "@/components/cost-center/cost-per-client-data";
import { ListEmpty, ListNoResults } from "@/components/empty-state";
import Figures from "@/components/figures";
import { ListPageFrame, ListPanel, ListTableRegion } from "@/components/list-page-frame";
import { RibbonBar, RibbonButton, RibbonDivider } from "@/components/ribbon-bar";
import { ResponsiveTable } from "@/components/responsive-table";
import StatCard from "@/components/stat-card";
import { formatUsd } from "@/lib/costs/types";
import type { Customer } from "@/lib/customers/types";
import { ACTIVE_WINDOW_DAYS } from "@/lib/customers/types";
import {
  formatDateTimeOrDash,
  formatRelativeTimeOrNever,
  pluralise,
} from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import CustomerDetailDrawer from "./customer-detail-drawer";
import {
  CUSTOMER_STATUS_META,
  CUSTOMER_STATUSES,
  CUSTOMERS_COLOR,
  CustomerStatusTag,
  Dash,
} from "./customers-meta";
import {
  CUSTOMER_PAGE_SIZE_OPTIONS,
  useCustomersStore,
  type CustomerStatusFilter,
} from "./use-customers";

/** The tenant to name in the table, and how many are being left out. */
function primaryTenantOf(customer: Customer): { name: string; others: number } | null {
  if (customer.tenants.length === 0) return null;
  const primary = customer.tenants.find((tenant) => tenant.isPrimary) ?? customer.tenants[0];
  return { name: primary.name, others: customer.tenants.length - 1 };
}

interface CustomersViewProps {
  /** Whether this operator may send invitations. */
  canInvite: boolean;
  /** Opens the invite drawer, which the page owns so both views share it. */
  onInvite: () => void;
  /** The view segmented control, drawn in the ribbon by both views. */
  switcher: React.ReactNode;
  /**
   * Reports this view's `canSend`/`unavailableReason` up to the page, which
   * owns the invite drawer and needs to know before the operator opens it,
   * whichever view is on screen.
   */
  onSendabilityChange: (canSend: boolean, unavailableReason: string | null) => void;
}

export default function CustomersView({ canInvite, onInvite, switcher, onSendabilityChange }: CustomersViewProps) {
  const store = useCustomersStore();
  /** The row whose detail drawer is open. */
  const [selected, setSelected] = useState<Customer | null>(null);
  /**
   * This month's allocated cost per tenant — **one request for the whole
   * page**, not one per row and not a join into the list's query. A row's
   * figure is the sum over the tenants it already carries.
   *
   * Best-effort: an operator may hold the Customers actions without holding a
   * cost action, and the allocation table may not exist yet. Either way the
   * column says "—" with the reason in its tooltip rather than breaking a
   * list that does not depend on it.
   */
  const costs = useTenantCosts();

  const { items, counts, canSend, unavailableReason } = store;

  useEffect(() => {
    onSendabilityChange(canSend, unavailableReason);
  }, [canSend, unavailableReason, onSendabilityChange]);

  /* --------------------------------- table --------------------------------- */

  const columns: ColumnsType<Customer> = [
    {
      title: "Email",
      dataIndex: "email",
      width: 260,
      render: (value: string, row) => (
        <span className="flex flex-col">
          <span className="font-semibold" style={{ color: surfaceColors.text }}>
            {value}
          </span>
          {row.deletedAt !== null && (
            <span className="text-xs" style={{ color: featureColors.rule }}>
              Deleted {formatRelativeTimeOrNever(row.deletedAt)}
            </span>
          )}
        </span>
      ),
    },
    {
      title: "Status",
      dataIndex: "status",
      width: 120,
      render: (_value, row) => <CustomerStatusTag status={row.status} />,
    },
    {
      title: "Tenant",
      key: "tenant",
      width: 220,
      render: (_value, row) => {
        const tenant = primaryTenantOf(row);
        if (tenant === null) return <Dash />;
        return (
          <span className="flex flex-col">
            <span className="truncate" style={{ color: surfaceColors.text }}>
              {tenant.name}
            </span>
            {tenant.others > 0 && (
              <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
                and {tenant.others} more
              </span>
            )}
          </span>
        );
      },
    },
    {
      title: "Joined",
      dataIndex: "createdAt",
      width: 150,
      render: (value: string | null) => (
        <Tooltip title={formatDateTimeOrDash(value)}>
          <span tabIndex={0}>{formatRelativeTimeOrNever(value)}</span>
        </Tooltip>
      ),
    },
    {
      // The column that really means "this person used the app": the consumer
      // app stamps `users.last_seen_at` at sign-in and refreshes it hourly.
      // It is null for a row written before that column existed and for
      // anyone who has not signed in since, so the derived "last active" is
      // shown underneath as the fallback — labelled, so the two are never
      // mistaken for each other.
      title: "Last seen",
      dataIndex: "lastSeenAt",
      width: 170,
      render: (value: string | null, row) => (
        <span className="flex flex-col">
          <Tooltip
            title={
              value === null
                ? "No sign-in recorded. The consumer app stamps users.last_seen_at at sign-in; a row written before that column existed has none."
                : formatDateTimeOrDash(value)
            }
          >
            <span tabIndex={0} style={{ color: value === null ? surfaceColors.textTertiary : undefined }}>
              {value === null ? "No sign-in recorded" : formatRelativeTimeOrNever(value)}
            </span>
          </Tooltip>
          <Tooltip
            title={`Newest change across the tenant\u2019s transactions, accounts, budgets and goals: ${formatDateTimeOrDash(row.lastActiveAt)}`}
          >
            <span
              tabIndex={0}
              className="text-xs"
              style={{ color: surfaceColors.textTertiary }}
            >
              changed {formatRelativeTimeOrNever(row.lastActiveAt).toLowerCase()}
            </span>
          </Tooltip>
        </span>
      ),
    },
    {
      title: "Accounts",
      dataIndex: "accountCount",
      width: 100,
      align: "right",
      render: (value: number) => <span className="tabular-nums">{value.toLocaleString()}</span>,
    },
    {
      title: "Transactions",
      dataIndex: "transactionCount",
      width: 120,
      align: "right",
      render: (value: number) => <span className="tabular-nums">{value.toLocaleString()}</span>,
    },
    {
      // An **allocated estimate**, never a bill: AWS charges per resource and
      // every resource except an S3 object is shared by all tenants, so this
      // is this month's spend divided over the tenants by measured usage. The
      // Cost center's "Cost per client" card is the same figures in full.
      title: "Cost (est.)",
      key: "costEstimate",
      width: 120,
      align: "right",
      render: (_value, row) => {
        const total = costs.totalFor(row.tenants.map((tenant) => tenant.id));
        if (total === null) {
          return (
            <Tooltip
              title={
                costs.loading
                  ? "Reading this month's cost allocation…"
                  : (costs.reason ??
                    (costs.notComputed
                      ? NOT_COMPUTED_NOTE
                      : "The cost allocation is not available on this deployment yet."))
              }
            >
              <span tabIndex={0} style={{ color: surfaceColors.textTertiary }}>
                —
              </span>
            </Tooltip>
          );
        }
        return (
          <Tooltip
            title={`An allocated estimate of what this customer's ${pluralise(row.tenants.length, "tenant")} cost this month: the month's AWS spend split into shared capacity, storage, data transfer and Cognito, and divided by measured usage. Open the row for the breakdown.`}
          >
            <span tabIndex={0} className="tabular-nums" style={{ color: surfaceColors.text }}>
              {formatUsd(total)}
            </span>
          </Tooltip>
        );
      },
    },
  ];

  /* --------------------------------- header -------------------------------- */

  const figures = (
    <Figures
      label="Customer totals"
      figures={[
        {
          label: "Customers",
          value: counts.total.toLocaleString(),
          tooltip: "Live customer rows in the app database, whatever the filters show.",
        },
        {
          label: `Active ${ACTIVE_WINDOW_DAYS}d`,
          value: counts.activeRecently.toLocaleString(),
          color: counts.activeRecently > 0 ? featureColors.loan : undefined,
          tooltip: `Customers who changed something in the last ${ACTIVE_WINDOW_DAYS} days.`,
          separatorBefore: true,
        },
        {
          label: "Invited",
          value: counts.invited.toLocaleString(),
          tooltip:
            "Pool accounts still waiting for a first sign-in. They are not in this list yet; see Invitations.",
        },
        {
          label: "Disabled",
          value: counts.disabled.toLocaleString(),
          color: counts.disabled > 0 ? featureColors.rule : undefined,
          tooltip: "Pool accounts that are switched off and cannot sign in.",
        },
        {
          label: "Deleted",
          value: counts.deleted.toLocaleString(),
          color: counts.deleted > 0 ? featureColors.rule : undefined,
          tooltip:
            "Customers who deleted their account in the consumer app (users.deleted_at). Hidden from the list unless \u201cInclude deleted\u201d is on, so this is the only place they are counted.",
        },
      ]}
    />
  );

  const byStatus = CUSTOMER_STATUSES.map((status) => ({
    label: CUSTOMER_STATUS_META[status].label,
    value: items.filter((item) => item.status === status).length,
    color: CUSTOMER_STATUS_META[status].color,
    tooltip: CUSTOMER_STATUS_META[status].tooltip,
  })).filter((row) => row.value > 0);

  const rail = (
    <div className="flex flex-col gap-4">
      <StatCard
        title="This page by status"
        icon={<PieChartOutlined style={{ color: CUSTOMERS_COLOR }} />}
        total={Math.max(1, items.length)}
        rows={byStatus}
        footnote={`Counts cover the ${pluralise(items.length, "customer")} on this page, out of ${store.total.toLocaleString()} matching. The header figures cover the whole list.`}
      />
    </div>
  );

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
          {store.filtersActive
            ? `${store.total.toLocaleString()} matching`
            : pluralise(store.total, "customer")}
        </span>
      }
    >
      {canInvite && (
        <>
          <RibbonButton
            label="Invite Customer"
            icon={<UserAddOutlined />}
            onClick={onInvite}
            disabled={!canSend}
            tooltip={
              canSend
                ? "Create a consumer-app account and email the invitation"
                : (unavailableReason ?? "Invitations cannot be sent from this deployment.")
            }
          />
          <RibbonDivider />
        </>
      )}

      <RibbonButton
        label="Refresh"
        icon={store.refreshing ? <LoadingOutlined /> : <ReloadOutlined />}
        onClick={store.reload}
        disabled={store.refreshing}
        tooltip="Reload this page of the list"
      />

      <RibbonDivider />
      {switcher}
    </RibbonBar>
  );

  /* ---------------------------------- body --------------------------------- */

  const toolbar = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {/* The width lives on this plain wrapper, which the search box fills: antd's own
          full-width rule on the box is unlayered and would beat a Tailwind width
          set on the box itself. Row-wide on compact, the old fixed width on desktop. */}
      <div className="w-full lg:w-[300px]">
        <Input.Search
          allowClear
          value={store.search}
          loading={store.refreshing}
          placeholder="Search email or tenant…"
          aria-label="Search customers"
          // The query follows the box after a 300 ms pause; Enter only asks for
          // the same query sooner, so both handlers set the same state.
          onChange={(event) => store.setSearch(event.target.value)}
          onSearch={store.setSearch}
        />
      </div>

      <span role="group" aria-label="Filter by status" className="max-lg:max-w-full max-lg:overflow-x-auto">
        <Segmented<CustomerStatusFilter>
          value={store.statusFilter}
          onChange={store.setStatusFilter}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "disabled", label: "Disabled" },
            // A column rather than a pool answer, and it implies "include
            // deleted": the server resolves the filter that way, so the
            // toggle below is left as the operator set it.
            { value: "deleted", label: "Deleted" },
          ]}
        />
      </span>

      <label className="flex items-center gap-2 text-sm" style={{ color: surfaceColors.textSecondary }}>
        <Switch
          size="small"
          checked={store.includeDeleted}
          onChange={store.setIncludeDeleted}
          aria-label="Include deleted customers"
        />
        Include deleted
      </label>
    </div>
  );

  let body: React.ReactNode;
  if (store.loading) {
    body = (
      <ListPanel>
        <div className="flex items-center justify-center py-16">
          <Spin />
        </div>
      </ListPanel>
    );
  } else if (!store.loaded) {
    body = (
      <Alert
        type="error"
        showIcon
        title="The customer list could not be loaded."
        description={store.error ?? undefined}
        action={
          <Button size="small" onClick={store.reload}>
            Retry
          </Button>
        }
      />
    );
  } else if (store.total === 0 && !store.filtersActive) {
    // Nothing in the list at all — not "nothing matches", which the filters
    // below answer for.
    body = canInvite ? (
      <ListEmpty
        icon={<ContactsOutlined />}
        color={CUSTOMERS_COLOR}
        title="No customers yet"
        description="There is no self-service sign-up: invite someone and Cognito emails them a temporary password."
        actionLabel="Invite customer"
        onAction={onInvite}
      />
    ) : (
      <ListPanel>
        <div className="py-14 text-center">
          <Typography.Text type="secondary">No customers yet.</Typography.Text>
        </div>
      </ListPanel>
    );
  } else {
    body = (
      <>
        {store.error !== null && <Alert type="warning" showIcon closable title={store.error} />}
        {toolbar}
        {store.total === 0 ? (
          <ListNoResults what="customers" onClearFilters={store.clearFilters} />
        ) : (
          <>
            {store.cognitoTruncated && (
              <Alert
                type="warning"
                showIcon
                title="The customer pool has more accounts than the page can read at once; statuses and the Invited / Disabled figures cover only part of it."
              />
            )}
            <ListTableRegion>
              {(y) => (
                <ListPanel>
                  <ResponsiveTable<Customer>
                    dataSource={items}
                    rowKey="id"
                    columns={columns}
                    size="middle"
                    loading={store.refreshing}
                    scroll={{ x: 1390, y }}
                    onRow={(row) => ({
                      onClick: () => setSelected(row),
                      style: { cursor: "pointer" },
                    })}
                    pagination={{
                      current: store.page,
                      pageSize: store.pageSize,
                      total: store.total,
                      showSizeChanger: true,
                      pageSizeOptions: [...CUSTOMER_PAGE_SIZE_OPTIONS],
                      showTotal: (total, range) =>
                        `${range[0].toLocaleString()}–${range[1].toLocaleString()} of ${total.toLocaleString()}`,
                      onChange: store.setPaging,
                      onShowSizeChange: store.setPaging,
                    }}
                  />
                </ListPanel>
              )}
            </ListTableRegion>
          </>
        )}
      </>
    );
  }

  return (
    <>
      <ListPageFrame
        title="Customers"
        caption="People with an account in the consumer app, and what the customer pool says about each."
        figures={store.loaded ? figures : undefined}
        ribbon={ribbon}
        rail={store.loaded ? rail : undefined}
      >
        {!store.cognitoAvailable && (
          <Alert
            type="warning"
            showIcon
            title="The customer Cognito pool is not configured or could not be reached; statuses are unknown."
          />
        )}
        {body}
      </ListPageFrame>

      <CustomerDetailDrawer
        customer={selected}
        cognitoAvailable={store.cognitoAvailable}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
