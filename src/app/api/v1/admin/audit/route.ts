/**
 * GET /api/v1/admin/audit?limit=&cursor= — the permission audit trail, newest
 * first. `cursor` is the `nextCursor` of the previous page.
 */
import { z } from "zod";
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(64).optional(),
});

export const GET = adminHandler(
  async (request) => {
    const { limit, cursor } = parseSearchParams(request.nextUrl, querySchema);
    return ok(await getAdminAccessRepository().listAuditEvents({ limit, cursor }));
  },
  { endpoint: "admin.audit.list" },
);
