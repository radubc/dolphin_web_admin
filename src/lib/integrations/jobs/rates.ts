import "server-only";
/**
 * The `bank_of_canada_rates` run, and the helpers the on-demand lookup shares
 * with it.
 *
 * **One request covers everything.** The Valet API publishes the whole daily
 * FX group in a single document, so the run makes exactly one outbound call
 * however many pairs are being watched, and an on-demand lookup for a pair
 * nobody has ever asked for costs nothing extra.
 *
 * **The series cache.** Every run also stores each published `X → CAD` series
 * as a rate row of its own (about 27 rows a day). That is what lets the
 * lookup answer a brand-new pair from cache: any pair is either one of those
 * series, its reciprocal, or the ratio of two of them, so once today's series
 * are cached no further provider call is needed for the rest of the day.
 *
 * **Dates.** The Bank publishes at 16:30 ET, so a fetch made this morning
 * returns yesterday's observation. That is not an error and is not corrected:
 * the observation date is stored with the rate, and "is the cache current?"
 * is answered by `fetched_at`, not by the observation date.
 */
import { isToday, type IsoDate } from "../dates";
import {
  BASE_CURRENCY,
  fetchFxObservation,
  rateFor,
  unpublishedCurrency,
  type FxObservation,
} from "../providers/bank-of-canada";
import {
  cachedSeriesFor,
  listActiveCurrencyPairs,
  markCurrencyPair,
  newestSeriesDate,
  newestSeriesFetchedAt,
  upsertExchangeRate,
} from "../repository";
import type { RunWork } from "../runs";
import type { ExchangeRate } from "../types";

export interface PairRequest {
  from: string;
  to: string;
}

export interface PairWriteResult {
  /** The rates written, keyed `FROM/TO`. */
  rates: Map<string, ExchangeRate>;
  created: number;
  updated: number;
  failed: number;
  /** Pairs the Bank does not publish a currency for, keyed `FROM/TO`. */
  errors: Map<string, string>;
}

const pairKey = (pair: PairRequest): string => `${pair.from}/${pair.to}`;

/** The message a pair carries when one of its currencies is not published. */
export function unpublishedMessage(currency: string): string {
  return `Currency ${currency} is not published by the Bank of Canada`;
}

/**
 * Computes and stores the rate for each pair from a set of `X → CAD` series,
 * and records the outcome on the watch row.
 *
 * The arithmetic is `rateFor` in the provider module; everything here is the
 * bookkeeping around it.
 */
export async function writePairRates(
  pairs: readonly PairRequest[],
  series: ReadonlyMap<string, number>,
  date: IsoDate,
  fetchedAt: Date,
): Promise<PairWriteResult> {
  const result: PairWriteResult = {
    rates: new Map(),
    created: 0,
    updated: 0,
    failed: 0,
    errors: new Map(),
  };
  for (const pair of pairs) {
    const computed = rateFor(pair.from, pair.to, series);
    if (!computed) {
      const missing = unpublishedCurrency(pair.from, pair.to, series) ?? pair.from;
      const message = unpublishedMessage(missing);
      result.failed += 1;
      result.errors.set(pairKey(pair), message);
      await markCurrencyPair(pair.from, pair.to, { ratedAt: null, error: message });
      continue;
    }
    const outcome = await upsertExchangeRate({
      fromCurrency: pair.from,
      toCurrency: pair.to,
      date,
      rate: computed.rate,
      source: computed.source,
      fetchedAt,
    });
    if (outcome === "created") result.created += 1;
    else result.updated += 1;
    result.rates.set(pairKey(pair), {
      fromCurrency: pair.from,
      toCurrency: pair.to,
      date,
      rate: computed.rate,
      source: computed.source,
      fetchedAt: fetchedAt.toISOString(),
    });
    await markCurrencyPair(pair.from, pair.to, { ratedAt: fetchedAt, error: null });
  }
  return result;
}

/**
 * Stores each published series as an `X → CAD` row, skipping pairs that were
 * just written as watch-list pairs (they are the same row, and writing it
 * twice would count it twice).
 */
export async function cacheSeries(
  observation: FxObservation,
  fetchedAt: Date,
  alreadyWritten: ReadonlySet<string>,
): Promise<number> {
  let written = 0;
  for (const [currency, value] of observation.rates) {
    const key = `${currency}/${BASE_CURRENCY}`;
    if (alreadyWritten.has(key)) continue;
    await upsertExchangeRate({
      fromCurrency: currency,
      toCurrency: BASE_CURRENCY,
      date: observation.date,
      rate: value,
      source: "boc",
      fetchedAt,
    });
    written += 1;
  }
  return written;
}

/**
 * Today's published series from the cache, or `null` when nothing was fetched
 * today. This is the on-demand path's first stop: when it hits, the lookup
 * answers without a provider call at all.
 */
export async function cachedSeriesIfCurrent(): Promise<{
  date: IsoDate;
  series: Map<string, number>;
} | null> {
  const fetchedAt = await newestSeriesFetchedAt();
  if (!isToday(fetchedAt)) return null;
  const date = await newestSeriesDate();
  if (!date) return null;
  const series = await cachedSeriesFor(date);
  return series.size === 0 ? null : { date, series };
}

/** Fetches the group and caches every series. Used by the on-demand path. */
export async function fetchAndCacheSeries(
  baseUrl: string,
): Promise<{ observation: FxObservation; fetchedAt: Date }> {
  const observation = await fetchFxObservation(baseUrl);
  const fetchedAt = new Date();
  await cacheSeries(observation, fetchedAt, new Set());
  return { observation, fetchedAt };
}

export interface RatesRunContext {
  baseUrl: string;
  /** Re-write every active pair even if it already has today's fetch. */
  force: boolean;
}

/**
 * The daily run body.
 *
 * `total` is the number of active pairs; the ~27 cached series are a side
 * effect and are logged rather than counted, so the numbers on the page mean
 * "pairs", which is what an operator is watching.
 */
export function ratesWork(context: RatesRunContext): RunWork {
  return async (report) => {
    const pairs = await listActiveCurrencyPairs();
    await report({ total: pairs.length, processed: 0 });

    const observation = await fetchFxObservation(context.baseUrl);
    const fetchedAt = new Date();

    const due = context.force
      ? pairs
      : pairs.filter((row) => !isToday(row.last_rated_at) || row.last_error !== null);
    const unchanged = pairs.length - due.length;

    const result = await writePairRates(
      due.map((row) => ({ from: row.from_currency, to: row.to_currency })),
      observation.rates,
      observation.date,
      fetchedAt,
    );

    const cached = await cacheSeries(observation, fetchedAt, new Set(result.rates.keys()));
    console.info(
      `[integrations] rates: observation ${observation.date}, ${result.rates.size} pairs written, ` +
        `${result.failed} unpublished, ${cached} series cached`,
    );

    await report({
      total: pairs.length,
      processed: pairs.length,
      created: result.created,
      updated: result.updated,
      unchanged,
      failed: result.failed,
    });
  };
}
