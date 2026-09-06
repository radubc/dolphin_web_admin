import "server-only";
/**
 * In-memory implementation of the admin-access repository.
 *
 * Seeded from the same catalog and system roles as
 * `docs/admin-access/admin_access.sql`, plus a handful of invented operators so
 * the User Management page has something to show. The super-admin row's
 * `cognito_sub` is `ADMIN_SUB` from the environment, so the person signing in
 * with that Cognito user is recognised as the owner; the email and name on the
 * row are filled in from their token the first time they load a page.
 *
 * State is parked on `globalThis` for the same reason the Prisma client and the
 * rate limiter are: Turbopack replaces module instances on every edit in dev,
 * and a store that reset on each save would make the page untestable.
 *
 * Everything here is scaffolding for the UI phase. The Prisma implementation
 * replaces this file wholesale; see `./repository.ts`.
 */
import { randomUUID } from "node:crypto";
import {
  AdminAccessError,
  type AdminAccessRepository,
  type LoginClaims,
} from "./repository";
import type {
  AdminAction,
  AdminPrincipal,
  AdminRole,
  AdminUser,
  AuditEvent,
  AuditPage,
  AuditTargetType,
  CreateAdminUserInput,
  CreateRoleInput,
  UpdateAdminUserInput,
  UpdateRoleInput,
} from "./types";

/* -------------------------------------------------------------------------- */
/*                                Stored shapes                               */
/* -------------------------------------------------------------------------- */

interface UserRow {
  id: string;
  cognitoSub: string;
  email: string;
  displayName: string | null;
  isSuperAdmin: boolean;
  disabledAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

interface State {
  users: UserRow[];
  roles: RoleRow[];
  actions: AdminAction[];
  /** role id → action ids */
  roleActions: Map<string, Set<string>>;
  /** user id → role ids */
  userRoles: Map<string, Set<string>>;
  /** Newest first. */
  audit: AuditEvent[];
}

/* -------------------------------------------------------------------------- */
/*                                    Seed                                    */
/* -------------------------------------------------------------------------- */

/** Same rows as the `admin_actions` seed in the SQL. */
const ACTION_SEED: ReadonlyArray<[key: string, description: string, category: string]> = [
  ["can_manage_admin_users", "Create, update, disable admin users and assign roles", "admin_access"],
  ["can_manage_roles", "Create and edit roles and their action grants", "admin_access"],
  ["can_read_admin_audit", "Read admin permission audit events", "admin_access"],
  ["can_read_user_list", "View the end-user list from the main database", "users"],
  ["can_read_user_detail", "View a single end-user record", "users"],
  ["can_write_user", "Update end-user records in the main database", "users"],
  ["can_disable_user", "Disable or soft-delete an end-user", "users"],
  ["can_read_tenant_list", "View tenants", "tenants"],
  ["can_read_tenant_detail", "View a single tenant", "tenants"],
  ["can_write_tenant", "Create or update tenants", "tenants"],
  ["can_access_tickets", "Open the support tickets area", "tickets"],
  ["can_read_tickets", "View tickets", "tickets"],
  ["can_write_tickets", "Create or update tickets", "tickets"],
  ["can_assign_tickets", "Assign tickets to agents", "tickets"],
  ["can_close_tickets", "Close or resolve tickets", "tickets"],
  ["can_read_catalogs", "View shared catalog data in the admin database", "catalogs"],
  ["can_write_catalogs", "Create or update catalog / reference data", "catalogs"],
];

/** Same rows and grants as the `admin_roles` seed in the SQL. */
const ROLE_SEED: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  actions: string[];
}> = [
  {
    key: "customer_service_agent",
    name: "Customer service agent",
    description: "Read users/tenants and work support tickets; no admin-access management.",
    actions: [
      "can_read_user_list",
      "can_read_user_detail",
      "can_read_tenant_list",
      "can_read_tenant_detail",
      "can_access_tickets",
      "can_read_tickets",
      "can_write_tickets",
      "can_assign_tickets",
      "can_close_tickets",
    ],
  },
  {
    key: "user_support_readonly",
    name: "User support (read-only)",
    description: "Read-only access to end users and tenants.",
    actions: [
      "can_read_user_list",
      "can_read_user_detail",
      "can_read_tenant_list",
      "can_read_tenant_detail",
    ],
  },
  {
    key: "catalog_editor",
    name: "Catalog editor",
    description: "Maintain shared reference data in the admin database.",
    actions: ["can_read_catalogs", "can_write_catalogs"],
  },
];

