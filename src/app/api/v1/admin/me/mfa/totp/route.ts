/**
 * /api/v1/admin/me/mfa/totp — the caller's own authenticator app.
 *
 * POST starts an enrolment (`AssociateSoftwareToken`) and returns the shared
 * secret and its `otpauth://` URI **once**; nothing stores it.
 * PUT verifies one six-digit code and, only then, switches the factor on.
 * DELETE switches it off again.
 *
 * All three act on the caller's account alone — Cognito derives the subject
 * from the access token — so any enabled operator may call them. PUT is a code
 * guess, so it carries the reset budget per operator as well as per IP.
 *
 * While the user pool's `MfaConfiguration` is `OFF` these answer 503
 * `mfa_not_enabled` quoting Cognito's own sentence; see `docs/auth.md` for the
 * pool settings that make them work.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { requireAccessToken } from "@/lib/auth/access-token";
import { verifyTotpSchema } from "@/lib/account/schemas";
import {
  disableTotp,
  startTotpEnrolment,
  verifyTotpEnrolment,
} from "@/lib/account/service";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/security/rate-limit";

export const POST = adminHandler(
  async (request, _ctx, principal) => {
    const accessToken = requireAccessToken(request);
    // The label the authenticator app shows under the issuer. The allowlist
    // row's address, not anything the browser sent.
    return ok(await startTotpEnrolment(accessToken, principal.user.email));
  },
  { endpoint: "admin.me.mfa.totp.start" },
);

export const PUT = adminHandler(
  async (request, _ctx, principal) => {
    const accessToken = requireAccessToken(request);
    await enforceRateLimit(
      `account:totp:${principal.user.id}`,
      RATE_LIMITS.authReset,
    );
    const input = await parseJsonBody(request, verifyTotpSchema);
    return ok(
      await verifyTotpEnrolment(accessToken, input.code, input.deviceName),
    );
  },
  { endpoint: "admin.me.mfa.totp.verify", rateLimit: RATE_LIMITS.authReset },
);

export const DELETE = adminHandler(
  async (request) => ok(await disableTotp(requireAccessToken(request))),
  { endpoint: "admin.me.mfa.totp.disable" },
);
