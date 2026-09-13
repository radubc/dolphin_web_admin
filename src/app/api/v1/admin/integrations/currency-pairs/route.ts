/**
 * /api/v1/admin/integrations/currency-pairs — the currency pair watch list.
 *
 * GET answers one page (`?page`, `?pageSize`, `?q`, `?active`), each pair
 * carrying its newest cached rate.
 *
 * POST adds a pair: two ISO 4217 codes, uppercased, which must differ. A
 * currency the Bank of Canada does not publish is still accepted — the fetch
 * below records that verdict on the row itself (`lastError`), which is more
 * useful than refusing the request with a list this app would have to keep in
 * step with the Bank's.
 *
 * The add also **brings the pair's last six months with it** (`today − 182
 * days` → today, one ranged Bank of Canada call recorded as an inline
 * `on_demand` run), so the list shows a rate at once instead of after that
 * night's run, and answers `{ pair, history }` with what the fetch produced.
 * The fetch cannot fail the add: a provider that is down, switched off or
 * already running a job comes back as a `history.status` and the pair is on
 * the watch list either way.
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
