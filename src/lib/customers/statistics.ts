import "server-only";
/**
 * The customer statistics the Activity view draws, and the five-figure
 * headline the Overview card asks for.
 *
 * This is the composition layer: `./repository.ts` reads the main app
 * database, `./lifecycle.ts` reads the three admin-database history tables,
 * and everything here is arithmetic over what they answered. No AWS call
 * happens on this path — the pool figures are as fresh as last night's
 * `cognito_directory` run, and the page says so.
 *
 * The definitions, in one place, because a figure whose definition is
 * scattered is a figure nobody trusts:
 *
 * - **A month is a UTC calendar month**, `YYYY-MM`, and a day is a UTC day.
 *   Both databases store timestamps with a zone and every other figure in
 *   this console is measured in UTC; a Toronto month would put the same
 *   sign-in in different months on either side of midnight.
 * - **DAU / WAU / MAU** are live `users` rows with `last_seen_at` inside the
 *   last 1 / 7 / 30 days. Not "sign-ins", which is what the CloudWatch series
 *   counts: a person who stays signed in for a week is one active user and
 *   one sign-in.
 * - **New per month** is `users.created_at`: the first time the consumer app
 *   saw the person. An invitation that was never accepted is not a customer.
 * - **Deleted per month** is `deleted` plus `deleted_in_app` events, deduped
 *   per sub within a month, so a person who deletes their account in the app
 *   and then disappears from the pool the same night is one departure.
 * - **Churn** for a month is `deleted ÷ activeAtStart`, where `activeAtStart`
 *   is everyone who existed and had not been deleted at 00:00 UTC on the 1st,
 *   plus anyone seen in the 30 days before it. A month that began with nobody
 *   has `null`, not 0 %.
 * - **Retention** is by sign-up cohort: of everyone whose `users` row was
 *   created in month M, what share has a `last_seen_at` inside the last 30
 *   days **and** no `deleted_at`. A deleted account stays in the denominator
 *   and can never be in the numerator — someone who deleted their account
 *   last week is not a retained customer, however recent their last sign-in —
 *   so a cohort that left shows as retention falling. That is the same
 *   population MAU counts, so the two cannot disagree about who is still here.
 * - **The funnel's first two steps are Cognito** (accounts in the newest
 *   snapshot, and how many of those are confirmed) and **the last three are
 *   the app database**. They are shown as measured, never forced to descend:
 *   a step that is wider than the one above it is a real inconsistency worth
 *   seeing rather than a rendering problem worth hiding.
 *
 * **Two parts are cached for ten minutes, in this process.** The monthly
 * churn denominators (one `users` count per month) and the largest-tenant
 * tables (aggregates over every tenant's `file_blobs` and `transactions`) are
 * the expensive half of the answer, and both move slowly by construction — a
 * month boundary and the total volume of data. Neither depends on anything
 * per-operator, so a cached answer cannot leak between them; `generatedAt`
 * still reports when the *whole* payload was assembled, and the two range
 * knobs on the page narrow a payload the browser already has rather than
 * asking again (`./window.ts`). See {@link CUSTOMER_STATS_CACHE_TTL_MS}.
 *
 * One honest imprecision, repeated in `docs/customers.md`: the churn
 * numerator is counted over Cognito subs and the denominator over `users`
 * rows. A revoked invitation is a `deleted` event for someone who never had a
 * `users` row, so a month full of revocations reads as churn against a base
 * that never included them. At this scale the alternative — only counting
 * departures whose sub is known to the app database — would silently drop the
 * deletions that matter most (an account removed in the AWS console), so the
 * simpler definition is kept and documented.
 */
import { NotFoundError } from "@/lib/api/errors";
import {
  accountCensus,
  deletionsPerMonth,
  eventsForSub,
  poolMetricsBetween,
  toDay,
} from "./lifecycle";
import {
  countActiveAtMonthStart,
  countLiveCustomers,
  countSeenSince,
  findCustomerById,
  funnelProgress,
  largestTenants,
  newCustomersPerMonth,
  retentionByCohort,
  tenantFootprints,
  usageForUser,
  usagePerDay,
  type UsageDayRow,
} from "./repository";
import type { ResolvedCustomerStatisticsQuery } from "./schemas";
import {
  ACTIVITY_DAYS,
  ACTIVITY_EVENTS_MAX,
  DAU_WINDOW_DAYS,
  LARGEST_TENANTS_LIMIT,
  MAU_WINDOW_DAYS,
  WAU_WINDOW_DAYS,
  type ChurnMonth,
  type CustomerActivity,
  type CustomerFunnel,
  type CustomerHeadline,
  type CustomerStatistics,
  type MonthCount,
  type RetentionMonth,
  type TenantSize,
  type UsageDay,
} from "./types";

