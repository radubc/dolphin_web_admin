"use client";

/**
 * State for the Customers screen's two lists.
 *
 * Both are server-paged. The customer list is the consumer app's whole user
 * table joined against the customer Cognito pool, which is far past anything
 * worth holding in the browser, and the invitation log only grows; so the
 * store keeps the query — page, page size, debounced search text, a status
 * filter, and "include deleted" for customers — and the server answers with
 * that page plus whole-list counts.
 *
 * The two lists differ only in their filter vocabulary and in what they fetch,
 * so the query state is written once in `useListQuery` and each store adds its
 * own request. Search settles for 300 ms before it is sent and any change to
 * the query drops back to page 1, so a narrowed result never opens on a page
 * that no longer exists.
 *
 * Writes go through `customersApi`, which announces its scope on `window`;
 * each store listens for its own scope alone, so sending an invitation does
 * not re-fetch the customer table.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { customersApi, onCustomersChanged, type CustomersScope } from "@/lib/customers/client";
import type {
  Customer,
  CustomerCounts,
  CustomerInvite,
  CustomerStatus,
  InviteStatus,
} from "@/lib/customers/types";
import { CUSTOMER_PAGE_SIZE_DEFAULT } from "@/lib/customers/types";
import { errorMessage } from "@/lib/format";

/** The page sizes both tables offer. The largest is `CUSTOMER_PAGE_SIZE_MAX`. */
export const CUSTOMER_PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

/** How long typing settles before the query is sent. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The statuses the customer segment offers. `no_account` and `unknown` are
 * left out on purpose: they are states of the *lookup*, not of the person, and
 * a filter for them would mostly be a filter for "the pool was unreachable".
 *
 * `deleted` is in, and is the one filter that is a column rather than a pool
 * answer. Choosing it implies "include deleted" — asking for the deleted
 * customers while hiding deleted rows can only ever answer nothing — so the
 * server resolves it that way and the toggle is left alone.
 */
export type CustomerStatusFilter =
  | "all"
  | Extract<CustomerStatus, "active" | "invited" | "disabled" | "deleted">;

export type InviteStatusFilter = InviteStatus | "all";

interface ListQueryState<Filter extends string> {
  page: number;
  pageSize: number;
  setPaging: (page: number, pageSize: number) => void;
  /** What is in the box right now; the query follows it after the debounce. */
  search: string;
  setSearch: (search: string) => void;
  /** The debounced text the server has been asked about. */
  query: string;
  statusFilter: Filter;
  setStatusFilter: (filter: Filter) => void;
  clearFilters: () => void;
  /** Bumped to force a re-fetch of the same query. */
  tick: number;
  reload: () => void;
}

function useListQuery<Filter extends string>(initialFilter: Filter): ListQueryState<Filter> {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(CUSTOMER_PAGE_SIZE_DEFAULT);
  const [search, setSearchState] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilterState] = useState<Filter>(initialFilter);
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

  const setStatusFilter = useCallback((next: Filter) => {
    setStatusFilterState(next);
    setPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setSearchState("");
    setQuery("");
    queryRef.current = "";
    setStatusFilterState(initialFilter);
    setPage(1);
  }, [initialFilter]);

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
    statusFilter,
    setStatusFilter,
    clearFilters,
    tick,
    reload,
  };
}

