import "server-only";
/**
 * The three history tables the customer statistics are built on, all of them
 * in the **admin** database: `admin_customer_snapshots`,
 * `admin_customer_events` and `admin_pool_metrics_daily`.
 *
 * They exist because neither system that holds the facts keeps the history.
 * Cognito's `ListUsers` answers "who is in the pool right now" and there is no
 * event, and no Lambda trigger, for a deletion or a disablement — an account
 * that went away yesterday simply is not in today's answer, and nothing says
 * it ever was. So the nightly `cognito_directory` job writes what it saw, and
 * the difference between two nights *is* the event log.
 *
 * Who writes what:
 *
 * - `admin_customer_snapshots` — only the job. One row per account per day,
 *   keyed `(sub, seen_on)`, never pruned: the absence of a sub on a later day
 *   is the deletion, so a pruned history would erase the evidence.
 * - `admin_customer_events` — the job's diff (`source: "directory_diff"`),
 *   the job's main-database sweep (`"main_db"`), and this console's own
 *   invitation actions (`"console"`, from `./invites.ts`). Every writer is
 *   idempotent, because `UNIQUE (sub, event, at)` plus a deterministic `at`
 *   means writing the same fact twice inserts nothing.
 * - `admin_pool_metrics_daily` — only the job, from CloudWatch.
 *
 * The tables may not exist yet (`docs/sql/014_customer_statistics.sql` is run
 * by hand). Prisma's P2021 is deliberately **not** caught here, so
 * `adminHandler` renders it as 503 `admin_schema_missing` like every other
 * feature, and the job fails with a message naming the file. The single
 * exception is {@link eventsForSub}: the per-customer drawer is mostly
 * main-database figures and must keep working before the SQL has run, so a
 * missing `admin_customer_events` table answers with an empty log instead of
 * failing the whole drawer.
 */
import { isMissingTableError } from "@/lib/admin-access/prisma-repository";
import type { Prisma } from "@/generated/prisma-admin/client";
import { prismaAdmin } from "@/lib/prisma-admin";
import {
  isCustomerEventKind,
  type AccountCensus,
  type CustomerEvent,
  type CustomerEventKind,
  type CustomerEventSource,
  type MonthCount,
  type PoolMetricsDay,
} from "./types";

/* -------------------------------------------------------------------------- */
/*                              Day arithmetic                                */
/* -------------------------------------------------------------------------- */

/**
 * A `DATE` column value for a UTC day. The same convention as
 * `src/lib/costs/calendar.ts`: midnight UTC, which Prisma round-trips
 * unchanged.
 */
export function toDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A `DATE` column back as `YYYY-MM-DD`. */
export function fromDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/*                                 Snapshots                                  */
/* -------------------------------------------------------------------------- */

/** One account, as the job read it out of the pool. */
export interface SnapshotWrite {
  sub: string;
  status: string;
  enabled: boolean;
  poolCreatedAt: Date | null;
  poolUpdatedAt: Date | null;
  email: string | null;
}

/** Just enough of a snapshot row to diff two days. */
export interface SnapshotState {
  sub: string;
  status: string;
  enabled: boolean;
  email: string | null;
}

/**
 * Writes one day's snapshot, replacing whatever was already recorded for that
 * day.
 *
 * The primary key is `(sub, seen_on)` and the semantics wanted are an upsert
 * per account; doing it as a delete of the day followed by one `createMany`,
 * inside a single transaction, is the same result in two statements instead of
 * one per account. It is also exactly right for a re-run: a second run on the
 * same night replaces its own earlier reading rather than merging with it, so
 * an account deleted between the two runs does not linger in the day it was
 * deleted from.
 *
 * `partial` marks a day whose pool listing was cut short by the page cap. The
 * rows are still written — partial data is still data, and the accounts it did
 * reach are real — but the day is flagged so it can never become the
 * *previous* side of a diff: every account the listing never reached would
 * otherwise be recorded as deleted the following night. The flag is per row
 * because that is where a column can live, and every row of one day carries
 * the same value.
 *
 * @returns how many rows were written, and how many the replace removed first.
 */
