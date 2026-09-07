/**
 * TwelveData: the reference-list downloads and the `/quote` endpoint.
 *
 * Fetch and parse only — no Prisma, no run bookkeeping, so the parsing rules
 * can be read (and reasoned about) on their own. The API key is a parameter,
 * never read from the environment here, and never put in a URL: it travels as
 * an `Authorization: apikey <key>` header, which TwelveData accepts as an
 * alternative to the `apikey` query parameter. That keeps it out of every URL
 * this module builds, and therefore out of logs, error messages and any
 * intermediary's access log. `redactUrl` is still applied to every message, so
 * a base URL an operator pasted a key into cannot leak either.
 *
 * ## Quote parsing
 *
 * This mirrors the macOS app's `QuoteService.parseEntry`, which is the
 * behaviour the consumer product already ships. The rules that are not
 * obvious from the payload:
 *
 * - A request for **one** symbol answers with a single object; a request for
 *   several answers with a dictionary keyed by the symbol **as requested**.
 *   Both shapes are normalised here.
 * - An entry with `status: "error"` is a miss, not a failure of the batch.
 * - Every numeric field arrives as a string.
 * - The **requested** symbol wins over the `symbol` field in the response:
 *   ask for `SHOP:TSX` and TwelveData answers `"symbol": "SHOP"`, which would
 *   collide with the NYSE listing in the cache.
 * - `is_market_open` (assumed **true** when absent) decides two things at
 *   once. While the market is open, today's `close` is an intraday price and
 *   the last *settled* price is `previous_close`; that value belongs to the
 *   previous trading day, and the intraday `open`/`high`/`low` do not belong
 *   to it, so they are dropped. While the market is closed, `close` is the
 *   day's settled price and the whole bar is kept under `datetime`'s date.
 * - `percent_change` arrives in percent units and is stored as a fraction, so
 *   0.64 becomes 0.0064. `change` is stored as given.
 */
import { isoDateFrom, previousTradingDay, todayIn, type IsoDate } from "../dates";
import type { CatalogTarget } from "../types";
import { fetchJson, ProviderError, redactUrl, toNumber, toText } from "./http";

/** Reference lists are ~100k rows each; they take a while to arrive. */
export const CATALOG_TIMEOUT_MS = 120_000;
/** A `/quote` batch is small; a slow answer is a problem, not a big payload. */
export const QUOTE_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/*                               Reference lists                              */
/* -------------------------------------------------------------------------- */

/** A `stocks` row as the admin catalog stores it. Empty strings, never null. */
export interface CatalogStockRow {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  mic_code: string;
  country: string;
  type: string;
  figi_code: string;
  cfi_code: string;
  isin: string;
  cusip: string;
}

/** An `etfs` row: the stock shape without `type`. */
export type CatalogEtfRow = Omit<CatalogStockRow, "type">;

/** A `cryptocurrencies` row; `available_exchanges` arrives as an array. */
export interface CatalogCryptoRow {
  symbol: string;
  available_exchanges: string;
  currency_base: string;
  currency_quote: string;
}

export type CatalogRow = CatalogStockRow | CatalogEtfRow | CatalogCryptoRow;

