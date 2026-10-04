/**
 * POST /api/v1/admin/customers/[id]/two-factor/reset — turns a customer's
 * two-factor authentication off (`docs/customers.md`, "Turning off a
 * customer's two-factor authentication").
 *
 * No body. One `AdminSetUserMFAPreference` on the customer pool with both
 * per-user settings off; nothing else about the account changes. Refused with
 * 403 unless the operator's own session was signed in with a second factor
 * (the authenticator code or a passkey) — read from the session
 * `adminHandler` authenticated the request with, so a bearer-token caller,
 * which has no such claim, is refused too. Five per hour per operator; one
 * audit row per attempt that reaches Cognito.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { resetCustomerTwoFactor } from "@/lib/customers/service";

type Ctx = RouteContext<"/api/v1/admin/customers/[id]/two-factor/reset">;

export const POST = adminHandler<Ctx>(
  async (_request, ctx, principal, session) => {
    const { id } = await ctx.params;
    return ok(
      await resetCustomerTwoFactor(id, {
        userId: principal.user.id,
        signInMethod: session.signInMethod,
      }),
    );
  },
  { endpoint: "admin.customers.two_factor_reset" },
);
