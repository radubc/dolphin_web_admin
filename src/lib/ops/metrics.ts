import "server-only";
/**
 * The Overview's Operations card: the last 24 hours of the metrics that say
 * whether the deployment is healthy, in **one** `cloudwatch:GetMetricData`
 * call, cached for a minute.
 *
 * What is asked for, and why each one:
 *
 * | Namespace | Metric | Statistic | Reads |
 * | --- | --- | --- | --- |
 * | `AWS/RDS` | `FreeStorageSpace` | Minimum | the instance fills up silently; storage does not grow unless autoscaling is on |
 * | `AWS/RDS` | `DatabaseConnections` | Maximum | `DATABASE_POOL_MAX` is 5 per client, so headroom is small and worth watching |
 * | `AWS/RDS` | `CPUUtilization` | Average | a saturated `t4g.micro` shows up here first |
 * | `AWS/ECS` | `CPUUtilization`, `MemoryUtilization` | Average, per service | a Node container that reaches 100% memory is killed |
 * | `AWS/ApplicationELB` | `HTTPCode_Target_5XX_Count`, `RequestCount` | Sum | errors the app returned, and the traffic to read them against |
 * | `AWS/ApplicationELB` | `TargetResponseTime` | Average | the number a user feels |
 * | `AWS/WAFV2` | `BlockedRequests` (`Rule=ALL`) | Sum | the admin host's allowlist doing its job |
 *
 * Conventions, all of them deliberate:
 *
 * - **One call.** `GetMetricData` takes up to 500 metric queries at once, so
 *   every row above is one request. `ListMetrics` is not used: it omits
 *   metrics that have been quiet for a fortnight — exactly the ones a young
 *   deployment has — while `GetMetricData` answers for a metric that has
 *   never been published with an empty series, which is the right answer and
 *   costs nothing to ask for.
 * - **The region is the metrics' region** (`./config.ts`), never `us-east-1`.
 *   Asking the wrong region returns an empty series rather than an error,
 *   which is the worst failure mode there is, so a deployment with no region
 *   configured asks nothing at all.
 * - **24 hourly slots, the last one partial.** The window starts at the top
 *   of the hour 23 hours ago and ends now, so the newest slot is however much
 *   of this hour has happened. For a gauge that is the freshest truth
 *   available; for a counter the 24-hour total is what the threshold judges,
 *   so a fractional slot cannot hide anything.
 * - **Nothing here throws.** A failed call comes back as
 *   `{ error: "<message>" }` with every row marked `failed`; the card prints
 *   the sentence. A page that 500s because CloudWatch was unreachable would
 *   be a worse outage than the one it is reporting.
 */
import {
  CloudWatchClient,
  GetMetricDataCommand,
  type Dimension,
  type MetricDataQuery,
  type MetricDataResult,
} from "@aws-sdk/client-cloudwatch";
import { memoiseFor, OPS_CACHE_TTL_MS, OPS_CLIENT_TIMEOUTS } from "./cache";
import { getOpsConfig, notConfigured, OPS_ENV_NAMES, type OpsConfig } from "./config";
import { stateFor, type MetricGroup, type MetricUnit, type OpsMetric, type OpsMetrics } from "./types";

/** Hours of history the card draws. */
export const OPS_WINDOW_HOURS = 24;

/** One slot, in seconds. An hour is the finest resolution free metrics keep for a day. */
export const OPS_PERIOD_SECONDS = 3600;

/**
 * `GetMetricData` caps a response page at 100 800 data points, far above the
 * couple of hundred asked for here, but a page token is answered anyway —
 * with a cap, so a strange answer cannot spin.
 */
const MAX_PAGES = 3;

const HOUR_MS = OPS_PERIOD_SECONDS * 1000;

/* -------------------------------------------------------------------------- */
/*                                   Client                                   */
/* -------------------------------------------------------------------------- */

/**
 * One client per region per process: a client is a connection pool and a
 * credential cache, and credentials come from the SDK's default provider
 * chain (the ECS task role on Fargate, a profile locally). Nothing here reads,
 * holds or logs a credential.
 *
 * Built with {@link OPS_CLIENT_TIMEOUTS}: this call is made while a server
 * render is waiting, so a socket that hangs has to give up on its own rather
 * than hold the page open.
 */
