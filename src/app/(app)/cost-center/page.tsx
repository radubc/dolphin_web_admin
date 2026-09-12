import type { Metadata } from "next";
import CostCenterPage from "@/components/cost-center/cost-center-page";
import { requirePageAccess } from "@/lib/admin-access/authorize";
import { capabilitiesOf } from "@/lib/admin-access/types";

export const metadata: Metadata = {
  title: "Cost center · Penny Squeeze Admin",
};

/**
 * The Cost center route: AWS spend from Cost Explorer, cached daily by the
 * `aws_costs` integration, and — once the consumer app records usage per
 * tenant — the allocated cost per client.
 *
 * No `PageHeader` here: `CostCenterPage` wears `ListPageFrame`, which owns
 * the sticky band (title, caption, figures) and the ribbon, exactly as
 * Customers, Constants and Services do. A second header above the frame would
 * duplicate the title and push the frame — which is pinned to the shell's
 * content area — past the bottom of it.
 *
 * The operator's capabilities go down with it, as on Integrations and
 * Customers: "Refresh now" starts an `aws_costs` run and spends real money at
 * Cost Explorer, so the control is drawn only for whoever
 * `can_write_integrations` allows. That is presentation only — the run
 * endpoint checks the same action again — but a button that always 403s is
 * worse than no button.
 */
export default async function Page() {
  const { principal } = await requirePageAccess("cost_center");

  return <CostCenterPage capabilities={capabilitiesOf(principal)} />;
}
