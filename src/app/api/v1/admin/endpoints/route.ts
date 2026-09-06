/**
 * GET /api/v1/admin/endpoints — the service registry merged with the code's
 * endpoint catalog: metadata, rule and rate-limit preset per endpoint.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { ok } from "@/lib/api/response";

export const GET = adminHandler(async () => ok(await getAdminAccessRepository().listEndpointRules()), {
  endpoint: "admin.endpoints.list",
});
