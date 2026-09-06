"use client";

/**
 * Small shared pieces of the User Management screen: the page colour, the
 * role and status tags, and the labels the audit log uses. Kept together so
 * the table, the drawers and the log all say the same thing the same way.
 */

import { Tag, Tooltip } from "antd";
import { CrownFilled } from "@ant-design/icons";
import type { AdminRole, AdminUser } from "@/lib/admin-access/types";
import { humaniseKey } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";

/** The User Management tab's colour on the rail. */
export const ACCESS_COLOR = featureColors.users;

/** Gold, for the one flag that outranks every role. */
export const SUPER_ADMIN_COLOR = "#D4A017";

export function SuperAdminTag({ compact = false }: { compact?: boolean }) {
  return (
    <Tooltip title="Bypasses every action check and may manage users, roles and grants.">
      <Tag
        icon={<CrownFilled />}
        color="gold"
        style={{ marginInlineEnd: 0, fontWeight: 600 }}
      >
        {compact ? "Super" : "Super-admin"}
      </Tag>
    </Tooltip>
  );
}

export function RoleTag({ roleKey, roles }: { roleKey: string; roles: readonly AdminRole[] }) {
  const role = roles.find((candidate) => candidate.key === roleKey);
  return (
    <Tooltip title={role?.description ?? roleKey}>
      <Tag style={{ marginInlineEnd: 0 }}>{role?.name ?? humaniseKey(roleKey)}</Tag>
    </Tooltip>
  );
}

export function StatusTag({ user }: { user: Pick<AdminUser, "disabledAt"> }) {
  return user.disabledAt === null ? (
    <Tag color="success" style={{ marginInlineEnd: 0 }}>
      Enabled
    </Tag>
  ) : (
    <Tag style={{ marginInlineEnd: 0, color: surfaceColors.textSecondary }}>Disabled</Tag>
  );
}

/** Initials for the avatar disc: "Maya Chen" → "MC", "owner@…" → "O". */
export function initialsOf(user: Pick<AdminUser, "displayName" | "email">): string {
  const source = user.displayName?.trim() || user.email.split("@")[0];
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 1);
  return letters.toUpperCase();
}

/** The audit log's verbs, read as a person would say them. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  admin_user_created: "Added admin user",
  admin_user_updated: "Updated admin user",
  admin_user_disabled: "Disabled admin user",
  admin_user_enabled: "Re-enabled admin user",
  super_admin_granted: "Granted super-admin",
  super_admin_revoked: "Revoked super-admin",
  role_assigned: "Assigned role",
  role_revoked: "Removed role",
  role_created: "Created role",
  role_updated: "Updated role",
  role_deleted: "Deleted role",
  action_granted: "Granted actions",
  action_revoked: "Revoked actions",
};

/** Red for removals, green for grants, neutral for the rest. */
export function auditTone(action: string): "success" | "error" | "default" {
  if (/revoked|disabled|deleted/.test(action)) return "error";
  if (/granted|created|enabled|assigned/.test(action)) return "success";
  return "default";
}

/** Category labels for the permission catalog. */
export const ACTION_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  admin_access: "Admin access",
  users: "End users",
  tenants: "Tenants",
  tickets: "Support tickets",
  catalogs: "Catalogs",
};

export function categoryLabel(category: string): string {
  return ACTION_CATEGORY_LABELS[category] ?? humaniseKey(category);
}
