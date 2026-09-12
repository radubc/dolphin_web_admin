/**
 * /api/v1/admin/customers/statistics — the Activity view's figures.
 *
 * Accounts by status, DAU/WAU/MAU, new and deleted per month, churn,
 * retention by sign-up cohort, the invitation funnel, the pool's daily
 * sign-in counters, request and error volume, and the largest tenants.
 * `?months=` (1..24, default 6) sizes the monthly series and `?days=`
 * (1..400, default 35) the two daily ones.
 *
 * **This endpoint never calls AWS.** The pool-derived figures are read from
 * the history tables the nightly `cognito_directory` integration fills, and
 * the rest from the main app database; a page that asked Cognito on every
 * load could not answer the questions on it at all, since Cognito keeps no
 * history. Taking a fresh snapshot is a separate, deliberate act — `POST
 * /api/v1/admin/integrations/cognito_directory/run`, and it is free.
 *
 * Every section may be empty. Before `docs/sql/014_customer_statistics.sql`
 * has been run it is a 503 `admin_schema_missing`, like every other feature's
 * list. After it, but before the job's first success, the account census, the
 * funnel head and the pool metrics are empty while the app-side figures
 * answer normally; the page says which half is missing rather than drawing
 * zeros as measurements.
 *
 * `statistics` is a static segment under the same parent as `[id]`, and Next
 * matches it first — the same arrangement `invites` already relies on — so a
 * customer id can never swallow this route.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";
import { customerStatisticsQuerySchema } from "@/lib/customers/schemas";
import { getCustomerStatistics } from "@/lib/customers/statistics";

export const GET = adminHandler(
  async (request) => {
    const query = parseSearchParams(request.nextUrl, customerStatisticsQuerySchema);
    return ok(await getCustomerStatistics(query));
  },
  { endpoint: "admin.customers.statistics" },
);
