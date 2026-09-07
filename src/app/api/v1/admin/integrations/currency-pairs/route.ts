/**
 * /api/v1/admin/integrations/currency-pairs — the currency pair watch list.
 *
 * GET answers one page (`?page`, `?pageSize`, `?q`, `?active`), each pair
 * carrying its newest cached rate.
 *
 * POST adds a pair: two ISO 4217 codes, uppercased, which must differ. A
 * currency the Bank of Canada does not publish is still accepted — the next
 * run records that verdict on the row itself (`lastError`), which is more
 * useful than refusing the request with a list this app would have to keep in
 * step with the Bank's.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { created, ok } from "@/lib/api/response";
import { parseJsonBody, parseSearchParams } from "@/lib/api/validate";
import { currencyPairInputSchema, watchListQuerySchema } from "@/lib/integrations/schemas";
import { addCurrencyPair, listCurrencyPairs } from "@/lib/integrations/service";

export const GET = adminHandler(
  async (request) => {
    const query = parseSearchParams(request.nextUrl, watchListQuerySchema);
    return ok(await listCurrencyPairs(query));
  },
  { endpoint: "admin.integrations.currency_pairs.list" },
);

export const POST = adminHandler(
  async (request, _ctx, principal) => {
    const input = await parseJsonBody(request, currencyPairInputSchema);
    return created(await addCurrencyPair(input, principal.user.id));
  },
  { endpoint: "admin.integrations.currency_pairs.create" },
);
