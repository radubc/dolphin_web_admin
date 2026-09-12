import type { Metadata } from "next";
import { Empty } from "antd";
import PageHeader from "@/components/page-header";
import { requirePageAccess } from "@/lib/admin-access/authorize";

export const metadata: Metadata = {
  title: "Marketing · Penny Squeeze Admin",
};

/**
 * The Marketing route. Blank for now: campaigns and acquisition have no
 * design yet, so the header band and a placeholder are the only content.
 */
export default async function Page() {
  await requirePageAccess("marketing");

  return (
    <>
      <PageHeader title="Marketing" caption="Campaigns and acquisition. Not built yet." />
      <div className="p-5">
        <Empty description="Nothing here yet." />
      </div>
    </>
  );
}
