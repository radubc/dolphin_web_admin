"use client";

/**
 * Following the runs that are live on the server.
 *
 * A run over a whole watch list takes minutes, so `POST .../run` answers with
 * the run rather than the result, and the page follows it — one `GET` every two
 * seconds per live run until it reaches `succeeded`, `failed` or `interrupted`.
 *
 * Several integrations can be running at once, so the hook watches a *set* rather
 * than a single job: it takes the list on screen, picks out every run that is
 * still live (whether it was started here or was already going when the page
 * loaded), and polls each of them on one timer. That is also what makes a
 * reload rejoin a run instead of losing it: the list's `latestRun` is enough to
 * pick the watch back up.
 *
 * When a run lands the hook announces the change on `window`
 * (`notifyIntegrationsChanged`), which is what the stores listen to, so the
 * cards and the watch list the run wrote to refresh through the one path every
 * other write already uses.
 *
 * The run is the server's; nothing here can cancel it. Leaving the page only
 * stops the watching.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { integrationsApi, notifyIntegrationsChanged } from "@/lib/integrations/client";
import type { Integration, IntegrationKey, IntegrationRun } from "@/lib/integrations/types";
import { RUN_STALE_AFTER_MS } from "@/lib/integrations/types";
import { errorMessage, pluralise } from "@/lib/format";

/** How often a live run is asked about. */
const POLL_INTERVAL_MS = 2_000;

/** Consecutive failed polls before the page gives up watching. */
const POLL_FAILURES_MAX = 3;

/** Still going, as far as its status says. */
function isLive(run: IntegrationRun): boolean {
  return run.status === "queued" || run.status === "running";
}

/**
 * A running run whose heartbeat has gone quiet, or a queued one that has sat
 * for as long without ever starting, belongs to a process that restarted under
 * it. The server reports that as `interrupted` on its own schedule; the page
 * reads the same signal too, so a watcher never spins forever on a run nobody
 * is working on any more.
 */
function isStale(run: IntegrationRun): boolean {
  if (run.status === "queued") {
    const created = Date.parse(run.createdAt);
    return !Number.isNaN(created) && Date.now() - created > RUN_STALE_AFTER_MS;
  }
  if (run.status !== "running" || run.heartbeatAt === null) return false;
  const beat = Date.parse(run.heartbeatAt);
  return !Number.isNaN(beat) && Date.now() - beat > RUN_STALE_AFTER_MS;
}

/** What the run would be called if it were reported now. */
function settle(run: IntegrationRun): IntegrationRun {
  if (isStale(run)) return { ...run, status: "interrupted" };
  if (run.status === "failed" && run.error === "interrupted") return { ...run, status: "interrupted" };
  return run;
}

/**
 * Which watch list a finished run wrote to, so the table showing it reloads
 * along with the cards. The catalog download writes the Constants catalogs,
 * which this page does not show, so it only announces itself.
 */
function scopeOf(key: IntegrationKey): "quote_symbols" | "currency_pairs" | null {
  switch (key) {
    case "twelvedata_quotes":
      return "quote_symbols";
    case "bank_of_canada_rates":
      return "currency_pairs";
    default:
      return null;
  }
}

export interface RunPolling {
  /** The live run per integration key, for the progress strips. */
  live: Readonly<Partial<Record<IntegrationKey, IntegrationRun>>>;
  /** Whether that integration has a run in flight: its Run now button is held. */
  isRunning: (key: IntegrationKey) => boolean;
  /** Follow the run "Run now" just returned. */
  track: (run: IntegrationRun) => void;
}

/**
 * @param integrations the list on screen, so a run that was already going when
 *   the page loaded is picked up from its integration's `latestRun`.
 */