let client: CloudWatchClient | null = null;
let clientRegion: string | null = null;

function cloudWatch(region: string): CloudWatchClient {
  if (client === null || clientRegion !== region) {
    client = new CloudWatchClient({ region, ...OPS_CLIENT_TIMEOUTS });
    clientRegion = region;
  }
  return client;
}

/** An error's own sentence, or a generic one. Never a stack, never a credential. */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message.trim();
  return "The CloudWatch call failed without a message.";
}

/* -------------------------------------------------------------------------- */
/*                                 The queries                                */
/* -------------------------------------------------------------------------- */

/**
 * One row of the card, and the CloudWatch question behind it.
 *
 * `dimensions` is `null` when the environment does not name the resource: the
 * row still exists, so "we are not watching this" is visible instead of
 * absent, and `note` says which variable to set.
 */
interface Plan {
  key: string;
  group: MetricGroup;
  label: string;
  scope: string | null;
  unit: MetricUnit;
  namespace: string;
  metricName: string;
  stat: string;
  /** True when the window's sum is the meaningful figure (a counter, not a gauge). */
  counter: boolean;
  dimensions: Dimension[] | null;
  note: string | null;
}

/** The rows the card draws, in order, whether or not they can be asked about. */
function planRows(config: OpsConfig): Plan[] {
  // No region means no question can be asked of any namespace: say so on
  // every row rather than reading an empty series from the wrong region.
  const regionMissing =
    config.region === null ? notConfigured(`${OPS_ENV_NAMES.region} or AWS_REGION`) : null;

  const dimensionsOr = (
    available: boolean,
    dimensions: Dimension[],
    missing: string,
  ): Pick<Plan, "dimensions" | "note"> => {
    if (regionMissing !== null) return { dimensions: null, note: regionMissing };
    if (!available) return { dimensions: null, note: missing };
    return { dimensions, note: null };
  };

  const rds = dimensionsOr(
    config.rdsInstanceId !== null,
    [{ Name: "DBInstanceIdentifier", Value: config.rdsInstanceId ?? "" }],
    notConfigured(OPS_ENV_NAMES.rdsInstanceId),
  );

  const alb = dimensionsOr(
    config.albArnSuffix !== null,
    [{ Name: "LoadBalancer", Value: config.albArnSuffix ?? "" }],
    notConfigured(OPS_ENV_NAMES.albArnSuffix),
  );

  const waf = dimensionsOr(
    config.wafWebAclName !== null && config.region !== null,
    [
      { Name: "WebACL", Value: config.wafWebAclName ?? "" },
      { Name: "Region", Value: config.region ?? "" },
      // The whole ACL rather than one rule. `ALL` is the aggregate dimension
      // WAF publishes alongside the per-rule series.
      { Name: "Rule", Value: "ALL" },
    ],
    notConfigured(OPS_ENV_NAMES.wafWebAclName),
  );

  const rows: Plan[] = [
    {
      key: "rds.storage",
      group: "rds",
      label: "Free storage",
      scope: config.rdsInstanceId,
      unit: "bytes",
      namespace: "AWS/RDS",
      metricName: "FreeStorageSpace",
      // The low-water mark of the hour: the worst moment is the one that
      // matters for a disk that cannot grow.
      stat: "Minimum",
      counter: false,
      ...rds,
    },
    {
      key: "rds.connections",
      group: "rds",
      label: "Connections",
      scope: config.rdsInstanceId,
      unit: "count",
      namespace: "AWS/RDS",
      metricName: "DatabaseConnections",
      // The peak, for the same reason: an average hides the minute the pools
      // were all busy at once.
      stat: "Maximum",
      counter: false,
      ...rds,
    },
    {
      key: "rds.cpu",
      group: "rds",
      label: "CPU",
      scope: config.rdsInstanceId,
      unit: "percent",
      namespace: "AWS/RDS",
      metricName: "CPUUtilization",
      stat: "Average",
      counter: false,
      ...rds,
    },
  ];

  /* ECS: two rows per configured service. A cluster with no service list, or
     a service list with no cluster, can ask nothing — both dimensions are
     required — so one "not configured" row per metric stands in. */
  const ecsReady = config.ecsCluster !== null && config.ecsServices.length > 0;
  const ecsMissing = notConfigured(OPS_ENV_NAMES.ecsCluster, OPS_ENV_NAMES.ecsServices);
  const ecsMetrics = [
    { key: "ecs.cpu", label: "CPU", metricName: "CPUUtilization" },
    { key: "ecs.memory", label: "Memory", metricName: "MemoryUtilization" },
  ] as const;

  for (const metric of ecsMetrics) {
    if (!ecsReady) {
      rows.push({
        key: metric.key,
        group: "ecs",
        label: metric.label,
        scope: null,
        unit: "percent",
        namespace: "AWS/ECS",
        metricName: metric.metricName,
        stat: "Average",
        counter: false,
        dimensions: null,
        note: regionMissing ?? ecsMissing,
      });
      continue;
    }
    for (const service of config.ecsServices) {
      rows.push({
        key: `${metric.key}:${service}`,
        group: "ecs",
        label: metric.label,
        scope: service,
        unit: "percent",
        namespace: "AWS/ECS",
        metricName: metric.metricName,
        stat: "Average",
        counter: false,
        ...dimensionsOr(
          true,
          [
            { Name: "ClusterName", Value: config.ecsCluster ?? "" },
            { Name: "ServiceName", Value: service },
          ],
          ecsMissing,
        ),
      });
    }
  }

  rows.push(
    {
      key: "alb.5xx",
      group: "alb",
      label: "Target 5xx",
      scope: null,
      unit: "count",
      namespace: "AWS/ApplicationELB",
      metricName: "HTTPCode_Target_5XX_Count",
      stat: "Sum",
      counter: true,
      ...alb,
    },
    {
      key: "alb.requests",
      group: "alb",
      label: "Requests",
      scope: null,
      unit: "count",
      namespace: "AWS/ApplicationELB",
      metricName: "RequestCount",
      stat: "Sum",
      counter: true,
      ...alb,
    },
    {
      key: "alb.latency",
      group: "alb",
      label: "Response time",
      scope: null,
      unit: "seconds",
      namespace: "AWS/ApplicationELB",
      metricName: "TargetResponseTime",
      stat: "Average",
      counter: false,
      ...alb,
    },
    {
      key: "waf.blocked",
      group: "waf",
      label: "Blocked requests",
      scope: config.wafWebAclName,
      unit: "count",
      namespace: "AWS/WAFV2",
      metricName: "BlockedRequests",
      stat: "Sum",
      counter: true,
      ...waf,
    },
  );

  return rows;
}

