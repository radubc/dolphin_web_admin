import "server-only";
/**
 * The AWS calls the cost job makes, one function each, each returning plain
 * data. No Prisma, no run counters, no policy about what a failure means —
 * that is the job's business (`src/lib/integrations/jobs/aws-costs.ts`).
 *
 * Everything here is a **read**, and only the three cost-and-usage calls cost
 * money: Cost Explorer charges $0.01 per request, and a request is a page, so
 * a paginated call is capped rather than looped to exhaustion. `GetAnomalies`
 * is free per Cost Anomaly Detection's pricing, as are Budgets and Free Tier,
 * so its pages are counted separately and never billed to the run.
 *
 * Every charged request is counted through a {@link CostRequestMeter} the
 * caller owns and passes in, incremented **before** the call goes out. A page
 * that throws has still been sent — and, as far as anything here can tell,
 * still charged — so the meter keeps the count a `return` value would lose.
 *
 * Conventions that apply to every Cost Explorer call below:
 *
 * - **`UnblendedCost`**, the metric that answers "what did this account
 *   actually get charged for this usage". `BlendedCost` only differs in an
 *   organisation with reserved-instance sharing, which this account is not.
 * - **Credits and refunds are filtered out** (`RECORD_TYPE`). A $100 credit
 *   landing on the 3rd would otherwise make the 3rd look like a $100 saving
 *   and the month's forecast nonsense. The figures are therefore *usage*,
 *   which is what a forecast and a per-tenant allocation must be built on;
 *   the invoice is this minus credits.
 * - **`End` is exclusive** and no *historical* call asks about today, whose
 *   spend AWS has not totalled. The forecast is the exception and has to be:
 *   its `Start` may be no later than today. See `./calendar.ts`.
 * - **Amounts arrive as strings** (`MetricValue.Amount`) and are parsed here,
 *   once. A value AWS omits or sends unparseable is 0, not `NaN`.
 */
import { DescribeBudgetsCommand, type Budget } from "@aws-sdk/client-budgets";
import {
  GetAnomaliesCommand,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  type Expression,
  type GroupDefinition,
} from "@aws-sdk/client-cost-explorer";
import {
  GetAccountPlanStateCommand,
  GetFreeTierUsageCommand,
  type FreeTierUsage,
} from "@aws-sdk/client-freetier";
import {
  awsAccountId,
  budgetsClient,
  costExplorerClient,
  freeTierClient,
} from "./aws";
import { isoDayFrom, type IsoDay } from "./calendar";
import type { CostAnomaly, CostBudget, FreeTierOffer, FreeTierState } from "./types";

/**
 * The most pages one paginated Cost Explorer call may fetch.
 *
 * Each page is a charged request, so this is a spending cap rather than a
 * performance one. Thirty-five days of an account with about fifteen services
 * is a few hundred groups and **fits in one page**, so the cap is never
 * reached in normal operation; eight pages is the ceiling for an account that
 * has grown, or for a `settings.days` near its 120-day limit.
 *
 * Truncation is not a quiet event. The caller treats a truncated answer as a
 * **failed** call and refuses to replace the cached window with it, because a
 * partial answer written over a complete one loses history that costs money
 * to fetch again.
 */
const MAX_PAGES = 8;

/**
 * A count of charged Cost Explorer requests, owned by the caller.
 *
 * Incremented before each request goes out, so a call that throws half way
 * through its pages still leaves the run with the true number of requests it
 * spent. `GetAnomalies` pages are not counted here — Cost Anomaly Detection
 * is free.
 */
export interface CostRequestMeter {
  requests: number;
}

/** The metric every cost call reads. */
const METRIC = "UnblendedCost";

/**
 * Everything that is not a credit or a refund. `Not` around a dimension
 * filter is how Cost Explorer spells "exclude these record types".
 */
const EXCLUDE_CREDITS: Expression = {
  Not: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund"] } },
};

const BY_SERVICE: GroupDefinition = { Type: "DIMENSION", Key: "SERVICE" };

