/**
 * /api/v1/admin/integrations/currency-pairs/[id]/rates — the download history
 * of one watched pair.
 *
 * GET answers one page (`?page`, `?pageSize`) of `admin_exchange_rates` for
 * that pair, newest observation day first: the rate, whether it was read from
 * the Bank of Canada's own series or derived from two of them, and when it was
 * fetched. Read-only; the rows are written by the daily run and by the
 * on-demand lookup, never from here.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";
import { rateHistoryQuerySchema } from "@/lib/integrations/schemas";
import { listCurrencyPairRates } from "@/lib/integrations/service";

type Ctx = RouteContext<"/api/v1/admin/integrations/currency-pairs/[id]/rates">;

export const GET = adminHandler<Ctx>(
  async (request, ctx) => {
    const { id } = await ctx.params;
    const query = parseSearchParams(request.nextUrl, rateHistoryQuerySchema);
    return ok(await listCurrencyPairRates(id, query));
  },
  { endpoint: "admin.integrations.currency_pairs.rates" },
);
