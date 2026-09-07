"use client";

/**
 * State for the two watch lists — the quote symbols and the currency pairs.
 *
 * Both are server-paged: the consumer app adds an item the first time it asks
 * for one, so either list can grow past anything worth holding in the browser.
 * The store keeps a `WatchListQuery` — page, page size, search text and the
 * active filter, plus the kind filter for quotes — and the server answers with
 * that page and the whole-list total. Search is debounced by 300 ms and any
 * change to the query drops back to page 1, so a filtered result never opens on
 * a page that no longer exists.
 *
 * The two lists differ only in what they fetch and in having a kind filter, so
 * the query state is written once in `useWatchListQuery` and each store adds
 * its own fetch. Every write goes through `integrationsApi`, which announces
 * its scope on `window`; each store listens for its own scope alone, so adding
 * a currency pair does not re-fetch the quote table.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { integrationsApi, onIntegrationsChanged, type IntegrationsScope } from "@/lib/integrations/client";
import type { CurrencyPair, QuoteKind, QuoteSymbol, WatchListQuery } from "@/lib/integrations/types";
import { WATCH_PAGE_SIZE_DEFAULT } from "@/lib/integrations/types";
import { errorMessage } from "@/lib/format";

/** The page sizes both tables offer. The largest is `WATCH_PAGE_SIZE_MAX`. */
export const WATCH_PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

/** How long typing settles before the query is sent. */
const SEARCH_DEBOUNCE_MS = 300;

/** The active segment above either table, exactly as the endpoints accept it. */
export type ActiveFilter = NonNullable<WatchListQuery["active"]>;

/** The kind segment above the quote table; `all` is "do not filter". */
export type KindFilter = QuoteKind | "all";

interface WatchListQueryState {
  page: number;
  pageSize: number;
  setPaging: (page: number, pageSize: number) => void;
  /** What is in the box right now; the query follows it after the debounce. */
  search: string;
  setSearch: (search: string) => void;
  /** The debounced text the server has been asked about. */
  query: string;
  activeFilter: ActiveFilter;
  setActiveFilter: (filter: ActiveFilter) => void;
  kindFilter: KindFilter;
  setKindFilter: (filter: KindFilter) => void;
  filtersActive: boolean;
  clearFilters: () => void;
  /** Bumped to force a re-fetch of the same query. */
  tick: number;
  reload: () => void;
}

function useWatchListQuery(): WatchListQueryState {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(WATCH_PAGE_SIZE_DEFAULT);
  const [search, setSearchState] = useState("");
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilterState] = useState<ActiveFilter>("all");
  const [kindFilter, setKindFilterState] = useState<KindFilter>("all");
  const [tick, setTick] = useState(0);

  // The search box types faster than the server can answer, so the query only
  // follows it once the operator stops. `queryRef` mirrors the query the store
  // last sent, which keeps the timer from resetting the page when the text ends
  // up where it started.
  const queryRef = useRef("");

  const reload = useCallback(() => setTick((value) => value + 1), []);

  const setPaging = useCallback(
    (nextPage: number, nextPageSize: number) => {
      // antd reports both together; a new page size renumbers the list, so the
      // only page that still means anything afterwards is the first.
      setPageSize(nextPageSize);
      setPage(nextPageSize === pageSize ? nextPage : 1);
    },
    [pageSize],
  );

  const setActiveFilter = useCallback((next: ActiveFilter) => {
    setActiveFilterState(next);
    setPage(1);
  }, []);

  const setKindFilter = useCallback((next: KindFilter) => {
    setKindFilterState(next);
    setPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setSearchState("");
    setQuery("");
    queryRef.current = "";
    setActiveFilterState("all");
    setKindFilterState("all");
    setPage(1);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (queryRef.current === search.trim()) return;
      queryRef.current = search.trim();
      setQuery(queryRef.current);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  return {
    page,
    pageSize,
    setPaging,
    search,
    setSearch: setSearchState,
    query,
    activeFilter,
    setActiveFilter,
    kindFilter,
    setKindFilter,
    filtersActive: query !== "" || activeFilter !== "all" || kindFilter !== "all",
    clearFilters,
    tick,
    reload,
  };
}

/** What either table needs, on top of the query state it shares. */
export interface WatchListStore<T> extends WatchListQueryState {
  /** The page on screen. Empty before the first one lands. */
  items: T[];
  /** Items matching the current query, all pages. */
  total: number;
  /** A first load: there is nothing to show yet. */
  loading: boolean;
  /** A fetch over rows that are still on screen — paging, searching, refreshing. */
  refreshing: boolean;
  error: string | null;
  /** True once a page has landed; a failed *first* load leaves this false. */
  loaded: boolean;
}

/**
 * Reloads the list when a write announces the given scope. Split out so both
 * stores subscribe the same way and neither reacts to the other's writes.
 */
function useScopeReload(scope: IntegrationsScope, reload: () => void): void {
  useEffect(
    () =>
      onIntegrationsChanged((changed) => {
        if (changed === scope) reload();
      }),
    [scope, reload],
  );
}

export function useQuoteSymbolsStore(): WatchListStore<QuoteSymbol> {
  const state = useWatchListQuery();
  const [items, setItems] = useState<QuoteSymbol[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { page, pageSize, query, activeFilter, kindFilter, tick, reload } = state;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPending(true);
      try {
        const response = await integrationsApi.quoteSymbols.list({
          page,
          pageSize,
          q: query,
          active: activeFilter,
          ...(kindFilter === "all" ? {} : { kind: kindFilter }),
        });
        if (cancelled) return;
        setItems(response.items);
        setTotal(response.total);
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
  }, [page, pageSize, query, activeFilter, kindFilter, tick]);

  useScopeReload("quote_symbols", reload);

  return {
    ...state,
    items: items ?? [],
    total,
    loading: pending && items === null,
    refreshing: pending && items !== null,
    error,
    loaded: items !== null,
  };
}

export function useCurrencyPairsStore(): WatchListStore<CurrencyPair> {
  const state = useWatchListQuery();
  const [items, setItems] = useState<CurrencyPair[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { page, pageSize, query, activeFilter, tick, reload } = state;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPending(true);
      try {
        // Pairs have no kind, so the kind filter is simply never sent.
        const response = await integrationsApi.currencyPairs.list({
          page,
          pageSize,
          q: query,
          active: activeFilter,
        });
        if (cancelled) return;
        setItems(response.items);
        setTotal(response.total);
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
  }, [page, pageSize, query, activeFilter, tick]);

  useScopeReload("currency_pairs", reload);

  return {
    ...state,
    items: items ?? [],
    total,
    loading: pending && items === null,
    refreshing: pending && items !== null,
    error,
    loaded: items !== null,
  };
}
