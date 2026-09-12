/**
 * The Operations and Deployments model, as the Overview draws it.
 *
 * Plain data and pure functions: no AWS SDK, no Prisma, no React. Safe to
 * import from a Client Component as well as from the server code that fills
 * these shapes in (`./metrics.ts`, `./deploy.ts`).
 *
 * Two conventions the cards depend on:
 *
 * - **A metric is always present, its value is not.** Every row the card can
 *   draw exists in the answer, carrying a `state` that says why it has no
 *   number: `unconfigured` (the environment does not name the resource),
 *   `unanswered` (CloudWatch knows no such metric, which for a young
 *   deployment is normal), or `failed` (the call itself failed). A row that
 *   vanished when a variable was unset would make "nothing is wrong" and
 *   "nothing was measured" look the same.
 * - **Thresholds live here, once.** The server decides the status, the card
 *   only paints it, so the page and any future alert cannot disagree about
 *   what "warn" means.
 */

/* -------------------------------------------------------------------------- */
/*                                  Metrics                                   */
/* -------------------------------------------------------------------------- */

/** What the number means, which decides how it is formatted and compared. */
export type MetricUnit = "bytes" | "count" | "percent" | "seconds";

/** Which AWS resource a row is about; the card groups rows by this. */
export type MetricGroup = "rds" | "ecs" | "alb" | "waf";

/**
 * Whether the row has a number, and what to make of it.
 *
 * `info` is a measurement with no opinion attached — request count, blocked
 * requests — and is painted neutrally. `ok`, `warn` and `critical` come from
 * {@link METRIC_THRESHOLDS}.
 */
export type MetricState = "ok" | "warn" | "critical" | "info" | "unconfigured" | "unanswered" | "failed";

/** One row of the Operations card. */
export interface OpsMetric {
  /** Stable identifier, e.g. `rds.connections` or `ecs.cpu:fairsums-web-stage`. */
  key: string;
  group: MetricGroup;
  /** Row label, e.g. "Free storage". */
  label: string;
  /** What the row is about when the group has more than one subject (a service name). */
  scope: string | null;
  unit: MetricUnit;
  /** The newest hour with a datum; null when there is none. */
  latest: number | null;
  /** The window's sum, for a counter; null for a gauge. */
  total: number | null;
  /** One slot per hour in the window, oldest first; null where nothing was published. */
  points: (number | null)[];
  state: MetricState;
  /** Why a row has no number, or what the threshold was — shown as small print. */
  note: string | null;
}

/** What `getOperationsMetrics()` answers with. */
export interface OpsMetrics {
  metrics: OpsMetric[];
  /** The region the metrics were read from; null when none is configured. */
  region: string | null;
  /** Hours the series covers. */
  windowHours: number;
  /** The period of one slot, in seconds. */
  periodSeconds: number;
  /** ISO; when the cached answer was fetched, not when it was served. */
  fetchedAt: string;
  /**
   * The whole `GetMetricData` call failed (no credentials, a denied action).
   * Every row is then `failed` and the card shows this sentence.
   */
  error: string | null;
  /** `GetMetricData` requests spent. Free, but worth saying. */
  requests: number;
}

/* -------------------------------------------------------------------------- */
/*                                 Thresholds                                 */
/* -------------------------------------------------------------------------- */

/** One metric's opinion about its own value. */
export interface MetricThreshold {
  /** `above`: bigger is worse. `below`: smaller is worse. `none`: no opinion. */
  direction: "above" | "below" | "none";
  warn?: number;
  critical?: number;
  /** Which figure is judged: the newest hour, or the window's total. */
  basis: "latest" | "total";
  /** The sentence the card prints under a row that is not `ok`. */
  note: string;
}

/** A gibibyte, the unit RDS free storage is worth reading in. */
const GIB = 1024 ** 3;

/**
 * Where each row turns amber, and why.
 *
 * The connection ceiling is arithmetic rather than taste, and the arithmetic
 * has to include a deploy. `DATABASE_POOL_MAX` is 5 in both task definitions
 * and the admin container builds **two** pool clients (main and admin
 * database), so the steady-state ceiling is 2 × 5 for the admin task plus 5
 * for the web task — fifteen. Measured on 2026-09-12 the stage instance peaks
 * at **19 with both apps close to idle**, which is already over that: pgAdmin,
 * the scheduler's own work and whatever else holds a session account for the
 * rest.
 *
 * And a **rolling deployment doubles every pool**: ECS starts the new task and
 * drains the old one, so for a minute or two both are connected and the
 * fifteen becomes thirty. A threshold below that would paint the card amber
 * on every single deploy, and a card that is amber every deploy is a card
 * nobody reads.
 *
 * So: **warn at 35**, which is above a rolling deploy of both services and
 * therefore means something beyond our own pools is holding connections (a
 * second environment on the instance, a pgAdmin session left open, a pool
 * that is not releasing); **critical at 60**, which is approaching the
 * roughly 85 a `db.t4g.micro` allows. Change the constants, not the card, if
 * the pool sizes or the instance class change — and re-measure, the way these
 * numbers were arrived at. Today's measurement is recorded in
 * `docs/overview.md`.
 */
