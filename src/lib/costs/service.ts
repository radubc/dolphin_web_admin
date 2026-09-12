import "server-only";
/**
 * The glue the two Cost center routes call: the cached rows
 * (`./repository.ts`) and the `aws_costs` run record
 * (`src/lib/integrations/runs.ts`), shaped into the responses declared in
 * `./types.ts`.
 *
 * Routes stay thin — they validate the query string and call one of these.
 *
 * The windows every figure is measured over are decided here, once, so the
 * page and the endpoints cannot disagree about what "this month" means:
 *
 * - **Nothing is counted for today.** Its spend has barely happened and AWS
 *   has not totalled it, so every window ends at yesterday. On the 1st of a
 *   month that makes "month to date" genuinely zero, which is the honest
 *   answer rather than a figure made of four hours of estimate.
 * - **"Month to date"** is the 1st of the current UTC month to yesterday.
 * - **The comparison window** is the 30 days ending yesterday — a rolling
 *   window, not last calendar month, because the question it answers is "is
 *   this service costing more than it was" and a calendar month cannot
 *   answer that on the 2nd.
 */
import { latestRuns } from "@/lib/integrations/runs";
import type { IntegrationRun } from "@/lib/integrations/types";
import { shiftDay, startOfMonth, todayUtc, monthOf, type IsoDay } from "./calendar";
import {
  costByComponent,
  costByService,
  dailySeries,
  latestSnapshot,
} from "./repository";
import type { CostDailyResponse, CostSummaryResponse } from "./types";
import { COST_PREVIOUS_WINDOW_DAYS, COSTS_INTEGRATION_KEY } from "./types";

/** The windows the summary is measured over, from one notion of "today". */
export interface CostWindows {
  today: IsoDay;
  /** The last day any figure covers. */
  yesterday: IsoDay;
  month: string;
  monthFrom: IsoDay;
  /** Yesterday, or the day before the 1st when today *is* the 1st. */
  monthTo: IsoDay;
  previousFrom: IsoDay;
  previousTo: IsoDay;
}

/** Exported for the job, which measures its month-to-date the same way. */
export function costWindows(now: Date = new Date()): CostWindows {
  const today = todayUtc(now);
  const yesterday = shiftDay(today, -1);
  return {
    today,
    yesterday,
    month: monthOf(today),
    monthFrom: startOfMonth(today),
    // On the 1st this is before `monthFrom`, so every month-to-date range is
    // empty and every month-to-date figure is 0. Deliberate: see above.
    monthTo: yesterday,
    previousFrom: shiftDay(today, -COST_PREVIOUS_WINDOW_DAYS),
    previousTo: yesterday,
  };
}

/** The newest `aws_costs` run, or null when the integration has never run. */
async function latestCostRun(): Promise<IntegrationRun | null> {
  const runs = await latestRuns([COSTS_INTEGRATION_KEY]);
  return runs.get(COSTS_INTEGRATION_KEY) ?? null;
}

/**
 * `GET /api/v1/admin/costs`.
 *
 * Every field is independently allowed to be empty: a deployment where the
 * SQL has run but the job has not answers `{ snapshot: null, byService: [],
 * byComponent: [], lastRun: null }`, and the page says "no data yet, press
 * Refresh" rather than showing zeros as if they were measurements.
 */
export async function getCostSummary(now: Date = new Date()): Promise<CostSummaryResponse> {
  const windows = costWindows(now);
  const [snapshot, byService, byComponent, lastRun] = await Promise.all([
    latestSnapshot(),
    costByService({
      monthFrom: windows.monthFrom,
      monthTo: windows.monthTo,
      previousFrom: windows.previousFrom,
      previousTo: windows.previousTo,
    }),
    costByComponent(windows.monthFrom, windows.monthTo),
    latestCostRun(),
  ]);
  return { snapshot, byService, byComponent, lastRun };
}

/**
 * `GET /api/v1/admin/costs/daily?days=35` — one entry per day that has rows,
 * oldest first, ending yesterday.
 *
 * Days AWS reported nothing for are simply absent rather than sent as zeros:
 * the chart fills its own gaps, and "no rows" and "$0.00" are the same thing
 * for a service that was not used.
 */
export async function getCostDaily(
  days: number,
  now: Date = new Date(),
): Promise<CostDailyResponse> {
  const { today, yesterday } = costWindows(now);
  return dailySeries(shiftDay(today, -days), yesterday);
}
