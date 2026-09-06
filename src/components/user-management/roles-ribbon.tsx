"use client";

/**
 * The roles ribbon: New role, Edit, Delete. Delete is refused by the server
 * for system roles and for roles that still have members; the button says so
 * before the click rather than after.
 */

import { Popconfirm } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { RibbonBar, RibbonButton } from "@/components/ribbon-bar";
import type { AdminRole } from "@/lib/admin-access/types";
import { pluralise } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";

interface RolesRibbonProps {
  selected: readonly AdminRole[];
  totalCount: number;
  canWrite: boolean;
  onAdd: () => void;
  onEdit: (role: AdminRole) => void;
  onDelete: (role: AdminRole) => void;
  onRefresh: () => void;
}

const NOT_SUPER_ADMIN = "Only a super-admin can change roles";

export default function RolesRibbon({
  selected,
  totalCount,
  canWrite,
  onAdd,
  onEdit,
  onDelete,
  onRefresh,
}: RolesRibbonProps) {
  const one = selected.length === 1 ? selected[0] : null;

  const deleteBlocked = !canWrite
    ? NOT_SUPER_ADMIN
    : one === null
      ? "Tick exactly one role"
      : one.isSystem
        ? "System roles are seeded and cannot be deleted"
        : one.memberCount > 0
          ? `Remove the role from its ${pluralise(one.memberCount, "member")} first`
          : null;

  const readout = (
    <span
      className="shrink-0 pr-1 text-[11px] tabular-nums"
      style={{ color: surfaceColors.textSecondary }}
    >
      {pluralise(totalCount, "role")}
    </span>
  );

  return (
    <RibbonBar trailing={readout}>
      <RibbonButton
        label="New Role"
        icon={<PlusOutlined />}
        onClick={onAdd}
        disabled={!canWrite}
        tooltip={canWrite ? "Bundle actions into a new role" : NOT_SUPER_ADMIN}
      />
      <RibbonButton
        label="Edit Role"
        icon={<EditOutlined />}
        onClick={() => {
          if (one !== null) onEdit(one);
        }}
        disabled={one === null}
        tooltip={one === null ? "Tick exactly one role to open it" : `Open ${one.name}`}
      />
      <Popconfirm
        title="Delete role"
        description={one ? `Delete “${one.name}”? This cannot be undone.` : undefined}
        okText="Delete"
        okButtonProps={{ danger: true }}
        cancelText="Cancel"
        disabled={deleteBlocked !== null}
        onConfirm={() => {
          if (one !== null) onDelete(one);
        }}
      >
        <span className="inline-flex">
          <RibbonButton
            label="Delete Role"
            icon={<DeleteOutlined />}
            disabled={deleteBlocked !== null}
            danger
            tooltip={deleteBlocked ?? `Delete ${one?.name}`}
          />
        </span>
      </Popconfirm>
      <RibbonButton
        label="Refresh"
        icon={<ReloadOutlined />}
        onClick={onRefresh}
        tooltip="Reload from the server"
      />
    </RibbonBar>
  );
}
