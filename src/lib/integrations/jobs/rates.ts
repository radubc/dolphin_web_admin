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
 * **Only watched pairs are stored.** `admin_exchange_rates` holds rows for the
 * pairs on `admin_currency_pairs` and nothing else. The published document
 * carries about 27 `X → CAD` series and an earlier version of this module
 * wrote every one of them as a rate row so that a later lookup could be
 * derived from the database without a second call. That filled the table with
 * pairs nobody watches, so the observation is now remembered **in process**
 * instead (see below) and the database only ever sees a watched pair.
 *
 * **The observation memo.** The last fetched document is kept in a
 * module-level variable with the instant it was fetched. Anything published
 * today answers every pair — a series, its reciprocal, or the ratio of two of
 * them — so the second and every later lookup of the day computes from the
 * memo and makes no call. The memo is per process: N app instances make up to
 * N calls a day between them, which the Valet API is free and unauthenticated
 * for, and a restart simply costs one more call.
 *
 * **Dates.** The Bank publishes at 16:30 ET, so a fetch made this morning
 * returns yesterday's observation. That is not an error and is not corrected:
 * the observation date is stored with the rate, and "is this current?" is
 * answered by when it was fetched, not by the observation date.
 *
 * **History.** The same group URL takes `start_date` / `end_date` and answers
 * one entry per published business day, which is what the dated forms of
 * `GET /api/v1/service/exchange-rates` are built on: `fetchObservations` makes
 * the one call and `writeHistoricalRates` stores the days the table did not
 * have. Those writes are still only ever for the pairs that were asked for,
 * and they deliberately leave `admin_currency_pairs` alone — a rate from 2019
 * neither makes a pair current nor says anything is wrong with it. The memo
 * plays no part: it answers "has this process read *today's* document?", and a
 * historical window is a different question every time.
 */
