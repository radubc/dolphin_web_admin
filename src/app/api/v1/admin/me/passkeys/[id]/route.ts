/**
 * DELETE /api/v1/admin/me/passkeys/[id] — removes one of the caller's own
 * passkeys.
 *
 * The id is Cognito's `CredentialId`. It needs no ownership check here:
 * `DeleteWebAuthnCredential` is scoped to the account the access token names,
 * so a credential belonging to anybody else is simply not found.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { BadRequestError } from "@/lib/api/errors";
import { noContent } from "@/lib/api/response";
import { requireAccessToken } from "@/lib/auth/access-token";
import { deletePasskey } from "@/lib/account/service";

/** Cognito credential ids are base64url; cap the length before forwarding. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,512}$/;

type Ctx = RouteContext<"/api/v1/admin/me/passkeys/[id]">;

export const DELETE = adminHandler<Ctx>(
  async (request, ctx) => {
    const accessToken = requireAccessToken(request);
    const { id } = await ctx.params;
    if (!CREDENTIAL_ID.test(id)) {
      throw new BadRequestError("That passkey id is not valid.");
    }
    await deletePasskey(accessToken, id);
    return noContent();
  },
  { endpoint: "admin.me.passkeys.delete" },
);
