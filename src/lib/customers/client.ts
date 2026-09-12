/**
 * The browser's typed calls to `/api/v1/admin/customers/*`. Client-safe: no
 * `server-only` imports, only `apiFetch` and the plain types.
 *
 * Every mutation announces a change on `window`, the same way the integrations
 * and admin-access clients do, so a table that did not make the call can
 * reload. The announcement carries a *scope*, because the page shows two lists
 * that answer different questions — the customers themselves, read from the
 * main app database, and the invitations, recorded in the admin database — and
 * an invitation being resent has nothing to say to the customer table.
 *
 * Only the invite calls write anything: customers are read-only from here (the
 * consumer app owns those rows), so the `customers` scope exists for the
 * refresh path and for whatever writes the page grows later.
 */
import { apiFetch } from "@/lib/api/client";
import type {
  Customer,
  CustomerActivity,
  CustomerInvite,
  CustomerListQuery,
  CustomerListResponse,
  CustomerStatistics,
  CreateInviteInput,
  InviteListQuery,
  InviteListResponse,
} from "./types";
import { STATISTICS_DAYS_DEFAULT, STATISTICS_MONTHS_DEFAULT } from "./types";

const BASE = "/api/v1/admin/customers";
const INVITES = `${BASE}/invites`;

/**
 * Which part of the page a change touched.
 *
 * `statistics` is here for completeness: nothing writes those figures from the
 * browser — they are filled by the nightly `cognito_directory` run — but a
 * "Refresh now" that starts that run announces the scope so the Activity view
 * reloads when it lands, exactly as the Cost center does.
 */
export type CustomersScope = "customers" | "invites" | "statistics";

/** Fired on `window` after any customers write succeeds. */
export const CUSTOMERS_CHANGED_EVENT = "penny-squeeze:customers-changed";

export function notifyCustomersChanged(scope: CustomersScope): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<CustomersScope>(CUSTOMERS_CHANGED_EVENT, { detail: scope }));
  }
}

/** Subscribes to change announcements; returns the unsubscribe. */
export function onCustomersChanged(listener: (scope: CustomersScope) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => listener((event as CustomEvent<CustomersScope>).detail);
  window.addEventListener(CUSTOMERS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(CUSTOMERS_CHANGED_EVENT, handler);
}

/** Paging, search and the filters, as the customer list endpoint accepts them. */
function customerSearch(query: CustomerListQuery): string {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.q !== undefined && query.q.trim() !== "") params.set("q", query.q.trim());
  if (query.status !== undefined && query.status !== "all") params.set("status", query.status);
  // Only sent when on: the server's default is "live rows only".
  if (query.includeDeleted === true) params.set("includeDeleted", "true");
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** The same for the invitations list, which has no deleted rows to hide. */
function inviteSearch(query: InviteListQuery): string {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.q !== undefined && query.q.trim() !== "") params.set("q", query.q.trim());
  if (query.status !== undefined && query.status !== "all") params.set("status", query.status);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

const invitePath = (id: string) => `${INVITES}/${encodeURIComponent(id)}`;

export const customersApi = {
  /** One page of customers, with the whole-list counts and the pool's reachability. */
  list: (query: CustomerListQuery = {}) =>
    apiFetch<CustomerListResponse>(`${BASE}${customerSearch(query)}`),

  /** One customer, freshly read, for the detail drawer. */
  get: (id: string) => apiFetch<Customer>(`${BASE}/${encodeURIComponent(id)}`),

  /**
   * The Activity view's figures. `months` sizes the monthly series (churn,
   * retention, new and deleted); `days` sizes the two daily ones (the pool's
   * sign-in counters and `usage_daily`). Both are capped by the server.
   *
   * 503 `admin_schema_missing` until `docs/sql/014_customer_statistics.sql`
   * has been run. Afterwards the pool-derived sections stay empty until the
   * nightly job has succeeded once, while the app-side figures answer
   * straight away.
   */
  statistics: (
    query: { months?: number; days?: number } = {},
  ) => {
    const params = new URLSearchParams({
      months: String(query.months ?? STATISTICS_MONTHS_DEFAULT),
      days: String(query.days ?? STATISTICS_DAYS_DEFAULT),
    });
    return apiFetch<CustomerStatistics>(`${BASE}/statistics?${params.toString()}`);
  },

  /** One customer's own usage, tenant sizes and lifecycle events. */
  activity: (id: string) =>
    apiFetch<CustomerActivity>(`${BASE}/${encodeURIComponent(id)}/activity`),

  invites: {
    list: (query: InviteListQuery = {}) =>
      apiFetch<InviteListResponse>(`${INVITES}${inviteSearch(query)}`),

    /**
     * Creates the Cognito account and lets the pool email the temporary
     * password. The API answers 409 when the address already has an account or
     * a live invitation, and 503 `cognito_unavailable` when this deployment
     * cannot reach the pool; both arrive as an `ApiClientError` the caller
     * shows in the server's own words.
     */
    create: async (input: CreateInviteInput) => {
      const invite = await apiFetch<CustomerInvite>(INVITES, { method: "POST", json: input });
      notifyCustomersChanged("invites");
      return invite;
    },

    /** Sends the invitation email again, with a fresh temporary password. */
    resend: async (id: string) => {
      const invite = await apiFetch<CustomerInvite>(`${invitePath(id)}/resend`, { method: "POST" });
      notifyCustomersChanged("invites");
      return invite;
    },

    /**
     * Withdraws an unaccepted invitation: the pool account is deleted and the
     * row is kept as `revoked`, so the same address can be invited again later.
     */
    revoke: async (id: string) => {
      const invite = await apiFetch<CustomerInvite>(invitePath(id), { method: "DELETE" });
      notifyCustomersChanged("invites");
      return invite;
    },
  },
};
