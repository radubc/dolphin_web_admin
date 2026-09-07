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
  CustomerInvite,
  CustomerListQuery,
  CustomerListResponse,
  CreateInviteInput,
  InviteListQuery,
  InviteListResponse,
} from "./types";

const BASE = "/api/v1/admin/customers";
const INVITES = `${BASE}/invites`;

/** Which of the page's two lists a change touched. */
export type CustomersScope = "customers" | "invites";

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
