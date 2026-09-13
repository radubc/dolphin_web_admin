/**
 * POST /api/v1/admin/me/password — the operator changes their own password.
 *
 * Self-service, so any enabled operator may call it: the endpoint acts on the
 * caller's own Cognito account and on nothing else. Cognito checks the current
 * password, which is the re-authentication the change needs.
 *
 * Limited twice: the wrapper charges the reset budget per client IP, and the
 * handler charges the same budget against the operator's id — the per-IP one
 * is switched off whenever `TRUST_PROXY_HEADERS` is unset, and a password
 * oracle must stay limited either way.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { noContent } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { requireAccessToken } from "@/lib/auth/access-token";
import { changePasswordSchema } from "@/lib/account/schemas";
import { changeOwnPassword } from "@/lib/account/service";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/security/rate-limit";

export const POST = adminHandler(
  async (request, _ctx, principal) => {
    const accessToken = requireAccessToken(request);
    await enforceRateLimit(
      `account:password:${principal.user.id}`,
      RATE_LIMITS.authReset,
    );
    const input = await parseJsonBody(request, changePasswordSchema);
    await changeOwnPassword(accessToken, input.currentPassword, input.newPassword);
    return noContent();
  },
  { endpoint: "admin.me.password.change", rateLimit: RATE_LIMITS.authReset },
);
