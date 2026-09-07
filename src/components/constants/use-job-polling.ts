"use client";

/**
 * Following a compare or a push while it runs on the server.
 *
 * A catalog of 300,000 rows cannot be compared or pushed inside one request, so
 * the API answers with a **job**: small requests come back already `succeeded`,
 * larger ones come back `running` and are followed here — one `GET` every two
 * seconds until the job reaches `succeeded`, `failed` or `interrupted`.
 *
 * Two ways in, one way out:
 *
 * - `track(job)` takes the job a push or compare just returned. Already
 *   finished (an inline push) means one notification and nothing else; still
 *   running means the poll starts.
 * - a job the *list* reports as running (`list.latestJob`) is picked up the
 *   same way, so reloading the page while a push is running rejoins it instead
 *   of losing it.
 *
 * When the job lands the hook announces the change on `window`
 * (`notifyConstantsChanged`), which is what the store listens to, so the page
 * reloads through the one path every other write already uses.
 *
 * The job is the server's; nothing here can cancel it. Leaving the page only
 * stops the watching.
 */

import { useCallback, useEffect, useState } from "react";
import { App } from "antd";
import { constantsApi, notifyConstantsChanged } from "@/lib/constants/client";
import type { ConstantJob, ConstantKind } from "@/lib/constants/types";
import { JOB_STALE_AFTER_MS } from "@/lib/constants/types";
import { errorMessage, pluralise } from "@/lib/format";

/** How often a running job is asked about. */
const POLL_INTERVAL_MS = 2_000;

/** Consecutive failed polls before the page gives up watching. */
const POLL_FAILURES_MAX = 3;

/** Still going, as far as its status says. */
function isLive(job: ConstantJob): boolean {
  return job.status === "queued" || job.status === "running";
}

/**
 * A running job whose heartbeat has gone quiet, or a queued one that has sat
 * for as long without ever starting, is a process that restarted under it.
 * The server reports that as `interrupted` on its own schedule; the page
 * reads the same signal too, so a watcher never spins forever on a job nobody
 * is running any more — including one that never got past `queued`, whose
 * `heartbeatAt` stays null the whole time it waits, which is why writes stay
 * held for it otherwise.
 */
function isStale(job: ConstantJob): boolean {
  if (job.status === "queued") {
    const created = Date.parse(job.createdAt);
    return !Number.isNaN(created) && Date.now() - created > JOB_STALE_AFTER_MS;
  }
  if (job.status !== "running" || job.heartbeatAt === null) return false;
  const beat = Date.parse(job.heartbeatAt);
  return !Number.isNaN(beat) && Date.now() - beat > JOB_STALE_AFTER_MS;
}

/**
 * What the job would be called if it were reported now: a stale `queued` or
 * `running` job reads as `interrupted`, and so does a `failed` one whose
 * `error` already says `"interrupted"` — belt and braces alongside the
 * server's own reporting of the same thing.
 */
function settle(job: ConstantJob): ConstantJob {
  if (isStale(job)) return { ...job, status: "interrupted" };
  if (job.status === "failed" && job.error === "interrupted") return { ...job, status: "interrupted" };
  return job;
}

/** "Comparing…" / "Pushing…", for the progress strip. */
export function jobRunningLabel(job: ConstantJob): string {
  return job.type === "compare" ? "Comparing…" : "Pushing…";
}

export interface JobPolling {
  /** The job being followed, or the one that just finished; null when there is none. */
  job: ConstantJob | null;
  /** A job for this kind is running: writes are held until it lands. */
  running: boolean;
  /** Follow the job a push or a compare just returned. */
  track: (job: ConstantJob) => void;
}

/**
 * @param kind the catalog on screen; a job belongs to one kind and a switch
 *   drops the watch rather than reporting another catalog's job.
 * @param latestJob the newest job the list reported, so a reload rejoins one
 *   that is still running.
 */
export function useJobPolling(kind: ConstantKind, latestJob: ConstantJob | null): JobPolling {
  const { notification } = App.useApp();
  // Stamped with its kind rather than cleared on a switch: derived at render,
  // it needs no effect to keep the two in step.
  const [tracked, setTracked] = useState<{ kind: ConstantKind; job: ConstantJob } | null>(null);

  const mine = tracked !== null && tracked.kind === kind ? tracked.job : null;
  // A job the list reports takes over only while nothing is being followed;
  // once a poll has answered, its own reading is the fresher one.
  const resumed = latestJob !== null && isLive(latestJob) ? settle(latestJob) : null;
  const job = mine ?? resumed;
  const running = job !== null && isLive(job);
  const pollId = running ? job.id : null;

  /** The notification a finished job earns. */
  const report = useCallback(
    (finished: ConstantJob) => {
      const what = finished.type === "compare" ? "Compare" : "Push";

      if (finished.status === "interrupted") {
        notification.warning({
          title: `${what} interrupted`,
          description:
            "The server restarted during the job; nothing it had already written is lost. Run it again to finish.",
          duration: 8,
        });
        return;
      }

      if (finished.status === "failed") {
        notification.error({
          title: `${what} failed`,
          description: finished.error ?? "The job stopped before it finished.",
          duration: 0,
        });
        return;
      }

      if (finished.type === "compare") {
        notification.success({
          title: "Compare finished",
          description: `${pluralise(finished.processed, "row")} compared, ${finished.mainOnly} only in the main app.`,
          duration: 6,
        });
        return;
      }

      const dependencies =
        finished.dependencyRows > 0
          ? ` ${pluralise(finished.dependencyRows, "dependent row")} pushed first so the references hold.`
          : "";
      notification.success({
        title: "Push finished",
        description: `${finished.created} created · ${finished.updated} updated · ${finished.unchanged} unchanged.${dependencies}`,
        duration: 6,
      });
    },
    [notification],
  );

  const track = useCallback(
    (next: ConstantJob) => {
      const settled = settle(next);
      setTracked({ kind, job: settled });
      // An inline job is already done when it is handed over: `constantsApi`
      // has announced the change itself, so this only has to say what happened.
      if (!isLive(settled)) report(settled);
    },
    [kind, report],
  );

  useEffect(() => {
    if (pollId === null) return;
    let stopped = false;
    let inFlight = false;
    let failures = 0;

    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };

    const finish = (finished: ConstantJob) => {
      stop();
      setTracked({ kind, job: finished });
      report(finished);
      // The store listens for this and reloads the page of rows, the counts and
      // the last compare time in one go.
      notifyConstantsChanged(kind);
    };

    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      if (stopped || inFlight) return;
      inFlight = true;
      void constantsApi
        .job(kind, pollId)
        .then((next) => {
          if (stopped) return;
          failures = 0;
          const settled = settle(next);
          if (isLive(settled)) {
            setTracked({ kind, job: settled });
            return;
          }
          finish(settled);
        })
        .catch((cause: unknown) => {
          if (stopped) return;
          failures += 1;
          if (failures < POLL_FAILURES_MAX) return;
          stop();
          notification.error({
            title: "Lost track of the job",
            description: `${errorMessage(cause)} The job carries on on the server; refresh to see where it got to.`,
            duration: 0,
          });
        })
        .finally(() => {
          inFlight = false;
        });
    }, POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [kind, pollId, report, notification]);

  return { job, running, track };
}
