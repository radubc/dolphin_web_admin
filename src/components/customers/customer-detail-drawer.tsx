"use client";

/**
 * One customer, in full: who they are, which tenants they belong to, how far
 * they have got in the app, what their own usage looks like day by day, every
 * lifecycle event recorded against their Cognito sub, and what the customer
 * pool says about their account.
 *
 * Read-only on purpose. The consumer app owns these rows — the admin console
 * reads them and never writes them — so this is a window, not a form.
 *
 * The row the table already has is drawn immediately so the drawer opens with
 * something in it, and a fresh read of `GET /customers/[id]` replaces it a
 * moment later: the list page may be minutes old by the time someone clicks a
 * row, and the tenant list and the pool lookup are the parts most likely to
 * have moved. A failed re-read is not an error the operator has to act on —
 * the stale row stays, with a quiet note above it.
 */

import { useEffect, useState } from "react";
import { Alert, Drawer, Spin, Tag, Tooltip, Typography } from "antd";
import {
  CloudOutlined,
  ContactsOutlined,
  DatabaseOutlined,
  HistoryOutlined,
  IdcardOutlined,
  LineChartOutlined,
} from "@ant-design/icons";
import DayBarChart from "@/components/day-bar-chart";
import CustomerCostSection from "@/components/cost-center/cost-per-client-figures";
import FormSection from "@/components/form-section";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import { customersApi } from "@/lib/customers/client";
import type { Customer, CustomerActivity, CustomerEvent } from "@/lib/customers/types";
import {
  errorMessage,
  formatBytes,
  formatDateTimeOrDash,
  formatIsoDay,
  formatRelativeTimeOrNever,
  pluralise,
} from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import { COGNITO_STATUS_LABELS, CUSTOMERS_COLOR, CustomerStatusTag, Dash } from "./customers-meta";

/** One labelled line of the drawer. The label column is fixed so lines align. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span
        className="shrink-0 text-xs"
        style={{ width: 116, color: surfaceColors.textSecondary }}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 text-sm" style={{ color: surfaceColors.text }}>
        {children}
      </span>
    </div>
  );
}

/** An identifier: monospaced, selectable, and allowed to wrap rather than clip. */
function Identifier({ value }: { value: string | null }) {
  if (value === null || value === "") return <Dash />;
  return (
    <code className="text-xs break-all" style={{ color: surfaceColors.text }}>
      {value}
    </code>
  );
}

/** A figure with its name under it, for the three activity numbers. */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span
        className="text-[11px] font-medium tracking-wide uppercase"
        style={{ color: surfaceColors.textSecondary }}
      >
        {label}
      </span>
      <span
        className="text-lg leading-tight font-semibold tabular-nums"
        style={{ color: surfaceColors.text }}
      >
        {value}
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Activity                                                                   */
/* -------------------------------------------------------------------------- */

/** How each lifecycle event reads, and in what colour. */
const EVENT_META: Readonly<Record<CustomerEvent["event"], { label: string; color: string }>> = {
  invited: { label: "Invited", color: "#D4A017" },
  confirmed: { label: "Confirmed", color: featureColors.loan },
  disabled: { label: "Disabled", color: featureColors.rule },
  enabled: { label: "Re-enabled", color: featureColors.asset },
  deleted: { label: "Removed from the pool", color: featureColors.rule },
  reappeared: { label: "Appeared in the pool", color: featureColors.neutral },
  deleted_in_app: { label: "Deleted their account", color: featureColors.rule },
};

/** Where the console learned it. */
const SOURCE_LABELS: Readonly<Record<CustomerEvent["source"], string>> = {
  console: "recorded by this console as it happened",
  directory_diff: "inferred from the nightly directory comparison",
  main_db: "read from the consumer app's own record",
};

/**
 * This customer's own usage, the size of their tenants, and their lifecycle
 * log — `GET /customers/[id]/activity`.
 *
 * Fetched separately from the identity read above rather than folded into it,
 * for two reasons: the drawer should open with something in it while the
 * heavier read runs, and the identity read is on the list's critical path
 * (every row click) while these aggregates are not. A failure here leaves the
 * rest of the drawer intact and says so in one line — none of it is
 * information an operator has to act on.
 */
