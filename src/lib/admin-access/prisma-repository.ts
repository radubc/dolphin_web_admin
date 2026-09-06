import "server-only";
/**
 * The admin-access repository over the admin database (`ADMIN_DATABASE_URL`)
 * through the `prismaAdmin` client.
 *
 * Maps one-to-one onto the tables created by `docs/sql/001_admin_access.sql`
 * and `002_access_map_and_services.sql`. Business rules (uniqueness, unknown
 * keys, lockouts, system roles) are enforced here, in transactions, so they
 * hold whoever calls; each violation is thrown as `AdminAccessError` and the
 * handler wrapper turns it into 409 / 422 / 404.
 *
 * Audit rows: `target_label` (an email or a role name at the time of the
 * change) is kept inside `metadata`, since the table has no column for it.
 */
import { Prisma } from "@/generated/prisma-admin/client";
import { prismaAdmin } from "@/lib/prisma-admin";
import { endpointRegistryEntry } from "./endpoint-registry";
import {
  mergeEndpointRules,
  mergePageRules,
  type StoredEndpointRule,
  type StoredPageRule,
} from "./merge-rules";
import { pageRegistryEntry } from "./page-registry";
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
  EndpointAuthKind,
  EndpointRule,
  EndpointUsageSummary,
  PageKind,
  PageRule,
  UpdateAdminUserInput,
  UpdateRoleInput,
  UpsertEndpointRuleInput,
  UpsertPageRuleInput,
  UsageHit,
} from "./types";

type Tx = Prisma.TransactionClient;

/* -------------------------------------------------------------------------- */
/*                                 Validation                                 */
/* -------------------------------------------------------------------------- */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

function normaliseEmail(email: string): string {
  const value = email.trim().toLowerCase();
  if (value.length === 0 || value.length > 320 || !EMAIL_PATTERN.test(value)) {
    throw new AdminAccessError("invalid", "Enter a valid email address.");
  }
  return value;
}

function normaliseText(
  value: string | null | undefined,
  label: string,
  max: number,
  required: boolean,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    if (required) throw new AdminAccessError("invalid", `${label} is required.`);
    return null;
  }
  if (trimmed.length > max) throw new AdminAccessError("invalid", `${label} is too long.`);
  return trimmed;
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null);

/** Postgres "relation does not exist": the SQL in docs/sql has not been run. */
export function isMissingTableError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021";
}

/* -------------------------------------------------------------------------- */
/*                                   Mapping                                  */
/* -------------------------------------------------------------------------- */

const userInclude = {
  admin_user_roles: { include: { admin_roles: { select: { key: true } } } },
} satisfies Prisma.admin_usersInclude;

type UserRow = Prisma.admin_usersGetPayload<{ include: typeof userInclude }>;

function toUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    cognitoSub: row.cognito_sub,
    email: row.email,
    displayName: row.display_name,
    isSuperAdmin: row.is_super_admin,
    disabledAt: iso(row.disabled_at),
    lastLoginAt: iso(row.last_login_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    roleKeys: row.admin_user_roles.map((link) => link.admin_roles.key).sort(),
  };
}

const roleInclude = {
  admin_role_actions: { include: { admin_actions: { select: { key: true } } } },
  admin_user_roles: { include: { admin_users: { select: { disabled_at: true } } } },
} satisfies Prisma.admin_rolesInclude;

type RoleRow = Prisma.admin_rolesGetPayload<{ include: typeof roleInclude }>;

