"use client";

/**
 * User Management: the operator allowlist, the role catalog and the audit
 * trail from `docs/admin-access/README.md`, in the app's list-page shape —
 * figures in the header, actions on the ribbon, the list taking the width and
 * a breakdown card down the right rail.
 *
 * Three views share the frame, switched by a segmented control under the
 * ribbon: **Users**, **Roles** and **Audit log**. Which views are offered
 * follows the caller's actions; which buttons are live follows whether they
 * are a super-admin, because only a super-admin may write.
 */

import { useMemo } from "react";
import { Alert, Button, Segmented, Spin } from "antd";
import {
  HistoryOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  UserAddOutlined,
} from "@ant-design/icons";
import { ListEmpty, ListNoResults } from "@/components/empty-state";
import Figures from "@/components/figures";
import { ListPageFrame, ListPanel, ListTableRegion } from "@/components/list-page-frame";
import { RibbonBar, RibbonButton } from "@/components/ribbon-bar";
import StatCard from "@/components/stat-card";
import { useAdminAccessStore, type AccessView } from "@/lib/admin-access/store";
import type { AdminCapabilities } from "@/lib/admin-access/types";
import { pluralise } from "@/lib/format";
import { featureColors, surfaceColors } from "@/lib/theme/colors";
import { ACCESS_COLOR, SUPER_ADMIN_COLOR } from "./access-meta";
import AuditTable from "./audit-table";
import RoleFormDrawer from "./role-form-drawer";
import RolesRibbon from "./roles-ribbon";
import RolesTable from "./roles-table";
import UserFormDrawer from "./user-form-drawer";
import UsersRibbon from "./users-ribbon";
import UsersTable from "./users-table";
import UsersToolbar from "./users-toolbar";

interface UserManagementPageProps {
  /** The signed-in operator, resolved on the server. */
  capabilities: AdminCapabilities;
}

