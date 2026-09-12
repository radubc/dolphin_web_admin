/**
 * The Customers model, as the API and the UI see it.
 *
 * A *customer* is a person with an account in the consumer app: a row in the
 * main app database's `users` table (created by the consumer app the first
 * time a Cognito identity signs in) plus, usually, a membership of one tenant.
 * The admin app only reads those tables; it never writes them. What it can
 * do is bring the Cognito side into view (does the account exist, has the
 * invitation been accepted, is it disabled) and send **invitations**: there
 * is no self-service sign-up, so an operator creates the Cognito account with
 * `AdminCreateUser`, Cognito emails the temporary password, and the person
 * signs in and sets their own. Invitations are recorded in the admin database
 * (`admin_customer_invites`) so the page can show who was invited, when, by
 * whom, and whether they have shown up.
 *
 * Plain data, no React, no Prisma: safe to import from anywhere.
 */

/* -------------------------------------------------------------------------- */
/*                                  Customers                                 */
/* -------------------------------------------------------------------------- */

/** One tenant a customer belongs to. */
export interface CustomerTenant {
  id: string;
  name: string;
  /** The tenant the person lands in by default. */
  isPrimary: boolean;
  createdAt: string | null;
}

/**
 * What the customer's Cognito pool says about the account. `null` when the
 * pool could not be consulted (not configured, no credentials, or the call
 * failed); the list still works from the database alone in that case.
 */
export interface CustomerCognitoAccount {
  /** The pool's `UserStatus`, normalised. */
  status: "confirmed" | "force_change_password" | "unconfirmed" | "reset_required" | "unknown";
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * The one-word state the table shows, derived on the server:
 * - `active` — signed in at least once (a `users` row exists) and the pool
 *   account is confirmed and enabled;
 * - `invited` — a Cognito account exists but the person has never set their
 *   own password (`FORCE_CHANGE_PASSWORD`);
 * - `disabled` — the pool account is disabled;
 * - `deleted` — the `users` row is soft-deleted (`users.deleted_at`), which is
 *   what the consumer app's "delete my account" flow writes. It outranks
 *   every pool-derived state: whatever the pool still says, this person has
 *   left, and the row is only in the list at all because "Include deleted" is
 *   on;
 * - `no_account` — a `users` row with no matching pool account (deleted in
 *   the pool, or a different pool);
 * - `unknown` — the pool was not consulted.
 */
export type CustomerStatus =
  | "active"
  | "invited"
  | "disabled"
  | "deleted"
  | "no_account"
  | "unknown";

export interface Customer {
  /** `users.id` in the main app database. */
  id: string;
  cognitoSub: string;
  email: string;
  isPrimary: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  tenants: CustomerTenant[];
  /**
   * The newest change the person's tenants have made: the greatest
   * `updated_at` across their transactions, accounts, budgets and goals, or
   * the tenant's own `updated_at` when nothing else exists. Null for a
   * customer with no tenant yet.
   *
   * Kept as the **fallback** for `lastSeenAt`: it says "someone in this
   * household changed something", which is all the console could measure
   * before the consumer app started stamping sign-ins.
   */
  lastActiveAt: string | null;
  /**
   * `users.last_seen_at` in the main app database: the consumer app stamps it
   * at sign-in and refreshes it at most once an hour, so this is the only
   * figure here that really means "this person used the app". Null for a row
   * written before that column existed, or for someone who has not signed in
   * since; the UI then falls back to `lastActiveAt` and says which it is
   * showing.
   */
  lastSeenAt: string | null;
  /** Live rows in the person's tenants; small numbers that say how far they got. */
  accountCount: number;
  transactionCount: number;
  cognito: CustomerCognitoAccount | null;
  status: CustomerStatus;
}

export const CUSTOMER_PAGE_SIZE_DEFAULT = 50;
export const CUSTOMER_PAGE_SIZE_MAX = 200;

/** How many days without a change still count as "active" in the figures. */
export const ACTIVE_WINDOW_DAYS = 30;

export interface CustomerListQuery {
  page?: number;
  pageSize?: number;
  /** Case-insensitive substring over email and tenant name. */
  q?: string;
  /** `all` (default) or one status. */
  status?: CustomerStatus | "all";
  /** Include soft-deleted `users` rows. Default false. */
  includeDeleted?: boolean;
}

export interface CustomerCounts {
  /** Live `users` rows. */
  total: number;
  /** Customers whose `lastActiveAt` is within `ACTIVE_WINDOW_DAYS`. */
  activeRecently: number;
  /** Pool accounts still waiting for a first sign-in (see invites too). */
  invited: number;
  disabled: number;
  /**
   * Soft-deleted `users` rows (`users.deleted_at`), whatever the filters show.
   * These are the self-service account deletions; they are hidden from the
   * list unless "Include deleted" is on, so the figure is the only place an
   * operator sees them without going looking.
   */
  deleted: number;
}

export interface CustomerListResponse {
  items: Customer[];
  total: number;
  page: number;
  pageSize: number;
  counts: CustomerCounts;
  /** False when the customer pool is not configured or could not be reached. */
  cognitoAvailable: boolean;
  /**
   * True when the pool listing hit its size cap, so statuses and counts cover
   * only part of the pool. The page says so instead of showing partial
   * numbers as whole ones.
   */
  cognitoTruncated: boolean;
  /**
   * Whether an invitation can be sent from this deployment (the pool is
   * configured). Carried here as well as on the invitations list so the
   * invite drawer knows before the operator presses Send, whichever view or
   * menu it was opened from.
   */
  canSend: boolean;
  /** A one-line reason when `canSend` is false. */
  unavailableReason: string | null;
}

/* -------------------------------------------------------------------------- */
/*                                   Invites                                  */
/* -------------------------------------------------------------------------- */

/**
 * - `invited` — the Cognito account exists with a temporary password and the
 *   email has been sent (possibly more than once);
 * - `accepted` — a `users` row with the account's sub has appeared, so the
 *   person has signed in;
 * - `revoked` — an operator withdrew it: the pool account was deleted while
 *   it was still unaccepted;
 * - `failed` — Cognito refused the create (the row keeps the reason).
 */
export type InviteStatus = "invited" | "accepted" | "revoked" | "failed";

export interface CustomerInvite {
  id: string;
  email: string;
  /** The Cognito username the account was created with (the email). */
  cognitoUsername: string;
  /** The account's `sub`, once Cognito answered. */
  cognitoSub: string | null;
  status: InviteStatus;
  /** Free text for the operator's own record: "beta tester", "friend of X". */
  note: string | null;
  invitedBy: string | null;
  invitedByEmail: string | null;
  createdAt: string;
  /** The last time the invitation email went out (create or resend). */
  lastSentAt: string | null;
  /** How many times the email has been sent. */
  sendCount: number;
  acceptedAt: string | null;
  revokedAt: string | null;
  /** Cognito's message when the create or a resend was refused. */
  error: string | null;
}

/** What `POST /api/v1/admin/customers/invites` accepts. */
export interface CreateInviteInput {
  email: string;
  note?: string | null;
  /**
   * Sent to Cognito as the `name` / `locale` attributes; the pool requires
   * both, and whatever is left blank the person is asked for at first
   * sign-in.
   */
  name?: string | null;
  /**
   * Sent to Cognito as the `name` / `locale` attributes; the pool requires
   * both, and whatever is left blank the person is asked for at first
   * sign-in.
   */
  locale?: string | null;
}

export interface InviteListQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: InviteStatus | "all";
}