/* -------------------------------------------------------------------------- */
/*  PLACEHOLDER DATA — invented operators so the page has rows. The owner row  */
/*  is real in one respect: its sub is ADMIN_SUB. Delete with the Prisma swap. */
/* -------------------------------------------------------------------------- */

/** Days before "now", for seed timestamps that read naturally. */
function daysAgo(days: number, hours = 0): string {
  return new Date(Date.now() - (days * 24 + hours) * 60 * 60 * 1000).toISOString();
}

interface UserSeed {
  email: string;
  displayName: string | null;
  isSuperAdmin?: boolean;
  disabledDaysAgo?: number | null;
  lastLoginDaysAgo?: number | null;
  createdDaysAgo: number;
  roles: string[];
}

const USER_SEED: readonly UserSeed[] = [
  {
    email: "owner@pennysqueeze.local",
    displayName: null,
    isSuperAdmin: true,
    lastLoginDaysAgo: 0,
    createdDaysAgo: 120,
    roles: [],
  },
  {
    email: "maya.chen@pennysqueeze.local",
    displayName: "Maya Chen",
    isSuperAdmin: true,
    lastLoginDaysAgo: 2,
    createdDaysAgo: 96,
    roles: [],
  },
  {
    email: "jordan.okafor@pennysqueeze.local",
    displayName: "Jordan Okafor",
    lastLoginDaysAgo: 0,
    createdDaysAgo: 61,
    roles: ["customer_service_agent"],
  },
  {
    email: "priya.natarajan@pennysqueeze.local",
    displayName: "Priya Natarajan",
    lastLoginDaysAgo: 1,
    createdDaysAgo: 45,
    roles: ["customer_service_agent", "catalog_editor"],
  },
  {
    email: "sam.lefebvre@pennysqueeze.local",
    displayName: "Sam Lefebvre",
    lastLoginDaysAgo: 5,
    createdDaysAgo: 30,
    roles: ["user_support_readonly"],
  },
  {
    email: "alex.dubois@pennysqueeze.local",
    displayName: "Alex Dubois",
    lastLoginDaysAgo: 12,
    createdDaysAgo: 28,
    roles: ["catalog_editor"],
  },
  {
    email: "taylor.brooks@pennysqueeze.local",
    displayName: "Taylor Brooks",
    lastLoginDaysAgo: null,
    createdDaysAgo: 3,
    roles: ["user_support_readonly"],
  },
  {
    email: "former.agent@pennysqueeze.local",
    displayName: "Riley Nguyen",
    disabledDaysAgo: 14,
    lastLoginDaysAgo: 20,
    createdDaysAgo: 88,
    roles: ["customer_service_agent"],
  },
];
/* ----------------------------- end placeholders ---------------------------- */

