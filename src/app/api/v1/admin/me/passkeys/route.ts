/**
 * /api/v1/admin/me/passkeys — the caller's own passkeys.
 *
 * GET lists them, POST starts a registration (Cognito's
 * `CredentialCreationOptions` for `navigator.credentials.create()`), PUT
 * finishes it with the browser's `RegistrationResponseJSON`. Cognito is the
 * relying party: it issues the challenge and verifies the attestation, so this
 * app forwards the credential untouched and interprets none of it.
 *
 * Every route acts on the caller's account alone — the access token names the
 * subject — so any enabled operator may call them.
 *
 * While the user pool has no WebAuthn relying party configured (and while it
 * is below the Essentials tier) these answer 503 `passkeys_not_enabled`
 * quoting Cognito; see `docs/auth.md`.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { noContent, ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { requireAccessToken } from "@/lib/auth/access-token";
import { completePasskeySchema } from "@/lib/account/schemas";
import {
  completePasskeyRegistration,
  listPasskeys,
  startPasskeyRegistration,
} from "@/lib/account/service";

export const GET = adminHandler(
  async (request) => ok(await listPasskeys(requireAccessToken(request))),
  { endpoint: "admin.me.passkeys.list" },
);

export const POST = adminHandler(
  async (request) =>
    ok({ options: await startPasskeyRegistration(requireAccessToken(request)) }),
  { endpoint: "admin.me.passkeys.start" },
);

export const PUT = adminHandler(
  async (request) => {
    const accessToken = requireAccessToken(request);
    const input = await parseJsonBody(request, completePasskeySchema);
    await completePasskeyRegistration(accessToken, input.credential);
    return noContent();
  },
  { endpoint: "admin.me.passkeys.complete" },
);
