/**
 * The browser's typed calls to `/api/v1/admin/costs*`. Client-safe: no
 * `server-only` imports, only `apiFetch` and the plain types.
 *
 * Both calls are reads, because the Cost center has no writes of its own: the
 * one thing an operator can change is *when the cache was filled*, and that
 * is a run of the `aws_costs` integration, started through
 * `integrationsApi.start("aws_costs")` and followed with the same polling the
 * Integrations page uses. Nothing here duplicates that.
 *
 * The change announcement follows the same shape as the customers and
 * integrations clients — a scope on a `window` event — so a refresh that
 * lands can tell both halves of the page to reload without either of them
 * knowing about the other. `notifyCostsChanged` is called by whatever
 * observed the run finish, not by these reads.
 */
import { apiFetch } from "@/lib/api/client";
import { COST_DAYS_DEFAULT, type CostDailyResponse, type CostSummaryResponse } from "./types";

const BASE = "/api/v1/admin/costs";

/** Which part of the page a change touched. */
export type CostsScope = "summary" | "daily";

/** Fired on `window` after an `aws_costs` run lands. */
export const COSTS_CHANGED_EVENT = "penny-squeeze:costs-changed";

export function notifyCostsChanged(scope: CostsScope): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<CostsScope>(COSTS_CHANGED_EVENT, { detail: scope }));
  }
}

/** Subscribes to change announcements; returns the unsubscribe. */
export function onCostsChanged(listener: (scope: CostsScope) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => listener((event as CustomEvent<CostsScope>).detail);
  window.addEventListener(COSTS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(COSTS_CHANGED_EVENT, handler);
}

export const costsApi = {
  /**
   * The newest snapshot with the per-service and per-component breakdowns and
   * the last run. 503 `admin_schema_missing` until
   * `docs/sql/013_aws_costs.sql` has been run; every field is null or empty
   * until the job has succeeded once.
   */
  summary: () => apiFetch<CostSummaryResponse>(BASE),

  /** The daily series for the last `days` days, ending yesterday. */
  daily: (days: number = COST_DAYS_DEFAULT) =>
    apiFetch<CostDailyResponse>(`${BASE}/daily?days=${encodeURIComponent(String(days))}`),
};
