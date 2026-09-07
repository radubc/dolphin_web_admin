/**
 * The Integrations model, as the API and the UI see it.
 *
 * An *integration* is one outbound call the admin app makes to an external
 * provider on a schedule, or on demand when the consumer app asks for
 * something the cache does not have yet. Three exist, seeded by
 * `docs/sql/008_integrations.sql` and never created from the UI:
 *
 * - `twelvedata_catalogs` — downloads the stock, ETF and cryptocurrency
 *   reference lists from TwelveData (no key needed) and inserts the rows the
 *   admin catalogs (`stocks`, `etfs`, `cryptocurrencies`) do not have yet.
 *   Existing rows are never changed or removed. New rows are marked `new`
 *   in the Constants sync ledger so the Constants page can push them.
 * - `twelvedata_quotes` — end-of-day quotes from TwelveData (`/quote`, key
 *   required) for every active row of the quote watch list
 *   (`admin_quote_symbols`), cached in `admin_quotes` one row per symbol and
 *   trading day. A symbol enters the watch list either by hand on the
 *   Integrations page or the first time the consumer app asks for it.
 * - `bank_of_canada_rates` — daily exchange rates from the Bank of Canada
 *   Valet API (no key needed) for every active currency pair
 *   (`admin_currency_pairs`), cached in `admin_exchange_rates` one row per
 *   pair and day. Pairs enter the list the same two ways.
 * - `iso_mic_markets` — downloads the ISO 10383 MIC list published by
 *   ISO 20022 (a CSV, no key needed) and inserts the markets the admin
 *   `markets` catalog does not have yet, matched on `mic_code`. Insert-only
 *   like the TwelveData catalogs, and new rows are marked `new` in the same
 *   Constants sync ledger. Seeded by `docs/sql/009_markets_and_alpha_vantage.sql`.
 * - `alpha_vantage_quotes` — the **fallback** for the quote watch list.
 *   TwelveData's free plan refuses non-US listings (`SHOP:TSX`), so the
 *   symbols it does not serve are asked of Alpha Vantage's `GLOBAL_QUOTE`
 *   (key required, one symbol per request, 25 a day and 5 a minute on the
 *   free tier). It runs *inside* the `twelvedata_quotes` run, so its own
 *   schedule is normally `off`; `Run now` refreshes the symbols it already
 *   owns. Which provider last served a symbol is remembered on
 *   `admin_quote_symbols.provider`, so neither provider is asked twice for
 *   a listing the other owns.
 *
 * The provider's address is editable per integration, so is the schedule and
 * a small settings object; nothing else about an integration is.
 *
 * Plain data, no React, no Prisma: safe to import from anywhere.
 */

/* -------------------------------------------------------------------------- */
/*                                Integrations                                */
/* -------------------------------------------------------------------------- */

/**
 * Every integration, in the order the page lists them: each catalog download
 * beside the catalog it fills, and the quote fallback beside the quote run it
 * backs up.
 */
export const INTEGRATION_KEYS = [
  "twelvedata_catalogs",
  "iso_mic_markets",
  "twelvedata_quotes",
  "alpha_vantage_quotes",
  "bank_of_canada_rates",
] as const;

export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export function isIntegrationKey(value: string): value is IntegrationKey {
  return (INTEGRATION_KEYS as readonly string[]).includes(value);
}

export const INTEGRATION_PROVIDERS = [
  "twelvedata",
  "bank_of_canada",
  "iso20022",
  "alpha_vantage",
] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** How often an integration runs on its own. `off` keeps it manual-only. */
export const SCHEDULE_FREQUENCIES = ["daily", "weekly", "monthly", "off"] as const;

export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

/**
 * When an integration runs. `hour` / `minute` are wall-clock in `timezone`
 * (an IANA name such as `America/Toronto`). `weekday` is 0 (Sunday) to 6 and
 * only read for `weekly`; `dayOfMonth` is 1..28 and only read for `monthly`,
 * capped at 28 so every month has the day.
 */
export interface IntegrationSchedule {
  frequency: ScheduleFrequency;
  hour: number;
  minute: number;
  weekday: number;
  dayOfMonth: number;
  timezone: string;
}

export const DEFAULT_TIMEZONE = "America/Toronto";

/** The catalogs the TwelveData catalog download can fill. */
export const CATALOG_TARGETS = ["stocks", "etfs", "cryptocurrencies"] as const;

export type CatalogTarget = (typeof CATALOG_TARGETS)[number];

