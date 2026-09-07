"use client";

/**
 * One customer, in full: who they are, which tenants they belong to, how far
 * they have got in the app, and what the customer Cognito pool says about
 * their account.
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
  IdcardOutlined,
  LineChartOutlined,
} from "@ant-design/icons";
import FormSection from "@/components/form-section";
import { ENTRY_DRAWER_WIDTH } from "@/components/shell/definitions";
import { customersApi } from "@/lib/customers/client";
import type { Customer } from "@/lib/customers/types";
import {
  errorMessage,
  formatDateTimeOrDash,
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
