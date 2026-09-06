"use client";

/**
 * The User Management page's client store.
 *
 * One hook — `useAdminAccessStore(capabilities)` — owns the three lists (users,
 * roles, audit), the filters and selection of the users view, the open form,
 * and every mutation. Data comes from the admin API through `adminAccessApi`;
 * a mutation reloads the lists so counts and role memberships stay honest, and
 * the store also reloads when anything else announces a change (the shell's
 * "Invite user" drawer).
 *
 * What is loaded follows the capabilities: a caller without `can_manage_roles`
 * never asks for the roles list, so the page does not paint a 403 it could
 * have predicted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminAccessApi, onAdminAccessChanged } from "./client";
import {
  adminUserStatus,
  canDo,
  type AdminAction,
  type AdminCapabilities,
  type AdminRole,
  type AdminUser,
  type AdminUserStatus,
  type AuditEvent,
  type CreateAdminUserInput,
  type CreateRoleInput,
  type UpdateAdminUserInput,
  type UpdateRoleInput,
} from "./types";
import { errorMessage } from "@/lib/format";

/* -------------------------------------------------------------------------- */
/* Views and filters                                                          */
/* -------------------------------------------------------------------------- */

export type AccessView = "users" | "roles" | "audit";

export type UserStatusFilter = "all" | AdminUserStatus;

export interface UsersFilters {
  search: string;
  status: UserStatusFilter;
  /** A role key, or null for any. */
  roleKey: string | null;
}

export const DEFAULT_USERS_FILTERS: UsersFilters = { search: "", status: "all", roleKey: null };

export const USER_STATUS_FILTERS: readonly UserStatusFilter[] = ["all", "enabled", "disabled"];

export const USER_STATUS_LABELS: Readonly<Record<UserStatusFilter, string>> = {
  all: "All",
  enabled: "Enabled",
  disabled: "Disabled",
};

export function hasNarrowingUsersFilters(filters: UsersFilters): boolean {
  return filters.search.trim() !== "" || filters.status !== "all" || filters.roleKey !== null;
}

