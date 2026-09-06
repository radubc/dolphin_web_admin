import type { Metadata } from "next";
import AccessMapPage from "@/components/access-map/access-map-page";
import { requirePageAccess } from "@/lib/admin-access/authorize";
import { capabilitiesOf } from "@/lib/admin-access/types";

export const metadata: Metadata = {
  title: "Access Map · Penny Squeeze Admin",
};

/** The Access Map route: gated by its own rule, like every page. */
export default async function Page() {
  const { principal } = await requirePageAccess("access_map");

  return <AccessMapPage capabilities={capabilitiesOf(principal)} />;
}