/**
 * Provider-specific knobs, one flat object so a single form and schema serve
 * every integration. Each integration reads only the fields that concern it:
 *
 * - `twelvedata_catalogs`: `catalogs` — which lists to download (default all).
 * - `twelvedata_quotes`: `batchSize` — symbols per `/quote` request (TwelveData
 *   accepts up to 120 and charges one credit per symbol); `creditsPerMinute` —
 *   the plan's per-minute allowance, which paces the batches (the free plan
 *   allows 8 per minute and 800 per day).
 * - `bank_of_canada_rates`: nothing yet.
 * - `iso_mic_markets`: `includeExpired` — whether MICs the register marks
 *   EXPIRED are loaded too (default false: only ACTIVE and UPDATED).
 * - `alpha_vantage_quotes`: `maxRequestsPerRun` and `requestsPerMinute` — the
 *   free tier allows 25 requests a day and 5 a minute, and `GLOBAL_QUOTE` has
 *   no batch form, so one symbol is one request.
 */
export interface IntegrationSettings {
  catalogs?: CatalogTarget[];
  batchSize?: number;
  creditsPerMinute?: number;
  /**
   * `iso_mic_markets`: load MICs whose STATUS is EXPIRED as well. False by
   * default — an expired market is history, not a place to trade.
   */
  includeExpired?: boolean;
  /**
   * `alpha_vantage_quotes`: the most symbols one pass may spend on. One
   * symbol is one request and the free tier allows 25 a day, so this is the
   * headroom the fallback leaves for the on-demand lookups.
   */
  maxRequestsPerRun?: number;
  /** `alpha_vantage_quotes`: the tier's per-minute allowance (5 on free). */
  requestsPerMinute?: number;
}

export const QUOTE_BATCH_SIZE_DEFAULT = 8;
export const QUOTE_BATCH_SIZE_MAX = 120;
export const QUOTE_CREDITS_PER_MINUTE_DEFAULT = 8;

/* ------------------------------ Alpha Vantage ----------------------------- */

/** Free tier: 25 requests a day. The default leaves room for lookups. */
export const ALPHA_VANTAGE_REQUESTS_PER_RUN_DEFAULT = 15;
/** The free tier's daily quota; a pass may never be told to exceed it. */
export const ALPHA_VANTAGE_REQUESTS_PER_RUN_MAX = 25;
/** Free tier: 5 requests a minute. */
export const ALPHA_VANTAGE_REQUESTS_PER_MINUTE_DEFAULT = 5;
export const ALPHA_VANTAGE_REQUESTS_PER_MINUTE_MAX = 5;

/**
 * The most Alpha Vantage requests one **consumer lookup** may make inline.
 * Deliberately tiny: the whole day's quota is 25, and one consumer call
 * asking for a hundred TSX symbols must not spend it. The rest come back as
 * `pending` and are picked up by the deferred run.
 */
export const LOOKUP_ALPHA_VANTAGE_MAX = 3;

export interface Integration {
  key: IntegrationKey;
  name: string;
  description: string;
  provider: IntegrationProvider;
  /** The provider's base address, editable. Paths are appended by the code. */
  baseUrl: string;
  /** Whether the provider needs a key for this integration's calls. */
  requiresApiKey: boolean;
  /** The environment variable the key is read from; never the key itself. */
  apiKeyEnv: string | null;
  /** Whether that variable is set in this deployment. Presence only. */
  apiKeyConfigured: boolean;
  isEnabled: boolean;
  schedule: IntegrationSchedule;
  settings: IntegrationSettings;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  /** When the scheduler will next start it; null while `off` or disabled. */
  nextRunAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
  /** The newest run, so a list can show status without a second call. */
  latestRun: IntegrationRun | null;
}

/** What `PATCH /api/v1/admin/integrations/[key]` accepts. Every field optional. */
export interface IntegrationPatch {
  baseUrl?: string;
  isEnabled?: boolean;
  schedule?: Partial<IntegrationSchedule>;
  settings?: IntegrationSettings;
}