export interface InviteListResponse {
  items: CustomerInvite[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<InviteStatus, number>;
  /**
   * False when invitations cannot be sent from this deployment: the customer
   * pool is not configured or AWS credentials are missing. The page then
   * shows why instead of a form.
   */
  canSend: boolean;
  /** A one-line reason when `canSend` is false. */
  unavailableReason: string | null;
}

/* -------------------------------------------------------------------------- */
/*                            Customer statistics                             */
/* -------------------------------------------------------------------------- */

/**
 * Everything the Activity view shows, and the vocabulary the churn and
 * retention arithmetic is written in.
 *
 * Three databases-worth of facts meet here and it matters which is which,
 * because they count slightly different populations:
 *
 * - the **customer Cognito pool**, as the nightly `cognito_directory` job
 *   recorded it in `admin_customer_snapshots` — every account that exists,
 *   including people who were invited and never signed in;
 * - `admin_customer_events` — what happened to those accounts, including the
 *   ones that no longer exist, which is the only place a deletion is
 *   recorded at all;
 * - the **main app database** — `users`, `usage_daily`, `tenants` and the
 *   tenant tables: who actually uses the product, how much, and how much data
 *   they hold.
 *
 * Where a figure could come from either, the type says which one it does come
 * from. Nothing here is a live AWS call: the pool figures are as fresh as last
 * night's job.
 */

/**
 * The integration whose nightly run fills the three history tables. Named
 * here so the page, the service and the SQL seed cannot spell it differently.
 */
export const DIRECTORY_INTEGRATION_KEY = "cognito_directory";

/**
 * How many days of CloudWatch metrics one `cognito_directory` run re-fetches,
 * ending yesterday. Every day in the window is replaced, so a figure that
 * arrived late is corrected rather than frozen; `GetMetricData` charges
 * nothing, so a wider window costs only a slightly larger response.
 */
export const POOL_METRICS_DAYS_DEFAULT = 35;

/**
 * The ceiling. CloudWatch keeps metrics at a one-day period for 15 months, so
 * a longer window could only ask for data that no longer exists.
 */
export const POOL_METRICS_DAYS_MAX = 450;

/**
 * How far back the nightly sweep looks for consumer-app account deletions
 * (`users.deleted_at`). A week, so several missed nights still cost nothing —
 * the events are deduped by `UNIQUE (sub, event, at)`, so re-reading the same
 * deletions writes nothing.
 */
export const DELETED_IN_APP_LOOKBACK_DAYS = 7;

/** The most deletions one sweep records, so a mass deletion stays bounded. */
export const DELETED_IN_APP_MAX = 500;

/** How many days without a sign-in still counts as a monthly active user. */
export const MAU_WINDOW_DAYS = 30;
/** The weekly active window. */
export const WAU_WINDOW_DAYS = 7;
/** The daily active window. A day, not "today": nobody is active at 00:05. */
export const DAU_WINDOW_DAYS = 1;

/** How many months of monthly series the statistics endpoint will answer for. */
export const STATISTICS_MONTHS_DEFAULT = 6;
export const STATISTICS_MONTHS_MAX = 24;

/** How many days of daily series (pool metrics, usage) it will answer for. */
export const STATISTICS_DAYS_DEFAULT = 35;
export const STATISTICS_DAYS_MAX = 400;

/** How many days of per-customer usage the activity endpoint returns. */
export const ACTIVITY_DAYS = 35;

/** How many tenants the "largest tenants" tables list. */
export const LARGEST_TENANTS_LIMIT = 10;

/** How many lifecycle events one customer's activity carries. */
export const ACTIVITY_EVENTS_MAX = 50;

/** The lifecycle events `admin_customer_events` records. */
export const CUSTOMER_EVENTS = [
  "invited",
  "confirmed",
  "disabled",
  "enabled",
  "deleted",
  "reappeared",
  "deleted_in_app",
] as const;

export type CustomerEventKind = (typeof CUSTOMER_EVENTS)[number];

export function isCustomerEventKind(value: string): value is CustomerEventKind {
  return (CUSTOMER_EVENTS as readonly string[]).includes(value);
}

/** Who recorded the event. */
export const CUSTOMER_EVENT_SOURCES = ["console", "directory_diff", "main_db"] as const;

export type CustomerEventSource = (typeof CUSTOMER_EVENT_SOURCES)[number];

/** One row of the lifecycle log. */
export interface CustomerEvent {
  id: string;
  /** The Cognito `sub`; the account itself may no longer exist. */
  sub: string;
  event: CustomerEventKind;
  at: string;
  source: CustomerEventSource;
  /** Whatever the writer knew. Never a credential. */
  details: Record<string, unknown> | null;
}

/** `{ month: "2026-09", count: 3 }`. Months are UTC calendar months. */
export interface MonthCount {
  /** `YYYY-MM`. */
  month: string;
  count: number;
}

/**
 * One month of churn.
 *
 * `churnPct` is `deleted ÷ activeAtStart × 100`, and `null` when
 * `activeAtStart` is 0 — a month that began with no customers has no churn
 * rate, and reporting 0 % would be a measurement where there is none.
 */
export interface ChurnMonth {
  month: string;
  /** Departures: `deleted` and `deleted_in_app` events, deduped per sub. */
  deleted: number;
  /**
   * The denominator: customers who existed and were not yet deleted at 00:00
   * UTC on the 1st, plus anyone seen in the 30 days before that.
   */
  activeAtStart: number;
  churnPct: number | null;
}

/** One sign-up cohort and how much of it is still around. */
export interface RetentionMonth {
  /** The month the cohort signed up in, `YYYY-MM`. */
  month: string;
  /** Everyone who signed up that month, deleted accounts included. */
  cohort: number;
  /** How many of them have a `last_seen_at` inside the last 30 days. */
  retained: number;
  /** `retained ÷ cohort × 100`; `null` for an empty cohort. */
  retainedPct: number | null;
}

/**
 * Where a new customer stalls. Each step is a subset of the one above it in
 * spirit, but not by construction — the first two are counted in the Cognito
 * pool and the last three in the app database, so an operator who deleted a
 * `users` row by hand could make the funnel widen. It is drawn as measured
 * rather than forced monotonic, because a funnel that has been "corrected"
 * hides exactly that kind of problem.
 */
export interface CustomerFunnel {
  /** Accounts in the pool's newest snapshot. There is no self-service sign-up. */
  invited: number;
  /** Of those, the ones whose status is `confirmed`: they set their password. */
  confirmed: number;
  /** Live `users` rows with at least one live `user_tenants` row. */
  onboarded: number;
  /** Of those, the ones whose tenant holds at least one live transaction. */
  firstTransaction: number;
  /** Of those, the ones whose tenant holds at least one live file blob. */
  firstAttachment: number;
  /** The snapshot day the first two figures come from; null when there is none. */
  snapshotDay: string | null;
}

/** One day of the pool's CloudWatch counters. */
export interface PoolMetricsDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  signIns: number;
  /** Attempts, successful or not. `attempts - signIns` is the failures. */
  signInAttempts: number;
  signUps: number;
  tokenRefreshes: number;
  throttles: number;
}

