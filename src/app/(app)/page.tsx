import type { Metadata } from "next";
import PageHeader from "@/components/page-header";
import CostCard from "@/components/overview/cost-card";
import CustomersCard from "@/components/overview/customers-card";
import DeploymentsCard from "@/components/overview/deployments-card";
import FunnelCard from "@/components/overview/funnel-card";
import OperationsCard from "@/components/overview/operations-card";
import TenantsCard from "@/components/overview/tenants-card";
import { requirePageAccess } from "@/lib/admin-access/authorize";
import { getCostDaily, getCostSummary } from "@/lib/costs/service";
import { customerHeadline } from "@/lib/customers/statistics";
import { getDeployHealth } from "@/lib/ops/deploy";
import { getOperationsMetrics } from "@/lib/ops/metrics";
import { overviewFunnel, overviewLargestTenants } from "@/lib/ops/overview";
import { loadedFrom } from "@/lib/ops/types";

export const metadata: Metadata = {
  title: "Overview · Penny Squeeze Admin",
};

/**
 * The Overview route: the first tab on the rail, where sign-in lands, and the
 * one page in this console that answers "is anything wrong" without being
 * asked a question.
 *
 * **Rendered on the server, in one pass.** Every card's data is a `src/lib/*`
 * function called directly — never a `fetch` of this app's own API, which
 * would cost a round trip and re-authenticate an operator who is already
 * authenticated here. `Promise.allSettled` runs the seven reads concurrently
 * and, crucially, *independently*: the admin database being down costs the
 * cost and funnel cards, no AWS credentials costs the operations and
 * deployment cards, and everything else still renders. Nothing on this page is
 * interactive and it holds no state, so the whole dashboard ships no client
 * JavaScript of its own; a refresh is the browser's refresh.
 *
 * **Cost.** Two of the reads call AWS — `GetMetricData` and
 * `DescribeServices`, both free, both cached in-process for 60 seconds
 * (`src/lib/ops/cache.ts`). Nothing here calls Cost Explorer, which charges
 * per request: the cost figures are the rows the daily `aws_costs` job
 * cached. The customer reads are the deliberately cheap subset —
 * `customerHeadline()` and the two accessors in `src/lib/ops/overview.ts` —
 * rather than the Activity view's full statistics.
 *
 * **What a failing card says.** Each read is handed to `loadedFrom` with the
 * source it read from. An AWS failure prints AWS's own sentence, which is the
 * one that ends the investigation; a database failure prints which database
 * could not be read, because an ORM's own message is a paragraph of
 * connection and model detail that belongs in the server log — where
 * `loadedFrom` puts it, with the read's name.
 *
 * **Layout.** A 12-column grid that scrolls in the shell's `<main>`, as this
 * page always has. Not `ListPageFrame`: that frame exists so a table's rows
 * are the only thing that moves, and there is no table here. Cards stack into
 * one column below 1024px.
 */
export default async function Page() {
  await requirePageAccess("overview");

  const [summary, daily, headline, funnel, tenants, metrics, deploy] = await Promise.allSettled([
    getCostSummary(),
    // Two days is all the "yesterday" figure needs; the 35-day chart lives on
    // the Cost center page.
    getCostDaily(2),
    customerHeadline(),
    overviewFunnel(),
    overviewLargestTenants(),
    getOperationsMetrics(),
    getDeployHealth(),
  ]);

  return (
    <>
      <PageHeader
        title="Overview"
        caption="Spend, customers and the state of the deployment, at a glance."
      />

      <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-12">
        {/* Each read says where it read from, so a failure is reported as a
            sentence a reader can act on — "The admin database could not be
            read" rather than a Prisma paragraph — and the detail is logged
            server-side. AWS failures keep AWS's own message. */}
        <CostCard
          summary={loadedFrom(summary, { what: "cost summary", source: "admin-db" })}
          daily={loadedFrom(daily, { what: "daily costs", source: "admin-db" })}
          className="lg:col-span-4"
        />
        <CustomersCard
          headline={loadedFrom(headline, { what: "customer headline", source: "both-db" })}
          className="lg:col-span-4"
        />
        <FunnelCard
          funnel={loadedFrom(funnel, { what: "activity funnel", source: "both-db" })}
          className="lg:col-span-4"
        />

        {/* Operations is the tall card: eight columns and two grid rows, with
            Deployments and Largest tenants stacked in the four beside it. */}
        <OperationsCard
          metrics={loadedFrom(metrics, { what: "operations metrics", source: "aws" })}
          className="lg:col-span-8 lg:row-span-2 lg:self-start"
        />
        <DeploymentsCard
          deploy={loadedFrom(deploy, { what: "deployment health", source: "aws" })}
          className="lg:col-span-4 lg:self-start"
        />
        <TenantsCard
          tenants={loadedFrom(tenants, { what: "largest tenants", source: "main-db" })}
          className="lg:col-span-4 lg:self-start"
        />
      </div>
    </>
  );
}
