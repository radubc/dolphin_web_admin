import "server-only";
/**
 * Every read and write the Integrations feature makes against the **admin**
 * database, and the mapping between its rows and the wire types in
 * `./types.ts`.
 *
 * Nothing here touches the main app database: the consumer app's schema is
 * not involved in this feature at all. The two market-data catalogs it does
 * read (`stocks`, `etfs`, `cryptocurrencies`) are the admin copies the
 * Constants page already owns.
 *
 * Conversions applied once, here, so no caller has to remember them:
 * `Decimal` becomes `number`, `DATE` becomes `YYYY-MM-DD`, every timestamp
 * becomes an ISO string.
 *
 * The tables may not exist yet (`docs/sql/008_integrations.sql` is run by
 * hand). Prisma's P2021 is deliberately **not** caught in this module, so
 * `adminHandler` renders it as 503 `admin_schema_missing`; the two service
 * endpoints and the scheduler catch it themselves.
 */
import type { Prisma } from "@/generated/prisma-admin/client";
import { prismaAdmin } from "@/lib/prisma-admin";
import { toIsoDate, fromIsoDate, shiftDays, todayIn, type IsoDate } from "./dates";
import { nextRunFor } from "./schedule";
import {
  ALPHA_VANTAGE_REQUESTS_PER_MINUTE_DEFAULT,
  ALPHA_VANTAGE_REQUESTS_PER_MINUTE_MAX,
  ALPHA_VANTAGE_REQUESTS_PER_RUN_DEFAULT,
  ALPHA_VANTAGE_REQUESTS_PER_RUN_MAX,
  CATALOG_TARGETS,
  DEFAULT_TIMEZONE,
  QUOTE_BATCH_SIZE_DEFAULT,
  QUOTE_BATCH_SIZE_MAX,
  QUOTE_CREDITS_PER_MINUTE_DEFAULT,
  type CatalogTarget,
  type CurrencyPair,
  type ExchangeRate,
  type Integration,
  type IntegrationKey,
  type IntegrationPatch,
  type IntegrationProvider,
  type IntegrationSchedule,
  type IntegrationSettings,
  type Quote,
  type QuoteKind,
  type QuoteSymbol,
  type WatchListQuery,
  type WatchSource,
} from "./types";

/* -------------------------------------------------------------------------- */
/*                                   Mapping                                  */
/* -------------------------------------------------------------------------- */

type IntegrationRow = Prisma.admin_integrationsGetPayload<object>;
type QuoteSymbolRow = Prisma.admin_quote_symbolsGetPayload<object>;
type QuoteRow = Prisma.admin_quotesGetPayload<object>;
type CurrencyPairRow = Prisma.admin_currency_pairsGetPayload<object>;
type ExchangeRateRow = Prisma.admin_exchange_ratesGetPayload<object>;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/** A `Decimal` column on the wire. `null` stays `null`. */
const num = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : Number(value);

function scheduleOf(row: IntegrationRow): IntegrationSchedule {
  return {
    frequency: row.schedule_frequency as IntegrationSchedule["frequency"],
    hour: row.schedule_hour,
    minute: row.schedule_minute,
    weekday: row.schedule_weekday,
    dayOfMonth: row.schedule_day_of_month,
    timezone: row.schedule_timezone || DEFAULT_TIMEZONE,
  };
}

/**
 * The `settings` JSONB, filtered down to the fields the model declares.
 * Anything else an operator or an older build wrote is ignored rather than
 * passed through, so a stray key can never reach the provider code.
 */
