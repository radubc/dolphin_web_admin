/**
 * /api/v1/admin/customers/[id] — one customer by `users.id` (main app
 * database), with their tenants, activity figures and pool account.
 *
 * `invites` is a static segment under the same parent and Next matches it
 * ahead of `[id]`, so an id can never swallow the invitations route.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { getCustomer } from "@/lib/customers/service";

type Ctx = RouteContext<"/api/v1/admin/customers/[id]">;

export const GET = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { id } = await ctx.params;
    return ok(await getCustomer(id));
  },
  { endpoint: "admin.customers.get" },
);
