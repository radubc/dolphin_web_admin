import "server-only";
/**
 * The `allocate_costs` run: divides each recent month's AWS bill over the
 * tenants and writes the result to `admin_tenant_cost_monthly`.
 *
 * **It calls nothing.** No AWS request, no provider, no API key — the two
 * inputs are the cost rows `aws_costs` already cached in the admin database
 * and the consumer app's own usage counters in the main one, and the output is
 * one table in the admin database. It is an integration purely because runs,
 * "Run now", a schedule and a history come free from being one; the
 * Integrations page shows it beside the others and its description says it
 * costs nothing.
 *
 * **Why nightly rather than on page load.** The arithmetic is four aggregates
 * of the main app database per month, two more for what the tenants hold
 * today, and one of the admin database, and the answer changes about as often
 * as the bill does — once a day. A page that recomputed it per request would
 * spend that on every click for a figure that had not moved.
 *
 * **What one run does.** Once, before the loop, it reads what every tenant
 * holds *now* — attachment bytes and live transaction rows
 * (`tenantStorageNow()`). Neither table keeps history, so those two
 * aggregates of the consumer app's largest tables are the same answer for
 * every month in the window and are read once per run rather than once per
 * month. Then, for each of the last `months` months, oldest first (the
 * current, partial month included):
 *
 * 1. read the month's cost by service from `admin_cost_daily` and fold it
 *    into the four pools;
 * 2. read every tenant the month concerns and what it did, reusing the
 *    storage snapshot;
 * 3. allocate, in micro-dollars with a largest-remainder pass, so the rows
 *    sum to the pools exactly;
 * 4. upsert the rows for that month and remove any row for a tenant the month
 *    no longer concerns — **both in one transaction**, so a month is never
 *    left half-written.
 *
 * Each month is committed before the next begins, so a run interrupted half
 * way leaves every month it had already finished, whole.
 *
 * **What the counters mean here.** Like `aws-costs.ts` and
 * `cognito-directory.ts`, this run does not process a list of items:
 *
 * - `total` — months planned;
 * - `processed` — months that finished, whether they allocated anything or
 *   not;
 * - `failed` — months that could not be allocated for a reason worth an
 *   operator's attention, which today means two things: the month has no
 *   cached cost rows, so there is no bill to divide; or the write was refused
 *   because the allocation covered no tenant at all while the month already
 *   had rows, so the existing figures were kept;
 * - `created` / `updated` — `admin_tenant_cost_monthly` **rows** written for
 *   the first time, and rows that replaced an earlier allocation;
 * - `unchanged` — months that were skipped because they have no completed day
 *   yet (a run on the 1st, for the month that started that morning).
 *
 * **Failure.** A month that fails fails *that month* and the run carries on: a
 * deployment where `aws_costs` has only just started has last month empty and
 * this month full, and refusing to write the month that does have data would
 * be unhelpful. At the end, a run with any failed month throws with a message
 * naming them and what to do about it — the page would otherwise show a stale
 * allocation under a green tick.
 */
import {
  ALLOCATION_MONTHS_MAX,
  allocateMonth,
  monthPools,
  monthWindow,
  recentMonths,
  tenantDriversFor,
  tenantStorageNow,
  writeMonthAllocation,
} from "@/lib/costs/allocation";
import type { RunWork } from "../runs";

export interface AllocateCostsRunContext {
  /** Months recomputed, ending with the current one. */
  months: number;
  /** The share of the fixed pool every live tenant gets before the split. */
  fixedFloorShare: number;
  /**
   * The instant the run treats as "now". Injected only by a test or an
   * ad-hoc check; production leaves it alone.
   */
  now?: Date;
}

