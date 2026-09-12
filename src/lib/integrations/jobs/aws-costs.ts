import "server-only";
/**
 * The `aws_costs` run: everything the Cost center page shows, fetched once a
 * day and cached in the admin database.
 *
 * **Why a job at all.** Cost Explorer charges $0.01 per request and its data
 * lags about a day. A page that asked AWS on every load would cost more than
 * some of the resources it reports on and would not be any fresher for it, so
 * the page reads `admin_cost_daily` and `admin_cost_snapshots` and this is
 * the only thing in the app allowed to call AWS about money.
 *
 * **What one run costs.** Three charged Cost Explorer requests — daily by
 * service, this month by service and component, the forecast — at $0.01 each,
 * so about **$0.03 a run and roughly $1 a month** at one run a day. On the
 * first three days of a month a fourth is added, because the previous month's
 * component split is re-read once its last day has settled. `GetAnomalies` is
 * free (Cost Anomaly Detection has no per-request charge), as are Budgets,
 * Free Tier and `sts:GetCallerIdentity`. A window wide enough to page would
 * add a request per page, which is why `settings.days` is capped at
 * `COST_FETCH_DAYS_MAX` and `MAX_PAGES` in `src/lib/costs/explorer.ts` is the
 * ceiling. The `raw` column of every snapshot records how many requests the
 * run actually spent, including the pages of a call that then failed.
 *
 * **What the counters mean here.** Unlike every other integration, this run
 * does not process a list of items — it makes a fixed set of AWS calls. So:
 *
 * - `total` is the calls the run planned (a call the calendar makes
 *   meaningless, such as a forecast on the last day of the month, is never
 *   planned and so never counted);
 * - `processed` is the calls that came back, whether they answered or
 *   refused;
 * - `failed` is the calls that refused for a reason worth an operator's
 *   attention — including a request AWS called invalid
 *   (`ValidationException`), and an answer that was good but could not be
 *   written because it would have replaced complete cached rows with an
 *   incomplete or empty reading. A refusal that means "this does not apply to
 *   this account" — no budget, no free-tier plan, too little history to
 *   forecast — is not a failure and is recorded as a skip;
 * - `created` and `updated` are **rows**, not calls: how many
 *   `admin_cost_daily` rows the run inserted that had no previous reading,
 *   and how many replaced one.
 *
 * **Failure.** A credentials or IAM problem throws at once: every further
 * call would spend a request to learn the same thing, and only an operator
 * can fix it. `DataUnavailableException` on the first call means Cost
 * Explorer has never been enabled on the account, which throws with its own
 * sentence because the fix is one click rather than an IAM change; on any
 * other call it keeps its own meaning — "this question does not apply here" —
 * and is a skip. Anything else, `ValidationException` included, is folded
 * into the counters, recorded in the snapshot's `raw`, and rethrown as the
 * run's `error` at the very end — after the rows and the snapshot have been
 * written, so a run that got three answers out of four still leaves those
 * three on the page.
 */
import {
  COST_EXPLORER_NOT_ENABLED,
  awsMessage,
  isCostExplorerNotEnabled,
  isCredentialsFailure,
  isInvalidRequest,
  isNotApplicable,
} from "@/lib/costs/aws";
import {
  dayOfMonth,
  shiftDay,
  startOfNextMonth,
  startOfPreviousMonth,
  type IsoDay,
} from "@/lib/costs/calendar";
import {
  fetchAnomalies,
  fetchBudget,
  fetchByComponent,
  fetchDailyByService,
  fetchForecast,
  fetchFreeTier,
  type ComponentCostRow,
  type CostRequestMeter,
} from "@/lib/costs/explorer";
import {
  createSnapshot,
  monthToDateTotal,
  replaceComponentSeries,
  replaceServiceSeries,
  type CostDailyWrite,
  type ReplaceOutcome,
} from "@/lib/costs/repository";
import { costWindows } from "@/lib/costs/service";
import type { CostAnomaly, CostBudget, FreeTierState } from "@/lib/costs/types";
import { COST_FETCH_DAYS_MAX } from "@/lib/costs/types";
import type { RunWork } from "../runs";

export interface AwsCostsRunContext {
  /** Days back the daily fetch reaches, ending yesterday. */
  days: number;
  /** The cost allocation tag the month-to-date split is grouped by. */
  componentTag: string;
  /** Which budget to read; null means the first the account has. */
  budgetName: string | null;
  /**
   * The instant the run treats as "now". Injected only by a test or an
   * ad-hoc check; production leaves it alone.
   */
  now?: Date;
}