function matchesUser(user: AdminUser, filters: UsersFilters, needle: string): boolean {
  if (needle !== "") {
    const haystack = `${user.email} ${user.displayName ?? ""} ${user.roleKeys.join(" ")}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (filters.status !== "all" && adminUserStatus(user) !== filters.status) return false;
  if (filters.roleKey !== null && !user.roleKeys.includes(filters.roleKey)) return false;
  return true;
}

export interface UsersSummary {
  total: number;
  enabled: number;
  disabled: number;
  superAdmins: number;
  withoutRoles: number;
}

function summariseUsers(users: readonly AdminUser[]): UsersSummary {
  let enabled = 0;
  let superAdmins = 0;
  let withoutRoles = 0;
  for (const user of users) {
    if (user.disabledAt === null) enabled += 1;
    if (user.isSuperAdmin) superAdmins += 1;
    if (!user.isSuperAdmin && user.roleKeys.length === 0) withoutRoles += 1;
  }
  return { total: users.length, enabled, disabled: users.length - enabled, superAdmins, withoutRoles };
}

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

const AUDIT_PAGE_SIZE = 50;

export interface AdminAccessStore {
  capabilities: AdminCapabilities;
  canManageUsers: boolean;
  canManageRoles: boolean;
  canReadAudit: boolean;
  /** Writes are super-admin only, per the access model. */
  canWrite: boolean;

  view: AccessView;
  setView: (view: AccessView) => void;

  loading: boolean;
  error: string | null;
  reload: () => void;

  /* users */
  users: readonly AdminUser[];
  userRows: AdminUser[];
  usersSummary: UsersSummary;
  usersFilters: UsersFilters;
  usersFiltersActive: boolean;
  setUsersSearch: (search: string) => void;
  setUsersStatus: (status: UserStatusFilter) => void;
  setUsersRole: (roleKey: string | null) => void;
  clearUsersFilters: () => void;
  selectedUserIds: string[];
  selectedUsers: AdminUser[];
  setSelectedUserIds: (ids: readonly string[]) => void;
  userFormOpen: boolean;
  /** Null while inviting. */
  userFormUser: AdminUser | null;
  openInviteForm: () => void;
  openEditUserForm: (user: AdminUser) => void;
  closeUserForm: () => void;
  createUser: (input: CreateAdminUserInput) => Promise<AdminUser>;
  updateUser: (id: string, input: UpdateAdminUserInput) => Promise<AdminUser>;
  setUserDisabled: (id: string, disabled: boolean) => Promise<AdminUser>;

  /* roles */
  roles: readonly AdminRole[];
  actions: readonly AdminAction[];
  selectedRoleIds: string[];
  selectedRoles: AdminRole[];
  setSelectedRoleIds: (ids: readonly string[]) => void;
  roleFormOpen: boolean;
  roleFormRole: AdminRole | null;
  openAddRoleForm: () => void;
  openEditRoleForm: (role: AdminRole) => void;
  closeRoleForm: () => void;
  createRole: (input: CreateRoleInput) => Promise<AdminRole>;
  updateRole: (id: string, input: UpdateRoleInput) => Promise<AdminRole>;
  deleteRole: (id: string) => Promise<void>;

  /* audit */
  audit: readonly AuditEvent[];
  auditHasMore: boolean;
  auditLoadingMore: boolean;
  loadMoreAudit: () => void;
}

export function useAdminAccessStore(capabilities: AdminCapabilities): AdminAccessStore {
  const canManageUsers = canDo(capabilities, "can_manage_admin_users");
  const canManageRoles = canDo(capabilities, "can_manage_roles");
  const canReadAudit = canDo(capabilities, "can_read_admin_audit");
  const canWrite = capabilities.isSuperAdmin;

  const [view, setView] = useState<AccessView>("users");

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [actions, setActions] = useState<AdminAction[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);

  // `loading` starts true and only ever goes false: a reload after a mutation
  // keeps the current rows on screen instead of flashing the spinner.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => {
    setError(null);
    setReloadTick((tick) => tick + 1);
  }, []);

  /* ------------------------------- Loading -------------------------------- */

  // Only the newest request may write results: a slow first load must not
  // overwrite the answer to a reload that finished before it.
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    let cancelled = false;

    void (async () => {
      try {
        const [nextUsers, nextRoles, nextActions, nextAudit] = await Promise.all([
          canManageUsers ? adminAccessApi.listUsers() : Promise.resolve([]),
          canManageRoles ? adminAccessApi.listRoles() : Promise.resolve([]),
          canManageRoles ? adminAccessApi.listActions() : Promise.resolve([]),
          canReadAudit
            ? adminAccessApi.listAudit(AUDIT_PAGE_SIZE)
            : Promise.resolve({ events: [], nextCursor: null }),
        ]);
        if (cancelled || seq !== requestSeq.current) return;
        setUsers(nextUsers);
        setRoles(nextRoles);
        setActions(nextActions);
        setAudit(nextAudit.events);
        setAuditCursor(nextAudit.nextCursor);
      } catch (cause) {
        if (cancelled || seq !== requestSeq.current) return;
        setError(errorMessage(cause));
      } finally {
        if (!cancelled && seq === requestSeq.current) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reloadTick, canManageUsers, canManageRoles, canReadAudit]);

  // Writes made elsewhere (the shell's Invite user drawer) announce themselves.
  useEffect(() => onAdminAccessChanged(reload), [reload]);

  const loadMoreAudit = useCallback(() => {
    if (auditCursor === null || auditLoadingMore) return;
    setAuditLoadingMore(true);
    void adminAccessApi
      .listAudit(AUDIT_PAGE_SIZE, auditCursor)
      .then((page) => {
        setAudit((current) => [...current, ...page.events]);
        setAuditCursor(page.nextCursor);
      })
      .catch((cause) => setError(errorMessage(cause)))
      .finally(() => setAuditLoadingMore(false));
  }, [auditCursor, auditLoadingMore]);

  /* --------------------------------- Users -------------------------------- */

  const [usersFilters, setUsersFilters] = useState<UsersFilters>(DEFAULT_USERS_FILTERS);
  const [selectedUserIds, setSelectedUserIdsState] = useState<string[]>([]);
  const [userFormOpen, setUserFormOpen] = useState(false);
  const [userFormId, setUserFormId] = useState<string | null>(null);

  const userRows = useMemo(() => {
    const needle = usersFilters.search.trim().toLowerCase();
    return users.filter((user) => matchesUser(user, usersFilters, needle));
  }, [users, usersFilters]);

  const usersSummary = useMemo(() => summariseUsers(userRows), [userRows]);

  const selectedUsers = useMemo(() => {
    const wanted = new Set(selectedUserIds);
    return userRows.filter((user) => wanted.has(user.id));
  }, [userRows, selectedUserIds]);

  const userFormUser = useMemo(
    () => users.find((user) => user.id === userFormId) ?? null,
    [users, userFormId],
  );

  const patchUsersFilters = useCallback((next: Partial<UsersFilters>) => {
    setUsersFilters((current) => ({ ...current, ...next }));
  }, []);
  const setUsersSearch = useCallback((search: string) => patchUsersFilters({ search }), [patchUsersFilters]);
  const setUsersStatus = useCallback(
    (status: UserStatusFilter) => patchUsersFilters({ status }),
    [patchUsersFilters],
  );
  const setUsersRole = useCallback(
    (roleKey: string | null) => patchUsersFilters({ roleKey }),
    [patchUsersFilters],
  );
  const clearUsersFilters = useCallback(() => setUsersFilters(DEFAULT_USERS_FILTERS), []);

  const setSelectedUserIds = useCallback((ids: readonly string[]) => {
    setSelectedUserIdsState([...ids]);
  }, []);

  const openInviteForm = useCallback(() => {
    setUserFormId(null);
    setUserFormOpen(true);
  }, []);
  const openEditUserForm = useCallback((user: AdminUser) => {
    setUserFormId(user.id);
    setUserFormOpen(true);
  }, []);
  const closeUserForm = useCallback(() => {
    setUserFormOpen(false);
    setUserFormId(null);
  }, []);

  const createUser = useCallback(async (input: CreateAdminUserInput) => {
    const user = await adminAccessApi.createUser(input);
    setUsers((current) => [...current, user]);
    return user;
  }, []);

  const updateUser = useCallback(async (id: string, input: UpdateAdminUserInput) => {
    const user = await adminAccessApi.updateUser(id, input);
    setUsers((current) => current.map((item) => (item.id === id ? user : item)));
    return user;
  }, []);

  const setUserDisabled = useCallback(
    (id: string, disabled: boolean) => updateUser(id, { disabled }),
    [updateUser],
  );

  /* --------------------------------- Roles -------------------------------- */

  const [selectedRoleIds, setSelectedRoleIdsState] = useState<string[]>([]);
  const [roleFormOpen, setRoleFormOpen] = useState(false);
  const [roleFormId, setRoleFormId] = useState<string | null>(null);

  const selectedRoles = useMemo(() => {
    const wanted = new Set(selectedRoleIds);
    return roles.filter((role) => wanted.has(role.id));
  }, [roles, selectedRoleIds]);

  const roleFormRole = useMemo(
    () => roles.find((role) => role.id === roleFormId) ?? null,
    [roles, roleFormId],
  );

  const setSelectedRoleIds = useCallback((ids: readonly string[]) => {
    setSelectedRoleIdsState([...ids]);
  }, []);

  const openAddRoleForm = useCallback(() => {
    setRoleFormId(null);
    setRoleFormOpen(true);
  }, []);
  const openEditRoleForm = useCallback((role: AdminRole) => {
    setRoleFormId(role.id);
    setRoleFormOpen(true);
  }, []);
  const closeRoleForm = useCallback(() => {
    setRoleFormOpen(false);
    setRoleFormId(null);
  }, []);

  const createRole = useCallback(async (input: CreateRoleInput) => {
    const role = await adminAccessApi.createRole(input);
    setRoles((current) => [...current, role]);
    return role;
  }, []);

  const updateRole = useCallback(async (id: string, input: UpdateRoleInput) => {
    const role = await adminAccessApi.updateRole(id, input);
    setRoles((current) => current.map((item) => (item.id === id ? role : item)));
    return role;
  }, []);

  const deleteRole = useCallback(async (id: string) => {
    await adminAccessApi.deleteRole(id);
    setRoles((current) => current.filter((item) => item.id !== id));
    setSelectedRoleIdsState((current) => current.filter((item) => item !== id));
  }, []);

  return {
    capabilities,
    canManageUsers,
    canManageRoles,
    canReadAudit,
    canWrite,

    view,
    setView,

    loading,
    error,
    reload,

    users,
    userRows,
    usersSummary,
    usersFilters,
    usersFiltersActive: hasNarrowingUsersFilters(usersFilters),
    setUsersSearch,
    setUsersStatus,
    setUsersRole,
    clearUsersFilters,
    selectedUserIds,
    selectedUsers,
    setSelectedUserIds,
    userFormOpen,
    userFormUser,
    openInviteForm,
    openEditUserForm,
    closeUserForm,
    createUser,
    updateUser,
    setUserDisabled,

    roles,
    actions,
    selectedRoleIds,
    selectedRoles,
    setSelectedRoleIds,
    roleFormOpen,
    roleFormRole,
    openAddRoleForm,
    openEditRoleForm,
    closeRoleForm,
    createRole,
    updateRole,
    deleteRole,

    audit,
    auditHasMore: auditCursor !== null,
    auditLoadingMore,
    loadMoreAudit,
  };
}
