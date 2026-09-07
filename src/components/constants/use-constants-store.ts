"use client";

/**
 * The Constants screen's state: which catalog is on show, the *page* of it the
 * table is drawing, the query that page answers, and the ticked rows.
 *
 * The catalogs run to hundreds of thousands of rows (stocks, ETFs, crypto
 * pairs), so nothing here loads a whole one. The store holds a `ListQuery` —
 * page, page size, search text and the push-state filter — and the server
 * answers with that page plus whole-catalog figures (`counts`), the last
 * compare time and the most recent job. Search is debounced by 300 ms and any
 * change to the query drops back to page 1, so a filtered result never opens on
 * a page that no longer exists.
 *
 * Three lookup catalogs are still read in full, because a label needs the row
 * the page does not carry: currencies for the country column and form, account
 * base types for the account-type column and form, and the category tree for
 * `Parent › Child`. They are small by nature and are read in pages of
 * `LIST_PAGE_SIZE_MAX` up to `LOOKUP_MAX_ROWS`; past that the label degrades to
 * the id rather than the page hanging on a runaway fetch.
 *
 * Every write goes through `constantsApi`, which announces itself on `window`;
 * the store listens and reloads, so a create, an edit, a delete, a push and a
 * finished job all refresh the same way and the ribbon never has to thread a
 * callback through.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { constantsApi, onConstantsChanged } from "@/lib/constants/client";
import type {
  AccountBaseTypeRow,
  CategoryRow,
  ConstantJob,
  ConstantKind,
  ConstantListResponse,
  ConstantRowOf,
  CurrencyRow,
  ListQuery,
  StateCounts,
} from "@/lib/constants/types";
import { LIST_PAGE_SIZE_DEFAULT, LIST_PAGE_SIZE_MAX } from "@/lib/constants/types";
import { errorMessage } from "@/lib/format";

/** A loaded page of a catalog, discriminated by `kind` so a table can narrow its rows. */
export type ConstantList = { [K in ConstantKind]: ConstantListResponse<K> }[ConstantKind];

/**
 * The push-state segment above the table, which is exactly what the list
 * endpoint accepts: `all`, one push state, `pending` (new + changed) or
 * `retired` (only for the kinds that retire — categories, account types,
 * markets).
 */
export type StateFilter = NonNullable<ListQuery["state"]>;

/** The page sizes the table offers. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

/** How long typing settles before the query is sent. */
const SEARCH_DEBOUNCE_MS = 300;

/** The ceiling on a lookup catalog read in full, so a huge one cannot hang the page. */
const LOOKUP_MAX_ROWS = 5000;

const EMPTY_COUNTS: StateCounts = {
  total: 0,
  new: 0,
  changed: 0,
  synced: 0,
  unknown: 0,
  retired: 0,
  mainOnly: 0,
};

/**
 * The typed fetch. A generic call with a union `kind` would widen the response
 * to a union of row *arrays*, which no longer narrows; switching keeps each
 * branch concrete.
 */
function loadList(kind: ConstantKind, query: ListQuery): Promise<ConstantList> {
  switch (kind) {
    case "countries":
      return constantsApi.list("countries", query);
    case "currencies":
      return constantsApi.list("currencies", query);
    case "financial_institutions":
      return constantsApi.list("financial_institutions", query);
    case "categories":
      return constantsApi.list("categories", query);
    case "account_base_types":
      return constantsApi.list("account_base_types", query);
    case "account_types":
      return constantsApi.list("account_types", query);
    case "cryptocurrencies":
      return constantsApi.list("cryptocurrencies", query);
    case "etfs":
      return constantsApi.list("etfs", query);
    case "stocks":
      return constantsApi.list("stocks", query);
    case "markets":
      return constantsApi.list("markets", query);
  }
}

/**
 * Every row of a lookup catalog, page by page. `kind` is a single literal at
 * each call site, so the return type stays the concrete row type.
 */
async function loadLookup<K extends ConstantKind>(kind: K): Promise<ConstantRowOf<K>[]> {
  const rows: ConstantRowOf<K>[] = [];
  let page = 1;
  for (;;) {
    const response = await constantsApi.list(kind, { page, pageSize: LIST_PAGE_SIZE_MAX });
    rows.push(...response.rows);
    if (
      response.rows.length === 0 ||
      rows.length >= response.total ||
      rows.length >= LOOKUP_MAX_ROWS
    ) {
      return rows;
    }
    page += 1;
  }
}