export function useRunPolling(integrations: readonly Integration[]): RunPolling {
  const { notification } = App.useApp();
  const [tracked, setTracked] = useState<Partial<Record<IntegrationKey, IntegrationRun>>>({});

  /** The live run per key: what is being followed, else what the list reported. */
  const live = useMemo(() => {
    const result: Partial<Record<IntegrationKey, IntegrationRun>> = {};
    for (const integration of integrations) {
      // A run a poll has answered about is the fresher reading; the list's
      // `latestRun` only takes over while nothing is being followed.
      const candidate = tracked[integration.key] ?? integration.latestRun;
      if (candidate === null || candidate === undefined) continue;
      const settled = settle(candidate);
      if (isLive(settled)) result[integration.key] = settled;
    }
    return result;
  }, [integrations, tracked]);

  /** `key:runId,key:runId`, so the effect restarts only when the set changes. */
  const pollKey = useMemo(
    () =>
      Object.entries(live)
        .map(([key, run]) => `${key}:${run.id}`)
        .sort()
        .join(","),
    [live],
  );

  const names = useMemo(() => {
    const result: Partial<Record<IntegrationKey, string>> = {};
    for (const integration of integrations) result[integration.key] = integration.name;
    return result;
  }, [integrations]);

  /** The notification a finished run earns. */
  const report = useCallback(
    (finished: IntegrationRun) => {
      const what = names[finished.integrationKey] ?? finished.integrationKey;

      if (finished.status === "interrupted") {
        notification.warning({
          title: `${what} was interrupted`,
          description:
            "The server restarted during the run; nothing it had already written is lost. Run it again to finish.",
          duration: 8,
        });
        return;
      }

      if (finished.status === "failed") {
        notification.error({
          title: `${what} failed`,
          description: finished.error ?? "The run stopped before it finished.",
          duration: 0,
        });
        return;
      }

      const failures =
        finished.failed > 0 ? ` ${pluralise(finished.failed, "item")} the provider did not return.` : "";
      notification.success({
        title: `${what} finished`,
        description: `${finished.created} created · ${finished.updated} updated · ${finished.unchanged} unchanged.${failures}`,
        duration: 6,
      });
    },
    [names, notification],
  );

  const track = useCallback(
    (next: IntegrationRun) => {
      const settled = settle(next);
      if (!isLive(settled)) {
        // Already finished when it was handed over — nothing to poll for, so
        // just report it and leave `tracked` alone: keeping no entry lets the
        // list's own `latestRun` (which the report's reload will refresh)
        // decide what is live from here on, including a run started later.
        report(settled);
        return;
      }
      setTracked((current) => ({ ...current, [settled.integrationKey]: settled }));
    },
    [report],
  );

  useEffect(() => {
    if (pollKey === "") return;
    const targets = pollKey.split(",").map((entry) => {
      const separator = entry.indexOf(":");
      return {
        key: entry.slice(0, separator) as IntegrationKey,
        id: entry.slice(separator + 1),
      };
    });

    let stopped = false;
    let inFlight = false;
    let failures = 0;
    // A run that lands is still in `targets` until the effect restarts with the
    // shorter set, and the timer can fire once more in between; without this it
    // would be reported twice.
    const reported = new Set<string>();

    const finish = (finished: IntegrationRun) => {
      if (reported.has(finished.id)) return;
      reported.add(finished.id);
      report(finished);
      // Drop the entry rather than parking the finished run in it: left in
      // place, it would outrank `integration.latestRun` forever and hide a
      // later run (say, the scheduler's) until the page reloaded. Removing it
      // hands the decision back to the list, which the notify below reloads.
      setTracked((current) => {
        if (current[finished.integrationKey]?.id !== finished.id) return current;
        const next = { ...current };
        delete next[finished.integrationKey];
        return next;
      });
      // The stores listen for these and reload the cards, and the watch list
      // the run wrote to, in one go.
      notifyIntegrationsChanged("integrations");
      const scope = scopeOf(finished.integrationKey);
      if (scope !== null) notifyIntegrationsChanged(scope);
    };

    const timer = setInterval(() => {
      if (stopped || inFlight) return;
      inFlight = true;
      void Promise.all(targets.map((target) => integrationsApi.run(target.key, target.id)))
        .then((runs) => {
          if (stopped) return;
          failures = 0;
          const settled = runs.map(settle);
          setTracked((current) => {
            const next = { ...current };
            for (const run of settled) next[run.integrationKey] = run;
            return next;
          });
          for (const run of settled) {
            if (!isLive(run)) finish(run);
          }
        })
        .catch((cause: unknown) => {
          if (stopped) return;
          failures += 1;
          if (failures < POLL_FAILURES_MAX) return;
          stopped = true;
          clearInterval(timer);
          notification.error({
            title: "Lost track of the run",
            description: `${errorMessage(cause)} The run carries on on the server; refresh to see where it got to.`,
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
  }, [pollKey, report, notification]);

  const isRunning = useCallback((key: IntegrationKey) => live[key] !== undefined, [live]);

  return { live, isRunning, track };
}