/* -------------------------------------------------------------------------- */
/*                                 The fetch                                  */
/* -------------------------------------------------------------------------- */

/** The window: the top of the hour 23 hours ago, to now. */
function windowFor(now: Date): { start: Date; end: Date } {
  const topOfHour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  return {
    start: new Date(topOfHour - (OPS_WINDOW_HOURS - 1) * HOUR_MS),
    end: now,
  };
}

/** The row a plan becomes when it could not be asked about. */
function blankRow(plan: Plan, state: OpsMetric["state"], note: string | null): OpsMetric {
  return {
    key: plan.key,
    group: plan.group,
    label: plan.label,
    scope: plan.scope,
    unit: plan.unit,
    latest: null,
    total: null,
    points: Array.from({ length: OPS_WINDOW_HOURS }, () => null),
    state,
    note,
  };
}

/** A series' values laid into the window's hourly slots, oldest first. */
function toSlots(result: MetricDataResult | undefined, start: Date): (number | null)[] {
  const points: (number | null)[] = Array.from({ length: OPS_WINDOW_HOURS }, () => null);
  if (result === undefined) return points;
  const timestamps = result.Timestamps ?? [];
  const values = result.Values ?? [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const at = timestamps[index];
    const value = values[index];
    if (at === undefined || typeof value !== "number" || !Number.isFinite(value)) continue;
    const slot = Math.floor((at.getTime() - start.getTime()) / HOUR_MS);
    if (slot < 0 || slot >= OPS_WINDOW_HOURS) continue;
    points[slot] = value;
  }
  return points;
}

/** The answer for a set of plans none of which can be asked about. */
function unaskable(plans: readonly Plan[], now: Date, region: string | null): OpsMetrics {
  return {
    metrics: plans.map((plan) => blankRow(plan, "unconfigured", plan.note)),
    region,
    windowHours: OPS_WINDOW_HOURS,
    periodSeconds: OPS_PERIOD_SECONDS,
    fetchedAt: now.toISOString(),
    error: null,
    requests: 0,
  };
}

