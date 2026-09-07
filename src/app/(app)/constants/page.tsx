import type { Metadata } from "next";
import ConstantsPage from "@/components/constants/constants-page";
import { requirePageAccess } from "@/lib/admin-access/authorize";
import { capabilitiesOf } from "@/lib/admin-access/types";
import { isConstantKind } from "@/lib/constants/types";

export const metadata: Metadata = {
  title: "Constants · Penny Squeeze Admin",
};

/**
 * The Constants route: the reference catalogs the admin database masters,
 * and their state against the main app database.
 *
 * `?kind=` names the catalog to open on, so a link can point at one of them.
 * It is read here rather than with `useSearchParams` because the page is
 * already dynamic — `requirePageAccess` reads the session cookie — and reading
 * it on the server keeps the client component free of a Suspense boundary.
 */
export default async function Page({ searchParams }: PageProps<"/constants">) {
  const { principal } = await requirePageAccess("constants");

  // `searchParams` is a promise in Next 16, and a repeated param arrives as an
  // array, which is not a kind.
  const { kind } = await searchParams;
  const initialKind = typeof kind === "string" && isConstantKind(kind) ? kind : undefined;

  return <ConstantsPage capabilities={capabilitiesOf(principal)} initialKind={initialKind} />;
}