function ActivitySection({ customerId }: { customerId: string }) {
  const [activity, setActivity] = useState<CustomerActivity | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const detail = await customersApi.activity(customerId);
        if (!cancelled) setActivity(detail);
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const shown = activity !== null && activity.userId === customerId ? activity : null;

  return (
    <>
      <FormSection
        title="Usage"
        icon={<DatabaseOutlined />}
        color={CUSTOMERS_COLOR}
        extra={loading ? <Spin size="small" /> : undefined}
      >
        {error !== null && (
          <Alert
            type="warning"
            showIcon
            title="This customer's usage could not be read."
            description={error}
          />
        )}
        {shown === null ? (
          <Typography.Text type="secondary" className="text-sm">
            {loading ? "Reading…" : "Nothing to show."}
          </Typography.Text>
        ) : (
          <>
            <Field label="Last seen">
              {shown.lastSeenAt === null ? (
                <span style={{ color: surfaceColors.textTertiary }}>No sign-in recorded</span>
              ) : (
                <Tooltip title={formatDateTimeOrDash(shown.lastSeenAt)}>
                  <span tabIndex={0}>{formatRelativeTimeOrNever(shown.lastSeenAt)}</span>
                </Tooltip>
              )}
            </Field>
            <DayBarChart
              bars={shown.usage.map((day) => ({ day: day.day, value: day.requests }))}
              color={featureColors.banking}
              height={96}
              formatValue={(value) => value.toLocaleString()}
              note={`requests per day, last ${shown.days} days`}
              missingLabel="no requests"
              emptyLabel="No requests recorded in the last 35 days."
              summary={(count, peak) =>
                `This customer's requests per day over ${count} days. Peak ${peak} in a day.`
              }
            />
            <Typography.Text type="secondary" className="text-xs">
              {shown.usage.reduce((sum, day) => sum + day.requests, 0).toLocaleString()} requests ·{" "}
              {shown.usage.reduce((sum, day) => sum + day.errors, 0).toLocaleString()} errors ·{" "}
              {shown.usage.reduce((sum, day) => sum + day.syncRows, 0).toLocaleString()} sync rows ·{" "}
              {formatBytes(shown.usage.reduce((sum, day) => sum + day.bytesUploaded, 0))} uploaded,
              from the consumer app’s usage_daily counters.
            </Typography.Text>
          </>
        )}
      </FormSection>

      {shown !== null && shown.tenants.length > 0 && (
        <FormSection title="Tenant size" icon={<DatabaseOutlined />} color={CUSTOMERS_COLOR}>
          {shown.tenants.map((tenant) => (
            <div key={tenant.tenantId} className="flex flex-col gap-0.5">
              <span className="truncate text-sm" style={{ color: surfaceColors.text }}>
                {tenant.name ?? "(deleted tenant)"}
              </span>
              <span className="text-xs tabular-nums" style={{ color: surfaceColors.textSecondary }}>
                {tenant.transactions.toLocaleString()} transactions ·{" "}
                {tenant.accounts.toLocaleString()} accounts ·{" "}
                {tenant.documents.toLocaleString()} documents · {formatBytes(tenant.bytes)}{" "}
                attachments
              </span>
            </div>
          ))}
        </FormSection>
      )}

      {shown !== null && (
        <FormSection title="Lifecycle" icon={<HistoryOutlined />} color={CUSTOMERS_COLOR}>
          {shown.events.length === 0 ? (
            <Typography.Text type="secondary" className="text-sm">
              No lifecycle events recorded for this Cognito sub. The log starts at the first
              directory snapshot, so an account that has not changed since then has nothing in it.
            </Typography.Text>
          ) : (
            shown.events.map((event) => {
              const meta = EVENT_META[event.event];
              return (
                <div key={event.id} className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Tag color={undefined} style={{ marginInlineEnd: 0, color: meta.color }}>
                      {meta.label}
                    </Tag>
                    <span className="truncate text-xs" style={{ color: surfaceColors.textTertiary }}>
                      {SOURCE_LABELS[event.source]}
                    </span>
                  </span>
                  <Tooltip title={formatDateTimeOrDash(event.at)}>
                    <span
                      tabIndex={0}
                      className="shrink-0 text-xs"
                      style={{ color: surfaceColors.textSecondary }}
                    >
                      {formatIsoDay(event.at.slice(0, 10))}
                    </span>
                  </Tooltip>
                </div>
              );
            })
          )}
        </FormSection>
      )}
    </>
  );
}

export interface CustomerDetailDrawerProps {
  /** The row that was clicked, or null when the drawer is closed. */
  customer: Customer | null;
  /** Whether the pool was consulted for this list at all. */
  cognitoAvailable: boolean;
  onClose: () => void;
}

