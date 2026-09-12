"use client";

/**
 * Everything the Cost center page needs from the server, and the one write it
 * can make.
 *
 * Two reads — the summary and the daily series — plus "Refresh now", which is
 * not a write to the cost tables at all: it starts a run of the `aws_costs`
 * integration through the endpoint the Integrations page already uses, and
 * follows it until it lands. There is deliberately no second run-now endpoint
 * for costs; one job, one way to start it, one run history.
 *
 * The polling here is a narrower cousin of
 * `src/components/integrations/use-run-polling.ts` rather than a reuse of it.
 * That hook watches a *set* of integrations and needs the whole
 * `Integration[]` list on screen to do it; this page has one integration and
 * already knows its newest run, because the summary carries it. Building a
 * synthetic `Integration` to satisfy the other hook's signature would be more
 * code than the twenty lines below, and it would fetch the list of every
 * provider to draw one button.
 *
 * What it does share is the behaviour that matters: a reload rejoins a run
 * that was already going (the summary's `lastRun` is enough to pick it back
 * up), a run whose heartbeat has gone quiet is reported as interrupted rather
 * than polled forever, and a landed run refreshes both reads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";
import { costsApi, notifyCostsChanged, onCostsChanged } from "@/lib/costs/client";
import {
  COSTS_INTEGRATION_KEY,
  COST_DAYS_DEFAULT,
  COST_REFRESH_PRICE_USD,
  formatUsd,
  type CostDailyResponse,
  type CostSummaryResponse,
} from "@/lib/costs/types";
import { integrationsApi } from "@/lib/integrations/client";
import { RUN_STALE_AFTER_MS, type IntegrationRun } from "@/lib/integrations/types";
import { errorMessage } from "@/lib/format";

/** How often a live run is asked about. Same cadence as the Integrations page. */
const POLL_INTERVAL_MS = 2_000;

/** Consecutive failed polls before the page gives up watching. */
const POLL_FAILURES_MAX = 3;

function isLive(run: IntegrationRun): boolean {
  return run.status === "queued" || run.status === "running";
}

/**
 * A run whose heartbeat has gone quiet belongs to a process that restarted
 * under it. The server reports that as `interrupted` on its own schedule; the
 * page reads the same signal so a watcher never spins on a run nobody is
 * working on.
 */
function settle(run: IntegrationRun): IntegrationRun {
  const beat =
    run.status === "queued" ? run.createdAt : (run.heartbeatAt ?? run.startedAt ?? run.createdAt);
  const at = Date.parse(beat);
  if (isLive(run) && !Number.isNaN(at) && Date.now() - at > RUN_STALE_AFTER_MS) {
    return { ...run, status: "interrupted" };
  }
  if (run.status === "failed" && run.error === "interrupted") {
    return { ...run, status: "interrupted" };
  }
  return run;
}

export interface CostData {
  summary: CostSummaryResponse | null;
  daily: CostDailyResponse;
  /** The first load, before anything is on screen. */
  loading: boolean;
  /** Why the reads failed, when they did and there is nothing cached to show. */
  error: string | null;
  /** How many days the series covers; changing it re-reads. */
  days: number;
  setDays: (days: number) => void;
  /** Re-reads both endpoints. Costs nothing — it never calls AWS. */
  reload: () => void;
  /** The live `aws_costs` run, for the progress line. */
  liveRun: IntegrationRun | null;
  /** True while a run is in flight; the button is held. */
  refreshing: boolean;
  /** Starts a run. This is the only thing on the page that spends money. */
  refreshNow: () => void;
}