/** The uncached read. `getOperationsMetrics` is the one callers should use. */
async function fetchOperationsMetrics(now: Date = new Date()): Promise<OpsMetrics> {
  const config = getOpsConfig();
  const plans = planRows(config);
  const askable = plans.filter((plan) => plan.dimensions !== null);

  if (config.region === null || askable.length === 0) {
    return unaskable(plans, now, config.region);
  }

  const { start, end } = windowFor(now);

  // `Id` must match /^[a-z][a-zA-Z0-9_]*$/, which no service or metric name
  // does, so the index is the id and this map takes the answers back.
  const idFor = new Map<string, string>();
  const queries: MetricDataQuery[] = askable.map((plan, index) => {
    const id = `m${index}`;
    idFor.set(plan.key, id);
    return {
      Id: id,
      MetricStat: {
        Metric: {
          Namespace: plan.namespace,
          MetricName: plan.metricName,
          Dimensions: plan.dimensions ?? [],
        },
        Period: OPS_PERIOD_SECONDS,
        Stat: plan.stat,
      },
      ReturnData: true,
    };
  });

  const results = new Map<string, MetricDataResult>();
  let requests = 0;

  try {
    const cw = cloudWatch(config.region);
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await cw.send(
        new GetMetricDataCommand({
          MetricDataQueries: queries,
          StartTime: start,
          EndTime: end,
          ScanBy: "TimestampAscending",
          NextToken: nextToken,
        }),
      );
      requests += 1;
      for (const result of response.MetricDataResults ?? []) {
        if (result.Id === undefined) continue;
        const existing = results.get(result.Id);
        if (existing === undefined) {
          results.set(result.Id, result);
        } else {
          // A paged answer continues the same series; concatenate, or the
          // earlier page's hours would be lost.
          existing.Timestamps = [...(existing.Timestamps ?? []), ...(result.Timestamps ?? [])];
          existing.Values = [...(existing.Values ?? []), ...(result.Values ?? [])];
        }
      }
      nextToken = response.NextToken;
      if (nextToken === undefined) break;
    }
  } catch (error) {
    const message = errorText(error);
    console.error("[ops] GetMetricData failed:", message);
    return {
      metrics: plans.map((plan) =>
        plan.dimensions === null
          ? blankRow(plan, "unconfigured", plan.note)
          : blankRow(plan, "failed", null),
      ),
      region: config.region,
      windowHours: OPS_WINDOW_HOURS,
      periodSeconds: OPS_PERIOD_SECONDS,
      fetchedAt: now.toISOString(),
      error: message,
      requests,
    };
  }

  const metrics = plans.map((plan): OpsMetric => {
    if (plan.dimensions === null) return blankRow(plan, "unconfigured", plan.note);

    const id = idFor.get(plan.key);
    const points = toSlots(id === undefined ? undefined : results.get(id), start);
    const measured = points.filter((point): point is number => point !== null);

    if (measured.length === 0) {
      return blankRow(
        plan,
        "unanswered",
        "Nothing published in the last 24 hours. Normal for a metric that has not happened.",
      );
    }

    const latest = measured[measured.length - 1];
    const total = plan.counter ? measured.reduce((sum, point) => sum + point, 0) : null;

    return {
      key: plan.key,
      group: plan.group,
      label: plan.label,
      scope: plan.scope,
      unit: plan.unit,
      latest,
      total,
      points,
      state: stateFor(plan.key, latest, total),
      note: null,
    };
  });

  return {
    metrics,
    region: config.region,
    windowHours: OPS_WINDOW_HOURS,
    periodSeconds: OPS_PERIOD_SECONDS,
    fetchedAt: now.toISOString(),
    error: null,
    requests,
  };
}

/**
 * The Operations card's data: one `GetMetricData` call per minute at most.
 *
 * Resolves whatever happens — see the module note — so a caller does not have
 * to guard it, though the Overview still wraps it in `Promise.allSettled`
 * with the rest.
 */
export const getOperationsMetrics = memoiseFor(OPS_CACHE_TTL_MS, () => fetchOperationsMetrics());