/**
 * How one planned call ended, for the snapshot's `raw`: `ok`, or `skipped: `
 * / `failed: ` followed by the reason. A plain string rather than a template
 * union — the strings are for a person reading the snapshot, and nothing
 * branches on them.
 */
type CallOutcome = string;

/**
 * A planned AWS call and its bookkeeping.
 *
 * `fatal` marks the calls whose refusal by IAM means the whole feature is
 * misconfigured (`ce:*`, `budgets:*`). `freetier:*` is not fatal: it is the
 * one optional permission in the task role, and an account that has left the
 * free tier refuses it too, so "no answer" is a normal state there.
 *
 * `requests` doubles as the {@link CostRequestMeter} handed to every charged
 * call, so a call that throws half way through its pages still leaves the
 * pages it did send in the count.
 */
interface Attempt extends CostRequestMeter {
  processed: number;
  failed: number;
  /** Charged Cost Explorer requests spent so far. */
  requests: number;
  outcomes: Record<string, CallOutcome>;
  /** One line per failure, for the run's `error`. */
  errors: string[];
}

/**
 * How far into a month the **previous** month's component split is re-read.
 *
 * Cost Explorer's `End` is exclusive and nothing is asked about today, so the
 * split window for a month can only ever reach yesterday — which means the
 * last day of a month is never covered while that month is current. Re-asking
 * for the whole of the previous month once it has ended fixes that, and doing
 * it for the first three days rather than only on the 1st covers the day or
 * two AWS takes to settle the month's tail. It is one extra charged request,
 * and only on those days.
 */
const COMPONENT_BACKFILL_UNTIL_DAY = 3;