/** `MetricValue.Amount` as a number. Absent or unparseable is 0. */
function amountOf(value: { Amount?: string } | undefined): number {
  if (!value?.Amount) return 0;
  const parsed = Number.parseFloat(value.Amount);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A `Spend`'s amount, or null when AWS sent none. */
function spendOf(value: { Amount?: string } | undefined): number | null {
  if (!value?.Amount) return null;
  const parsed = Number.parseFloat(value.Amount);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A tag group's key, as Cost Explorer spells it: `Component$web` for a
 * tagged resource and `Component$` for one the tag does not cover. The value
 * after the `$` is what we store; `""` is "untagged", a real answer.
 *
 * A key with no `$` at all cannot be a tag group, and is skipped rather than
 * stored under a guess.
 */
function tagValueOf(key: string, tagKey: string): string | null {
  const prefix = `${tagKey}$`;
  if (!key.startsWith(prefix)) return null;
  return key.slice(prefix.length);
}

/* -------------------------------------------------------------------------- */
/*                            Daily cost by service                           */
/* -------------------------------------------------------------------------- */

/** One day's cost for one service. */
export interface DailyCostRow {
  day: IsoDay;
  /** Cost Explorer's SERVICE dimension value, verbatim. */
  service: string;
  amountUsd: number;
  /** True while AWS still calls the day an estimate. */
  estimated: boolean;
}

export interface CostFetch<T> {
  rows: T[];
  /**
   * True when the cap stopped the paging before AWS ran out of pages, which
   * makes the answer incomplete. The caller must not write it over a complete
   * window.
   */
  truncated: boolean;
}

/**
 * Cost per day and service for `[start, end)`.
 *
 * One charged request per page, counted on `meter` before it is sent; groups
 * with a zero amount are dropped rather than stored, because a table of a
 * hundred services that cost nothing is not a useful table and the rows would
 * outnumber the real ones.
 */
export async function fetchDailyByService(
  range: {
    start: IsoDay;
    end: IsoDay;
  },
  meter: CostRequestMeter,
): Promise<CostFetch<DailyCostRow>> {
  const client = costExplorerClient();
  const rows: DailyCostRow[] = [];
  let token: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Before the send: a request that throws has still been made.
    meter.requests += 1;
    const response = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: range.start, End: range.end },
        Granularity: "DAILY",
        Metrics: [METRIC],
        GroupBy: [BY_SERVICE],
        Filter: EXCLUDE_CREDITS,
        NextPageToken: token,
      }),
    );

    for (const period of response.ResultsByTime ?? []) {
      const day = isoDayFrom(period.TimePeriod?.Start);
      if (day === null) continue;
      const estimated = period.Estimated === true;
      for (const group of period.Groups ?? []) {
        const service = group.Keys?.[0]?.trim();
        if (!service) continue;
        const amountUsd = amountOf(group.Metrics?.[METRIC]);
        if (amountUsd === 0) continue;
        rows.push({ day, service, amountUsd, estimated });
      }
    }

    token = response.NextPageToken;
    if (!token) break;
    truncated = page === MAX_PAGES - 1;
  }

  return { rows, truncated };
}

/* -------------------------------------------------------------------------- */
/*                      Month to date by service and component                */
/* -------------------------------------------------------------------------- */

/** The month-to-date cost of one service under one component tag value. */
export interface ComponentCostRow extends DailyCostRow {
  /** The tag value; `""` for spend the tag does not cover. */
  component: string;
}

/**
 * Cost for `[start, end)` grouped by service **and** by the `tagKey` cost
 * allocation tag, at monthly granularity.
 *
 * Two group-by keys is the maximum Cost Explorer allows and both are used,
 * because the result is stored in the same `(day, service, component)` table
 * as the daily series and grouping by the tag alone would leave `service`
 * with nothing meaningful in it. The stored `day` is the period's start — the
 * 1st of the month — since the figure describes the month, not a day.
 *
 * **A tag nobody activated is not an error.** Until the tag is activated in
 * the Billing console, Cost Explorer either returns nothing or returns one
 * group whose tag value is empty; both come back here as rows (or no rows)
 * and the caller reports "no component data yet". Activation is also not
 * retroactive, so spend from before it will never appear however often this
 * runs.
 */
export async function fetchByComponent(
  range: {
    start: IsoDay;
    end: IsoDay;
    tagKey: string;
  },
  meter: CostRequestMeter,
): Promise<CostFetch<ComponentCostRow>> {
  const client = costExplorerClient();
  const rows: ComponentCostRow[] = [];
  let token: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Before the send: a request that throws has still been made.
    meter.requests += 1;
    const response = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: range.start, End: range.end },
        Granularity: "MONTHLY",
        Metrics: [METRIC],
        GroupBy: [BY_SERVICE, { Type: "TAG", Key: range.tagKey }],
        Filter: EXCLUDE_CREDITS,
        NextPageToken: token,
      }),
    );

    for (const period of response.ResultsByTime ?? []) {
      const day = isoDayFrom(period.TimePeriod?.Start);
      if (day === null) continue;
      const estimated = period.Estimated === true;
      for (const group of period.Groups ?? []) {
        const service = group.Keys?.[0]?.trim();
        const component = tagValueOf(group.Keys?.[1] ?? "", range.tagKey);
        if (!service || component === null) continue;
        const amountUsd = amountOf(group.Metrics?.[METRIC]);
        if (amountUsd === 0) continue;
        rows.push({ day, service, component, amountUsd, estimated });
      }
    }

    token = response.NextPageToken;
    if (!token) break;
    truncated = page === MAX_PAGES - 1;
  }

  return { rows, truncated };
}

