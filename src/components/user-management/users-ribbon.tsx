"use client";

/**
 * The users ribbon: Invite, Edit, Disable / Enable and Refresh, on the app's
 * strip across the top. Every action but Invite and Refresh acts on the ticked
 * rows; buttons grey out rather than disappear so the bar never reflows.
 *
 * Writes are super-admin only. For anyone else the write buttons stay visible
 * and disabled, with the tooltip saying why, so the model is legible.
 */

import { Popconfirm } from "antd";
import {
  EditOutlined,
  ReloadOutlined,
  StopOutlined,
  UserAddOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import { RibbonBar, RibbonButton } from "@/components/ribbon-bar";
import type { AdminUser } from "@/lib/admin-access/types";
import { pluralise } from "@/lib/format";
import { surfaceColors } from "@/lib/theme/colors";

interface UsersRibbonProps {
  selected: readonly AdminUser[];
  filteredCount: number;
  totalCount: number;
  canWrite: boolean;
  /** The signed-in operator: their own row cannot be disabled from here. */
  selfId: string;
  onInvite: () => void;
  onEdit: (user: AdminUser) => void;
  onSetDisabled: (user: AdminUser, disabled: boolean) => void;
  onRefresh: () => void;
}

const NOT_SUPER_ADMIN = "Only a super-admin can change admin access";

export default function UsersRibbon({
  selected,
  filteredCount,
  totalCount,
  canWrite,
  selfId,
  onInvite,
  onEdit,
  onSetDisabled,
  onRefresh,
}: UsersRibbonProps) {
  const one = selected.length === 1 ? selected[0] : null;
  const label = one ? (one.displayName ?? one.email) : null;
  const oneIsSelf = one?.id === selfId;
  const oneDisabled = one?.disabledAt !== null;

  const readout = (
    <span
      className="shrink-0 pr-1 text-[11px] tabular-nums"
      style={{ color: surfaceColors.textSecondary }}
    >
      {filteredCount} of {pluralise(totalCount, "admin user")}
    </span>
  );

  const toggleLabel = one && oneDisabled ? "Enable User" : "Disable User";
  const toggleDisabled = !canWrite || one === null || oneIsSelf;
  const toggleTooltip = !canWrite
    ? NOT_SUPER_ADMIN
    : one === null
      ? "Tick exactly one admin user"
      : oneIsSelf
        ? "You cannot disable your own account"
        : oneDisabled
          ? `Let ${label} sign in again`
          : `Stop ${label} from signing in. The row stays for the audit trail.`;

  return (
    <RibbonBar trailing={readout}>
      <RibbonButton
        label="Invite User"
        icon={<UserAddOutlined />}
        onClick={onInvite}
        disabled={!canWrite}
        tooltip={canWrite ? "Add an operator to the admin pool" : NOT_SUPER_ADMIN}
      />
      <RibbonButton
        label="Edit User"
        icon={<EditOutlined />}
        onClick={() => {
          if (one !== null) onEdit(one);
        }}
        disabled={one === null}
        tooltip={one === null ? "Tick exactly one admin user to open it" : `Open ${label}`}
      />
      <Popconfirm
        title={toggleLabel}
        description={one ? toggleTooltip : undefined}
        okText={one && oneDisabled ? "Enable" : "Disable"}
        okButtonProps={{ danger: !(one && oneDisabled) }}
        cancelText="Cancel"
        disabled={toggleDisabled}
        onConfirm={() => {
          if (one !== null) onSetDisabled(one, !oneDisabled);
        }}
      >
        <span className="inline-flex">
          <RibbonButton
            label={toggleLabel}
            icon={one && oneDisabled ? <CheckCircleOutlined /> : <StopOutlined />}
            disabled={toggleDisabled}
            danger={!(one && oneDisabled)}
            tooltip={toggleTooltip}
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
