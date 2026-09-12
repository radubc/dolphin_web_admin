import "server-only";
/**
 * The customer pool's daily counters, from CloudWatch.
 *
 * Cognito on the Essentials tier publishes nothing per user — that is the Plus
 * tier's threat-protection feature, $0.020 per monthly active user with no
 * free allowance — but it publishes the whole pool's counts to the
 * `AWS/Cognito` namespace for free, and `GetMetricData` reads them for free
 * too. So "sign-ins per day" is answerable; "did Alice sign in" is not, and
 * comes from the main app database's `users.last_seen_at` instead.
 *
 * Conventions the rest of the app does not have to remember:
 *
 * - **Region is the pool's region**, not `us-east-1`. Unlike Cost Explorer
 *   (see `src/lib/costs/aws.ts`, where the pin to `us-east-1` is deliberate),
 *   CloudWatch metrics live in the region that produced them, and the pool's
 *   metrics are in the pool's region. Asking anywhere else returns an empty
 *   answer rather than an error, which is the worst possible failure mode, so
 *   the region comes from `./config.ts` and nothing else.
 * - **Credentials come from the SDK's default provider chain** — the ECS task
 *   role on Fargate, a profile or the `AWS_*` variables locally — exactly as
 *   the Cognito client does it. Nothing here reads, holds or logs a
 *   credential.
 * - **`AWS/Cognito` is published per app client, never for the pool alone.**
 *   Every series in the namespace carries **both** the `UserPool` and the
 *   `UserPoolClient` dimension, so a `MetricStat` naming `UserPool` on its
 *   own matches no series at all and answers with an empty set — the failure
 *   mode that reads as "nobody signed in". The queries below are therefore
 *   metric-math `SEARCH()` expressions over `{AWS/Cognito,UserPool,
 *   UserPoolClient}` filtered by this pool, wrapped in `SUM()` so the pool's
 *   app clients are added together into the one pool-level series a
 *   "sign-ins per day" figure means. An app client added later is picked up
 *   with no code change.
 * - **`SEARCH` needs no extra permission.** The expression is evaluated
 *   inside `GetMetricData`, so `cloudwatch:GetMetricData` is the whole
 *   requirement — and since 2026-09-12 the only CloudWatch action
 *   `infra/service-admin.yaml` grants: `cloudwatch:ListMetrics` was removed
 *   because nothing on this path, or any other, ever called it.
 * - **`Sum` is successes and `SampleCount` is attempts.** Cognito publishes
 *   one datum per call with a value of 1 for a success, so the sum over a day
 *   is the successes and the sample count is everything that was tried, and
 *   the difference is the failures. That holds per app client, so it holds for
 *   the `SUM(SEARCH(…))` over all of them just as well.
 * - **A day is 86 400 seconds at UTC midnight**, which is the same day
 *   `admin_pool_metrics_daily.day` and every other daily figure in the
 *   console is measured in.
 * - **One request, several metrics.** `GetMetricData` takes up to 500 metric
 *   queries at once, so a night's whole fetch is one call.
 * - **Silence is reported, never assumed.** A query that came back with no
 *   data point, a `StatusCode` other than `Complete`, and anything in
 *   `Messages` are all handed back to the caller, which decides whether an
 *   empty answer means an idle pool or a query that matched nothing — see
 *   `src/lib/integrations/jobs/cognito-directory.ts`.
 *
 * One client per process: a client is a connection pool and a credential
 * cache, and the only caller is a job that runs once a night.
 */
import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from "@aws-sdk/client-cloudwatch";
import { getCustomerCognitoConfig } from "./config";

/** The namespace Cognito publishes user-pool metrics to. */
const NAMESPACE = "AWS/Cognito";

/**
 * The dimension set every `AWS/Cognito` series carries. Both names, in this
 * order, are what a search has to match: the metrics are published per app
 * client, so there is no pool-only series to ask for.
 */
const DIMENSIONS = "UserPool,UserPoolClient";

/** One UTC day, in seconds. The period every query here uses. */
const DAY_SECONDS = 86_400;

/**
 * `GetMetricData` caps a response page at 100 800 data points; a page token
 * is still possible for a long window with many metrics, so paging is
 * implemented, with a cap so a bad answer cannot spin.
 */
const MAX_PAGES = 10;

/** One day's counters, as the job writes them. */
export interface PoolMetricsRow {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  signIns: number;
  signInAttempts: number;
  signUps: number;
  tokenRefreshes: number;
  throttles: number;
}