export function allocateCostsWork(context: AllocateCostsRunContext): RunWork {
  return async (report) => {
    const now = context.now ?? new Date();
    const months = recentMonths(now, Math.min(ALLOCATION_MONTHS_MAX, Math.max(1, context.months)));

    let processed = 0;
    let failed = 0;
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let removed = 0;
    let tenantsAllocated = 0;
    const outcomes: Record<string, string> = {};
    const errors: string[] = [];

    const progress = () =>
      report({ total: months.length, processed, created, updated, unchanged, failed });

    await progress();

    // Month-independent, so once per run: `file_blobs` and `transactions`
    // hold what each tenant has today whichever month is being recomputed.
    // A fourteen-month backfill would otherwise aggregate the consumer app's
    // two largest tables twenty-eight times for the same answer.
    const storage = await tenantStorageNow();

    for (const month of months) {
      const window = monthWindow(month, now);

      if (window.empty) {
        // The month started this morning. Nothing has settled, `aws_costs`
        // has nothing for it either, and an allocation of $0.00 over every
        // tenant would only overwrite nothing with nothing.
        processed += 1;
        unchanged += 1;
        outcomes[month] = "skipped: the month has no completed day yet (it is the 1st)";
        await progress();
        continue;
      }

      const { pools, services } = await monthPools(window);

      if (services === 0) {
        // No cached bill for the month. Loud, because the figure an operator
        // is looking at would otherwise be silently missing a month.
        processed += 1;
        failed += 1;
        const message =
          `${month} has no rows in admin_cost_daily for ${window.from}..${window.to}, ` +
          "so there is no bill to divide — run the aws_costs integration first (or wait for " +
          "its 09:00 run). Cost Explorer also has to have been enabled once in the AWS console.";
        outcomes[month] = `failed: ${message}`;
        errors.push(message);
        await progress();
        continue;
      }

      const tenants = await tenantDriversFor(window, storage);
      const allocation = allocateMonth({
        month,
        pools,
        tenants,
        fixedFloorShare: context.fixedFloorShare,
      });
      const outcome = await writeMonthAllocation(allocation);

      if (outcome.refused !== null) {
        // The month kept its existing rows: the allocation covered no tenant
        // at all, which is a broken read rather than news. Loud, because the
        // figures an operator is looking at are now older than they look.
        processed += 1;
        failed += 1;
        outcomes[month] = `failed: ${outcome.refused}`;
        errors.push(outcome.refused);
        await progress();
        continue;
      }

      created += outcome.created;
      updated += outcome.updated;
      removed += outcome.removed;
      tenantsAllocated += allocation.tenants.length;
      processed += 1;
      outcomes[month] =
        `ok: $${allocation.monthTotalUsd.toFixed(2)} over ${allocation.tenants.length} tenants ` +
        `($${allocation.allocatedUsd.toFixed(2)} allocated, ` +
        `$${allocation.unallocatedUsd.toFixed(2)} left unallocated), ` +
        `${outcome.created} new rows, ${outcome.updated} replaced` +
        (outcome.removed === 0 ? "" : `, ${outcome.removed} stale rows removed`);
      await progress();
    }

    console.info(
      `[integrations] allocate_costs: ${processed}/${months.length} months ` +
        `(${months.at(0)}..${months.at(-1)}), ${tenantsAllocated} tenant-months allocated, ` +
        `${created} new and ${updated} replaced rows` +
        (removed === 0 ? "" : `, ${removed} stale rows removed`) +
        (failed === 0 ? "" : `, ${failed} months failed`),
    );

    // Logged before the throw, and whatever the outcome: this job has no
    // snapshot table to record a `raw` column in, the way `aws_costs` does,
    // so the per-month detail a support question needs lives here.
    if (Object.keys(outcomes).length > 0) {
      console.info(
        `[integrations] allocate_costs months: ${Object.entries(outcomes)
          .map(([month, outcome]) => `${month} ${outcome}`)
          .join(" | ")}`,
      );
    }

    // Everything achieved is already committed, so saying what went wrong
    // costs none of it. A run with a month it could not allocate is a failed
    // run: the page would otherwise show a gap under a green tick.
    if (errors.length > 0) {
      throw new Error(
        `${errors.length} of ${months.length} months could not be allocated — ${errors.join("; ")}`,
      );
    }
  };
}