export default function CustomerDetailDrawer({
  customer,
  cognitoAvailable,
  onClose,
}: CustomerDetailDrawerProps) {
  const [fresh, setFresh] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(false);
  const [staleReason, setStaleReason] = useState<string | null>(null);

  const id = customer?.id ?? null;

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setStaleReason(null);
      try {
        const detail = await customersApi.get(id);
        if (!cancelled) setFresh(detail);
      } catch (cause) {
        // Nothing is lost: the row from the table is still on screen.
        if (!cancelled) setStaleReason(errorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The fresh copy is only worth showing while it is a copy of *this* row;
  // matching on the id is how the last customer's detail is dropped when a
  // different one is opened, without a reset that would blank the drawer.
  const shown = fresh !== null && fresh.id === id ? fresh : customer;

  return (
    <Drawer
      open={customer !== null}
      onClose={onClose}
      placement="right"
      size={ENTRY_DRAWER_WIDTH}
      destroyOnHidden
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ContactsOutlined style={{ fontSize: 18, color: CUSTOMERS_COLOR }} />
          <span className="truncate">{shown?.email ?? "Customer"}</span>
          {loading && <Spin size="small" />}
        </span>
      }
      styles={{ body: { background: surfaceColors.page } }}
    >
      {shown === null ? null : (
        <div className="flex flex-col gap-4">
          {staleReason !== null && (
            <Alert
              type="warning"
              showIcon
              title="Showing the row from the list; it could not be re-read."
              description={staleReason}
            />
          )}

          <FormSection title="Identity" icon={<IdcardOutlined />} color={CUSTOMERS_COLOR}>
            <Field label="Email">
              <span className="font-semibold">{shown.email}</span>
            </Field>
            <Field label="Status">
              <CustomerStatusTag status={shown.status} />
            </Field>
            <Field label="Cognito sub">
              <Identifier value={shown.cognitoSub} />
            </Field>
            <Field label="User id">
              <Identifier value={shown.id} />
            </Field>
            <Field label="Joined">{formatDateTimeOrDash(shown.createdAt)}</Field>
            {shown.deletedAt !== null && (
              <Field label="Deleted">
                <span style={{ color: featureColors.rule }}>
                  {formatDateTimeOrDash(shown.deletedAt)}
                </span>
              </Field>
            )}
          </FormSection>

          <FormSection
            title={`Tenants (${shown.tenants.length})`}
            icon={<ContactsOutlined />}
            color={CUSTOMERS_COLOR}
          >
            {shown.tenants.length === 0 ? (
              <Typography.Text type="secondary" className="text-sm">
                No tenant yet. The consumer app creates one the first time the person signs in.
              </Typography.Text>
            ) : (
              shown.tenants.map((tenant) => (
                <div key={tenant.id} className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm" style={{ color: surfaceColors.text }}>
                      {tenant.name}
                    </span>
                    {tenant.isPrimary && (
                      <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                        Primary
                      </Tag>
                    )}
                  </span>
                  <span className="shrink-0 text-xs" style={{ color: surfaceColors.textTertiary }}>
                    {formatDateTimeOrDash(tenant.createdAt)}
                  </span>
                </div>
              ))
            )}
          </FormSection>

          <FormSection title="Activity" icon={<LineChartOutlined />} color={CUSTOMERS_COLOR}>
            <div className="flex flex-wrap items-start gap-8">
              <Figure label="Accounts" value={shown.accountCount.toLocaleString()} />
              <Figure label="Transactions" value={shown.transactionCount.toLocaleString()} />
              <Tooltip title={formatDateTimeOrDash(shown.lastActiveAt)}>
                <span tabIndex={0}>
                  <Figure
                    label="Last active"
                    value={formatRelativeTimeOrNever(shown.lastActiveAt)}
                  />
                </span>
              </Tooltip>
            </div>
            <Typography.Text type="secondary" className="text-xs">
              Counts cover the live rows in {pluralise(shown.tenants.length, "tenant")}. &ldquo;Last
              active&rdquo; is the newest change across transactions, accounts, budgets and goals.
            </Typography.Text>
          </FormSection>

          <ActivitySection customerId={shown.id} />

          {/* What the households this person belongs to cost, as an allocated
              estimate — the same figures the Cost center's "Cost per client"
              card shows, summed over their tenants. Read-only and
              best-effort: an operator without a cost action sees why instead. */}
          <CustomerCostSection tenantIds={shown.tenants.map((tenant) => tenant.id)} />

          <FormSection title="Cognito account" icon={<CloudOutlined />} color={CUSTOMERS_COLOR}>
            {shown.cognito === null ? (
              <Typography.Text type="secondary" className="text-sm">
                {cognitoAvailable
                  ? "No account in the customer pool matches this sub. It may have been deleted, or created in a different pool."
                  : "The customer pool was not consulted, so nothing is known about this account."}
              </Typography.Text>
            ) : (
              <>
                <Field label="Status">{COGNITO_STATUS_LABELS[shown.cognito.status]}</Field>
                <Field label="Enabled">
                  {shown.cognito.enabled ? (
                    <Tag color="green" style={{ marginInlineEnd: 0 }}>
                      Enabled
                    </Tag>
                  ) : (
                    <Tag color="red" style={{ marginInlineEnd: 0 }}>
                      Disabled
                    </Tag>
                  )}
                </Field>
                <Field label="Created">{formatDateTimeOrDash(shown.cognito.createdAt)}</Field>
                <Field label="Last modified">{formatDateTimeOrDash(shown.cognito.updatedAt)}</Field>
              </>
            )}
          </FormSection>
        </div>
      )}
    </Drawer>
  );
}