/* -------------------------------------------------------------------------- */
/*                                  Forecast                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cost Explorer's forecast for `[start, end)`, in USD.
 *
 * **`Start` must be today, not tomorrow.** The API model is explicit: "the
 * start date must be equal to or no later than the current date to avoid a
 * validation error" (`DateInterval.Start`, and again on
 * `GetCostForecastRequest.TimePeriod`). Asking from tomorrow earns a
 * `ValidationException`, which costs the request and answers nothing — the
 * bug this call used to have.
 *
 * So the caller asks for `[today, 1st of next month)` and the forecast covers
 * **today plus every day left in the month**. Month to date covers the 1st to
 * yesterday, so `monthToDate + forecast` is the whole month exactly once,
 * with no day counted twice and no day missed. On the last day of a month the
 * window is the single day `[today, tomorrow)`, where tomorrow *is* the 1st of
 * the next month; on the 1st, month to date is empty and the forecast alone is
 * the projection.
 *
 * Cost Explorer refuses to forecast an account with too little history, and
 * says so with `DataUnavailableException`; that is a normal answer for a new
 * account, not a failure, and the caller records it as a skipped call.
 *
 * No `Filter` here, unlike every other call: `GetCostForecast` accepts only a
 * narrow set of filter expressions and `Not` over `RECORD_TYPE` is not one
 * AWS documents as supported, so sending it risks a `ValidationException`
 * that would cost the request and answer nothing. The forecast is therefore
 * the only figure on the page that may include the effect of a recurring
 * credit — which, for an account with no credits, is no difference at all.
 */
export async function fetchForecast(
  range: {
    start: IsoDay;
    end: IsoDay;
  },
  meter: CostRequestMeter,
): Promise<{ amountUsd: number }> {
  // Before the send: a request that throws has still been made.
  meter.requests += 1;
  const response = await costExplorerClient().send(
    new GetCostForecastCommand({
      TimePeriod: { Start: range.start, End: range.end },
      Metric: "UNBLENDED_COST",
      Granularity: "MONTHLY",
    }),
  );
  return { amountUsd: amountOf(response.Total) };
}

/* -------------------------------------------------------------------------- */
/*                                  Anomalies                                 */
/* -------------------------------------------------------------------------- */

/**
 * Cost Anomaly Detection's findings for `[start, end]`.
 *
 * **The interval filters on the anomaly's *end* date.** `GetAnomalies`
 * returns anomalies whose `AnomalyEndDate` falls inside the given
 * `AnomalyDateInterval`, so an anomaly AWS still considers open — no end date
 * yet — may not come back at all, however recent it is. The caller therefore
 * asks up to *tomorrow* rather than today, which is the widest end this API
 * accepts without inventing a future, and the card's "still open" label is
 * kept for the rows that do arrive with no end date.
 *
 * **Free** — Cost Anomaly Detection has no per-request charge — so its pages
 * take no {@link CostRequestMeter} and are never billed to the run. The page
 * count is returned for the run record only.
 *
 * Empty in two different situations that look the same from here: nothing
 * anomalous happened, or the account has no anomaly monitor at all. The page
 * says which by whether the account was ever set up, not by this list.
 */
export async function fetchAnomalies(range: {
  start: IsoDay;
  end: IsoDay;
}): Promise<{ anomalies: CostAnomaly[]; pages: number }> {
  const client = costExplorerClient();
  const anomalies: CostAnomaly[] = [];
  let token: string | undefined;
  let pages = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    pages += 1;
    const response = await client.send(
      new GetAnomaliesCommand({
        DateInterval: { StartDate: range.start, EndDate: range.end },
        NextPageToken: token,
        MaxResults: 100,
      }),
    );

    for (const anomaly of response.Anomalies ?? []) {
      if (!anomaly.AnomalyId) continue;
      anomalies.push({
        id: anomaly.AnomalyId,
        // `DimensionValue` is the service for a SERVICE-scoped monitor; the
        // root causes name it for the others.
        service: anomaly.DimensionValue ?? anomaly.RootCauses?.[0]?.Service ?? null,
        startDate: isoDayFrom(anomaly.AnomalyStartDate),
        endDate: isoDayFrom(anomaly.AnomalyEndDate),
        totalImpactUsd: anomaly.Impact?.TotalImpact ?? 0,
        maxImpactUsd: anomaly.Impact?.MaxImpact ?? null,
        totalActualUsd: anomaly.Impact?.TotalActualSpend ?? null,
        totalExpectedUsd: anomaly.Impact?.TotalExpectedSpend ?? null,
        feedback: anomaly.Feedback ?? null,
      });
    }

    token = response.NextPageToken;
    if (!token) break;
  }

  // Worst first: an anomaly list is read top-down and stopped at.
  anomalies.sort((a, b) => b.totalImpactUsd - a.totalImpactUsd);
  return { anomalies, pages };
}

