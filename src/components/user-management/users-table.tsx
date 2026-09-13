"use client";

/**
 * The admin-user list: who they are, what they hold, whether they can sign in,
 * when they last did. Ticking rows arms the ribbon; the name is a button that
 * opens the form, and a double-click anywhere on the row does the same.
 */

import { Avatar, Button, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { EditOutlined } from "@ant-design/icons";
import type { AdminRole, AdminUser } from "@/lib/admin-access/types";
import { formatDate, formatDateTimeOrDash, formatRelativeTimeOrNever } from "@/lib/format";
import { useListTableBodyHeight } from "@/lib/hooks/use-table-body-height";
import { ResponsiveTable } from "@/components/responsive-table";
import { accentBlue, accentTints, surfaceColors, withAlpha } from "@/lib/theme/colors";
import { initialsOf, RoleTag, StatusTag, SUPER_ADMIN_COLOR, SuperAdminTag } from "./access-meta";

/** The sum of the column widths; below it the table scrolls sideways. */
const TABLE_MIN_WIDTH = 960;

interface UsersTableProps {
  rows: readonly AdminUser[];
  roles: readonly AdminRole[];
  selectedIds: readonly string[];
  selfId: string;
  onSelectionChange: (ids: readonly string[]) => void;
  onEdit: (user: AdminUser) => void;
}

export default function UsersTable({
  rows,
  roles,
  selectedIds,
  selfId,
  onSelectionChange,
  onEdit,
}: UsersTableProps) {
  // Set inside a `ListTableRegion`: the rows scroll, the header and pager stay.
  const bodyHeight = useListTableBodyHeight();

  const columns: ColumnsType<AdminUser> = [
    {
      title: "User",
      key: "user",
      render: (_value, user) => {
        const disabled = user.disabledAt !== null;
        return (
          <span className="flex items-center gap-3">
            <Avatar
              size={32}
              style={{
                flexShrink: 0,
                backgroundColor: user.isSuperAdmin
                  ? withAlpha(SUPER_ADMIN_COLOR, 0.16)
                  : accentTints.soft,
                color: user.isSuperAdmin ? SUPER_ADMIN_COLOR : accentBlue,
                fontWeight: 600,
                opacity: disabled ? 0.55 : 1,
              }}
            >
              {initialsOf(user)}
            </Avatar>
            <span className="flex min-w-0 flex-col">
              <Button
                type="link"
                className="!h-auto !px-0 text-left"
                style={{
                  color: disabled ? surfaceColors.textSecondary : surfaceColors.text,
                  fontWeight: 500,
                }}
                onClick={() => onEdit(user)}
              >
                {user.displayName ?? user.email}
                {user.id === selfId ? (
                  <span className="ml-1 text-xs" style={{ color: surfaceColors.textTertiary }}>
                    (you)
                  </span>
                ) : null}
              </Button>
              {user.displayName !== null && (
                <span className="truncate text-xs" style={{ color: surfaceColors.textSecondary }}>
                  {user.email}
                </span>
              )}
            </span>
          </span>
        );
      },
    },
    {
      title: "Access",
      key: "roles",
      width: 320,
      render: (_value, user) => (
        <span className="flex flex-wrap gap-1">
          {user.isSuperAdmin && <SuperAdminTag />}
          {user.roleKeys.map((key) => (
            <RoleTag key={key} roleKey={key} roles={roles} />
          ))}
          {!user.isSuperAdmin && user.roleKeys.length === 0 && (
            <Tooltip title="Holds no role, so every action is denied.">
              <span className="text-xs" style={{ color: surfaceColors.textTertiary }}>
                No roles
              </span>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      title: "Status",
      key: "status",
      width: 110,
      render: (_value, user) =>
        user.disabledAt === null ? (
          <StatusTag user={user} />
        ) : (
          <Tooltip title={`Disabled ${formatDateTimeOrDash(user.disabledAt)}`}>
            <span>
              <StatusTag user={user} />
            </span>
          </Tooltip>
        ),
    },
    {
      title: "Last sign-in",
      dataIndex: "lastLoginAt",
      width: 150,
      sorter: (a, b) => (a.lastLoginAt ?? "").localeCompare(b.lastLoginAt ?? ""),
      render: (value: string | null) => (
        <Tooltip title={formatDateTimeOrDash(value)}>
          <span
            className="tabular-nums"
            style={{ color: value ? surfaceColors.textSecondary : surfaceColors.textTertiary }}
          >
            {formatRelativeTimeOrNever(value)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "Added",
      dataIndex: "createdAt",
      width: 130,
      sorter: (a, b) => a.createdAt.localeCompare(b.createdAt),
      render: (value: string) => (
        <span className="tabular-nums" style={{ color: surfaceColors.textSecondary }}>
          {formatDate(value)}
        </span>
      ),
    },
    {
      title: "",
      key: "actions",
      width: 56,
      align: "right",
      render: (_value, user) => (
        <Tooltip title="Open">
          <Button
            type="text"
            size="small"
            aria-label={`Open ${user.displayName ?? user.email}`}
            icon={<EditOutlined />}
            onClick={() => onEdit(user)}
          />
        </Tooltip>
      ),
    },
  ];

  return (
    <ResponsiveTable<AdminUser>
      dataSource={[...rows]}
      rowKey={(user) => user.id}
      columns={columns}
      size="middle"
      scroll={{ x: TABLE_MIN_WIDTH, y: bodyHeight }}
      pagination={
        rows.length > 25
          ? { pageSize: 25, showSizeChanger: true, size: "small", hideOnSinglePage: true }
          : false
      }
      rowSelection={{
        selectedRowKeys: [...selectedIds],
        onChange: (keys) => onSelectionChange(keys.map(String)),
        getCheckboxProps: (user) => ({
          "aria-label": `Select ${user.displayName ?? user.email}`,
        }),
      }}
      onRow={(user) => ({ onDoubleClick: () => onEdit(user) })}
    />
  );
}