export async function writeSnapshot(
  day: string,
  accounts: readonly SnapshotWrite[],
  options: { partial: boolean },
): Promise<{ written: number; removed: number }> {
  const seenOn = toDay(day);
  const fetchedAt = new Date();
  const [removed, written] = await prismaAdmin.$transaction([
    prismaAdmin.admin_customer_snapshots.deleteMany({ where: { seen_on: seenOn } }),
    prismaAdmin.admin_customer_snapshots.createMany({
      data: accounts.map((account) => ({
        sub: account.sub,
        seen_on: seenOn,
        status: account.status,
        enabled: account.enabled,
        pool_created_at: account.poolCreatedAt,
        pool_updated_at: account.poolUpdatedAt,
        email: account.email,
        partial: options.partial,
        fetched_at: fetchedAt,
      })),
    }),
  ]);
  return { written: written.count, removed: removed.count };
}

/**
 * The most recent **complete** snapshot day strictly before `day`, or `null`
 * when there is none — which is how "this is the first snapshot" is detected,
 * and why the first run writes no events.
 *
 * Days marked `partial` are skipped: a truncated listing is missing accounts
 * it never reached, and diffing against it would read every one of them as a
 * `reappeared`, then as a `deleted` the night after. Skipping means the diff
 * reaches further back instead, which is exactly what a missed night does and
 * is handled the same way.
 */
export async function previousSnapshotDay(day: string): Promise<string | null> {
  const row = await prismaAdmin.admin_customer_snapshots.findFirst({
    where: { seen_on: { lt: toDay(day) }, partial: false },
    select: { seen_on: true },
    orderBy: { seen_on: "desc" },
  });
  return row === null ? null : fromDay(row.seen_on);
}

/**
 * The newest snapshot day of all, or `null` when the job has never run.
 *
 * A `partial` day counts here, unlike in {@link previousSnapshotDay}: the
 * census and the funnel's first two steps are "what the pool looked like when
 * we last looked", and the accounts a truncated listing did reach are real.
 * Only the *diff* can be corrupted by a partial day, and only as the previous
 * side of one.
 */
export async function latestSnapshotDay(): Promise<string | null> {
  const row = await prismaAdmin.admin_customer_snapshots.findFirst({
    select: { seen_on: true },
    orderBy: { seen_on: "desc" },
  });
  return row === null ? null : fromDay(row.seen_on);
}

/**
 * Every account recorded on one snapshot day.
 *
 * Unbounded on purpose: it is one row per pool account and the diff has to see
 * all of them, since a missing row *is* the signal. The pool listing that
 * produced it is capped at 12 000 accounts (`LIST_PAGE_CAP` in `./cognito.ts`)
 * and the job refuses to diff a truncated listing, so this is bounded by the
 * same cap in practice.
 */
export async function snapshotFor(day: string): Promise<SnapshotState[]> {
  const rows = await prismaAdmin.admin_customer_snapshots.findMany({
    where: { seen_on: toDay(day) },
    select: { sub: true, status: true, enabled: true, email: true },
  });
  return rows.map((row) => ({
    sub: row.sub,
    status: row.status,
    enabled: row.enabled,
    email: row.email,
  }));
}

/**
 * Accounts by status on the newest snapshot day.
 *
 * `byStatus` is whatever statuses are actually present, so a status Cognito
 * adds later appears without a code change; the UI labels the ones it knows
 * and prints the raw value for anything else.
 */
export async function accountCensus(): Promise<AccountCensus> {
  const day = await latestSnapshotDay();
  if (day === null) {
    return { total: 0, byStatus: {}, disabled: 0, snapshotDay: null };
  }
  const seenOn = toDay(day);
  const [grouped, disabled] = await Promise.all([
    prismaAdmin.admin_customer_snapshots.groupBy({
      by: ["status"],
      where: { seen_on: seenOn },
      _count: { _all: true },
    }),
    prismaAdmin.admin_customer_snapshots.count({ where: { seen_on: seenOn, enabled: false } }),
  ]);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const group of grouped) {
    byStatus[group.status] = group._count._all;
    total += group._count._all;
  }
  return { total, byStatus, disabled, snapshotDay: day };
}

/* -------------------------------------------------------------------------- */
/*                                  Events                                    */
/* -------------------------------------------------------------------------- */

