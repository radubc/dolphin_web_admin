import type { Metadata } from "next";
import CustomersPage from "@/components/customers/customers-page";
import { isCustomersView } from "@/components/customers/views";
import { requirePageAccess } from "@/lib/admin-access/authorize";
import { capabilitiesOf } from "@/lib/admin-access/types";

export const metadata: Metadata = {
  title: "Customers · Penny Squeeze Admin",
};

/**
 * The Customers route: the consumer app's users, and the invitations that
 * created their accounts.
 *
 * `?view=` names the view to open on — `customers` or `invites` — so a link can
 * point at either. It is read here rather than with `useSearchParams` because
 * the page is already dynamic — `requirePageAccess` reads the session cookie —
 * and reading it on the server keeps the client component free of a Suspense
 * boundary.
 */
export default async function Page({ searchParams }: PageProps<"/customers">) {
  const { principal } = await requirePageAccess("customers");

  // `searchParams` is a promise in Next 16, and a repeated param arrives as an
  // array, which is not a view.
  const { view } = await searchParams;
  const initialView = typeof view === "string" && isCustomersView(view) ? view : undefined;

  return <CustomersPage capabilities={capabilitiesOf(principal)} initialView={initialView} />;
}
