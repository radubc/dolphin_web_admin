import type { Metadata } from "next";
import IntegrationsPage from "@/components/integrations/integrations-page";
import { requirePageAccess } from "@/lib/admin-access/authorize";
import { capabilitiesOf } from "@/lib/admin-access/types";
import { isIntegrationsView } from "@/lib/integrations/types";

export const metadata: Metadata = {
  title: "Integrations · Penny Squeeze Admin",
};

/**
 * The Integrations route: the external providers this app calls on a schedule,
 * and the two watch lists their runs work through.
 *
 * `?view=` names the view to open on — `integrations`, `quotes` or `rates` — so
 * a link can point at one of them. It is read here rather than with
 * `useSearchParams` because the page is already dynamic — `requirePageAccess`
 * reads the session cookie — and reading it on the server keeps the client
 * component free of a Suspense boundary.
 */
export default async function Page({ searchParams }: PageProps<"/integrations">) {
  const { principal } = await requirePageAccess("integrations");

  // `searchParams` is a promise in Next 16, and a repeated param arrives as an
  // array, which is not a view.
  const { view } = await searchParams;
  const initialView = typeof view === "string" && isIntegrationsView(view) ? view : undefined;

  return <IntegrationsPage capabilities={capabilitiesOf(principal)} initialView={initialView} />;
}