function seed(): State {
  const actions: AdminAction[] = ACTION_SEED.map(([key, description, category]) => ({
    id: randomUUID(),
    key,
    description,
    category,
  }));
  const actionIdByKey = new Map(actions.map((action) => [action.key, action.id]));

  const roles: RoleRow[] = [];
  const roleActions = new Map<string, Set<string>>();
  for (const entry of ROLE_SEED) {
    const role: RoleRow = {
      id: randomUUID(),
      key: entry.key,
      name: entry.name,
      description: entry.description,
      isSystem: true,
      createdAt: daysAgo(120),
      updatedAt: daysAgo(120),
    };
    roles.push(role);
    roleActions.set(
      role.id,
      new Set(entry.actions.map((key) => actionIdByKey.get(key)).filter((id): id is string => !!id)),
    );
  }
  const roleIdByKey = new Map(roles.map((role) => [role.key, role.id]));

  const users: UserRow[] = [];
  const userRoles = new Map<string, Set<string>>();
  const ownerSub = process.env.ADMIN_SUB?.trim() || `mock-owner-${randomUUID()}`;
  USER_SEED.forEach((entry, index) => {
    const user: UserRow = {
      id: randomUUID(),
      cognitoSub: index === 0 ? ownerSub : `mock-sub-${randomUUID()}`,
      email: entry.email,
      displayName: entry.displayName,
      isSuperAdmin: entry.isSuperAdmin ?? false,
      disabledAt: entry.disabledDaysAgo == null ? null : daysAgo(entry.disabledDaysAgo),
      lastLoginAt: entry.lastLoginDaysAgo == null ? null : daysAgo(entry.lastLoginDaysAgo, 3),
      createdAt: daysAgo(entry.createdDaysAgo),
      updatedAt: daysAgo(Math.min(entry.createdDaysAgo, entry.disabledDaysAgo ?? entry.createdDaysAgo)),
    };
    users.push(user);
    userRoles.set(
      user.id,
      new Set(entry.roles.map((key) => roleIdByKey.get(key)).filter((id): id is string => !!id)),
    );
  });

  // A few audit rows so the log is not empty on first load.
  const owner = users[0];
  const audit: AuditEvent[] = ([
    {
      id: randomUUID(),
      actorUserId: owner.id,
      actorEmail: owner.email,
      action: "admin_user_disabled",
      targetType: "admin_user",
      targetId: users[7].id,
      targetLabel: users[7].email,
      metadata: {},
      createdAt: daysAgo(14),
    },
    {
      id: randomUUID(),
      actorUserId: users[1].id,
      actorEmail: users[1].email,
      action: "admin_user_created",
      targetType: "admin_user",
      targetId: users[6].id,
      targetLabel: users[6].email,
      metadata: { roleKeys: ["user_support_readonly"] },
      createdAt: daysAgo(3),
    },
    {
      id: randomUUID(),
      actorUserId: owner.id,
      actorEmail: owner.email,
      action: "role_assigned",
      targetType: "admin_user_role",
      targetId: users[3].id,
      targetLabel: users[3].email,
      metadata: { roleKey: "catalog_editor" },
      createdAt: daysAgo(1, 4),
    },
  ] satisfies AuditEvent[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { users, roles, actions, roleActions, userRoles, audit };
}

/* -------------------------------------------------------------------------- */
/*                                 Validation                                 */
/* -------------------------------------------------------------------------- */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 500;

function normaliseEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (value.length === 0 || value.length > 320 || !EMAIL_PATTERN.test(value)) {
    throw new AdminAccessError("invalid", "Enter a valid email address.");
  }
  return value;
}

function normaliseName(value: string | null | undefined, label: string, required: boolean): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    if (required) throw new AdminAccessError("invalid", `${label} is required.`);
    return null;
  }
  if (trimmed.length > MAX_NAME) {
    throw new AdminAccessError("invalid", `${label} is too long.`);
  }
  return trimmed;
}

function normaliseDescription(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > MAX_DESCRIPTION) {
    throw new AdminAccessError("invalid", "Description is too long.");
  }
  return trimmed.length === 0 ? null : trimmed;
}

/* -------------------------------------------------------------------------- */
/*                                 Repository                                 */
/* -------------------------------------------------------------------------- */

/** How often `recordLogin` is allowed to touch a row: once a minute is plenty. */
const LOGIN_TOUCH_INTERVAL_MS = 60_000;

class MemoryAdminAccessRepository implements AdminAccessRepository {
  private readonly state: State;

  constructor(state: State) {
    this.state = state;
  }

  /* ------------------------------- lookups ------------------------------ */

  private userRow(id: string): UserRow {
    const row = this.state.users.find((user) => user.id === id);
    if (!row) throw new AdminAccessError("not_found", "That admin user no longer exists.");
    return row;
  }

  private roleRow(id: string): RoleRow {
    const row = this.state.roles.find((role) => role.id === id);
    if (!row) throw new AdminAccessError("not_found", "That role no longer exists.");
    return row;
  }

  private roleKeysOf(userId: string): string[] {
    const ids = this.state.userRoles.get(userId) ?? new Set<string>();
    return this.state.roles
      .filter((role) => ids.has(role.id))
      .map((role) => role.key)
      .sort();
  }

  private actionKeysOf(roleId: string): string[] {
    const ids = this.state.roleActions.get(roleId) ?? new Set<string>();
    return this.state.actions
      .filter((action) => ids.has(action.id))
      .map((action) => action.key)
      .sort();
  }

