/**
 * GET /api/v1/admin/me/mfa — which second factors the caller has switched on.
 *
 * Read straight from Cognito with the caller's own access token, so it is
 * always current; nothing about MFA is cached or stored in either database.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { requireAccessToken } from "@/lib/auth/access-token";
import { getMfaStatus } from "@/lib/account/service";

export const GET = adminHandler(
  async (request) => ok(await getMfaStatus(requireAccessToken(request))),
  { endpoint: "admin.me.mfa.get" },
);
