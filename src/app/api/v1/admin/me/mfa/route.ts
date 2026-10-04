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
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { requireAccessToken } from "@/lib/auth/access-token";
import { getMfaStatus } from "@/lib/account/service";

export const GET = adminHandler(
  async (request) => ok(await getMfaStatus(requireAccessToken(request))),
  { endpoint: "admin.me.mfa.get" },
);
