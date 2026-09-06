/**
 * GET /api/v1/me — the signed-in caller's identity.
 *
 * Reference implementation for every business endpoint: exported through
 * `protectedHandler`, thin body, `{ data }` envelope, no direct token handling.
 * Authenticates from either the `psa_id_token` cookie or an
 * `Authorization: Bearer <id token>` header.
 */
import { protectedHandler } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";

export const GET = protectedHandler(
  async (_request, _ctx, session) =>
    ok({
      userId: session.userId,
      email: session.email,
      name: session.name,
    }),
  { endpoint: "me" },
);