export function useCostData(): CostData {
  const { notification } = App.useApp();
  const [summary, setSummary] = useState<CostSummaryResponse | null>(null);
  const [daily, setDaily] = useState<CostDailyResponse>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(COST_DAYS_DEFAULT);
  const [tick, setTick] = useState(0);
  const [tracked, setTracked] = useState<IntegrationRun | null>(null);
  const [starting, setStarting] = useState(false);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  /* --------------------------------- Reads -------------------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextSummary, nextDaily] = await Promise.all([
          costsApi.summary(),
          costsApi.daily(days),
        ]);
        if (cancelled) return;
        setSummary(nextSummary);
        setDaily(nextDaily);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days, tick]);

  useEffect(() => onCostsChanged(() => reload()), [reload]);

  /* ------------------------------- The run -------------------------------- */

  // What is being followed, else what the summary reported. A run a poll has
  // answered about is the fresher reading.
  const liveRun = useMemo(() => {
    const candidate = tracked ?? summary?.lastRun ?? null;
    if (candidate === null) return null;
    const settled = settle(candidate);
    return isLive(settled) ? settled : null;
  }, [tracked, summary]);

  /** The notification a finished run earns, and the reload that follows it. */
  const reportedRef = useRef<string | null>(null);
  const report = useCallback(
    (finished: IntegrationRun) => {
      if (reportedRef.current === finished.id) return;
      reportedRef.current = finished.id;

      if (finished.status === "interrupted") {
        notification.warning({
          title: "The cost refresh was interrupted",
          description:
            "The server restarted during the run; whatever it had already written is kept. " +
            "Run it again to finish.",
          duration: 8,
        });
      } else if (finished.status === "failed") {
        notification.error({
          title: "The cost refresh failed",
          description: finished.error ?? "The run stopped before it finished.",
          duration: 0,
        });
      } else {
        notification.success({
          title: "Costs refreshed",
          description:
            `${finished.processed} of ${finished.total ?? finished.processed} AWS calls answered · ` +
            `${finished.created + finished.updated} daily rows written.`,
          duration: 6,
        });
      }

      setTracked(null);
      notifyCostsChanged("summary");
    },
    [notification],
  );

  const runId = liveRun?.id ?? null;

  useEffect(() => {
    if (runId === null) return;
    let stopped = false;
    let inFlight = false;
    let failures = 0;

    const timer = setInterval(() => {
      if (stopped || inFlight) return;
      inFlight = true;
      void integrationsApi
        .run(COSTS_INTEGRATION_KEY, runId)
        .then((run) => {
          if (stopped) return;
          failures = 0;
          const settled = settle(run);
          setTracked(settled);
          if (!isLive(settled)) {
            stopped = true;
            clearInterval(timer);
            report(settled);
          }
        })
        .catch((cause: unknown) => {
          if (stopped) return;
          failures += 1;
          if (failures < POLL_FAILURES_MAX) return;
          stopped = true;
          clearInterval(timer);
          notification.error({
            title: "Lost track of the refresh",
            description: `${errorMessage(cause)} The run carries on on the server; reload to see where it got to.`,
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
  }, [runId, report, notification]);

  const refreshNow = useCallback(() => {
    setStarting(true);
    void integrationsApi
      .start(COSTS_INTEGRATION_KEY)
      .then((run) => {
        reportedRef.current = null;
        const settled = settle(run);
        if (isLive(settled)) setTracked(settled);
        else report(settled);
      })
      .catch((cause: unknown) => {
        notification.error({
          // 409 while a run is already live, 422 if the integration is not
          // installed, 403 without can_write_integrations. The server's own
          // sentence says which.
          title: "The refresh could not be started",
          description: errorMessage(cause),
          duration: 8,
        });
      })
      .finally(() => setStarting(false));
  }, [notification, report]);

  return {
    summary,
    daily,
    loading,
    error,
    days,
    setDays,
    reload,
    liveRun,
    refreshing: starting || liveRun !== null,
    refreshNow,
  };
}

/** The sentence the page prints beside "Refresh now". */
export const REFRESH_PRICE_NOTE =
  `Asks AWS again: about ${formatUsd(COST_REFRESH_PRICE_USD)} in Cost Explorer requests. ` +
  "The daily job does this on its own at 09:00 Toronto time.";