export interface ConstantsStore {
  kind: ConstantKind;
  setKind: (kind: ConstantKind) => void;

  /** The page the table is drawing, or null before the first one lands. */
  list: ConstantList | null;
  /** Whole-catalog figures, not narrowed by the query. */
  counts: StateCounts;
  /** Rows matching the current query, all pages. */
  total: number;
  /** When the last compare job for this kind finished; null before the first. */
  lastComparedAt: string | null;
  /** The newest job for this kind, so the page can resume polling after a reload. */
  latestJob: ConstantJob | null;

  page: number;
  pageSize: number;
  /** From the table's pagination; a new page size always returns to page 1. */
  setPaging: (page: number, pageSize: number) => void;

  /** For the country column and the country form. */
  currencies: CurrencyRow[];
  /** For the account-type column and form. */
  baseTypes: AccountBaseTypeRow[];
  /** The whole category tree, so a child can name a parent the page does not carry. */
  categories: CategoryRow[];
  /** Distinct institution types on the page in view, for the form's autocomplete. */
  institutionTypes: string[];

  /** A first load or a kind switch: there is nothing to show yet. */
  loading: boolean;
  /** A fetch over rows that are still on screen — paging, searching, refreshing. */
  refreshing: boolean;
  error: string | null;
  /** Set when the currency catalog failed to load alongside countries; `currencies` still falls back to `[]`. */
  currenciesError: string | null;
  /** Set when the base-type catalog failed to load alongside account types; `baseTypes` still falls back to `[]`. */
  baseTypesError: string | null;
  reload: () => void;

  /** What is in the box right now; the query follows it after the debounce. */
  search: string;
  setSearch: (search: string) => void;
  stateFilter: StateFilter;
  setStateFilter: (filter: StateFilter) => void;
  filtersActive: boolean;
  clearFilters: () => void;

  /** Kept across pages, so a selection can span them. */
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
  clearSelection: () => void;
}