/** The path each catalog lives at, appended to the integration's base URL. */
const CATALOG_PATHS: Record<CatalogTarget, string> = {
  stocks: "/stocks",
  etfs: "/etfs",
  cryptocurrencies: "/cryptocurrencies",
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseStock(row: Record<string, unknown>): CatalogStockRow {
  return {
    symbol: toText(row.symbol),
    name: toText(row.name),
    currency: toText(row.currency),
    exchange: toText(row.exchange),
    mic_code: toText(row.mic_code),
    country: toText(row.country),
    type: toText(row.type),
    figi_code: toText(row.figi_code),
    cfi_code: toText(row.cfi_code),
    isin: toText(row.isin),
    cusip: toText(row.cusip),
  };
}

function parseCrypto(row: Record<string, unknown>): CatalogCryptoRow {
  const exchanges = Array.isArray(row.available_exchanges)
    ? row.available_exchanges.map((entry) => toText(entry)).filter((entry) => entry !== "")
    : [];
  return {
    symbol: toText(row.symbol),
    // Stored comma-joined: the column is a single NOT NULL text field, and
    // this is the spelling the macOS app's preload already uses.
    available_exchanges: exchanges.join(","),
    currency_base: toText(row.currency_base),
    currency_quote: toText(row.currency_quote),
  };
}

/**
 * Downloads one reference list. The payload is `{"data": [...]}`; anything
 * else is a `bad_response`.
 *
 * Rows with no symbol are dropped here rather than in the run body: they
 * cannot satisfy either catalog's unique key, so they are not data.
 */
export async function fetchCatalog(
  baseUrl: string,
  target: CatalogTarget,
): Promise<CatalogRow[]> {
  const url = `${baseUrl}${CATALOG_PATHS[target]}`;
  const body = await fetchJson<unknown>(url, { timeoutMs: CATALOG_TIMEOUT_MS });
  const envelope = record(body);
  const data = envelope?.data;
  if (!Array.isArray(data)) {
    throw new ProviderError(
      "bad_response",
      `${redactUrl(url)} did not answer {"data": [...]}.`,
    );
  }
  const rows: CatalogRow[] = [];
  for (const entry of data) {
    const row = record(entry);
    if (!row) continue;
    if (target === "cryptocurrencies") {
      const parsed = parseCrypto(row);
      if (parsed.symbol !== "") rows.push(parsed);
      continue;
    }
    const parsed = parseStock(row);
    if (parsed.symbol === "") continue;
    if (target === "etfs") {
      // The ETF list ships no `type`; the column does not exist on that table.
      const etf: CatalogEtfRow = {
        symbol: parsed.symbol,
        name: parsed.name,
        currency: parsed.currency,
        exchange: parsed.exchange,
        mic_code: parsed.mic_code,
        country: parsed.country,
        figi_code: parsed.figi_code,
        cfi_code: parsed.cfi_code,
        isin: parsed.isin,
        cusip: parsed.cusip,
      };
      rows.push(etf);
      continue;
    }
    rows.push(parsed);
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/*                                   Quotes                                   */
/* -------------------------------------------------------------------------- */

/** One parsed quote, keyed by the symbol that was **requested**. */
export interface ParsedQuote {
  requested: string;
  quoteDate: IsoDate;
  close: number;
  open: number | null;
  high: number | null;
  low: number | null;
  currency: string;
  change: number | null;
  /** A fraction (0.0064 = 0.64 %), already divided by 100. */
  percentChange: number | null;
}

export interface QuoteBatchResult {
  quotes: ParsedQuote[];
  /** Symbols the provider answered with an error, or did not answer at all. */
  missing: string[];
}

/** `true` unless the provider explicitly says the market is closed. */
function marketIsOpen(entry: Record<string, unknown>): boolean {
  const value = entry.is_market_open;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() !== "false";
  return true;
}

/**
 * One entry of a `/quote` answer, or `null` when it is a miss.
 *
 * `requested` is the symbol we asked for and the key the quote is stored
 * under; the response's own `symbol` is deliberately ignored.
 */
export function parseEntry(requested: string, value: unknown): ParsedQuote | null {
  const entry = record(value);
  if (!entry) return null;
  if (toText(entry.status).toLowerCase() === "error") return null;

  const open = marketIsOpen(entry);
  const close = toNumber(entry.close);
  const previousClose = toNumber(entry.previous_close);
  // Open: today's `close` is intraday, so the last settled price is
  // `previous_close`. Closed: `close` is the settled price.
  const price = open ? (previousClose ?? close) : (close ?? previousClose);
  if (price === null) return null;

  const datetime = isoDateFrom(entry.datetime) ?? todayIn();
  const quoteDate = open ? previousTradingDay(datetime) : datetime;

  const percent = toNumber(entry.percent_change);

  return {
    requested,
    quoteDate,
    close: price,
    // The intraday bar does not describe the previous trading day, so it is
    // dropped while the market is open rather than mislabelled.
    open: open ? null : toNumber(entry.open),
    high: open ? null : toNumber(entry.high),
    low: open ? null : toNumber(entry.low),
    currency: toText(entry.currency),
    change: toNumber(entry.change),
    percentChange: percent === null ? null : percent / 100,
  };
}

/**
 * Fetches one batch of quotes. `symbols` are canonical (`AAPL`, `SHOP:TSX`,
 * `BTC/USD`) and cost one credit each.
 *
 * A single-symbol request answers with the entry itself, a multi-symbol one
 * with a dictionary keyed by the requested symbol; both are normalised. A
 * dictionary that is missing a symbol we asked for, and an entry the provider
 * marked as an error, both land in `missing`.
 *
 * `apiKey` is sent as `Authorization: apikey <key>`, so it never appears in a
 * URL. An empty key sends no header and earns the provider's own 401.
 *
 * @throws {ProviderError} the whole batch failed (auth, 429, network, junk).
 */
export async function fetchQuotes(
  baseUrl: string,
  apiKey: string,
  symbols: readonly string[],
): Promise<QuoteBatchResult> {
  if (symbols.length === 0) return { quotes: [], missing: [] };
  const url = `${baseUrl}/quote?symbol=${encodeURIComponent(symbols.join(","))}`;
  const key = apiKey.trim();
  const body = await fetchJson<unknown>(url, {
    timeoutMs: QUOTE_TIMEOUT_MS,
    // The key goes in a header, never in the query string. An empty key sends
    // no header at all, so the provider answers 401 and `fetchJson` turns that
    // into a ProviderError("auth") — the same outcome as a wrong key.
    ...(key === "" ? {} : { headers: { Authorization: `apikey ${key}` } }),
  });
  const envelope = record(body);
  if (!envelope) {
    throw new ProviderError("bad_response", "The quote endpoint did not answer an object.");
  }

  // TwelveData reports some failures with 200 and a body-level code.
  const bodyStatus = toText(envelope.status).toLowerCase();
  const bodyCode = toNumber(envelope.code);
  if (bodyStatus === "error" && symbols.length > 1) {
    if (bodyCode === 401 || bodyCode === 403) {
      throw new ProviderError("auth", "API key missing or invalid.", bodyCode);
    }
    if (bodyCode === 429) {
      throw new ProviderError("rate_limit", "The provider is rate limiting us (429).", 429);
    }
  }

  const quotes: ParsedQuote[] = [];
  const missing: string[] = [];

  if (symbols.length === 1) {
    const only = symbols[0];
    // A single-symbol answer with a body-level auth error is still an auth
    // error; anything else about it is simply a miss.
    if (bodyStatus === "error" && (bodyCode === 401 || bodyCode === 403)) {
      throw new ProviderError("auth", "API key missing or invalid.", bodyCode);
    }
    if (bodyStatus === "error" && bodyCode === 429) {
      throw new ProviderError("rate_limit", "The provider is rate limiting us (429).", 429);
    }
    const parsed = parseEntry(only, envelope);
    if (parsed) quotes.push(parsed);
    else missing.push(only);
    return { quotes, missing };
  }

  for (const symbol of symbols) {
    const parsed = parseEntry(symbol, envelope[symbol]);
    if (parsed) quotes.push(parsed);
    else missing.push(symbol);
  }
  return { quotes, missing };
}
