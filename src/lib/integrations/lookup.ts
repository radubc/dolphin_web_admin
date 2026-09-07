import "server-only";
/**
 * The on-demand path: what `GET /api/v1/service/quotes` and
 * `GET /api/v1/service/exchange-rates` do for a machine client.
 *
 * The contract these two keep, in order of importance:
 *
 * 1. **Never fail because a provider is down.** A lookup answers with the
 *    newest cached value even when it is stale, and only reports an item as
 *    missing when there is nothing cached at all. The consumer app showing a
 *    yesterday's price is a far better outcome than an error.
 * 2. **Answer inside a request.** A quote lookup fetches **at most one batch**
 *    (`settings.batchSize` symbols, one provider call) while the caller waits.
 *    TwelveData's free plan allows 8 credits a minute, so fetching 100 stale
 *    symbols inline would take a quarter of an hour; anything past the first
 *    batch is handed to a background `on_demand` run and reported as `pending`
 *    (or as its newest cached value, which is usually what the caller wants
 *    anyway). Rates need no such rule: one Bank of Canada call covers every
 *    pair at once.
 * 3. **Never spend a credit twice.** An item that was already fetched today
 *    is answered from the cache. Rates go further: because one Bank of Canada
 *    call caches every published series, a pair nobody has ever asked for can
 *    still be derived from today's cache without touching the provider.
 * 4. **Learn from the request, but only from a real one.** A symbol or pair
 *    the watch list did not have joins it (`source: "request"`) **after** the
 *    provider answered for it, never before: a watch row costs a credit every
 *    day forever, and a typo'd ticker must not buy one. An item an operator
 *    deactivated is never fetched for, never re-inserted and never
 *    reactivated — it answers from cache, or as `unavailable`.
 * 5. **Leave a trace, but only a real one.** A run row (trigger `on_demand`)
 *    is written **only** when the provider is actually called, so the
 *    Integrations page shows on-demand activity without being flooded by
 *    cache hits.
 */
import { ConflictError } from "@/lib/api/errors";
import { isToday } from "./dates";
import { alphaVantageContext, runAlphaVantagePass } from "./jobs/alpha-vantage";
import { fetchQuotesInto, runQuoteFallback } from "./jobs/quotes";
import {
  cachedSeriesIfCurrent,
  fetchAndCacheSeries,
  unpublishedMessage,
  writePairRates,
  type PairRequest,
} from "./jobs/rates";
import { unpublishedCurrency } from "./providers/bank-of-canada";
import { isProviderError } from "./providers/http";
import {
  apiKeyOf,
  createCurrencyPair,
  createQuoteSymbol,
  findCurrencyPairsFor,
  findIntegrationRow,
  findQuoteSymbolsByCanonical,
  inferKind,
  latestQuotesFor,
  latestRatesFor,
  lookupCatalog,
  markCurrencyPair,
  markQuoteSymbol,
  quoteSettings,
  settingsOf,
  splitCanonical,
} from "./repository";
import { beginRun, messageOf, type RunWork } from "./runs";
import { LOOKUP_ALPHA_VANTAGE_MAX } from "./types";
import type {
  ExchangeRate,
  ExchangeRateLookupResponse,
  LookupMiss,
  LookupMissReason,
  Quote,
  QuoteLookupResponse,
} from "./types";

/* -------------------------------------------------------------------------- */
/*                                   Quotes                                   */
/* -------------------------------------------------------------------------- */

/**
 * Adds the symbols the provider actually answered for to the watch list, so
 * the daily run takes them over from here.
 *
 * Called **after** a quote has been saved, never before: every watch row costs
 * one credit a day for as long as it is active, and a symbol the consumer app
 * asked for by mistake (a typo, a ticker that was delisted years ago) would
 * otherwise buy that spend permanently.
 *
 * Rows that already exist — active *or* inactive — are left exactly as they
 * are: the lookup path never reactivates what an operator switched off. A
 * duplicate insert (two consumer requests for the same new symbol at once) is
 * logged rather than failed; the row exists either way, which is all the
 * caller wanted.
 */
