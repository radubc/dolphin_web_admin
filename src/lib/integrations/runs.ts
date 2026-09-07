import "server-only";
/**
 * Integration **runs** (`admin_integration_runs` in the admin database) and
 * the in-process runner that executes them.
 *
 * This is the Constants jobs runner (`src/lib/constants/jobs.ts`) applied to
 * the integration tables, deliberately as a parallel implementation rather
 * than a shared abstraction: the two have different counters, different
 * keys and different lifetimes, and the Constants runner is not to be
 * touched. The behaviour it copies, and the reasons, are the same:
 *
 * - **In-process.** No queue, no worker, no cron beyond the 60 s scheduler
 *   tick in `./scheduler.ts`. Every batch commits on its own, so a run
 *   interrupted by a deploy loses nothing already written and can simply be
 *   started again.
 * - **Heartbeat.** A running run refreshes `heartbeat_at` between batches
 *   *and* on a `RUN_HEARTBEAT_INTERVAL_MS` timer, so a slow provider call
 *   never looks dead. A run is stale when it is `running` and its heartbeat
 *   (or `started_at`, before the first beat) is older than
 *   `RUN_STALE_AFTER_MS`, or when it is `queued` and `created_at` is that old
 *   — the process died between the insert and the run.
 * - **`interrupted` is derived.** The database stores only `queued`,
 *   `running`, `succeeded` and `failed`; a stale live row reads as
 *   `interrupted`, and the next run for that integration writes it off as
 *   `failed` with `error = RUN_INTERRUPTED`, which keeps reading back as
 *   `interrupted`. A run the API once called interrupted never turns into a
 *   plain failure later.
 * - **One live run per integration**, guarded twice: a module-level
 *   reservation (this process) and a check for a non-stale `queued` /
 *   `running` row (any process). A second request is a 409 naming the run.
 *
 * `admin_integration_runs` may not exist yet (`docs/sql/008_integrations.sql`
 * is run by hand). That error is never swallowed here, so `adminHandler`
 * renders it as 503 `admin_schema_missing`; the service endpoints and the
 * scheduler catch it themselves.
 */
import type { Prisma } from "@/generated/prisma-admin/client";
import { isMissingTableError } from "@/lib/admin-access/prisma-repository";
import { ConflictError } from "@/lib/api/errors";
import { prismaAdmin } from "@/lib/prisma-admin";
import {
  RUN_HEARTBEAT_INTERVAL_MS,
  RUN_STALE_AFTER_MS,
  type IntegrationKey,
  type IntegrationRun,
  type RunStatus,
  type RunTrigger,
} from "./types";

/** How long an error message may be before it is cut down for the run row. */
const ERROR_MAX = 1000;

/**
 * The sentinel `error` value a run row carries when it was written off as
 * abandoned. One spelling shared by the writer (`assertNoLiveRun`) and the
 * reader (`statusOf`).
 */
export const RUN_INTERRUPTED = "interrupted";

/* -------------------------------------------------------------------------- */
/*                                   Mapping                                  */
/* -------------------------------------------------------------------------- */

type RunRow = Prisma.admin_integration_runsGetPayload<object>;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

type StaleCheckRow = Pick<RunRow, "status" | "heartbeat_at" | "started_at" | "created_at">;

function isStale(row: StaleCheckRow): boolean {
  if (row.status === "running") {
    const beat = row.heartbeat_at ?? row.started_at ?? row.created_at;
    return Date.now() - beat.getTime() > RUN_STALE_AFTER_MS;
  }
  if (row.status === "queued") {
    return Date.now() - row.created_at.getTime() > RUN_STALE_AFTER_MS;
  }
  return false;
}

function statusOf(row: RunRow): RunStatus {
  if (row.status === "running" || row.status === "queued") {
    return isStale(row) ? "interrupted" : row.status;
  }
  if (row.status === "failed") return row.error === RUN_INTERRUPTED ? "interrupted" : "failed";
  if (row.status === "succeeded") return "succeeded";
  // A value the CHECK constraint forbids; never let an unknown string reach
  // the client as a status.
  return "failed";
}