/** One day of `usage_daily`, summed over every tenant. */
export interface UsageDay {
  day: string;
  requests: number;
  errors: number;
  syncRows: number;
  bytesUploaded: number;
}

/** One tenant in the "largest tenants" tables. */
export interface TenantSize {
  tenantId: string;
  /** Null when the tenant row is gone but its data is not. */
  name: string | null;
  /** Live `file_blobs.byte_size`, summed. */
  bytes: number;
  /** Live `transactions` rows. */
  transactions: number;
}

/** Accounts as the newest directory snapshot saw them. */
export interface AccountCensus {
  total: number;
  /** Cognito status (lower-cased) to count. Empty when there is no snapshot. */
  byStatus: Record<string, number>;
  /** Accounts the pool has switched off. */
  disabled: number;
  /** The snapshot day, `YYYY-MM-DD`; null when the job has never run. */
  snapshotDay: string | null;
}

/** `GET /api/v1/admin/customers/statistics`. */
export interface CustomerStatistics {
  accounts: AccountCensus;
  /** Distinct live `users` rows with `last_seen_at` inside the window. */
  mau: number;
  wau: number;
  dau: number;
  /** New `users` rows per month: people who reached the app, not invitations. */
  newPerMonth: MonthCount[];
  /** `deleted` + `deleted_in_app` events, deduped per sub per month. */
  deletedPerMonth: MonthCount[];
  churnPerMonth: ChurnMonth[];
  retentionBySignupMonth: RetentionMonth[];
  funnel: CustomerFunnel;
  /** The last `days` days of `admin_pool_metrics_daily`, oldest first. */
  poolMetrics: PoolMetricsDay[];
  usage: {
    requestsPerDay: UsageDay[];
    /** The same days, carried separately so a chart can take one array. */
    errorsPerDay: UsageDay[];
  };
  largestTenants: {
    byBytes: TenantSize[];
    byTransactions: TenantSize[];
  };
  /** The window the monthly series cover, and the daily one. */
  months: number;
  days: number;
  /** When the answer was assembled, so the page can say how fresh it is. */
  generatedAt: string;
}