/* -------------------------------------------------------------------------- */
/*                                   Budget                                   */
/* -------------------------------------------------------------------------- */

/** The budget's unit, when it is not USD, so the caller can say so. */
export interface BudgetFetch {
  budget: CostBudget | null;
  /** The currency AWS reported the limit in; only ever not `USD` by mistake. */
  unit: string | null;
  /** How many budgets the account has, for the note when there are several. */
  count: number;
}

/**
 * The account's budget: the one `name` asks for, else the first one AWS
 * returns.
 *
 * `CalculatedSpend` is Budgets' own arithmetic, not ours — which is the point
 * of reading it rather than deriving "are we over budget" from the daily
 * series: a budget can be scoped and filtered in ways this job does not
 * model, and the number the alert emails quote is this one.
 *
 * An account with no budget answers `{ budget: null }`. That is a normal
 * state, not a failure.
 */
export async function fetchBudget(name?: string | null): Promise<BudgetFetch> {
  const accountId = await awsAccountId();
  const response = await budgetsClient().send(
    new DescribeBudgetsCommand({ AccountId: accountId, MaxResults: 100 }),
  );
  const budgets = response.Budgets ?? [];
  const wanted = name?.trim();
  const chosen: Budget | undefined =
    wanted === undefined || wanted === ""
      ? budgets[0]
      : budgets.find((candidate) => candidate.BudgetName === wanted);

  if (!chosen?.BudgetName) return { budget: null, unit: null, count: budgets.length };

  return {
    budget: {
      name: chosen.BudgetName,
      limitUsd: spendOf(chosen.BudgetLimit),
      actualUsd: spendOf(chosen.CalculatedSpend?.ActualSpend),
      forecastUsd: spendOf(chosen.CalculatedSpend?.ForecastedSpend),
    },
    unit: chosen.BudgetLimit?.Unit ?? null,
    count: budgets.length,
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Free tier                                 */
/* -------------------------------------------------------------------------- */

function toOffer(usage: FreeTierUsage): FreeTierOffer | null {
  const service = usage.service?.trim();
  if (!service) return null;
  const used = usage.actualUsageAmount ?? null;
  const limit = usage.limit ?? null;
  return {
    service,
    description: usage.description?.trim() ?? "",
    unit: usage.unit?.trim() ?? "",
    usedAmount: used,
    limitAmount: limit,
    forecastedAmount: usage.forecastedUsageAmount ?? null,
    usedShare: used !== null && limit !== null && limit > 0 ? used / limit : null,
  };
}

/**
 * Where the account stands with the free tier: which plan it is on, how much
 * credit is left, and how far through each offer the month is.
 *
 * Both calls are free and both are allowed to refuse. An account that has
 * left the free tier answers `ResourceNotFoundException`, and an account
 * whose policy does not include `freetier:*` answers `AccessDenied`; the
 * caller treats either as "not applicable" and the page simply shows no
 * free-tier figure. That is why `freetier:*` is the one optional permission
 * in the task role.
 */
export async function fetchFreeTier(): Promise<FreeTierState> {
  const client = freeTierClient();
  const plan = await client.send(new GetAccountPlanStateCommand({}));

  const offers: FreeTierOffer[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await client.send(new GetFreeTierUsageCommand({ nextToken: token }));
    for (const usage of response.freeTierUsages ?? []) {
      const offer = toOffer(usage);
      if (offer !== null) offers.push(offer);
    }
    token = response.nextToken;
    if (!token) break;
  }

  // Closest to its limit first: that is the one about to start costing money.
  offers.sort((a, b) => (b.usedShare ?? -1) - (a.usedShare ?? -1));

  return {
    planType: plan.accountPlanType ?? null,
    planStatus: plan.accountPlanStatus ?? null,
    // `MonetaryAmount` here is already a number with a currency code beside
    // it, not Cost Explorer's stringly-typed `Spend`. Only USD is expected;
    // another currency would be recorded as-is rather than converted.
    remainingCreditsUsd: plan.accountPlanRemainingCredits?.amount ?? null,
    expiresAt: plan.accountPlanExpirationDate?.toISOString() ?? null,
    offers,
  };
}