/** What either table needs, on top of the query state it shares. */
interface ListStore<T, Filter extends string> extends ListQueryState<Filter> {
  /** The page on screen. Empty before the first one lands. */
  items: T[];
  /** Items matching the current query, all pages. */
  total: number;
  /** True when something narrows the list, which changes what "empty" means. */
  filtersActive: boolean;
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
function useScopeReload(scope: CustomersScope, reload: () => void): void {
  useEffect(
    () =>
      onCustomersChanged((changed) => {
        if (changed === scope) reload();
      }),
    [scope, reload],
  );
}

export interface CustomersStore extends ListStore<Customer, CustomerStatusFilter> {
  /** Whole-list figures, from the server, not from the page on screen. */
  counts: CustomerCounts;
  /** False when the customer pool is not configured or could not be reached. */
  cognitoAvailable: boolean;
  /** True when the pool listing hit its size cap; statuses and counts cover only part of it. */
  cognitoTruncated: boolean;
  /** Whether an invitation can be sent from this deployment. */
  canSend: boolean;
  /** The one-line reason when `canSend` is false. */
  unavailableReason: string | null;
  includeDeleted: boolean;
  setIncludeDeleted: (include: boolean) => void;
}

/** Zeroes to draw before the first page lands, so the figures never read `NaN`. */
const EMPTY_COUNTS: CustomerCounts = {
  total: 0,
  activeRecently: 0,
  invited: 0,
  disabled: 0,
  deleted: 0,
};

export function useCustomersStore(): CustomersStore {
  const state = useListQuery<CustomerStatusFilter>("all");
  const [items, setItems] = useState<Customer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<CustomerCounts>(EMPTY_COUNTS);
  const [cognitoAvailable, setCognitoAvailable] = useState(true);
  const [cognitoTruncated, setCognitoTruncated] = useState(false);
  // Optimistic until the first response says otherwise: assuming the pool is
  // unreachable would grey out the invite button before anyone has asked.
  const [canSend, setCanSend] = useState(true);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [includeDeleted, setIncludeDeletedState] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { page, pageSize, query, statusFilter, tick, reload, clearFilters, setPaging } = state;

  const setIncludeDeleted = useCallback(
    (include: boolean) => {
      setIncludeDeletedState(include);
      // A wider list renumbers the pages, so page 1 is the only honest place.
      setPaging(1, pageSize);
    },
    [setPaging, pageSize],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPending(true);
      try {
        const response = await customersApi.list({
          page,
          pageSize,
          q: query,
          status: statusFilter,
          includeDeleted,
        });
        if (cancelled) return;
        setItems(response.items);
        setTotal(response.total);
        setCounts(response.counts);
        setCognitoAvailable(response.cognitoAvailable);
        setCognitoTruncated(response.cognitoTruncated);
        setCanSend(response.canSend);
        setUnavailableReason(response.unavailableReason);
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
  }, [page, pageSize, query, statusFilter, includeDeleted, tick]);

  useScopeReload("customers", reload);

  return {
    ...state,
    clearFilters: useCallback(() => {
      setIncludeDeletedState(false);
      clearFilters();
    }, [clearFilters]),
    items: items ?? [],
    total,
    counts,
    cognitoAvailable,
    cognitoTruncated,
    canSend,
    unavailableReason,
    includeDeleted,
    setIncludeDeleted,
    filtersActive: query !== "" || statusFilter !== "all" || includeDeleted,
    loading: pending && items === null,
    refreshing: pending && items !== null,
    error,
    loaded: items !== null,
  };
}

export interface InvitesStore extends ListStore<CustomerInvite, InviteStatusFilter> {
  /** Whole-list counts per status, from the server. */
  counts: Record<InviteStatus, number>;
  /** False when this deployment cannot send an invitation at all. */
  canSend: boolean;
  /** The one-line reason when `canSend` is false. */
  unavailableReason: string | null;
}

const EMPTY_INVITE_COUNTS: Record<InviteStatus, number> = {
  invited: 0,
  accepted: 0,
  revoked: 0,
  failed: 0,
};

export function useInvitesStore(): InvitesStore {
  const state = useListQuery<InviteStatusFilter>("all");
  const [items, setItems] = useState<CustomerInvite[] | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<InviteStatus, number>>(EMPTY_INVITE_COUNTS);
  // Optimistic until the first response says otherwise: assuming the pool is
  // unreachable would grey out the invite button before anyone has asked.
  const [canSend, setCanSend] = useState(true);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { page, pageSize, query, statusFilter, tick, reload } = state;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPending(true);
      try {
        const response = await customersApi.invites.list({
          page,
          pageSize,
          q: query,
          status: statusFilter,
        });
        if (cancelled) return;
        setItems(response.items);
        setTotal(response.total);
        setCounts(response.counts);
        setCanSend(response.canSend);
        setUnavailableReason(response.unavailableReason);
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
  }, [page, pageSize, query, statusFilter, tick]);

  useScopeReload("invites", reload);

  return {
    ...state,
    items: items ?? [],
    total,
    counts,
    canSend,
    unavailableReason,
    filtersActive: query !== "" || statusFilter !== "all",
    loading: pending && items === null,
    refreshing: pending && items !== null,
    error,
    loaded: items !== null,
  };
}
