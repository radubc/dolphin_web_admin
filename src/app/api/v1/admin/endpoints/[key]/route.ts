/**
 * PUT /api/v1/admin/endpoints/[key] — register or update one endpoint rule.
 * Same shape as the page rule route, with `notes` instead of `navOrder`.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { upsertEndpointRuleSchema } from "@/lib/admin-access/schemas";
import { ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";

type Ctx = RouteContext<"/api/v1/admin/endpoints/[key]">;

export const PUT = adminHandler<Ctx>(
  async (request, ctx, principal) => {
    const { key } = await ctx.params;
    const input = await parseJsonBody(request, upsertEndpointRuleSchema);
    return ok(await getAdminAccessRepository().upsertEndpointRule(key, input, principal.user.id));
  },
  { endpoint: "admin.endpoints.upsert" },
);
