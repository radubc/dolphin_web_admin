/**
 * The API endpoints the code ships, keyed the same way as the
 * `admin_endpoints` rows in the admin database.
 *
 * Like the page registry this is the *catalog*, not the access map: the
 * database holds the rule for each endpoint. Each Route Handler names its
 * entry when it is exported — `apiHandler(fn, { endpoint: "health" })` — and
 * that key is what the wrapper looks up in the database and what usage is
 * counted against. `rateLimit` names a `RATE_LIMITS` preset so the Services
 * page can print the numbers.
 *
 * Adding an endpoint: write the route, add an entry here with the same key
 * the route declares, then register it on the Access Map (or in a numbered
 * SQL file under `docs/sql/`). An endpoint with no row is super-admin only.
 */
import type { ActionKey } from "./types";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Who may call it before any rule is consulted:
 * - `public`: no credential (health, the auth routes that carry their own cookie);
 * - `session`: any signed-in user of the admin Cognito pool, allowlisted or not;
 * - `admin`: the allowlist plus the endpoint's rule.
 */
export type EndpointAuthKind = "public" | "session" | "admin";

export interface EndpointRegistryEntry {
  key: string;
  method: HttpMethod;
  /** Route pattern as Next spells it, e.g. `/api/v1/admin/users/[id]`. */
  path: string;
  name: string;
  description: string;
  category: string;
  authKind: EndpointAuthKind;
  /** A `RATE_LIMITS` preset name. */
  rateLimit: string;
  /** Defaults used when the entry is registered from the Access Map. */
  defaults: {
    requireSuperAdmin: boolean;
    /** ANY-OF. Empty means any operator (for `admin` endpoints). */
    actionKeys: ActionKey[];
  };
}

const none = { requireSuperAdmin: false, actionKeys: [] as ActionKey[] };
const superOnly = { requireSuperAdmin: true, actionKeys: [] as ActionKey[] };
const any = (...actionKeys: ActionKey[]) => ({ requireSuperAdmin: false, actionKeys });

