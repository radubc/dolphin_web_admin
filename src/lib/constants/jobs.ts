import "server-only";
/**
 * Compare and push **jobs** for the Constants catalogs
 * (`admin_constant_jobs` in the admin database) and the in-process runner
 * that executes them.
 *
 * A catalog of 300 000 rows cannot be compared or pushed inside one request,
 * so the work is a job: a row that records what was asked, how far it got,
 * what it wrote and how it ended. Small requests still run **inline** — the
 * response carries an already finished job — while larger ones return a
 * `running` job the page follows through `GET …/jobs/[jobId]`.
 *
 * The runner is deliberately in-process: there is no queue, no worker, no
 * cron. Every batch commits on its own, so an interrupted job (a deploy, a
 * restart) loses nothing that was already written and can simply be run
 * again.
 *
 * **Interruption.** A running job refreshes `heartbeat_at` after every batch
 * *and* on a `JOB_HEARTBEAT_INTERVAL_MS` timer, so a long batch never looks
 * dead. A job is stale when
 * - it is `running` and `heartbeat_at` (or `started_at`, before the first
 *   beat) is older than `JOB_STALE_AFTER_MS`, or
 * - it is `queued` and `created_at` is that old — the process died between the
 *   insert and the run, so nothing will ever pick it up.
 *
 * A stale job reads as `interrupted` straight away, and the next job for that
 * kind writes the row off as `failed` with `error = JOB_INTERRUPTED`. That
 * stored form is mapped back to `interrupted` on read, so a job the API once
 * called `interrupted` never turns into a plain `failed` later.
 *
 * Only one compare or push per kind runs at a time. The guard is two-layered:
 * a module-level reservation (this process) and a check for a `queued` or
 * `running` row that is not stale (any process). A second request is a 409
 * naming the job that holds the kind.
 *
 * Admin database only. `admin_constant_jobs` may not exist yet
 * (`docs/sql/007_constants_sync_and_jobs.sql` is run by hand); that error is
 * never swallowed, so `adminHandler` renders it as 503 `admin_schema_missing`.
 */
import type { Prisma } from "@/generated/prisma-admin/client";
import { isMissingTableError } from "@/lib/admin-access/prisma-repository";
import { ConflictError } from "@/lib/api/errors";
import { prismaAdmin } from "@/lib/prisma-admin";
import {
  CONSTANT_KIND_LABELS,
  JOB_HEARTBEAT_INTERVAL_MS,
  JOB_STALE_AFTER_MS,
  type ConstantJob,
  type ConstantJobStatus,
  type ConstantJobType,
  type ConstantKind,
} from "./types";

/** How long an error message may be before it is cut down for the job row. */
const ERROR_MAX = 1000;

/**
 * The sentinel `error` value a job row carries when it was written off as
 * abandoned. The one spelling shared by the writer (`assertNoLiveJob`) and the
 * reader (`statusOf`), which is what keeps a job the API called `interrupted`
 * from turning into a plain `failed` once the row is finally closed.
 */
export const JOB_INTERRUPTED = "interrupted";

/* -------------------------------------------------------------------------- */
/*                                   Mapping                                  */
/* -------------------------------------------------------------------------- */

type JobRow = Prisma.admin_constant_jobsGetPayload<object>;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** The row fields staleness is decided from. */
type StaleCheckRow = Pick<JobRow, "status" | "heartbeat_at" | "started_at" | "created_at">;

/**
 * True when a live job has gone quiet long enough to call it interrupted.
 *
 * A `running` row is judged by its heartbeat (a job writes one every
 * `JOB_HEARTBEAT_INTERVAL_MS` and after every batch), falling back to
 * `started_at` for the moment before the first beat. A `queued` row has no
 * heartbeat to give: it is judged by `created_at`, which catches a process
 * that died between the insert and the run. Any other status is finished and
 * never stale.
 */
function isStale(row: StaleCheckRow): boolean {
  if (row.status === "running") {
    const beat = row.heartbeat_at ?? row.started_at ?? row.created_at;
    return Date.now() - beat.getTime() > JOB_STALE_AFTER_MS;
  }
  if (row.status === "queued") {
    return Date.now() - row.created_at.getTime() > JOB_STALE_AFTER_MS;
  }
  return false;
}

