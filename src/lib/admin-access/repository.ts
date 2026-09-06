import "server-only";
/**
 * The seam between the admin-access API and its storage.
 *
 * Every Route Handler and page talks to this interface and never to a store
 * directly, so the in-memory mock behind `getAdminAccessRepository()` today can
 * be replaced by a Prisma implementation over `ADMIN_DATABASE_URL` without a
 * single call site changing. The Prisma version maps one-to-one onto the
 * tables in `docs/admin-access/admin_access.sql`.
 *
 * Rules the implementation, not the caller, enforces (so they hold whoever
 * calls):
 *
 * - emails are stored lowercased and are unique; role keys are unique;
 * - a system role cannot be deleted;
 * - the last enabled super-admin cannot be disabled or demoted, and an actor
 *   cannot disable or demote themself — both are lockouts;
 * - every membership or grant change writes an audit event.
 *
 * A violated rule is thrown as `AdminAccessError`, which the handler wrapper
 * renders as a 409 `conflict` or 422 `validation_failed`.
 */
import type {
  AdminAction,
  AdminPrincipal,
  AdminRole,
  AdminUser,
  AuditPage,
  CreateAdminUserInput,
  CreateRoleInput,
  UpdateAdminUserInput,
  UpdateRoleInput,
} from "./types";
import { getMemoryAdminAccessRepository } from "./mock";

/** A rule of the model was violated. `code` is stable; `message` is user-facing. */
export class AdminAccessError extends Error {
  readonly code: "not_found" | "conflict" | "invalid";

  constructor(code: "not_found" | "conflict" | "invalid", message: string) {
    super(message);
    this.name = "AdminAccessError";
    this.code = code;
  }
}

/** Claims from the verified id token, used to keep the allowlist row current. */
export interface LoginClaims {
  email: string | null;
  name: string | null;
}

export interface AdminAccessRepository {
  /* ----------------------------- Principal ------------------------------ */

  /**
   * Resolves the allowlist row for a Cognito `sub`, with the union of its
   * roles' actions. `null` when there is no row **or** the row is disabled:
   * the caller must treat both as "no access".
   */
  findPrincipalBySub(cognitoSub: string): Promise<AdminPrincipal | null>;

  /**
   * Stamps `last_login_at` and refreshes email/display name from the token.
   * Implementations may throttle it; it is called on every page render.
   */
  recordLogin(userId: string, claims: LoginClaims): Promise<void>;

  /* ------------------------------- Users -------------------------------- */

  listUsers(): Promise<AdminUser[]>;
  getUser(id: string): Promise<AdminUser | null>;
  createUser(input: CreateAdminUserInput, actorId: string): Promise<AdminUser>;
  updateUser(id: string, input: UpdateAdminUserInput, actorId: string): Promise<AdminUser>;

  /* ------------------------------- Roles -------------------------------- */

  listRoles(): Promise<AdminRole[]>;
  getRole(id: string): Promise<AdminRole | null>;
  createRole(input: CreateRoleInput, actorId: string): Promise<AdminRole>;
  updateRole(id: string, input: UpdateRoleInput, actorId: string): Promise<AdminRole>;
  deleteRole(id: string, actorId: string): Promise<void>;

  /* ------------------------------ Catalog ------------------------------- */

  listActions(): Promise<AdminAction[]>;

  /* ------------------------------- Audit -------------------------------- */

  listAuditEvents(options: { limit: number; cursor?: string | null }): Promise<AuditPage>;
}

/**
 * The repository the app runs on.
 *
 * **Mock for now.** Swap the body for the Prisma implementation when the
 * `admin_*` tables are mirrored into `prisma-admin/schema.prisma`; nothing
 * else in the app needs to change.
 */
export function getAdminAccessRepository(): AdminAccessRepository {
  return getMemoryAdminAccessRepository();
}
