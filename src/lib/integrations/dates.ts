/**
 * Calendar-day arithmetic for the integrations, on `YYYY-MM-DD` strings.
 *
 * Two different notions of "day" live here and must not be confused:
 *
 * - **The quote or observation day** is a plain calendar date with no time and
 *   no zone. It comes from the provider (`datetime`, `d`), it is stored in a
 *   `DATE` column and it goes on the wire as `YYYY-MM-DD`. All of that is
 *   handled by the string helpers, which use UTC internally so that "add a
 *   day" can never be an hour short.
 * - **"Fetched today"** — the test the daily runs and the on-demand lookups
 *   use to decide whether the cache is current — is a wall-clock question, so
 *   it is answered in a real timezone (`America/Toronto`, the market
 *   timezone), not in UTC. At 20:00 in Toronto it is already tomorrow in UTC,
 *   and a cache that expired four hours early would spend credits for nothing.
 *
 * Plain data, no server-only imports.
 */
import dayjs from "dayjs";
import timezonePlugin from "dayjs/plugin/timezone";
import utcPlugin from "dayjs/plugin/utc";
import { DEFAULT_TIMEZONE } from "./types";

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

/** `YYYY-MM-DD`, the only date format that crosses a boundary here. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The date part of whatever the provider sent: `2026-09-05`,
 * `2026-09-05 15:59:00` and `2026-09-05T15:59:00Z` all give `2026-09-05`.
 * `null` when there is no date in there at all.
 */
export function isoDateFrom(value: unknown): IsoDate | null {
  if (typeof value !== "string") return null;
  const head = value.trim().slice(0, 10);
  return ISO_DATE.test(head) ? head : null;
}

/** A `DATE` column as the wire wants it. */
export function toIsoDate(value: Date): IsoDate {
  return dayjs(value).utc().format("YYYY-MM-DD");
}

/**
 * A `YYYY-MM-DD` as the value a `DATE` column takes: midnight UTC, which is
 * how Prisma round-trips `@db.Date` without ever shifting the day.
 */
export function fromIsoDate(value: IsoDate): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** `days` before (negative) or after (positive) the given calendar day. */
export function shiftDays(date: IsoDate, days: number): IsoDate {
  return dayjs.utc(date).add(days, "day").format("YYYY-MM-DD");
}

/** 0 (Sunday) to 6, for a calendar day. */
export function weekdayOf(date: IsoDate): number {
  return dayjs.utc(date).day();
}

/**
 * The trading day before `date`: one day back, then back again over Saturday
 * and Sunday. Public holidays are not modelled — the provider's own
 * `previous_close` is what is being labelled, and mislabelling a holiday by
 * one day is better than inventing a holiday calendar per exchange.
 */
export function previousTradingDay(date: IsoDate): IsoDate {
  let candidate = shiftDays(date, -1);
  while (weekdayOf(candidate) === 0 || weekdayOf(candidate) === 6) {
    candidate = shiftDays(candidate, -1);
  }
  return candidate;
}

/** Today's calendar day in `timezone` (market time, not UTC). */
export function todayIn(timezone: string = DEFAULT_TIMEZONE): IsoDate {
  return dayjs().tz(timezone).format("YYYY-MM-DD");
}

/** The instant midnight local time in `timezone` began, for a `>=` comparison. */
export function startOfTodayIn(timezone: string = DEFAULT_TIMEZONE): Date {
  return dayjs().tz(timezone).startOf("day").toDate();
}

/** True when `at` falls on today's calendar day in `timezone`. */
export function isToday(at: Date | null, timezone: string = DEFAULT_TIMEZONE): boolean {
  if (!at) return false;
  return at.getTime() >= startOfTodayIn(timezone).getTime();
}
