/**
 * GET /api/v1/admin/me/mfa — which second factors the caller has switched on.
 *
 * Read straight from Cognito with the caller's own access token, so it is
 * always current; nothing about MFA is cached or stored in either database.
 *
 * Also answers `passkeyMfaEnabled` and `passkeySignInPaused` (2026-10-04): for
 * an account with TOTP on and passkey MFA off it lists the passkeys, and
 * "paused" means there is at least one. Switching the flag on happens at TOTP
 * enrolment, passkey registration and TOTP sign-in
 * (`src/lib/account/passkey-mfa.ts`), never here.
 *
 * Since phase B (`docs/two-factor-plan.md`) the answer also carries
 * `recoveryCodes` — how many of the caller's ten recovery codes are left and
 * whether one has been used — from one read of `admin_user_recovery_codes`
 * pinned to the caller's own allowlist row.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { requireAccessToken } from "@/lib/auth/access-token";
import { getMfaStatusView } from "@/lib/account/recovery";

export const GET = adminHandler(
  async (request, _ctx, principal) =>
    ok(await getMfaStatusView(requireAccessToken(request), principal.user.id)),
  { endpoint: "admin.me.mfa.get" },
);
