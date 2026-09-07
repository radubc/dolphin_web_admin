import "server-only";
/**
 * The `alpha_vantage_quotes` integration: a **fallback**, not a schedule.
 *
 * TwelveData's free plan refuses Canadian and most other non-US listings
 * (`SHOP:TSX` comes back as an error, having spent the credit), so the macOS
 * app grew a second quote provider for exactly those symbols. This is that
 * fallback, moved into the admin app: a pass that Alpha Vantage's
 * `GLOBAL_QUOTE` serves one symbol at a time.
 *
 * ## Where it runs from
 *
 * Three callers, one engine (`runAlphaVantagePass`):
 *
 * - the daily `twelvedata_quotes` run, over the symbols TwelveData did not
 *   return. It runs *inside* that run, and its results are counted in that
 *   run's counters — one run row per day, not two;
 * - an on-demand quote lookup, bounded to `LOOKUP_ALPHA_VANTAGE_MAX` symbols
 *   so one consumer request cannot spend the day's whole quota;
 * - this integration's own **Run now**, which refreshes the symbols Alpha
 *   Vantage already owns and never touches TwelveData.
 *
 * Its `schedule.frequency` is seeded `off` for that reason. Enabling a daily
 * schedule is allowed and does something sensible (it is the Run now body),
 * but it is not how the fallback is meant to earn its keep.
 *
 * ## Quota, and why the pass stops
 *
 * The free tier is 25 requests a day and 5 a minute. So:
 *
 * - a symbol Alpha Vantage cannot resolve is never asked about
 *   (`quoteSymbolFromCanonical` returns null for crypto pairs and for
 *   exchanges with no documented suffix);
 * - `maxRequestsPerRun` caps a pass, and symbols beyond the cap are left
 *   exactly as they were — including whatever error TwelveData last recorded
 *   for them — to be picked up the next day;
 * - a throttle answer (which arrives as HTTP 200 with a `Note` or
 *   `Information` body) stops the pass **immediately**. Every request after
 *   it would return the same non-answer, and on the daily quota that is the
 *   difference between losing one symbol and losing tomorrow's too.
 *
 * ## Which provider owns a symbol
 *
 * A saved quote stamps `admin_quote_symbols.provider`. That is the memory the
 * next run routes by: a symbol Alpha Vantage served skips TwelveData (whose
 * free plan will only refuse it again, for a credit), and one TwelveData
 * served never spends an Alpha Vantage request.
 */
import { isToday } from "../dates";
import { fetchGlobalQuote, quoteSymbolFromCanonical } from "../providers/alpha-vantage";
import { sleep } from "../providers/http";
import {
  alphaVantageSettings,
  apiKeyOf,
  findIntegrationRow,
  findQuoteSymbolsByCanonical,
  latestQuotesFor,
  listActiveQuoteSymbols,
  markQuoteSymbol,
  settingsOf,
  upsertQuote,
} from "../repository";
import type { RunWork } from "../runs";
import type { Quote } from "../types";

/** What a pass needs; assembled by `alphaVantageContext` or by the service. */
export interface AlphaVantagePassContext {
  baseUrl: string;
  apiKey: string;
  /** The most requests this pass may make. Never above the tier's daily quota. */
  maxRequestsPerRun: number;
  /** The tier's per-minute allowance; the pass paces itself to it. */
  requestsPerMinute: number;
}

export interface AlphaVantagePassResult {
  /** The quotes written, keyed by the canonical symbol asked for. */
  quotes: Map<string, Quote>;
  /** Symbols Alpha Vantage was reached for and had nothing to say about. */
  notFound: Set<string>;
  /**
   * Symbols the pass never asked anyone about: not mappable to Alpha Vantage
   * notation, past the request cap, or after the throttle stopped it. These
   * keep whatever error they already carried.
   */
  skipped: string[];
  created: number;
  updated: number;
  /** Requests actually spent, for the quota arithmetic and the log line. */
  requests: number;
  /** The throttle or quota message that ended the pass, if one did. */
  stoppedBy: string | null;
}