export function settingsOf(value: Prisma.JsonValue): IntegrationSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const settings: IntegrationSettings = {};
  if (Array.isArray(raw.catalogs)) {
    const targets = raw.catalogs.filter((entry): entry is CatalogTarget =>
      (CATALOG_TARGETS as readonly unknown[]).includes(entry),
    );
    if (targets.length > 0) settings.catalogs = targets;
  }
  if (typeof raw.batchSize === "number" && Number.isFinite(raw.batchSize)) {
    settings.batchSize = Math.min(QUOTE_BATCH_SIZE_MAX, Math.max(1, Math.trunc(raw.batchSize)));
  }
  if (typeof raw.creditsPerMinute === "number" && Number.isFinite(raw.creditsPerMinute)) {
    settings.creditsPerMinute = Math.max(1, Math.trunc(raw.creditsPerMinute));
  }
  if (typeof raw.includeExpired === "boolean") {
    settings.includeExpired = raw.includeExpired;
  }
  if (typeof raw.maxRequestsPerRun === "number" && Number.isFinite(raw.maxRequestsPerRun)) {
    // Clamped to the free tier's whole daily quota: a stored value above it
    // would be a promise the provider will not keep.
    settings.maxRequestsPerRun = Math.min(
      ALPHA_VANTAGE_REQUESTS_PER_RUN_MAX,
      Math.max(1, Math.trunc(raw.maxRequestsPerRun)),
    );
  }
  if (typeof raw.requestsPerMinute === "number" && Number.isFinite(raw.requestsPerMinute)) {
    settings.requestsPerMinute = Math.min(
      ALPHA_VANTAGE_REQUESTS_PER_MINUTE_MAX,
      Math.max(1, Math.trunc(raw.requestsPerMinute)),
    );
  }
  return settings;
}

/** The effective settings for a quote run, defaults filled in. */
export function quoteSettings(settings: IntegrationSettings): {
  batchSize: number;
  creditsPerMinute: number;
} {
  return {
    batchSize: Math.min(QUOTE_BATCH_SIZE_MAX, settings.batchSize ?? QUOTE_BATCH_SIZE_DEFAULT),
    creditsPerMinute: settings.creditsPerMinute ?? QUOTE_CREDITS_PER_MINUTE_DEFAULT,
  };
}

/** The effective settings for an Alpha Vantage pass, defaults filled in. */
export function alphaVantageSettings(settings: IntegrationSettings): {
  maxRequestsPerRun: number;
  requestsPerMinute: number;
} {
  return {
    maxRequestsPerRun: Math.min(
      ALPHA_VANTAGE_REQUESTS_PER_RUN_MAX,
      Math.max(1, settings.maxRequestsPerRun ?? ALPHA_VANTAGE_REQUESTS_PER_RUN_DEFAULT),
    ),
    requestsPerMinute: Math.min(
      ALPHA_VANTAGE_REQUESTS_PER_MINUTE_MAX,
      Math.max(1, settings.requestsPerMinute ?? ALPHA_VANTAGE_REQUESTS_PER_MINUTE_DEFAULT),
    ),
  };
}

/** Whether the MIC download loads the register's EXPIRED rows too. */
export function marketsSettings(settings: IntegrationSettings): { includeExpired: boolean } {
  return { includeExpired: settings.includeExpired === true };
}

/** The catalogs a catalog run downloads; all three unless narrowed. */
export function catalogTargets(settings: IntegrationSettings): CatalogTarget[] {
  return settings.catalogs && settings.catalogs.length > 0
    ? [...settings.catalogs]
    : [...CATALOG_TARGETS];
}

/**
 * Whether the environment variable this integration reads its key from is
 * set. **Presence only** — the value never leaves the server, is never
 * logged and is never part of any response.
 */
export function apiKeyConfigured(row: Pick<IntegrationRow, "api_key_env">): boolean {
  if (!row.api_key_env) return false;
  const value = process.env[row.api_key_env];
  return typeof value === "string" && value.trim() !== "";
}