async function ensureWatched(quotes: ReadonlyMap<string, Quote>): Promise<void> {
  if (quotes.size === 0) return;
  const canonicals = [...quotes.keys()];
  const known = new Set(
    (await findQuoteSymbolsByCanonical(canonicals)).map((row) => row.canonical),
  );
  for (const canonical of canonicals) {
    if (known.has(canonical)) continue;
    const { symbol, exchange } = splitCanonical(canonical);
    try {
      const kind = await inferKind(symbol, exchange);
      const match = await lookupCatalog(kind, symbol, exchange);
      await createQuoteSymbol({
        kind,
        symbol,
        exchange,
        canonical,
        name: match?.name ?? null,
        currency: match?.currency ?? null,
        source: "request",
        createdBy: null,
      });
      // The fetch that earned the row happened before the row existed, so its
      // outcome is stamped here instead; the page would otherwise show a
      // symbol that has never been quoted next to a fresh price.
      const quote = quotes.get(canonical);
      if (quote) {
        await markQuoteSymbol(canonical, {
          quotedAt: new Date(quote.fetchedAt),
          error: null,
          // Who served it, so the next run routes straight to that provider.
          provider: quote.provider,
        });
      }
    } catch (error) {
      console.warn(`[integrations] could not watch ${canonical}: ${messageOf(error)}`);
    }
  }
}

/** What a TwelveData quote fetch needs from the integration row. */
interface QuoteFetchContext {
  baseUrl: string;
  apiKey: string;
  batchSize: number;
  creditsPerMinute: number;
}

/** Where a run body reports back to when the lookup is waiting for it. */
interface QuoteFetchOutcome {
  fetched: Map<string, Quote>;
  /** Symbols the provider was reached for and had nothing to say about. */
  notFound: Set<string>;
}

/**
 * The run body both on-demand quote runs share: fetch `symbols`, record what
 * came back, and only then put the answered ones on the watch list.
 *
 * `alphaVantageOnly` are symbols that must not be sent to TwelveData at all —
 * Alpha Vantage already served them once, so a TwelveData credit spent on
 * them would only buy the same refusal again. They go straight to the
 * fallback, along with whatever TwelveData does not return this time.
 *
 * `outcome` is filled in as it goes, which is what lets the inline caller read
 * the quotes without waiting for the run row to be written back.
 */
function quoteLookupWork(
  context: QuoteFetchContext | null,
  symbols: readonly string[],
  outcome: QuoteFetchOutcome,
  alphaVantageOnly: readonly string[] = [],
): RunWork {
  return async (report) => {
    const total = symbols.length + alphaVantageOnly.length;
    const result =
      context === null || symbols.length === 0
        ? null
        : await fetchQuotesInto({
            baseUrl: context.baseUrl,
            apiKey: context.apiKey,
            symbols: [...symbols],
            batchSize: context.batchSize,
            creditsPerMinute: context.creditsPerMinute,
            onProgress: async (totals) => {
              await report({ total, ...totals });
            },
          });

    if (result !== null) {
      for (const [symbol, quote] of result.quotes) outcome.fetched.set(symbol, quote);
      // Only the symbols a quote was saved for are worth a daily credit.
      await ensureWatched(result.quotes);
    }

    // Everything TwelveData did not answer for, minus what it is known to
    // serve, plus the symbols routed straight here.
    const missed = symbols.filter((symbol) => !outcome.fetched.has(symbol));
    const fallback = await runQuoteFallback([...alphaVantageOnly, ...missed]);
    if (fallback !== null) {
      for (const [symbol, quote] of fallback.quotes) outcome.fetched.set(symbol, quote);
      await ensureWatched(fallback.quotes);
      for (const symbol of fallback.notFound) outcome.notFound.add(symbol);
    }

    for (const symbol of symbols) {
      // Reached a provider, and none of them had anything for this symbol.
      if (!outcome.fetched.has(symbol) && result?.anySucceeded) outcome.notFound.add(symbol);
    }

    const rescued = fallback === null ? 0 : fallback.created + fallback.updated;
    const created = (result?.created ?? 0) + (fallback?.created ?? 0);
    const updated = (result?.updated ?? 0) + (fallback?.updated ?? 0);
    await report({
      total,
      processed: (result?.processed ?? 0) + alphaVantageOnly.length,
      created,
      updated,
      failed: total - created - updated,
    });

    if (result !== null && !result.anySucceeded && result.lastError && rescued === 0) {
      throw new Error(result.lastError);
    }
  };
}