  private effectiveActions(userId: string): string[] {
    const keys = new Set<string>();
    for (const roleId of this.state.userRoles.get(userId) ?? []) {
      for (const key of this.actionKeysOf(roleId)) keys.add(key);
    }
    return [...keys].sort();
  }

  private toUser(row: UserRow): AdminUser {
    return { ...row, roleKeys: this.roleKeysOf(row.id) };
  }

  private toRole(row: RoleRow): AdminRole {
    let memberCount = 0;
    for (const user of this.state.users) {
      if (user.disabledAt === null && this.state.userRoles.get(user.id)?.has(row.id)) {
        memberCount += 1;
      }
    }
    return { ...row, actionKeys: this.actionKeysOf(row.id), memberCount };
  }

  /** Resolves role keys to ids, refusing any key that is not a role. */
  private roleIdsFor(keys: readonly string[]): Set<string> {
    const ids = new Set<string>();
    for (const key of new Set(keys)) {
      const role = this.state.roles.find((candidate) => candidate.key === key);
      if (!role) throw new AdminAccessError("invalid", `Unknown role “${key}”.`);
      ids.add(role.id);
    }
    return ids;
  }

  private actionIdsFor(keys: readonly string[]): Set<string> {
    const ids = new Set<string>();
    for (const key of new Set(keys)) {
      const action = this.state.actions.find((candidate) => candidate.key === key);
      if (!action) throw new AdminAccessError("invalid", `Unknown action “${key}”.`);
      ids.add(action.id);
    }
    return ids;
  }

  private enabledSuperAdmins(): UserRow[] {
    return this.state.users.filter((user) => user.isSuperAdmin && user.disabledAt === null);
  }

  private record(
    actorId: string | null,
    action: string,
    targetType: AuditTargetType,
    targetId: string | null,
    targetLabel: string | null,
    metadata: Record<string, unknown> = {},
  ): void {
    const actor = actorId ? this.state.users.find((user) => user.id === actorId) : undefined;
    this.state.audit.unshift({
      id: randomUUID(),
      actorUserId: actorId,
      actorEmail: actor?.email ?? null,
      action,
      targetType,
      targetId,
      targetLabel,
      metadata,
      createdAt: new Date().toISOString(),
    });
  }

  /* ------------------------------ principal ----------------------------- */

  async findPrincipalBySub(cognitoSub: string): Promise<AdminPrincipal | null> {
    const row = this.state.users.find((user) => user.cognitoSub === cognitoSub);
    if (!row || row.disabledAt !== null) return null;
    return {
      user: this.toUser(row),
      isSuperAdmin: row.isSuperAdmin,
      actions: this.effectiveActions(row.id),
    };
  }

  async recordLogin(userId: string, claims: LoginClaims): Promise<void> {
    const row = this.state.users.find((user) => user.id === userId);
    if (!row) return;
    const now = Date.now();
    const last = row.lastLoginAt ? Date.parse(row.lastLoginAt) : 0;
    if (now - last < LOGIN_TOUCH_INTERVAL_MS) return;
    row.lastLoginAt = new Date(now).toISOString();
    // The seed knows the owner's sub but not their address; the token does.
    if (claims.email && row.email.endsWith("@pennysqueeze.local")) {
      const email = claims.email.toLowerCase();
      if (!this.state.users.some((user) => user.id !== row.id && user.email === email)) {
        row.email = email;
      }
    }
    if (claims.name && row.displayName === null) {
      row.displayName = claims.name;
    }
  }

  /* -------------------------------- users ------------------------------- */

  async listUsers(): Promise<AdminUser[]> {
    return this.state.users
      .map((row) => this.toUser(row))
      .sort((a, b) => a.email.localeCompare(b.email, "en-CA"));
  }

  async getUser(id: string): Promise<AdminUser | null> {
    const row = this.state.users.find((user) => user.id === id);
    return row ? this.toUser(row) : null;
  }

