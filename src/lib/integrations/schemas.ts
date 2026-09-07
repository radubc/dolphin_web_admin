/**
 * Request-body and query schemas for the Integrations routes.
 *
 * Shape, size and normalisation only. Whether a symbol exists at the
 * provider, whether a currency is published by the Bank of Canada and whether
 * a canonical symbol is already watched are decided in `./repository.ts` and
 * by the run itself, so a caller that bypasses these still cannot break an
 * invariant.
 *
 * Normalisation happens here on purpose: symbols, exchanges and currency
 * codes are trimmed and uppercased, so the canonical spelling is the only one
 * that ever reaches the database or the provider.
 *
 * Plain zod, no server imports: safe to import from anywhere.
 */
import { z } from "zod";
import {
  ALPHA_VANTAGE_REQUESTS_PER_MINUTE_MAX,
  ALPHA_VANTAGE_REQUESTS_PER_RUN_MAX,
  CATALOG_TARGETS,
  LOOKUP_ITEMS_MAX,
  type IntegrationProvider,
  QUOTE_BATCH_SIZE_MAX,
  QUOTE_KINDS,
  SCHEDULE_FREQUENCIES,
  WATCH_PAGE_SIZE_DEFAULT,
  WATCH_PAGE_SIZE_MAX,
  type CurrencyPairInput,
  type CurrencyPairPatch,
  type IntegrationPatch,
  type QuoteSymbolInput,
  type QuoteSymbolPatch,
  type RunRequest,
  type WatchListQuery,
} from "./types";

/* -------------------------------------------------------------------------- */
/*                                   Fields                                   */
/* -------------------------------------------------------------------------- */

/** ISO 4217: exactly three letters, stored uppercase. */
const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, "Use exactly three letters.")
  .regex(/^[A-Z]{3}$/, "Letters only.");

/**
 * A bare ticker as the catalogs spell it. Crypto pairs carry a slash
 * (`BTC/USD`), a few tickers carry a dot or a dash (`BRK.B`, `RDS-A`); the
 * colon is excluded because it is the separator in the canonical form.
 */
const tickerSymbol = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9./-]+$/, "Letters, digits, dot, slash or dash only.");

/** An exchange name as the catalog spells it (`TSX`, `NASDAQ`). */
const exchangeName = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9 ._-]+$/, "Letters, digits, space, dot, underscore or dash only.");

/** Only https: an admin-configured base URL is a request this server makes. */
const httpsUrl = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use an https:// address.")
  // Trailing slashes are stripped so paths can be appended with one rule.
  .transform((value) => value.replace(/\/+$/, ""));

/* -------------------------------------------------------------------------- */
/*                          Base URL: one domain each                         */
/* -------------------------------------------------------------------------- */

/**
 * The registrable domain each provider's base URL must sit on.
 *
 * The base URL stays editable — a region, a staging host or a different path
 * are all fine — but only within the provider's own domain. The reason is not
 * hypothetical: the TwelveData calls carry an API key, and an operator who
 * could point `baseUrl` at a host they control could have this server deliver
 * that key to them. Anything the provider itself serves is already trusted
 * with the key.
 */
export const PROVIDER_BASE_URL_DOMAINS: Record<IntegrationProvider, string> = {
  twelvedata: "twelvedata.com",
  bank_of_canada: "bankofcanada.ca",
  iso20022: "iso20022.org",
  // Alpha Vantage only accepts its key as a query parameter, so this is the
  // one integration whose address really can carry the credential off-site.
  // The domain check is the thing that stops it.
  alpha_vantage: "alphavantage.co",
};

/**
 * Whether `value` is an https URL whose host is the provider's domain or a
 * subdomain of it. Case-insensitive; a trailing dot in the host is ignored.
 * Anything that is not a parseable URL is `false` (the shape check refuses it
 * with its own message first).
 */
export function isAllowedBaseUrl(provider: IntegrationProvider, value: string): boolean {
  const domain = PROVIDER_BASE_URL_DOMAINS[provider];
  let host: string;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return false;
    host = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return host === domain || host.endsWith(`.${domain}`);
}

/** The 422 message an out-of-domain base URL earns; it names the domain. */
export function baseUrlDomainMessage(provider: IntegrationProvider): string {
  return `The base URL must be on ${PROVIDER_BASE_URL_DOMAINS[provider]} (the address is editable within that domain only).`;
}

/* -------------------------------------------------------------------------- */
/*                                Integrations                                */
/* -------------------------------------------------------------------------- */

const scheduleSchema = z
  .object({
    frequency: z.enum(SCHEDULE_FREQUENCIES),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekday: z.number().int().min(0).max(6),
    /** Capped at 28 so every month has the day. */
    dayOfMonth: z.number().int().min(1).max(28),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Unknown timezone."),
  })
  .partial();

