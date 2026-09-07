/**
 * /api/v1/admin/integrations/[key]/runs — recent runs of one integration,
 * newest first. `limit` is 1..50 and defaults to 10.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";
import { runsQuerySchema } from "@/lib/integrations/schemas";
import { listIntegrationRuns, parseIntegrationKey } from "@/lib/integrations/service";

type Ctx = RouteContext<"/api/v1/admin/integrations/[key]/runs">;

export const GET = adminHandler<Ctx>(
  async (request, ctx) => {
    const { key } = await ctx.params;
    const integrationKey = parseIntegrationKey(key);
    const { limit } = parseSearchParams(request.nextUrl, runsQuerySchema);
    return ok(await listIntegrationRuns(integrationKey, limit));
  },
  { endpoint: "admin.integrations.runs.list" },
);
