/**
 * /api/v1/admin/customers/invites/[id] — one invitation.
 *
 * DELETE withdraws it: the unused pool account is deleted and the row is kept
 * as `revoked`, so the record of who invited whom survives. Only an open
 * invitation can be withdrawn — once the person has signed in they are a
 * customer, and deleting a confirmed account is a 409, not something this
 * endpoint does.
 *
 * The answer is the updated invitation rather than 204: the page redraws the
 * row from it.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { revokeCustomerInvite } from "@/lib/customers/service";

type Ctx = RouteContext<"/api/v1/admin/customers/invites/[id]">;

export const DELETE = adminHandler<Ctx>(
  async (_request, ctx, principal) => {
    const { id } = await ctx.params;
    return ok(await revokeCustomerInvite(id, principal.user.id));
  },
  { endpoint: "admin.customers.invites.revoke" },
);
