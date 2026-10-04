/**
 * /api/v1/admin/integrations/quote-symbols/[id]/quotes — the download history
 * of one watched symbol.
 *
 * GET answers one page (`?page`, `?pageSize`) of `admin_quotes` for that
 * symbol, newest trading day first: the close (and open, high and low when
 * the provider gave them), the day's change, which provider served it and
 * when it was fetched. Read-only; the rows are written by the daily runs and
 * by the on-demand lookup, never from here.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";
import { rateHistoryQuerySchema } from "@/lib/integrations/schemas";
import { listQuoteSymbolQuotes } from "@/lib/integrations/service";

type Ctx = RouteContext<"/api/v1/admin/integrations/quote-symbols/[id]/quotes">;

export const GET = adminHandler<Ctx>(
  async (request, ctx) => {
    const { id } = await ctx.params;
    const query = parseSearchParams(request.nextUrl, rateHistoryQuerySchema);
    return ok(await listQuoteSymbolQuotes(id, query));
  },
  { endpoint: "admin.integrations.quote_symbols.quotes" },
);
