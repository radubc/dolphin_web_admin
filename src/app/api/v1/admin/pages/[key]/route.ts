/**
 * PUT /api/v1/admin/pages/[key] — register or update one page rule.
 *
 * An empty body registers the page with the code's defaults. Any subset of
 * `actionKeys`, `requireSuperAdmin`, `isEnabled`, `navOrder`, `name`,
 * `description` updates it. Writes an audit event.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { getAdminAccessRepository } from "@/lib/admin-access/repository";
import { upsertPageRuleSchema } from "@/lib/admin-access/schemas";
import { ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";

type Ctx = RouteContext<"/api/v1/admin/pages/[key]">;

export const PUT = adminHandler<Ctx>(
  async (request, ctx, principal) => {
    const { key } = await ctx.params;
    const input = await parseJsonBody(request, upsertPageRuleSchema);
    return ok(await getAdminAccessRepository().upsertPageRule(key, input, principal.user.id));
  },
  { endpoint: "admin.pages.upsert" },
);
