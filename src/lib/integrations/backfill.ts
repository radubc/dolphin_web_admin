import "server-only";
/**
 * Six months of history for **one** currency pair, on demand.
 *
 * Two operator actions share this module and nothing else does:
 *
 * - adding a pair by hand (`POST /api/v1/admin/integrations/currency-pairs`),
 *   which used to leave the row with no rate at all until that night's run;
 * - the "Fetch 6 months" button in the pair's download-history drawer
 *   (`POST …/currency-pairs/[id]/backfill`).
 *
 * It is deliberately **not** on the service path: `lookup.ts` still owns what
 * `GET /api/v1/service/exchange-rates` does, and that contract is unchanged.
 * What is shared with it is the machinery underneath — `fetchObservations` and
 * `writeHistoricalRates` in `jobs/rates.ts`, the same `on_demand` run record —
 * so there is one implementation of "ask the Bank for a range and store it".
 *
 * The rules it adds on top of `writeHistoricalRates`, which are what make this
 * an operator action rather than a lookup:
 *
 * - **One call.** The Valet group URL takes `start_date` / `end_date` and
 *   answers every published business day in one document, so a six-month
 *   backfill is a single request however many days come back (about 125).
 * - **The watch row is stamped, carefully.** A historical write never touches
 *   `admin_currency_pairs` (a rate from 2019 says nothing about today), but
 *   this window *ends today*: when the newest day the Bank can have published
 *   (`publishedThrough`) is among the days written, the pair really is current
 *   and `last_rated_at` is stamped so tonight's run skips it. When it is not —
 *   a series the Bank discontinued mid-window — the row is left alone and the
 *   nightly run still tries. When no day at all could be rated, the pair keeps
 *   the "not published" message in `last_error`, which is the same verdict the
 *   nightly run would have written.
 * - **It never throws.** A disabled integration, a busy run or a provider
 *   error comes back as a `status` on the result. Adding a pair must not fail
 *   because the Bank is down: the row belongs on the watch list either way.
 */
import { ConflictError } from "@/lib/api/errors";
import { shiftDays, todayIn, type IsoDate } from "./dates";
import {
  fetchObservations,
  unpublishedMessage,
  writeHistoricalRates,
  type PairRequest,
} from "./jobs/rates";
import { publishedThrough } from "./providers/bank-of-canada";
import { findIntegrationRow, markCurrencyPair, ratesInRange } from "./repository";
import { beginRun, messageOf } from "./runs";
import {
  CURRENCY_PAIR_BACKFILL_DAYS,
  type CurrencyPairHistory,
  type ExchangeRate,
} from "./types";

/** Why the run was started, recorded on the run row for the drawer. */
export type BackfillReason = "manual_add" | "manual_backfill";

const pairKey = (pair: PairRequest): string => `${pair.from}/${pair.to}`;

/** `today − CURRENCY_PAIR_BACKFILL_DAYS` → today, in market time. */
export function backfillWindow(): { from: IsoDate; to: IsoDate } {
  const to = todayIn();
  return { from: shiftDays(to, -CURRENCY_PAIR_BACKFILL_DAYS), to };
}

/** The stored rows and the freshly written ones, by day, oldest first. */
function daysCovered(
  stored: readonly ExchangeRate[] = [],
  written: readonly ExchangeRate[] = [],
): ExchangeRate[] {
  const byDate = new Map(stored.map((rate) => [rate.date, rate] as const));
  for (const rate of written) byDate.set(rate.date, rate);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Fetches and stores every day the Bank published for `pair` between `from`
 * and `to`, as one inline `on_demand` run.
 *
 * The pair's watch row is expected to exist already (both callers create it or
 * look it up first); `markCurrencyPair` is an `updateMany`, so a missing row is
 * a no-op rather than an error.
 *
 * Never throws — every failure is a `status` on the answer.
 */
export async function backfillPairHistory(
  pair: PairRequest,
  from: IsoDate,
  to: IsoDate,
  options: { requestedBy?: string | null; reason?: BackfillReason } = {},
): Promise<CurrencyPairHistory> {
  const key = pairKey(pair);
  const result: CurrencyPairHistory = {
    status: "written",
    from,
    to,
    days: 0,
    latestDate: null,
    created: 0,
    updated: 0,
    unchanged: 0,
    current: false,
    runId: null,
    error: null,
  };

  const row = await findIntegrationRow("bank_of_canada_rates");
  if (!row) {
    return {
      ...result,
      status: "unavailable",
      error:
        "The Bank of Canada integration is not installed, so no history was fetched. Run docs/sql/008_integrations.sql.",
    };
  }
  if (!row.is_enabled) {
    return {
      ...result,
      status: "unavailable",
      error: "The Bank of Canada integration is switched off, so no history was fetched.",
    };
  }

  // What the table already holds for the window: both the answer's starting
  // point and the "which rows are new" test `writeHistoricalRates` needs.
  const stored = await ratesInRange([pair], from, to);

  try {
    const run = await beginRun({
      integrationKey: "bank_of_canada_rates",
      trigger: "on_demand",
      requestedBy: options.requestedBy ?? null,
      request: { pairs: [key], from, to, reason: options.reason ?? "manual_backfill" },
      total: 1,
      inline: true,
      work: async (report) => {
        const { observations, fetchedAt } = await fetchObservations(row.base_url, from, to);
        const written = await writeHistoricalRates([pair], observations, stored, fetchedAt);
        const days = daysCovered(stored.get(key), written.rates.get(key));

        result.created = written.created;
        result.updated = written.updated;
        result.unchanged = written.unchanged;
        result.days = days.length;
        result.latestDate = days.at(-1)?.date ?? null;

        if (days.length === 0) {
          // No day in six months could be rated: one of the two currencies has
          // no series at all. The nightly run would say exactly this, so say it
          // now and put it on the row.
          const message = written.errors.get(key) ?? unpublishedMessage(pair.from);
          result.status = "unpublished";
          result.error = message;
          await markCurrencyPair(pair.from, pair.to, { ratedAt: null, error: message });
        } else if (result.latestDate !== null && result.latestDate >= publishedThrough(to)) {
          // The newest day the Bank can have published is stored, so the pair
          // is current: stamp it and clear whatever error it carried, which is
          // what makes tonight's run skip it.
          result.current = true;
          await markCurrencyPair(pair.from, pair.to, { ratedAt: fetchedAt, error: null });
        }
        // Otherwise the window produced days but stops short of the newest one
        // (a discontinued series). The watch row is left exactly as it was:
        // claiming the pair is current would silence the nightly run for a
        // rate it does not have.

        await report({
          total: 1,
          processed: 1,
          created: written.created,
          updated: written.updated,
          unchanged: written.unchanged,
          failed: written.failed,
        });
      },
    });

    result.runId = run.id;
    if (run.status !== "succeeded") {
      // `beginRun` inline answers with the finished row rather than throwing,
      // so a provider error arrives here as a failed run.
      result.status = "failed";
      result.error = run.error ?? "The Bank of Canada run did not finish.";
    }
    return result;
  } catch (error) {
    if (error instanceof ConflictError) {
      return {
        ...result,
        status: "busy",
        error:
          "A Bank of Canada run is already in progress, so no history was fetched yet. Try again in a moment.",
      };
    }
    // A missing `admin_integration_runs` table, or the database refusing the
    // insert. The pair itself is fine; only its history is missing.
    console.warn(`[integrations] history backfill for ${key} failed: ${messageOf(error)}`);
    return { ...result, status: "failed", error: messageOf(error) };
  }
}
