import type { Metadata } from "next";
import ServicesPage from "@/components/services/services-page";
import { requirePageAccess } from "@/lib/admin-access/authorize";
import { capabilitiesOf } from "@/lib/admin-access/types";

export const metadata: Metadata = {
  title: "Services · Penny Squeeze Admin",
};

/** The Services route: the endpoint catalog with limits and usage. */
export default async function Page() {
  const { principal } = await requirePageAccess("services");

  return <ServicesPage capabilities={capabilitiesOf(principal)} />;
}
