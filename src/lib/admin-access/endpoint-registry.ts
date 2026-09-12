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
 * - `service`: an `API_KEYS` machine client; the rule is not applied.
 */
export type EndpointAuthKind = "public" | "session" | "admin" | "service";

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
      "One page of a reference catalog (countries, currencies, financial institutions, categories, account base types, account types, cryptocurrencies, ETFs, stocks, markets) from the admin database, each row labelled from the sync ledger, with the catalog counts and the latest job.",
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
      "Retires a category, an account type or a market (deleted_at) or removes a row of the other reference catalogs from the admin database. Never deletes anything from the main app database.",
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
      "Upserts the named rows, everything pending, or the whole catalog into the main app database by id, in batches, dependencies first. It never deletes there: rows are referenced by tenant data. Answers with a job.",
    category: "catalogs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_catalogs"),
  },
  {
    key: "admin.constants.compare",
    method: "POST",
    path: "/api/v1/admin/constants/[kind]/compare",
    name: "Compare constants",
    description:
      "Starts a job that compares one catalog with the main app database and rebuilds its sync ledger (new / changed / synced / main-only). Small catalogs finish before the response.",
    category: "catalogs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_catalogs"),
  },
  {
    key: "admin.constants.jobs.list",
    method: "GET",
    path: "/api/v1/admin/constants/[kind]/jobs",
    name: "List constant jobs",
    description:
      "Recent compare and push jobs for one catalog, newest first, with progress and counters.",
    category: "catalogs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_catalogs", "can_write_catalogs"),
  },
  {
    key: "admin.constants.jobs.get",
    method: "GET",
    path: "/api/v1/admin/constants/[kind]/jobs/[jobId]",
    name: "Get constant job",
    description: "One compare or push job by id, for polling progress.",
    category: "catalogs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_catalogs", "can_write_catalogs"),
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
  {
    key: "admin.integrations.list",
    method: "GET",
    path: "/api/v1/admin/integrations",
    name: "List integrations",
    description:
      "Every integration with its schedule, settings, latest run and whether the scheduler runs in this process. Never returns an API key, only whether its environment variable is set.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_integrations", "can_write_integrations"),
  },
  {
    key: "admin.integrations.update",
    method: "PATCH",
    path: "/api/v1/admin/integrations/[key]",
    name: "Update integration",
    description:
      "Base URL, enabled flag, schedule and settings. Recomputes when the scheduler will next start it.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_integrations"),
  },
  {
    key: "admin.integrations.run",
    method: "POST",
    path: "/api/v1/admin/integrations/[key]/run",
    name: "Run integration",
    description:
      "Starts a run now and answers a running run to poll. 409 while one is already live for that integration; 422 when it needs an API key that is not configured.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_integrations"),
  },
  {
    key: "admin.integrations.runs.list",
    method: "GET",
    path: "/api/v1/admin/integrations/[key]/runs",
    name: "List integration runs",
    description: "Recent runs for one integration, newest first, with progress and counters.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_integrations", "can_write_integrations"),
  },
  {
    key: "admin.integrations.runs.get",
    method: "GET",
    path: "/api/v1/admin/integrations/[key]/runs/[runId]",
    name: "Get integration run",
    description: "One run by id, for polling progress.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_integrations", "can_write_integrations"),
  },
  {
    key: "admin.integrations.quote_symbols.list",
    method: "GET",
    path: "/api/v1/admin/integrations/quote-symbols",
    name: "List quote symbols",
    description: "One page of the quote watch list, each symbol with its newest cached quote.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_integrations", "can_write_integrations"),
  },
  {
    key: "admin.integrations.quote_symbols.create",
    method: "POST",
    path: "/api/v1/admin/integrations/quote-symbols",
    name: "Add quote symbol",
    description:
      "Adds a symbol to the watch list, filling name and currency from the admin catalog when it is found there. A symbol the catalog does not know is still accepted.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_integrations"),
  },
  {
    key: "admin.integrations.quote_symbols.update",
    method: "PATCH",
    path: "/api/v1/admin/integrations/quote-symbols/[id]",
    name: "Update quote symbol",
    description: "Activates or deactivates one watched symbol.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_integrations"),
  },
  {
    key: "admin.integrations.quote_symbols.delete",
    method: "DELETE",
    path: "/api/v1/admin/integrations/quote-symbols/[id]",
    name: "Remove quote symbol",
    description: "Removes the watch row. Cached quotes are kept.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_integrations"),
  },
  {
    key: "admin.integrations.currency_pairs.list",
    method: "GET",
    path: "/api/v1/admin/integrations/currency-pairs",
    name: "List currency pairs",
    description: "One page of the currency pair watch list, each pair with its newest cached rate.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_integrations", "can_write_integrations"),
  },
  {
    key: "admin.integrations.currency_pairs.create",
    method: "POST",
    path: "/api/v1/admin/integrations/currency-pairs",
    name: "Add currency pair",
    description: "Adds a pair to the watch list. Codes are three uppercase letters and must differ.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_integrations"),
  },
  {
    key: "admin.integrations.currency_pairs.update",
    method: "PATCH",
    path: "/api/v1/admin/integrations/currency-pairs/[id]",
    name: "Update currency pair",
    description: "Activates or deactivates one watched pair.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_integrations"),
  },
  {
    key: "admin.integrations.currency_pairs.delete",
    method: "DELETE",
    path: "/api/v1/admin/integrations/currency-pairs/[id]",
    name: "Remove currency pair",
    description: "Removes the watch row. Cached rates are kept.",
    category: "integrations",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_write_integrations"),
  },
  {
    key: "admin.customers.list",
    method: "GET",
    path: "/api/v1/admin/customers",
    name: "List customers",
    description:
      "One page of the consumer app's users with their tenants, last activity, account and transaction counts, and what the customer Cognito pool says about each account.",
    category: "customers",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_user_list", "can_read_user_detail", "can_invite_users"),
  },
  {
    key: "admin.customers.get",
    method: "GET",
    path: "/api/v1/admin/customers/[id]",
    name: "Get customer",
    description: "One customer by users.id, with the same figures as the list.",
    category: "customers",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_user_list", "can_read_user_detail", "can_invite_users"),
  },
  {
    key: "admin.customers.invites.list",
    method: "GET",
    path: "/api/v1/admin/customers/invites",
    name: "List customer invitations",
    description:
      "Invitations sent to the consumer app, newest first, with counts per status and whether this deployment can send any.",
    category: "customers",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_user_list", "can_read_user_detail", "can_invite_users"),
  },
  {
    key: "admin.customers.invites.create",
    method: "POST",
    path: "/api/v1/admin/customers/invites",
    name: "Invite a customer",
    description:
      "Creates the account in the customer Cognito pool and lets Cognito email the temporary password. 409 when the address already has an account or an open invitation.",
    category: "customers",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_invite_users"),
  },
  {
    key: "admin.customers.invites.resend",
    method: "POST",
    path: "/api/v1/admin/customers/invites/[id]/resend",
    name: "Resend a customer invitation",
    description: "Sends the invitation email again for an invitation nobody has acted on yet.",
    category: "customers",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_invite_users"),
  },
  {
    key: "admin.customers.invites.revoke",
    method: "DELETE",
    path: "/api/v1/admin/customers/invites/[id]",
    name: "Revoke a customer invitation",
    description:
      "Deletes the unused pool account and marks the invitation revoked. Refuses (409) once the person has signed in.",
    category: "customers",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_invite_users"),
  },
  {
    key: "admin.customers.statistics",
    method: "GET",
    path: "/api/v1/admin/customers/statistics",
    name: "Customer statistics",
    description:
      "Population and engagement figures: accounts by status, DAU/WAU/MAU, new and deleted per month, churn, retention by sign-up cohort, the invitation funnel, the pool's daily sign-in counters, request and error volume, and the largest tenants. ?months= (1..24, default 6) and ?days= (1..400, default 35). Reads the admin and main databases; never calls AWS.",
    category: "customers",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_user_list", "can_read_user_detail", "can_invite_users"),
  },
  {
    key: "admin.customers.activity",
    method: "GET",
    path: "/api/v1/admin/customers/[id]/activity",
    name: "Customer activity",
    description:
      "One customer's own figures: last seen, 35 days of their usage_daily counters, the size of each tenant they belong to, and every lifecycle event recorded for their Cognito sub. No query string.",
    category: "customers",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_user_list", "can_read_user_detail", "can_invite_users"),
  },
  {
    key: "admin.costs.summary",
    method: "GET",
    path: "/api/v1/admin/costs",
    name: "Cost summary",
    description:
      "The newest AWS cost snapshot (month to date, forecast, budget, free tier, anomalies) with the per-service and per-component breakdowns and the last aws_costs run. Reads the admin database only; never calls AWS.",
    category: "costs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_costs", "can_write_costs"),
  },
  {
    key: "admin.costs.daily",
    method: "GET",
    path: "/api/v1/admin/costs/daily",
    name: "Daily cost series",
    description:
      "One entry per day for the last ?days (1..400, default 35): the day's total in USD, whether AWS still calls it an estimate, and the amount per service. Ends yesterday; reads the admin database only.",
    category: "costs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_costs", "can_write_costs"),
  },
  {
    key: "admin.costs.per_client",
    method: "GET",
    path: "/api/v1/admin/costs/per-client",
    name: "Cost per client",
    description:
      "The allocated cost estimate per tenant for one month (?month=YYYY-MM, default the current month): the four pool totals with what is left unallocated, and each tenant's four components, share of the month and the drivers behind them. Reads admin_tenant_cost_monthly plus tenant names from the main app database; never calls AWS and never recomputes — the nightly allocate_costs run writes it.",
    category: "costs",
    authKind: "admin",
    rateLimit: "api",
    defaults: any("can_read_costs", "can_write_costs"),
  },
  {
    key: "service.quotes.lookup",
    method: "GET",
    path: "/api/v1/service/quotes",
    name: "Quote lookup",
    description:
      "Machine clients (API_KEYS): the newest cached quote per symbol, fetching any symbol with no quote from today. Unknown symbols join the watch list. Never fails because the provider is down.",
    category: "integrations",
    authKind: "service",
    rateLimit: "service",
    defaults: none,
  },
  {
    key: "service.exchange_rates.lookup",
    method: "GET",
    path: "/api/v1/service/exchange-rates",
    name: "Exchange rate lookup",
    description:
      "Machine clients (API_KEYS): the newest cached rate per pair, fetching any pair with no rate from today. Unknown pairs join the watch list. Never fails because the provider is down.",
    category: "integrations",
    authKind: "service",
    rateLimit: "service",
    defaults: none,
  },
  {
    key: "service.defaults.categories",
    method: "GET",
    path: "/api/v1/service/defaults/categories",
    name: "Default categories",
    description:
      "Machine clients (API_KEYS): every live default category, for the consumer app to copy into a tenant it is creating. A missing or empty catalog is a 503, never an empty list.",
    category: "catalogs",
    authKind: "service",
    rateLimit: "service",
    defaults: none,
  },
  {
    key: "service.defaults.financial_institutions",
    method: "GET",
    path: "/api/v1/service/defaults/financial-institutions",
    name: "Default financial institutions",
    description:
      "Machine clients (API_KEYS): the default financial institutions, for the consumer app to copy into a tenant it is creating. A missing or empty catalog is a 503, never an empty list.",
    category: "catalogs",
    authKind: "service",
    rateLimit: "service",
    defaults: none,
  },
] as const;

export type EndpointKey = (typeof ENDPOINT_REGISTRY)[number]["key"];

export function endpointRegistryEntry(key: string): EndpointRegistryEntry | undefined {
  return ENDPOINT_REGISTRY.find((entry) => entry.key === key);
}