/**
 * Starts a background run for the symbols this request will not fetch itself.
 *
 * Never throws: a live run (the daily one, or another lookup's) means the
 * values are already on their way, and any other failure is the background
 * run's problem, not the caller's. `false` says nothing was started.
 */
async function startDeferredQuoteRun(
  context: QuoteFetchContext | null,
  symbols: readonly string[],
  alphaVantageOnly: readonly string[] = [],
): Promise<boolean> {
  if (symbols.length === 0 && alphaVantageOnly.length === 0) return false;
  try {
    await beginRun({
      integrationKey: "twelvedata_quotes",
      trigger: "on_demand",
      requestedBy: null,
      request: {
        symbols: [...symbols],
        ...(alphaVantageOnly.length === 0 ? {} : { alphaVantage: [...alphaVantageOnly] }),
        deferred: true,
      },
      total: symbols.length + alphaVantageOnly.length,
      inline: false,
      work: quoteLookupWork(
        context,
        symbols,
        { fetched: new Map(), notFound: new Set() },
        alphaVantageOnly,
      ),
    });
    return true;
  } catch (error) {
    if (!(error instanceof ConflictError)) {
      console.warn(`[integrations] could not start the deferred quote run: ${messageOf(error)}`);
    }
    return false;
  }
}

/**
 * The Alpha Vantage half of an inline lookup: at most
 * `LOOKUP_ALPHA_VANTAGE_MAX` symbols, recorded as an `on_demand` run of the
 * fallback integration so the page shows the requests it spent.
 *
 * Bounded deliberately hard. The free tier's whole day is 25 requests, and a
 * consumer call naming forty TSX tickers must not be able to spend it; the
 * rest come back `pending` and the deferred run picks them up.
 *
 * Never throws. Returns the reason to record for the symbols it could not
 * answer, or `null` when the fallback is not configured at all.
 */
async function lookupViaAlphaVantage(
  symbols: readonly string[],
  outcome: QuoteFetchOutcome,
): Promise<LookupMissReason> {
  const context = await alphaVantageContext();
  // Not seeded, disabled, or no key: nothing here can serve these symbols.
  if (context === null) return "unavailable";

  try {
    await beginRun({
      integrationKey: "alpha_vantage_quotes",
      trigger: "on_demand",
      requestedBy: null,
      request: { symbols: [...symbols] },
      total: symbols.length,
      inline: true,
      work: async (report) => {
        const result = await runAlphaVantagePass(context, symbols, {
          limit: LOOKUP_ALPHA_VANTAGE_MAX,
          onProgress: async (progress) => {
            await report({
              total: symbols.length,
              processed: progress.requests,
              created: progress.created,
              updated: progress.updated,
              failed: progress.notFound.size,
            });
          },
        });
        for (const [symbol, quote] of result.quotes) outcome.fetched.set(symbol, quote);
        for (const symbol of result.notFound) outcome.notFound.add(symbol);
        await ensureWatched(result.quotes);
        await report({
          total: symbols.length,
          processed: result.requests,
          created: result.created,
          updated: result.updated,
          failed: result.notFound.size,
        });
        if (result.stoppedBy !== null) throw new Error(result.stoppedBy);
      },
    });
    return "provider_error";
  } catch (error) {
    // A live run holds the fallback: the values are on their way.
    if (error instanceof ConflictError) return "pending";
    console.warn(`[integrations] the Alpha Vantage lookup fell back to cache: ${messageOf(error)}`);
    return "provider_error";
  }
}

/**
 * The newest cached quote per symbol, fetching the ones with nothing from
 * today — at most one TwelveData batch and `LOOKUP_ALPHA_VANTAGE_MAX` Alpha
 * Vantage requests inline.
 *
 * Symbols are routed by memory first: one Alpha Vantage already served skips
 * TwelveData entirely, and one TwelveData serves is never offered to the
 * fallback. That is what keeps a 25-a-day quota usable at all.
 *
 * @param symbols canonical, already trimmed and uppercased by the schema.
 */
