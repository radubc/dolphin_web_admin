/**
 * /api/v1/admin/customers/[id] — one customer by `users.id` (main app
 * database), with their tenants, activity figures, pool account and
 * two-factor settings.
 *
 * `invites` is a static segment under the same parent and Next matches it
 * ahead of `[id]`, so an id can never swallow the invitations route.
 *
 * The answer also says whether *this operator* may turn the customer's
 * two-factor authentication off (`operatorCanReset`), which is a fact about
 * the caller's own session — how it was signed in — rather than about the
 * customer. It is read from the session `adminHandler` authenticated the
 * request with, so the drawer can show the button or the explanation without
 * a second round trip; a bearer-token caller has no such claim and reads as
 * password-only.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { getCustomer } from "@/lib/customers/service";

type Ctx = RouteContext<"/api/v1/admin/customers/[id]">;

export const GET = adminHandler<Ctx>(
  async (_request, ctx, _principal, session) => {
    const { id } = await ctx.params;
    return ok(await getCustomer(id, session.signInMethod));
  },
  { endpoint: "admin.customers.get" },
);
