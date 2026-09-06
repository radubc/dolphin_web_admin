/**
 * /api/v1/admin/users/[id] — one admin user.
 *
 * GET for anyone holding `can_manage_admin_users`; PATCH is super-admin only.
 * PATCH carries any subset of display name, roles, super-admin flag and the
 * `disabled` switch; the repository refuses the two lockouts (disabling or
 * demoting yourself, or the last enabled super-admin) with a 409.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { updateAdminUserSchema } from "@/lib/admin-access/schemas";
import { NotFoundError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";

type Ctx = RouteContext<"/api/v1/admin/users/[id]">;

export const GET = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { id } = await ctx.params;
    const user = await getAdminAccessRepository().getUser(id);
    if (!user) throw new NotFoundError("That admin user does not exist.");
    return ok(user);
  },
  { endpoint: "admin.users.get" },
);

export const PATCH = adminHandler<Ctx>(
  async (request, ctx, principal) => {
    const { id } = await ctx.params;
    const input = await parseJsonBody(request, updateAdminUserSchema);
    const user = await getAdminAccessRepository().updateUser(id, input, principal.user.id);
    return ok(user);
  },
  { endpoint: "admin.users.update" },
);
