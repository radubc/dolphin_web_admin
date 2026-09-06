import type { Metadata } from "next";
import PageHeader from "@/components/page-header";
import { requirePageAccess } from "@/lib/admin-access/authorize";

export const metadata: Metadata = {
  title: "Constants · Penny Squeeze Admin",
};

/**
 * The Constants route. Blank for now: the header band is the only content, so the
 * rail, the tab highlight and the page chrome can be judged before the page
 * itself is designed.
 */
export default async function Page() {
  await requirePageAccess("constants");

  return <PageHeader title="Constants" caption="Reference data shared by every tenant." />;
}
