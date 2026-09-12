import "server-only";
/**
 * Every read and write the Cost center makes against the **admin** database
 * (`admin_cost_daily`, `admin_cost_snapshots`), and the mapping between those
 * rows and the wire types in `./types.ts`.
 *
 * Nothing here touches the main app database, and nothing here calls AWS: the
 * job (`src/lib/integrations/jobs/aws-costs.ts`) is the only writer and the
 * two endpoints are the only readers.
 *
 * Conversions applied once, here, so no caller has to remember them:
 * `Decimal` becomes `number`, `DATE` becomes `YYYY-MM-DD`, every timestamp
 * becomes an ISO string.
 *
 * **Why the writes replace rather than upsert.** The unique key is
 * `UNIQUE NULLS NOT DISTINCT (day, service, component)`, which Prisma cannot
 * express: to Prisma two rows with a NULL component look distinct, so an
 * `upsert` on that key would insert a duplicate every run. Each write
 * therefore deletes the day range it is about to write — for its own series
 * only, the by-service rows and the by-component rows never touch each
 * other — and inserts, both inside one transaction. That is also exactly the
 * semantics wanted: Cost Explorer revises recent days, so the last 35 days
 * are *replaced* by whatever AWS says today, not merged with what it said
 * yesterday.
 *
 * **With one guard.** Replace only makes sense while the new answer is at
 * least as complete as the old one, so a write whose fetch was truncated by
 * the page cap, or which came back empty for a window that already holds
 * rows, is refused outright: nothing is deleted and `ReplaceOutcome.refused`
 * says why. The job counts that as a failed call. Cached cost rows cost
 * $0.01 each time they are fetched; losing a month of them to one bad answer
 * is the one outcome worth refusing a write over.
 *
 * The tables may not exist yet (`docs/sql/013_aws_costs.sql` is run by hand).
 * Prisma's P2021 is deliberately **not** caught here, so `adminHandler`
 * renders it as 503 `admin_schema_missing`, the same as every other feature.
 */
import type { Prisma } from "@/generated/prisma-admin/client";
import { prismaAdmin } from "@/lib/prisma-admin";
import {
  fromDateColumn,
  toDateColumn,
  type IsoDay,
  type IsoMonth,
} from "./calendar";
import type {
  CostAnomaly,
  CostByComponent,
  CostByService,
  CostDay,
  CostSnapshot,
  FreeTierState,
} from "./types";

type DailyRow = Prisma.admin_cost_dailyGetPayload<object>;
type SnapshotRow = Prisma.admin_cost_snapshotsGetPayload<object>;

/** A `Decimal` column on the wire. */
const num = (value: Prisma.Decimal): number => Number(value);

/** A nullable `Decimal` column on the wire. */
const numOrNull = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : Number(value);

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

/** One row the job wants written. `component` null means the by-service series. */
export interface CostDailyWrite {
  day: IsoDay;
  service: string;
  component: string | null;
  amountUsd: number;
  estimated: boolean;
}

/** What a replace did, for the run's counters. */
export interface ReplaceOutcome {
  /** Rows inserted. */
  written: number;
  /** Rows the replace removed first — the previous reading for those days. */
  removed: number;
  /**
   * Why the replace was **refused**, or null when it went through. A refusal
   * leaves every cached row exactly as it was; the caller counts the call as
   * failed and says so in the run's error.
   */
  refused: string | null;
}

/**
 * Why an answer must not be written over what is already cached, or null when
 * it may be.
 *
 * A window that holds nothing has nothing to lose, so a first run — or a
 * cost allocation tag nobody has activated — is never refused.
 */
function refusalReason(
  rowCount: number,
  existing: number,
  truncated: boolean,
  series: string,
): string | null {
  if (existing === 0) return null;
  if (truncated) {
    return (
      `the page cap stopped the ${series} fetch early, so the answer is incomplete; ` +
      `the ${existing} cached rows for this window were kept rather than replaced ` +
      `with a partial reading`
    );
  }
  if (rowCount === 0) {
    return (
      `AWS returned no ${series} rows for a window that already holds ${existing}; ` +
      `the cached rows were kept rather than deleted on the strength of an empty answer`
    );
  }
  return null;
}

