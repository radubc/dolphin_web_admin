"use client";

/**
 * State for the Customers screen's Activity view: one read, one range knob,
 * and the one write the view can make.
 *
 * The write is not a write to any of the figures — nothing in the browser can
 * change them. It starts a run of the `cognito_directory` integration through
 * the endpoint the Integrations page already uses, which takes a fresh
 * snapshot of the Cognito pool and re-reads the CloudWatch counters. That is
 * the same arrangement the Cost center has, and for the same reason: one job,
 * one way to start it, one run history. The difference is the price — a
 * cost refresh spends about $0.05 at Cost Explorer, and this one is free, so
 * the button carries no warning.
 *
 * **The two range knobs do not always cost a request.** The endpoint is the
 * most expensive read in the console, and a payload for a wide window already
 * contains every narrower one: a 24-month, 90-day answer holds the 6-month,
 * 14-day answer as a suffix. So the payload the browser has is kept, and a
 * knob that only narrows it is served by cutting it down (`narrowStatistics`
 * in `src/lib/customers/window.ts`). Widening, Refresh, and a payload older
 * than {@link PAYLOAD_TTL_MS} all still ask the server — Refresh especially,
 * because that is the button's whole meaning.
 *
 * The polling follows `src/components/cost-center/use-cost-data.ts` closely:
 * a reload rejoins a run that was already going, a run whose heartbeat has
 * gone quiet is reported as interrupted rather than polled forever, and a
 * landed run re-reads the figures. It is a copy rather than a shared hook for
 * the reason that file gives — the generic run-watcher needs the whole
 * `Integration[]` list on screen, which this page does not have and should not
 * fetch to draw one button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App } from "antd";
import {
  customersApi,
  notifyCustomersChanged,
  onCustomersChanged,
} from "@/lib/customers/client";
import {
  DIRECTORY_INTEGRATION_KEY,
  STATISTICS_DAYS_DEFAULT,
  STATISTICS_MONTHS_DEFAULT,
  type CustomerStatistics,
} from "@/lib/customers/types";
import { coversWindow, narrowStatistics } from "@/lib/customers/window";
import { integrationsApi } from "@/lib/integrations/client";
import { RUN_STALE_AFTER_MS, type IntegrationRun } from "@/lib/integrations/types";
import { errorMessage } from "@/lib/format";

/** How often a live run is asked about. Same cadence as the other pages. */
const POLL_INTERVAL_MS = 2_000;

/**
 * How long a fetched payload may be narrowed instead of re-fetched.
 *
 * The same ten minutes the server caches its expensive parts for
 * (`CUSTOMER_STATS_CACHE_TTL_MS` in `src/lib/customers/statistics.ts`), so a
 * tab left open does not narrow an hour-old answer into something that looks
 * current. Refresh ignores it entirely.
 */
const PAYLOAD_TTL_MS = 10 * 60 * 1000;

/** Consecutive failed polls before the view gives up watching. */
const POLL_FAILURES_MAX = 3;

/** The month windows the view offers. */
export const STATISTICS_MONTH_OPTIONS = [
  { value: 3, label: "3 months" },
  { value: STATISTICS_MONTHS_DEFAULT, label: "6 months" },
  { value: 12, label: "12 months" },
  { value: 24, label: "24 months" },
] as const;

/** The day windows the two daily charts offer. */
export const STATISTICS_DAY_OPTIONS = [
  { value: 14, label: "14 days" },
  { value: STATISTICS_DAYS_DEFAULT, label: "35 days" },
  { value: 90, label: "90 days" },
] as const;

function isLive(run: IntegrationRun): boolean {
  return run.status === "queued" || run.status === "running";
}

/**
 * A run whose heartbeat has gone quiet belongs to a process that restarted
 * under it. The server reports that as `interrupted` on its own schedule; the
 * view reads the same signal so a watcher never spins on a run nobody is
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

export interface CustomerStatisticsStore {
  statistics: CustomerStatistics | null;
  /** The first load, before anything is on screen. */
  loading: boolean;
  /** A re-read over figures that are still on screen. */
  refreshing: boolean;
  /** Why the read failed, when it did and there is nothing cached to show. */
  error: string | null;
  months: number;
  setMonths: (months: number) => void;
  days: number;
  setDays: (days: number) => void;
  /** Re-reads the endpoint. Costs nothing — it never calls AWS. */
  reload: () => void;
  /** The live `cognito_directory` run, for the progress line. */
  liveRun: IntegrationRun | null;
  /** True while a run is in flight; the button is held. */
  snapshotting: boolean;
  /** Takes a fresh snapshot of the pool. Free. */
  snapshotNow: () => void;
}