/* -------------------------------------------------------------------------- */
/*                             Calendar (all UTC)                             */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 00:00 UTC on the 1st of the month `at` falls in. */
function startOfUtcMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** The same, `n` months away. Negative goes back. */
function addUtcMonths(at: Date, n: number): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + n, 1));
}

/** `YYYY-MM` for a month start. */
function monthLabel(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** `YYYY-MM-DD` for a UTC instant. */
function dayLabel(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `days` before a UTC instant. */
function daysBefore(at: Date, days: number): Date {
  return new Date(at.getTime() - days * DAY_MS);
}

/**
 * The `months` month starts ending with the current month, oldest first.
 *
 * The current month is included and is deliberately **partial**: a page that
 * only showed finished months would be a month behind for thirty days at a
 * time, and the page labels the last bucket "this month" so nobody reads it
 * as a completed one.
 */
function monthStarts(now: Date, months: number): Date[] {
  const current = startOfUtcMonth(now);
  const starts: Date[] = [];
  for (let index = months - 1; index >= 0; index -= 1) {
    starts.push(addUtcMonths(current, -index));
  }
  return starts;
}

/* -------------------------------------------------------------------------- */
/*                                Arithmetic                                  */
/* -------------------------------------------------------------------------- */

/** A percentage to one decimal, or `null` when the denominator is 0. */
function share(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** `[{month, count}]` filled in for every month in the window, zeros included. */
function alignMonths(starts: readonly Date[], counts: readonly MonthCount[]): MonthCount[] {
  const byMonth = new Map(counts.map((entry) => [entry.month, entry.count]));
  return starts.map((start) => {
    const month = monthLabel(start);
    return { month, count: byMonth.get(month) ?? 0 };
  });
}

/** `UsageDayRow` on the wire. Identical shape; named separately for clarity. */
function toUsageDay(row: UsageDayRow): UsageDay {
  return {
    day: row.day,
    requests: row.requests,
    errors: row.errors,
    syncRows: row.syncRows,
    bytesUploaded: row.bytesUploaded,
  };
}

/* -------------------------------------------------------------------------- */
/*                        A ten-minute cache, in process                      */
/* -------------------------------------------------------------------------- */

/**
 * How long the expensive parts of the payload are served from memory.
 *
 * Ten minutes, which is shorter than the resolution of what it holds: the
 * churn denominator is "who existed on the 1st" and the largest-tenant tables
 * are total data volume — neither is a figure that changes meaningfully
 * inside ten minutes, and the page prints when the answer was assembled. The
 * cheap parts (DAU/WAU/MAU, the daily series, the funnel, the census) are
 * **not** cached, so an invitation or a sign-in still shows up on the next
 * load.
 */
export const CUSTOMER_STATS_CACHE_TTL_MS = 10 * 60 * 1000;

interface Slot {
  at: number;
  value: Promise<unknown>;
}

/**
 * Per-process, keyed, TTL'd memoisation of one promise per key.
 *
 * The same trade `src/lib/ops/cache.ts` makes and for the same reasons: N
 * tasks keep N caches, which at this scale is invisible, and a concurrent
 * second caller joins the flight instead of starting a second query. A
 * rejection is not cached — it is removed in `finally`-style so the next
 * caller tries again — because a failed database read is usually transient
 * and a cached failure would outlive the cause by ten minutes.
 *
 * Bounded by construction: the keys are built from the month window and the
 * current UTC month, so there are a handful of them and an old month's entry
 * stops being asked for (and is evicted when its TTL lapses and it is
 * overwritten). Nothing per-operator or per-tenant is ever part of a key.
 */
const slots = new Map<string, Slot>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const slot = slots.get(key);
  if (slot !== undefined && now - slot.at < CUSTOMER_STATS_CACHE_TTL_MS) {
    return slot.value as Promise<T>;
  }
  // Sweep whatever has lapsed while we are here, so a long-lived process does
  // not keep a month's worth of dead keys.
  for (const [other, entry] of slots) {
    if (now - entry.at >= CUSTOMER_STATS_CACHE_TTL_MS) slots.delete(other);
  }
  // Annotated because the rejection handler refers to `value`, which would
  // otherwise make the inferred type circular.
  const value: Promise<T> = load().catch((error: unknown) => {
    if (slots.get(key)?.value === value) slots.delete(key);
    throw error;
  });
  slots.set(key, { at: now, value });
  return value;
}

/**
 * The churn denominators for a window of month starts.
 *
 * One `users` count per month, so at most {@link
 * import("./types").STATISTICS_MONTHS_MAX} of them and usually six; cached
 * together because they are asked for together and a partially fresh series
 * would be a series whose months disagree about when they were counted.
 */
function activeAtMonthStarts(starts: readonly Date[]): Promise<number[]> {
  const key = `activeAtStart:${starts.map(monthLabel).join(",")}`;
  return cached(key, () =>
    Promise.all(starts.map((start) => countActiveAtMonthStart(start, MAU_WINDOW_DAYS))),
  );
}

/** The largest-tenant tables. Five aggregates over every tenant's data. */
function cachedLargestTenants(): ReturnType<typeof largestTenants> {
  return cached(`largestTenants:${LARGEST_TENANTS_LIMIT}`, () =>
    largestTenants(LARGEST_TENANTS_LIMIT),
  );
}

/* -------------------------------------------------------------------------- */
/*                               The statistics                               */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/v1/admin/customers/statistics`.
 *
 * Every section is independently allowed to be empty. A deployment where
 * `docs/sql/014_customer_statistics.sql` has run but the nightly job has not
 * answers with an empty account census, an empty funnel head, no pool metrics
 * and no deletions — while the app-side figures (active users, new customers,
 * usage, largest tenants) are all there, because those need no job at all.
 * The page says which half is missing rather than drawing zeros as
 * measurements.
 *
 * Cost: a fixed number of round trips whatever the window — the monthly churn
 * denominators are one count per month (at most
 * {@link import("./types").STATISTICS_MONTHS_MAX}), and everything else is a
 * single aggregate.
 */
export async function getCustomerStatistics(
  query: ResolvedCustomerStatisticsQuery,
  now: Date = new Date(),
): Promise<CustomerStatistics> {
  const starts = monthStarts(now, query.months);
  const windowFrom = starts[0];
  const windowTo = addUtcMonths(startOfUtcMonth(now), 1);
  const seenSince = daysBefore(now, MAU_WINDOW_DAYS);

  // Daily windows. Usage runs through today, which is partial and honest —
  // the consumer app writes those counters as requests arrive. The pool
  // metrics stop at yesterday: CloudWatch's current day bucket is a fraction
  // of a day, and half a bar of sign-ins reads as a collapse.
  const today = dayLabel(now);
  const yesterday = dayLabel(daysBefore(now, 1));
  const dailyFrom = dayLabel(daysBefore(now, query.days));

  const [
    accounts,
    mau,
    wau,
    dau,
    newPerMonthRaw,
    deletedPerMonthRaw,
    cohorts,
    progress,
    poolMetrics,
    usageRows,
    tenants,
  ] = await Promise.all([
    accountCensus(),
    countSeenSince(seenSince),
    countSeenSince(daysBefore(now, WAU_WINDOW_DAYS)),
    countSeenSince(daysBefore(now, DAU_WINDOW_DAYS)),
    newCustomersPerMonth(windowFrom, windowTo),
    deletionsPerMonth(windowFrom, windowTo),
    retentionByCohort(windowFrom, windowTo, seenSince),
    funnelProgress(),
    poolMetricsBetween(dailyFrom, yesterday),
    usagePerDay(toDay(dailyFrom), toDay(today)),
    cachedLargestTenants(),
  ]);

  const newPerMonth = alignMonths(starts, newPerMonthRaw);
  const deletedPerMonth = alignMonths(starts, deletedPerMonthRaw);

  // One count per month. Bounded by `months`, which the schema caps, so this
  // is at most 24 small counts and usually 6 — and cached for ten minutes,
  // because none of them can change inside a month except the last.
  const activeAtStarts = await activeAtMonthStarts(starts);

  const churnPerMonth: ChurnMonth[] = starts.map((start, index) => {
    const deleted = deletedPerMonth[index]?.count ?? 0;
    const activeAtStart = activeAtStarts[index] ?? 0;
    return {
      month: monthLabel(start),
      deleted,
      activeAtStart,
      churnPct: share(deleted, activeAtStart),
    };
  });

  const byCohort = new Map(cohorts.map((entry) => [entry.month, entry]));
  const retentionBySignupMonth: RetentionMonth[] = starts.map((start) => {
    const month = monthLabel(start);
    const entry = byCohort.get(month);
    const cohort = entry?.cohort ?? 0;
    const retained = entry?.retained ?? 0;
    return { month, cohort, retained, retainedPct: share(retained, cohort) };
  });

  const funnel: CustomerFunnel = {
    invited: accounts.total,
    confirmed: accounts.byStatus.confirmed ?? 0,
    onboarded: progress.onboarded,
    firstTransaction: progress.firstTransaction,
    firstAttachment: progress.firstAttachment,
    snapshotDay: accounts.snapshotDay,
  };

  const usage = usageRows.map(toUsageDay);
  const toTenantSize = (row: {
    tenantId: string;
    name: string | null;
    bytes: number;
    transactions: number;
  }): TenantSize => ({
    tenantId: row.tenantId,
    name: row.name,
    bytes: row.bytes,
    transactions: row.transactions,
  });

  return {
    accounts,
    mau,
    wau,
    dau,
    newPerMonth,
    deletedPerMonth,
    churnPerMonth,
    retentionBySignupMonth,
    funnel,
    poolMetrics,
    // The same days twice: the page draws two charts from one read, and a
    // caller that wants only errors should not have to filter a wide array.
    usage: { requestsPerDay: usage, errorsPerDay: usage },
    largestTenants: {
      byBytes: tenants.byBytes.map(toTenantSize),
      byTransactions: tenants.byTransactions.map(toTenantSize),
    },
    months: query.months,
    days: query.days,
    generatedAt: now.toISOString(),
  };
}

/**
 * The five figures the Overview's customer card needs — and nothing else.
 *
 * Six small queries, no monthly series and no per-tenant aggregates, because
 * a dashboard card that costs as much as a whole page will not be put on a
 * dashboard. `accountsTotal` falls back to live `users` rows when the nightly
 * job has never run, so the card has a number on a fresh deployment instead
 * of a zero that looks like a measurement.
 *
 * Exported for the Overview task; nothing in the Customers page uses it.
 */
export async function customerHeadline(now: Date = new Date()): Promise<CustomerHeadline> {
  const monthStart = startOfUtcMonth(now);
  const nextMonth = addUtcMonths(monthStart, 1);

  const [census, mau, newThisMonth, deletedThisMonth, activeAtStart, liveUsers] = await Promise.all([
    accountCensus(),
    countSeenSince(daysBefore(now, MAU_WINDOW_DAYS)),
    newCustomersPerMonth(monthStart, nextMonth),
    deletionsPerMonth(monthStart, nextMonth),
    // The same cache the Activity view's churn table fills, keyed by the
    // month window: the Overview and the page cannot disagree about the
    // denominator, and whichever of them is opened second pays nothing.
    activeAtMonthStarts([monthStart]).then((counts) => counts[0] ?? 0),
    countLiveCustomers(),
  ]);

  const deleted = deletedThisMonth[0]?.count ?? 0;
  return {
    accountsTotal: census.snapshotDay === null ? liveUsers : census.total,
    mau,
    newThisMonth: newThisMonth[0]?.count ?? 0,
    deletedThisMonth: deleted,
    churnPct: share(deleted, activeAtStart),
  };
}

/**
 * `GET /api/v1/admin/customers/[id]/activity` — one customer, in depth.
 *
 * The identity comes from the same read the detail drawer uses, so the two
 * cannot disagree about who this is; everything else is this person's own
 * usage, the size of their tenants, and every lifecycle event recorded
 * against their Cognito sub — including, for someone who has deleted their
 * account, the events that outlived it.
 *
 * @throws {NotFoundError} no `users` row with that id.
 */
export async function getCustomerActivity(
  id: string,
  now: Date = new Date(),
): Promise<CustomerActivity> {
  const base = await findCustomerById(id);
  if (base === null) throw new NotFoundError("That customer does not exist.");

  const from = toDay(dayLabel(daysBefore(now, ACTIVITY_DAYS)));
  const to = toDay(dayLabel(now));

  const [usage, tenants, events] = await Promise.all([
    usageForUser(base.id, from, to),
    tenantFootprints(base.id),
    eventsForSub(base.cognitoSub, ACTIVITY_EVENTS_MAX),
  ]);

  return {
    userId: base.id,
    cognitoSub: base.cognitoSub,
    email: base.email,
    lastSeenAt: base.lastSeenAt,
    lastActiveAt: base.lastActiveAt,
    createdAt: base.createdAt,
    deletedAt: base.deletedAt,
    usage: usage.map(toUsageDay),
    tenants: tenants.map((tenant) => ({
      tenantId: tenant.tenantId,
      name: tenant.name,
      transactions: tenant.transactions,
      accounts: tenant.accounts,
      documents: tenant.documents,
      bytes: tenant.bytes,
    })),
    events,
    days: ACTIVITY_DAYS,
  };
}
