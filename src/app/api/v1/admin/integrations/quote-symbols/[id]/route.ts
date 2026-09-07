/**
 * /api/v1/admin/integrations/quote-symbols/[id] — one watched symbol.
 *
 * PATCH activates or deactivates it; an inactive symbol stays on the list and
 * keeps its history, the daily run simply skips it.
 *
 * DELETE removes the watch row only. The cached quotes are kept: they cost
 * credits to obtain, the consumer app may still be asking for them, and
 * nothing about removing a symbol from a watch list says the prices were
 * wrong.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { noContent, ok } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/validate";
import { quoteSymbolPatchSchema } from "@/lib/integrations/schemas";
import { patchQuoteSymbol, removeQuoteSymbol } from "@/lib/integrations/service";

type Ctx = RouteContext<"/api/v1/admin/integrations/quote-symbols/[id]">;

export const PATCH = adminHandler<Ctx>(
  async (request, ctx) => {
    const { id } = await ctx.params;
    const patch = await parseJsonBody(request, quoteSymbolPatchSchema);
    return ok(await patchQuoteSymbol(id, patch));
  },
  { endpoint: "admin.integrations.quote_symbols.update" },
);

export const DELETE = adminHandler<Ctx>(
  async (_request, ctx) => {
    const { id } = await ctx.params;
    await removeQuoteSymbol(id);
    return noContent();
  },
  { endpoint: "admin.integrations.quote_symbols.delete" },
);
