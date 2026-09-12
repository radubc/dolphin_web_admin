"use client";

/**
 * What the three cost-per-client surfaces read, and the one place the endpoint
 * is called from the browser.
 *
 * The surfaces are the Cost center's rail card and its "see all" drawer, and —
 * on another page entirely — the Customers list's "Cost (est.)" column and the
 * customer drawer's cost breakdown. All four ask the same endpoint,
 * `GET /api/v1/admin/costs/per-client?month=`, which answers a whole month in
 * one small payload: a few dozen tenants, each a handful of numbers.
 *
 * Two decisions here, both about the Customers page:
 *
 * - **One request for the whole column, and one per month per five minutes.**
 *   The list is server-paged and its query is deliberately bounded, so the
 *   cost column must not add a lookup per row, nor a join into another
 *   database. Instead the month's allocation is fetched once and a customer's
 *   estimate is the sum over the tenants the row already carries. A tenant
 *   with no row is 0, not unknown: the allocation covers every tenant the
 *   month concerned. The month payloads are then held in a module-level cache
 *   ({@link PER_CLIENT_CACHE_TTL_MS}) shared by every surface, so opening ten
 *   customer drawers does not re-read ten whole months — see the cache note
 *   below.
 * - **It is best-effort.** An operator may hold the Customers actions without
 *   holding a cost action, in which case this endpoint answers 403 — and until
 *   `docs/sql/015_cost_allocation.sql` has run it answers 503. Neither is
 *   something the customer list should break, or even complain, about: the
 *   column simply says "—" and the tooltip says why. That is what
 *   `available` is for.
 *
 * Client-safe: `apiFetch`, the plain wire types (type-only, so nothing
 * server-side is bundled) and the two formatting helpers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { CostPerClientResponse } from "@/lib/costs/allocation";
import { formatMonth, monthOf, shiftMonth, todayUtc } from "@/lib/costs/calendar";
import { errorMessage } from "@/lib/format";

const BASE = "/api/v1/admin/costs/per-client";

/** How many months the pickers offer. Half a year of history is plenty. */
export const PER_CLIENT_MONTHS = 6;

/** How many months the customer drawer shows side by side. */
export const PER_CLIENT_DRAWER_MONTHS = 2;

/** How many tenants the rail card lists before "See all". */
export const PER_CLIENT_TOP = 10;

/** The sentence every surface uses to say what these figures are. */
export const ALLOCATION_NOTE =
  "An allocated estimate, not a bill. AWS charges per resource and every resource except " +
  "an S3 object is shared by all tenants, so the month's spend is split into four pools — " +
  "shared capacity, storage, data transfer and Cognito — and divided over the tenants by " +
  "measured usage: requests and sync rows, attachment bytes plus an estimated row footprint, " +
  "and active users. Every tenant still live at the end of the month carries a small floor of " +
  "the shared capacity even if it was dormant, because the capacity was there for it; the floors " +
  "together take at most half the pool, so measured usage always decides the rest.";

/** One month's allocation, straight from the endpoint. */
export function fetchPerClient(month: string): Promise<CostPerClientResponse> {
  return apiFetch<CostPerClientResponse>(`${BASE}?month=${encodeURIComponent(month)}`);
}

/* -------------------------------------------------------------------------- */
/* The shared month cache                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How long a month's payload is reused across surfaces.
 *
 * The figure behind it moves once a night (the `allocate_costs` run at 03:30
 * Toronto), so five minutes is far shorter than the data's own resolution and
 * cannot mislead anyone. What it buys is real: the customer drawer asks for
 * **two whole months** every time it opens, and without a cache a session
 * spent opening one customer after another re-downloads the same two month
 * tables per click, each one a row per tenant.
 */
export const PER_CLIENT_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  at: number;
  answer: Promise<CostPerClientResponse>;
}

/**
 * Month key to its in-flight or settled answer.
 *
 * Module level, so the Customers list's column and the customer drawer's
 * breakdown share one entry per month — they are the same request — and two
 * components mounting at once share the *promise* rather than making two
 * requests. A **rejection is never cached**: a 403 that becomes a grant, or a
 * 503 that becomes a migration, must be visible on the next read rather than
 * in five minutes.
 */
