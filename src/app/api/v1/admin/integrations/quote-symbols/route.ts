/**
 * /api/v1/admin/integrations/quote-symbols — the quote watch list.
 *
 * GET answers one page (`?page`, `?pageSize`, `?q`, `?kind`, `?active`), each
 * symbol carrying its newest cached quote so the page needs no second call.
 *
 * POST adds a symbol. The symbol and exchange are uppercased, an exchange is
 * required for stocks and ETFs (the canonical form `SHOP:TSX` needs it to be
 * unambiguous) and the admin catalog is consulted for a display name and
 * currency. A symbol the catalog does not know is still accepted: the
 * catalogs are a snapshot, and the next run reports the provider's own
 * verdict on it.
 */
import { adminHandler } from "@/lib/admin-access/authorize";
import { created, ok } from "@/lib/api/response";
import { parseJsonBody, parseSearchParams } from "@/lib/api/validate";
import { quoteSymbolInputSchema, watchListQuerySchema } from "@/lib/integrations/schemas";
import { addQuoteSymbol, listQuoteSymbols } from "@/lib/integrations/service";

export const GET = adminHandler(
  async (request) => {
    const query = parseSearchParams(request.nextUrl, watchListQuerySchema);
    return ok(await listQuoteSymbols(query));
  },
  { endpoint: "admin.integrations.quote_symbols.list" },
);

export const POST = adminHandler(
  async (request, _ctx, principal) => {
    const input = await parseJsonBody(request, quoteSymbolInputSchema);
    return created(await addQuoteSymbol(input, principal.user.id));
  },
  { endpoint: "admin.integrations.quote_symbols.create" },
);
