"use client";

/**
 * The Constants screen's state: which catalog is on show, its rows and their
 * push state, the filters over them, and the ticked rows.
 *
 * One kind is loaded at a time — the four catalogs are independent and each
 * comparison against the main app database costs a query there — plus the
 * currency list whenever countries are on screen, because a country's currency
 * is an id that has to be read as `CAD · Canadian dollar`.
 *
 * Every write goes through `constantsApi`, which announces itself on `window`;
 * the store listens and reloads, so a create, an edit, a delete and a push all
 * refresh the same way and the ribbon never has to thread a callback through.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { constantsApi, onConstantsChanged } from "@/lib/constants/client";
import type {
  CategoryRow,
  ConstantKind,
  ConstantListResponse,
  ConstantRow,
  CurrencyRow,
  PushState,
} from "@/lib/constants/types";
import { errorMessage } from "@/lib/format";
import { categoryPath, currencyLabel, isRetired } from "./constants-meta";

/** A loaded catalog, discriminated by `kind` so a table can narrow its rows. */
export type ConstantList = { [K in ConstantKind]: ConstantListResponse<K> }[ConstantKind];

/** The push-state segment above the table. `retired` only exists for categories. */
export type StateFilter = "all" | PushState | "retired";

export interface ConstantCounts {
  total: number;
  new: number;
  changed: number;
  synced: number;
  retired: number;
}

/**
 * The typed fetch. A generic call with a union `kind` would widen the response
 * to a union of row *arrays*, which no longer narrows; switching keeps each
 * branch concrete.
 */
function loadList(kind: ConstantKind): Promise<ConstantList> {
  switch (kind) {
    case "countries":
      return constantsApi.list("countries");
    case "currencies":
      return constantsApi.list("currencies");
    case "financial_institutions":
      return constantsApi.list("financial_institutions");
    case "categories":
      return constantsApi.list("categories");
  }
}