export async function lookupQuotes(symbols: readonly string[]): Promise<QuoteLookupResponse> {
  const cached = await latestQuotesFor(symbols);
  const watched = new Map(
    (await findQuoteSymbolsByCanonical(symbols)).map((row) => [row.canonical, row] as const),
  );
  const reasons = new Map<string, LookupMissReason>();

  /** Due a fetch, split by which provider is known to serve them. */
  const viaTwelveData: string[] = [];
  const viaAlphaVantage: string[] = [];
  for (const symbol of symbols) {
    const row = watched.get(symbol);
    if (row && !row.is_active) {
      // An operator switched this symbol off. Answer whatever is cached and
      // spend nothing; never fetch, never reactivate.
      reasons.set(symbol, "unavailable");
      continue;
    }
    const quote = cached.get(symbol);
    if (quote && isToday(new Date(quote.fetchedAt))) continue;
    if (row?.provider === "alpha_vantage") viaAlphaVantage.push(symbol);
    else viaTwelveData.push(symbol);
  }

  // Everything was fetched today (or is switched off): answer from cache and
  // write no run row.
  if (viaTwelveData.length === 0 && viaAlphaVantage.length === 0) {
    return answerQuotes(symbols, cached, new Map(), reasons, "provider_error");
  }

  const outcome: QuoteFetchOutcome = { fetched: new Map(), notFound: new Set() };

  /* ------------------------------ TwelveData ------------------------------ */

  const row = await findIntegrationRow("twelvedata_quotes");
  const apiKey = row ? apiKeyOf(row) : null;
  const usable = row !== null && row.is_enabled && !(row.requires_api_key && !apiKey);

  let context: QuoteFetchContext | null = null;
  let inline: string[] = [];
  let deferred: string[] = [];
  let reason: LookupMissReason = usable ? "provider_error" : "unavailable";

  if (usable && row !== null && viaTwelveData.length > 0) {
    const { batchSize, creditsPerMinute } = quoteSettings(settingsOf(row.settings));
    context = {
      baseUrl: row.base_url,
      apiKey: apiKey ?? "",
      batchSize,
      creditsPerMinute,
    };
    // One batch is one provider call. Everything beyond it would be paced
    // against the plan's per-minute allowance, which is minutes of waiting.
    inline = viaTwelveData.slice(0, batchSize);
    deferred = viaTwelveData.slice(batchSize);

    try {
      await beginRun({
        integrationKey: "twelvedata_quotes",
        trigger: "on_demand",
        requestedBy: null,
        request: { symbols: inline },
        total: inline.length,
        inline: true,
        // The fallback is run here, for these symbols only, further down; the
        // run body is given no fallback list of its own so the tiny inline
        // Alpha Vantage budget is spent once and in one place.
        work: quoteLookupWork(context, inline, outcome),
      });
    } catch (error) {
      // A live run holds the integration: the values are being fetched right
      // now, so this is "ask again shortly" rather than an outage.
      if (error instanceof ConflictError) reason = "pending";
      else if (isProviderError(error) && error.kind === "auth") reason = "unavailable";
      else reason = "provider_error";
      console.warn(`[integrations] quote lookup fell back to cache: ${messageOf(error)}`);
    }

    for (const symbol of inline) {
      reasons.set(symbol, outcome.notFound.has(symbol) ? "not_found" : reason);
    }
  } else if (viaTwelveData.length > 0) {
    // TwelveData is disabled, unseeded or keyless. These symbols get no
    // deferred run either: there is nothing to defer them to. They answer
    // from cache, or as `unavailable`.
    for (const symbol of viaTwelveData) reasons.set(symbol, "unavailable");
  }

  /* ----------------------------- Alpha Vantage ---------------------------- */

  // The fallback's turn: the symbols it already owns, then the ones this
  // request's TwelveData batch could not answer and TwelveData does not own.
  const fallbackCandidates = [
    ...viaAlphaVantage,
    ...inline.filter(
      (symbol) =>
        !outcome.fetched.has(symbol) && watched.get(symbol)?.provider !== "twelvedata",
    ),
  ];
  const fallbackInline = fallbackCandidates.slice(0, LOOKUP_ALPHA_VANTAGE_MAX);
  const fallbackDeferred = fallbackCandidates.slice(LOOKUP_ALPHA_VANTAGE_MAX);

  if (fallbackInline.length > 0) {
    const fallbackReason = await lookupViaAlphaVantage(fallbackInline, outcome);
    for (const symbol of fallbackInline) {
      if (outcome.fetched.has(symbol)) {
        reasons.delete(symbol);
        continue;
      }
      reasons.set(symbol, outcome.notFound.has(symbol) ? "not_found" : fallbackReason);
    }
  }

  /* -------------------------------- Deferred ------------------------------ */

  if (deferred.length > 0 || fallbackDeferred.length > 0) {
    // Started, or skipped because one is already live — either way a fetch is
    // in flight for these, so the answer is the same.
    await startDeferredQuoteRun(context, deferred, fallbackDeferred);
    for (const symbol of [...deferred, ...fallbackDeferred]) reasons.set(symbol, "pending");
  }

  return answerQuotes(symbols, cached, outcome.fetched, reasons, reason);
}

