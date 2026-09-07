/**
 * The two views of the Customers screen, and the guard that reads one out of
 * `?view=`.
 *
 * Plain data with no `"use client"` and no antd, so the Server Component at
 * `src/app/(app)/customers/page.tsx` can validate the query string before it
 * hands the value to the client tree. It does not live in
 * `src/lib/customers/types.ts` because that file is the API contract; which
 * screen is on top is the shell's business, not the server's.
 */

export type CustomersViewKey = "customers" | "invites";

export const CUSTOMERS_VIEWS: readonly CustomersViewKey[] = ["customers", "invites"];

export function isCustomersView(value: string): value is CustomersViewKey {
  return (CUSTOMERS_VIEWS as readonly string[]).includes(value);
}
