/**
 * /api/v1/admin/integrations/currency-pairs/[id] — one watched pair.
 *
 * PATCH activates or deactivates it. DELETE removes the watch row and keeps
 * the cached rates, for the same reason quotes are kept: the history is
 * still true and the consumer app may still be reading it.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { noContent, ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { currencyPairPatchSchema } from "@/lib/integrations/schemas";
import { patchCurrencyPair, removeCurrencyPair } from "@/lib/integrations/service";

type Ctx = RouteContext<"/api/v1/admin/integrations/currency-pairs/[id]">;

export const PATCH = adminHandler<Ctx>(
  async (request, ctx) => {
    const { id } = await ctx.params;
    const patch = await parseJsonBody(request, currencyPairPatchSchema);
    return ok(await patchCurrencyPair(id, patch));
  },
  { endpoint: "admin.integrations.currency_pairs.update" },
);

export const DELETE = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { id } = await ctx.params;
    await removeCurrencyPair(id);
    return noContent();
  },
  { endpoint: "admin.integrations.currency_pairs.delete" },
);
