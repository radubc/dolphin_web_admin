/**
 * /api/v1/service/exchange-rates?pairs=USD/CAD,EUR/USD — the exchange-rate
 * cache, for the consumer app.
 *
 * Machine-to-machine only, same as the quote lookup: an `API_KEYS` entry, and
 * the path listed in `PUBLIC_API_PATHS` in `src/proxy.ts`.
 *
 * "Current" here means *fetched* today, not dated today: the Bank of Canada
 * publishes at 16:30 ET, so a fetch made this morning legitimately returns
 * yesterday's observation. The `date` field on each rate says which day it
 * describes.
 *
 * Because one Bank of Canada call caches every published series, a pair
 * nobody has ever asked for is usually derived from the cache without any
 * provider call at all — and no `on_demand` run row is written when that
 * happens.
 */
import { isMissingTableError } from "@/lib/admin-access/prisma-repository";
import { serviceHandler } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { parseSearchParams } from "@/lib/api/validate";
import { RATE_LIMITS } from "@/lib/security/rate-limit";
import { lookupExchangeRates } from "@/lib/integrations/lookup";
import { exchangeRateLookupQuerySchema } from "@/lib/integrations/schemas";
import type { ExchangeRateLookupResponse } from "@/lib/integrations/types";

export const GET = serviceHandler(
  async (request) => {
    const { pairs } = parseSearchParams(request.nextUrl, exchangeRateLookupQuerySchema);
    try {
      return ok(await lookupExchangeRates(pairs));
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      console.warn(
        "[integrations] exchange-rate lookup: the integration tables are not installed " +
          "(run docs/sql/008_integrations.sql).",
      );
      return ok<ExchangeRateLookupResponse>({
        rates: [],
        missing: pairs.map((requested) => ({ requested, reason: "unavailable" })),
      });
    }
  },
  // The `service` preset per IP as well as per key: the default `api` policy
  // (120/min) would cap a machine client far below the 600/min the registry
  // row and docs/api.md advertise. `serviceHandler` charges `key:` separately.
  { endpoint: "service.exchange_rates.lookup", rateLimit: RATE_LIMITS.service },
);