export function useConstantsStore(initialKind: ConstantKind): ConstantsStore {
  const [kind, setKindState] = useState<ConstantKind>(initialKind);
  const [list, setList] = useState<ConstantList | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(LIST_PAGE_SIZE_DEFAULT);
  const [search, setSearchState] = useState("");
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilterState] = useState<StateFilter>("all");

  const [loadedCurrencies, setLoadedCurrencies] = useState<CurrencyRow[]>([]);
  const [loadedBaseTypes, setLoadedBaseTypes] = useState<AccountBaseTypeRow[]>([]);
  const [loadedCategories, setLoadedCategories] = useState<CategoryRow[]>([]);

  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currenciesError, setCurrenciesError] = useState<string | null>(null);
  const [baseTypesError, setBaseTypesError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // The search box types faster than the server can answer, so the query only
  // follows it once the operator stops. `queryRef` mirrors the query the store
  // last sent, which keeps the timer from resetting the page when the text ends
  // up where it started — and keeps a cleared box from swallowing a repeat of
  // the same search.
  const queryRef = useRef("");

  const reload = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  const setKind = useCallback(
    (next: ConstantKind) => {
      if (next === kind) return;
      // A selection, a search, a page and a state segment all mean something
      // about the catalog that was on screen; none of them carries over.
      setKindState(next);
      setList(null);
      setPage(1);
      setSearchState("");
      setQuery("");
      // The debounce compares against this; leaving the old text in it would
      // swallow the next search for exactly the same words.
      queryRef.current = "";
      setStateFilterState("all");
      setSelectedIds([]);
    },
    [kind],
  );

  const setPaging = useCallback(
    (nextPage: number, nextPageSize: number) => {
      // antd reports both together; a new page size renumbers the catalog, so
      // the only page that still means anything afterwards is the first. A
      // plain page change leaves what is selected alone — cross-page
      // selection is the point — but a page-size change reshuffles which rows
      // fall on which page, so a selection kept past it could no longer be
      // what is on screen.
      setPageSize(nextPageSize);
      if (nextPageSize === pageSize) {
        setPage(nextPage);
        return;
      }
      setPage(1);
      setSelectedIds([]);
    },
    [pageSize],
  );

  const setStateFilter = useCallback((next: StateFilter) => {
    setStateFilterState(next);
    setPage(1);
    // A row ticked under one state filter may not exist under the next; a
    // push must only ever act on rows the operator can still see.
    setSelectedIds([]);
  }, []);

  const clearFilters = useCallback(() => {
    setSearchState("");
    setQuery("");
    queryRef.current = "";
    setStateFilterState("all");
    setPage(1);
    setSelectedIds([]);
  }, []);

  const clearSelection = useCallback(() => setSelectedIds([]), []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (queryRef.current === search.trim()) return;
      queryRef.current = search.trim();
      setQuery(queryRef.current);
      setPage(1);
      // The rows behind a selection made under the old search text may not
      // match the new one; a push must only ever act on rows the operator can
      // still see.
      setSelectedIds([]);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  /* ------------------------------ the page ------------------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPending(true);
      try {
        const next = await loadList(kind, { page, pageSize, q: query, state: stateFilter });
        if (cancelled) return;
        setList(next);
        setError(null);
      } catch (cause) {
        // A failed *refresh* keeps what is on screen and says so above the
        // table; only a first load (or a kind switch, which clears the list)
        // leaves nothing to show, and then the page shows the error itself.
        if (!cancelled) setError(errorMessage(cause));
      } finally {
        if (!cancelled) setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, page, pageSize, query, stateFilter, tick]);

  /* ----------------------------- the lookups ----------------------------- */

  // Keyed on the kind alone: paging through stocks must not re-read the
  // currency catalog. A lookup failure is soft — the column falls back to the
  // id — but it is recorded so the page and the drawer can say so.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setCurrenciesError(null);
      setBaseTypesError(null);
      if (kind === "countries") {
        try {
          const rows = await loadLookup("currencies");
          if (!cancelled) setLoadedCurrencies(rows);
        } catch (cause) {
          if (!cancelled) {
            setCurrenciesError(errorMessage(cause));
            setLoadedCurrencies([]);
          }
        }
      } else if (!cancelled) {
        setLoadedCurrencies([]);
      }

      if (kind === "account_types") {
        try {
          const rows = await loadLookup("account_base_types");
          if (!cancelled) setLoadedBaseTypes(rows);
        } catch (cause) {
          if (!cancelled) {
            setBaseTypesError(errorMessage(cause));
            setLoadedBaseTypes([]);
          }
        }
      } else if (!cancelled) {
        setLoadedBaseTypes([]);
      }

      if (kind === "categories") {
        try {
          const rows = await loadLookup("categories");
          if (!cancelled) setLoadedCategories(rows);
        } catch {
          // The tree is only used for labels and the parent picker; without it
          // a category still reads by its own name.
          if (!cancelled) setLoadedCategories([]);
        }
      } else if (!cancelled) {
        setLoadedCategories([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, tick]);

  // Any write anywhere in the app (this page's drawer, a push, a finished job,
  // another tab of the same app) reloads what is on screen.
  useEffect(() => onConstantsChanged(reload), [reload]);

  const institutionTypes = useMemo<string[]>(() => {
    // The page in view, not the catalog: this only feeds an autocomplete, and
    // reading 300k institutions to fill it would cost far more than it is worth.
    if (list === null || list.kind !== "financial_institutions") return [];
    return [...new Set(list.rows.map((row) => row.type.trim()).filter((type) => type !== ""))].sort();
  }, [list]);

  const counts = list?.counts ?? EMPTY_COUNTS;
  const filtersActive = query !== "" || stateFilter !== "all";

  return {
    kind,
    setKind,
    list,
    counts,
    total: list?.total ?? 0,
    lastComparedAt: list?.lastComparedAt ?? null,
    latestJob: list?.latestJob ?? null,
    page,
    pageSize,
    setPaging,
    currencies: loadedCurrencies,
    baseTypes: loadedBaseTypes,
    categories: loadedCategories,
    institutionTypes,
    loading: pending && list === null,
    refreshing: pending && list !== null,
    error,
    currenciesError,
    baseTypesError,
    reload,
    search,
    setSearch: setSearchState,
    stateFilter,
    setStateFilter,
    filtersActive,
    clearFilters,
    selectedIds,
    setSelectedIds,
    clearSelection,
  };
}