export interface PoolMetricsFetch {
  rows: PoolMetricsRow[];
  /** `GetMetricData` requests spent. Free, but worth recording in the run. */
  requests: number;
  /**
   * Queries CloudWatch answered with no data point at all, as
   * `MetricName/Stat`. One or two empty is the normal answer for a quiet pool
   * (nothing signed up, nothing was throttled); **all** of them empty is the
   * signal that the search matched nothing, which the caller weighs against
   * the pool's own account count rather than deciding here.
   */
  unanswered: string[];
  /** True when every query came back empty across the whole window. */
  allEmpty: boolean;
  /**
   * Queries whose `StatusCode` was not `Complete`, as
   * `MetricName/Stat: StatusCode`. Read after paging, so `PartialData` here
   * means the expression itself could not be completed — not "there is
   * another page".
   */
  incomplete: string[];
  /** Whatever CloudWatch said about the request or a query, verbatim. */
  messages: string[];
  /** True when {@link MAX_PAGES} stopped the read while a page token remained. */
  truncated: boolean;
}

let client: CloudWatchClient | null = null;
let clientRegion: string | null = null;

function cloudWatchClient(region: string): CloudWatchClient {
  if (client === null || clientRegion !== region) {
    client = new CloudWatchClient({ region });
    clientRegion = region;
  }
  return client;
}

/**
 * The metrics fetched, and which column each lands in.
 *
 * `id` is the `GetMetricData` query id, which must match `^[a-z][a-zA-Z0-9_]*$`
 * — hence the lower-case first letter. `stat` is the statistic; the pair
 * (`SignInSuccesses`, `Sum`) and (`SignInSuccesses`, `SampleCount`) is how
 * successes and attempts are told apart.
 */
const QUERIES = [
  { id: "signIns", metric: "SignInSuccesses", stat: "Sum", column: "signIns" },
  { id: "signInAttempts", metric: "SignInSuccesses", stat: "SampleCount", column: "signInAttempts" },
  { id: "signUps", metric: "SignUpSuccesses", stat: "Sum", column: "signUps" },
  { id: "tokenRefreshes", metric: "TokenRefreshSuccesses", stat: "Sum", column: "tokenRefreshes" },
  { id: "throttles", metric: "SignInThrottles", stat: "Sum", column: "throttles" },
] as const satisfies readonly {
  id: string;
  metric: string;
  stat: string;
  column: keyof Omit<PoolMetricsRow, "day">;
}[];

/** The UTC calendar day a timestamp falls in. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The pool id, checked to be safe inside a search expression.
 *
 * A Cognito pool id is `<region>_<alphanumerics>` and nothing else, so a
 * value outside that alphabet is a misconfiguration rather than something to
 * escape: a quote or a brace in it would change what the expression *means*,
 * and an expression whose meaning depends on an environment variable is not
 * one this job should send. The check is spelled out so the failure names the
 * variable an operator has to fix.
 *
 * @throws {Error} when `CUSTOMER_COGNITO_USER_POOL_ID` is not shaped like a
 * pool id.
 */
function searchSafePoolId(userPoolId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(userPoolId)) {
    throw new Error(
      "CUSTOMER_COGNITO_USER_POOL_ID does not look like a Cognito user pool id " +
        "(letters, digits, underscore and dash only), so the CloudWatch search " +
        "expression cannot be built from it.",
    );
  }
  return userPoolId;
}

/**
 * The metric-math expression for one (metric, stat) pair.
 *
 * `SEARCH` returns one time series per matching app client and `SUM` adds
 * them at each timestamp, which is the pool-level figure. The third `SEARCH`
 * argument is the period, so the series arrive already bucketed by UTC day.
 *
 * Exported so the expression can be read — and pasted into the CloudWatch
 * console — without running the job.
 */
export function poolMetricSearchExpression(
  userPoolId: string,
  metric: string,
  stat: string,
): string {
  const poolId = searchSafePoolId(userPoolId);
  return (
    `SUM(SEARCH('{${NAMESPACE},${DIMENSIONS}} MetricName="${metric}" ` +
    `UserPool="${poolId}"', '${stat}', ${DAY_SECONDS}))`
  );
}

/**
 * Reads the pool's counters for `[from, to]` inclusive, both UTC days.
 *
 * The window is turned into `StartTime` at 00:00 UTC of `from` and `EndTime`
 * at 00:00 UTC of the day **after** `to`, because CloudWatch's end is
 * exclusive — the same convention Cost Explorer uses and the same reason the
 * cost calendar bakes it in.
 *
 * A day CloudWatch has no datum for is simply absent from the result: the
 * pool was not used, and a zero row would be indistinguishable from one. The
 * caller upserts what it gets and leaves the rest alone.
 *
 * @throws whatever the SDK throws. The job classifies it: a missing
 * `cloudwatch:GetMetricData` permission is worth an operator's attention, but
 * it must not lose the snapshot the same run already wrote.
 */