/**
 * The integration's context, or `null` when the fallback must not run: the
 * row is not seeded, an operator disabled it, or `ALPHA_VANTAGE_API_KEY` is
 * not set on this deployment.
 *
 * Returning `null` rather than throwing is deliberate — every caller is in
 * the middle of doing something else (a TwelveData run, a consumer lookup),
 * and "there is no fallback configured" is a normal state, not a failure.
 */
export async function alphaVantageContext(): Promise<AlphaVantagePassContext | null> {
  const row = await findIntegrationRow("alpha_vantage_quotes");
  if (!row || !row.is_enabled) return null;
  const apiKey = apiKeyOf(row);
  if (row.requires_api_key && !apiKey) return null;
  const settings = alphaVantageSettings(settingsOf(row.settings));
  return {
    baseUrl: row.base_url,
    apiKey: apiKey ?? "",
    maxRequestsPerRun: settings.maxRequestsPerRun,
    requestsPerMinute: settings.requestsPerMinute,
  };
}

export interface AlphaVantagePassOptions {
  /**
   * A tighter cap than the integration's own, for a caller that must not
   * spend the whole allowance (a consumer lookup takes three).
   */
  limit?: number;
  /** Called after each request with the running result, for the heartbeat. */
  onProgress?: (result: AlphaVantagePassResult) => Promise<void>;
}

/**
 * Asks Alpha Vantage for `symbols`, sequentially and paced, and stores what
 * comes back.
 *
 * Never throws: the caller is spending a limited quota inside somebody else's
 * run, and every outcome — including "the day's quota is gone" — is part of
 * the result rather than an exception. The one thing it does is stop early.
 *
 * The currency is taken from the watch row's catalog currency, because Alpha
 * Vantage reports none at all; `""` when the catalog does not know either,
 * which is what the `admin_quotes.currency` NOT NULL column expects.
 */
