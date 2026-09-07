/**
 * Alpha Vantage: the `GLOBAL_QUOTE` endpoint, used as the fallback for
 * listings TwelveData's free plan refuses (`SHOP:TSX` and every other non-US
 * exchange).
 *
 * This is the port of the macOS app's `AlphaVantageQuoteService` and
 * `AlphaVantageAPI`, which is the behaviour the consumer product already
 * ships. Fetch, map and parse only — no Prisma and no run bookkeeping.
 *
 * ## The key really is in the URL
 *
 * Alpha Vantage accepts its key **only** as the `apikey` query parameter;
 * there is no header form. So unlike every other provider here, this module
 * builds URLs that carry a credential. Three rules follow, and they are not
 * optional:
 *
 * 1. nothing in this module ever logs, throws or returns a raw URL — every
 *    one goes through `redactUrl`, which blanks `apikey=`;
 * 2. the key is never stored, only read from the environment by the caller;
 * 3. the base URL is pinned to `alphavantage.co` by
 *    `PROVIDER_BASE_URL_DOMAINS`, because an operator who could point it
 *    elsewhere could make this server deliver the key to that address.
 *
 * ## The quota is the design constraint
 *
 * The free tier allows **25 requests a day and 5 a minute**, and
 * `GLOBAL_QUOTE` has no batch form: one symbol is one request. Hence
 * `quoteSymbolFromCanonical` returning `null` rather than a guess — a symbol
 * Alpha Vantage cannot resolve must never cost one of the 25 — and hence
 * `AlphaVantageOutcome.throttled`, which the caller must treat as "stop the
 * whole pass now", not as "this symbol failed".
 *
 * ## Throttling arrives as a success
 *
 * Alpha Vantage answers HTTP **200** with `{"Note": …}` or
 * `{"Information": …}` when the rate limit or the daily quota is spent, so a
 * caller that only checks the status code will happily burn the rest of its
 * list on identical non-answers.
 */
import { isoDateFrom, todayIn, type IsoDate } from "../dates";
import { fetchJson, isProviderError, redactUrl, toNumber, toText } from "./http";

/** One symbol, one small JSON body; a slow answer is a problem, not a payload. */
export const ALPHA_VANTAGE_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/*                               Symbol mapping                               */
/* -------------------------------------------------------------------------- */

/** US exchanges whose symbols Alpha Vantage takes bare, with no suffix. */
const US_EXCHANGES: ReadonlySet<string> = new Set([
  "NYSE",
  "NASDAQ",
  "AMEX",
  "NYSE AMERICAN",
  "NYSE ARCA",
  "ARCA",
  "BATS",
  "CBOE",
  "IEX",
  "OTC",
  "OTCQB",
  "OTCQX",
  "OTC MARKETS",
]);

/**
 * Alpha Vantage's exchange suffixes, keyed by the catalog's exchange name
 * (TwelveData's spelling, upper-cased). Taken from the provider's own
 * documented examples: `TSCO.LON`, `SHOP.TRT`, `GPV.TRV`, `MBG.DEX`,
 * `RELIANCE.BSE`, `600104.SHH`, `000002.SHZ`.
 */
export const EXCHANGE_SUFFIXES: Readonly<Record<string, string>> = {
  TSX: "TRT",
  TSXV: "TRV",
  LSE: "LON",
  XETRA: "DEX",
  XETR: "DEX",
  FSX: "FRK",
  FRA: "FRK",
  BSE: "BSE",
  SSE: "SHH",
  SZSE: "SHZ",
};

/**
 * The canonical `SYMBOL:EXCHANGE` in Alpha Vantage notation, or `null` when
 * Alpha Vantage cannot resolve it.
 *
 * `null` is the important half of this function. A crypto pair (`BTC/USD`)
 * and an exchange with no documented suffix are both unresolvable, and asking
 * anyway would spend one of the day's 25 requests to be told so. A bare
 * canonical with no exchange is passed through as it stands — that is already
 * Alpha Vantage's own notation for a US listing.
 */
export function quoteSymbolFromCanonical(canonical: string): string | null {
  const trimmed = canonical.trim();
  if (trimmed === "") return null;
  // Crypto pairs are a different endpoint entirely (CURRENCY_EXCHANGE_RATE),
  // and TwelveData serves them on the free plan, so they never come here.
  if (trimmed.includes("/")) return null;

  const separator = trimmed.indexOf(":");
  if (separator < 0) return trimmed;

  const symbol = trimmed.slice(0, separator);
  const exchange = trimmed.slice(separator + 1).toUpperCase();
  if (symbol === "" || exchange === "") return null;

  if (US_EXCHANGES.has(exchange)) return symbol;
  const suffix = EXCHANGE_SUFFIXES[exchange];
  return suffix === undefined ? null : `${symbol}.${suffix}`;
}