export const METRIC_THRESHOLDS = {
  "rds.storage": {
    direction: "below",
    warn: 2 * GIB,
    critical: 1 * GIB,
    basis: "latest",
    note: "Warn below 2 GiB, critical below 1 GiB. RDS storage does not grow on its own unless autoscaling is on.",
  },
  "rds.connections": {
    direction: "above",
    warn: 35,
    critical: 60,
    basis: "latest",
    note: "Warn at 35, critical at 60. Our own pools hold 15 in steady state (DATABASE_POOL_MAX of 5: two pools in the admin task, one in the web task) and up to 30 during a rolling deploy, when the old and new tasks are both connected; the stage instance peaks at 19 near-idle. Beyond 35 something else is holding connections; a db.t4g.micro allows about 85.",
  },
  "rds.cpu": {
    direction: "above",
    warn: 80,
    critical: 95,
    basis: "latest",
    note: "Warn above 80%.",
  },
  "ecs.cpu": {
    direction: "above",
    warn: 80,
    critical: 95,
    basis: "latest",
    note: "Warn above 80% of the task's reserved CPU.",
  },
  "ecs.memory": {
    direction: "above",
    warn: 80,
    critical: 95,
    basis: "latest",
    note: "Warn above 80% of the task's reserved memory; a Node container that reaches 100% is killed.",
  },
  "alb.5xx": {
    direction: "above",
    warn: 1,
    critical: 25,
    basis: "total",
    note: "Any target 5xx in the last 24 hours is worth a look.",
  },
  "alb.latency": {
    direction: "above",
    warn: 1,
    critical: 3,
    basis: "latest",
    note: "Warn above 1 second of average target response time.",
  },
  "alb.requests": { direction: "none", basis: "total", note: "" },
  "waf.blocked": { direction: "none", basis: "total", note: "" },
} as const satisfies Record<string, MetricThreshold>;

/** The threshold keys; a metric's `key` starts with one of them. */
export type MetricThresholdKey = keyof typeof METRIC_THRESHOLDS;

/** The threshold for a metric key (`ecs.cpu:fairsums-web-stage` → `ecs.cpu`). */
export function thresholdFor(key: string): MetricThreshold | null {
  const base = key.split(":")[0] as MetricThresholdKey;
  return METRIC_THRESHOLDS[base] ?? null;
}

/**
 * The state a measured row deserves.
 *
 * A metric with no threshold, or one whose basis has no number, is `info`:
 * the measurement stands, nothing is claimed about it.
 */
export function stateFor(key: string, latest: number | null, total: number | null): MetricState {
  const threshold = thresholdFor(key);
  if (threshold === null || threshold.direction === "none") return "info";
  const subject = threshold.basis === "total" ? total : latest;
  if (subject === null) return "info";
  const { direction, warn, critical } = threshold;
  const breached = (limit: number | undefined): boolean =>
    limit !== undefined && (direction === "above" ? subject >= limit : subject < limit);
  if (breached(critical)) return "critical";
  if (breached(warn)) return "warn";
  return "ok";
}

/* -------------------------------------------------------------------------- */
/*                                 Formatting                                 */
/* -------------------------------------------------------------------------- */

/** `2.4 GiB` — binary units, because that is how RDS reports storage. */
function formatGib(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = Math.abs(bytes);
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${(bytes < 0 ? -scaled : scaled).toFixed(digits)} ${units[unit]}`;
}

/** A metric value in its own unit, or `—` when there is none. */
export function formatMetric(value: number | null, unit: MetricUnit): string {
  if (value === null || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "bytes":
      return formatGib(value);
    case "percent":
      return `${value.toFixed(value < 10 ? 1 : 0)}%`;
    case "seconds":
      return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`;
    case "count":
      return Math.round(value).toLocaleString("en-US");
  }
}

/* -------------------------------------------------------------------------- */
/*                              Deployment health                             */
/* -------------------------------------------------------------------------- */

/** One ECS service, as `DescribeServices` last saw it. */
export interface DeployService {
  /** The service name as configured, so a service ECS did not answer for still has a row. */
  name: string;
  /** `ACTIVE`, `DRAINING`, … or null when ECS said nothing. */
  status: string | null;
  desired: number | null;
  running: number | null;
  pending: number | null;
  /** `family:revision`. The image tag is not in this answer — see `IMAGE_TAG_NOTE`. */
  taskDefinition: string | null;
  /** `COMPLETED`, `IN_PROGRESS`, `FAILED`, or null for a service ECS reports without one. */
  rolloutState: string | null;
  rolloutStateReason: string | null;
  /** When the primary deployment last changed, ISO. */
  updatedAt: string | null;
  /** The newest service event's message, which is where a failing deploy explains itself. */
  lastEvent: { at: string | null; message: string } | null;
  /** Why this row has no figures: ECS did not return the service, or it failed. */
  error: string | null;
}