export const ENDPOINT_REGISTRY: readonly EndpointRegistryEntry[] = [
  {
    key: "health",
    method: "GET",
    path: "/api/health",
    name: "Health probe",
    description:
      "Liveness and readiness: probes the main and admin databases. Public and unversioned so a load balancer can call it.",
    category: "operations",
    authKind: "public",
    rateLimit: "health",
    defaults: none,
  },
  {
    key: "auth.refresh.post",
    method: "POST",
    path: "/api/auth/refresh",
    name: "Refresh session (fetch)",
    description:
      "Exchanges the refresh-token cookie for a new id/access token pair. Called by apiFetch on token_expired.",
    category: "authentication",
    authKind: "public",
    rateLimit: "authRefresh",
    defaults: none,
  },
  {
    key: "auth.refresh.get",
    method: "GET",
    path: "/api/auth/refresh",
    name: "Refresh session (navigation)",
    description:
      "Same exchange for a browser navigation; the proxy sends an expired page session here and it redirects back.",
    category: "authentication",
    authKind: "public",
    rateLimit: "authRefresh",
    defaults: none,
  },
  {
    key: "auth.logout.post",
    method: "POST",
    path: "/api/auth/logout",
    name: "Sign out (form or fetch)",
    description:
      "Revokes the refresh token at Cognito and clears every session cookie. A form POST gets a 303 to /login, a fetch gets 204.",
    category: "authentication",
    authKind: "public",
    rateLimit: "authRefresh",
    defaults: none,
  },
  {
    key: "auth.logout.get",
    method: "GET",
    path: "/api/auth/logout",
    name: "Sign out (navigation)",
    description: "Sign-out for a typed URL or bookmark. Same effect as the POST, always redirects to /login.",
    category: "authentication",
    authKind: "public",
    rateLimit: "authRefresh",
    defaults: none,
  },
  {
    key: "me",
    method: "GET",
    path: "/api/v1/me",
    name: "Session identity",
    description:
      "The signed-in Cognito identity from the id token: user id, email, name. Does not consult the allowlist.",
    category: "session",
    authKind: "session",
    rateLimit: "api",
    defaults: none,
  },
  {
    key: "admin.me",
    method: "GET",
    path: "/api/v1/admin/me",
    name: "Operator capabilities",
    description:
      "The caller's allowlist row, super-admin flag and effective actions. The UI uses it to decide which controls to draw.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: none,
  },
  {
    key: "admin.users.list",
    method: "GET",
    path: "/api/v1/admin/users",
    name: "List admin users",
    description: "Every operator on the allowlist, enabled or disabled, with their role keys.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_manage_admin_users"),
  },
  {
    key: "admin.users.create",
    method: "POST",
    path: "/api/v1/admin/users",
    name: "Invite admin user",
    description: "Adds an operator: email, display name, roles, super-admin flag. Writes an audit event.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: superOnly,
  },
  {
    key: "admin.users.get",
    method: "GET",
    path: "/api/v1/admin/users/[id]",
    name: "Get admin user",
    description: "One operator by id.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_manage_admin_users"),
  },
  {
    key: "admin.users.update",
    method: "PATCH",
    path: "/api/v1/admin/users/[id]",
    name: "Update admin user",
    description:
      "Display name, roles, super-admin flag, disable/enable. Refuses self-lockout and removing the last super-admin.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: superOnly,
  },
  {
    key: "admin.roles.list",
    method: "GET",
    path: "/api/v1/admin/roles",
    name: "List roles",
    description: "The role catalog with each role's action grants and member count.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_manage_roles"),
  },
  {
    key: "admin.roles.create",
    method: "POST",
    path: "/api/v1/admin/roles",
    name: "Create role",
    description: "A new role with its key, name, description and action grants.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: superOnly,
  },
  {
    key: "admin.roles.get",
    method: "GET",
    path: "/api/v1/admin/roles/[id]",
    name: "Get role",
    description: "One role by id.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_manage_roles"),
  },
  {
    key: "admin.roles.update",
    method: "PATCH",
    path: "/api/v1/admin/roles/[id]",
    name: "Update role",
    description: "Name, description and action grants. Grants and revocations are audited individually.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: superOnly,
  },
  {
    key: "admin.roles.delete",
    method: "DELETE",
    path: "/api/v1/admin/roles/[id]",
    name: "Delete role",
    description: "Removes a non-system role that no enabled user holds.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: superOnly,
  },
  {
    key: "admin.actions.list",
    method: "GET",
    path: "/api/v1/admin/actions",
    name: "List actions",
    description: "The permission catalog (admin_actions).",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_manage_roles", "can_manage_access_map"),
  },
  {
    key: "admin.audit.list",
    method: "GET",
    path: "/api/v1/admin/audit",
    name: "List audit events",
    description: "Membership and grant changes, newest first, cursor-paged.",
    category: "admin_access",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_admin_audit"),
  },
  {
    key: "admin.pages.list",
    method: "GET",
    path: "/api/v1/admin/pages",
    name: "List page rules",
    description:
      "The access map for pages and quick actions, merged with what the code knows so unregistered items are visible.",
    category: "access_map",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_manage_access_map"),
  },
  {
    key: "admin.pages.upsert",
    method: "PUT",
    path: "/api/v1/admin/pages/[key]",
    name: "Save page rule",
    description:
      "Registers or updates one page/quick action rule: required actions, super-admin only, enabled, order.",
    category: "access_map",
    authKind: "admin",
    rateLimit: "api",
    defaults: superOnly,
  },
  {
    key: "admin.endpoints.list",
    method: "GET",
    path: "/api/v1/admin/endpoints",
    name: "List endpoint rules",
    description:
      "The service registry merged with the code's endpoint catalog: metadata, rule, rate-limit preset.",
    category: "access_map",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_manage_access_map", "can_read_services"),
  },
  {
    key: "admin.endpoints.upsert",
    method: "PUT",
    path: "/api/v1/admin/endpoints/[key]",
    name: "Save endpoint rule",
    description: "Registers or updates one endpoint rule: required actions, super-admin only, enabled, notes.",
    category: "access_map",
    authKind: "admin",
    rateLimit: "api",
    defaults: superOnly,
  },
  {
    key: "admin.constants.list",
    method: "GET",
    path: "/api/v1/admin/constants/[kind]",
    name: "List constants",
    description:
      "One reference catalog (countries, currencies, financial institutions, categories) from the admin database, each row labelled new / changed / synced against the main app database.",
    category: "catalogs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_catalogs", "can_write_catalogs"),
  },
  {
    key: "admin.constants.create",
    method: "POST",
    path: "/api/v1/admin/constants/[kind]",
    name: "Create constant",
    description:
      "Adds a row to a reference catalog in the admin database. Nothing reaches the main app database until a push.",
    category: "catalogs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_catalogs"),
  },
  {
    key: "admin.constants.get",
    method: "GET",
    path: "/api/v1/admin/constants/[kind]/[id]",
    name: "Get constant",
    description: "One catalog row by id, with its push state against the main app database.",
    category: "catalogs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_catalogs", "can_write_catalogs"),
  },
  {
    key: "admin.constants.update",
    method: "PATCH",
    path: "/api/v1/admin/constants/[kind]/[id]",
    name: "Update constant",
    description:
      "Partial edit of one catalog row in the admin database. The main app database is unaffected until a push.",
    category: "catalogs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_catalogs"),
  },
  {
    key: "admin.constants.delete",
    method: "DELETE",
    path: "/api/v1/admin/constants/[kind]/[id]",
    name: "Delete constant",
    description:
      "Retires a category (deleted_at) or removes a country, currency or institution from the admin catalog. Never deletes anything from the main app database.",
    category: "catalogs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_catalogs"),
  },
  {
    key: "admin.constants.push",
    method: "POST",
    path: "/api/v1/admin/constants/[kind]/push",
    name: "Push constants",
    description:
      "Upserts the selected rows (or the whole catalog) into the main app database by id, dependencies first. It never deletes there: rows are referenced by tenant data.",
    category: "catalogs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_catalogs"),
  },
  {
    key: "admin.usage.list",
    method: "GET",
    path: "/api/v1/admin/usage",
    name: "Endpoint usage",
    description:
      "Daily call counters per endpoint for the Services page: calls, errors, denials, rate limits, timing.",
    category: "access_map",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_services"),
  },
] as const;

export type EndpointKey = (typeof ENDPOINT_REGISTRY)[number]["key"];

export function endpointRegistryEntry(key: string): EndpointRegistryEntry | undefined {
  return ENDPOINT_REGISTRY.find((entry) => entry.key === key);
}
