/**
 * GET /api/v1/admin/me — the signed-in operator's capabilities.
 *
 * Any enabled allowlist row may call it: the client uses the answer to decide
 * which controls to draw. It is a convenience, not a security boundary; every
 * write route re-checks on its own.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { capabilitiesOf } from "@/lib/admin-access/types";
import { ok } from "@/lib/api/response";

export const GET = adminHandler(async (_request, _ctx, principal) => ok(capabilitiesOf(principal)), {
  endpoint: "admin.me",
});