export async function fetchPoolMetrics(from: string, to: string): Promise<PoolMetricsFetch> {
  const config = getCustomerCognitoConfig();
  const cw = cloudWatchClient(config.region);

  const metricDataQueries: MetricDataQuery[] = QUERIES.map((query) => ({
    Id: query.id,
    // A metric-math search, not a `MetricStat`: see the note at the top of
    // this file about the `UserPoolClient` dimension. `Period` at the query
    // level matches the period inside the `SEARCH`, which is how the
    // CloudWatch console writes the same query.
    Expression: poolMetricSearchExpression(config.userPoolId, query.metric, query.stat),
    Period: DAY_SECONDS,
    ReturnData: true,
  }));

  const startTime = new Date(`${from}T00:00:00.000Z`);
  const endExclusive = new Date(`${to}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

  const results = new Map<string, MetricDataResult>();
  const messages = new Set<string>();
  let nextToken: string | undefined;
  let requests = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await cw.send(
      new GetMetricDataCommand({
        MetricDataQueries: metricDataQueries,
        StartTime: startTime,
        EndTime: endExclusive,
        // Oldest first, so the rows arrive in the order the page draws them.
        ScanBy: "TimestampAscending",
        NextToken: nextToken,
      }),
    );
    requests += 1;
    // Request-level complaints — an expression CloudWatch dislikes, a window
    // it trimmed — never arrive as an exception, so a run that ignored them
    // would report success over an answer AWS had reservations about.
    for (const message of response.Messages ?? []) {
      const text = [message.Code, message.Value].filter(Boolean).join(": ");
      if (text !== "") messages.add(text);
    }
    for (const result of response.MetricDataResults ?? []) {
      if (result.Id === undefined) continue;
      for (const message of result.Messages ?? []) {
        const text = [message.Code, message.Value].filter(Boolean).join(": ");
        if (text !== "") messages.add(`${result.Id}: ${text}`);
      }
      const existing = results.get(result.Id);
      if (existing === undefined) {
        results.set(result.Id, result);
      } else {
        // A paged answer continues the same series; concatenate rather than
        // replace, or the earlier page's days would be lost. The status comes
        // from the newest page, because `PartialData` on an earlier one only
        // meant "there is more to come".
        existing.Timestamps = [...(existing.Timestamps ?? []), ...(result.Timestamps ?? [])];
        existing.Values = [...(existing.Values ?? []), ...(result.Values ?? [])];
        existing.StatusCode = result.StatusCode;
      }
    }
    nextToken = response.NextToken;
    if (nextToken === undefined) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  /* Days are assembled from whichever series mentioned them, so a day with
     sign-ins but no refreshes still gets a row (with 0 refreshes). */
  const byDay = new Map<string, PoolMetricsRow>();
  const unanswered: string[] = [];
  const incomplete: string[] = [];

  for (const query of QUERIES) {
    const label = `${query.metric}/${query.stat}`;
    const result = results.get(query.id);
    if (result === undefined) {
      // No result object at all: CloudWatch did not answer this query.
      unanswered.push(label);
      continue;
    }
    if (result.StatusCode !== undefined && result.StatusCode !== "Complete") {
      incomplete.push(`${label}: ${result.StatusCode}`);
    }
    const timestamps = result.Timestamps ?? [];
    const values = result.Values ?? [];
    // An answered query with no data point is either an idle pool or a search
    // that matched nothing. Which one cannot be decided here, so it is
    // reported and the caller weighs it against the pool's account count.
    if (values.length === 0) unanswered.push(label);
    for (let index = 0; index < timestamps.length; index += 1) {
      const at = timestamps[index];
      const value = values[index];
      if (at === undefined || typeof value !== "number" || !Number.isFinite(value)) continue;
      const day = utcDay(at);
      const row =
        byDay.get(day) ??
        ({
          day,
          signIns: 0,
          signInAttempts: 0,
          signUps: 0,
          tokenRefreshes: 0,
          throttles: 0,
        } satisfies PoolMetricsRow);
      // Counters, so rounding is the honest conversion: CloudWatch answers a
      // Sum of counts as a float.
      row[query.column] = Math.round(value);
      byDay.set(day, row);
    }
  }

  return {
    rows: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    requests,
    unanswered,
    allEmpty: unanswered.length === QUERIES.length,
    incomplete,
    messages: [...messages],
    truncated,
  };
}
