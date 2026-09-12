/**
 * /api/v1/admin/costs — the Cost center's summary.
 *
 * `{ snapshot, byService, byComponent, lastRun }`, all of it read from
 * `admin_cost_daily` and `admin_cost_snapshots`. **This endpoint never calls
 * AWS**: Cost Explorer charges $0.01 per request, so the `aws_costs`
 * integration asks once a day and everything here is the cache. Refreshing
 * is a separate, deliberate act — `POST
 * /api/v1/admin/integrations/aws_costs/run`.
 *
 * Every field may be empty. A deployment where docs/sql/013_aws_costs.sql has
 * run but the job has not answers `{ snapshot: null, byService: [],
 * byComponent: [], lastRun: null }`, which the page reports as "no data yet"
 * rather than as zero spend. Before that SQL has run it is a 503
 * `admin_schema_missing`, like every other feature's list.
 *
 * No query string: the windows are fixed (month to date and the 30 days
 * ending yesterday) so the page and the job cannot disagree about them. The
 * bar chart's range is the other endpoint's `?days=`.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { getCostSummary } from "@/lib/costs/service";

export const GET = adminHandler(
  async () => {
    return ok(await getCostSummary());
  },
  { endpoint: "admin.costs.summary" },
);
