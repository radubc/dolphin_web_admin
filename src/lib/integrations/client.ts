/**
 * The browser's typed calls to `/api/v1/admin/integrations/*`. Client-safe: no
 * `server-only` imports, only `apiFetch` and the plain types.
 *
 * Every mutation announces a change on `window`, the same way the constants and
 * admin-access clients do, so a table that did not make the call can reload.
 * The announcement carries a *scope* rather than a bare "something changed":
 * the page shows three lists — the integrations themselves, the quote watch
 * list and the currency-pair watch list — and a write to one of them should not
 * re-fetch the other two.
 */
import { apiFetch } from "@/lib/api/client";
import type {
  CurrencyPair,
  CurrencyPairInput,
  CurrencyPairListResponse,
  CurrencyPairPatch,
  CurrencyPairWithHistory,
  ExchangeRateListResponse,
  Integration,
  IntegrationKey,
  IntegrationListResponse,
  IntegrationPatch,
  IntegrationRun,
  QuoteSymbol,
  QuoteSymbolInput,
  QuoteSymbolListResponse,
  QuoteSymbolPatch,
  RateHistoryQuery,
  RunRequest,
  WatchListQuery,
} from "./types";

const BASE = "/api/v1/admin/integrations";

/** Which of the page's three lists a change touched. */
export type IntegrationsScope = "integrations" | "quote_symbols" | "currency_pairs";

/** Fired on `window` after any integrations write succeeds. */
export const INTEGRATIONS_CHANGED_EVENT = "penny-squeeze:integrations-changed";

export function notifyIntegrationsChanged(scope: IntegrationsScope): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<IntegrationsScope>(INTEGRATIONS_CHANGED_EVENT, { detail: scope }));
  }
}

/** Subscribes to change announcements; returns the unsubscribe. */
export function onIntegrationsChanged(listener: (scope: IntegrationsScope) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => listener((event as CustomEvent<IntegrationsScope>).detail);
  window.addEventListener(INTEGRATIONS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(INTEGRATIONS_CHANGED_EVENT, handler);
}

const integrationPath = (key: IntegrationKey) => `${BASE}/${encodeURIComponent(key)}`;
const quoteSymbolsPath = `${BASE}/quote-symbols`;
const currencyPairsPath = `${BASE}/currency-pairs`;

/** Paging, search and the two filters, as the watch-list endpoints accept them. */
function watchSearch(query: WatchListQuery): string {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  if (query.q !== undefined && query.q.trim() !== "") params.set("q", query.q.trim());
  if (query.kind !== undefined) params.set("kind", query.kind);
  if (query.active !== undefined && query.active !== "all") params.set("active", query.active);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** Paging alone, as the pair history endpoint accepts it. */
function historySearch(query: RateHistoryQuery): string {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export const integrationsApi = {
  /** Every integration, plus whether this process runs the scheduler. */
  list: () => apiFetch<IntegrationListResponse>(BASE),

  /** Edits the base URL, the enabled flag, the schedule or the settings. */
  update: async (key: IntegrationKey, patch: IntegrationPatch) => {
    const integration = await apiFetch<Integration>(integrationPath(key), { method: "PATCH", json: patch });
    notifyIntegrationsChanged("integrations");
    return integration;
  },

  /**
   * Starts a run now. The API answers 409 when one is already live and 422 when
   * the integration needs an API key that is not configured; both arrive as an
   * `ApiClientError` the caller reports in its own words.
   */
  start: async (key: IntegrationKey, request: RunRequest = {}) => {
    const run = await apiFetch<IntegrationRun>(`${integrationPath(key)}/run`, { method: "POST", json: request });
    notifyIntegrationsChanged("integrations");
    return run;
  },

  /** Recent runs for one integration, newest first. */
  runs: (key: IntegrationKey, limit = 20) =>
    apiFetch<IntegrationRun[]>(`${integrationPath(key)}/runs?limit=${encodeURIComponent(String(limit))}`),

  /** One run by id, for polling. */
  run: (key: IntegrationKey, runId: string) =>
    apiFetch<IntegrationRun>(`${integrationPath(key)}/runs/${encodeURIComponent(runId)}`),

  /* ------------------------------ Quote symbols ----------------------------- */

  quoteSymbols: {
    list: (query: WatchListQuery = {}) =>
      apiFetch<QuoteSymbolListResponse>(`${quoteSymbolsPath}${watchSearch(query)}`),

    create: async (input: QuoteSymbolInput) => {
      const symbol = await apiFetch<QuoteSymbol>(quoteSymbolsPath, { method: "POST", json: input });
      notifyIntegrationsChanged("quote_symbols");
      return symbol;
    },

    update: async (id: string, patch: QuoteSymbolPatch) => {
      const symbol = await apiFetch<QuoteSymbol>(`${quoteSymbolsPath}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        json: patch,
      });
      notifyIntegrationsChanged("quote_symbols");
      return symbol;
    },

    /** Removes the symbol from the watch list; quotes already cached for it are kept. */
    remove: async (id: string) => {
      await apiFetch<void>(`${quoteSymbolsPath}/${encodeURIComponent(id)}`, { method: "DELETE" });
      notifyIntegrationsChanged("quote_symbols");
    },
  },

  /* ----------------------------- Currency pairs ----------------------------- */

  currencyPairs: {
    list: (query: WatchListQuery = {}) =>
      apiFetch<CurrencyPairListResponse>(`${currencyPairsPath}${watchSearch(query)}`),

    /**
     * Adds the pair **and** brings six months of history with it: the answer
     * carries the watch row (its newest rate already filled in when the fetch
     * worked) and a `history` saying what that fetch did. The change
     * announcement then reloads the list, so the "Latest rate" column fills
     * without the operator refreshing.
     */
    create: async (input: CurrencyPairInput) => {
      const result = await apiFetch<CurrencyPairWithHistory>(currencyPairsPath, {
        method: "POST",
        json: input,
      });
      notifyIntegrationsChanged("currency_pairs");
      return result;
    },

    update: async (id: string, patch: CurrencyPairPatch) => {
      const pair = await apiFetch<CurrencyPair>(`${currencyPairsPath}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        json: patch,
      });
      notifyIntegrationsChanged("currency_pairs");
      return pair;
    },

    /** Removes the pair from the watch list; rates already cached for it are kept. */
    remove: async (id: string) => {
      await apiFetch<void>(`${currencyPairsPath}/${encodeURIComponent(id)}`, { method: "DELETE" });
      notifyIntegrationsChanged("currency_pairs");
    },

    /** One page of what has been downloaded for the pair, newest first. */
    rates: (id: string, query: RateHistoryQuery = {}) =>
      apiFetch<ExchangeRateListResponse>(
        `${currencyPairsPath}/${encodeURIComponent(id)}/rates${historySearch(query)}`,
      ),

    /**
     * Fetches the last six months for a pair that is already watched — the
     * same window and the same answer as an add. 409 when the pair is
     * inactive; a provider that is down is *not* an error, it is a `history`
     * with a status.
     */
    backfill: async (id: string) => {
      const result = await apiFetch<CurrencyPairWithHistory>(
        `${currencyPairsPath}/${encodeURIComponent(id)}/backfill`,
        { method: "POST" },
      );
      notifyIntegrationsChanged("currency_pairs");
      return result;
    },
  },
};
