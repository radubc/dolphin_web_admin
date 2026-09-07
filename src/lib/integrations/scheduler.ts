import "server-only";
/**
 * The in-process scheduler: one 60-second tick that starts the integrations
 * whose time has come.
 *
 * Started from `src/instrumentation.ts` when the Node.js runtime boots, and
 * switched off with `INTEGRATIONS_SCHEDULER=off` (a developer running the app
 * beside a colleague's, or a second instance that should only serve
 * requests).
 *
 * ## Why a timer and not cron
 *
 * The same reasoning as the Constants jobs runner: there is no queue and no
 * worker process, work happens in batches that each commit on their own, and
 * an interrupted run is visible as such and can simply be started again.
 * Adding an external scheduler would add an operational dependency for three
 * daily jobs.
 *
 * ## Two instances, one run
 *
 * `next_run_at` is the lock. A tick reads the due rows, computes what the
 * *next* run after this one should be, and moves `next_run_at` forward with an
 * `updateMany` whose predicate still names the old value. Exactly one instance
 * can win that update, and only the winner starts the run. No advisory lock,
 * no leader election, and nothing to clean up if the winner then dies — the
 * run row goes stale and reads as `interrupted`.
 *
 * A row whose `next_run_at` is NULL (a freshly seeded integration) is
 * **computed and stored, not run**: starting a catalog download the moment the
 * app boots is not what "daily at 02:00" means.
 *
 * ## Failure
 *
 * Nothing throws out of a tick. A missing schema (the SQL has not been run) is
 * logged once and then ignored, so a fresh deployment does not print a stack
 * trace every minute.
 */
import { isMissingTableError } from "@/lib/admin-access/prisma-repository";
import { claimDueIntegration, dueIntegrationRows, setNextRunAt } from "./repository";
import { computeNextRun } from "./schedule";
import { isSchedulerActive, setSchedulerActive } from "./scheduler-state";
import { messageOf } from "./runs";
import { startIntegrationRun } from "./service";
import { DEFAULT_TIMEZONE, type IntegrationKey, type IntegrationSchedule } from "./types";

export { isSchedulerActive } from "./scheduler-state";

/** How often the due list is checked. */
export const TICK_INTERVAL_MS = 60_000;

/** A short first tick, so a NULL `next_run_at` is filled in soon after boot. */
const FIRST_TICK_DELAY_MS = 5_000;

const TIMER = Symbol.for("penny-squeeze.integrations.scheduler.timer");
const FIRST_TIMER = Symbol.for("penny-squeeze.integrations.scheduler.first-timer");

type Holder = { [TIMER]?: NodeJS.Timeout; [FIRST_TIMER]?: NodeJS.Timeout };

/** Set once the "schema is not installed" warning has been printed. */
let schemaWarned = false;

function scheduleOfRow(row: {
  schedule_frequency: string;
  schedule_hour: number;
  schedule_minute: number;
  schedule_weekday: number;
  schedule_day_of_month: number;
  schedule_timezone: string;
}): IntegrationSchedule {
  return {
    frequency: row.schedule_frequency as IntegrationSchedule["frequency"],
    hour: row.schedule_hour,
    minute: row.schedule_minute,
    weekday: row.schedule_weekday,
    dayOfMonth: row.schedule_day_of_month,
    timezone: row.schedule_timezone || DEFAULT_TIMEZONE,
  };
}

/**
 * One pass over the due integrations. Never throws.
 *
 * Exported for a future health check or a manual nudge; the timer is the only
 * caller today.
 */
export async function tick(now: Date = new Date()): Promise<void> {
  let due;
  try {
    due = await dueIntegrationRows(now);
  } catch (error) {
    if (isMissingTableError(error)) {
      if (!schemaWarned) {
        schemaWarned = true;
        console.warn(
          "[integrations] scheduler idle: the integration tables are not installed " +
            "(run docs/sql/008_integrations.sql).",
        );
      }
      return;
    }
    console.error(`[integrations] scheduler tick failed: ${messageOf(error)}`);
    return;
  }

  for (const row of due) {
    const key = row.key as IntegrationKey;
    try {
      const schedule = scheduleOfRow(row);
      if (row.next_run_at === null) {
        // First sight of this row: record when it should run, and let that
        // time arrive on its own.
        await setNextRunAt(key, computeNextRun(schedule, now));
        continue;
      }
      const claimed = await claimDueIntegration(key, now, computeNextRun(schedule, now));
      if (!claimed) continue;
      console.info(`[integrations] scheduler: starting ${key}`);
      await startIntegrationRun(key, {}, { trigger: "scheduled", requestedBy: null });
    } catch (error) {
      // A conflict (a run is already live), a missing key, a dead provider —
      // all of it is one integration's problem, never the tick's.
      console.error(`[integrations] scheduler could not start ${key}: ${messageOf(error)}`);
    }
  }
}

/**
 * Installs the tick, once per process.
 *
 * Idempotent on purpose: Next's dev server re-evaluates modules on hot
 * reload, and a second timer would double every scheduled run. The guard and
 * the handle both live on `globalThis`, which survives that re-evaluation.
 * The timer is `unref`'d so it can never be the reason the process stays up.
 */
export function startScheduler(): void {
  if (isSchedulerActive()) return;
  setSchedulerActive(true);

  const holder = globalThis as Holder;
  const timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  timer.unref?.();
  holder[TIMER] = timer;

  const first = setTimeout(() => {
    delete holder[FIRST_TIMER];
    void tick();
  }, FIRST_TICK_DELAY_MS);
  first.unref?.();
  // Kept so `stopScheduler` can cancel a first tick that has not fired yet;
  // otherwise a stopped scheduler still ticks once, up to five seconds later.
  holder[FIRST_TIMER] = first;

  console.info(`[integrations] scheduler started (every ${TICK_INTERVAL_MS / 1000}s).`);
}

/** Stops the tick. Only a test or a graceful shutdown needs this. */
export function stopScheduler(): void {
  const holder = globalThis as Holder;
  if (holder[TIMER]) {
    clearInterval(holder[TIMER]);
    delete holder[TIMER];
  }
  if (holder[FIRST_TIMER]) {
    clearTimeout(holder[FIRST_TIMER]);
    delete holder[FIRST_TIMER];
  }
  setSchedulerActive(false);
}
