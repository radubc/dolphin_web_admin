/**
 * /api/v1/admin/roles — the role catalog with each role's action grants.
 *
 * GET for anyone holding `can_manage_roles`; POST is super-admin only.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { createRoleSchema } from "@/lib/admin-access/schemas";
import { created, ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";

export const GET = adminHandler(
  async () => ok(await getAdminAccessRepository().listRoles()),
  { action: "can_manage_roles" },
);

export const POST = adminHandler(
  async (request, _ctx, principal) => {
    const input = await parseJsonBody(request, createRoleSchema);
    const role = await getAdminAccessRepository().createRole(input, principal.user.id);
    return created(role);
  },
  { superAdmin: true },
);