function toRole(row: RoleRow): AdminRole {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    actionKeys: row.admin_role_actions.map((link) => link.admin_actions.key).sort(),
    memberCount: row.admin_user_roles.filter((link) => link.admin_users.disabled_at === null).length,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toAction(row: { id: string; key: string; description: string; category: string }): AdminAction {
  return { id: row.id, key: row.key, description: row.description, category: row.category };
}

/* -------------------------------------------------------------------------- */
/*                                 Repository                                 */
/* -------------------------------------------------------------------------- */

/** How often `recordLogin` is allowed to touch a row: once a minute is plenty. */
const LOGIN_TOUCH_INTERVAL_MS = 60_000;

class PrismaAdminAccessRepository implements AdminAccessRepository {
  /* ------------------------------- helpers ------------------------------ */

  private async actionIdsFor(tx: Tx, keys: readonly string[]): Promise<string[]> {
    const wanted = [...new Set(keys)];
    if (wanted.length === 0) return [];
    const rows = await tx.admin_actions.findMany({ where: { key: { in: wanted } }, select: { id: true, key: true } });
    const missing = wanted.filter((key) => !rows.some((row) => row.key === key));
    if (missing.length > 0) {
      throw new AdminAccessError("invalid", `Unknown action “${missing[0]}”.`);
    }
    return rows.map((row) => row.id);
  }

  private async roleIdsFor(tx: Tx, keys: readonly string[]): Promise<{ id: string; key: string }[]> {
    const wanted = [...new Set(keys)];
    if (wanted.length === 0) return [];
    const rows = await tx.admin_roles.findMany({ where: { key: { in: wanted } }, select: { id: true, key: true } });
    const missing = wanted.filter((key) => !rows.some((row) => row.key === key));
    if (missing.length > 0) {
      throw new AdminAccessError("invalid", `Unknown role “${missing[0]}”.`);
    }
    return rows;
  }

  private async record(
    tx: Tx,
    actorId: string | null,
    action: string,
    targetType: AuditTargetType,
    targetId: string | null,
    targetLabel: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.admin_permission_audit_events.create({
      data: {
        actor_user_id: actorId,
        action,
        target_type: targetType,
        target_id: targetId,
        metadata: { ...metadata, target_label: targetLabel } as Prisma.InputJsonObject,
      },
    });
  }

  private async enabledSuperAdminCount(tx: Tx): Promise<number> {
    return tx.admin_users.count({ where: { is_super_admin: true, disabled_at: null } });
  }

  private async effectiveActions(userId: string): Promise<string[]> {
    const rows = await prismaAdmin.admin_role_actions.findMany({
      where: { admin_roles: { admin_user_roles: { some: { user_id: userId } } } },
      select: { admin_actions: { select: { key: true } } },
    });
    return [...new Set(rows.map((row) => row.admin_actions.key))].sort();
  }

  /* ------------------------------ principal ----------------------------- */

  async findPrincipalBySub(cognitoSub: string): Promise<AdminPrincipal | null> {
    const row = await prismaAdmin.admin_users.findUnique({
      where: { cognito_sub: cognitoSub },
      include: userInclude,
    });
    if (!row || row.disabled_at !== null) return null;
    return {
      user: toUser(row),
      isSuperAdmin: row.is_super_admin,
      actions: await this.effectiveActions(row.id),
    };
  }

  async recordLogin(userId: string, claims: LoginClaims): Promise<void> {
    const row = await prismaAdmin.admin_users.findUnique({
      where: { id: userId },
      select: { last_login_at: true, display_name: true },
    });
    if (!row) return;
    const now = Date.now();
    if (row.last_login_at && now - row.last_login_at.getTime() < LOGIN_TOUCH_INTERVAL_MS) return;
    await prismaAdmin.admin_users.update({
      where: { id: userId },
      data: {
        last_login_at: new Date(now),
        // The bootstrap row may carry a placeholder name; the token's is better.
        ...(claims.name && row.display_name === null ? { display_name: claims.name } : {}),
      },
    });
  }

  /* -------------------------------- users ------------------------------- */

  async listUsers(): Promise<AdminUser[]> {
    const rows = await prismaAdmin.admin_users.findMany({ include: userInclude, orderBy: { email: "asc" } });
    return rows.map(toUser);
  }

  async getUser(id: string): Promise<AdminUser | null> {
    const row = await prismaAdmin.admin_users.findUnique({ where: { id }, include: userInclude });
    return row ? toUser(row) : null;
  }

  async createUser(input: CreateAdminUserInput, actorId: string): Promise<AdminUser> {
    const email = normaliseEmail(input.email);
    const displayName = normaliseText(input.displayName, "Display name", 120, false);

    return prismaAdmin.$transaction(async (tx) => {
      if (await tx.admin_users.findUnique({ where: { email }, select: { id: true } })) {
        throw new AdminAccessError("conflict", "An admin user with this email already exists.");
      }
      const roles = await this.roleIdsFor(tx, input.roleKeys);
      const row = await tx.admin_users.create({
        data: {
          // The Cognito user is created by the invitation step (AdminCreateUser)
          // once that is wired; until then the sub is a placeholder that no
          // token can ever carry, so the row cannot be used to sign in.
          cognito_sub: `pending-${crypto.randomUUID()}`,
          email,
          display_name: displayName,
          is_super_admin: input.isSuperAdmin,
          created_by: actorId,
          updated_by: actorId,
          admin_user_roles: {
            create: roles.map((role) => ({ role_id: role.id, created_by: actorId })),
          },
        },
        include: userInclude,
      });
      await this.record(tx, actorId, "admin_user_created", "admin_user", row.id, row.email, {
        roleKeys: roles.map((role) => role.key).sort(),
        isSuperAdmin: row.is_super_admin,
      });
      return toUser(row);
    });
  }

  async updateUser(id: string, input: UpdateAdminUserInput, actorId: string): Promise<AdminUser> {
    return prismaAdmin.$transaction(async (tx) => {
      const row = await tx.admin_users.findUnique({ where: { id }, include: userInclude });
      if (!row) throw new AdminAccessError("not_found", "That admin user no longer exists.");
      const self = row.id === actorId;
      // Unchecked: `updated_by` is written as the scalar FK, not through the
      // self-relation `db pull` generated for it.
      const data: Prisma.admin_usersUncheckedUpdateInput = { updated_at: new Date(), updated_by: actorId };

      if (input.displayName !== undefined) {
        const displayName = normaliseText(input.displayName, "Display name", 120, false);
        if (displayName !== row.display_name) {
          data.display_name = displayName;
          await this.record(tx, actorId, "admin_user_updated", "admin_user", row.id, row.email, { displayName });
        }
      }

      if (input.isSuperAdmin !== undefined && input.isSuperAdmin !== row.is_super_admin) {
        if (!input.isSuperAdmin) {
          if (self) throw new AdminAccessError("conflict", "You cannot remove your own super-admin access.");
          if (row.disabled_at === null && (await this.enabledSuperAdminCount(tx)) <= 1) {
            throw new AdminAccessError("conflict", "At least one enabled super-admin must remain.");
          }
        }
        data.is_super_admin = input.isSuperAdmin;
        await this.record(
          tx,
          actorId,
          input.isSuperAdmin ? "super_admin_granted" : "super_admin_revoked",
          "admin_user",
          row.id,
          row.email,
        );
      }

      if (input.roleKeys !== undefined) {
        const next = await this.roleIdsFor(tx, input.roleKeys);
        const currentIds = new Set(row.admin_user_roles.map((link) => link.role_id));
        const nextIds = new Set(next.map((role) => role.id));
        for (const role of next) {
          if (!currentIds.has(role.id)) {
            await tx.admin_user_roles.create({ data: { user_id: row.id, role_id: role.id, created_by: actorId } });
            await this.record(tx, actorId, "role_assigned", "admin_user_role", row.id, row.email, { roleKey: role.key });
          }
        }
        for (const link of row.admin_user_roles) {
          if (!nextIds.has(link.role_id)) {
            await tx.admin_user_roles.delete({ where: { id: link.id } });
            await this.record(tx, actorId, "role_revoked", "admin_user_role", row.id, row.email, {
              roleKey: link.admin_roles.key,
            });
          }
        }
      }

      if (input.disabled !== undefined) {
        const currentlyDisabled = row.disabled_at !== null;
        if (input.disabled && !currentlyDisabled) {
          if (self) throw new AdminAccessError("conflict", "You cannot disable your own account.");
          if (row.is_super_admin && (await this.enabledSuperAdminCount(tx)) <= 1) {
            throw new AdminAccessError("conflict", "At least one enabled super-admin must remain.");
          }
          data.disabled_at = new Date();
          await this.record(tx, actorId, "admin_user_disabled", "admin_user", row.id, row.email);
        } else if (!input.disabled && currentlyDisabled) {
          data.disabled_at = null;
          await this.record(tx, actorId, "admin_user_enabled", "admin_user", row.id, row.email);
        }
      }

      const updated = await tx.admin_users.update({ where: { id }, data, include: userInclude });
      return toUser(updated);
    });
  }

  /* -------------------------------- roles ------------------------------- */

  async listRoles(): Promise<AdminRole[]> {
    const rows = await prismaAdmin.admin_roles.findMany({ include: roleInclude, orderBy: { name: "asc" } });
    return rows.map(toRole);
  }

  async getRole(id: string): Promise<AdminRole | null> {
    const row = await prismaAdmin.admin_roles.findUnique({ where: { id }, include: roleInclude });
    return row ? toRole(row) : null;
  }

  async createRole(input: CreateRoleInput, actorId: string): Promise<AdminRole> {
    const key = input.key.trim();
    if (!KEY_PATTERN.test(key) || key.length > 64) {
      throw new AdminAccessError(
        "invalid",
        "Role key must be snake_case: lowercase letters, digits and underscores, starting with a letter.",
      );
    }
    const name = normaliseText(input.name, "Role name", 120, true)!;
    const description = normaliseText(input.description, "Description", 500, false);

    return prismaAdmin.$transaction(async (tx) => {
      if (await tx.admin_roles.findUnique({ where: { key }, select: { id: true } })) {
        throw new AdminAccessError("conflict", "A role with this key already exists.");
      }
      const actionIds = await this.actionIdsFor(tx, input.actionKeys);
      const row = await tx.admin_roles.create({
        data: {
          key,
          name,
          description,
          created_by: actorId,
          updated_by: actorId,
          admin_role_actions: { create: actionIds.map((action_id) => ({ action_id, created_by: actorId })) },
        },
        include: roleInclude,
      });
      const role = toRole(row);
      await this.record(tx, actorId, "role_created", "admin_role", row.id, row.name, { key, actionKeys: role.actionKeys });
      return role;
    });
  }

  async updateRole(id: string, input: UpdateRoleInput, actorId: string): Promise<AdminRole> {
    return prismaAdmin.$transaction(async (tx) => {
      const row = await tx.admin_roles.findUnique({ where: { id }, include: roleInclude });
      if (!row) throw new AdminAccessError("not_found", "That role no longer exists.");
      const data: Prisma.admin_rolesUncheckedUpdateInput = { updated_at: new Date(), updated_by: actorId };
      let described = false;

      if (input.name !== undefined) {
        data.name = normaliseText(input.name, "Role name", 120, true)!;
        described = true;
      }
      if (input.description !== undefined) {
        data.description = normaliseText(input.description, "Description", 500, false);
        described = true;
      }
      if (input.actionKeys !== undefined) {
        const nextIds = new Set(await this.actionIdsFor(tx, input.actionKeys));
        const current = new Map(row.admin_role_actions.map((link) => [link.action_id, link]));
        const granted: string[] = [];
        const revoked: string[] = [];
        const catalog = await tx.admin_actions.findMany({ select: { id: true, key: true } });
        const keyOf = new Map(catalog.map((action) => [action.id, action.key]));
        for (const actionId of nextIds) {
          if (!current.has(actionId)) {
            await tx.admin_role_actions.create({ data: { role_id: row.id, action_id: actionId, created_by: actorId } });
            granted.push(keyOf.get(actionId) ?? actionId);
          }
        }
        for (const [actionId, link] of current) {
          if (!nextIds.has(actionId)) {
            await tx.admin_role_actions.delete({ where: { id: link.id } });
            revoked.push(link.admin_actions.key);
          }
        }
        if (granted.length > 0) {
          await this.record(tx, actorId, "action_granted", "admin_role_action", row.id, row.name, { actionKeys: granted.sort() });
        }
        if (revoked.length > 0) {
          await this.record(tx, actorId, "action_revoked", "admin_role_action", row.id, row.name, { actionKeys: revoked.sort() });
        }
      }
      if (described) {
        await this.record(tx, actorId, "role_updated", "admin_role", row.id, (data.name as string | undefined) ?? row.name);
      }
      const updated = await tx.admin_roles.update({ where: { id }, data, include: roleInclude });
      return toRole(updated);
    });
  }

  async deleteRole(id: string, actorId: string): Promise<void> {
    await prismaAdmin.$transaction(async (tx) => {
      const row = await tx.admin_roles.findUnique({ where: { id }, include: roleInclude });
      if (!row) throw new AdminAccessError("not_found", "That role no longer exists.");
      if (row.is_system) throw new AdminAccessError("conflict", "System roles cannot be deleted.");
      const holders = toRole(row).memberCount;
      if (holders > 0) {
        throw new AdminAccessError(
          "conflict",
          `Remove this role from its ${holders === 1 ? "member" : `${holders} members`} first.`,
        );
      }
      await tx.admin_roles.delete({ where: { id } });
      await this.record(tx, actorId, "role_deleted", "admin_role", row.id, row.name, { key: row.key });
    });
  }

  /* ------------------------------- catalog ------------------------------ */

  async listActions(): Promise<AdminAction[]> {
    const rows = await prismaAdmin.admin_actions.findMany({ orderBy: [{ category: "asc" }, { key: "asc" }] });
    return rows.map(toAction);
  }

  /* -------------------------------- audit ------------------------------- */

  async listAuditEvents(options: { limit: number; cursor?: string | null }): Promise<AuditPage> {
    const limit = Math.max(1, Math.min(200, options.limit));
    const cursorDate = options.cursor ? new Date(options.cursor) : null;
    const rows = await prismaAdmin.admin_permission_audit_events.findMany({
      where: cursorDate && !Number.isNaN(cursorDate.getTime()) ? { created_at: { lt: cursorDate } } : undefined,
      orderBy: { created_at: "desc" },
      take: limit + 1,
      include: { admin_users: { select: { email: true } } },
    });
    const page = rows.slice(0, limit);
    const events: AuditEvent[] = page.map((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const { target_label: targetLabel, ...rest } = metadata;
      return {
        id: row.id,
        actorUserId: row.actor_user_id,
        actorEmail: row.admin_users?.email ?? null,
        action: row.action,
        targetType: row.target_type as AuditTargetType,
        targetId: row.target_id,
        targetLabel: typeof targetLabel === "string" ? targetLabel : null,
        metadata: rest,
        createdAt: row.created_at.toISOString(),
      };
    });
    return {
      events,
      nextCursor: rows.length > limit ? page[page.length - 1].created_at.toISOString() : null,
    };
  }

  /* ----------------------------- access map ----------------------------- */

  private async storedPageRules(where?: Prisma.admin_pagesWhereInput): Promise<StoredPageRule[]> {
    const rows = await prismaAdmin.admin_pages.findMany({
      where,
      include: { admin_page_actions: { include: { admin_actions: { select: { key: true } } } } },
    });
    return rows.map((row) => ({
      key: row.key,
      kind: row.kind as PageKind,
      path: row.path,
      name: row.name,
      description: row.description,
      navOrder: row.nav_order,
      isEnabled: row.is_enabled,
      requireSuperAdmin: row.require_super_admin,
      actionKeys: row.admin_page_actions.map((link) => link.admin_actions.key).sort(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async listPageRules(): Promise<PageRule[]> {
    return mergePageRules(await this.storedPageRules());
  }

  async getPageRule(key: string): Promise<PageRule | null> {
    const rows = await this.storedPageRules({ key });
    return rows.length === 0 ? null : (mergePageRules(rows).find((rule) => rule.key === key) ?? null);
  }

  async upsertPageRule(key: string, input: UpsertPageRuleInput, actorId: string): Promise<PageRule> {
    const entry = pageRegistryEntry(key);
    return prismaAdmin.$transaction(async (tx) => {
      const existing = await tx.admin_pages.findUnique({ where: { key } });
      if (!existing && !entry) {
        throw new AdminAccessError("not_found", "The running code has no page with that key.");
      }
      const name = input.name !== undefined ? normaliseText(input.name, "Name", 120, true)! : undefined;
      const description =
        input.description !== undefined ? normaliseText(input.description, "Description", 500, false) : undefined;

      const row = existing
        ? await tx.admin_pages.update({
            where: { key },
            data: {
              ...(name !== undefined ? { name } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(input.navOrder !== undefined ? { nav_order: input.navOrder } : {}),
              ...(input.isEnabled !== undefined ? { is_enabled: input.isEnabled } : {}),
              ...(input.requireSuperAdmin !== undefined ? { require_super_admin: input.requireSuperAdmin } : {}),
              updated_at: new Date(),
              updated_by: actorId,
            },
          })
        : await tx.admin_pages.create({
            data: {
              key,
              kind: entry!.kind,
              path: entry!.path,
              name: name ?? entry!.name,
              description: description !== undefined ? description : entry!.description,
              nav_order: input.navOrder ?? entry!.defaults.navOrder,
              is_enabled: input.isEnabled ?? true,
              require_super_admin: input.requireSuperAdmin ?? entry!.defaults.requireSuperAdmin,
              updated_by: actorId,
            },
          });

      const actionKeys = input.actionKeys ?? (existing ? undefined : entry!.defaults.actionKeys);
      if (actionKeys !== undefined) {
        const ids = await this.actionIdsFor(tx, actionKeys);
        await tx.admin_page_actions.deleteMany({ where: { page_id: row.id } });
        if (ids.length > 0) {
          await tx.admin_page_actions.createMany({ data: ids.map((action_id) => ({ page_id: row.id, action_id })) });
        }
      }

      await this.record(tx, actorId, existing ? "page_rule_updated" : "page_rule_registered", "admin_page", row.id, row.name, {
        key,
        ...(input.actionKeys !== undefined ? { actionKeys: [...input.actionKeys].sort() } : {}),
        ...(input.requireSuperAdmin !== undefined ? { requireSuperAdmin: input.requireSuperAdmin } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
      });

      const rule = await this.getPageRule(key);
      if (!rule) throw new AdminAccessError("not_found", "The page rule could not be read back.");
      return rule;
    });
  }

  private async storedEndpointRules(where?: Prisma.admin_endpointsWhereInput): Promise<StoredEndpointRule[]> {
    const rows = await prismaAdmin.admin_endpoints.findMany({
      where,
      include: { admin_endpoint_actions: { include: { admin_actions: { select: { key: true } } } } },
    });
    return rows.map((row) => ({
      key: row.key,
      method: row.method,
      path: row.path,
      name: row.name,
      description: row.description,
      category: row.category,
      authKind: row.auth_kind as EndpointAuthKind,
      rateLimit: row.rate_limit_policy,
      notes: row.notes,
      isEnabled: row.is_enabled,
      requireSuperAdmin: row.require_super_admin,
      actionKeys: row.admin_endpoint_actions.map((link) => link.admin_actions.key).sort(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async listEndpointRules(): Promise<EndpointRule[]> {
    return mergeEndpointRules(await this.storedEndpointRules());
  }

  async getEndpointRule(key: string): Promise<EndpointRule | null> {
    const rows = await this.storedEndpointRules({ key });
    return rows.length === 0 ? null : (mergeEndpointRules(rows).find((rule) => rule.key === key) ?? null);
  }

  async upsertEndpointRule(key: string, input: UpsertEndpointRuleInput, actorId: string): Promise<EndpointRule> {
    const entry = endpointRegistryEntry(key);
    return prismaAdmin.$transaction(async (tx) => {
      const existing = await tx.admin_endpoints.findUnique({ where: { key } });
      if (!existing && !entry) {
        throw new AdminAccessError("not_found", "The running code has no endpoint with that key.");
      }
      const name = input.name !== undefined ? normaliseText(input.name, "Name", 120, true)! : undefined;
      const description =
        input.description !== undefined ? normaliseText(input.description, "Description", 1000, false) : undefined;
      const notes = input.notes !== undefined ? normaliseText(input.notes, "Notes", 2000, false) : undefined;

      const row = existing
        ? await tx.admin_endpoints.update({
            where: { key },
            data: {
              ...(name !== undefined ? { name } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(notes !== undefined ? { notes } : {}),
              ...(input.isEnabled !== undefined ? { is_enabled: input.isEnabled } : {}),
              ...(input.requireSuperAdmin !== undefined ? { require_super_admin: input.requireSuperAdmin } : {}),
              updated_at: new Date(),
              updated_by: actorId,
            },
          })
        : await tx.admin_endpoints.create({
            data: {
              key,
              method: entry!.method,
              path: entry!.path,
              name: name ?? entry!.name,
              description: description !== undefined ? description : entry!.description,
              category: entry!.category,
              auth_kind: entry!.authKind,
              rate_limit_policy: entry!.rateLimit,
              notes: notes ?? null,
              is_enabled: input.isEnabled ?? true,
              require_super_admin: input.requireSuperAdmin ?? entry!.defaults.requireSuperAdmin,
              updated_by: actorId,
            },
          });

      const actionKeys = input.actionKeys ?? (existing ? undefined : entry!.defaults.actionKeys);
      if (actionKeys !== undefined) {
        const ids = await this.actionIdsFor(tx, actionKeys);
        await tx.admin_endpoint_actions.deleteMany({ where: { endpoint_id: row.id } });
        if (ids.length > 0) {
          await tx.admin_endpoint_actions.createMany({ data: ids.map((action_id) => ({ endpoint_id: row.id, action_id })) });
        }
      }

      await this.record(
        tx,
        actorId,
        existing ? "endpoint_rule_updated" : "endpoint_rule_registered",
        "admin_endpoint",
        row.id,
        `${row.method} ${row.path}`,
        {
          key,
          ...(input.actionKeys !== undefined ? { actionKeys: [...input.actionKeys].sort() } : {}),
          ...(input.requireSuperAdmin !== undefined ? { requireSuperAdmin: input.requireSuperAdmin } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        },
      );

      const rule = await this.getEndpointRule(key);
      if (!rule) throw new AdminAccessError("not_found", "The endpoint rule could not be read back.");
      return rule;
    });
  }

  /* -------------------------------- usage ------------------------------- */

  async recordUsage(hit: UsageHit): Promise<void> {
    const isError = hit.status >= 500 ? 1 : 0;
    const isDenied = hit.status === 401 || hit.status === 403 ? 1 : 0;
    const isLimited = hit.status === 429 ? 1 : 0;
    const duration = Math.max(0, Math.round(hit.durationMs));
    await prismaAdmin.$executeRaw`
      INSERT INTO admin_endpoint_usage
        (endpoint_key, day, calls, errors, denied, rate_limited, total_duration_ms, last_called_at)
      VALUES
        (${hit.endpointKey}, (now() AT TIME ZONE 'UTC')::date, 1, ${isError}, ${isDenied}, ${isLimited}, ${duration}, now())
      ON CONFLICT (endpoint_key, day) DO UPDATE SET
        calls             = admin_endpoint_usage.calls + 1,
        errors            = admin_endpoint_usage.errors + EXCLUDED.errors,
        denied            = admin_endpoint_usage.denied + EXCLUDED.denied,
        rate_limited      = admin_endpoint_usage.rate_limited + EXCLUDED.rate_limited,
        total_duration_ms = admin_endpoint_usage.total_duration_ms + EXCLUDED.total_duration_ms,
        last_called_at    = now()
    `;
  }

  async listUsage(): Promise<EndpointUsageSummary[]> {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 30);
    since.setUTCHours(0, 0, 0, 0);
    const rows = await prismaAdmin.admin_endpoint_usage.findMany({ where: { day: { gte: since } } });

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const weekAgo = new Date(today);
    weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);

    const byKey = new Map<string, EndpointUsageSummary & { duration30d: number }>();
    for (const row of rows) {
      const summary = byKey.get(row.endpoint_key) ?? {
        endpointKey: row.endpoint_key,
        callsToday: 0,
        calls7d: 0,
        calls30d: 0,
        errors30d: 0,
        denied30d: 0,
        rateLimited30d: 0,
        avgMs30d: null,
        lastCalledAt: null,
        duration30d: 0,
      };
      const calls = Number(row.calls);
      summary.calls30d += calls;
      summary.errors30d += Number(row.errors);
      summary.denied30d += Number(row.denied);
      summary.rateLimited30d += Number(row.rate_limited);
      summary.duration30d += Number(row.total_duration_ms);
      if (row.day.getTime() >= weekAgo.getTime()) summary.calls7d += calls;
      if (row.day.getTime() >= today.getTime()) summary.callsToday += calls;
      const last = iso(row.last_called_at);
      if (last && (!summary.lastCalledAt || last > summary.lastCalledAt)) summary.lastCalledAt = last;
      byKey.set(row.endpoint_key, summary);
    }
    return [...byKey.values()].map(({ duration30d, ...summary }) => ({
      ...summary,
      avgMs30d: summary.calls30d > 0 ? Math.round(duration30d / summary.calls30d) : null,
    }));
  }
}

let cached: PrismaAdminAccessRepository | null = null;

export function getPrismaAdminAccessRepository(): AdminAccessRepository {
  cached ??= new PrismaAdminAccessRepository();
  return cached;
}
