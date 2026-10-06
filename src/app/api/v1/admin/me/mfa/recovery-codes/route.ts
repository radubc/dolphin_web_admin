/**
 * POST /api/v1/admin/me/mfa/recovery-codes — "Generate new codes".
 *
 * Body `{ password }`. Replaces the caller's set of two-factor recovery codes
 * and answers the ten new ones, `{ recoveryCodes: string[] }`, for the same
 * once-only dialog enrolment shows (`docs/two-factor-plan.md`, phase B).
 * Every earlier code stops working the moment this answers.
 *
 * Guarded like `POST /api/v1/admin/me/password`, because it proves a password:
 *
 * - `adminHandler`, so the caller is a verified, enabled operator and the
 *   cookie path also passes the same-origin (CSRF) check;
 * - **`RATE_LIMITS.authLoginAccount` per email, charged before Cognito** — the
 *   same five-per-quarter-hour budget `/login` spends, so this is no cheaper a
 *   place to guess a password than the sign-in form. The address is the
 *   allowlist row's, never anything the browser sent;
 * - **`RATE_LIMITS.accountMfa` per operator**, the per-user backstop.
 *
 * Both are spent whatever the outcome, and before the password is checked.
 * The `authLoginAccount` slot comes back once the password is proven — the
 * sign-in budgets count failed attempts only (owner, 2026-10-06) — whether
 * the codes were then issued or a later rule refused (`passwordProvenDespite`);
 * a wrong password or a Cognito outage keeps it spent. `accountMfa` is a
 * per-operation budget and is never refunded. The check itself, the
 * "authenticator must be on" rule and the replacement live in
 * `src/lib/account/recovery.ts` (`regenerateRecoveryCodes`).
 *
 * Answers: 200 with the codes; 401 `password_incorrect` (nothing replaced);
 * 422 `validation_failed` "Turn on the authenticator app first."; 503
 * `auth_unavailable` when Cognito never judged the password; 401
 * `token_expired` when the access-token cookie needs refreshing first, which
 * `apiFetch()` handles by refreshing once and replaying.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { requireAccessToken } from "@/lib/auth/access-token";
import { passwordProvenDespite, regenerateRecoveryCodes } from "@/lib/account/recovery";
import { regenerateRecoveryCodesSchema } from "@/lib/account/schemas";
import { enforceRateLimit, RATE_LIMITS, refundRateLimit } from "@/lib/security/rate-limit";

export const POST = adminHandler(
  async (request, _ctx, principal) => {
    const accessToken = requireAccessToken(request);
    const { password } = await parseJsonBody(request, regenerateRecoveryCodesSchema);

    const loginKey = `login:email:${principal.user.email.toLowerCase()}`;
    await enforceRateLimit(loginKey, RATE_LIMITS.authLoginAccount);
    await enforceRateLimit(`account:mfa:${principal.user.id}`, RATE_LIMITS.accountMfa);

    let recoveryCodes;
    try {
      recoveryCodes = await regenerateRecoveryCodes(
        accessToken,
        { id: principal.user.id, email: principal.user.email },
        password,
      );
    } catch (error) {
      if (passwordProvenDespite(error)) {
        await refundRateLimit(loginKey, RATE_LIMITS.authLoginAccount);
      }
      throw error;
    }
    await refundRateLimit(loginKey, RATE_LIMITS.authLoginAccount);
    return ok({ recoveryCodes });
  },
  { endpoint: "admin.me.mfa.recovery_codes", rateLimit: RATE_LIMITS.authReset },
);
