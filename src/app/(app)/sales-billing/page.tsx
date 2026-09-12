import type { Metadata } from "next";
import { Empty } from "antd";
import PageHeader from "@/components/page-header";
import { requirePageAccess } from "@/lib/admin-access/authorize";

export const metadata: Metadata = {
  title: "Sales and Billing · Penny Squeeze Admin",
};

/**
 * The Sales and Billing route. Blank for now: subscriptions, invoices and
 * revenue have no design yet, so the header band and a placeholder are the
 * only content.
 */
export default async function Page() {
  await requirePageAccess("sales_billing");

  return (
    <>
      <PageHeader title="Sales and Billing" caption="Subscriptions, invoices and revenue. Not built yet." />
      <div className="p-5">
        <Empty description="Nothing here yet." />
      </div>
    </>
  );
}