/** The five figures the Overview's customer card needs, and nothing else. */
export interface CustomerHeadline {
  accountsTotal: number;
  mau: number;
  newThisMonth: number;
  deletedThisMonth: number;
  /** This month's churn so far, or null when the month began with nobody. */
  churnPct: number | null;
}

/** The size of one customer's tenants, for the activity drawer. */
export interface CustomerTenantSize {
  tenantId: string;
  name: string | null;
  transactions: number;
  accounts: number;
  documents: number;
  bytes: number;
}

/** `GET /api/v1/admin/customers/[id]/activity`. */
export interface CustomerActivity {
  /** `users.id` in the main app database. */
  userId: string;
  cognitoSub: string;
  email: string;
  /** `users.last_seen_at`; null when they have not signed in since it existed. */
  lastSeenAt: string | null;
  /** The `lastActiveAt` fallback, so the drawer can show both. */
  lastActiveAt: string | null;
  createdAt: string | null;
  deletedAt: string | null;
  /** The last `ACTIVITY_DAYS` days of this person's `usage_daily` rows. */
  usage: UsageDay[];
  /** One row per tenant they belong to. */
  tenants: CustomerTenantSize[];
  /** Every lifecycle event recorded for their sub, newest first. */
  events: CustomerEvent[];
  days: number;
}
