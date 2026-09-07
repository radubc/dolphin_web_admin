/**
 * /api/v1/admin/customers/invites/[id]/resend — sends the invitation email
 * again for an invitation nobody has acted on yet.
 *
 * Cognito re-issues the temporary password (`MessageAction: "RESEND"`); the
 * row's `sendCount` and `lastSentAt` move. An invitation that is accepted,
 * revoked or failed is a 409: there is nothing to resend.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { resendCustomerInvite } from "@/lib/customers/service";

type Ctx = RouteContext<"/api/v1/admin/customers/invites/[id]/resend">;

export const POST = adminHandler<Ctx>(
  async (_request, ctx, principal) => {
    const { id } = await ctx.params;
    return ok(await resendCustomerInvite(id, principal.user.id));
  },
  { endpoint: "admin.customers.invites.resend" },
);
