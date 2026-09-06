import type { Metadata } from "next";
import PageHeader from "@/components/page-header";
import { requirePageAccess } from "@/lib/admin-access/authorize";

export const metadata: Metadata = {
  title: "Overview · Penny Squeeze Admin",
};

/**
 * The Overview route: the first tab on the rail and where sign-in lands.
 * Blank for now: the header band is the only content, so the rail, the tab
 * highlight and the page chrome can be judged before the page is designed.
 */
export default async function Page() {
  await requirePageAccess("overview");

  return <PageHeader title="Overview" caption="At a glance." />;
}