const settingsSchema = z
  .object({
    catalogs: z.array(z.enum(CATALOG_TARGETS)).min(1).max(CATALOG_TARGETS.length),
    batchSize: z.number().int().min(1).max(QUOTE_BATCH_SIZE_MAX),
    /** One credit per symbol; the free plan allows 8 a minute. */
    creditsPerMinute: z.number().int().min(1).max(3000),
    /** MIC list: load the register's EXPIRED rows as well. */
    includeExpired: z.boolean(),
    /**
     * Alpha Vantage: one symbol is one request and the free tier allows 25 a
     * day, so the cap can never be set above the day's whole quota.
     */
    maxRequestsPerRun: z.number().int().min(1).max(ALPHA_VANTAGE_REQUESTS_PER_RUN_MAX),
    /** Alpha Vantage: the free tier allows 5 requests a minute. */
    requestsPerMinute: z.number().int().min(1).max(ALPHA_VANTAGE_REQUESTS_PER_MINUTE_MAX),
  })
  .partial();

/** `PATCH /api/v1/admin/integrations/[key]`. At least one field. */
export const integrationPatchSchema: z.ZodType<IntegrationPatch> = z
  .object({
    baseUrl: httpsUrl,
    isEnabled: z.boolean(),
    schedule: scheduleSchema,
    settings: settingsSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change.");

/** `POST /api/v1/admin/integrations/[key]/run`. An empty body is allowed. */
export const runRequestSchema: z.ZodType<RunRequest> = z
  .object({ force: z.boolean() })
  .partial();

/** `GET /api/v1/admin/integrations/[key]/runs?limit=`. */
export const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type RunsQuery = z.infer<typeof runsQuerySchema>;

/* -------------------------------------------------------------------------- */
/*                                Watch lists                                 */
/* -------------------------------------------------------------------------- */

/** Query for both watch lists; `kind` is ignored by the currency pair list. */
export const watchListQuerySchema: z.ZodType<WatchListQuery> = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(WATCH_PAGE_SIZE_MAX)
    .default(WATCH_PAGE_SIZE_DEFAULT),
  q: z.string().trim().max(64).optional(),
  kind: z.enum(QUOTE_KINDS).optional(),
  active: z.enum(["all", "active", "inactive"]).default("all"),
});

/**
 * `POST /api/v1/admin/integrations/quote-symbols`.
 *
 * An exchange is required for stocks and ETFs (the canonical form needs it to
 * be unambiguous: `SHOP` is not `SHOP:TSX`) and dropped for crypto, whose
 * symbol already carries the quote currency.
 */
export const quoteSymbolInputSchema: z.ZodType<QuoteSymbolInput> = z
  .object({
    kind: z.enum(QUOTE_KINDS),
    symbol: tickerSymbol,
    exchange: exchangeName.nullish(),
  })
  .refine(
    (value) => value.kind === "crypto" || (value.exchange !== null && value.exchange !== undefined),
    { message: "An exchange is required for stocks and ETFs.", path: ["exchange"] },
  )
  .transform((value) => ({
    kind: value.kind,
    symbol: value.symbol,
    exchange: value.kind === "crypto" ? null : (value.exchange ?? null),
  }));

/** `PATCH /api/v1/admin/integrations/quote-symbols/[id]`. */
export const quoteSymbolPatchSchema: z.ZodType<QuoteSymbolPatch> = z
  .object({ isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change.");

/** `POST /api/v1/admin/integrations/currency-pairs`. */
export const currencyPairInputSchema: z.ZodType<CurrencyPairInput> = z
  .object({
    fromCurrency: currencyCode,
    toCurrency: currencyCode,
  })
  .refine((value) => value.fromCurrency !== value.toCurrency, {
    message: "The two currencies must differ.",
    path: ["toCurrency"],
  });

/** `PATCH /api/v1/admin/integrations/currency-pairs/[id]`. */
export const currencyPairPatchSchema: z.ZodType<CurrencyPairPatch> = z
  .object({ isActive: z.boolean() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change.");

/* -------------------------------------------------------------------------- */
/*                            Service (API key) lookups                       */
/* -------------------------------------------------------------------------- */

/**
 * A comma-separated list, trimmed, uppercased, de-duplicated and capped at
 * `LOOKUP_ITEMS_MAX`. Empty entries are dropped rather than refused: a
 * trailing comma is not worth a 422.
 */
const commaList = (itemMax: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(LOOKUP_ITEMS_MAX * (itemMax + 1))
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim().toUpperCase())
        .filter((item) => item !== ""),
    )
    .transform((items) => [...new Set(items)])
    .refine((items) => items.length > 0, "Name at least one item.")
    .refine(
      (items) => items.length <= LOOKUP_ITEMS_MAX,
      `At most ${LOOKUP_ITEMS_MAX} items per request.`,
    );

/** `GET /api/v1/service/quotes?symbols=AAPL,SHOP:TSX,BTC/USD`. */
export const quoteLookupQuerySchema = z.object({
  symbols: commaList(48).refine(
    (items) => items.every((item) => /^[A-Z0-9./:-]{1,48}$/.test(item)),
    "A symbol may hold letters, digits, dot, slash, colon or dash only.",
  ),
});

/** `GET /api/v1/service/exchange-rates?pairs=USD/CAD,EUR/USD`. */
export const exchangeRateLookupQuerySchema = z.object({
  pairs: commaList(7).refine(
    (items) => items.every((item) => /^[A-Z]{3}\/[A-Z]{3}$/.test(item)),
    "A pair looks like USD/CAD.",
  ),
});
