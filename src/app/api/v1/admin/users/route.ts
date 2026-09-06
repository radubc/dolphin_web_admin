/**
 * /api/v1/admin/users — the operator allowlist.
 *
 * GET lists every admin user, enabled or disabled, for anyone holding
 * `can_manage_admin_users`. POST creates one and is super-admin only: the
 * README reserves managing users, roles and grants for super-admins.
 *
 * The real implementation of POST also creates the Cognito user in the admin
 * pool (AdminCreateUser sends the invitation); the mock only records the row.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { createAdminUserSchema } from "@/lib/admin-access/schemas";
import { created, ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";

export const GET = adminHandler(
  async () => ok(await getAdminAccessRepository().listUsers()),
  { action: "can_manage_admin_users" },
);

export const POST = adminHandler(
  async (request, _ctx, principal) => {
    const input = await parseJsonBody(request, createAdminUserSchema);
    const user = await getAdminAccessRepository().createUser(input, principal.user.id);
    return created(user);
  },
  { superAdmin: true },
);
