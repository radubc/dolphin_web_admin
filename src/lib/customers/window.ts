/**
 * Narrowing a customer-statistics payload to a shorter window.
 *
 * The Activity view has two range knobs — months and days — and the endpoint
 * that answers them is the most expensive read in the console: the monthly
 * churn denominators are one `users` count each, and the largest-tenant
 * tables aggregate `file_blobs` and `transactions` across every tenant. A
 * payload for 24 months and 90 days already *contains* the answer for 6
 * months and 14 days, so narrowing it in the browser is exactly right and one
 * request fewer; only widening needs the server.
 *
 * What that costs in honesty is nothing: every series here is a list of whole
 * UTC months or whole UTC days, oldest first, and a shorter window is a
 * suffix of a longer one. The daily series are cut by date rather than by
 * position, because a day nothing happened on is deliberately absent from
 * them (`admin_pool_metrics_daily` has no row for an idle day, and the view
 * draws the gap as "no figure" rather than as a zero).
 *
 * `generatedAt` is kept as it was: the figures really were assembled then,
 * and the view prints it. Pure, no imports, no React — safe on either side.
 */
import type { CustomerStatistics } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` for a UTC instant. */
function dayLabel(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Whether `payload` already covers a `months` × `days` window, so it can be
 * narrowed instead of re-fetched.
 *
 * Equal is covered: the payload is then returned unchanged.
 */
export function coversWindow(
  payload: CustomerStatistics,
  months: number,
  days: number,
): boolean {
  return payload.months >= months && payload.days >= days;
}

/**
 * `payload` cut down to the last `months` months and `days` days.
 *
 * A window wider than the payload is returned as-is rather than padded:
 * inventing empty months would be inventing measurements. Call
 * {@link coversWindow} first when that matters.
 */
export function narrowStatistics(
  payload: CustomerStatistics,
  months: number,
  days: number,
): CustomerStatistics {
  if (payload.months === months && payload.days === days) return payload;

  // The monthly series are one entry per month in the window, oldest first
  // (the endpoint fills the gaps), so a shorter window is the tail.
  const tail = <T>(series: readonly T[]): T[] =>
    months >= series.length ? [...series] : series.slice(series.length - months);

  // The daily series are sparse, so they are cut by date. The same instant
  // the server measured from is used, not the browser's clock, so the
  // boundary cannot drift by a day for a tab left open overnight.
  const generatedAt = Date.parse(payload.generatedAt);
  const from = Number.isNaN(generatedAt) ? null : dayLabel(generatedAt - days * DAY_MS);
  const since = <T extends { day: string }>(series: readonly T[]): T[] =>
    from === null ? [...series] : series.filter((entry) => entry.day >= from);

  // The endpoint sends the same days twice, as two arrays, so a chart can take
  // one of them without filtering a wide one. Both are cut the same way: over
  // the wire they are two separate arrays, so sharing the result would be a
  // change of shape for no gain.
  const requestsPerDay = since(payload.usage.requestsPerDay);
  const errorsPerDay = since(payload.usage.errorsPerDay);

  return {
    ...payload,
    newPerMonth: tail(payload.newPerMonth),
    deletedPerMonth: tail(payload.deletedPerMonth),
    churnPerMonth: tail(payload.churnPerMonth),
    retentionBySignupMonth: tail(payload.retentionBySignupMonth),
    poolMetrics: since(payload.poolMetrics),
    usage: { requestsPerDay, errorsPerDay },
    months: Math.min(months, payload.months),
    days: Math.min(days, payload.days),
  };
}
