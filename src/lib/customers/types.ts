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
 * - `no_account` — a `users` row with no matching pool account (deleted in
 *   the pool, or a different pool);
 * - `unknown` — the pool was not consulted.
 */
export type CustomerStatus = "active" | "invited" | "disabled" | "no_account" | "unknown";

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
   */
  lastActiveAt: string | null;
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
