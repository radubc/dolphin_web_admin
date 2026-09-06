/**
 * /api/v1/admin/roles/[id] — one role. PATCH edits name, description and
 * grants; DELETE removes a non-system role nobody holds. Both super-admin only.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { updateRoleSchema } from "@/lib/admin-access/schemas";
import { NotFoundError } from "@/lib/api/errors";
import { noContent, ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";

type Ctx = RouteContext<"/api/v1/admin/roles/[id]">;

export const GET = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { id } = await ctx.params;
    const role = await getAdminAccessRepository().getRole(id);
    if (!role) throw new NotFoundError("That role does not exist.");
    return ok(role);
  },
  { action: "can_manage_roles" },
);

export const PATCH = adminHandler<Ctx>(
  async (request, ctx, principal) => {
    const { id } = await ctx.params;
    const input = await parseJsonBody(request, updateRoleSchema);
    const role = await getAdminAccessRepository().updateRole(id, input, principal.user.id);
    return ok(role);
  },
  { superAdmin: true },
);

export const DELETE = adminHandler<Ctx>(
  async (_request, ctx, principal) => {
    const { id } = await ctx.params;
    await getAdminAccessRepository().deleteRole(id, principal.user.id);
    return noContent();
  },
  { superAdmin: true },
);