export function awsCostsWork(context: AwsCostsRunContext): RunWork {
  return async (report) => {
    const now = context.now ?? new Date();
    const windows = costWindows(now);
    const today = windows.today;

    /* ------------------------------ The plan ------------------------------ */

    // `End` is exclusive everywhere in Cost Explorer, so "the last N days
    // ending yesterday" is [today - N, today). The window is clamped here as
    // well as in the settings reader: every page of the answer is a charged
    // request, and this is the last place before the money is spent.
    const days = Math.min(COST_FETCH_DAYS_MAX, Math.max(1, Math.trunc(context.days)));
    const dailyStart = shiftDay(today, -days);

    // This month's split by component needs at least one whole day in the
    // month. On the 1st there is none, so the call is not planned at all
    // rather than sent and refused.
    const wantsComponents = windows.monthFrom < today;

    // The previous month's split, for its last day — which no window ending
    // yesterday could ever have covered. Once the month has ended the range is
    // fixed, so this is worth one request early in the new month and nothing
    // afterwards.
    const previousMonthFrom = startOfPreviousMonth(today);
    const previousMonthTo = shiftDay(windows.monthFrom, -1);
    const wantsPreviousComponents = dayOfMonth(today) <= COMPONENT_BACKFILL_UNTIL_DAY;

    // The forecast is always planned. `GetCostForecast` requires a `Start` no
    // later than today, so the window is [today, 1st of next month): today
    // plus everything left in the month. Month to date covers the 1st to
    // yesterday, so the two together are the month exactly once. On the last
    // day of the month the window is the single day [today, tomorrow), where
    // tomorrow is the 1st of the next month; on the 1st, month to date is
    // empty and the forecast alone is the projection.
    const forecastStart: IsoDay = today;
    const forecastEnd: IsoDay = startOfNextMonth(today);

    const planned =
      1 /* daily by service */ +
      (wantsComponents ? 1 : 0) +
      (wantsPreviousComponents ? 1 : 0) +
      1 /* forecast */ +
      1 /* anomalies */ +
      1 /* budget */ +
      1 /* free tier */;

    const attempt: Attempt = {
      processed: 0,
      failed: 0,
      requests: 0,
      outcomes: {},
      errors: [],
    };

    let created = 0;
    let updated = 0;

    const progress = () =>
      report({
        total: planned,
        processed: attempt.processed,
        created,
        updated,
        unchanged: 0,
        failed: attempt.failed,
      });

    await progress();

    /** Records a call as failed, in all three places a failure is reported. */
    const fail = (name: string, message: string) => {
      attempt.failed += 1;
      attempt.outcomes[name] = `failed: ${message}`;
      attempt.errors.push(`${name}: ${message}`);
    };

    /**
     * Runs one planned call and records how it went.
     *
     * Returns `null` when the call did not answer, so every caller has to
     * decide what a missing answer means rather than being handed a zero.
     *
     * @throws when the credentials or the IAM policy are wrong (always), or
     * when Cost Explorer has never been enabled on the account.
     */
    const call = async <T>(
      name: string,
      run: () => Promise<T>,
      options: { fatal?: boolean } = {},
    ): Promise<T | null> => {
      const fatal = options.fatal !== false;
      try {
        const value = await run();
        attempt.processed += 1;
        attempt.outcomes[name] = "ok";
        await progress();
        return value;
      } catch (error) {
        attempt.processed += 1;
        const message = awsMessage(error);

        if (isCostExplorerNotEnabled(error) && name === "costAndUsageDaily") {
          // The very first call, and the account has never opened Cost
          // Explorer. Nothing else can succeed either, and the fix is not an
          // IAM one, so say exactly that and stop.
          throw new Error(COST_EXPLORER_NOT_ENABLED);
        }

        if (isCredentialsFailure(error) && fatal) {
          // Every further call would spend a request to learn the same thing.
          throw new Error(
            `AWS refused ${name}: ${message} Check the task role's ` +
              `CostAndUsageRead policy (infra/service-admin.yaml) and, locally, ` +
              `that the AWS credentials in the environment are current.`,
          );
        }

        if (isNotApplicable(error) || !fatal) {
          // "This question does not apply to this account": no budget, no
          // free-tier plan, not enough history to forecast. Not a failure —
          // recorded and moved past. `freetier:*` (`fatal: false`) is here
          // for the same reason: refusing is its normal answer.
          attempt.outcomes[name] = `skipped: ${message}`;
          await progress();
          return null;
        }

        if (isInvalidRequest(error)) {
          // `ValidationException` / `InvalidNextTokenException`: AWS says the
          // request itself was wrong. That is a bug in the window this job
          // built, not a fact about the account, and it cost a request to
          // learn — so it is a failure with its message in the run's error,
          // loudly enough that nobody has to read a snapshot's `raw` to find
          // out why a figure stopped moving.
          fail(name, message);
          await progress();
          return null;
        }

        fail(name, message);
        await progress();
        return null;
      }
    };

    /**
     * Writes one fetched series and records what the write did.
     *
     * Two things count as a failed call here, neither of which is an AWS
     * error: a replace the repository **refused** (it would have dropped
     * complete cached rows for an incomplete or empty answer), and a fetch the
     * page cap **truncated** (whatever was written covers only part of the
     * window). Both leave a figure on the page that is not the figure AWS
     * holds, so the run must not report success.
     */
    const store = async (
      name: string,
      fetched: { truncated: boolean },
      write: () => Promise<ReplaceOutcome>,
    ): Promise<ReplaceOutcome> => {
      const outcome = await write();
      if (outcome.refused !== null) {
        fail(name, outcome.refused);
      } else if (fetched.truncated) {
        fail(
          name,
          "the page cap stopped the fetch early, so the window written covers only " +
            "part of the range asked for; lower settings.days or raise MAX_PAGES in " +
            "src/lib/costs/explorer.ts",
        );
      } else {
        created += Math.max(0, outcome.written - outcome.removed);
        updated += Math.min(outcome.written, outcome.removed);
      }
      await progress();
      return outcome;
    };

    /* ------------------------ (a) Daily, by service ------------------------ */

    const daily = await call("costAndUsageDaily", () =>
      fetchDailyByService({ start: dailyStart, end: today }, attempt),
    );
    if (daily !== null) {
      const rows: CostDailyWrite[] = daily.rows.map((row) => ({
        day: row.day,
        service: row.service,
        component: null,
        amountUsd: row.amountUsd,
        estimated: row.estimated,
      }));
      // The whole window is replaced, not merged: Cost Explorer revises
      // recent days, and today's answer is the only one worth keeping — but
      // only when the answer is complete. `store` refuses the rest.
      await store("costAndUsageDaily", daily, () =>
        replaceServiceSeries(dailyStart, windows.yesterday, rows, {
          truncated: daily.truncated,
        }),
      );
    }

    /* ------------- (b) By service and component, month by month ------------ */

    /** Maps a component fetch onto the rows the repository writes. */
    const componentWrites = (rows: readonly ComponentCostRow[]): CostDailyWrite[] =>
      rows.map((row) => ({
        day: row.day,
        service: row.service,
        // `""` is a real answer — spend the tag does not cover — and is
        // stored as the empty string so it stays distinct from the NULL
        // that marks the by-service series.
        component: row.component,
        amountUsd: row.amountUsd,
        estimated: row.estimated,
      }));

    /** The sentence a run earns when the cost allocation tag is not active. */
    const tagNotActive =
      `skipped: AWS returned no groups for the "${context.componentTag}" cost ` +
      "allocation tag. Activate it in the Billing console; activation is not retroactive.";

    let componentRows = 0;

    // (b1) This month, from the 1st to yesterday.
    if (wantsComponents) {
      const components = await call("costAndUsageByComponent", () =>
        fetchByComponent(
          { start: windows.monthFrom, end: today, tagKey: context.componentTag },
          attempt,
        ),
      );
      if (components !== null) {
        const rows = componentWrites(components.rows);
        componentRows += rows.length;
        const outcome = await store("costAndUsageByComponent", components, () =>
          replaceComponentSeries(windows.monthFrom, windows.yesterday, rows, {
            truncated: components.truncated,
          }),
        );
        // Only when nothing went wrong: a refusal or a truncation has already
        // written a failure into the same slot and must not be overwritten
        // with a reassuring skip.
        if (rows.length === 0 && outcome.refused === null && !components.truncated) {
          attempt.outcomes.costAndUsageByComponent = tagNotActive;
        }
      }
    } else {
      attempt.outcomes.costAndUsageByComponent =
        "skipped: the month has no completed day yet (it is the 1st)";
    }

    // (b2) The previous month, whole — the only way its last day is ever
    // covered, since every window while the month was current ended
    // yesterday. Asked for the first few days of the new month only.
    if (wantsPreviousComponents) {
      const previous = await call("costAndUsageByComponentPrevious", () =>
        fetchByComponent(
          { start: previousMonthFrom, end: windows.monthFrom, tagKey: context.componentTag },
          attempt,
        ),
      );
      if (previous !== null) {
        const rows = componentWrites(previous.rows);
        componentRows += rows.length;
        const outcome = await store("costAndUsageByComponentPrevious", previous, () =>
          replaceComponentSeries(previousMonthFrom, previousMonthTo, rows, {
            truncated: previous.truncated,
          }),
        );
        if (rows.length === 0 && outcome.refused === null && !previous.truncated) {
          attempt.outcomes.costAndUsageByComponentPrevious = tagNotActive;
        }
      }
    } else {
      attempt.outcomes.costAndUsageByComponentPrevious =
        `skipped: the previous month is only re-read on the first ` +
        `${COMPONENT_BACKFILL_UNTIL_DAY} days of a month, once its last day has settled`;
    }

    /* ----------------- The month to date, from what was written ----------- */

    // Read back rather than summing the fetched rows: the window the page
    // shows and the figure the snapshot carries then come from the same
    // query, so they can never disagree by a rounding step.
    const monthToDateUsd = await monthToDateTotal(windows.monthFrom, windows.monthTo);

    /* ------------------------------ (c) Forecast --------------------------- */

    // Always asked. `[today, 1st of next month)` is what is left of the
    // month *including today*, and month to date ends yesterday, so the two
    // add up to the month with no gap and no overlap. On the last day of the
    // month the window is that one day.
    let forecastUsd: number | null = null;
    const forecast = await call("costForecast", () =>
      fetchForecast({ start: forecastStart, end: forecastEnd }, attempt),
    );
    if (forecast !== null) {
      // Stored as the projected **month total**, which is what the page
      // labels "Forecast": what is left plus what has already been spent.
      forecastUsd = monthToDateUsd + forecast.amountUsd;
    }

    /* ----------------------------- (d) Anomalies -------------------------- */

    // A fixed 35 days regardless of `settings.days`: Cost Anomaly Detection
    // is free, and "what went wrong recently" is not the same question as
    // "how far back does the chart go".
    //
    // The interval filters on the anomaly's **end** date, so it reaches to
    // tomorrow rather than today — and an anomaly AWS still considers open,
    // with no end date at all, may not be returned however recent it is. The
    // card is therefore "what has finished going wrong", which is why nothing
    // on the page treats an empty list as proof that all is well.
    const anomalyStart = shiftDay(today, -35);
    const anomalyEnd = shiftDay(today, 1);
    const anomalyResult = await call("anomalies", () =>
      fetchAnomalies({ start: anomalyStart, end: anomalyEnd }),
    );
    const anomalies: CostAnomaly[] = anomalyResult?.anomalies ?? [];
    // Deliberately not added to `attempt.requests`: GetAnomalies is free per
    // Cost Anomaly Detection's pricing, so charging the run for its pages
    // would make the snapshot's cost figure a lie.

    /* ------------------------------- (e) Budget --------------------------- */

    const budgetResult = await call("budget", () => fetchBudget(context.budgetName));
    const budget: CostBudget | null = budgetResult?.budget ?? null;
    if (budgetResult !== null && budgetResult.budget === null) {
      attempt.outcomes.budget =
        context.budgetName === null
          ? "skipped: the account has no AWS budget"
          : `skipped: the account has no budget named "${context.budgetName}"`;
    }
    if (budgetResult?.unit !== null && budgetResult?.unit !== undefined && budgetResult.unit !== "USD") {
      // Recorded rather than converted: this app does no FX, and a budget in
      // another currency compared against USD spend would be a silent lie.
      attempt.outcomes.budget = `ok: the budget's limit is in ${budgetResult.unit}, not USD`;
    }

    /* ------------------------------ (f) Free tier ------------------------- */

    // `fatal: false` — `freetier:*` is the one optional permission on the
    // task role, and an account past the free tier refuses these calls too.
    // Either way the answer is "not applicable", not "something is broken".
    const freeTier: FreeTierState | null = await call("freeTier", () => fetchFreeTier(), {
      fatal: false,
    });

    /* ------------------------------ The snapshot -------------------------- */

    await createSnapshot({
      month: windows.month,
      monthToDateUsd,
      forecastUsd,
      budgetName: budget?.name ?? null,
      budgetLimitUsd: budget?.limitUsd ?? null,
      budgetActualUsd: budget?.actualUsd ?? null,
      budgetForecastUsd: budget?.forecastUsd ?? null,
      freeTier,
      anomalies,
      raw: {
        windows: {
          today,
          dailyFrom: dailyStart,
          dailyToInclusive: windows.yesterday,
          monthFrom: windows.monthFrom,
          monthToInclusive: windows.monthTo,
          components: wantsComponents
            ? { from: windows.monthFrom, toInclusive: windows.yesterday }
            : null,
          previousComponents: wantsPreviousComponents
            ? { from: previousMonthFrom, toInclusive: previousMonthTo }
            : null,
          // Always present now: `GetCostForecast` accepts a `Start` of today
          // on every day of the month, the last one included.
          forecast: { from: forecastStart, toExclusive: forecastEnd },
          anomaliesFrom: anomalyStart,
          anomaliesToInclusive: anomalyEnd,
        },
        settings: {
          // What the run actually used, after the fetch-window clamp — not
          // what the row asked for.
          days,
          daysRequested: context.days,
          componentTag: context.componentTag,
          budgetName: context.budgetName,
        },
        calls: attempt.outcomes,
        // What this run spent at AWS, at $0.01 a request: the pages of
        // `GetCostAndUsage` plus the one `GetCostForecast`, including the
        // pages of a call that then failed. `GetAnomalies`, Budgets, Free
        // Tier and `sts:GetCallerIdentity` are free and are not counted.
        costExplorerRequests: attempt.requests,
        anomalyPagesFree: anomalyResult?.pages ?? null,
        componentRowsWritten: componentRows,
        budgetsOnAccount: budgetResult?.count ?? null,
      },
    });

    await progress();

    console.info(
      `[integrations] aws_costs: ${attempt.processed}/${planned} calls, ` +
        `${attempt.requests} Cost Explorer requests, ` +
        `month to date $${monthToDateUsd.toFixed(2)}` +
        (forecastUsd === null ? "" : `, forecast $${forecastUsd.toFixed(2)}`) +
        (anomalies.length === 0 ? "" : `, ${anomalies.length} anomalies`),
    );

    // Everything the run managed is already committed, so saying what went
    // wrong costs nothing that was achieved. A run with a failed call is a
    // failed run: the page would otherwise show a day-old figure under a
    // green tick.
    if (attempt.errors.length > 0) {
      throw new Error(
        `${attempt.errors.length} of ${planned} planned calls failed — ` +
          `${attempt.errors.join("; ")}`,
      );
    }
  };
}