export interface IntegrationListResponse {
  integrations: Integration[];
  /**
   * Whether this process runs the scheduler (`src/instrumentation.ts`,
   * switched off with `INTEGRATIONS_SCHEDULER=off`). When false, nothing
   * starts on its own and the page says so.
   */
  schedulerActive: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                 Page views                                 */
/* -------------------------------------------------------------------------- */

/**
 * The three views of the Integrations page, and what `?view=` may say. Kept
 * here, away from any `"use client"` module, because the Server Component
 * route reads `?view=` and a client module's function cannot be called from
 * the server. Named `...ViewKey` rather than `...View`: `IntegrationsView` is
 * the component for the first of them.
 */
export const INTEGRATIONS_VIEWS = ["integrations", "quotes", "rates"] as const;

export type IntegrationsViewKey = (typeof INTEGRATIONS_VIEWS)[number];

export function isIntegrationsView(value: string): value is IntegrationsViewKey {
  return (INTEGRATIONS_VIEWS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/*                                    Runs                                    */
/* -------------------------------------------------------------------------- */

/**
 * Why a run started: the scheduler, an operator's "Run now", or a consumer
 * request for a symbol or pair the cache did not have.
 */
export type RunTrigger = "scheduled" | "manual" | "on_demand";

/**
 * `queued` → `running` → `succeeded` | `failed`. `interrupted` is what a
 * running run becomes when its heartbeat goes stale (the process restarted
 * under it); every batch commits on its own, so nothing already written is
 * lost and the run can simply be started again.
 */
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted";

export interface IntegrationRun {
  id: string;
  integrationKey: IntegrationKey;
  trigger: RunTrigger;
  status: RunStatus;
  /** Items the run set out to process (rows, symbols, pairs); null until known. */
  total: number | null;
  processed: number;
  /** Rows inserted (catalogs) or quotes/rates written for the first time. */
  created: number;
  /** Rows updated (a quote or rate for a day that already had one). */
  updated: number;
  /** Items skipped because they were already current. */
  unchanged: number;
  /** Items the provider refused or did not return. */
  failed: number;
  error: string | null;
  /** The request as received (forced, symbols asked for, ...), for the record. */
  request: Record<string, unknown>;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
}

/** What `POST /api/v1/admin/integrations/[key]/run` accepts. */
export interface RunRequest {
  /**
   * Quotes and rates: refresh every active item even if it was already
   * fetched today. Catalogs ignore it (they only ever insert missing rows).
   */
  force?: boolean;
}

/**
 * A run whose heartbeat (or, while still `queued`, whose creation) is older
 * than this is reported as `interrupted`. Same reasoning as the Constants jobs.
 */
export const RUN_STALE_AFTER_MS = 5 * 60_000;

/** How often a running run refreshes its heartbeat regardless of progress. */
export const RUN_HEARTBEAT_INTERVAL_MS = 15_000;

/* -------------------------------------------------------------------------- */
/*                                   Quotes                                   */
/* -------------------------------------------------------------------------- */

export const QUOTE_KINDS = ["stock", "etf", "crypto"] as const;

export type QuoteKind = (typeof QUOTE_KINDS)[number];

export function isQuoteKind(value: string): value is QuoteKind {
  return (QUOTE_KINDS as readonly string[]).includes(value);
}

/** How an item entered a watch list. */
export type WatchSource = "manual" | "request";

/**
 * A symbol the quote integration keeps current.
 *
 * `symbol` is the bare ticker as the catalog spells it (`AAPL`, `SHOP`,
 * `BTC/USD`); `exchange` is the catalog's exchange name for stocks and ETFs
 * and null for crypto. `canonical` is what is sent to the provider and what
 * the consumer app asks for: `SYMBOL:EXCHANGE` when an exchange is set
 * (`SHOP:TSX`), the bare symbol otherwise (`AAPL`, `BTC/USD`). It is unique.
 */
export interface QuoteSymbol {
  id: string;
  kind: QuoteKind;
  symbol: string;
  exchange: string | null;
  canonical: string;
  /** From the admin catalog when the symbol was found there; null otherwise. */
  name: string | null;
  currency: string | null;
  source: WatchSource;
  /**
   * Which provider last served this symbol, so the runs stop paying twice to
   * learn what they already know: a symbol Alpha Vantage owns skips
   * TwelveData (whose free plan refuses it anyway), and one TwelveData serves
   * never spends an Alpha Vantage request. `null` until a quote is saved.
   */
  provider: IntegrationProvider | null;
  /** Inactive symbols are kept but skipped by the daily run. */
  isActive: boolean;
  lastQuotedAt: string | null;
  lastError: string | null;
  createdAt: string;
  createdBy: string | null;
  latestQuote: Quote | null;
}

/** An end-of-day quote for one symbol on one trading day. */
export interface Quote {
  /** The canonical symbol (see `QuoteSymbol.canonical`). */
  symbol: string;
  /** The trading day, `YYYY-MM-DD`. */
  quoteDate: string;
  close: number;
  open: number | null;
  high: number | null;
  low: number | null;
  /** The provider's currency for the quote; empty when it reported none. */
  currency: string;
  /** Provider-reported daily change, in the quote's currency. */
  change: number | null;
  /** Provider-reported daily change as a fraction (0.0064 = 0.64 %). */
  percentChange: number | null;
  provider: IntegrationProvider;
  /** When the provider was last asked; the daily run skips a symbol fetched today. */
  fetchedAt: string;
}

/** What `POST /api/v1/admin/integrations/quote-symbols` accepts. */
export interface QuoteSymbolInput {
  kind: QuoteKind;
  symbol: string;
  /** Required for stocks and ETFs, ignored for crypto. */
  exchange?: string | null;
}

/** What `PATCH /api/v1/admin/integrations/quote-symbols/[id]` accepts. */
export interface QuoteSymbolPatch {
  isActive?: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                Exchange rates                              */
/* -------------------------------------------------------------------------- */

/** A currency pair the rate integration keeps current. Codes are ISO 4217, uppercase. */
export interface CurrencyPair {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  source: WatchSource;
  isActive: boolean;
  lastRatedAt: string | null;
  lastError: string | null;
  createdAt: string;
  createdBy: string | null;
  latestRate: ExchangeRate | null;
}

/**
 * `rate` is how many `toCurrency` one `fromCurrency` buys, on `date`.
 *
 * The Bank of Canada publishes every currency against CAD only
 * (`FXUSDCAD` = CAD per 1 USD). A pair with CAD on either side is read
 * straight from that (`source: "boc"`, inverted for CAD → X); a pair with CAD
 * on neither side is the ratio of the two CAD series (`source: "derived"`).
 */
export interface ExchangeRate {
  fromCurrency: string;
  toCurrency: string;
  /** The observation day, `YYYY-MM-DD`. */
  date: string;
  rate: number;
  source: "boc" | "derived";
  fetchedAt: string;
}

/** What `POST /api/v1/admin/integrations/currency-pairs` accepts. */
export interface CurrencyPairInput {
  fromCurrency: string;
  toCurrency: string;
}

/** What `PATCH /api/v1/admin/integrations/currency-pairs/[id]` accepts. */
export interface CurrencyPairPatch {
  isActive?: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                    Lists                                   */
/* -------------------------------------------------------------------------- */

export const WATCH_PAGE_SIZE_DEFAULT = 50;
export const WATCH_PAGE_SIZE_MAX = 200;

/** Paging and search for the two watch lists. */
export interface WatchListQuery {
  page?: number;
  pageSize?: number;
  /** Case-insensitive substring over symbol / name (quotes) or the two codes (pairs). */
  q?: string;
  /** Quotes only. */
  kind?: QuoteKind;
  /** `all` (default) or only the active / inactive items. */
  active?: "all" | "active" | "inactive";
}

export interface WatchListPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type QuoteSymbolListResponse = WatchListPage<QuoteSymbol>;
export type CurrencyPairListResponse = WatchListPage<CurrencyPair>;

/* -------------------------------------------------------------------------- */
/*                         Service endpoints (consumer app)                   */
/* -------------------------------------------------------------------------- */

/** The most symbols or pairs one service lookup may ask for. */
export const LOOKUP_ITEMS_MAX = 100;

/** Why a requested item has no answer. */
export type LookupMissReason =
  /** The provider did not return it (unknown symbol, unsupported currency). */
  | "not_found"
  /** The provider could not be reached or refused; try again later. */
  | "provider_error"
  /**
   * The integration is disabled, its key is not configured, or an operator
   * deactivated this item on the watch list.
   */
  | "unavailable"
  /** A fetch has been started; ask again shortly. */
  | "pending";

export interface LookupMiss {
  /** The canonical symbol or the `FROM/TO` pair as requested. */
  requested: string;
  reason: LookupMissReason;
}

/**
 * `GET /api/v1/service/quotes?symbols=AAPL,SHOP:TSX,BTC/USD` — the newest
 * cached quote per symbol.
 *
 * One request fetches at most one batch (`settings.batchSize`) of symbols
 * inline, so a lookup answers in seconds however many symbols it names; the
 * rest are picked up by a background `on_demand` run and come back as their
 * newest cached value, or as `pending`. A symbol the provider answered for and
 * the cache did not know is added to the watch list.
 */
export interface QuoteLookupResponse {
  quotes: Quote[];
  missing: LookupMiss[];
}

/**
 * `GET /api/v1/service/exchange-rates?pairs=USD/CAD,EUR/USD` — the newest
 * cached rate per pair, fetching first for any pair with no rate from today
 * (one provider call covers every pair). A pair a rate was computed for and
 * the cache did not know is added to the watch list.
 */
export interface ExchangeRateLookupResponse {
  rates: ExchangeRate[];
  missing: LookupMiss[];
}
