/**
 * GET /api/v1/admin/pages — the access map for pages and quick actions:
 * database rows merged with the code's page registry, so an unregistered page
 * shows up with its defaults and a "Register" affordance.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { ok } from "@/lib/api/response";

export const GET = adminHandler(async () => ok(await getAdminAccessRepository().listPageRules()), {
  endpoint: "admin.pages.list",
});