export function useCustomerStatistics(): CustomerStatisticsStore {
  const { notification } = App.useApp();
  const [fetched, setFetched] = useState<CustomerStatistics | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [months, setMonths] = useState<number>(STATISTICS_MONTHS_DEFAULT);
  const [days, setDays] = useState<number>(STATISTICS_DAYS_DEFAULT);
  const [tick, setTick] = useState(0);
  const [tracked, setTracked] = useState<IntegrationRun | null>(null);
  const [starting, setStarting] = useState(false);

  /**
   * When the held payload was fetched. A ref, not state, so the read effect
   * can consult it without depending on it (which would make it re-run on
   * every answer it produced).
   */
  const fetchedAtRef = useRef<number | null>(null);

  const reload = useCallback(() => {
    // Refresh means "ask the server", so the held payload stops counting as
    // an answer to anything.
    fetchedAtRef.current = null;
    setTick((value) => value + 1);
  }, []);

  /* --------------------------------- Read --------------------------------- */

  /**
   * True when the payload already on hand answers the window asked for, so
   * the read below has nothing to do.
   */
  const covered = fetched !== null && coversWindow(fetched, months, days);

  useEffect(() => {
    const held = fetchedAtRef.current;
    if (covered && held !== null && Date.now() - held < PAYLOAD_TTL_MS) {
      // Covered by what is already here: the knob only narrowed the window,
      // and `narrowStatistics` below does the rest. `setPending(false)`
      // matters — a fetch this effect replaced left it true.
      setPending(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      setPending(true);
      try {
        const response = await customersApi.statistics({ months, days });
        if (cancelled) return;
        setFetched(response);
        fetchedAtRef.current = Date.now();
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `covered` is derived from the held payload and the two knobs, so it is
    // listed rather than the payload itself: depending on the payload would
    // re-run this effect with every answer it produced.
  }, [months, days, covered, tick]);

  /**
   * What the view draws: the fetched payload cut to the window asked for.
   *
   * Identical to the payload whenever the two windows match, which is the
   * case immediately after every fetch.
   */
  const statistics = useMemo(
    () => (fetched === null ? null : narrowStatistics(fetched, months, days)),
    [fetched, months, days],
  );

  useEffect(
    () =>
      onCustomersChanged((scope) => {
        // An invitation changes the funnel's first step and writes an
        // `invited` event, so this view listens for that scope too.
        if (scope === "statistics" || scope === "invites") reload();
      }),
    [reload],
  );

  /* -------------------------------- The run ------------------------------- */

  const liveRun = useMemo(() => {
    if (tracked === null) return null;
    const settled = settle(tracked);
    return isLive(settled) ? settled : null;
  }, [tracked]);

  const reportedRef = useRef<string | null>(null);
  const report = useCallback(
    (finished: IntegrationRun) => {
      if (reportedRef.current === finished.id) return;
      reportedRef.current = finished.id;

      if (finished.status === "interrupted") {
        notification.warning({
          title: "The snapshot was interrupted",
          description:
            "The server restarted during the run; whatever it had already written is kept. " +
            "Run it again to finish.",
          duration: 8,
        });
      } else if (finished.status === "failed") {
        notification.error({
          title: "The snapshot failed",
          description: finished.error ?? "The run stopped before it finished.",
          duration: 0,
        });
      } else {
        notification.success({
          title: "Directory snapshot taken",
          description:
            `${finished.processed} of ${finished.total ?? finished.processed} parts done · ` +
            `${finished.created} rows written` +
            (finished.unchanged > 0 ? ` · ${finished.unchanged} accounts unchanged` : ""),
          duration: 6,
        });
      }

      setTracked(null);
      notifyCustomersChanged("statistics");
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
        .run(DIRECTORY_INTEGRATION_KEY, runId)
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
            title: "Lost track of the snapshot",
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

  const snapshotNow = useCallback(() => {
    setStarting(true);
    void integrationsApi
      .start(DIRECTORY_INTEGRATION_KEY)
      .then((run) => {
        reportedRef.current = null;
        const settled = settle(run);
        if (isLive(settled)) setTracked(settled);
        else report(settled);
      })
      .catch((cause: unknown) => {
        notification.error({
          // 409 while a run is already live, 404 before
          // docs/sql/014_customer_statistics.sql has seeded the integration,
          // 403 without can_write_integrations. The server's own sentence
          // says which.
          title: "The snapshot could not be started",
          description: errorMessage(cause),
          duration: 8,
        });
      })
      .finally(() => setStarting(false));
  }, [notification, report]);

  return {
    statistics,
    loading: pending && statistics === null,
    refreshing: pending && statistics !== null,
    error,
    months,
    setMonths,
    days,
    setDays,
    reload,
    liveRun,
    snapshotting: starting || liveRun !== null,
    snapshotNow,
  };
}
