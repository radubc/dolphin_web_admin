"use client";

/**
 * The invitation log: every consumer-app account an operator has created, who
 * created it, when the email last went out, and whether the person has shown
 * up since.
 *
 * This list is the admin database's own record (`admin_customer_invites`),
 * which is why it survives things the Cognito pool does not: a revoked
 * invitation keeps its row after the pool account is deleted, and a refused
 * one keeps Cognito's reason. It is the audit trail for the one write this
 * console makes against the customer pool.
 *
 * Two actions, both only for an invitation still waiting: **Resend** sends a
 * fresh temporary password to the same address, and **Revoke** deletes the
 * unaccepted account so the address is free to be invited again. Neither is
 * offered once someone has accepted — at that point the account is theirs, not
 * ours to withdraw.
 *
 * When the deployment cannot reach the pool at all, `canSend` comes back false
 * with a reason; the list still reads, and the controls that would call
 * Cognito are switched off rather than failing on click.
 */

import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Button,
  Input,
  Popconfirm,
  Segmented,
  Space,
  Spin,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  DeleteOutlined,
  LoadingOutlined,
  MailOutlined,
  PieChartOutlined,
  ReloadOutlined,
  SendOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import { ListEmpty, ListNoResults } from "@/components/empty-state";
import Figures from "@/components/figures";
import { ListPageFrame, ListPanel, ListTableRegion } from "@/components/list-page-frame";
import { RibbonBar, RibbonButton, RibbonDivider } from "@/components/ribbon-bar";
import { ResponsiveTable } from "@/components/responsive-table";
import StatCard from "@/components/stat-card";
import { customersApi } from "@/lib/customers/client";
import type { CustomerInvite } from "@/lib/customers/types";
import {
  errorMessage,
  formatDateTimeOrDash,
  formatRelativeTimeOrNever,
  pluralise,
} from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import {
  CUSTOMERS_COLOR,
  Dash,
  ErrorCell,
  INVITE_STATUS_META,
  INVITE_STATUSES,
  InviteStatusTag,
  TextCell,
} from "./customers-meta";
import {
  CUSTOMER_PAGE_SIZE_OPTIONS,
  useInvitesStore,
  type InviteStatusFilter,
} from "./use-customers";