/** One lifecycle fact, as a writer knows it. */
export interface EventWrite {
  sub: string;
  event: CustomerEventKind;
  at: Date;
  source: CustomerEventSource;
  details?: Record<string, unknown> | null;
}

/**
 * Records lifecycle events, skipping any that are already there.
 *
 * `skipDuplicates` against `UNIQUE (sub, event, at)` is what makes every
 * writer safe to repeat: the nightly diff dates its events at 00:00 UTC of
 * the snapshot day, so re-running the same night inserts nothing, and the
 * main-database sweep dates a deletion at `users.deleted_at` itself, so it
 * cannot double-record however often it runs.
 *
 * @returns how many rows were actually inserted.
 */
export async function recordEvents(events: readonly EventWrite[]): Promise<number> {
  if (events.length === 0) return 0;
  const result = await prismaAdmin.admin_customer_events.createMany({
    data: events.map((event) => ({
      sub: event.sub,
      event: event.event,
      at: event.at,
      source: event.source,
      // Left unset rather than written as JSON `null`, so the column holds SQL
      // NULL — "nothing to add" rather than "the value null". The cast is the
      // usual friction of putting a `Record` into a JSONB column.
      details:
        event.details === null || event.details === undefined
          ? undefined
          : (event.details as Prisma.InputJsonObject),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * The same thing for a single event, never allowed to fail its caller.
 *
 * Used by the console's own actions — sending an invitation, revoking one —
 * where the event is a *record* of something that has already happened in
 * Cognito. A missing `admin_customer_events` table (the SQL has not been run
 * yet) must not turn a sent invitation into a 500, exactly as
 * `recordInviteAudit` decided for the audit trail. The nightly diff is the
 * safety net that notices whatever was missed.
 */
export async function recordEventQuietly(event: EventWrite): Promise<void> {
  try {
    await recordEvents([event]);
  } catch (error) {
    const reason =
      error instanceof Error
        ? (error.message.split("\n").filter(Boolean).at(-1) ?? error.message)
        : String(error);
    console.warn(`[customers] lifecycle event skipped (${event.event}): ${reason}`);
  }
}

/** Which of `subs` already have an event of this kind. */
export async function subsWithEvent(
  event: CustomerEventKind,
  subs: readonly string[],
): Promise<Set<string>> {
  if (subs.length === 0) return new Set();
  const rows = await prismaAdmin.admin_customer_events.findMany({
    where: { event, sub: { in: [...subs] } },
    select: { sub: true },
    distinct: ["sub"],
  });
  return new Set(rows.map((row) => row.sub));
}

function detailsOf(value: Prisma.JsonValue): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Logged once per process, so a deployment without 014 is not a log flood. */
let warnedMissingEvents = false;

/**
 * One customer's lifecycle log, newest first.
 *
 * The one read in this module that tolerates a missing table. Everything else
 * the per-customer activity drawer shows comes from the main app database, so
 * before `docs/sql/014_customer_statistics.sql` has run the honest answer is
 * "there is no lifecycle log yet" and a working drawer — not a 503 on a
 * screen whose other four sections are ready. The statistics endpoint still
 * fails loudly, because there *every* pool-derived figure depends on the
 * tables.
 */
export async function eventsForSub(sub: string, take: number): Promise<CustomerEvent[]> {
  let rows;
  try {
    rows = await prismaAdmin.admin_customer_events.findMany({
      where: { sub },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take,
    });
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    if (!warnedMissingEvents) {
      warnedMissingEvents = true;
      console.warn(
        "[customers] admin_customer_events does not exist yet (run docs/sql/014_customer_statistics.sql); " +
          "the customer activity drawer will show no lifecycle events.",
      );
    }
    return [];
  }
  return rows.map((row) => ({
    id: row.id,
    sub: row.sub,
    // The column is TEXT with a CHECK; an unfamiliar value is reported as the
    // nearest honest thing rather than crashing a drawer.
    event: isCustomerEventKind(row.event) ? row.event : "reappeared",
    at: row.at.toISOString(),
    source: (["console", "directory_diff", "main_db"] as readonly string[]).includes(row.source)
      ? (row.source as CustomerEventSource)
      : "directory_diff",
    details: detailsOf(row.details),
  }));
}

/**
 * Departures per UTC calendar month, **deduped per sub per month**.
 *
 * Both departure events count: `deleted` (the account left the pool, whoever
 * removed it) and `deleted_in_app` (the consumer app's own delete-my-account
 * flow). A person who does both in the same month — deletes their account in
 * the app, and the pool account then disappears the same night — is one
 * departure, which is what `count(DISTINCT sub)` gives. Across two different
 * months they would be counted twice, which is the one honest imprecision
 * here and is called out in docs/customers.md.
 *
 * Raw SQL because the bucket is `date_trunc('month', …)` and the measure is a
 * `COUNT(DISTINCT …)`, neither of which Prisma's `groupBy` can express.
 * Parameterised through the tagged template, and the only inputs are two
 * `Date`s.
 */
export async function deletionsPerMonth(from: Date, toExclusive: Date): Promise<MonthCount[]> {
  const rows = await prismaAdmin.$queryRaw<{ month: string; n: bigint }[]>`
    SELECT to_char(date_trunc('month', at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
           count(DISTINCT sub) AS n
    FROM admin_customer_events
    WHERE event IN ('deleted', 'deleted_in_app')
      AND at >= ${from}
      AND at < ${toExclusive}
    GROUP BY 1
    ORDER BY 1
  `;
  return rows.map((row) => ({ month: row.month, count: Number(row.n) }));
}

/* -------------------------------------------------------------------------- */
/*                               Pool metrics                                 */
/* -------------------------------------------------------------------------- */

/** One day of CloudWatch counters, as the job writes them. */
export interface PoolMetricsWrite {
  day: string;
  signIns: number;
  signInAttempts: number;
  signUps: number;
  tokenRefreshes: number;
  throttles: number;
}

/**
 * Upserts the days CloudWatch answered for.
 *
 * A day is only touched when there is a figure for it: CloudWatch omits a day
 * nothing happened on, and writing a zero row for it would make "the pool was
 * idle" indistinguishable from "we have not asked yet". The existing days are
 * read first so the run can report created against updated without a second
 * pass.
 */
export async function upsertPoolMetrics(
  rows: readonly PoolMetricsWrite[],
): Promise<{ created: number; updated: number }> {
  if (rows.length === 0) return { created: 0, updated: 0 };
  const days = rows.map((row) => toDay(row.day));
  const existing = await prismaAdmin.admin_pool_metrics_daily.findMany({
    where: { day: { in: days } },
    select: { day: true },
  });
  const present = new Set(existing.map((row) => fromDay(row.day)));
  const fetchedAt = new Date();

  const fresh = rows.filter((row) => !present.has(row.day));
  const stale = rows.filter((row) => present.has(row.day));

  if (fresh.length > 0) {
    await prismaAdmin.admin_pool_metrics_daily.createMany({
      data: fresh.map((row) => ({
        day: toDay(row.day),
        sign_ins: row.signIns,
        sign_in_attempts: row.signInAttempts,
        sign_ups: row.signUps,
        token_refreshes: row.tokenRefreshes,
        throttles: row.throttles,
        fetched_at: fetchedAt,
      })),
      skipDuplicates: true,
    });
  }
  for (const row of stale) {
    await prismaAdmin.admin_pool_metrics_daily.update({
      where: { day: toDay(row.day) },
      data: {
        sign_ins: row.signIns,
        sign_in_attempts: row.signInAttempts,
        sign_ups: row.signUps,
        token_refreshes: row.tokenRefreshes,
        throttles: row.throttles,
        fetched_at: fetchedAt,
      },
    });
  }
  return { created: fresh.length, updated: stale.length };
}

/** The counters for `[from, to]`, oldest first. */
export async function poolMetricsBetween(from: string, to: string): Promise<PoolMetricsDay[]> {
  const rows = await prismaAdmin.admin_pool_metrics_daily.findMany({
    where: { day: { gte: toDay(from), lte: toDay(to) } },
    orderBy: { day: "asc" },
  });
  return rows.map((row) => ({
    day: fromDay(row.day),
    signIns: row.sign_ins,
    signInAttempts: row.sign_in_attempts,
    signUps: row.sign_ups,
    tokenRefreshes: row.token_refreshes,
    throttles: row.throttles,
  }));
}
