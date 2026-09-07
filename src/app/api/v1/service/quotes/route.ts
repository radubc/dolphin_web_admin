/**
 * /api/v1/service/quotes?symbols=AAPL,SHOP:TSX,BTC/USD — the quote cache, for
 * the consumer app.
 *
 * Machine-to-machine only: the caller presents an `API_KEYS` entry
 * (`x-api-key` or `Authorization: ApiKey`), which is why the path is listed in
 * `PUBLIC_API_PATHS` in `src/proxy.ts` — the proxy would otherwise refuse a
 * request that carries no Cognito cookie.
 *
 * The answer is `{ quotes, missing }`: the newest cached quote per symbol,
 * with the symbols that had nothing from today fetched from TwelveData first.
 * A symbol the watch list did not know is added to it (`source: "request"`),
 * so the daily run keeps it current and the next request is a cache hit.
 *
 * **It does not fail when the provider does.** A dead provider, a missing key
 * or a disabled integration all answer with whatever the cache holds, however
 * stale, and only report a `missing` entry for a symbol with nothing cached
 * at all. The one thing that can stop it is the admin schema not being
 * installed, and even that answers 200 with every symbol `unavailable`.
 */
import { isMissingTableError } from "@/lib/admin-access/prisma-repository";
import { serviceHandler } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";
import { RATE_LIMITS } from "@/lib/security/rate-limit";
import { lookupQuotes } from "@/lib/integrations/lookup";
import { quoteLookupQuerySchema } from "@/lib/integrations/schemas";
import type { QuoteLookupResponse } from "@/lib/integrations/types";

export const GET = serviceHandler(
  async (request) => {
    const { symbols } = parseSearchParams(request.nextUrl, quoteLookupQuerySchema);
    try {
      return ok(await lookupQuotes(symbols));
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      console.warn(
        "[integrations] quote lookup: the integration tables are not installed " +
          "(run docs/sql/008_integrations.sql).",
      );
      return ok<QuoteLookupResponse>({
        quotes: [],
        missing: symbols.map((requested) => ({ requested, reason: "unavailable" })),
      });
    }
  },
  // The `service` preset per IP as well as per key: the default `api` policy
  // (120/min) would cap a machine client far below the 600/min the registry
  // row and docs/api.md advertise. `serviceHandler` charges `key:` separately.
  { endpoint: "service.quotes.lookup", rateLimit: RATE_LIMITS.service },
);
