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
 * The admin pool allows all three (`MfaConfiguration OPTIONAL`, software
 * tokens on, since 2026-09-12); on a pool with MFA `OFF` they answer 503
 * `mfa_not_enabled` quoting Cognito's own sentence, see `docs/auth.md`. PUT
 * also sets passkey MFA for an operator who already has a passkey, so the
 * authenticator app never costs them passkey sign-in (`passkey-mfa.ts`);
 * DELETE clears both in one call.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { requireAccessToken } from "@/lib/auth/access-token";
import { ensurePasskeyMfa } from "@/lib/account/passkey-mfa";
import { verifyTotpSchema } from "@/lib/account/schemas";
import {
  disableTotp,
  getMfaStatus,
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
    const status = await verifyTotpEnrolment(
      accessToken,
      input.code,
      input.deviceName,
    );
    if (!status.passkeySignInPaused) {
      return ok(status);
    }
    // The app just went on and a passkey is already registered: set the flag
    // that keeps passkey sign-in working, then answer with the fresh status.
    // Best-effort — the enrolment stands whatever Cognito says to this, and
    // so does the response: if the re-read fails, answer from what is known
    // (the methods list is then one entry short, which the next read fixes).
    const check = await ensurePasskeyMfa(accessToken, { status, hasPasskeys: true });
    try {
      return ok(await getMfaStatus(accessToken));
    } catch {
      return ok({ ...status, ...check });
    }
  },
  { endpoint: "admin.me.mfa.totp.verify", rateLimit: RATE_LIMITS.authReset },
);

export const DELETE = adminHandler(
  async (request) => ok(await disableTotp(requireAccessToken(request))),
  { endpoint: "admin.me.mfa.totp.disable" },
);