export interface DeployHealth {
  cluster: string | null;
  services: DeployService[];
  /** ISO; when the cached answer was fetched. */
  fetchedAt: string;
  /** The whole call failed; every row carries the same reason. */
  error: string | null;
}

/**
 * Why the card names a task definition revision and not an image tag.
 *
 * The tag is inside the task definition's container definitions, which needs
 * `ecs:DescribeTaskDefinition`. The task role is not granted it
 * (`infra/service-admin.yaml` allows `ecs:DescribeServices` only), so the
 * revision is as far as this card can honestly go. The deploy workflow stamps
 * the commit SHA into `BUILD_ID`, so "which commit is this" is answerable from
 * the deployment log in the meantime.
 */
export const IMAGE_TAG_NOTE =
  "Image tags need ecs:DescribeTaskDefinition, which this task role is not granted; " +
  "the task definition revision identifies the build instead.";

/* -------------------------------------------------------------------------- */
/*                        One card's data, or the reason                      */
/* -------------------------------------------------------------------------- */

/**
 * What one Overview card was handed: the data, or the sentence to print
 * instead of it.
 *
 * The page loads every card's data with `Promise.allSettled`, so one source
 * being down — the admin database, the main database, AWS — costs exactly one
 * card. Nothing on the Overview throws.
 *
 * `reason` is what the card **prints**, and it is not always the error's own
 * message: see {@link loadedFrom} and {@link LoadSource}. An AWS failure says
 * what AWS said; a database failure says which database could not be read,
 * and the detail goes to the server log.
 */
export type Loaded<T> = { ok: true; data: T } | { ok: false; reason: string };

/** The longest reason a card will print; an ORM error can be a paragraph. */
const REASON_MAX = 240;

/**
 * Where a card's data came from, which decides what a failure is *called*.
 *
 * - `aws` — the reason is AWS's own sentence, printed verbatim. That is the
 *   sentence that ends the investigation: `Could not load credentials from
 *   any providers`, an `AccessDenied` naming the action.
 * - `admin-db` / `main-db` / `both-db` — the reason is one flat sentence
 *   naming the database. A Prisma failure's own message is a paragraph of
 *   connection string, model name and Rust panic text: useful in a log, not
 *   on a dashboard, and it is the one class of message that can carry a
 *   fragment of infrastructure detail to the screen. The detail is logged
 *   server-side instead, with the read's name.
 */
export type LoadSource = "aws" | "admin-db" | "main-db" | "both-db";

/** What a card's read is called in a log line, and where it read from. */
export interface LoadContext {
  /** The read, for the server-side log: "cost summary", "customer headline". */
  what: string;
  source: LoadSource;
}

/** The sentence a failed database read is reported as, per source. */
const DATABASE_REASON: Record<Exclude<LoadSource, "aws">, string> = {
  "admin-db": "The admin database could not be read.",
  "main-db": "The main database could not be read.",
  // Two cards read both, and nothing in a rejected promise says which of the
  // two refused. Naming one of them would be a guess printed as a fact.
  "both-db": "The admin or the main database could not be read.",
};

/** An error's own sentence, however it was thrown. */
function messageOf(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim() !== "") return reason.message.trim();
  if (typeof reason === "string" && reason.trim() !== "") return reason.trim();
  return "The read failed without a message.";
}

/**
 * A rejected settled result as something a card can show.
 *
 * With a {@link LoadContext} the failure is also logged with an `[overview]`
 * prefix — the whole message, server-side, where an operator debugging it can
 * read it — and a database failure is rendered as the flat sentence for its
 * source rather than as the ORM's own paragraph. Without a context (a caller
 * outside the Overview) the behaviour is unchanged: the error's own message,
 * trimmed.
 */
export function loadedFrom<T>(
  result: PromiseSettledResult<T>,
  context?: LoadContext,
): Loaded<T> {
  if (result.status === "fulfilled") return { ok: true, data: result.value };
  const detail = messageOf(result.reason);

  if (context !== undefined) {
    console.error(`[overview] ${context.what} (${context.source}) failed:`, detail);
    if (context.source !== "aws") return { ok: false, reason: DATABASE_REASON[context.source] };
  }

  return {
    ok: false,
    reason: detail.length > REASON_MAX ? `${detail.slice(0, REASON_MAX)}…` : detail,
  };
}