  async createUser(input: CreateAdminUserInput, actorId: string): Promise<AdminUser> {
    const email = normaliseEmail(input.email);
    if (this.state.users.some((user) => user.email === email)) {
      throw new AdminAccessError("conflict", "An admin user with this email already exists.");
    }
    const displayName = normaliseName(input.displayName, "Display name", false);
    const roleIds = this.roleIdsFor(input.roleKeys);

    const now = new Date().toISOString();
    const row: UserRow = {
      id: randomUUID(),
      // The real implementation creates the Cognito user (AdminCreateUser) and
      // stores the sub it returns; the mock invents one.
      cognitoSub: `mock-sub-${randomUUID()}`,
      email,
      displayName,
      isSuperAdmin: input.isSuperAdmin,
      disabledAt: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.users.push(row);
    this.state.userRoles.set(row.id, roleIds);

    this.record(actorId, "admin_user_created", "admin_user", row.id, row.email, {
      roleKeys: this.roleKeysOf(row.id),
      isSuperAdmin: row.isSuperAdmin,
    });
    return this.toUser(row);
  }

  async updateUser(id: string, input: UpdateAdminUserInput, actorId: string): Promise<AdminUser> {
    const row = this.userRow(id);
    const self = row.id === actorId;
    const before = this.toUser(row);

    if (input.displayName !== undefined) {
      row.displayName = normaliseName(input.displayName, "Display name", false);
    }

    if (input.isSuperAdmin !== undefined && input.isSuperAdmin !== row.isSuperAdmin) {
      if (!input.isSuperAdmin) {
        if (self) {
          throw new AdminAccessError("conflict", "You cannot remove your own super-admin access.");
        }
        if (row.disabledAt === null && this.enabledSuperAdmins().length <= 1) {
          throw new AdminAccessError("conflict", "At least one enabled super-admin must remain.");
        }
      }
      row.isSuperAdmin = input.isSuperAdmin;
      this.record(
        actorId,
        input.isSuperAdmin ? "super_admin_granted" : "super_admin_revoked",
        "admin_user",
        row.id,
        row.email,
      );
    }

    if (input.roleKeys !== undefined) {
      const next = this.roleIdsFor(input.roleKeys);
      const current = this.state.userRoles.get(row.id) ?? new Set<string>();
      for (const roleId of next) {
        if (!current.has(roleId)) {
          this.record(actorId, "role_assigned", "admin_user_role", row.id, row.email, {
            roleKey: this.roleRow(roleId).key,
          });
        }
      }
      for (const roleId of current) {
        if (!next.has(roleId)) {
          this.record(actorId, "role_revoked", "admin_user_role", row.id, row.email, {
            roleKey: this.roleRow(roleId).key,
          });
        }
      }
      this.state.userRoles.set(row.id, next);
    }

    if (input.disabled !== undefined) {
      const currentlyDisabled = row.disabledAt !== null;
      if (input.disabled && !currentlyDisabled) {
        if (self) {
          throw new AdminAccessError("conflict", "You cannot disable your own account.");
        }
        if (row.isSuperAdmin && this.enabledSuperAdmins().length <= 1) {
          throw new AdminAccessError("conflict", "At least one enabled super-admin must remain.");
        }
        row.disabledAt = new Date().toISOString();
        this.record(actorId, "admin_user_disabled", "admin_user", row.id, row.email);
      } else if (!input.disabled && currentlyDisabled) {
        row.disabledAt = null;
        this.record(actorId, "admin_user_enabled", "admin_user", row.id, row.email);
      }
    }

    row.updatedAt = new Date().toISOString();
    const after = this.toUser(row);
    if (before.displayName !== after.displayName) {
      this.record(actorId, "admin_user_updated", "admin_user", row.id, row.email, {
        displayName: after.displayName,
      });
    }
    return after;
  }

  /* -------------------------------- roles ------------------------------- */

  async listRoles(): Promise<AdminRole[]> {
    return this.state.roles
      .map((row) => this.toRole(row))
      .sort((a, b) => a.name.localeCompare(b.name, "en-CA"));
  }

  async getRole(id: string): Promise<AdminRole | null> {
    const row = this.state.roles.find((role) => role.id === id);
    return row ? this.toRole(row) : null;
  }

  async createRole(input: CreateRoleInput, actorId: string): Promise<AdminRole> {
    const key = input.key.trim();
    if (!KEY_PATTERN.test(key) || key.length > 64) {
      throw new AdminAccessError(
        "invalid",
        "Role key must be snake_case: lowercase letters, digits and underscores, starting with a letter.",
      );
    }
    if (this.state.roles.some((role) => role.key === key)) {
      throw new AdminAccessError("conflict", "A role with this key already exists.");
    }
    const name = normaliseName(input.name, "Role name", true)!;
    const description = normaliseDescription(input.description);
    const actionIds = this.actionIdsFor(input.actionKeys);

    const now = new Date().toISOString();
    const row: RoleRow = {
      id: randomUUID(),
      key,
      name,
      description,
      isSystem: false,
      createdAt: now,
      updatedAt: now,
    };
    this.state.roles.push(row);
    this.state.roleActions.set(row.id, actionIds);
    this.record(actorId, "role_created", "admin_role", row.id, row.name, {
      key,
      actionKeys: this.actionKeysOf(row.id),
    });
    return this.toRole(row);
  }

  async updateRole(id: string, input: UpdateRoleInput, actorId: string): Promise<AdminRole> {
    const row = this.roleRow(id);
    if (input.name !== undefined) {
      row.name = normaliseName(input.name, "Role name", true)!;
    }
    if (input.description !== undefined) {
      row.description = normaliseDescription(input.description);
    }
    if (input.actionKeys !== undefined) {
      const next = this.actionIdsFor(input.actionKeys);
      const current = this.state.roleActions.get(row.id) ?? new Set<string>();
      const granted: string[] = [];
      const revoked: string[] = [];
      for (const action of this.state.actions) {
        if (next.has(action.id) && !current.has(action.id)) granted.push(action.key);
        if (!next.has(action.id) && current.has(action.id)) revoked.push(action.key);
      }
      this.state.roleActions.set(row.id, next);
      if (granted.length > 0) {
        this.record(actorId, "action_granted", "admin_role_action", row.id, row.name, {
          actionKeys: granted,
        });
      }
      if (revoked.length > 0) {
        this.record(actorId, "action_revoked", "admin_role_action", row.id, row.name, {
          actionKeys: revoked,
        });
      }
    }
    row.updatedAt = new Date().toISOString();
    if (input.name !== undefined || input.description !== undefined) {
      this.record(actorId, "role_updated", "admin_role", row.id, row.name);
    }
    return this.toRole(row);
  }

  async deleteRole(id: string, actorId: string): Promise<void> {
    const row = this.roleRow(id);
    if (row.isSystem) {
      throw new AdminAccessError("conflict", "System roles cannot be deleted.");
    }
    const holders = this.toRole(row).memberCount;
    if (holders > 0) {
      throw new AdminAccessError(
        "conflict",
        `Remove this role from its ${holders === 1 ? "member" : `${holders} members`} first.`,
      );
    }
    this.state.roles = this.state.roles.filter((role) => role.id !== id);
    this.state.roleActions.delete(id);
    for (const roles of this.state.userRoles.values()) roles.delete(id);
    this.record(actorId, "role_deleted", "admin_role", row.id, row.name, { key: row.key });
  }

  /* ------------------------------- catalog ------------------------------ */

  async listActions(): Promise<AdminAction[]> {
    return [...this.state.actions];
  }

  /* -------------------------------- audit ------------------------------- */

  async listAuditEvents(options: { limit: number; cursor?: string | null }): Promise<AuditPage> {
    const limit = Math.max(1, Math.min(200, options.limit));
    // The cursor is the `createdAt` of the last event on the previous page;
    // events are newest first, so the next page is everything older.
    const cursor = options.cursor ?? null;
    const source = cursor
      ? this.state.audit.filter((event) => event.createdAt < cursor)
      : this.state.audit;
    const events = source.slice(0, limit);
    const nextCursor = source.length > limit ? events[events.length - 1].createdAt : null;
    return { events, nextCursor };
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Singleton                                 */
/* -------------------------------------------------------------------------- */

const globalForAdminAccess = globalThis as unknown as {
  pennySqueezeAdminAccessState?: State;
};

export function getMemoryAdminAccessRepository(): AdminAccessRepository {
  globalForAdminAccess.pennySqueezeAdminAccessState ??= seed();
  return new MemoryAdminAccessRepository(globalForAdminAccess.pennySqueezeAdminAccessState);
}