export async function runAlphaVantagePass(
  context: AlphaVantagePassContext,
  symbols: readonly string[],
  options: AlphaVantagePassOptions = {},
): Promise<AlphaVantagePassResult> {
  const result: AlphaVantagePassResult = {
    quotes: new Map(),
    notFound: new Set(),
    skipped: [],
    created: 0,
    updated: 0,
    requests: 0,
    stoppedBy: null,
  };
  if (symbols.length === 0) return result;

  const limit = Math.max(
    0,
    Math.min(context.maxRequestsPerRun, options.limit ?? context.maxRequestsPerRun),
  );
  if (limit === 0) {
    result.skipped.push(...symbols);
    return result;
  }

  // One query for the currencies: Alpha Vantage reports none, and asking the
  // catalog per symbol would be a round trip for every request.
  const currencyOf = new Map<string, string>();
  for (const row of await findQuoteSymbolsByCanonical(symbols)) {
    currencyOf.set(row.canonical, row.currency ?? "");
  }

  const pauseMs = 60_000 / Math.max(1, context.requestsPerMinute);
  /** When the previous request was sent, so the pacing subtracts its duration. */
  let lastRequestAt = 0;

  for (const [index, canonical] of symbols.entries()) {
    if (result.stoppedBy !== null || result.requests >= limit) {
      result.skipped.push(canonical);
      continue;
    }
    const avSymbol = quoteSymbolFromCanonical(canonical);
    if (avSymbol === null) {
      // Not resolvable at Alpha Vantage: never spend a request on it.
      result.skipped.push(canonical);
      continue;
    }

    // Paced from the second request on; nothing precedes the first. The wait
    // is measured from the moment the previous request was *sent*, so a slow
    // answer shortens it rather than adding to it.
    if (lastRequestAt !== 0) await sleep(pauseMs - (Date.now() - lastRequestAt));
    lastRequestAt = Date.now();
    result.requests += 1;
    const outcome = await fetchGlobalQuote(context.baseUrl, context.apiKey, avSymbol);

    if (outcome.kind === "throttled") {
      // The rest of this pass would learn the same thing 24 times over.
      result.stoppedBy = outcome.message;
      console.warn(`[integrations] alpha vantage: ${outcome.message} — stopping the pass`);
      // Everything after this point is untouched, not failed.
      result.skipped.push(...symbols.slice(index + 1));
      await options.onProgress?.(result);
      break;
    }

    if (outcome.kind === "failed") {
      result.notFound.add(canonical);
      await markQuoteSymbol(canonical, { quotedAt: null, error: outcome.message });
      await options.onProgress?.(result);
      continue;
    }

    if (outcome.kind === "not_found") {
      result.notFound.add(canonical);
      await markQuoteSymbol(canonical, {
        quotedAt: null,
        error: "Neither TwelveData nor Alpha Vantage returned a quote for this symbol.",
      });
      await options.onProgress?.(result);
      continue;
    }

    const fetchedAt = new Date();
    const quote: Quote = {
      symbol: canonical,
      quoteDate: outcome.quote.quoteDate,
      close: outcome.quote.close,
      open: outcome.quote.open,
      high: outcome.quote.high,
      low: outcome.quote.low,
      currency: currencyOf.get(canonical) ?? "",
      change: outcome.quote.change,
      percentChange: outcome.quote.percentChange,
      provider: "alpha_vantage",
      fetchedAt: fetchedAt.toISOString(),
    };
    const written = await upsertQuote({
      symbol: quote.symbol,
      quoteDate: quote.quoteDate,
      close: quote.close,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      currency: quote.currency,
      change: quote.change,
      percentChange: quote.percentChange,
      provider: "alpha_vantage",
      fetchedAt,
    });
    if (written === "created") result.created += 1;
    else result.updated += 1;
    result.quotes.set(canonical, quote);
    // Remember who served it: the next run asks this provider first and
    // spends no TwelveData credit finding out what it already knows.
    await markQuoteSymbol(canonical, {
      quotedAt: fetchedAt,
      error: null,
      provider: "alpha_vantage",
    });
    await options.onProgress?.(result);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*                                  Run now                                   */
/* -------------------------------------------------------------------------- */

export interface AlphaVantageRunContext extends AlphaVantagePassContext {
  /** Refresh even a symbol already quoted today. */
  force: boolean;
}

/**
 * The body of this integration's own **Run now**.
 *
 * It refreshes, up to the cap, the active symbols Alpha Vantage already owns
 * (`provider = 'alpha_vantage'`) plus any active symbol with no quote from
 * today, and it never calls TwelveData. Symbols Alpha Vantage cannot resolve
 * at all are filtered out before the counters are set, so `total` is what the
 * run could actually attempt rather than a number it was always going to miss.
 *
 * A pass stopped by the quota fails the run, with the provider's own message:
 * pressing Run now and being told "succeeded, 0 created" would hide exactly
 * the thing the operator needs to know.
 */
export function alphaVantageQuotesWork(context: AlphaVantageRunContext): RunWork {
  return async (report) => {
    const active = await listActiveQuoteSymbols();
    const mappable = active.filter((row) => quoteSymbolFromCanonical(row.canonical) !== null);
    const cached = await latestQuotesFor(mappable.map((row) => row.canonical));

    const candidates: string[] = [];
    let unchanged = 0;
    for (const row of mappable) {
      const quote = cached.get(row.canonical);
      const fresh = quote ? isToday(new Date(quote.fetchedAt)) : false;
      // A symbol this provider owns is always refreshed — that is what the
      // button is for — while any other symbol is only fetched when nothing
      // from today is cached for it.
      if (context.force || row.provider === "alpha_vantage" || !fresh) candidates.push(row.canonical);
      else unchanged += 1;
    }

    await report({ total: candidates.length, processed: 0, unchanged });
    if (candidates.length === 0) return;

    const result = await runAlphaVantagePass(context, candidates, {
      onProgress: async (progress) => {
        await report({
          total: candidates.length,
          processed: progress.requests,
          created: progress.created,
          updated: progress.updated,
          unchanged,
          failed: progress.notFound.size,
        });
      },
    });

    await report({
      total: candidates.length,
      processed: result.requests,
      created: result.created,
      updated: result.updated,
      unchanged,
      failed: result.notFound.size,
    });
    console.info(
      `[integrations] alpha vantage: ${result.requests} requests, ` +
        `${result.created + result.updated} quotes, ${result.skipped.length} left for next time`,
    );
    if (result.stoppedBy !== null) throw new Error(result.stoppedBy);
  };
}
