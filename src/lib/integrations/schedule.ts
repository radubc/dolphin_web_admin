/**
 * When an integration next runs.
 *
 * The schedule is wall-clock in an IANA timezone (`America/Toronto` by
 * default), so "daily at 01:00" means 01:00 local in Toronto whatever UTC is
 * doing that week. Everything here goes through dayjs's `utc` + `timezone`
 * plugins and builds each candidate from a **formatted local string**
 * (`2026-03-08T01:00:00` in the zone) rather than by adding 24 hours to an
 * instant: on the two days a year the offset changes, adding hours drifts the
 * wall-clock time by one and the run would creep.
 *
 * Two edge cases the string approach settles by itself:
 * - **Spring forward.** 02:30 does not exist on the changeover day; dayjs
 *   resolves it to the next real instant (03:30), so the run happens once,
 *   an hour late, and is back on time the following day.
 * - **Fall back.** 01:30 exists twice; the first occurrence is chosen, and
 *   because the result is compared with `from` strictly the second one is not
 *   run again.
 *
 * `weekday` is 0 (Sunday) to 6 and only read for `weekly`; `dayOfMonth` is
 * 1..28 and only read for `monthly`, capped so February always has the day.
 *
 * Plain data, no server-only imports: the UI may import this to show the next
 * run it expects.
 */
import dayjs from "dayjs";
import timezonePlugin from "dayjs/plugin/timezone";
import utcPlugin from "dayjs/plugin/utc";
import { DEFAULT_TIMEZONE, type IntegrationSchedule } from "./types";

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

/** How far ahead the search is allowed to look before giving up. */
const MAX_DAYS_AHEAD = 8;
const MAX_MONTHS_AHEAD = 14;

const pad = (value: number): string => String(value).padStart(2, "0");

/** True when the runtime's ICU knows the zone. An unknown zone falls back. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function zoneOf(schedule: IntegrationSchedule): string {
  const candidate = schedule.timezone?.trim();
  return candidate && isValidTimezone(candidate) ? candidate : DEFAULT_TIMEZONE;
}

/**
 * The instant of `hour:minute` local time on the given local calendar day, or
 * `null` when the combination has no instant at all (which dayjs only reports
 * for a malformed input, not for a DST gap).
 */
function instantAt(day: dayjs.Dayjs, hour: number, minute: number, timezone: string): Date | null {
  const local = `${day.format("YYYY-MM-DD")}T${pad(hour)}:${pad(minute)}:00`;
  const resolved = dayjs.tz(local, timezone);
  return resolved.isValid() ? resolved.toDate() : null;
}

/** Clamps the schedule's fields into the ranges the database also enforces. */
function normalise(schedule: IntegrationSchedule): {
  hour: number;
  minute: number;
  weekday: number;
  dayOfMonth: number;
} {
  const clamp = (value: number, min: number, max: number, fallback: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
  return {
    hour: clamp(schedule.hour, 0, 23, 1),
    minute: clamp(schedule.minute, 0, 59, 0),
    weekday: clamp(schedule.weekday, 0, 6, 1),
    dayOfMonth: clamp(schedule.dayOfMonth, 1, 28, 1),
  };
}

/**
 * The first instant strictly after `from` at which the schedule fires.
 *
 * `null` means "never on its own": the frequency is `off`, or the search
 * exhausted its window (which no valid schedule does — it is a guard, not a
 * behaviour).
 */
export function computeNextRun(schedule: IntegrationSchedule, from: Date): Date | null {
  if (schedule.frequency === "off") return null;
  const timezone = zoneOf(schedule);
  const { hour, minute, weekday, dayOfMonth } = normalise(schedule);
  const start = dayjs(from).tz(timezone);

  if (schedule.frequency === "daily") {
    for (let offset = 0; offset < MAX_DAYS_AHEAD; offset += 1) {
      const candidate = instantAt(start.add(offset, "day"), hour, minute, timezone);
      if (candidate && candidate.getTime() > from.getTime()) return candidate;
    }
    return null;
  }

  if (schedule.frequency === "weekly") {
    for (let offset = 0; offset < MAX_DAYS_AHEAD; offset += 1) {
      const day = start.add(offset, "day");
      if (day.day() !== weekday) continue;
      const candidate = instantAt(day, hour, minute, timezone);
      if (candidate && candidate.getTime() > from.getTime()) return candidate;
    }
    return null;
  }

  // monthly
  for (let offset = 0; offset < MAX_MONTHS_AHEAD; offset += 1) {
    const day = start.add(offset, "month").date(dayOfMonth);
    const candidate = instantAt(day, hour, minute, timezone);
    if (candidate && candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

/**
 * The next run for an integration as stored: `null` while it is disabled or
 * its frequency is `off`, so a disabled integration never carries a stale
 * timestamp the scheduler could act on.
 */
export function nextRunFor(
  schedule: IntegrationSchedule,
  isEnabled: boolean,
  from: Date = new Date(),
): Date | null {
  if (!isEnabled) return null;
  return computeNextRun(schedule, from);
}
