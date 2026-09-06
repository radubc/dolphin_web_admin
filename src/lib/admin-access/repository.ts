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
  EndpointRule,
  EndpointUsageSummary,
  PageRule,
  UpdateAdminUserInput,
  UpdateRoleInput,
  UpsertEndpointRuleInput,
  UpsertPageRuleInput,
  UsageHit,
} from "./types";
import { getMemoryAdminAccessRepository } from "./mock";
import { getPrismaAdminAccessRepository } from "./prisma-repository";

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

  /* ----------------------------- Access map ----------------------------- */

  /** Every page and quick action: database rows merged with the code registry. */
  listPageRules(): Promise<PageRule[]>;
  /** The stored rule for one key, or `null` when it is not registered. */
  getPageRule(key: string): Promise<PageRule | null>;
  /** Registers (from the registry defaults) or updates one rule. */
  upsertPageRule(key: string, input: UpsertPageRuleInput, actorId: string): Promise<PageRule>;

  listEndpointRules(): Promise<EndpointRule[]>;
  getEndpointRule(key: string): Promise<EndpointRule | null>;
  upsertEndpointRule(key: string, input: UpsertEndpointRuleInput, actorId: string): Promise<EndpointRule>;

  /* -------------------------------- Usage ------------------------------- */

  /** Counts one call. Best effort: must never throw into a request. */
  recordUsage(hit: UsageHit): Promise<void>;
  /** Counters per endpoint over the last 30 days. */
  listUsage(): Promise<EndpointUsageSummary[]>;
}

/**
 * The repository the app runs on.
 *
 * Prisma over the admin database by default. `ADMIN_ACCESS_STORE=mock` in the
 * environment selects the in-memory mock instead — for development before the
 * SQL in `docs/sql/` has been run, or for a demo with invented operators. Read
 * per call so a change to `.env` takes effect on the dev server's next request.
 */
export function getAdminAccessRepository(): AdminAccessRepository {
  const store = process.env.ADMIN_ACCESS_STORE?.trim().toLowerCase();
  if (store === "mock") {
    return getMemoryAdminAccessRepository();
  }
  return getPrismaAdminAccessRepository();
}
