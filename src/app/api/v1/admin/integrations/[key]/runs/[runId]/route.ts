/**
 * /api/v1/admin/integrations/[key]/runs/[runId] — one run, for polling while
 * it works.
 *
 * A run id that is not a UUID, or one that belongs to another integration, is
 * a 404: from the caller's side that run does not exist, and the shape of the
 * id is not something the answer should confirm.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { getIntegrationRun, parseIntegrationKey } from "@/lib/integrations/service";

type Ctx = RouteContext<"/api/v1/admin/integrations/[key]/runs/[runId]">;

export const GET = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { key, runId } = await ctx.params;
    return ok(await getIntegrationRun(parseIntegrationKey(key), runId));
  },
  { endpoint: "admin.integrations.runs.get" },
);