interface InvitesViewProps {
  /** Whether this operator holds `can_invite_users`. */
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

export default function InvitesView({ canInvite, onInvite, switcher, onSendabilityChange }: InvitesViewProps) {
  const { message } = App.useApp();
  const store = useInvitesStore();
  /** The row whose write is in flight, so only its buttons wait. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const { items, counts, canSend, unavailableReason } = store;
  /** Both actions call Cognito, so both need the permission *and* a live pool. */
  const canAct = canInvite && canSend;

  useEffect(() => {
    onSendabilityChange(canSend, unavailableReason);
  }, [canSend, unavailableReason, onSendabilityChange]);

  const resend = async (row: CustomerInvite) => {
    setBusyId(row.id);
    try {
      const invite = await customersApi.invites.resend(row.id);
      message.success(`Invitation sent to ${invite.email} again.`);
    } catch (cause) {
      message.error(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (row: CustomerInvite) => {
    setBusyId(row.id);
    try {
      const invite = await customersApi.invites.revoke(row.id);
      message.success(`Invitation to ${invite.email} revoked.`);
    } catch (cause) {
      message.error(errorMessage(cause));
    } finally {
      setBusyId(null);
    }
  };

  /* --------------------------------- table --------------------------------- */

  const columns: ColumnsType<CustomerInvite> = [
    {
      title: "Email",
      dataIndex: "email",
      width: 250,
      render: (value: string) => (
        <span className="font-semibold" style={{ color: surfaceColors.text }}>
          {value}
        </span>
      ),
    },
    {
      title: "Status",
      dataIndex: "status",
      width: 120,
      render: (_value, row) => <InviteStatusTag status={row.status} />,
    },
    {
      title: "Note",
      dataIndex: "note",
      width: 220,
      render: (value: string | null) => <TextCell value={value} />,
    },
    {
      title: "Invited by",
      dataIndex: "invitedByEmail",
      width: 220,
      render: (value: string | null) => <TextCell value={value} />,
    },
    {
      title: "Sent",
      dataIndex: "lastSentAt",
      width: 150,
      render: (value: string | null, row) => (
        <Tooltip title={formatDateTimeOrDash(value)}>
          <span tabIndex={0}>
            {formatRelativeTimeOrNever(value)}
            {row.sendCount > 1 && (
              // How many times the email went out: an invitation resent four
              // times is usually a wrong address, not a slow reader.
              <span className="ms-1 text-xs" style={{ color: surfaceColors.textTertiary }}>
                ×{row.sendCount}
              </span>
            )}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "Accepted",
      dataIndex: "acceptedAt",
      width: 150,
      render: (value: string | null) =>
        value === null ? (
          <Dash />
        ) : (
          <Tooltip title={formatDateTimeOrDash(value)}>
            <span tabIndex={0}>{formatRelativeTimeOrNever(value)}</span>
          </Tooltip>
        ),
    },
    {
      title: "Error",
      dataIndex: "error",
      width: 220,
      render: (value: string | null) => <ErrorCell error={value} />,
    },
  ];

  if (canInvite) {
    columns.push({
      title: "",
      key: "actions",
      width: 120,
      align: "right",
      render: (_value, row) => {
        // Only an invitation still waiting can be resent or withdrawn; an
        // accepted account belongs to the person now.
        if (row.status !== "invited") return null;
        const busy = busyId === row.id;
        return (
          <Space size={4}>
            <Popconfirm
              title="Send the invitation again"
              description={`${row.email} gets a new temporary password by email. The old one stops working.`}
              okText="Resend"
              cancelText="Cancel"
              disabled={!canAct || busy}
              onConfirm={() => {
                void resend(row);
              }}
            >
              <Tooltip title={canAct ? `Resend to ${row.email}` : store.unavailableReason ?? undefined}>
                <Button
                  type="text"
                  size="small"
                  aria-label={`Resend the invitation to ${row.email}`}
                  icon={<SendOutlined />}
                  disabled={!canAct || busy}
                />
              </Tooltip>
            </Popconfirm>

            <Popconfirm
              title="Revoke the invitation"
              description="Deletes the unaccepted account; the person can be invited again later."
              okText="Revoke"
              okButtonProps={{ danger: true }}
              cancelText="Cancel"
              disabled={!canAct || busy}
              onConfirm={() => {
                void revoke(row);
              }}
            >
              <Tooltip title={canAct ? `Revoke ${row.email}` : store.unavailableReason ?? undefined}>
                <Button
                  type="text"
                  size="small"
                  danger
                  aria-label={`Revoke the invitation to ${row.email}`}
                  icon={<DeleteOutlined />}
                  disabled={!canAct || busy}
                />
              </Tooltip>
            </Popconfirm>
          </Space>
        );
      },
    });
  }

  /* --------------------------------- header -------------------------------- */

  const figures = (
    <Figures
      label="Invitation totals"
      figures={[
        {
          label: "Invitations",
          value: store.total.toLocaleString(),
          tooltip: "Invitations the current filters match, across every page.",
        },
        {
          label: "Waiting",
          value: counts.invited.toLocaleString(),
          color: counts.invited > 0 ? "#D4A017" : undefined,
          tooltip: "Sent, and not yet accepted. Whole list, not just this page.",
          separatorBefore: true,
        },
        {
          label: "Accepted",
          value: counts.accepted.toLocaleString(),
          color: counts.accepted > 0 ? featureColors.loan : undefined,
          tooltip: "People who have signed in at least once.",
        },
        {
          label: "Failed",
          value: counts.failed.toLocaleString(),
          color: counts.failed > 0 ? featureColors.rule : undefined,
          tooltip: "Cognito refused the account; the reason is in the error column.",
        },
      ]}
    />
  );

  const rail = (
    <div className="flex flex-col gap-4">
      <StatCard
        title="By status"
        icon={<PieChartOutlined style={{ color: CUSTOMERS_COLOR }} />}
        rows={INVITE_STATUSES.map((status) => ({
          label: INVITE_STATUS_META[status].label,
          value: counts[status],
          color: INVITE_STATUS_META[status].color,
          tooltip: INVITE_STATUS_META[status].tooltip,
        }))}
        footnote="Counts cover every invitation ever sent, not just this page."
      />

      <Alert
        type="info"
        showIcon
        title="How an invitation works"
        description={
          <span className="flex flex-col gap-1">
            <span>1. The account is created in the customer Cognito pool.</span>
            <span>2. Cognito emails the person a temporary password.</span>
            <span>3. They sign in with it and set their own.</span>
          </span>
        }
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
            : pluralise(store.total, "invitation")}
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
                : (store.unavailableReason ?? "Invitations cannot be sent from this deployment.")
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
        tooltip="Reload this page of the log"
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
          placeholder="Search email or note…"
          aria-label="Search invitations"
          onChange={(event) => store.setSearch(event.target.value)}
          onSearch={store.setSearch}
        />
      </div>

      <span role="group" aria-label="Filter by status" className="max-lg:max-w-full max-lg:overflow-x-auto">
        <Segmented<InviteStatusFilter>
          value={store.statusFilter}
          onChange={store.setStatusFilter}
          options={[
            { value: "all", label: "All" },
            ...INVITE_STATUSES.map((status) => ({
              value: status,
              label: INVITE_STATUS_META[status].label,
            })),
          ]}
        />
      </span>
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
        title="The invitation log could not be loaded."
        description={store.error ?? undefined}
        action={
          <Button size="small" onClick={store.reload}>
            Retry
          </Button>
        }
      />
    );
  } else if (store.total === 0 && !store.filtersActive) {
    body = canInvite ? (
      <ListEmpty
        icon={<MailOutlined />}
        color={CUSTOMERS_COLOR}
        title="No invitations sent yet"
        description="Invite someone and Cognito emails them a temporary password; the invitation stays here until they sign in."
        actionLabel="Invite customer"
        onAction={onInvite}
      />
    ) : (
      <ListPanel>
        <div className="py-14 text-center">
          <Typography.Text type="secondary">No invitations sent yet.</Typography.Text>
        </div>
      </ListPanel>
    );
  } else {
    body = (
      <>
        {store.error !== null && <Alert type="warning" showIcon closable title={store.error} />}
        {toolbar}
        {store.total === 0 ? (
          <ListNoResults what="invitations" onClearFilters={store.clearFilters} />
        ) : (
          <ListTableRegion>
            {(y) => (
              <ListPanel>
                <ResponsiveTable<CustomerInvite>
                  dataSource={items}
                  rowKey="id"
                  columns={columns}
                  size="middle"
                  loading={store.refreshing}
                  scroll={{ x: 1330, y }}
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
        )}
      </>
    );
  }

  return (
    <ListPageFrame
      title="Customers"
      caption="Consumer-app accounts an operator created, and whether the person has signed in since."
      figures={store.loaded ? figures : undefined}
      ribbon={ribbon}
      rail={store.loaded ? rail : undefined}
    >
      {!canSend && (
        <Alert
          type="warning"
          showIcon
          title="Invitations cannot be sent from this deployment."
          description={store.unavailableReason ?? undefined}
        />
      )}
      {body}
    </ListPageFrame>
  );
}