/**
 * The status as the API reports it. The database only ever stores `queued`,
 * `running`, `succeeded` or `failed`; `interrupted` is derived, in two ways
 * that have to agree:
 * - a `running` or `queued` row that has gone stale, so nothing has to be
 *   written the moment a process dies; and
 * - a `failed` row carrying `error = JOB_INTERRUPTED`, which is how the next
 *   job for the kind closes that same row. Without this second case a job
 *   already reported as `interrupted` would flip to `failed` behind the
 *   operator's back.
 */
function statusOf(row: JobRow): ConstantJobStatus {
  if (row.status === "running" || row.status === "queued") {
    return isStale(row) ? "interrupted" : row.status;
  }
  if (row.status === "failed") return row.error === JOB_INTERRUPTED ? "interrupted" : "failed";
  if (row.status === "succeeded") {
    return row.status;
  }
  // A value the CHECK constraint forbids; report it as failed rather than
  // letting an unknown string reach the client as a status.
  return "failed";
}

function toJob(row: JobRow): ConstantJob {
  return {
    id: row.id,
    kind: row.kind as ConstantKind,
    type: row.type as ConstantJobType,
    status: statusOf(row),
    total: row.total,
    processed: row.processed,
    created: row.created,
    updated: row.updated,
    unchanged: row.unchanged,
    dependencyRows: row.dependency_rows,
    mainOnly: row.main_only,
    error: row.error === null ? null : row.error.slice(0, ERROR_MAX),
    requestedBy: row.requested_by,
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    heartbeatAt: iso(row.heartbeat_at),
  };
}

/** The last line of an error, trimmed to what the `error` column should hold. */
function messageOf(error: unknown): string {
  const raw =
    error instanceof Error
      ? (error.message.split("\n").filter((line) => line.trim() !== "").at(-1) ?? error.message)
      : String(error);
  return raw.trim().slice(0, ERROR_MAX);
}

/* -------------------------------------------------------------------------- */
/*                                    Reads                                   */
/* -------------------------------------------------------------------------- */

/** One job of one kind. `null` when the id is unknown or belongs to another kind. */
export async function getJob(kind: ConstantKind, jobId: string): Promise<ConstantJob | null> {
  const row = await prismaAdmin.admin_constant_jobs.findFirst({ where: { id: jobId, kind } });
  return row ? toJob(row) : null;
}

/** The kind's most recent jobs, newest first. */
export async function listJobs(kind: ConstantKind, limit: number): Promise<ConstantJob[]> {
  const rows = await prismaAdmin.admin_constant_jobs.findMany({
    where: { kind },
    orderBy: { created_at: "desc" },
    take: limit,
  });
  return rows.map(toJob);
}

/** The kind's most recent job of any status, for the list response. */
export async function latestJob(kind: ConstantKind): Promise<ConstantJob | null> {
  const row = await prismaAdmin.admin_constant_jobs.findFirst({
    where: { kind },
    orderBy: { created_at: "desc" },
  });
  return row ? toJob(row) : null;
}

/** When the kind's last successful compare finished; `null` before the first. */
export async function lastComparedAt(kind: ConstantKind): Promise<string | null> {
  const row = await prismaAdmin.admin_constant_jobs.findFirst({
    where: { kind, type: "compare", status: "succeeded", finished_at: { not: null } },
    orderBy: { finished_at: "desc" },
    select: { finished_at: true },
  });
  return row?.finished_at ? row.finished_at.toISOString() : null;
}

/* -------------------------------------------------------------------------- */
/*                                   Writes                                   */
/* -------------------------------------------------------------------------- */

export interface CreateJobInput {
  kind: ConstantKind;
  type: ConstantJobType;
  /** `admin_users.id` of the operator, or null for a system run. */
  requestedBy: string | null;
  /** The request as received (ids or scope), kept for the record. */
  request: Prisma.InputJsonValue;
  /** Rows the job expects to process, when it is known up front. */
  total?: number | null;
}

/** Inserts a `queued` job row. */
export async function createJob(input: CreateJobInput): Promise<ConstantJob> {
  const row = await prismaAdmin.admin_constant_jobs.create({
    data: {
      kind: input.kind,
      type: input.type,
      status: "queued",
      total: input.total ?? null,
      request: input.request,
      requested_by: input.requestedBy,
    },
  });
  return toJob(row);
}

