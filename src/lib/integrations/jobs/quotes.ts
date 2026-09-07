import "server-only";
/**
 * The `twelvedata_quotes` run, and the batching helper the on-demand lookup
 * shares with it.
 *
 * **What it fetches.** Every active row of the quote watch list that has not
 * already been quoted today, unless the request carried `force`. "Today" is a
 * wall-clock day in the market timezone, not UTC (see `../dates`), because
 * that is the day an operator means when they say a quote is current.
 *
 * **Credits.** TwelveData charges one credit per symbol, whether it is asked
 * for on its own or inside a batch, and the free plan allows 8 a minute and
 * 800 a day. So the batch size (how many symbols per request) and the credit
 * allowance (how fast requests may follow each other) are two separate
 * settings, and the pacing here is computed from the credits actually spent:
 * a batch of N symbols is followed by a pause long enough that N credits per
 * `creditsPerMinute` have been earned back, minus the time the request itself
 * took.
 *
 * **Failure.** A 401/403 stops the whole run — the key is wrong and every
 * further request would waste a credit to learn the same thing. A 429 pauses
 * and retries the batch once, then gives up on that batch and moves on. Any
 * other provider failure marks the batch's symbols failed and carries on, so
 * one bad symbol list cannot cost the whole run; if *every* batch failed the
 * run itself fails, because at that point nothing was accomplished.
 *
 * **The Alpha Vantage fallback.** TwelveData's free plan refuses non-US
 * listings, so after the batches the symbols it did not return are offered to
 * Alpha Vantage (`./alpha-vantage.ts`), inside this same run and counted in
 * this same run's counters. Two rules keep that cheap: which provider last
 * served a symbol is remembered on `admin_quote_symbols.provider`, so a
 * symbol Alpha Vantage owns never spends a TwelveData credit again and one
 * TwelveData owns never spends an Alpha Vantage request; and the fallback is
 * capped per run, with the symbols past the cap keeping their TwelveData
 * error until the next day.
 */
import { isToday } from "../dates";
import { isProviderError, sleep } from "../providers/http";
import { fetchQuotes } from "../providers/twelvedata";
import {
  latestQuotesFor,
  listActiveQuoteSymbols,
  markQuoteSymbol,
  upsertQuote,
} from "../repository";
import type { RunWork } from "../runs";
import type { IntegrationProvider, Quote } from "../types";
import {
  alphaVantageContext,
  runAlphaVantagePass,
  type AlphaVantagePassContext,
  type AlphaVantagePassResult,
} from "./alpha-vantage";

/** How long to wait out a 429 before retrying the batch once. */
const RATE_LIMIT_PAUSE_MS = 60_000;

export interface QuoteFetchOptions {
  baseUrl: string;
  apiKey: string;
  /** Canonical symbols, in the order they should be spent. */
  symbols: string[];
  batchSize: number;
  creditsPerMinute: number;
  /** Called after every batch with the running totals, for the heartbeat. */
  onProgress?: (totals: QuoteFetchTotals) => Promise<void>;
}

export interface QuoteFetchTotals {
  processed: number;
  created: number;
  updated: number;
  failed: number;
}

export interface QuoteFetchResult extends QuoteFetchTotals {
  /** The quotes written, keyed by the canonical symbol that was requested. */
  quotes: Map<string, Quote>;
  /** The last provider failure, for the run's `error` when nothing succeeded. */
  lastError: string | null;
  /** True when at least one batch reached the provider and was parsed. */
  anySucceeded: boolean;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  const width = Math.max(1, Math.trunc(size));
  for (let index = 0; index < values.length; index += width) {
    chunks.push(values.slice(index, index + width));
  }
  return chunks;
}

/**
 * Fetches, parses and stores quotes for `symbols`, in paced batches.
 *
 * Shared by the daily run and by `GET /api/v1/service/quotes`, so both spend
 * credits the same way and both leave the watch list's `last_quoted_at` and
 * `last_error` in the same state.
 *
 * @throws {ProviderError} only for `auth`: the caller decides what a wrong key
 * means (a failed run, or a `unavailable` miss in a lookup).
 */