/**
 * Replaces the **by-service** rows (`component IS NULL`) for `[from, to]`
 * with `rows`, in one transaction.
 *
 * A day inside the range that AWS reported nothing for ends up with no rows,
 * which is the truth: a day of exactly $0.00 and a day AWS has not totalled
 * are both "nothing to draw", and `estimated` on the days either side says
 * which.
 *
 * **Cached history is never wiped by a bad answer.** The replace is refused —
 * nothing is deleted, nothing is inserted — when the fetch was truncated by
 * the page cap, or when it came back empty for a window that already holds
 * rows. Both would trade a complete reading, which cost money to fetch, for a
 * partial or absent one. The caller turns a refusal into a failed call, never
 * a skipped one, so the run goes red and an operator looks.
 */
export async function replaceServiceSeries(
  from: IsoDay,
  to: IsoDay,
  rows: readonly CostDailyWrite[],
  options: { truncated: boolean } = { truncated: false },
): Promise<ReplaceOutcome> {
  const fetchedAt = new Date();
  const range = { gte: toDateColumn(from), lte: toDateColumn(to) };
  // Interactive rather than batched: the decision to delete depends on what
  // is already there, and both have to see the same rows.
  return prismaAdmin.$transaction(async (tx) => {
    const existing = await tx.admin_cost_daily.count({
      where: { day: range, component: null },
    });
    const refused = refusalReason(rows.length, existing, options.truncated, "by-service");
    if (refused !== null) return { written: 0, removed: 0, refused };

    const removed = await tx.admin_cost_daily.deleteMany({
      where: { day: range, component: null },
    });
    const written = await tx.admin_cost_daily.createMany({
      data: rows.map((row) => ({
        day: toDateColumn(row.day),
        service: row.service,
        component: null,
        amount_usd: row.amountUsd,
        estimated: row.estimated,
        fetched_at: fetchedAt,
      })),
    });
    return { written: written.count, removed: removed.count, refused: null };
  });
}

/**
 * Replaces the **by-component** rows (`component IS NOT NULL`) for the
 * explicit range `[from, to]` with `rows`, in one transaction.
 *
 * The range is the caller's, not "this month": the job refreshes the current
 * month and, for the first few days of a new one, the whole of the previous
 * month — whose last day only settles after it has ended. Only the range
 * given is touched, so **older component rows are history and stay**.
 *
 * An empty `rows` for a range that holds nothing is the normal state before
 * the cost allocation tag has been activated, and writes nothing. An empty
 * `rows` for a range that *does* hold rows is refused, like a truncated
 * answer: see {@link replaceServiceSeries}.
 */
export async function replaceComponentSeries(
  from: IsoDay,
  to: IsoDay,
  rows: readonly CostDailyWrite[],
  options: { truncated: boolean } = { truncated: false },
): Promise<ReplaceOutcome> {
  const fetchedAt = new Date();
  const range = { gte: toDateColumn(from), lte: toDateColumn(to) };
  return prismaAdmin.$transaction(async (tx) => {
    const existing = await tx.admin_cost_daily.count({
      where: { day: range, component: { not: null } },
    });
    const refused = refusalReason(rows.length, existing, options.truncated, "by-component");
    if (refused !== null) return { written: 0, removed: 0, refused };

    const removed = await tx.admin_cost_daily.deleteMany({
      where: { day: range, component: { not: null } },
    });
    const written = await tx.admin_cost_daily.createMany({
      data: rows.map((row) => ({
        day: toDateColumn(row.day),
        service: row.service,
        component: row.component ?? "",
        amount_usd: row.amountUsd,
        estimated: row.estimated,
        fetched_at: fetchedAt,
      })),
    });
    return { written: written.count, removed: removed.count, refused: null };
  });
}

/** What the job writes into `admin_cost_snapshots` at the end of a run. */
export interface CostSnapshotWrite {
  month: IsoMonth;
  monthToDateUsd: number;
  /** The projected month total, or null when there is no forecast. */
  forecastUsd: number | null;
  budgetName: string | null;
  budgetLimitUsd: number | null;
  budgetActualUsd: number | null;
  budgetForecastUsd: number | null;
  freeTier: FreeTierState | null;
  anomalies: readonly CostAnomaly[];
  /** Which calls the run made and what they answered. Never a credential. */
  raw: Prisma.InputJsonValue;
}

