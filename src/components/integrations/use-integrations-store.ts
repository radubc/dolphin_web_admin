"use client";

/**
 * The Integrations view's state: the three integrations, whether this process
 * runs the scheduler, and the reload every write goes through.
 *
 * There are exactly three integrations and they are never created or removed
 * from the UI, so this list is small enough to read whole — no paging, no
 * filters. `integrationsApi` announces every write on `window`; the store
 * listens for the `integrations` scope and reloads, so an edit, a "Run now" and
 * a finished run all refresh the same way.
 */

import { useCallback, useEffect, useState } from "react";
import { integrationsApi, onIntegrationsChanged } from "@/lib/integrations/client";
import type { Integration } from "@/lib/integrations/types";
import { errorMessage } from "@/lib/format";

export interface IntegrationsStore {
  integrations: Integration[];
  /**
   * Whether this process runs the scheduler. False means nothing starts on its
   * own here, which the page says out loud rather than letting an operator
   * assume a schedule is being kept.
   */
  schedulerActive: boolean;
  /** A first load: there is nothing to show yet. */
  loading: boolean;
  /** A fetch over cards that are still on screen. */
  refreshing: boolean;
  error: string | null;
  /** True once a load has landed; a failed *first* load leaves this false. */
  loaded: boolean;
  reload: () => void;
}

export function useIntegrationsStore(): IntegrationsStore {
  const [integrations, setIntegrations] = useState<Integration[] | null>(null);
  const [schedulerActive, setSchedulerActive] = useState(true);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPending(true);
      try {
        const response = await integrationsApi.list();
        if (cancelled) return;
        setIntegrations(response.integrations);
        setSchedulerActive(response.schedulerActive);
        setError(null);
      } catch (cause) {
        // A failed *refresh* keeps the cards on screen and says so above them;
        // only a failed first load leaves the page with nothing to draw.
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(
    () =>
      onIntegrationsChanged((scope) => {
        // A quote symbol or a currency pair changing says nothing about the
        // integrations themselves; only their own scope reloads this list.
        if (scope === "integrations") reload();
      }),
    [reload],
  );

  return {
    integrations: integrations ?? [],
    schedulerActive,
    loading: pending && integrations === null,
    refreshing: pending && integrations !== null,
    error,
    loaded: integrations !== null,
    reload,
  };
}
