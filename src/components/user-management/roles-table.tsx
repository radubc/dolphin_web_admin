"use client";

/**
 * The role catalog: name and key, what it says it is for, how many actions it
 * grants (grouped by area on hover), and how many enabled users hold it.
 */

import { Button, Table, Tag, Tooltip } from "antd";
import type { ColumnsType } from "antd/es/table";
import { EditOutlined, LockOutlined } from "@ant-design/icons";
import type { AdminAction, AdminRole } from "@/lib/admin-access/types";
import { humaniseKey, pluralise } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";
import { categoryLabel } from "./access-meta";

const TABLE_MIN_WIDTH = 880;

interface RolesTableProps {
  rows: readonly AdminRole[];
  actions: readonly AdminAction[];
  selectedIds: readonly string[];
  onSelectionChange: (ids: readonly string[]) => void;
  onEdit: (role: AdminRole) => void;
  /** Filters the users view to this role. */
  onShowMembers: (role: AdminRole) => void;
}

/** "Support tickets: 5 · End users: 2", for the actions column. */
function grantSummary(role: AdminRole, actions: readonly AdminAction[]): string[] {
  const counts = new Map<string, number>();
  for (const key of role.actionKeys) {
    const action = actions.find((candidate) => candidate.key === key);
    const category = action?.category ?? "other";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => `${categoryLabel(category)}: ${count}`);
}

export default function RolesTable({
  rows,
  actions,
  selectedIds,
  onSelectionChange,
  onEdit,
  onShowMembers,
}: RolesTableProps) {
  const columns: ColumnsType<AdminRole> = [
    {
      title: "Role",
      key: "role",
      render: (_value, role) => (
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <Button
              type="link"
              className="!h-auto !px-0 text-left"
              style={{ color: surfaceColors.text, fontWeight: 500 }}
              onClick={() => onEdit(role)}
            >
              {role.name}
            </Button>
            {role.isSystem && (
              <Tooltip title="Seeded with the app. Its grants can be edited; the role cannot be deleted.">
                <Tag icon={<LockOutlined />} style={{ marginInlineEnd: 0 }}>
                  System
                </Tag>
              </Tooltip>
            )}
          </span>
          <code className="text-xs" style={{ color: surfaceColors.textTertiary }}>
            {role.key}
          </code>
        </span>
      ),
    },
    {
      title: "Description",
      dataIndex: "description",
      width: 340,
      render: (value: string | null) =>
        value === null ? (
          <span style={{ color: surfaceColors.textTertiary }}>—</span>
        ) : (
          <span className="line-clamp-2 text-sm" style={{ color: surfaceColors.textSecondary }}>
            {value}
          </span>
        ),
    },
    {
      title: "Actions",
      key: "actions",
      width: 220,
      render: (_value, role) => {
        const summary = grantSummary(role, actions);
        return (
          <Tooltip
            title={
              role.actionKeys.length === 0 ? (
                "Grants nothing."
              ) : (
                <ul className="m-0 list-none p-0">
                  {role.actionKeys.map((key) => (
                    <li key={key}>{humaniseKey(key)}</li>
                  ))}
                </ul>
              )
            }
          >
            <span className="flex flex-col">
              <span className="tabular-nums" style={{ color: surfaceColors.text }}>
                {pluralise(role.actionKeys.length, "action")}
              </span>
              {summary.length > 0 && (
                <span className="truncate text-xs" style={{ color: surfaceColors.textTertiary }}>
                  {summary.join(" · ")}
                </span>
              )}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "Members",
      dataIndex: "memberCount",
      width: 110,
      align: "right",
      sorter: (a, b) => a.memberCount - b.memberCount,
      render: (value: number, role) =>
        value === 0 ? (
          <span className="tabular-nums" style={{ color: surfaceColors.textTertiary }}>
            0
          </span>
        ) : (
          <Tooltip title="Show these users">
            <Button type="link" className="!h-auto !px-0 tabular-nums" onClick={() => onShowMembers(role)}>
              {value}
            </Button>
          </Tooltip>
        ),
    },
    {
      title: "",
      key: "row-actions",
      width: 56,
      align: "right",
      render: (_value, role) => (
        <Tooltip title="Open">
          <Button
            type="text"
            size="small"
            aria-label={`Open ${role.name}`}
            icon={<EditOutlined />}
            onClick={() => onEdit(role)}
          />
        </Tooltip>
      ),
    },
  ];

  return (
    <Table<AdminRole>
      dataSource={[...rows]}
      rowKey={(role) => role.id}
      columns={columns}
      size="middle"
      scroll={{ x: TABLE_MIN_WIDTH }}
      pagination={false}
      rowSelection={{
        selectedRowKeys: [...selectedIds],
        onChange: (keys) => onSelectionChange(keys.map(String)),
        getCheckboxProps: (role) => ({ "aria-label": `Select ${role.name}` }),
      }}
      onRow={(role) => ({ onDoubleClick: () => onEdit(role) })}
    />
  );
}