/** Counters a job reports as it goes; every field is an absolute total. */
export interface JobProgress {
  total?: number | null;
  processed?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  dependencyRows?: number;
  mainOnly?: number;
}

/**
 * How work reports progress. One call per batch: each call is one `UPDATE`
 * that also refreshes `heartbeat_at`, which is what keeps the job from being
 * read as interrupted.
 */
export type ProgressReporter = (progress: JobProgress) => Promise<void>;

/** What a job does. It is handed the reporter and its own job id. */
export type JobWork = (progress: ProgressReporter, jobId: string) => Promise<void>;

function progressData(progress: JobProgress): Prisma.admin_constant_jobsUpdateInput {
  return {
    ...(progress.total === undefined ? {} : { total: progress.total }),
    ...(progress.processed === undefined ? {} : { processed: progress.processed }),
    ...(progress.created === undefined ? {} : { created: progress.created }),
    ...(progress.updated === undefined ? {} : { updated: progress.updated }),
    ...(progress.unchanged === undefined ? {} : { unchanged: progress.unchanged }),
    ...(progress.dependencyRows === undefined ? {} : { dependency_rows: progress.dependencyRows }),
    ...(progress.mainOnly === undefined ? {} : { main_only: progress.mainOnly }),
    heartbeat_at: new Date(),
  };
}

/**
 * Runs one job to the end and returns the finished row.
 *
 * The job goes `running` (with `started_at`), `work` runs, and the row lands
 * on `succeeded` or `failed` with `finished_at`. A failure is logged with the
 * job id and stored in `error`; it is **not** rethrown, because a background
 * run has nobody to throw to and an inline one answers with the failed job.
 *
 * The single exception is a missing admin table: that is a deployment problem
 * rather than a job outcome, so it propagates and `adminHandler` turns it into
 * 503 `admin_schema_missing`.
 *
 * Besides the per-batch progress write, a timer refreshes `heartbeat_at` every
 * `JOB_HEARTBEAT_INTERVAL_MS`: a batch that legitimately takes minutes (a
 * 1000-row push transaction) must not be mistaken for a dead process.
 */
export async function runJob(jobId: string, work: JobWork): Promise<ConstantJob> {
  const startedAt = new Date();
  await prismaAdmin.admin_constant_jobs.update({
    where: { id: jobId },
    data: { status: "running", started_at: startedAt, heartbeat_at: startedAt },
  });

  const report: ProgressReporter = async (progress) => {
    await prismaAdmin.admin_constant_jobs.update({
      where: { id: jobId },
      data: progressData(progress),
    });
  };

  const heartbeat = startHeartbeat(jobId);

  try {
    await work(report, jobId);
    await finish(jobId, "succeeded", null);
  } catch (error) {
    const message = messageOf(error);
    console.error(`[constants] job ${jobId} failed: ${message}`);
    if (isMissingTableError(error)) {
      // The ledger or the jobs table is not installed. Recording the failure
      // would fail the same way; let the request answer 503 instead.
      throw error;
    }
    await finish(jobId, "failed", message);
  } finally {
    heartbeat.stop();
  }
  const row = await prismaAdmin.admin_constant_jobs.findUnique({ where: { id: jobId } });
  if (!row) throw new Error(`Constants job ${jobId} disappeared while it was running.`);
  return toJob(row);
}

/**
 * Keeps `heartbeat_at` fresh while a job runs, independently of its batches.
 *
 * One write in flight at a time (`writing`), so a slow admin database cannot
 * pile beats up behind each other, and a failed beat is logged rather than
 * thrown: it is a liveness signal, not part of the job's work. The timer is
 * `unref`'d so it can never hold the process open on its own; the caller
 * clears it in a `finally`. A beat that was already in flight when the job
 * finished can land afterwards — it only touches `heartbeat_at`, which says
 * nothing about a job that is no longer `running`.
 */
function startHeartbeat(jobId: string): { stop: () => void } {
  let writing = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (writing || stopped) return;
    writing = true;
    void prismaAdmin.admin_constant_jobs
      .updateMany({
        where: { id: jobId, status: "running" },
        data: { heartbeat_at: new Date() },
      })
      .catch((error: unknown) => {
        console.warn(`[constants] job ${jobId} heartbeat failed: ${messageOf(error)}`);
      })
      .finally(() => {
        writing = false;
      });
  }, JOB_HEARTBEAT_INTERVAL_MS);
  // Node timers only; a stray beat must not keep a serverless invocation alive.
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function finish(
  jobId: string,
  status: "succeeded" | "failed",
  error: string | null,
): Promise<void> {
  await prismaAdmin.admin_constant_jobs.update({
    where: { id: jobId },
    data: { status, error, finished_at: new Date(), heartbeat_at: new Date() },
  });
}