/**
 * Assembles the answer: a freshly fetched quote wins, then the cache however
 * old it is, and only then a miss with the reason recorded for that symbol.
 */
function answerQuotes(
  symbols: readonly string[],
  cached: ReadonlyMap<string, Quote>,
  fetched: ReadonlyMap<string, Quote>,
  reasons: ReadonlyMap<string, LookupMissReason>,
  fallback: LookupMissReason,
): QuoteLookupResponse {
  const quotes: Quote[] = [];
  const missing: LookupMiss[] = [];
  for (const symbol of symbols) {
    const quote = fetched.get(symbol) ?? cached.get(symbol);
    if (quote) {
      quotes.push(quote);
      continue;
    }
    missing.push({ requested: symbol, reason: reasons.get(symbol) ?? fallback });
  }
  return { quotes, missing };
}

/* -------------------------------------------------------------------------- */
/*                               Exchange rates                               */
/* -------------------------------------------------------------------------- */

/** `USD/CAD` as the schema validated it. */
function parsePair(pair: string): PairRequest {
  const [from, to] = pair.split("/");
  return { from, to };
}

const pairKey = (pair: PairRequest): string => `${pair.from}/${pair.to}`;

/**
 * Adds the pairs a rate was actually computed for to the watch list.
 *
 * Same rule as `ensureWatched`: only after the provider's data answered for
 * the pair, and never for a row that already exists — an operator's
 * deactivation is not undone here, and re-inserting it would only trip the
 * unique key. A pair of one currency with itself is not a watch row at all
 * (the table's CHECK forbids it); it is answered arithmetically.
 */
async function ensurePairsWatched(
  pairs: readonly PairRequest[],
  ratedAt: Date,
): Promise<void> {
  const candidates = pairs.filter((pair) => pair.from !== pair.to);
  if (candidates.length === 0) return;
  const known = new Set(
    (await findCurrencyPairsFor(candidates)).map((row) =>
      pairKey({ from: row.from_currency, to: row.to_currency }),
    ),
  );
  for (const pair of candidates) {
    if (known.has(pairKey(pair))) continue;
    try {
      await createCurrencyPair({
        fromCurrency: pair.from,
        toCurrency: pair.to,
        source: "request",
        createdBy: null,
      });
      // Same as the quote path: the rate was written before the row existed.
      await markCurrencyPair(pair.from, pair.to, { ratedAt, error: null });
    } catch (error) {
      console.warn(
        `[integrations] could not watch ${pair.from}/${pair.to}: ${messageOf(error)}`,
      );
    }
  }
}

/**
 * Writes the rates for `pairs` from a set of series, then puts the ones that
 * worked on the watch list.
 */
async function writeAndWatch(
  pairs: readonly PairRequest[],
  series: ReadonlyMap<string, number>,
  date: string,
  fetchedAt: Date,
): Promise<Awaited<ReturnType<typeof writePairRates>>> {
  const written = await writePairRates(pairs, series, date, fetchedAt);
  await ensurePairsWatched(
    pairs.filter((pair) => written.rates.has(pairKey(pair))),
    fetchedAt,
  );
  return written;
}

