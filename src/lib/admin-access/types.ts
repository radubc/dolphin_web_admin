/**
 * The admin-access model, as the API and the UI see it.
 *
 * Mirrors the tables in `docs/admin-access/admin_access.sql` (`admin_users`,
 * `admin_actions`, `admin_roles`, the two join tables and the audit trail),
 * with the joins already resolved into `roleKeys` / `actionKeys` so a client
 * never has to stitch ids together. Timestamps are ISO strings: JSON has no
 * Date, and the client formats them itself.
 *
 * Plain data, no React, no Prisma: safe to import from anywhere.
 */

/* -------------------------------------------------------------------------- */
/*                                Action catalog                              */
/* -------------------------------------------------------------------------- */

/**
 * The permission catalog seeded by the SQL, as a type. Keys are the contract
 * with application code: `requireAction("can_write_tickets")` only compiles
 * for a key that exists. Extend this list together with the SQL seed.
 */
export const ACTION_KEYS = [
  "can_manage_admin_users",
  "can_manage_roles",
  "can_read_admin_audit",
  "can_read_user_list",
  "can_read_user_detail",
  "can_write_user",
  "can_disable_user",
  "can_read_tenant_list",
  "can_read_tenant_detail",
  "can_write_tenant",
  "can_access_tickets",
  "can_read_tickets",
  "can_write_tickets",
  "can_assign_tickets",
  "can_close_tickets",
  "can_read_catalogs",
  "can_write_catalogs",
  "can_manage_access_map",
  "can_read_services",
] as const;

export type ActionKey = (typeof ACTION_KEYS)[number];

export function isActionKey(value: string): value is ActionKey {
  return (ACTION_KEYS as readonly string[]).includes(value);
}

export interface AdminAction {
  id: string;
  key: string;
  description: string;
  /** Grouping for the UI: `admin_access`, `users`, `tenants`, `tickets`, `catalogs`. */
  category: string;
}

/* -------------------------------------------------------------------------- */
/*                                    Roles                                   */
/* -------------------------------------------------------------------------- */