import { isToday, type IsoDate } from "../dates";
import {
  fetchFxObservation,
  fetchFxObservations,
  rateFor,
  unpublishedCurrency,
  type FxObservation,
} from "../providers/bank-of-canada";
import {
  insertExchangeRates,
  listActiveCurrencyPairs,
  markCurrencyPair,
  upsertExchangeRate,
  type RateUpsert,
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
    // A currency against itself is arithmetic, not an observation: answer 1
    // without writing a row (the watch list's CHECK forbids such a pair, so a
    // row for it could never belong to a watched pair) and without marking.
    if (computed && pair.from === pair.to) {
      result.rates.set(pairKey(pair), {
        fromCurrency: pair.from,
        toCurrency: pair.to,
        date,
        rate: computed.rate,
        source: computed.source,
        fetchedAt: fetchedAt.toISOString(),
      });
      continue;
    }
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

/* -------------------------------------------------------------------------- */
/*                            Historical observations                         */
/* -------------------------------------------------------------------------- */

export interface HistoricalWriteResult {
  /** Every rate computed, keyed `FROM/TO`, oldest observation day first. */
  rates: Map<string, ExchangeRate[]>;
  created: number;
  /** Rows that were already stored with a different value. */
  updated: number;
  /** Rows that were already stored with the same value. */
  unchanged: number;
  /** Pairs (not pair-days) no day in the window could be rated for. */
  failed: number;
  /** Those pairs' messages, keyed `FROM/TO`. */
  errors: Map<string, string>;
}

/**
 * A stored rate and a freshly computed one are "the same" within this much.
 *
 * The column is `numeric(20,10)`, so a value that made the round trip differs
 * from the arithmetic that produced it by up to half a unit in the tenth
 * decimal. Relative, because the published series span 1.37 (USD) to 0.001017
 * (KRW) and a fixed epsilon would be meaningless at one end or the other.
 */
const RATE_EPSILON = 1e-9;

const sameRate = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(Math.abs(a), 1) * RATE_EPSILON;

/**
 * Computes and stores each pair's rate for **every** observation day given,
 * for the historical half of the service lookup.
 *
 * Three things make this a separate function rather than a loop over
 * `writePairRates`:
 *
 * - **Statement count.** A year of business days times a handful of pairs is
 *   thousands of rows. `stored` is what the caller already read for the window
 *   (one query), so rows that are new go in one `createMany` per thousand and
 *   a row whose value has not changed costs no statement at all.
 * - **The watch row is left alone.** `writePairRates` stamps `last_rated_at`
 *   with the fetch instant, which is right for an observation of *today* and
 *   wrong for one of 2019: it would tell the nightly run the pair is already
 *   current. A historical write therefore touches no `admin_currency_pairs`
 *   row (adding a missing one is the lookup's job, `ensurePairsWatched`), and
 *   for the same reason it never writes `last_error` — a currency the Bank had
 *   not started publishing in the requested window says nothing about the
 *   pair's health today.
 * - **Per-day failure is normal.** A discontinued series stops appearing part
 *   way through a range; those days are simply absent from the answer. Only a
 *   pair with *no* day at all is a failure, and it is reported once.
 */
export async function writeHistoricalRates(
  pairs: readonly PairRequest[],
  observations: readonly FxObservation[],
  stored: ReadonlyMap<string, readonly ExchangeRate[]>,
  fetchedAt: Date,
): Promise<HistoricalWriteResult> {
  const result: HistoricalWriteResult = {
    rates: new Map(),
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    errors: new Map(),
  };
  const inserts: RateUpsert[] = [];
  const updates: RateUpsert[] = [];
  const iso = fetchedAt.toISOString();
  // The newest day's series, for naming the currency a pair failed on.
  const newest = observations.at(-1)?.rates ?? new Map<string, number>();

  for (const pair of pairs) {
    const key = pairKey(pair);
    const known = new Map(
      (stored.get(key) ?? []).map((rate) => [rate.date, rate] as const),
    );
    const computed: ExchangeRate[] = [];
    for (const observation of observations) {
      const value = rateFor(pair.from, pair.to, observation.rates);
      if (!value) continue;
      const rate: ExchangeRate = {
        fromCurrency: pair.from,
        toCurrency: pair.to,
        date: observation.date,
        rate: value.rate,
        source: value.source,
        fetchedAt: iso,
      };
      computed.push(rate);
      // A currency against itself is arithmetic, never a stored row (the watch
      // list's CHECK forbids the pair), exactly as in `writePairRates`.
      if (pair.from === pair.to) continue;
      const existing = known.get(observation.date);
      if (!existing) {
        inserts.push({ ...rate, fetchedAt });
        result.created += 1;
      } else if (sameRate(existing.rate, value.rate)) {
        result.unchanged += 1;
        // Keep the stored row in the answer: its `fetchedAt` is when the
        // figure really came from the Bank.
        computed[computed.length - 1] = existing;
      } else {
        updates.push({ ...rate, fetchedAt });
        result.updated += 1;
      }
    }
    if (computed.length > 0) {
      result.rates.set(key, computed);
      continue;
    }
    if (observations.length === 0) continue;
    const missing = unpublishedCurrency(pair.from, pair.to, newest) ?? pair.from;
    result.failed += 1;
    result.errors.set(key, unpublishedMessage(missing));
  }

  // `createMany` counts what it actually inserted; a row a concurrent writer
  // put there first is skipped, so correct the optimistic count.
  const inserted = await insertExchangeRates(inserts);
  result.created = inserted;
  result.unchanged += inserts.length - inserted;
  for (const update of updates) await upsertExchangeRate(update);
  return result;
}

/* -------------------------------------------------------------------------- */
/*                            The observation memo                            */
/* -------------------------------------------------------------------------- */

/** A fetched document and when it was fetched. */
export interface MemoisedObservation {
  observation: FxObservation;
  fetchedAt: Date;
}

/**
 * The last document this process fetched. Module-level on purpose: it is a
 * cache of one small object, it must not reach the database (that is the whole
 * point of this change), and losing it on a restart costs one free call.
 */
let memo: MemoisedObservation | null = null;

/**
 * The document fetched today, or `null` when this process has not fetched one
 * today. The on-demand path's second stop, after the pair's own cached rate:
 * when it hits, the lookup computes the pair and makes no provider call.
 *
 * "Today" is the same wall-clock test the rest of the feature uses
 * (`isToday`, America/Toronto), so the memo expires when the cached rates do.
 */
export function currentObservation(): MemoisedObservation | null {
  if (memo === null || !isToday(memo.fetchedAt)) return null;
  return memo;
}

/** Remembers a freshly fetched document for the rest of the day. */
function rememberObservation(
  observation: FxObservation,
  fetchedAt: Date,
): MemoisedObservation {
  memo = { observation, fetchedAt };
  return memo;
}

/**
 * Fetches the group and memoises it. The only place either the run or the
 * lookup reaches the Bank of Canada.
 */
export async function fetchObservation(baseUrl: string): Promise<MemoisedObservation> {
  const observation = await fetchFxObservation(baseUrl);
  return rememberObservation(observation, new Date());
}

/** A range of days as the Bank published them, with the instant they were read. */
export interface FetchedObservations {
  observations: FxObservation[];
  fetchedAt: Date;
}

/**
 * Fetches every published day between `from` and `to`, inclusive.
 *
 * Deliberately **not** memoised. The memo answers one question — "has this
 * process already read today's document?" — and the historical lookups ask a
 * different one for a different window every time; caching those would grow
 * without bound for no hit rate. The cache that serves them is
 * `admin_exchange_rates` itself, which is durable, shared by every instance
 * and already the answer the endpoint returns.
 *
 * An empty array means the window held no published day (a weekend, a
 * holiday), which is data, not a failure.
 */
export async function fetchObservations(
  baseUrl: string,
  from: IsoDate,
  to: IsoDate,
): Promise<FetchedObservations> {
  const observations = await fetchFxObservations(baseUrl, from, to);
  return { observations, fetchedAt: new Date() };
}

export interface RatesRunContext {
  baseUrl: string;
  /** Re-write every active pair even if it already has today's fetch. */
  force: boolean;
}

/**
 * The daily run body.
 *
 * `total` is the number of active pairs, which is also everything the run
 * writes: the rest of the published document is remembered in process for the
 * day's lookups and never stored.
 *
 * The run always fetches, memo or no memo — it is the scheduled read, and
 * skipping it would mean a day with no observation of its own.
 */
export function ratesWork(context: RatesRunContext): RunWork {
  return async (report) => {
    const pairs = await listActiveCurrencyPairs();
    await report({ total: pairs.length, processed: 0 });

    const { observation, fetchedAt } = await fetchObservation(context.baseUrl);

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

    console.info(
      `[integrations] rates: observation ${observation.date}, ${result.rates.size} pairs written, ` +
        `${result.failed} unpublished, ${observation.rates.size} series published`,
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