/**
 * The newest cached rate per pair, fetching only when today's Bank of Canada
 * series are not cached yet.
 *
 * One provider call covers every pair, so there is no batching rule here: a
 * lookup either finds today's series in the cache, or makes that one call.
 *
 * `requested` spellings are kept exactly as they arrived (`USD/CAD`), because
 * that is what the caller matches its own request against.
 */
export async function lookupExchangeRates(
  requested: readonly string[],
): Promise<ExchangeRateLookupResponse> {
  const pairs = requested.map(parsePair);
  const cached = await latestRatesFor(pairs);
  const watched = new Map(
    (await findCurrencyPairsFor(pairs)).map(
      (row) => [pairKey({ from: row.from_currency, to: row.to_currency }), row] as const,
    ),
  );
  const reasons = new Map<string, LookupMissReason>();

  const fetchable: PairRequest[] = [];
  for (const pair of pairs) {
    const key = pairKey(pair);
    const row = watched.get(key);
    if (row && !row.is_active) {
      // Deactivated by an operator: cache only, and nothing written for it.
      reasons.set(key, "unavailable");
      continue;
    }
    const rate = cached.get(key);
    if (rate && isToday(new Date(rate.fetchedAt))) continue;
    fetchable.push(pair);
  }

  if (fetchable.length === 0) {
    return answerRates(requested, cached, new Map(), reasons, "provider_error");
  }

  // One call a day caches every published series, so a pair that has never
  // been asked for can still be derived without touching the provider.
  const current = await cachedSeriesIfCurrent();
  if (current) {
    const written = await writeAndWatch(fetchable, current.series, current.date, new Date());
    return answerRates(requested, cached, written.rates, reasons, "provider_error", written.errors);
  }

  const row = await findIntegrationRow("bank_of_canada_rates");
  if (!row || !row.is_enabled) {
    for (const pair of fetchable) reasons.set(pairKey(pair), "unavailable");
    return answerRates(requested, cached, new Map(), reasons, "unavailable");
  }

  let fetched = new Map<string, ExchangeRate>();
  let errors = new Map<string, string>();
  let reason: LookupMissReason = "provider_error";
  try {
    await beginRun({
      integrationKey: "bank_of_canada_rates",
      trigger: "on_demand",
      requestedBy: null,
      request: { pairs: fetchable.map(pairKey) },
      total: fetchable.length,
      inline: true,
      work: async (report) => {
        const { observation, fetchedAt } = await fetchAndCacheSeries(row.base_url);
        const written = await writeAndWatch(
          fetchable,
          observation.rates,
          observation.date,
          fetchedAt,
        );
        fetched = written.rates;
        errors = written.errors;
        await report({
          total: fetchable.length,
          processed: fetchable.length,
          created: written.created,
          updated: written.updated,
          failed: written.failed,
        });
      },
    });
  } catch (error) {
    // A live run is already fetching the same single document.
    if (error instanceof ConflictError) reason = "pending";
    console.warn(`[integrations] rate lookup fell back to cache: ${messageOf(error)}`);
  }

  return answerRates(requested, cached, fetched, reasons, reason, errors);
}

/**
 * Assembles the answer. A pair the Bank does not publish a currency for is a
 * `not_found`, whatever the cache holds — but a cached value still wins,
 * because a rate that was published once is better than nothing.
 */
function answerRates(
  requested: readonly string[],
  cached: ReadonlyMap<string, ExchangeRate>,
  fetched: ReadonlyMap<string, ExchangeRate>,
  reasons: ReadonlyMap<string, LookupMissReason>,
  fallback: LookupMissReason,
  errors: ReadonlyMap<string, string> = new Map(),
): ExchangeRateLookupResponse {
  const rates: ExchangeRate[] = [];
  const missing: LookupMiss[] = [];
  for (const pair of requested) {
    const rate = fetched.get(pair) ?? cached.get(pair);
    if (rate) {
      rates.push(rate);
      continue;
    }
    const reason = errors.has(pair) ? "not_found" : (reasons.get(pair) ?? fallback);
    missing.push({ requested: pair, reason });
  }
  return { rates, missing };
}

/** Re-exported so a caller can name the reason a currency was refused. */
export { unpublishedCurrency, unpublishedMessage };
