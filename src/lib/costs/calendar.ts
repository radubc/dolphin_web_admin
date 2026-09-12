/**
 * The calendar arithmetic the cost feature needs, all of it in **UTC**.
 *
 * Billing days are UTC days: Cost Explorer reports `2026-09-11` and means the
 * UTC day, and `admin_cost_daily.day` is a `DATE` column holding exactly
 * that. The integrations' market-data helpers (`src/lib/integrations/dates.ts`)
 * deliberately answer "is this today?" in Toronto time, because a stale quote
 * is a wall-clock question; a billing day is not, so this module never looks
 * at a timezone.
 *
 * Two conventions from the Cost Explorer API are baked in here so no caller
 * has to remember them:
 *
 * - **`End` is exclusive.** "The last 35 days ending yesterday" is
 *   `Start = today - 35`, `End = today`.
 * - **Nothing is known about today.** Today's spend has barely happened and
 *   AWS has not totalled it, so every window the job asks for and every
 *   figure the page shows ends at yesterday.
 *
 * Plain data, no server-only imports: the page uses the same functions.
 */
import dayjs from "dayjs";
import utcPlugin from "dayjs/plugin/utc";

dayjs.extend(utcPlugin);

/** `YYYY-MM-DD`, the only date format that crosses a boundary here. */
export type IsoDay = string;

/** `YYYY-MM`, a month label. */
export type IsoMonth = string;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today's UTC calendar day. The job's whole notion of "now". */
export function todayUtc(now: Date = new Date()): IsoDay {
  return dayjs(now).utc().format("YYYY-MM-DD");
}

/** `days` before (negative) or after (positive) a UTC calendar day. */
export function shiftDay(day: IsoDay, days: number): IsoDay {
  return dayjs.utc(day).add(days, "day").format("YYYY-MM-DD");
}

/** The month a day falls in, `YYYY-MM`. */
export function monthOf(day: IsoDay): IsoMonth {
  return day.slice(0, 7);
}

/** The first day of the month a day falls in. */
export function startOfMonth(day: IsoDay): IsoDay {
  return `${monthOf(day)}-01`;
}

/** The first day of the month *after* the one a day falls in. */
export function startOfNextMonth(day: IsoDay): IsoDay {
  return dayjs.utc(day).add(1, "month").startOf("month").format("YYYY-MM-DD");
}

/** The first day of the month *before* the one a day falls in. */
export function startOfPreviousMonth(day: IsoDay): IsoDay {
  return dayjs.utc(day).subtract(1, "month").startOf("month").format("YYYY-MM-DD");
}

/** The last day of the month a day falls in. */
export function endOfMonth(day: IsoDay): IsoDay {
  return shiftDay(startOfNextMonth(day), -1);
}

/**
 * `months` before (negative) or after (positive) a month label.
 *
 * Month arithmetic belongs here with the rest of the calendar: `dayjs.utc`
 * handles the year rollover and the short months, where a hand-rolled
 * `Date.UTC(year, month - n, 1)` reads like arithmetic and behaves like a
 * calendar only by accident.
 */
export function shiftMonth(month: IsoMonth, months: number): IsoMonth {
  return dayjs.utc(`${month}-01`).add(months, "month").format("YYYY-MM");
}

/**
 * The day of the month, 1..31.
 *
 * The job reads it to decide how far into a month the *previous* month is
 * still worth re-reading by component: the last day of a month only settles a
 * day or two into the next one, and each re-read is a charged Cost Explorer
 * request.
 */
export function dayOfMonth(day: IsoDay): number {
  return dayjs.utc(day).date();
}

/**
 * True when a day is the last of its month.
 *
 * The forecast no longer depends on it — `GetCostForecast` is asked for
 * `[today, 1st of next month)`, which on the last day of a month is still one
 * whole day and a legal request, because that API's `Start` must be *no
 * later* than today. Kept because "is this the end of a billing month" is a
 * question the calendar should be able to answer.
 */
export function isLastDayOfMonth(day: IsoDay): boolean {
  return shiftDay(day, 1) === startOfNextMonth(day);
}

/** A `DATE` column value for a UTC day: midnight UTC, which Prisma round-trips. */
export function toDateColumn(day: IsoDay): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A `DATE` column back as `YYYY-MM-DD`. */
export function fromDateColumn(value: Date): IsoDay {
  return dayjs(value).utc().format("YYYY-MM-DD");
}

/** `[from, from+1, …, to]` inclusive. Empty when `to` is before `from`. */
export function daysBetween(from: IsoDay, to: IsoDay): IsoDay[] {
  const days: IsoDay[] = [];
  let cursor = from;
  // A hard stop as well as the comparison: a malformed input must not spin.
  for (let guard = 0; guard < 1000 && cursor <= to; guard += 1) {
    days.push(cursor);
    cursor = shiftDay(cursor, 1);
  }
  return days;
}

/** The date part of an AWS `YYYY-MM-DD` (or datetime) string, or null. */
export function isoDayFrom(value: unknown): IsoDay | null {
  if (typeof value !== "string") return null;
  const head = value.trim().slice(0, 10);
  return ISO_DAY.test(head) ? head : null;
}

/** `11 Sep 2026`, for a chart axis or a table cell. */
export function formatDay(day: IsoDay): string {
  return dayjs.utc(day).format("D MMM YYYY");
}

/** `11 Sep`, for a dense axis. */
export function formatDayShort(day: IsoDay): string {
  return dayjs.utc(day).format("D MMM");
}

/** `September 2026`, for a section heading. */
export function formatMonth(month: IsoMonth): string {
  return dayjs.utc(`${month}-01`).format("MMMM YYYY");
}