const monthCache = new Map<string, CacheEntry>();

/**
 * One month's allocation, from the cache when it is fresh enough.
 *
 * `fresh: true` drops the entry first, which is what an explicit reload
 * control means.
 */
export function readPerClient(
  month: string,
  options: { fresh?: boolean } = {},
): Promise<CostPerClientResponse> {
  const now = Date.now();
  if (options.fresh === true) monthCache.delete(month);
  const hit = monthCache.get(month);
  if (hit !== undefined && now - hit.at < PER_CLIENT_CACHE_TTL_MS) return hit.answer;

  const answer = fetchPerClient(month).catch((cause: unknown) => {
    if (monthCache.get(month)?.answer === answer) monthCache.delete(month);
    throw cause;
  });
  monthCache.set(month, { at: now, answer });
  return answer;
}

/** Forgets every cached month. For a surface that has just changed the data. */
export function clearPerClientCache(): void {
  monthCache.clear();
}

/* -------------------------------------------------------------------------- */
/* Months                                                                     */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM` for a UTC instant. */
function monthKey(at: Date): string {
  return monthOf(todayUtc(at));
}

/**
 * The last `count` months, newest first, as `YYYY-MM`.
 *
 * UTC, like every other figure in this console, and computed in the browser
 * rather than asked for: the server measures months the same way — the same
 * `dayjs.utc` helpers from `@/lib/costs/calendar`, which is why there is no
 * second copy of the month arithmetic here — so the two agree without a round
 * trip. (The allocator walks the same months server-side and oldest-first,
 * because it recomputes them in order.)
 */
export function recentMonthKeys(count: number, now: Date = new Date()): string[] {
  const current = monthKey(now);
  return Array.from({ length: count }, (_value, back) => shiftMonth(current, -back));
}

/** The same, as antd `Select` options labelled "September 2026". */
export function monthOptions(
  count: number = PER_CLIENT_MONTHS,
  now: Date = new Date(),
): { value: string; label: string }[] {
  return recentMonthKeys(count, now).map((month) => ({
    value: month,
    label: formatMonth(month),
  }));
}

/** The current UTC month, which every picker starts on. */
export function currentMonthKey(now: Date = new Date()): string {
  return monthKey(now);
}

/* -------------------------------------------------------------------------- */
/* One month, for the Cost center                                             */
/* -------------------------------------------------------------------------- */

export interface PerClientState {
  month: string;
  setMonth: (month: string) => void;
  data: CostPerClientResponse | null;
  loading: boolean;
  /** Why the read failed, when it did. */
  error: string | null;
  reload: () => void;
}

/**
 * One month of the allocation, with the month a piece of page state.
 *
 * A month that has never been allocated is not an error: the endpoint answers
 * the pool totals it can read with an empty tenant list and
 * `computedAt: null`, and the card says "not computed yet".
 */
export function usePerClient(initialMonth: string = currentMonthKey()): PerClientState {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<CostPerClientResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Which `tick` the last read used, so "the tick moved" can be told from
  // "the month changed": only the former is a deliberate reload.
  const readTick = useRef(0);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const fresh = readTick.current !== tick;
    readTick.current = tick;
    let cancelled = false;
    void (async () => {
      // Inside the async body, not before it: a synchronous setState in an
      // effect body costs a cascading render, and the lint rule says so.
      setLoading(true);
      try {
        // A reload must go past the shared cache; mounting and switching
        // months may be served from it.
        const next = await readPerClient(month, { fresh });
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setError(errorMessage(cause));
        // The previous month's answer is dropped: showing September's rows
        // under an October heading would be worse than showing none.
        setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [month, tick]);

  return { month, setMonth, data, loading, error, reload };
}

/* -------------------------------------------------------------------------- */
/* Several months, for the Customers page                                     */
/* -------------------------------------------------------------------------- */

/** A month's allocation indexed by tenant, for summing over a customer's tenants. */
export interface MonthCostIndex {
  month: string;
  /** Tenant id to its allocated total for the month, in USD. */
  totals: Map<string, number>;
  /** Tenant id to its four components, for the drawer. */
  rows: Map<
    string,
    { fixedUsd: number; storageUsd: number; requestUsd: number; userUsd: number; totalUsd: number }
  >;
  monthTotalUsd: number;
  computedAt: string | null;
}

export interface TenantCostState {
  months: MonthCostIndex[];
  loading: boolean;
  /**
   * False when the figures cannot be read at all — the SQL has not run, or
   * this operator holds no cost action. The surfaces then show "—" and say
   * why rather than treating it as a failure.
   */
  available: boolean;
  /** Why it is unavailable, for a tooltip. Null while it is available. */
  reason: string | null;
  /**
   * True when the newest month read exists but has never been allocated
   * (`computedAt === null`). The figures are then unknown rather than zero,
   * and {@link TenantCostState.totalFor} answers null.
   */
  notComputed: boolean;
  /**
   * The allocated total for a set of tenants in the newest month read, or
   * **null when there is no figure**: nothing read yet, or the month has not
   * been allocated. Null means "—", never $0.00.
   */
  totalFor: (tenantIds: readonly string[]) => number | null;
}

/** What a surface says when the newest month has not been allocated yet. */
export const NOT_COMPUTED_NOTE =
  "This month has not been allocated yet; the nightly allocate_costs run writes it (03:30 " +
  "Toronto time), or press Run now on the Cost allocation integration.";

function indexOf(response: CostPerClientResponse): MonthCostIndex {
  return {
    month: response.month,
    totals: new Map(response.tenants.map((tenant) => [tenant.tenantId, tenant.totalUsd])),
    rows: new Map(
      response.tenants.map((tenant) => [
        tenant.tenantId,
        {
          fixedUsd: tenant.fixedUsd,
          storageUsd: tenant.storageUsd,
          requestUsd: tenant.requestUsd,
          userUsd: tenant.userUsd,
          totalUsd: tenant.totalUsd,
        },
      ]),
    ),
    monthTotalUsd: response.monthTotalUsd,
    computedAt: response.computedAt,
  };
}

/**
 * The last `count` months of the allocation, indexed by tenant.
 *
 * `count` requests at most, each a small payload — not one per customer and
 * not one per tenant. The Customers list asks for one month (the column), the
 * customer drawer for two (the breakdown), and both go through
 * {@link readPerClient}: a drawer opened a second time inside
 * {@link PER_CLIENT_CACHE_TTL_MS} costs nothing, and the month the list has
 * already read is shared rather than fetched again.
 *
 * A failure is reported as `available: false` with the server's own sentence,
 * never thrown: nothing on the Customers page depends on these figures.
 */
export function useTenantCosts(count: number = 1): TenantCostState {
  const [months, setMonths] = useState<MonthCostIndex[]>([]);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState<string | null>(null);

  const keys = useMemo(() => recentMonthKeys(count).join(","), [count]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const answers = await Promise.all(keys.split(",").map((month) => readPerClient(month)));
        if (cancelled) return;
        setMonths(answers.map(indexOf));
        setReason(null);
      } catch (cause) {
        if (cancelled) return;
        setMonths([]);
        setReason(errorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keys]);

  const newest = months[0];
  // A month nobody has allocated yet has no figures at all, and $0.00 would
  // be a measurement we do not have. The same check the customer drawer's
  // breakdown makes per month (`cost-per-client-figures.tsx`), so the column
  // and the drawer say the same thing about the same month.
  const notComputed = newest !== undefined && newest.computedAt === null;

  const totalFor = useCallback(
    (tenantIds: readonly string[]): number | null => {
      if (newest === undefined || newest.computedAt === null) return null;
      // A tenant with no row is 0, not unknown: the allocation covers every
      // tenant the month concerned, so an absence means "nothing was charged
      // to it" — a brand-new tenant, or a month the bill predates.
      return tenantIds.reduce((total, id) => total + (newest.totals.get(id) ?? 0), 0);
    },
    [newest],
  );

  return {
    months,
    loading,
    available: months.length > 0,
    reason,
    notComputed,
    totalFor,
  };
}
