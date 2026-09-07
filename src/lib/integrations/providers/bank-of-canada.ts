/**
 * The Bank of Canada Valet API: one call a day for the whole FX group.
 *
 * `GET {base}/observations/group/FX_RATES_DAILY/json?recent=1` answers
 *
 * ```json
 * { "seriesDetail": { "FXUSDCAD": { "label": "USD/CAD" }, … },
 *   "observations": [ { "d": "2026-09-05", "FXUSDCAD": { "v": "1.3712" }, … } ] }
 * ```
 *
 * Every series is **CAD per one unit of the foreign currency**, for about 27
 * currencies. One request therefore covers every pair the watch list can
 * hold, which is why there is no per-pair call anywhere in this feature.
 *
 * `recent=1` means "the most recent observation **of each series**", and the
 * Bank groups those by date: series it still publishes share one entry dated
 * the last business day, while series it has discontinued (VND ended in 2019,
 * a few more in 2026) come back as their own, older entries. The array is not
 * sorted by date. The entry with the newest date is therefore the one to
 * read, and a currency missing from it is one the Bank no longer publishes.
 *
 * Fetch, parse and the arithmetic that turns the CAD series into an arbitrary
 * pair — all pure, no Prisma. The rules mirror the macOS
 * `BankOfCanadaService`:
 *
 * | pair | rate | source |
 * | --- | --- | --- |
 * | `X → CAD` | `FX{X}CAD` | `boc` |
 * | `CAD → X` | `1 / FX{X}CAD` | `boc` |
 * | `X → Y` | `FX{X}CAD / FX{Y}CAD` | `derived` |
 * | `X → X` | `1` | `boc` |
 *
 * The Bank publishes at 16:30 ET, so a fetch made today may well return
 * yesterday's observation date. That is correct and is why the observation
 * date is stored beside the rate instead of being assumed.
 */
import { isoDateFrom, todayIn, type IsoDate } from "../dates";
import { fetchJson, ProviderError, toNumber } from "./http";

/** One request, one small payload; 30 s is generous. */
export const RATES_TIMEOUT_MS = 30_000;

/** The currency every series is quoted against. */
export const BASE_CURRENCY = "CAD";

/** The published series for one observation day. */
export interface FxObservation {
  /** The observation day, `YYYY-MM-DD`. */
  date: IsoDate;
  /** Currency code -> CAD per one unit of it. Never contains `CAD`. */
  rates: Map<string, number>;
}

/** `FXUSDCAD` -> `USD`; `null` for a series name of another shape. */
export function currencyOfSeries(name: string): string | null {
  const match = /^FX([A-Z]{3})CAD$/.exec(name.trim().toUpperCase());
  return match ? match[1] : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Fetches the most recent observation of the daily FX group.
 *
 * @throws {ProviderError} the call failed, or the payload held no usable
 * observation (an empty `observations` array is a `bad_response`: there is
 * nothing to cache and nothing to compute from).
 */
export async function fetchFxObservation(baseUrl: string): Promise<FxObservation> {
  const url = `${baseUrl}/observations/group/FX_RATES_DAILY/json?recent=1`;
  const body = await fetchJson<unknown>(url, { timeoutMs: RATES_TIMEOUT_MS });
  const envelope = record(body);
  const observations = envelope?.observations;
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new ProviderError("bad_response", `${url} answered no observations.`);
  }
  // One entry per distinct "most recent" date, unsorted (see the module
  // comment): the newest date carries every series still published, and
  // that is the observation to use. On a date tie the fuller entry wins.
  let best: FxObservation | null = null;
  for (const entry of observations) {
    const parsed = parseObservation(record(entry));
    if (!parsed) continue;
    if (!best || parsed.date > best.date || (parsed.date === best.date && parsed.rates.size > best.rates.size)) {
      best = parsed;
    }
  }
  if (!best) {
    throw new ProviderError("bad_response", `${url} answered no usable series.`);
  }
  return best;
}

/** One `observations[]` entry as a dated series map; `null` when it holds no usable series. */
function parseObservation(observation: Record<string, unknown> | null): FxObservation | null {
  if (!observation) return null;
  const date = isoDateFrom(observation.d) ?? todayIn();
  const rates = new Map<string, number>();
  for (const [name, cell] of Object.entries(observation)) {
    if (name === "d") continue;
    const currency = currencyOfSeries(name);
    if (!currency || currency === BASE_CURRENCY) continue;
    const value = toNumber(record(cell)?.v);
    if (value === null || value <= 0) continue;
    rates.set(currency, value);
  }
  return rates.size === 0 ? null : { date, rates };
}

export interface ComputedRate {
  rate: number;
  source: "boc" | "derived";
}

/**
 * The rate for one pair from the published CAD series, or `null` when one of
 * the two currencies is not published (the caller turns that into the pair's
 * `last_error` and counts it as a failure).
 *
 * The same-currency case answers 1 rather than reaching for a series, so a
 * `CAD → CAD` or `USD → USD` row never fails.
 */
export function rateFor(
  from: string,
  to: string,
  rates: ReadonlyMap<string, number>,
): ComputedRate | null {
  if (from === to) return { rate: 1, source: "boc" };
  if (to === BASE_CURRENCY) {
    const value = rates.get(from);
    return value === undefined ? null : { rate: value, source: "boc" };
  }
  if (from === BASE_CURRENCY) {
    const value = rates.get(to);
    return value === undefined || value === 0 ? null : { rate: 1 / value, source: "boc" };
  }
  const fromCad = rates.get(from);
  const toCad = rates.get(to);
  if (fromCad === undefined || toCad === undefined || toCad === 0) return null;
  return { rate: fromCad / toCad, source: "derived" };
}

/** Which of the two currencies the Bank does not publish, for the error text. */
export function unpublishedCurrency(
  from: string,
  to: string,
  rates: ReadonlyMap<string, number>,
): string | null {
  if (from !== BASE_CURRENCY && !rates.has(from)) return from;
  if (to !== BASE_CURRENCY && !rates.has(to)) return to;
  return null;
}