function matchesState(row: ConstantRow, filter: StateFilter): boolean {
  if (filter === "all") return true;
  if (filter === "retired") return isRetired(row);
  // Retired rows keep a push state, but they belong to their own bucket: a
  // "Not pushed" filter that hands back retired rows reads as a bug.
  return row.pushState === filter && !isRetired(row);
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

/**
 * Narrows a loaded catalog to what the search box and the state segment leave,
 * keeping the discriminated union intact.
 */
function filterList(
  list: ConstantList,
  search: string,
  stateFilter: StateFilter,
  currencies: readonly CurrencyRow[],
): ConstantList {
  const needle = search.trim().toLowerCase();

  switch (list.kind) {
    case "countries":
      return {
        ...list,
        rows: list.rows.filter(
          (row) =>
            matchesState(row, stateFilter) &&
            (needle === "" ||
              contains(
                `${row.name} ${row.alpha2Code} ${row.alpha3Code} ${currencyLabel(row.currencyId, currencies)}`,
                needle,
              )),
        ),
      };
    case "currencies":
      return {
        ...list,
        rows: list.rows.filter(
          (row) =>
            matchesState(row, stateFilter) &&
            (needle === "" || contains(`${row.code} ${row.name} ${row.symbol ?? ""}`, needle)),
        ),
      };
    case "financial_institutions":
      return {
        ...list,
        rows: list.rows.filter(
          (row) =>
            matchesState(row, stateFilter) &&
            (needle === "" || contains(`${row.name} ${row.institutionNumber} ${row.type}`, needle)),
        ),
      };
    case "categories": {
      const all = list.rows;
      return {
        ...list,
        rows: all.filter(
          (row) =>
            matchesState(row, stateFilter) &&
            (needle === "" || contains(`${categoryPath(row, all)} ${row.type ?? ""}`, needle)),
        ),
      };
    }
  }
}

/** The rows of any loaded catalog, as the common row type. */
function rowsOf(list: ConstantList): ConstantRow[] {
  return list.rows;
}

function countOf(rows: readonly ConstantRow[]): ConstantCounts {
  const counts: ConstantCounts = { total: rows.length, new: 0, changed: 0, synced: 0, retired: 0 };
  for (const row of rows) {
    // A retired row belongs to its own bucket, not to the push-state bucket it
    // also carries: counting it in both makes the rail's bars sum past the
    // catalog's total.
    if (isRetired(row)) {
      counts.retired += 1;
    } else {
      counts[row.pushState] += 1;
    }
  }
  return counts;
}

export interface ConstantsStore {
  kind: ConstantKind;
  setKind: (kind: ConstantKind) => void;

  /** Everything the kind has, before the filters. */
  list: ConstantList | null;
  /** What the filters leave, same shape. */
  visible: ConstantList | null;
  counts: ConstantCounts;
  /** For the country column and the country form; the currency catalog itself when that kind is on show. */
  currencies: CurrencyRow[];
  /** For the parent column and the category form. */
  categories: CategoryRow[];
  /** Distinct institution types already in use, for the form's autocomplete. */
  institutionTypes: string[];

  loading: boolean;
  error: string | null;
  /** Set when the currency catalog failed to load alongside countries; `currencies` still falls back to `[]`. */
  currenciesError: string | null;
  reload: () => void;
  /** True from the moment `reload` is called until the fetch it started settles; distinct from `loading`, which blanks the table. */
  refreshing: boolean;

  search: string;
  setSearch: (search: string) => void;
  stateFilter: StateFilter;
  setStateFilter: (filter: StateFilter) => void;
  filtersActive: boolean;
  clearFilters: () => void;

  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  /** The ticked rows the filters still show: what a bulk action acts on. */
  selectedVisibleIds: string[];
}

export function useConstantsStore(initialKind: ConstantKind): ConstantsStore {
  const [kind, setKindState] = useState<ConstantKind>(initialKind);
  const [list, setList] = useState<ConstantList | null>(null);
  const [loadedCurrencies, setLoadedCurrencies] = useState<CurrencyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currenciesError, setCurrenciesError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const reload = useCallback(() => {
    // Loading blanks the table; a refresh must not, so it gets its own flag
    // for the ribbon button to show while the fetch is in flight.
    setRefreshing(true);
    setTick((value) => value + 1);
  }, []);

  const setKind = useCallback(
    (next: ConstantKind) => {
      if (next === kind) return;
      // A selection, a search and a state segment all mean something about the
      // catalog that was on screen; none of them carries over.
      setKindState(next);
      setList(null);
      setLoading(true);
      setSearch("");
      setStateFilter("all");
      setSelectedIds([]);
    },
    [kind],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setError(null);
      setCurrenciesError(null);
      try {
        // Countries show and edit a currency, so that catalog comes along.
        // Its failure must not fail the country load: it falls back to `[]`,
        // but the failure is recorded so the page and the drawer can say so.
        const currencyPromise: Promise<CurrencyRow[]> =
          kind === "countries"
            ? constantsApi
                .list("currencies")
                .then((response) => response.rows)
                .catch((cause) => {
                  if (!cancelled) setCurrenciesError(errorMessage(cause));
                  return [];
                })
            : Promise.resolve([]);
        const [nextList, nextCurrencies] = await Promise.all([loadList(kind), currencyPromise]);
        if (cancelled) return;
        setList(nextList);
        setLoadedCurrencies(nextCurrencies);
      } catch (cause) {
        // A failed *refresh* keeps what is on screen and says so above the
        // table; only a first load (or a kind switch, which clears the list)
        // leaves nothing to show, and then the page shows the error itself.
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, tick]);

  // Any write anywhere in the app (this page's drawer, a push, another tab of
  // the same app) reloads what is on screen.
  useEffect(() => onConstantsChanged(reload), [reload]);

  const currencies = useMemo<CurrencyRow[]>(
    () => (list !== null && list.kind === "currencies" ? list.rows : loadedCurrencies),
    [list, loadedCurrencies],
  );

  const categories = useMemo<CategoryRow[]>(
    () => (list !== null && list.kind === "categories" ? list.rows : []),
    [list],
  );

  const institutionTypes = useMemo<string[]>(() => {
    if (list === null || list.kind !== "financial_institutions") return [];
    return [...new Set(list.rows.map((row) => row.type.trim()).filter((type) => type !== ""))].sort();
  }, [list]);

  const visible = useMemo(
    () => (list === null ? null : filterList(list, search, stateFilter, currencies)),
    [list, search, stateFilter, currencies],
  );

  const counts = useMemo<ConstantCounts>(
    () => countOf(list === null ? [] : rowsOf(list)),
    [list],
  );

  const selectedVisibleIds = useMemo(() => {
    if (visible === null) return [];
    const shown = new Set(rowsOf(visible).map((row) => row.id));
    return selectedIds.filter((id) => shown.has(id));
  }, [visible, selectedIds]);

  const filtersActive = search.trim() !== "" || stateFilter !== "all";

  const clearFilters = useCallback(() => {
    setSearch("");
    setStateFilter("all");
  }, []);

  return {
    kind,
    setKind,
    list,
    visible,
    counts,
    currencies,
    categories,
    institutionTypes,
    loading,
    error,
    currenciesError,
    reload,
    refreshing,
    search,
    setSearch,
    stateFilter,
    setStateFilter,
    filtersActive,
    clearFilters,
    selectedIds,
    setSelectedIds,
    selectedVisibleIds,
  };
}
