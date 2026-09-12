/**
 * The Cost center model, as the API and the UI see it.
 *
 * What the page shows is **cached AWS billing data**, never a live AWS call.
 * The `aws_costs` integration (`src/lib/integrations/jobs/aws-costs.ts`) runs
 * once a day, asks Cost Explorer, Budgets and Free Tier what the account has
 * spent, and writes the answers into `admin_cost_daily` (a series, one row
 * per day and service) and `admin_cost_snapshots` (one row per run, for
 * everything that is a single figure). The two endpoints below read only
 * those tables.
 *
 * That indirection is not architectural neatness: Cost Explorer charges
 * $0.01 per request. A page that called it on every load would cost more
 * than the resources it reports on, and the data lags about a day anyway, so
 * there is nothing to gain from asking more often than once.
 *
 * Two facts about the numbers, both of which the page says out loud:
 *
 * - **Every amount is USD.** AWS bills this account in USD and Cost Explorer
 *   reports `UnblendedCost` in USD; nothing here converts currency.
 * - **Credits and refunds are excluded** (`RECORD_TYPE` is filtered), so
 *   these figures are what the account *used*, which is what a forecast and
 *   a per-client allocation have to be built on. The invoice can be lower.
 *
 * Plain data, no React, no Prisma, no AWS SDK: safe to import from anywhere.
 */
import type { IntegrationRun } from "@/lib/integrations/types";

/* -------------------------------------------------------------------------- */
/*                                 Constants                                  */
/* -------------------------------------------------------------------------- */

/** The integration key the Cost center's "Refresh now" starts. */
export const COSTS_INTEGRATION_KEY = "aws_costs";

/* ------------------------- Cost allocation settings ----------------------- */
/**
 * The `allocate_costs` run's two knobs. The model and the arithmetic are in
 * `./allocation.ts`, which is server-only; the bounds live here because three
 * places need them and one of them is a Client Component — the Integrations
 * drawer draws the same minima, maxima and defaults that
 * `src/lib/integrations/schemas.ts` validates against and `settingsOf`
 * clamps to. `./allocation.ts` re-exports all four, so existing importers are
 * unaffected. See docs/cost-allocation.md.
 */

/**
 * How many months one `allocate_costs` run recomputes, ending with the
 * current (partial) one.
 *
 * Two by default: this month, whose figures move every day, and last month,
 * which Cost Explorer may still revise. More is allowed — a backfill after
 * the feature is switched on wants it — and every month is recomputed from
 * scratch, so a wider window only costs time.
 */
export const ALLOCATION_MONTHS_DEFAULT = 2;

/** The ceiling. Cost Explorer keeps about 14 months, so further back is empty. */
export const ALLOCATION_MONTHS_MAX = 14;

/**
 * The share of the fixed pool every tenant still live at the end of the month
 * is given before the rest is split by activity: half a percent.
 *
 * Small on purpose. It exists so a dormant tenant does not read as free, not
 * so that dormant tenants can absorb the bill: at 0.005, twenty of them carry
 * a tenth of the shared capacity between them and the measured split still
 * decides the other nine tenths.
 */
export const FIXED_FLOOR_SHARE_DEFAULT = 0.005;

/**
 * The most the floor may be set to. Above a quarter of the pool the figure
 * stops being an allocation and becomes a headcount; the effective floor is
 * additionally capped at `0.5 / eligible tenants`
 * (`FIXED_FLOOR_POOL_SHARE_MAX` in `./allocation.ts`), so the floors together
 * never take more than half the pool and the measurement always decides the
 * rest.
 */
export const FIXED_FLOOR_SHARE_MAX = 0.25;

/**
 * Days of history the daily fetch covers, and the page draws, by default.
 *
 * 35 rather than 30: a bar chart of "the last month" is only honest if it
 * includes the whole of the previous calendar month on the first of this one,
 * and a figure AWS revises a couple of weeks late is still inside the window
 * that gets re-fetched.
 */
