/**
 * The app's date, relative-time and text formatters.
 *
 * A subset of the consumer app's `src/lib/format.ts`, kept to the same names
 * and rules so a component ported from there compiles unchanged:
 *
 * - The locale is pinned to `en-CA`. A formatter that reads the browser's
 *   locale renders one way on the server and another in the browser, which is a
 *   hydration mismatch.
 * - Timestamps are ISO strings from the API; unparseable input comes back
 *   unchanged rather than throwing, so one bad row cannot blank a page.
 *
 * No Prisma, no React, no browser API: safe to import from Server Components,
 * Client Components and plain modules alike.
 */

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "medium",
  timeZone: "UTC",
});

/** `Sep 6, 2026, 17:44` (UTC) from an ISO timestamp. */
export function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return DATE_TIME_FORMATTER.format(new Date(time));
}

/** `Sep 6, 2026` from an ISO timestamp or date. */
export function formatDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return DATE_FORMATTER.format(new Date(time));
}

/** `formatDateTime` for fields that can be empty; an em dash stands in for null. */
export function formatDateTimeOrDash(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  return formatDateTime(iso);
}

/**
 * `3 hours ago`, `yesterday`, `in 2 days`. Positive input is the past, which
 * is `Intl.RelativeTimeFormat`'s own convention once the sign is flipped.
 */
export function formatRelativeMinutes(minutesAgo: number): string {
  const formatter = new Intl.RelativeTimeFormat("en-CA", { numeric: "auto" });
  const magnitude = Math.abs(minutesAgo);
  if (magnitude < 1) return "just now";
  if (magnitude < 60) return formatter.format(-Math.round(minutesAgo), "minute");
  if (magnitude < 60 * 24) return formatter.format(-Math.round(minutesAgo / 60), "hour");
  if (magnitude < 60 * 24 * 30) return formatter.format(-Math.round(minutesAgo / (60 * 24)), "day");
  return formatter.format(-Math.round(minutesAgo / (60 * 24 * 30)), "month");
}

/**
 * The same thing from an ISO timestamp. Reads the clock, so the result is only
 * stable within one render pass: use it in Client Components.
 */
export function formatRelativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return formatRelativeMinutes((Date.now() - time) / 60_000);
}

/** `formatRelativeTime` for fields that can be empty. */
export function formatRelativeTimeOrNever(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "Never";
  return formatRelativeTime(iso);
}

/** `"12 users"` / `"1 user"`. */
export function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** Trims a form string and turns the empty result into `null` for the API. */
export function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** A rejected callback is shown to the user, so it needs a readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "The change could not be saved. Please try again.";
}

/** `can_read_user_list` → `Can read user list`, for keys shown to people. */
export function humaniseKey(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* -------------------------------------------------------------------------- */
/* Calendar days                                                              */
/* -------------------------------------------------------------------------- */

const DAY_LABEL_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const DAY_SHORT_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/**
 * `11 Sep 2026` from a `YYYY-MM-DD` day, in UTC.
 *
 * Days in this app are UTC calendar days — a billing day, a usage day and a
 * CloudWatch day are all the same UTC bucket — so this never looks at a
 * timezone. Unparseable input comes back unchanged, like the rest of this
 * module.
 */
export function formatIsoDay(day: string): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(time)) return day;
  return DAY_LABEL_FORMATTER.format(new Date(time));
}

/** `11 Sep`, for a dense chart axis. */
export function formatIsoDayShort(day: string): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(time)) return day;
  return DAY_SHORT_FORMATTER.format(new Date(time));
}

/** `1.4 MB` / `912 kB` / `0 B`, base 1000, for byte counts in a table. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // No decimal on bytes — half a byte is not a thing — and one everywhere
  // else, which is as much precision as a size column can carry usefully.
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** `0.4%` / `12.5%` / `—` for null, which is "there is no rate", not "zero". */
export function formatPercentOrDash(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}