function requestOf(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toRun(row: RunRow): IntegrationRun {
  return {
    id: row.id,
    integrationKey: row.integration_key as IntegrationKey,
    trigger: row.trigger as RunTrigger,
    status: statusOf(row),
    total: row.total,
    processed: row.processed,
    created: row.created,
    updated: row.updated,
    unchanged: row.unchanged,
    failed: row.failed,
    error: row.error === null ? null : row.error.slice(0, ERROR_MAX),
    request: requestOf(row.request),
    requestedBy: row.requested_by,
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    heartbeatAt: iso(row.heartbeat_at),
  };
}

/** The last line of an error, trimmed to what the `error` column should hold. */
export function messageOf(error: unknown): string {
  const raw =
    error instanceof Error
      ? (error.message.split("\n").filter((line) => line.trim() !== "").at(-1) ?? error.message)
      : String(error);
  return raw.trim().slice(0, ERROR_MAX);
}

/* -------------------------------------------------------------------------- */
/*                                    Reads                                   */
/* -------------------------------------------------------------------------- */

/** One run of one integration. `null` when the id is unknown or is another's. */
export async function getRun(key: IntegrationKey, runId: string): Promise<IntegrationRun | null> {
  const row = await prismaAdmin.admin_integration_runs.findFirst({
    where: { id: runId, integration_key: key },
  });
  return row ? toRun(row) : null;
}

/** The integration's most recent runs, newest first. */
export async function listRuns(key: IntegrationKey, limit: number): Promise<IntegrationRun[]> {
  const rows = await prismaAdmin.admin_integration_runs.findMany({
    where: { integration_key: key },
    orderBy: { created_at: "desc" },
    take: limit,
  });
  return rows.map(toRun);
}

/** The newest run of each named integration, for the list response. */
export async function latestRuns(
  keys: readonly IntegrationKey[],
): Promise<Map<IntegrationKey, IntegrationRun>> {
  const latest = new Map<IntegrationKey, IntegrationRun>();
  for (const key of keys) {
    const row = await prismaAdmin.admin_integration_runs.findFirst({
      where: { integration_key: key },
      orderBy: { created_at: "desc" },
    });
    if (row) latest.set(key, toRun(row));
  }
  return latest;
}

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

export interface CreateRunInput {
  integrationKey: IntegrationKey;
  trigger: RunTrigger;
  /** `admin_users.id` of the operator, or null for a scheduled/machine run. */
  requestedBy: string | null;
  /** The request as received (force, symbols asked for), kept for the record. */
  request: Prisma.InputJsonValue;
  /** Items the run expects to process, when it is known up front. */
  total?: number | null;
}

/** Inserts a `queued` run row. */
export async function createRun(input: CreateRunInput): Promise<IntegrationRun> {
  const row = await prismaAdmin.admin_integration_runs.create({
    data: {
      integration_key: input.integrationKey,
      trigger: input.trigger,
      status: "queued",
      total: input.total ?? null,
      request: input.request,
      requested_by: input.requestedBy,
    },
  });
  return toRun(row);
}

/** Counters a run reports as it goes; every field is an absolute total. */
export interface RunProgress {
  total?: number | null;
  processed?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  failed?: number;
}

/**
 * How work reports progress. One call per batch: each call is one `UPDATE`
 * that also refreshes `heartbeat_at`, which is what keeps the run from being
 * read as interrupted.
 */
export type ProgressReporter = (progress: RunProgress) => Promise<void>;

/** What a run does. It is handed the reporter and its own run id. */
export type RunWork = (progress: ProgressReporter, runId: string) => Promise<void>;

function progressData(progress: RunProgress): Prisma.admin_integration_runsUpdateInput {
  return {
    ...(progress.total === undefined ? {} : { total: progress.total }),
    ...(progress.processed === undefined ? {} : { processed: progress.processed }),
    ...(progress.created === undefined ? {} : { created: progress.created }),
    ...(progress.updated === undefined ? {} : { updated: progress.updated }),
    ...(progress.unchanged === undefined ? {} : { unchanged: progress.unchanged }),
    ...(progress.failed === undefined ? {} : { failed: progress.failed }),
    heartbeat_at: new Date(),
  };
}

/**
 * Stamps `last_run_at` (always) and `last_success_at` (only on success) on the
 * integration row. `updateMany` rather than `update` so a run whose
 * integration row vanished cannot throw out of the runner.
 */
async function stampIntegration(key: IntegrationKey, at: Date, succeeded: boolean): Promise<void> {
  await prismaAdmin.admin_integrations.updateMany({
    where: { key },
    data: { last_run_at: at, ...(succeeded ? { last_success_at: at } : {}) },
  });
}

/**
 * Runs one run to the end and returns the finished row.
 *
 * The row goes `running` (with `started_at`), `work` runs, and it lands on
 * `succeeded` or `failed` with `finished_at`. A failure is logged and stored
 * in `error`; it is **not** rethrown, because a background run has nobody to
 * throw to and an inline one answers with the failed run.
 *
 * The single exception is a missing admin table: a deployment problem rather
 * than a run outcome, so it propagates and the caller decides.
 */
export async function runRun(
  key: IntegrationKey,
  runId: string,
  work: RunWork,
): Promise<IntegrationRun> {
  const startedAt = new Date();
  await prismaAdmin.admin_integration_runs.update({
    where: { id: runId },
    data: { status: "running", started_at: startedAt, heartbeat_at: startedAt },
  });
  await stampIntegration(key, startedAt, false);

  const report: ProgressReporter = async (progress) => {
    await prismaAdmin.admin_integration_runs.update({
      where: { id: runId },
      data: progressData(progress),
    });
  };

  const heartbeat = startHeartbeat(runId);

  try {
    await work(report, runId);
    await finish(runId, "succeeded", null);
    await stampIntegration(key, new Date(), true);
  } catch (error) {
    const message = messageOf(error);
    console.error(`[integrations] run ${runId} (${key}) failed: ${message}`);
    if (isMissingTableError(error)) {
      // The integration tables are not installed. Recording the failure would
      // fail the same way; let the caller answer 503 instead.
      throw error;
    }
    await finish(runId, "failed", message);
  } finally {
    heartbeat.stop();
  }
  const row = await prismaAdmin.admin_integration_runs.findUnique({ where: { id: runId } });
  if (!row) throw new Error(`Integration run ${runId} disappeared while it was running.`);
  return toRun(row);
}

/**
 * Keeps `heartbeat_at` fresh while a run works, independently of its batches.
 *
 * One write in flight at a time, a failed beat is logged rather than thrown
 * (it is a liveness signal, not part of the work), and the timer is `unref`'d
 * so it can never hold the process open on its own.
 */
function startHeartbeat(runId: string): { stop: () => void } {
  let writing = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (writing || stopped) return;
    writing = true;
    void prismaAdmin.admin_integration_runs
      .updateMany({ where: { id: runId, status: "running" }, data: { heartbeat_at: new Date() } })
      .catch((error: unknown) => {
        console.warn(`[integrations] run ${runId} heartbeat failed: ${messageOf(error)}`);
      })
      .finally(() => {
        writing = false;
      });
  }, RUN_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function finish(
  runId: string,
  status: "succeeded" | "failed",
  error: string | null,
): Promise<void> {
  await prismaAdmin.admin_integration_runs.update({
    where: { id: runId },
    data: { status, error, finished_at: new Date(), heartbeat_at: new Date() },
  });
}

/* -------------------------------------------------------------------------- */
/*                          One live run per integration                      */
/* -------------------------------------------------------------------------- */

/**
 * The integrations this process is running, so a second request is refused
 * before it touches the database. The value is the run id once it exists, and
 * a placeholder for the moment between the reservation and the insert.
 */
const runningByKey = new Map<IntegrationKey, string>();

const RESERVED = "starting";

function conflict(key: IntegrationKey, runId: string): ConflictError {
  return new ConflictError(
    runId === RESERVED
      ? `Another run of ${key} is starting. Wait for it to finish.`
      : `Run ${runId} is already running for ${key}. Wait for it to finish.`,
  );
}

/** Claims the integration for this process, synchronously, or refuses. */
function reserveKey(key: IntegrationKey): void {
  const held = runningByKey.get(key);
  if (held !== undefined) throw conflict(key, held);
  runningByKey.set(key, RESERVED);
}

function releaseKey(key: IntegrationKey, runId: string): void {
  if (runningByKey.get(key) === runId) runningByKey.delete(key);
}

/** True while this process holds a run for the key (without touching the DB). */
export function isRunningHere(key: IntegrationKey): boolean {
  return runningByKey.has(key);
}

/**
 * Refuses a new run while another process holds the integration, and cleans
 * up after a process that died: a stale `queued` or `running` row is written
 * off as `failed` with `error = RUN_INTERRUPTED`, which `statusOf` keeps
 * reporting as `interrupted`.
 */
async function assertNoLiveRun(key: IntegrationKey): Promise<void> {
  const rows = await prismaAdmin.admin_integration_runs.findMany({
    where: { integration_key: key, status: { in: ["queued", "running"] } },
  });
  for (const row of rows) {
    if (!isStale(row)) throw conflict(key, row.id);
    await prismaAdmin.admin_integration_runs.updateMany({
      where: { id: row.id, status: { in: ["queued", "running"] } },
      data: { status: "failed", error: RUN_INTERRUPTED, finished_at: new Date() },
    });
  }
}

export interface BeginRunOptions extends CreateRunInput {
  /** Await the run and answer with the finished row, rather than a `running` one. */
  inline: boolean;
  work: RunWork;
}

/**
 * The one entry point the service uses: claims the integration, records the
 * run and executes it.
 *
 * @throws {ConflictError} a run is already live for this integration.
 */
export async function beginRun(options: BeginRunOptions): Promise<IntegrationRun> {
  const { inline, work, ...input } = options;
  reserveKey(input.integrationKey);
  let run: IntegrationRun;
  try {
    await assertNoLiveRun(input.integrationKey);
    run = await createRun(input);
  } catch (error) {
    runningByKey.delete(input.integrationKey);
    throw error;
  }
  runningByKey.set(input.integrationKey, run.id);
  return startRun(run, work, { inline });
}

/**
 * Executes a run that already exists. Inline: awaits it and answers with the
 * finished row. Otherwise: lets it run on and answers `running` at once,
 * which is what the page starts polling.
 */
export async function startRun(
  run: IntegrationRun,
  work: RunWork,
  options: { inline: boolean },
): Promise<IntegrationRun> {
  const execution = runRun(run.integrationKey, run.id, work).finally(() =>
    releaseKey(run.integrationKey, run.id),
  );
  if (options.inline) return execution;
  void execution.catch((error: unknown) => {
    console.error(
      `[integrations] run ${run.id} (${run.integrationKey}) ended badly: ${messageOf(error)}`,
    );
  });
  const now = new Date().toISOString();
  // Optimistic, and true within milliseconds: `runRun` has already been
  // called, so the row is on its way to `running`. The next poll reads the
  // real timestamps.
  return { ...run, status: "running", startedAt: now, heartbeatAt: now };
}