export interface AdminRole {
  id: string;
  /** Stable snake_case identifier, e.g. `customer_service_agent`. */
  key: string;
  name: string;
  description: string | null;
  /** Seeded roles operators may edit but not delete. */
  isSystem: boolean;
  /** The actions this role grants. */
  actionKeys: string[];
  /** How many enabled admin users hold the role. */
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleInput {
  key: string;
  name: string;
  description?: string | null;
  actionKeys: string[];
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  actionKeys?: string[];
}

/* -------------------------------------------------------------------------- */
/*                                    Users                                   */
/* -------------------------------------------------------------------------- */

export interface AdminUser {
  id: string;
  /** Immutable subject from the admin-only Cognito user pool. */
  cognitoSub: string;
  email: string;
  displayName: string | null;
  /** Bypasses every action check and is the only principal that may manage access. */
  isSuperAdmin: boolean;
  /** Set when the user is soft-disabled; the row stays for the audit trail. */
  disabledAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Keys of the roles the user holds. */
  roleKeys: string[];
}

export type AdminUserStatus = "enabled" | "disabled";

export function adminUserStatus(user: Pick<AdminUser, "disabledAt">): AdminUserStatus {
  return user.disabledAt === null ? "enabled" : "disabled";
}

export interface CreateAdminUserInput {
  email: string;
  displayName?: string | null;
  roleKeys: string[];
  isSuperAdmin: boolean;
}

export interface UpdateAdminUserInput {
  displayName?: string | null;
  roleKeys?: string[];
  isSuperAdmin?: boolean;
  /** `true` disables, `false` re-enables. */
  disabled?: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                    Audit                                   */
/* -------------------------------------------------------------------------- */

export type AuditTargetType =
  | "admin_user"
  | "admin_role"
  | "admin_action"
  | "admin_user_role"
  | "admin_role_action"
  | "admin_page"
  | "admin_endpoint"
  /** A reference catalog (Constants); the row names the kind in `target_label`. */
  | "catalog";

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  /** Denormalised for display; null when the actor row is gone. */
  actorEmail: string | null;
  /** snake_case verb, e.g. `admin_user_created`, `role_assigned`. */
  action: string;
  targetType: AuditTargetType;
  targetId: string | null;
  /** Human-readable name of the target at the time, for display. */
  targetLabel: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditPage {
  events: AuditEvent[];
  /** Cursor for the next (older) page, or null at the end. */
  nextCursor: string | null;
}

/* -------------------------------------------------------------------------- */
/*                                  Principal                                 */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in operator as the authorization layer sees them: the allowlist
 * row plus the union of their roles' actions. A super-admin's `actions` list
 * is whatever their roles grant, but `isSuperAdmin` short-circuits every
 * check.
 */
export interface AdminPrincipal {
  user: AdminUser;
  isSuperAdmin: boolean;
  actions: string[];
}

/** What the UI needs to decide which controls to show. Safe to send to the client. */
export interface AdminCapabilities {
  userId: string;
  email: string;
  displayName: string | null;
  isSuperAdmin: boolean;
  actions: string[];
}

export function capabilitiesOf(principal: AdminPrincipal): AdminCapabilities {
  return {
    userId: principal.user.id,
    email: principal.user.email,
    displayName: principal.user.displayName,
    isSuperAdmin: principal.isSuperAdmin,
    actions: principal.actions,
  };
}

/** The one permission test, shared by server and client. */
export function canDo(
  capabilities: Pick<AdminCapabilities, "isSuperAdmin" | "actions">,
  action: ActionKey,
): boolean {
  return capabilities.isSuperAdmin || capabilities.actions.includes(action);
}

/* -------------------------------------------------------------------------- */
/*                                 Access map                                 */
/* -------------------------------------------------------------------------- */

/**
 * The rule that gates a page, a quick action or an endpoint. Stored in the
 * admin database (`admin_pages` / `admin_endpoints` plus their action links)
 * and edited on the Access Map page.
 *
 * Evaluation order, in `evaluateRule`: super-admins pass everything; then
 * `isEnabled`; then `requireSuperAdmin`; then ANY ONE of `actionKeys`. An
 * empty `actionKeys` means any enabled operator.
 */
export interface AccessRule {
  isEnabled: boolean;
  requireSuperAdmin: boolean;
  /** ANY-OF. Empty means any operator. */
  actionKeys: string[];
}

export type AccessDecision =
  /** Open it. */
  | "allow"
  /** No row in the database yet: super-admins only until registered. */
  | "unregistered"
  /** `isEnabled` is false. */
  | "disabled"
  /** The caller lacks the super-admin flag or every listed action. */
  | "denied";

/** The one rule evaluation, shared by the server (pages, routes) and the client (rail, buttons). */
export function evaluateRule(
  capabilities: Pick<AdminCapabilities, "isSuperAdmin" | "actions">,
  rule: AccessRule | null,
): AccessDecision {
  if (capabilities.isSuperAdmin) return "allow";
  if (rule === null) return "unregistered";
  if (!rule.isEnabled) return "disabled";
  if (rule.requireSuperAdmin) return "denied";
  if (rule.actionKeys.length === 0) return "allow";
  return rule.actionKeys.some((key) => capabilities.actions.includes(key)) ? "allow" : "denied";
}

export type PageKind = "page" | "quick_action";

/** One page or quick action as the Access Map shows it: rule plus catalog data. */
export interface PageRule extends AccessRule {
  key: string;
  kind: PageKind;
  path: string | null;
  name: string;
  description: string | null;
  navOrder: number;
  /** True when a database row exists. False rows show the code's defaults. */
  registered: boolean;
  /** False for a database row whose key the running code no longer ships. */
  inCode: boolean;
  updatedAt: string | null;
}

export interface UpsertPageRuleInput {
  actionKeys?: string[];
  requireSuperAdmin?: boolean;
  isEnabled?: boolean;
  navOrder?: number;
  name?: string;
  description?: string | null;
}

export type EndpointAuthKind = "public" | "session" | "admin";

/** One endpoint as the Access Map and the Services page show it. */
export interface EndpointRule extends AccessRule {
  key: string;
  method: string;
  path: string;
  name: string;
  description: string | null;
  category: string;
  authKind: EndpointAuthKind;
  /** A `RATE_LIMITS` preset name. */
  rateLimit: string;
  notes: string | null;
  registered: boolean;
  inCode: boolean;
  updatedAt: string | null;
}

export interface UpsertEndpointRuleInput {
  actionKeys?: string[];
  requireSuperAdmin?: boolean;
  isEnabled?: boolean;
  name?: string;
  description?: string | null;
  notes?: string | null;
}

/* -------------------------------------------------------------------------- */
/*                                    Usage                                   */
/* -------------------------------------------------------------------------- */

/** One recorded call, as the handler wrapper reports it. */
export interface UsageHit {
  endpointKey: string;
  status: number;
  durationMs: number;
}

/** Rolled-up counters for one endpoint, for the Services page. */
export interface EndpointUsageSummary {
  endpointKey: string;
  callsToday: number;
  calls7d: number;
  calls30d: number;
  errors30d: number;
  denied30d: number;
  rateLimited30d: number;
  /** Mean response time over the last 30 days, or null with no calls. */
  avgMs30d: number | null;
  lastCalledAt: string | null;
}
