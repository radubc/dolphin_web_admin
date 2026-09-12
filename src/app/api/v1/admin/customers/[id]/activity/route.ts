/**
 * /api/v1/admin/customers/[id]/activity — one customer, in depth.
 *
 * When they were last seen (`users.last_seen_at`), their own daily request,
 * error, sync-row and upload counters for the last 35 days (`usage_daily`),
 * the size of each tenant they belong to, and every lifecycle event recorded
 * against their Cognito sub — including the events that outlived a deleted
 * account, which is the only place a departure is visible at all.
 *
 * No query string: the windows are fixed so the drawer and the Activity view
 * cannot disagree about them. Reads the main app database and the admin
 * database; never calls AWS.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { getCustomerActivity } from "@/lib/customers/statistics";

type Ctx = RouteContext<"/api/v1/admin/customers/[id]/activity">;

export const GET = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { id } = await ctx.params;
    return ok(await getCustomerActivity(id));
  },
  { endpoint: "admin.customers.activity" },
);