/** The API key itself, for the run bodies. `null` when it is not configured. */
export function apiKeyOf(row: Pick<IntegrationRow, "api_key_env">): string | null {
  if (!row.api_key_env) return null;
  const value = process.env[row.api_key_env];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Maps an integration row. `latestRun` is attached by the service layer. */
export function toIntegration(row: IntegrationRow): Omit<Integration, "latestRun"> {
  return {
    key: row.key as IntegrationKey,
    name: row.name,
    description: row.description,
    provider: row.provider as IntegrationProvider,
    baseUrl: row.base_url,
    requiresApiKey: row.requires_api_key,
    apiKeyEnv: row.api_key_env,
    apiKeyConfigured: apiKeyConfigured(row),
    isEnabled: row.is_enabled,
    schedule: scheduleOf(row),
    settings: settingsOf(row.settings),
    lastRunAt: iso(row.last_run_at),
    lastSuccessAt: iso(row.last_success_at),
    nextRunAt: iso(row.next_run_at),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

export function toQuote(row: QuoteRow): Quote {
  return {
    symbol: row.symbol,
    quoteDate: toIsoDate(row.quote_date),
    close: Number(row.close),
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    currency: row.currency,
    change: num(row.change),
    percentChange: num(row.percent_change),
    provider: row.provider as IntegrationProvider,
    fetchedAt: row.fetched_at.toISOString(),
  };
}

export function toExchangeRate(row: ExchangeRateRow): ExchangeRate {
  return {
    fromCurrency: row.from_currency,
    toCurrency: row.to_currency,
    date: toIsoDate(row.date),
    rate: Number(row.rate),
    source: row.source === "derived" ? "derived" : "boc",
    fetchedAt: row.fetched_at.toISOString(),
  };
}

export function toQuoteSymbol(row: QuoteSymbolRow, latestQuote: Quote | null): QuoteSymbol {
  return {
    id: row.id,
    kind: row.kind as QuoteKind,
    symbol: row.symbol,
    exchange: row.exchange,
    canonical: row.canonical,
    name: row.name,
    currency: row.currency,
    source: row.source as WatchSource,
    provider: (row.provider as IntegrationProvider | null) ?? null,
    isActive: row.is_active,
    lastQuotedAt: iso(row.last_quoted_at),
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    latestQuote,
  };
}

export function toCurrencyPair(row: CurrencyPairRow, latestRate: ExchangeRate | null): CurrencyPair {
  return {
    id: row.id,
    fromCurrency: row.from_currency,
    toCurrency: row.to_currency,
    source: row.source as WatchSource,
    isActive: row.is_active,
    lastRatedAt: iso(row.last_rated_at),
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    latestRate,
  };
}

/* -------------------------------------------------------------------------- */
/*                                Integrations                                */
/* -------------------------------------------------------------------------- */

/** Every integration row, in the order the page shows them. */
export function listIntegrationRows(): Promise<IntegrationRow[]> {
  return prismaAdmin.admin_integrations.findMany({ orderBy: { key: "asc" } });
}

/** One integration row, or `null` when the seed has not been run. */
export function findIntegrationRow(key: IntegrationKey): Promise<IntegrationRow | null> {
  return prismaAdmin.admin_integrations.findUnique({ where: { key } });
}

/** The schedule a patch would produce, for recomputing `next_run_at`. */
export function mergeSchedule(
  current: IntegrationSchedule,
  patch: IntegrationPatch["schedule"],
): IntegrationSchedule {
  return { ...current, ...(patch ?? {}) };
}

/** True when two schedules would fire at the same times. */
function sameSchedule(a: IntegrationSchedule, b: IntegrationSchedule): boolean {
  return (
    a.frequency === b.frequency &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.weekday === b.weekday &&
    a.dayOfMonth === b.dayOfMonth &&
    a.timezone === b.timezone
  );
}

/**
 * Applies a patch.
 *
 * `next_run_at` is recomputed **only** when the schedule or the enabled flag
 * actually changed: a patch that touches nothing but the base URL or the
 * settings must not move a run that is already due (recomputing pushes it to
 * the next occurrence, which silently skips today's). Disabling clears it, so
 * a disabled integration never carries a timestamp the scheduler could act on;
 * enabling computes a fresh one.
 */
export async function updateIntegrationRow(
  row: IntegrationRow,
  patch: IntegrationPatch,
  updatedBy: string | null,
): Promise<IntegrationRow> {
  const current = scheduleOf(row);
  const schedule = mergeSchedule(current, patch.schedule);
  const isEnabled = patch.isEnabled ?? row.is_enabled;
  const settings: IntegrationSettings = patch.settings
    ? { ...settingsOf(row.settings), ...patch.settings }
    : settingsOf(row.settings);
  const timingChanged = !sameSchedule(current, schedule) || isEnabled !== row.is_enabled;
  return prismaAdmin.admin_integrations.update({
    where: { key: row.key },
    data: {
      ...(patch.baseUrl === undefined ? {} : { base_url: patch.baseUrl }),
      is_enabled: isEnabled,
      schedule_frequency: schedule.frequency,
      schedule_hour: schedule.hour,
      schedule_minute: schedule.minute,
      schedule_weekday: schedule.weekday,
      schedule_day_of_month: schedule.dayOfMonth,
      schedule_timezone: schedule.timezone,
      settings: settings as Prisma.InputJsonValue,
      ...(timingChanged ? { next_run_at: nextRunFor(schedule, isEnabled) } : {}),
      updated_at: new Date(),
      updated_by: updatedBy,
    },
  });
}

/**
 * Integrations the scheduler should start now: enabled, on a schedule, and
 * due. Rows whose `next_run_at` is still NULL come back too — the caller
 * computes and stores one rather than running them immediately.
 */
export function dueIntegrationRows(now: Date): Promise<IntegrationRow[]> {
  return prismaAdmin.admin_integrations.findMany({
    where: {
      is_enabled: true,
      schedule_frequency: { not: "off" },
      OR: [{ next_run_at: null }, { next_run_at: { lte: now } }],
    },
    orderBy: { key: "asc" },
  });
}

/**
 * Claims a due integration for this process by moving `next_run_at` forward,
 * atomically. `true` means this process won the claim and must run it.
 *
 * The predicate is `next_run_at <= due` — the same test that put the row on
 * the due list — and the new value is `computeNextRun`, which is strictly in
 * the future. So the first `updateMany` to commit takes the row out of its own
 * predicate, and a second instance ticking at the same second matches no row
 * and counts 0. (Naming the exact old timestamp would be equivalent; `<=` also
 * absorbs a row whose `next_run_at` moved backwards between the read and the
 * claim, which an operator editing the schedule can cause.)
 */
export async function claimDueIntegration(
  key: IntegrationKey,
  due: Date,
  nextRunAt: Date | null,
): Promise<boolean> {
  const result = await prismaAdmin.admin_integrations.updateMany({
    where: { key, is_enabled: true, next_run_at: { lte: due } },
    data: { next_run_at: nextRunAt },
  });
  return result.count === 1;
}

/** Stores a computed `next_run_at` on a row that had none, without running it. */
export async function setNextRunAt(key: IntegrationKey, nextRunAt: Date | null): Promise<void> {
  await prismaAdmin.admin_integrations.updateMany({
    where: { key, next_run_at: null },
    data: { next_run_at: nextRunAt },
  });
}

/* -------------------------------------------------------------------------- */
/*                                Quote symbols                               */
/* -------------------------------------------------------------------------- */

/** `SYMBOL:EXCHANGE` when an exchange is set, the bare symbol otherwise. */
export function canonicalOf(symbol: string, exchange: string | null): string {
  return exchange ? `${symbol}:${exchange}` : symbol;
}

/** Splits a canonical symbol back into its parts. */
export function splitCanonical(canonical: string): { symbol: string; exchange: string | null } {
  const index = canonical.indexOf(":");
  if (index < 0) return { symbol: canonical, exchange: null };
  return { symbol: canonical.slice(0, index), exchange: canonical.slice(index + 1) || null };
}

function watchWhere(query: WatchListQuery): Prisma.admin_quote_symbolsWhereInput {
  const q = query.q?.trim();
  return {
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.active === "active" ? { is_active: true } : {}),
    ...(query.active === "inactive" ? { is_active: false } : {}),
    ...(q
      ? {
          OR: [
            { canonical: { contains: q, mode: "insensitive" } },
            { symbol: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

/** One page of the quote watch list, plus the total matching the query. */
export async function findQuoteSymbolPage(
  query: WatchListQuery,
  page: { skip: number; take: number },
): Promise<{ rows: QuoteSymbolRow[]; total: number }> {
  const where = watchWhere(query);
  const [rows, total] = await Promise.all([
    prismaAdmin.admin_quote_symbols.findMany({
      where,
      orderBy: { canonical: "asc" },
      skip: page.skip,
      take: page.take,
    }),
    prismaAdmin.admin_quote_symbols.count({ where }),
  ]);
  return { rows, total };
}

export function findQuoteSymbolById(id: string): Promise<QuoteSymbolRow | null> {
  return prismaAdmin.admin_quote_symbols.findUnique({ where: { id } });
}

export function findQuoteSymbolByCanonical(canonical: string): Promise<QuoteSymbolRow | null> {
  return prismaAdmin.admin_quote_symbols.findUnique({ where: { canonical } });
}

export function findQuoteSymbolsByCanonical(
  canonicals: readonly string[],
): Promise<QuoteSymbolRow[]> {
  return prismaAdmin.admin_quote_symbols.findMany({ where: { canonical: { in: [...canonicals] } } });
}

/** Every active symbol, in canonical order, for the daily run. */
export function listActiveQuoteSymbols(): Promise<QuoteSymbolRow[]> {
  return prismaAdmin.admin_quote_symbols.findMany({
    where: { is_active: true },
    orderBy: { canonical: "asc" },
  });
}

export interface NewQuoteSymbol {
  kind: QuoteKind;
  symbol: string;
  exchange: string | null;
  canonical: string;
  name: string | null;
  currency: string | null;
  source: WatchSource;
  createdBy: string | null;
}

export function createQuoteSymbol(input: NewQuoteSymbol): Promise<QuoteSymbolRow> {
  return prismaAdmin.admin_quote_symbols.create({
    data: {
      kind: input.kind,
      symbol: input.symbol,
      exchange: input.exchange,
      canonical: input.canonical,
      name: input.name,
      currency: input.currency,
      source: input.source,
      created_by: input.createdBy,
    },
  });
}

export function updateQuoteSymbol(id: string, isActive: boolean): Promise<QuoteSymbolRow> {
  return prismaAdmin.admin_quote_symbols.update({
    where: { id },
    data: { is_active: isActive },
  });
}

export async function deleteQuoteSymbol(id: string): Promise<void> {
  await prismaAdmin.admin_quote_symbols.delete({ where: { id } });
}

/**
 * Records what the provider said about a symbol. A success clears
 * `last_error`, so an operator never sees a stale complaint next to a fresh
 * quote.
 */
export async function markQuoteSymbol(
  canonical: string,
  outcome: {
    quotedAt: Date | null;
    error: string | null;
    /**
     * Which provider produced this quote. Recorded only on a success, and
     * only when the caller names one: a failure must not erase the memory of
     * who served the symbol last time, because that memory is what stops the
     * next run from asking the wrong provider again.
     */
    provider?: IntegrationProvider;
  },
): Promise<void> {
  await prismaAdmin.admin_quote_symbols.updateMany({
    where: { canonical },
    data: {
      ...(outcome.quotedAt ? { last_quoted_at: outcome.quotedAt } : {}),
      ...(outcome.provider === undefined ? {} : { provider: outcome.provider }),
      last_error: outcome.error,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                                   Quotes                                   */
/* -------------------------------------------------------------------------- */

export interface QuoteUpsert {
  symbol: string;
  quoteDate: IsoDate;
  close: number;
  open: number | null;
  high: number | null;
  low: number | null;
  currency: string;
  change: number | null;
  percentChange: number | null;
  provider: IntegrationProvider;
  fetchedAt: Date;
}

/** Whether an upsert wrote a new row or refreshed one that already existed. */
export type WriteOutcome = "created" | "updated";

/** Upserts one quote on `(symbol, quote_date)`. */
export async function upsertQuote(input: QuoteUpsert): Promise<WriteOutcome> {
  const where = { symbol_quote_date: { symbol: input.symbol, quote_date: fromIsoDate(input.quoteDate) } };
  const existing = await prismaAdmin.admin_quotes.findUnique({ where, select: { id: true } });
  const values = {
    close: input.close,
    open: input.open,
    high: input.high,
    low: input.low,
    currency: input.currency,
    change: input.change,
    percent_change: input.percentChange,
    provider: input.provider,
    fetched_at: input.fetchedAt,
  };
  await prismaAdmin.admin_quotes.upsert({
    where,
    create: {
      symbol: input.symbol,
      quote_date: fromIsoDate(input.quoteDate),
      ...values,
    },
    update: { ...values, updated_at: new Date() },
  });
  return existing ? "updated" : "created";
}

/**
 * How far back the first, bounded pass over a cache table looks.
 *
 * Two weeks covers every ordinary case (a daily run, a long weekend, a
 * holiday) while keeping the scan proportional to the number of keys asked
 * for rather than to the whole history of the table, which grows by one row
 * per symbol per trading day forever.
 */
export const LATEST_LOOKBACK_DAYS = 14;

/** Midnight (UTC, as `DATE` columns are stored) `LATEST_LOOKBACK_DAYS` ago. */
function lookbackFrom(): Date {
  return fromIsoDate(shiftDays(todayIn(), -LATEST_LOOKBACK_DAYS));
}

/**
 * The newest cached quote for each of `symbols`, by quote date then fetch
 * time.
 *
 * Two passes rather than one: the first is bounded to the last two weeks and
 * answers every symbol that is remotely current, and only the symbols it found
 * nothing for are looked up again without a date bound (one row each, via
 * `distinct`). The ordering makes the first row per symbol the newest one.
 */
export async function latestQuotesFor(
  symbols: readonly string[],
): Promise<Map<string, Quote>> {
  const latest = new Map<string, Quote>();
  if (symbols.length === 0) return latest;
  const wanted = [...new Set(symbols)];
  const order = [
    { symbol: "asc" as const },
    { quote_date: "desc" as const },
    { fetched_at: "desc" as const },
  ];

  const recent = await prismaAdmin.admin_quotes.findMany({
    where: { symbol: { in: wanted }, quote_date: { gte: lookbackFrom() } },
    orderBy: order,
  });
  for (const row of recent) {
    if (!latest.has(row.symbol)) latest.set(row.symbol, toQuote(row));
  }

  const older = wanted.filter((symbol) => !latest.has(symbol));
  if (older.length === 0) return latest;
  const rows = await prismaAdmin.admin_quotes.findMany({
    where: { symbol: { in: older } },
    orderBy: order,
    distinct: ["symbol"],
  });
  for (const row of rows) {
    if (!latest.has(row.symbol)) latest.set(row.symbol, toQuote(row));
  }
  return latest;
}

/* -------------------------------------------------------------------------- */
/*                               Currency pairs                               */
/* -------------------------------------------------------------------------- */

function pairWhere(query: WatchListQuery): Prisma.admin_currency_pairsWhereInput {
  const q = query.q?.trim();
  return {
    ...(query.active === "active" ? { is_active: true } : {}),
    ...(query.active === "inactive" ? { is_active: false } : {}),
    ...(q
      ? {
          OR: [
            { from_currency: { contains: q, mode: "insensitive" } },
            { to_currency: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

export async function findCurrencyPairPage(
  query: WatchListQuery,
  page: { skip: number; take: number },
): Promise<{ rows: CurrencyPairRow[]; total: number }> {
  const where = pairWhere(query);
  const [rows, total] = await Promise.all([
    prismaAdmin.admin_currency_pairs.findMany({
      where,
      orderBy: [{ from_currency: "asc" }, { to_currency: "asc" }],
      skip: page.skip,
      take: page.take,
    }),
    prismaAdmin.admin_currency_pairs.count({ where }),
  ]);
  return { rows, total };
}

export function findCurrencyPairById(id: string): Promise<CurrencyPairRow | null> {
  return prismaAdmin.admin_currency_pairs.findUnique({ where: { id } });
}

export function findCurrencyPair(from: string, to: string): Promise<CurrencyPairRow | null> {
  return prismaAdmin.admin_currency_pairs.findUnique({
    where: { from_currency_to_currency: { from_currency: from, to_currency: to } },
  });
}

/**
 * Every watch row for the named pairs, **active or not**.
 *
 * The on-demand lookup needs all of them: a pair an operator deactivated must
 * not be fetched for, and must not be inserted again either (the unique key
 * would refuse it, and reactivating it would undo the operator's decision).
 */
export function findCurrencyPairsFor(
  pairs: readonly { from: string; to: string }[],
): Promise<CurrencyPairRow[]> {
  if (pairs.length === 0) return Promise.resolve([]);
  return prismaAdmin.admin_currency_pairs.findMany({
    where: {
      OR: pairs.map((pair) => ({ from_currency: pair.from, to_currency: pair.to })),
    },
  });
}

export function listActiveCurrencyPairs(): Promise<CurrencyPairRow[]> {
  return prismaAdmin.admin_currency_pairs.findMany({
    where: { is_active: true },
    orderBy: [{ from_currency: "asc" }, { to_currency: "asc" }],
  });
}

export function createCurrencyPair(input: {
  fromCurrency: string;
  toCurrency: string;
  source: WatchSource;
  createdBy: string | null;
}): Promise<CurrencyPairRow> {
  return prismaAdmin.admin_currency_pairs.create({
    data: {
      from_currency: input.fromCurrency,
      to_currency: input.toCurrency,
      source: input.source,
      created_by: input.createdBy,
    },
  });
}

export function updateCurrencyPair(id: string, isActive: boolean): Promise<CurrencyPairRow> {
  return prismaAdmin.admin_currency_pairs.update({ where: { id }, data: { is_active: isActive } });
}

export async function deleteCurrencyPair(id: string): Promise<void> {
  await prismaAdmin.admin_currency_pairs.delete({ where: { id } });
}

export async function markCurrencyPair(
  from: string,
  to: string,
  outcome: { ratedAt: Date | null; error: string | null },
): Promise<void> {
  await prismaAdmin.admin_currency_pairs.updateMany({
    where: { from_currency: from, to_currency: to },
    data: {
      ...(outcome.ratedAt ? { last_rated_at: outcome.ratedAt } : {}),
      last_error: outcome.error,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                               Exchange rates                               */
/* -------------------------------------------------------------------------- */

export interface RateUpsert {
  fromCurrency: string;
  toCurrency: string;
  date: IsoDate;
  rate: number;
  source: "boc" | "derived";
  fetchedAt: Date;
}

/** Upserts one rate on `(from, to, date)`. */
export async function upsertExchangeRate(input: RateUpsert): Promise<WriteOutcome> {
  const where = {
    from_currency_to_currency_date: {
      from_currency: input.fromCurrency,
      to_currency: input.toCurrency,
      date: fromIsoDate(input.date),
    },
  };
  const existing = await prismaAdmin.admin_exchange_rates.findUnique({
    where,
    select: { id: true },
  });
  const values = { rate: input.rate, source: input.source, fetched_at: input.fetchedAt };
  await prismaAdmin.admin_exchange_rates.upsert({
    where,
    create: {
      from_currency: input.fromCurrency,
      to_currency: input.toCurrency,
      date: fromIsoDate(input.date),
      ...values,
    },
    update: { ...values, updated_at: new Date() },
  });
  return existing ? "updated" : "created";
}

/**
 * The newest cached rate for each `FROM/TO` pair, keyed by that spelling.
 *
 * Bounded the same way as `latestQuotesFor`: a two-week window first, then one
 * unbounded row per pair that window had nothing for.
 */
export async function latestRatesFor(
  pairs: readonly { from: string; to: string }[],
): Promise<Map<string, ExchangeRate>> {
  const latest = new Map<string, ExchangeRate>();
  if (pairs.length === 0) return latest;
  const order = [
    { from_currency: "asc" as const },
    { to_currency: "asc" as const },
    { date: "desc" as const },
    { fetched_at: "desc" as const },
  ];
  const matching = (list: readonly { from: string; to: string }[]) =>
    list.map((pair) => ({ from_currency: pair.from, to_currency: pair.to }));

  const recent = await prismaAdmin.admin_exchange_rates.findMany({
    where: { date: { gte: lookbackFrom() }, OR: matching(pairs) },
    orderBy: order,
  });
  for (const row of recent) {
    const key = `${row.from_currency}/${row.to_currency}`;
    if (!latest.has(key)) latest.set(key, toExchangeRate(row));
  }

  const older = pairs.filter((pair) => !latest.has(`${pair.from}/${pair.to}`));
  if (older.length === 0) return latest;
  const rows = await prismaAdmin.admin_exchange_rates.findMany({
    where: { OR: matching(older) },
    orderBy: order,
    distinct: ["from_currency", "to_currency"],
  });
  for (const row of rows) {
    const key = `${row.from_currency}/${row.to_currency}`;
    if (!latest.has(key)) latest.set(key, toExchangeRate(row));
  }
  return latest;
}

/**
 * Every `X → CAD` series cached for `date`, as the map the rate arithmetic
 * takes. This is what lets an on-demand lookup answer a brand-new pair
 * without calling the Bank of Canada again: the run caches all ~27 published
 * series each day, and any pair is a ratio of two of them.
 */
export async function cachedSeriesFor(date: IsoDate): Promise<Map<string, number>> {
  const rows = await prismaAdmin.admin_exchange_rates.findMany({
    where: { to_currency: "CAD", date: fromIsoDate(date), source: "boc" },
    select: { from_currency: true, rate: true },
  });
  const series = new Map<string, number>();
  for (const row of rows) series.set(row.from_currency, Number(row.rate));
  return series;
}

/** The newest observation date any cached `X → CAD` series carries. */
export async function newestSeriesDate(): Promise<IsoDate | null> {
  const row = await prismaAdmin.admin_exchange_rates.findFirst({
    where: { to_currency: "CAD", source: "boc" },
    orderBy: { date: "desc" },
    select: { date: true, fetched_at: true },
  });
  return row ? toIsoDate(row.date) : null;
}

/** When the newest cached series was fetched, for the "already today" test. */
export async function newestSeriesFetchedAt(): Promise<Date | null> {
  const row = await prismaAdmin.admin_exchange_rates.findFirst({
    where: { to_currency: "CAD", source: "boc" },
    orderBy: { fetched_at: "desc" },
    select: { fetched_at: true },
  });
  return row?.fetched_at ?? null;
}

/* -------------------------------------------------------------------------- */
/*                          Admin market-data catalogs                        */
/* -------------------------------------------------------------------------- */

/** What a catalog lookup can fill in for a watched symbol. */
export interface CatalogMatch {
  kind: QuoteKind;
  name: string | null;
  currency: string | null;
}

/**
 * Looks a symbol up in the admin `stocks` / `etfs` / `cryptocurrencies`
 * catalogs to fill its name and currency.
 *
 * A miss is not an error: the catalogs are a snapshot, and the run will
 * report the provider's own verdict on the symbol soon enough.
 */
export async function lookupCatalog(
  kind: QuoteKind,
  symbol: string,
  exchange: string | null,
): Promise<CatalogMatch | null> {
  if (kind === "crypto") {
    const row = await prismaAdmin.cryptocurrencies.findFirst({ where: { symbol } });
    return row ? { kind: "crypto", name: null, currency: row.currency_quote || null } : null;
  }
  const where = { symbol, ...(exchange ? { exchange } : {}) };
  if (kind === "etf") {
    const row = await prismaAdmin.etfs.findFirst({ where });
    return row ? { kind: "etf", name: row.name || null, currency: row.currency || null } : null;
  }
  const row = await prismaAdmin.stocks.findFirst({ where });
  return row ? { kind: "stock", name: row.name || null, currency: row.currency || null } : null;
}

/**
 * The kind a requested canonical symbol most likely is, for a symbol the
 * consumer app asked for and the watch list did not have.
 *
 * A slash means a crypto pair (`BTC/USD`). Otherwise the ETF catalog is
 * consulted first and the symbol falls back to `stock`, which is both the
 * common case and the harmless one: the kind only decides which catalog is
 * searched for a display name, never what is sent to the provider.
 */
export async function inferKind(symbol: string, exchange: string | null): Promise<QuoteKind> {
  if (symbol.includes("/")) return "crypto";
  const where = { symbol, ...(exchange ? { exchange } : {}) };
  const etf = await prismaAdmin.etfs.findFirst({ where, select: { id: true } });
  return etf ? "etf" : "stock";
}