export const COST_DAYS_DEFAULT = 35;

/** The most days one `?days=` may ask for. Cost Explorer keeps 14 months. */
export const COST_DAYS_MAX = 400;

/**
 * The most days the **job's daily fetch** may reach back over
 * (`settings.days`), as opposed to the page's read of the cache.
 *
 * Lower than {@link COST_DAYS_MAX} on purpose, and for money rather than for
 * the database: every page of a `GetCostAndUsage` answer is a charged
 * request, so a window wide enough to need paging turns one $0.01 call into
 * several every single day. 120 days is four months of history — more than
 * the chart offers — and at roughly fifteen services it still fits in one
 * page. A wider history is not lost: days already fetched stay in
 * `admin_cost_daily`, which is what the 180-day chart range draws from.
 */
export const COST_FETCH_DAYS_MAX = 120;

/**
 * The cost allocation tag the month-to-date split is grouped by when
 * `settings.componentTag` says nothing.
 *
 * `Component` is the tag every resource in the three CloudFormation stacks
 * already carries (`web`, `admin`). It does nothing for billing until it is
 * activated once in the Billing console, and activation is not retroactive —
 * see `docs/costs.md`.
 */
export const COST_COMPONENT_TAG_DEFAULT = "Component";

/**
 * The rolling window `CostByService.prev30Usd` covers: the 30 days ending
 * yesterday. Deliberately *not* "last calendar month" — the figure exists to
 * answer "is this service costing more than it was", and a calendar month
 * cannot answer that on the 2nd.
 */
export const COST_PREVIOUS_WINDOW_DAYS = 30;

/**
 * What one run of the job spends at AWS, for the sentence the page prints
 * next to "Refresh now".
 *
 * **Three charged Cost Explorer requests per run** — daily by service, this
 * month by service and component, and the forecast — at $0.01 each, so about
 * $0.03. On the first three days of a month a fourth is added: the previous
 * month's component split is re-read once its last day has settled. The
 * anomaly list is free (Cost Anomaly Detection), and so are Budgets, Free
 * Tier and `sts:GetCallerIdentity`. A window wide enough to page would add a
 * request per page, which is why `settings.days` is capped
 * ({@link COST_FETCH_DAYS_MAX}). Rounded up, and up again, because an
 * operator pressing a button deserves the pessimistic number rather than the
 * flattering one.
 */
export const COST_REFRESH_PRICE_USD = 0.05;

/* -------------------------------------------------------------------------- */
/*                                  Snapshot                                  */
/* -------------------------------------------------------------------------- */

/** The budget figures, when the account has a budget. */
export interface CostBudget {
  /** The budget's name in AWS Budgets. */
  name: string;
  /** The limit as configured, in USD. */
  limitUsd: number | null;
  /** Spend so far in the budget's period, as Budgets itself calculated it. */
  actualUsd: number | null;
  /** Budgets' own forecast for the end of the period. */
  forecastUsd: number | null;
}

/** One free-tier offer the account still has, as Free Tier reports it. */
export interface FreeTierOffer {
  /** The AWS service the offer belongs to. */
  service: string;
  description: string;
  /** The unit the amounts are counted in (`GB-Mo`, `Requests`). */
  unit: string;
  /** Used so far this month. */
  usedAmount: number | null;
  /** The offer's ceiling. */
  limitAmount: number | null;
  /** What AWS expects the month to end at. */
  forecastedAmount: number | null;
  /** The share of the limit used, 0..1, when both numbers are known. */
  usedShare: number | null;
}

/**
 * Where the account stands with the free tier. `null` on the snapshot when
 * the account is not on a free plan, or when the Free Tier API refused —
 * both of which mean "not applicable", not "something went wrong".
 */
export interface FreeTierState {
  /** `Free Tier`, `Paid`, … as `GetAccountPlanState` spells it. */
  planType: string | null;
  planStatus: string | null;
  /** Credit left on the plan, in USD, when the plan carries any. */
  remainingCreditsUsd: number | null;
  /** When the plan expires, ISO, when AWS gave a date. */
  expiresAt: string | null;
  offers: FreeTierOffer[];
}

