import type { Metadata } from "next";
import PageHeader from "@/components/page-header";
import { requirePageAccess } from "@/lib/admin-access/authorize";

export const metadata: Metadata = {
  title: "Support · Penny Squeeze Admin",
};

/**
 * The Support route. Blank for now: the header band is the only content, so the
 * rail, the tab highlight and the page chrome can be judged before the page
 * itself is designed.
 */
export default async function Page() {
  await requirePageAccess("support");

  return <PageHeader title="Support" caption="Support tickets and the help desk." />;
}
