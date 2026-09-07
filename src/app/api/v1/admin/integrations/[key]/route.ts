/**
 * /api/v1/admin/integrations/[key] — the editable part of one integration:
 * its base URL, whether it is enabled, its schedule and its settings.
 *
 * Nothing else about an integration can be changed from here: the key, the
 * provider, the name and the API key requirement are what the code ships.
 * Saving recomputes `next_run_at`, so the schedule the operator just wrote is
 * the one the scheduler uses on its next tick.
 *
 * Next matches the static segments (`quote-symbols`, `currency-pairs`) ahead
 * of `[key]`, so those never arrive here; an unknown key is still a 404.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { integrationPatchSchema } from "@/lib/integrations/schemas";
import { parseIntegrationKey, patchIntegration } from "@/lib/integrations/service";

type Ctx = RouteContext<"/api/v1/admin/integrations/[key]">;

export const PATCH = adminHandler<Ctx>(
  async (request, ctx, principal) => {
    const { key } = await ctx.params;
    const integrationKey = parseIntegrationKey(key);
    const patch = await parseJsonBody(request, integrationPatchSchema);
    return ok(await patchIntegration(integrationKey, patch, principal.user.id));
  },
  { endpoint: "admin.integrations.update" },
);