export async function fetchQuotesInto(options: QuoteFetchOptions): Promise<QuoteFetchResult> {
  const totals: QuoteFetchTotals = { processed: 0, created: 0, updated: 0, failed: 0 };
  const quotes = new Map<string, Quote>();
  let lastError: string | null = null;
  let anySucceeded = false;

  const batches = chunk(options.symbols, options.batchSize);
  for (const [index, batch] of batches.entries()) {
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof fetchQuotes>> | null = null;
    try {
      result = await fetchQuotes(options.baseUrl, options.apiKey, batch);
    } catch (error) {
      if (isProviderError(error) && error.kind === "auth") throw error;
      if (isProviderError(error) && error.kind === "rate_limit") {
        // Wait the allowance out and try this batch once more before writing
        // it off; a burst is much more likely than a dead plan.
        console.warn(`[integrations] quotes: rate limited, pausing ${RATE_LIMIT_PAUSE_MS} ms`);
        await sleep(RATE_LIMIT_PAUSE_MS);
        try {
          result = await fetchQuotes(options.baseUrl, options.apiKey, batch);
        } catch (retryError) {
          if (isProviderError(retryError) && retryError.kind === "auth") throw retryError;
          result = null;
          lastError = retryError instanceof Error ? retryError.message : String(retryError);
        }
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (result === null) {
      totals.processed += batch.length;
      totals.failed += batch.length;
      for (const symbol of batch) {
        await markQuoteSymbol(symbol, { quotedAt: null, error: lastError });
      }
    } else {
      anySucceeded = true;
      const fetchedAt = new Date();
      for (const parsed of result.quotes) {
        const outcome = await upsertQuote({
          symbol: parsed.requested,
          quoteDate: parsed.quoteDate,
          close: parsed.close,
          open: parsed.open,
          high: parsed.high,
          low: parsed.low,
          currency: parsed.currency,
          change: parsed.change,
          percentChange: parsed.percentChange,
          provider: "twelvedata",
          fetchedAt,
        });
        totals.processed += 1;
        if (outcome === "created") totals.created += 1;
        else totals.updated += 1;
        quotes.set(parsed.requested, {
          symbol: parsed.requested,
          quoteDate: parsed.quoteDate,
          close: parsed.close,
          open: parsed.open,
          high: parsed.high,
          low: parsed.low,
          currency: parsed.currency,
          change: parsed.change,
          percentChange: parsed.percentChange,
          provider: "twelvedata",
          fetchedAt: fetchedAt.toISOString(),
        });
        // Remember who served it, so the Alpha Vantage fallback never spends
        // one of its 25 daily requests on a symbol TwelveData handles.
        await markQuoteSymbol(parsed.requested, {
          quotedAt: fetchedAt,
          error: null,
          provider: "twelvedata",
        });
      }
      for (const symbol of result.missing) {
        totals.processed += 1;
        totals.failed += 1;
        await markQuoteSymbol(symbol, {
          quotedAt: null,
          error: "The provider returned no quote for this symbol.",
        });
      }
    }

    await options.onProgress?.({ ...totals });

    // Pace against the plan: N credits were just spent, so wait until N
    // credits' worth of the minute has passed, minus the time the request
    // itself took. Skipped after the last batch — nothing follows it.
    if (index < batches.length - 1) {
      const owed = (batch.length / Math.max(1, options.creditsPerMinute)) * 60_000;
      await sleep(owed - (Date.now() - startedAt));
    }
  }

  return { ...totals, quotes, lastError, anySucceeded };
}

export interface QuotesRunContext {
  baseUrl: string;
  apiKey: string;
  batchSize: number;
  creditsPerMinute: number;
  /** Re-fetch every active symbol, even one already quoted today. */
  force: boolean;
}

/**
 * Runs the Alpha Vantage fallback over `symbols`, if there is one configured.
 *
 * Split out because three run bodies want it on the same terms: never throw,
 * never let the fallback's own trouble fail the run that called it, and hand
 * back enough to fold into that run's counters. `null` means the fallback is
 * not configured (no row, disabled, or no key) — a normal state, not an error.
 */
export async function runQuoteFallback(
  symbols: readonly string[],
  options: { context?: AlphaVantagePassContext | null; limit?: number } = {},
): Promise<AlphaVantagePassResult | null> {
  if (symbols.length === 0) return null;
  const context = options.context === undefined ? await alphaVantageContext() : options.context;
  if (context === null) return null;
  try {
    return await runAlphaVantagePass(context, symbols, { limit: options.limit });
  } catch (error) {
    // The pass reports its outcomes rather than throwing, so this is a bug or
    // a database hiccup. Either way the TwelveData results already written
    // are worth keeping.
    console.warn(
      `[integrations] quotes: the Alpha Vantage fallback failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * The daily run body.
 *
 * `unchanged` counts the active symbols that were already current, which is
 * the normal outcome of a second run on the same day and the reason `force`
 * exists at all.
 *
 * The run is in two acts. TwelveData is asked for every due symbol it has not
 * already been shown to refuse; then Alpha Vantage is offered the ones it did
 * not return, plus the ones it is already known not to serve — which are not
 * sent to TwelveData at all, because a credit spent to be refused again is a
 * credit wasted twice over. Both acts report into one set of counters and one
 * run row: from an operator's side this is still "the daily quote run".
 */
export function quotesWork(context: QuotesRunContext): RunWork {
  return async (report) => {
    const active = await listActiveQuoteSymbols();
    const canonicals = active.map((row) => row.canonical);
    const cached = context.force ? new Map<string, Quote>() : await latestQuotesFor(canonicals);

    /** Symbols due a fetch, split by which provider owns them. */
    const viaTwelveData: string[] = [];
    const viaAlphaVantage: string[] = [];
    /** Who served each due symbol last time, for the fallback's routing. */
    const ownerOf = new Map<string, IntegrationProvider | null>();
    let unchanged = 0;

    for (const row of active) {
      const quote = cached.get(row.canonical);
      const fetchedToday = quote ? isToday(new Date(quote.fetchedAt)) : false;
      if (!context.force && fetchedToday) {
        unchanged += 1;
        continue;
      }
      const owner = (row.provider as IntegrationProvider | null) ?? null;
      ownerOf.set(row.canonical, owner);
      if (owner === "alpha_vantage") viaAlphaVantage.push(row.canonical);
      else viaTwelveData.push(row.canonical);
    }

    await report({ total: active.length, processed: unchanged, unchanged });
    if (viaTwelveData.length === 0 && viaAlphaVantage.length === 0) return;

    /* ------------------------------ TwelveData ----------------------------- */

    let result: Awaited<ReturnType<typeof fetchQuotesInto>> | null = null;
    /** A refused TwelveData key. Held, not rethrown yet: see below. */
    let authError: Error | null = null;

    if (viaTwelveData.length > 0) {
      try {
        result = await fetchQuotesInto({
          baseUrl: context.baseUrl,
          apiKey: context.apiKey,
          symbols: viaTwelveData,
          batchSize: context.batchSize,
          creditsPerMinute: context.creditsPerMinute,
          onProgress: async (totals) => {
            await report({
              total: active.length,
              processed: unchanged + totals.processed,
              created: totals.created,
              updated: totals.updated,
              unchanged,
              failed: totals.failed,
            });
          },
        });
      } catch (error) {
        // Only an `auth` failure escapes `fetchQuotesInto`; everything else is
        // already a counted, per-batch outcome. It is caught rather than left
        // to propagate so the symbols Alpha Vantage owns — which never needed
        // TwelveData at all — still get their pass. It is rethrown at the end,
        // because a refused key is a configuration fault the operator has to
        // see, whatever else the run managed.
        authError = error instanceof Error ? error : new Error(String(error));
        console.error(`[integrations] quotes: TwelveData refused the key — ${authError.message}`);
      }
    }

    const twelveData = result ?? {
      processed: 0,
      created: 0,
      updated: 0,
      // A refused key means none of its symbols were fetched; they are the
      // run's failures, and the error says why.
      failed: authError === null ? 0 : viaTwelveData.length,
    };

    /* ---------------------------- Alpha Vantage ---------------------------- */

    // The symbols TwelveData did not answer for, minus the ones it is known
    // to serve (a transient error there is not a reason to spend one of the
    // 25 daily Alpha Vantage requests). Empty when the key was refused: that
    // says nothing about whether TwelveData serves these listings, and
    // spending the day's Alpha Vantage quota on a misconfiguration would be
    // the wrong lesson to draw from it.
    const missed =
      result === null
        ? []
        : viaTwelveData.filter(
            (symbol) => !result.quotes.has(symbol) && ownerOf.get(symbol) !== "twelvedata",
          );
    const fallbackSymbols = [...viaAlphaVantage, ...missed];

    const fallback = await runQuoteFallback(fallbackSymbols);
    const rescued = fallback === null ? 0 : fallback.created + fallback.updated;
    // A symbol TwelveData already counted as failed and Alpha Vantage then
    // answered for is no longer a failure; one Alpha Vantage was asked first
    // for and could not serve is a new one.
    const rescuedFromMissed =
      fallback === null ? 0 : missed.filter((symbol) => fallback.quotes.has(symbol)).length;
    const alphaVantageOnlyFailed =
      fallback === null
        ? viaAlphaVantage.length
        : viaAlphaVantage.filter((symbol) => !fallback.quotes.has(symbol)).length;

    await report({
      total: active.length,
      processed: unchanged + twelveData.processed + viaAlphaVantage.length,
      created: twelveData.created + (fallback?.created ?? 0),
      updated: twelveData.updated + (fallback?.updated ?? 0),
      unchanged,
      failed: twelveData.failed - rescuedFromMissed + alphaVantageOnlyFailed,
    });

    if (fallback !== null) {
      console.info(
        `[integrations] quotes: ${twelveData.created + twelveData.updated} via TwelveData, ` +
          `${rescued} via Alpha Vantage (${fallback.requests} requests, ` +
          `${fallback.skipped.length} left for next time)`,
      );
      if (fallback.stoppedBy !== null) {
        console.warn(`[integrations] quotes: the fallback stopped early — ${fallback.stoppedBy}`);
      }
    }

    // A refused key is always reported, even when the fallback saved some of
    // the run: the counters written above survive the failure, so nothing the
    // run achieved is lost by saying so.
    if (authError !== null) throw authError;

    // Nothing reached either provider at all: that is a failed run, not a run
    // that quietly did nothing.
    if (result !== null && !result.anySucceeded && result.lastError && rescued === 0) {
      throw new Error(result.lastError);
    }
  };
}
