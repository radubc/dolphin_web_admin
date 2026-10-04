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
 * The admin pool is Essentials tier with the relying party `admin.fairsums.app`
 * (since 2026-09-12), so these work there; a pool without a relying party or
 * below that tier answers 503 `passkeys_not_enabled` quoting Cognito, see
 * `docs/auth.md`. PUT also sets passkey MFA when the operator has the
 * authenticator app on, so the new passkey can sign in (`passkey-mfa.ts`).
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { noContent, ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { requireAccessToken } from "@/lib/auth/access-token";
import { ensurePasskeyMfa } from "@/lib/account/passkey-mfa";
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
    // A passkey now exists: with the authenticator app on, it needs the
    // per-user flag to sign in (one `GetUser`, plus the passkey list and the
    // set only when the authenticator is on and the flag off). Best-effort —
    // the registration stands whatever this answers.
    await ensurePasskeyMfa(accessToken, { hasPasskeys: true });
    return noContent();
  },
  { endpoint: "admin.me.passkeys.complete" },
);
