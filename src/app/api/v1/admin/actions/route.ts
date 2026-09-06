/**
 * GET /api/v1/admin/actions — the permission catalog.
 *
 * Read by the role editor, so it needs the same action as the roles list.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { ok } from "@/lib/api/response";

export const GET = adminHandler(
  async () => ok(await getAdminAccessRepository().listActions()),
  { endpoint: "admin.actions.list" },
);