/* -------------------------------------------------------------------------- */
/*                                  Fetching                                  */
/* -------------------------------------------------------------------------- */

/**
 * One quote as `GLOBAL_QUOTE` reports it.
 *
 * Alpha Vantage reports **no currency**; the caller supplies the watch row's
 * catalog currency, or `""`. `change` and `percentChange` are computed from
 * `05. price` and `08. previous close` rather than read from `09.`/`10.`, so
 * the fraction stored is exactly consistent with the two prices stored beside
 * it (the provider's own `10. change percent` arrives as the string
 * `"-0.64%"`, in percent units).
 */
export interface AlphaVantageQuote {
  /** The trading day from `07. latest trading day`. */
  quoteDate: IsoDate;
  close: number;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  change: number | null;
  /** A fraction (0.0064 = 0.64 %), never percent units. */
  percentChange: number | null;
}

/**
 * What one request produced.
 *
 * `throttled` is not a failure of the symbol — it is the end of the pass. The
 * per-minute limit and the daily quota are reported the same way, and the
 * caller cannot tell them apart, so the only safe reading is "stop asking".
 */
export type AlphaVantageOutcome =
  | { kind: "quote"; quote: AlphaVantageQuote }
  /** Reached the provider; it does not know this symbol. */
  | { kind: "not_found" }
  /** Rate limit or daily quota. Stop the whole pass. */
  | { kind: "throttled"; message: string }
  /** Network, timeout, refusal, or a body that made no sense. */
  | { kind: "failed"; message: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reads one `{"Global Quote": {...}}` body.
 *
 * Exported for the sake of being testable against a captured payload; the
 * fetch below is its only caller.
 */
export function parseGlobalQuote(body: unknown): AlphaVantageOutcome {
  const envelope = record(body);
  if (!envelope) return { kind: "failed", message: "Alpha Vantage did not answer an object." };

  // HTTP 200 with a Note/Information body is how the free tier says "no".
  const note = toText(envelope.Note) || toText(envelope.Information);
  if (note !== "") {
    return {
      kind: "throttled",
      message: `Alpha Vantage refused: ${note.slice(0, 300)}`,
    };
  }
  if (toText(envelope["Error Message"]) !== "") return { kind: "not_found" };

  const entry = record(envelope["Global Quote"]);
  // An empty "Global Quote" object is how an unknown symbol comes back.
  if (!entry || Object.keys(entry).length === 0) return { kind: "not_found" };

  const close = toNumber(entry["05. price"]);
  if (close === null) return { kind: "not_found" };

  const previousClose = toNumber(entry["08. previous close"]);
  const change = previousClose === null ? null : close - previousClose;
  const percentChange =
    previousClose === null || previousClose === 0 ? null : (close - previousClose) / previousClose;

  return {
    kind: "quote",
    quote: {
      quoteDate: isoDateFrom(entry["07. latest trading day"]) ?? todayIn(),
      close,
      open: toNumber(entry["02. open"]),
      high: toNumber(entry["03. high"]),
      low: toNumber(entry["04. low"]),
      previousClose,
      change,
      percentChange,
    },
  };
}

/**
 * Fetches one symbol's quote. `symbol` is Alpha Vantage notation
 * (`SHOP.TRT`), already produced by `quoteSymbolFromCanonical`.
 *
 * Never throws: every failure is an `AlphaVantageOutcome`, because the caller
 * is spending a strictly limited quota and has to decide, per symbol, whether
 * to carry on. An HTTP 429 is folded into `throttled` for the same reason.
 */
export async function fetchGlobalQuote(
  baseUrl: string,
  apiKey: string,
  symbol: string,
): Promise<AlphaVantageOutcome> {
  const key = apiKey.trim();
  if (key === "") return { kind: "failed", message: "No Alpha Vantage key is configured." };

  const url =
    `${baseUrl}/query?function=GLOBAL_QUOTE` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&apikey=${encodeURIComponent(key)}`;

  try {
    return parseGlobalQuote(await fetchJson<unknown>(url, { timeoutMs: ALPHA_VANTAGE_TIMEOUT_MS }));
  } catch (error) {
    if (isProviderError(error)) {
      if (error.kind === "rate_limit") {
        return { kind: "throttled", message: "Alpha Vantage is rate limiting us (429)." };
      }
      if (error.kind === "auth") {
        // A wrong key answers the same way for every symbol, so there is no
        // point spending the rest of the pass discovering it again.
        return { kind: "throttled", message: "The Alpha Vantage key was refused." };
      }
      // `ProviderError` messages are already redacted; this is belt and braces
      // for a message assembled somewhere else.
      return { kind: "failed", message: redactUrl(error.message) };
    }
    return {
      kind: "failed",
      message: redactUrl(error instanceof Error ? error.message : String(error)),
    };
  }
}