/* -------------------------------------------------------------------------- */
/*                             One job per kind                               */
/* -------------------------------------------------------------------------- */

/**
 * The kinds this process is running a job for, so a second request is refused
 * before it touches either database. The value is the job id once it exists,
 * and a placeholder for the moment between the reservation and the insert.
 */
const runningByKind = new Map<ConstantKind, string>();

/** Held between `reserveKind` and the job row existing. */
const RESERVED = "starting";

function conflict(kind: ConstantKind, jobId: string): ConflictError {
  const label = CONSTANT_KIND_LABELS[kind].plural;
  return new ConflictError(
    jobId === RESERVED
      ? `Another job for ${label} is starting. Wait for it to finish.`
      : `Job ${jobId} is already running for ${label}. Wait for it to finish.`,
  );
}

/** Claims the kind for this process, synchronously, or refuses. */
function reserveKind(kind: ConstantKind): void {
  const held = runningByKind.get(kind);
  if (held !== undefined) throw conflict(kind, held);
  runningByKind.set(kind, RESERVED);
}

function releaseKind(kind: ConstantKind, jobId: string): void {
  if (runningByKind.get(kind) === jobId) runningByKind.delete(kind);
}

/**
 * Refuses a new job while another process holds the kind, and cleans up after
 * a process that died.
 *
 * Both live statuses count: a `running` row with a fresh heartbeat is a job in
 * flight, and a `queued` row is one that is about to start (or, once stale, one
 * whose process died between the insert and the run — a row nothing would ever
 * have closed before). A stale row of either kind is written off as `failed`
 * with `error = JOB_INTERRUPTED`, which `statusOf` keeps reporting as
 * `interrupted`, exactly as it did while the row was still open.
 */
async function assertNoLiveJob(kind: ConstantKind): Promise<void> {
  const rows = await prismaAdmin.admin_constant_jobs.findMany({
    where: { kind, status: { in: ["queued", "running"] } },
  });
  for (const row of rows) {
    if (!isStale(row)) throw conflict(kind, row.id);
    await prismaAdmin.admin_constant_jobs.updateMany({
      where: { id: row.id, status: { in: ["queued", "running"] } },
      data: { status: "failed", error: JOB_INTERRUPTED, finished_at: new Date() },
    });
  }
}

export interface BeginJobOptions extends CreateJobInput {
  /** Await the run and answer with the finished job, rather than a `running` one. */
  inline: boolean;
  work: JobWork;
}

/**
 * The one entry point the service uses: claims the kind, records the job and
 * runs it.
 *
 * @throws {ConflictError} a compare or push is already running for this kind.
 */
export async function beginJob(options: BeginJobOptions): Promise<ConstantJob> {
  const { inline, work, ...input } = options;
  reserveKind(input.kind);
  let job: ConstantJob;
  try {
    await assertNoLiveJob(input.kind);
    job = await createJob(input);
  } catch (error) {
    runningByKind.delete(input.kind);
    throw error;
  }
  runningByKind.set(input.kind, job.id);
  return startJob(job, work, { inline });
}

/**
 * Runs a job that already exists. Inline: awaits it and answers with the
 * finished row. Otherwise: lets it run on and answers `running` at once, which
 * is what the page starts polling.
 */
export async function startJob(
  job: ConstantJob,
  work: JobWork,
  options: { inline: boolean },
): Promise<ConstantJob> {
  const run = runJob(job.id, work).finally(() => releaseKind(job.kind, job.id));
  if (options.inline) return run;
  void run.catch((error: unknown) => {
    console.error(`[constants] job ${job.id} (${job.kind} ${job.type}) ended badly: ${messageOf(error)}`);
  });
  const now = new Date().toISOString();
  // Optimistic, and true within milliseconds: `runJob` has already been
  // called, so the row is on its way to `running`. The next poll reads the
  // real timestamps.
  return { ...job, status: "running", startedAt: now, heartbeatAt: now };
}
