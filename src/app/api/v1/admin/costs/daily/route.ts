/**
 * /api/v1/admin/costs/daily — the daily cost series behind the bar chart.
 *
 * `[{ day, totalUsd, estimated, services }]`, oldest first, ending yesterday:
 * nothing is reported for today, whose spend AWS has not totalled.
 * `?days=` (1..400, default 35) says how far back to go; a day AWS reported
 * nothing for is simply absent rather than sent as a zero.
 *
 * Read from `admin_cost_daily` only — this endpoint never calls AWS. See
 * `/api/v1/admin/costs`.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";
import { costDailyQuerySchema } from "@/lib/costs/schemas";
import { getCostDaily } from "@/lib/costs/service";

export const GET = adminHandler(
  async (request) => {
    const { days } = parseSearchParams(request.nextUrl, costDailyQuerySchema);
    return ok(await getCostDaily(days));
  },
  { endpoint: "admin.costs.daily" },
);