/** One finding from Cost Anomaly Detection. */
export interface CostAnomaly {
  id: string;
  /** The service or linked account the monitor blamed; null when unspecified. */
  service: string | null;
  /** `YYYY-MM-DD`, the day the anomaly started. */
  startDate: string | null;
  /** `YYYY-MM-DD`, or null while the anomaly is still open. */
  endDate: string | null;
  /** Total unexpected spend, in USD. */
  totalImpactUsd: number;
  /** The worst single day of it, in USD. */
  maxImpactUsd: number | null;
  totalActualUsd: number | null;
  totalExpectedUsd: number | null;
  /** An operator's verdict in AWS (`YES`, `NO`, `PLANNED_ACTIVITY`), if any. */
  feedback: string | null;
}

/** One `admin_cost_snapshots` row, as the API returns it. */
export interface CostSnapshot {
  id: string;
  /** When the job wrote it. */
  takenAt: string;
  /** The month the figures describe, `YYYY-MM` in UTC. */
  month: string;
  /** Spend from the 1st to yesterday inclusive, in USD. */
  monthToDateUsd: number;
  /**
   * What the whole month is projected to cost: the month to date (the 1st to
   * yesterday) plus Cost Explorer's forecast for `[today, 1st of next
   * month)`, which is the rest of the month including today — so the two
   * cover the month exactly once. `null` when Cost Explorer says it has too
   * little history to forecast, and when that call failed.
   */
  forecastUsd: number | null;
  budget: CostBudget | null;
  freeTier: FreeTierState | null;
  anomalies: CostAnomaly[];
}

/* -------------------------------------------------------------------------- */
/*                                 Breakdowns                                 */
/* -------------------------------------------------------------------------- */

/** One service's share of the month, with the rolling window to compare it to. */
export interface CostByService {
  /** Cost Explorer's SERVICE dimension value, verbatim. */
  service: string;
  /** The 1st of this month to yesterday inclusive, in USD. */
  mtdUsd: number;
  /** The {@link COST_PREVIOUS_WINDOW_DAYS} days ending yesterday, in USD. */
  prev30Usd: number;
}

/**
 * One value of the `Component` cost allocation tag, for the month to date.
 *
 * Empty until the tag is activated in the Billing console, and never
 * retroactive — see `docs/costs.md`. `component` is `""` for spend on
 * resources the tag does not cover, which the page labels "Untagged".
 */
export interface CostByComponent {
  component: string;
  mtdUsd: number;
}

/* -------------------------------------------------------------------------- */
/*                                 Responses                                  */
/* -------------------------------------------------------------------------- */

/** `GET /api/v1/admin/costs`. */
export interface CostSummaryResponse {
  /** The newest snapshot, or null when the job has never succeeded. */
  snapshot: CostSnapshot | null;
  byService: CostByService[];
  byComponent: CostByComponent[];
  /** The newest `aws_costs` run, so the page can say how fresh this is. */
  lastRun: IntegrationRun | null;
}

/** One day of the bar chart. */
export interface CostDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  totalUsd: number;
  /** True while AWS still calls the day an estimate. */
  estimated: boolean;
  /** Amount per service for that day, in USD. Services with nothing are absent. */
  services: Record<string, number>;
}

/** `GET /api/v1/admin/costs/daily?days=35`. */
export type CostDailyResponse = CostDay[];

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/** `$12.34`, or `$0.0043` for an amount small enough that cents hide it. */
export function formatUsd(amount: number): string {
  const magnitude = Math.abs(amount);
  const digits = magnitude !== 0 && magnitude < 0.01 ? 4 : 2;
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** `$12` — the same amount where the cents would only be noise. */
export function formatUsdRounded(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/** The label the page gives a component value. `""` is untagged spend. */
export function componentLabel(component: string): string {
  return component === "" ? "Untagged" : component;
}