export default function UserManagementPage({ capabilities }: UserManagementPageProps) {
  const store = useAdminAccessStore(capabilities);

  const views = useMemo(() => {
    const options: Array<{ value: AccessView; label: string; icon: React.ReactNode }> = [];
    if (store.canManageUsers) options.push({ value: "users", label: "Users", icon: <TeamOutlined /> });
    if (store.canManageRoles) options.push({ value: "roles", label: "Roles", icon: <SafetyCertificateOutlined /> });
    if (store.canReadAudit) options.push({ value: "audit", label: "Audit log", icon: <HistoryOutlined /> });
    return options;
  }, [store.canManageUsers, store.canManageRoles, store.canReadAudit]);

  // A caller whose actions do not include the default view lands on the first
  // one they may see.
  const view: AccessView = views.some((option) => option.value === store.view)
    ? store.view
    : (views[0]?.value ?? "users");

  /* ------------------------------- header --------------------------------- */

  const { usersSummary } = store;
  const figures = (
    <Figures
      label="Access totals"
      figures={[
        {
          label: "Admin users",
          value: `${usersSummary.total}`,
          tooltip: "How many admin users are on screen. The filters narrow this figure.",
        },
        {
          label: "Enabled",
          value: `${usersSummary.enabled}`,
          color: ACCESS_COLOR,
          tooltip: "Admin users who can sign in right now.",
        },
        {
          label: "Super-admins",
          value: `${usersSummary.superAdmins}`,
          color: SUPER_ADMIN_COLOR,
          tooltip: "Bypass every action check and manage access itself.",
        },
        {
          label: "Roles",
          value: `${store.roles.length}`,
          tooltip: "Roles in the catalog, system and custom.",
          separatorBefore: true,
        },
      ]}
    />
  );

  const rail =
    view === "roles" ? (
      <StatCard
        title="Members per role"
        icon={<SafetyCertificateOutlined style={{ color: ACCESS_COLOR }} />}
        total={Math.max(1, ...store.roles.map((role) => role.memberCount))}
        rows={store.roles.map((role) => ({
          label: role.name,
          value: role.memberCount,
          color: role.isSystem ? ACCESS_COLOR : featureColors.constants,
          tooltip: role.description ?? undefined,
        }))}
        footnote="Enabled users holding each role. Super-admins need no role."
      />
    ) : (
      <StatCard
        title="Access"
        icon={<TeamOutlined style={{ color: ACCESS_COLOR }} />}
        total={usersSummary.total}
        rows={[
          {
            label: "Super-admins",
            value: usersSummary.superAdmins,
            color: SUPER_ADMIN_COLOR,
            tooltip: "Allowed everything.",
          },
          {
            label: "With roles",
            value: usersSummary.total - usersSummary.superAdmins - usersSummary.withoutRoles - usersSummary.disabled + countDisabledSuperOrRoled(store),
            color: ACCESS_COLOR,
            tooltip: "Permissions come from their roles.",
          },
          {
            label: "No roles",
            value: usersSummary.withoutRoles,
            color: featureColors.neutral,
            tooltip: "Enabled or not, they hold no role, so every action is denied.",
          },
          {
            label: "Disabled",
            value: usersSummary.disabled,
            color: featureColors.rule,
            tooltip: "Cannot sign in. The row stays for the audit trail.",
          },
        ]}
        footnote="Default deny: an action is allowed only through a role, or to a super-admin."
      />
    );

  /* -------------------------------- ribbon -------------------------------- */

  const ribbon =
    view === "users" ? (
      <UsersRibbon
        selected={store.selectedUsers}
        filteredCount={store.userRows.length}
        totalCount={store.users.length}
        canWrite={store.canWrite}
        selfId={capabilities.userId}
        onInvite={store.openInviteForm}
        onEdit={store.openEditUserForm}
        onSetDisabled={(user, disabled) => {
          void store.setUserDisabled(user.id, disabled);
        }}
        onRefresh={store.reload}
      />
    ) : view === "roles" ? (
      <RolesRibbon
        selected={store.selectedRoles}
        totalCount={store.roles.length}
        canWrite={store.canWrite}
        onAdd={store.openAddRoleForm}
        onEdit={store.openEditRoleForm}
        onDelete={(role) => {
          void store.deleteRole(role.id);
        }}
        onRefresh={store.reload}
      />
    ) : (
      <RibbonBar
        trailing={
          <span className="shrink-0 pr-1 text-[11px] tabular-nums" style={{ color: surfaceColors.textSecondary }}>
            {pluralise(store.audit.length, "event")} loaded
          </span>
        }
      >
        <RibbonButton label="Refresh" icon={<ReloadOutlined />} onClick={store.reload} tooltip="Reload from the server" />
      </RibbonBar>
    );

  /* --------------------------------- body --------------------------------- */

  let body: React.ReactNode;
  if (store.loading) {
    body = (
      <ListPanel>
        <div className="flex items-center justify-center py-16">
          <Spin />
        </div>
      </ListPanel>
    );
  } else if (store.error !== null && store.users.length === 0 && store.roles.length === 0) {
    body = (
      <Alert
        type="error"
        showIcon
        title="Admin access could not be loaded."
        description={store.error}
        action={
          <Button size="small" onClick={store.reload}>
            Retry
          </Button>
        }
      />
    );
  } else if (views.length === 0) {
    body = (
      <Alert
        type="info"
        showIcon
        title="You can sign in, but your roles grant nothing in this area."
        description="Ask a super-admin for the admin-access actions if you need to manage operators."
      />
    );
  } else if (view === "users") {
    body =
      store.users.length === 0 ? (
        <ListEmpty
          icon={<UserAddOutlined />}
          color={ACCESS_COLOR}
          title="No admin users yet"
          description="Operators sign in through the admin Cognito pool, but only those on this list get past the door. Invite the first one."
          actionLabel="Invite user"
          onAction={store.openInviteForm}
        />
      ) : (
        <>
          {store.error !== null && (
            <Alert type="warning" showIcon closable title={store.error} />
          )}
          <UsersToolbar
            filters={store.usersFilters}
            roles={store.roles}
            onSearchChange={store.setUsersSearch}
            onStatusChange={store.setUsersStatus}
            onRoleChange={store.setUsersRole}
          />
          {store.userRows.length === 0 ? (
            <ListNoResults what="admin users" onClearFilters={store.clearUsersFilters} />
          ) : (
            <ListTableRegion>
              <ListPanel>
                <UsersTable
                  rows={store.userRows}
                  roles={store.roles}
                  selectedIds={store.selectedUserIds}
                  selfId={capabilities.userId}
                  onSelectionChange={store.setSelectedUserIds}
                  onEdit={store.openEditUserForm}
                />
              </ListPanel>
            </ListTableRegion>
          )}
        </>
      );
  } else if (view === "roles") {
    body = (
      <ListTableRegion>
        <ListPanel>
          <RolesTable
            rows={store.roles}
            actions={store.actions}
            selectedIds={store.selectedRoleIds}
            onSelectionChange={store.setSelectedRoleIds}
            onEdit={store.openEditRoleForm}
            onShowMembers={(role) => {
              store.setUsersRole(role.key);
              store.setUsersStatus("enabled");
              store.setView("users");
            }}
          />
        </ListPanel>
      </ListTableRegion>
    );
  } else {
    body = (
      <ListTableRegion>
        <ListPanel>
          <AuditTable
            rows={store.audit}
            hasMore={store.auditHasMore}
            loadingMore={store.auditLoadingMore}
            onLoadMore={store.loadMoreAudit}
          />
        </ListPanel>
      </ListTableRegion>
    );
  }

  const caption =
    view === "users"
      ? `${pluralise(store.userRows.length, "admin user")} shown · ${store.users.length} in total`
      : view === "roles"
        ? `${pluralise(store.roles.length, "role")} · default deny, allow through roles or super-admin`
        : "Every membership and grant change, newest first";

  return (
    <>
      <ListPageFrame
        title="User Management"
        caption={caption}
        figures={store.loading ? undefined : figures}
        ribbon={ribbon}
        rail={store.loading || views.length === 0 ? undefined : rail}
      >
        {views.length > 1 && (
          <span role="group" aria-label="Section">
            <Segmented<AccessView>
              value={view}
              onChange={store.setView}
              options={views}
            />
          </span>
        )}
        {body}
      </ListPageFrame>

      <UserFormDrawer
        open={store.userFormOpen}
        user={store.userFormUser}
        roles={store.roles}
        capabilities={capabilities}
        onClose={store.closeUserForm}
        onCreate={store.createUser}
        onUpdate={store.updateUser}
        onSetDisabled={store.setUserDisabled}
      />

      <RoleFormDrawer
        open={store.roleFormOpen}
        role={store.roleFormRole}
        actions={store.actions}
        readOnly={!store.canWrite}
        onClose={store.closeRoleForm}
        onCreate={store.createRole}
        onUpdate={store.updateRole}
      />
    </>
  );
}

/**
 * "With roles" counts everyone who is neither a super-admin nor role-less,
 * whatever their status; the summary's `disabled` bucket overlaps, so the
 * subtraction above has to add those back in.
 */
function countDisabledSuperOrRoled(store: ReturnType<typeof useAdminAccessStore>): number {
  return store.userRows.filter(
    (user) => user.disabledAt !== null && (user.isSuperAdmin || user.roleKeys.length > 0),
  ).length;
}