/** Inserts the run's snapshot and returns it as the API shape. */
export async function createSnapshot(input: CostSnapshotWrite): Promise<CostSnapshot> {
  const row = await prismaAdmin.admin_cost_snapshots.create({
    data: {
      month: input.month,
      month_to_date_usd: input.monthToDateUsd,
      forecast_usd: input.forecastUsd,
      budget_name: input.budgetName,
      budget_limit_usd: input.budgetLimitUsd,
      budget_actual_usd: input.budgetActualUsd,
      budget_forecast_usd: input.budgetForecastUsd,
      // Left unset rather than written as JSON `null`, so the column holds
      // SQL NULL — which is what "the account is not on a free plan" means.
      // The casts are the usual friction of putting a declared interface into
      // a JSONB column: both shapes are plain JSON by construction, but
      // `InputJsonValue` is structural and an interface is not assignable to
      // it without help.
      free_tier:
        input.freeTier === null
          ? undefined
          : (input.freeTier as unknown as Prisma.InputJsonValue),
      anomalies: input.anomalies as unknown as Prisma.InputJsonValue,
      raw: input.raw,
    },
  });
  return toSnapshot(row);
}

/* -------------------------------------------------------------------------- */
/*                                    Reads                                   */
/* -------------------------------------------------------------------------- */

/**
 * The JSON columns, read back defensively.
 *
 * The job is the only writer, so these should always be the shapes it wrote —
 * but an older build's row is still in the table after a deploy, and a page
 * must not blow up on one. Anything unrecognised reads as absent.
 */
/** True for a JSON value that is an object with the named key on it. */
function isRecordWith(value: unknown, key: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && key in value;
}

function anomaliesOf(value: Prisma.JsonValue): CostAnomaly[] {
  if (!Array.isArray(value)) return [];
  // The cast is the boundary: the array's entries are `JsonValue`, and what
  // survives the filter is what the job wrote. Structural checks past "it is
  // an object with an id" would only be re-implementing the type.
  return value.filter((entry) => isRecordWith(entry, "id")) as unknown as CostAnomaly[];
}

function freeTierOf(value: Prisma.JsonValue): FreeTierState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const offers = Array.isArray(raw.offers) ? raw.offers : [];
  return {
    planType: typeof raw.planType === "string" ? raw.planType : null,
    planStatus: typeof raw.planStatus === "string" ? raw.planStatus : null,
    remainingCreditsUsd:
      typeof raw.remainingCreditsUsd === "number" ? raw.remainingCreditsUsd : null,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
    offers: offers.filter((entry) =>
      isRecordWith(entry, "service"),
    ) as unknown as FreeTierState["offers"],
  };
}

export function toSnapshot(row: SnapshotRow): CostSnapshot {
  const name = row.budget_name;
  return {
    id: row.id,
    takenAt: row.taken_at.toISOString(),
    month: row.month,
    monthToDateUsd: num(row.month_to_date_usd),
    forecastUsd: numOrNull(row.forecast_usd),
    budget:
      name === null
        ? null
        : {
            name,
            limitUsd: numOrNull(row.budget_limit_usd),
            actualUsd: numOrNull(row.budget_actual_usd),
            forecastUsd: numOrNull(row.budget_forecast_usd),
          },
    freeTier: freeTierOf(row.free_tier),
    anomalies: anomaliesOf(row.anomalies),
  };
}

/** The newest snapshot, or null when the job has never written one. */
export async function latestSnapshot(): Promise<CostSnapshot | null> {
  const row = await prismaAdmin.admin_cost_snapshots.findFirst({
    orderBy: { taken_at: "desc" },
  });
  return row === null ? null : toSnapshot(row);
}

