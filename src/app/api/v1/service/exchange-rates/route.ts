/**
 * /api/v1/service/exchange-rates?pairs=USD/CAD,EUR/USD — the exchange-rate
 * cache, for the consumer app.
 *
 * Machine-to-machine only, same as the quote lookup: an `API_KEYS` entry, and
 * the path listed in `PUBLIC_API_PATHS` in `src/proxy.ts`.
 *
 * Three forms, all with the same `{ rates, missing }` answer:
 *
 * - `?pairs=…` — the newest rate per pair. "Current" here means *fetched*
 *   today, not dated today: the Bank of Canada publishes at 16:30 ET, so a
 *   fetch made this morning legitimately returns yesterday's observation. The
 *   `date` field on each rate says which day it describes.
 * - `?pairs=…&date=2026-03-14` — the closest observation **on or before** that
 *   day (weekends and holidays look back up to ten days), one rate per pair,
 *   its `date` being the real observation day.
 * - `?pairs=…&from=2026-01-01&to=2026-03-31` — every published observation in
 *   the window, so `rates` holds one entry per pair *and* day.
 *
 * Both dated forms are answered from `admin_exchange_rates` when it already
 * covers the window, and otherwise by a single ranged Bank of Canada call
 * whose rows are stored on the way out. The "latest" form additionally derives
 * from the in-process memo of today's document, so a pair nobody has ever
 * asked for usually costs no provider call at all — and no `on_demand` run row
 * is written when nothing was fetched.
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
    const { pairs, date, from, to } = parseSearchParams(
      request.nextUrl,
      exchangeRateLookupQuerySchema,
    );
    try {
      return ok(await lookupExchangeRates(pairs, { date, from, to }));
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