/** Total by service over `[from, to]`, by-service rows only. */
async function sumByService(from: IsoDay, to: IsoDay): Promise<Map<string, number>> {
  const groups = await prismaAdmin.admin_cost_daily.groupBy({
    by: ["service"],
    where: { day: { gte: toDateColumn(from), lte: toDateColumn(to) }, component: null },
    _sum: { amount_usd: true },
  });
  const totals = new Map<string, number>();
  for (const group of groups) {
    totals.set(group.service, group._sum.amount_usd === null ? 0 : num(group._sum.amount_usd));
  }
  return totals;
}

/**
 * The "by service" table: this month to date beside the rolling previous
 * window, so a service whose cost has moved stands out.
 *
 * Two aggregate queries rather than one pass over rows: the windows overlap
 * and the database is better at summing than we are. Services that appear in
 * only one window are still listed, with 0 in the other — that is precisely
 * the case worth seeing.
 */
export async function costByService(windows: {
  monthFrom: IsoDay;
  monthTo: IsoDay;
  previousFrom: IsoDay;
  previousTo: IsoDay;
}): Promise<CostByService[]> {
  const [month, previous] = await Promise.all([
    sumByService(windows.monthFrom, windows.monthTo),
    sumByService(windows.previousFrom, windows.previousTo),
  ]);
  const services = new Set([...month.keys(), ...previous.keys()]);
  return [...services]
    .map((service) => ({
      service,
      mtdUsd: month.get(service) ?? 0,
      prev30Usd: previous.get(service) ?? 0,
    }))
    // Most expensive this month first; a tie falls back to the window, so a
    // service that spent nothing this month but something last still sorts
    // above one that spent nothing in either.
    .sort((a, b) => b.mtdUsd - a.mtdUsd || b.prev30Usd - a.prev30Usd);
}

/**
 * The "by component" table for `[from, to]`: the cost allocation tag's values
 * with their totals. Empty when the tag has never been active.
 */
export async function costByComponent(from: IsoDay, to: IsoDay): Promise<CostByComponent[]> {
  const groups = await prismaAdmin.admin_cost_daily.groupBy({
    by: ["component"],
    where: { day: { gte: toDateColumn(from), lte: toDateColumn(to) }, component: { not: null } },
    _sum: { amount_usd: true },
  });
  return groups
    .map((group) => ({
      component: group.component ?? "",
      mtdUsd: group._sum.amount_usd === null ? 0 : num(group._sum.amount_usd),
    }))
    .sort((a, b) => b.mtdUsd - a.mtdUsd);
}

/**
 * The daily series for `[from, to]`, one entry per day that has any rows.
 *
 * The per-service amounts come back with the day so the chart can explain a
 * spike without a second request; at 35 days and a dozen services that is a
 * few hundred rows, small enough to shape in memory and to send.
 */
export async function dailySeries(from: IsoDay, to: IsoDay): Promise<CostDay[]> {
  const rows: Pick<DailyRow, "day" | "service" | "amount_usd" | "estimated">[] =
    await prismaAdmin.admin_cost_daily.findMany({
      where: { day: { gte: toDateColumn(from), lte: toDateColumn(to) }, component: null },
      select: { day: true, service: true, amount_usd: true, estimated: true },
      orderBy: { day: "asc" },
    });

  const byDay = new Map<IsoDay, CostDay>();
  for (const row of rows) {
    const day = fromDateColumn(row.day);
    const entry = byDay.get(day) ?? { day, totalUsd: 0, estimated: false, services: {} };
    const amount = num(row.amount_usd);
    entry.totalUsd += amount;
    entry.services[row.service] = (entry.services[row.service] ?? 0) + amount;
    // One estimated service makes the whole day an estimate: the day's total
    // is the sum, so it inherits the least certain part of it.
    entry.estimated = entry.estimated || row.estimated;
    byDay.set(day, entry);
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** The month-to-date total from the by-service rows the run has just written. */
export async function monthToDateTotal(from: IsoDay, to: IsoDay): Promise<number> {
  const total = await prismaAdmin.admin_cost_daily.aggregate({
    where: { day: { gte: toDateColumn(from), lte: toDateColumn(to) }, component: null },
    _sum: { amount_usd: true },
  });
  return total._sum.amount_usd === null ? 0 : num(total._sum.amount_usd);
}
