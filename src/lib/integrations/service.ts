import "server-only";
/**
 * The glue the Integrations routes call: the admin database
 * (`./repository.ts`), the run runner (`./runs.ts`) and the run bodies
 * (`./jobs/*`), shaped into the responses declared in `./types.ts`.
 *
 * Routes stay thin — they validate the path segment, the query string and the
 * body, and call one of these.
 *
 * Two decisions live here rather than in a route:
 *
 * - **A manual run is never inline.** The catalog download moves hundreds of
 *   thousands of rows and a quote run deliberately paces itself against a
 *   per-minute credit allowance, so neither can finish inside a request. The
 *   rate run could, but making one of the three behave differently would only
 *   mean the page needs two code paths for the same button. Every operator
 *   run answers `running` and is followed through `GET …/runs/[runId]`. The
 *   on-demand lookups are the exception, and they run inline by definition —
 *   as is the six-month history a currency pair is added with, or fetched for
 *   from its drawer (`./backfill.ts`): it is one ranged call, the operator is
 *   waiting for its verdict, and the answer carries it.
 * - **A missing API key is refused before the run row is written.** Starting a
 *   run that can only fail, and leaving a failed row behind, is worse than a
 *   422 that says which environment variable is unset.
 */
import { Prisma } from "@/generated/prisma-admin/client";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/api/errors";
import type { ValidationDetails } from "@/lib/api/validate";
import { DIRECTORY_INTEGRATION_KEY } from "@/lib/customers/types";
import { backfillPairHistory, backfillWindow } from "./backfill";
import { allocateCostsWork } from "./jobs/allocate-costs";
import { alphaVantageQuotesWork } from "./jobs/alpha-vantage";
import { awsCostsWork } from "./jobs/aws-costs";
import { cognitoDirectoryWork } from "./jobs/cognito-directory";
import { catalogsWork } from "./jobs/catalogs";
import { marketsWork } from "./jobs/markets";
import { quotesWork } from "./jobs/quotes";
import { ratesWork } from "./jobs/rates";
import {
  allocateCostsSettings,
  alphaVantageSettings,
  apiKeyOf,
  awsCostsSettings,
  cognitoDirectorySettings,
  canonicalOf,
  catalogTargets,
  createCurrencyPair,
  createQuoteSymbol,
  deleteCurrencyPair,
  deleteQuoteSymbol,
  findCurrencyPair,
  findCurrencyPairById,
  findCurrencyPairPage,
  findExchangeRatePage,
  findIntegrationRow,
  findQuoteSymbolByCanonical,
  findQuoteSymbolById,
  findQuoteSymbolPage,
  latestQuotesFor,
  latestRatesFor,
  listIntegrationRows,
  lookupCatalog,
  marketsSettings,
  quoteSettings,
  settingsOf,
  toCurrencyPair,
  toExchangeRate,
  toIntegration,
  toQuoteSymbol,
  updateCurrencyPair,
  updateIntegrationRow,
  updateQuoteSymbol,
} from "./repository";
import { baseUrlDomainMessage, isAllowedBaseUrl } from "./schemas";
import { beginRun, getRun, latestRuns, listRuns, type RunWork } from "./runs";
import { isSchedulerActive } from "./scheduler-state";
import {
  RATE_HISTORY_PAGE_SIZE_DEFAULT,
  INTEGRATION_KEYS,
  isIntegrationKey,
  WATCH_PAGE_SIZE_DEFAULT,
  WATCH_PAGE_SIZE_MAX,
  type CurrencyPair,
  type CurrencyPairInput,
  type CurrencyPairListResponse,
  type CurrencyPairPatch,
  type CurrencyPairWithHistory,
  type ExchangeRateListResponse,
  type Integration,
  type IntegrationKey,
  type IntegrationListResponse,
  type IntegrationPatch,
  type IntegrationRun,
  type QuoteSymbol,
  type QuoteSymbolInput,
  type QuoteSymbolListResponse,
  type IntegrationProvider,
  type QuoteSymbolPatch,
  type RateHistoryQuery,
  type RunRequest,
  type RunTrigger,
  type WatchListQuery,
} from "./types";

/** Any RFC 4122 variant; the id columns are Postgres `uuid`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrows the `[key]` path segment. An unknown integration is a 404, not a
 * 422: from the caller's side the URL simply does not exist. The static
 * segments (`quote-symbols`, `currency-pairs`) never reach this — Next
 * matches them ahead of `[key]` — but an unknown key still has to 404 rather
 * than fall through to a database lookup.
 */
export function parseIntegrationKey(value: string): IntegrationKey {
  if (!isIntegrationKey(value)) throw new NotFoundError("That integration does not exist.");
  return value;
}

function requireUuid(id: string, what: string): string {
  if (!UUID.test(id)) throw new NotFoundError(`That ${what} does not exist.`);
  return id;
}

/**
 * Renders the two races a read-then-write cannot exclude as the answers the
 * check itself would have given.
 *
 * Every write below reads first (is this canonical already watched? does this
 * row still exist?), and two operators can pass the same check at the same
 * moment. The database's unique key and its row lookup are the last word:
 * Prisma's `P2002` becomes the same 409 the read would have raised and `P2025`
 * the same 404, rather than an unexplained 500. Same shape as
 * `withUniqueViolation` in `src/lib/constants/repository.ts`.
 */
async function withWriteRaces<T>(
  run: () => Promise<T>,
  messages: { conflict: string; notFound: string },
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") throw new ConflictError(messages.conflict);
      if (error.code === "P2025") throw new NotFoundError(messages.notFound);
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/*                                Integrations                                */
/* -------------------------------------------------------------------------- */

/**
 * Every integration with its newest run.
 *
 * The seed may not have run yet, in which case the list is simply empty; the
 * page says so rather than inventing rows the database does not have.
 */
export async function listIntegrations(): Promise<IntegrationListResponse> {
  const rows = await listIntegrationRows();
  const runs = await latestRuns(rows.map((row) => row.key as IntegrationKey));
  const integrations: Integration[] = rows
    .map((row) => ({
      ...toIntegration(row),
      latestRun: runs.get(row.key as IntegrationKey) ?? null,
    }))
    // Seed order (quotes, rates, catalogs) is not alphabetical; the page shows
    // them in the order the code declares them.
    .sort(
      (a, b) => INTEGRATION_KEYS.indexOf(a.key) - INTEGRATION_KEYS.indexOf(b.key),
    );
  return { integrations, schedulerActive: isSchedulerActive() };
}

async function requireIntegration(key: IntegrationKey) {
  const row = await findIntegrationRow(key);
  if (!row) {
    throw new NotFoundError(
      "That integration is not installed. Run docs/sql/008_integrations.sql.",
    );
  }
  return row;
}

/** One integration with its newest run, after a change. */
async function withLatestRun(key: IntegrationKey): Promise<Integration> {
  const row = await requireIntegration(key);
  const runs = await latestRuns([key]);
  return { ...toIntegration(row), latestRun: runs.get(key) ?? null };
}

/**
 * Applies a patch, and recomputes when the scheduler will next start it when
 * the schedule or the enabled flag changed.
 *
 * The base URL is checked against the provider's own domain here rather than
 * in the schema, because only the stored row says which provider this key
 * speaks to. It is a security check, not a nicety: the TwelveData calls carry
 * an API key, so an operator who could point the base URL at a host of their
 * choosing could make this server hand that key over.
 *
 * @throws {ValidationError} the base URL is outside the provider's domain.
 */
export async function patchIntegration(
  key: IntegrationKey,
  patch: IntegrationPatch,
  updatedBy: string | null,
): Promise<Integration> {
  const row = await requireIntegration(key);
  if (patch.baseUrl !== undefined) {
    const provider = row.provider as IntegrationProvider;
    if (!isAllowedBaseUrl(provider, patch.baseUrl)) {
      const message = baseUrlDomainMessage(provider);
      const details: ValidationDetails = { formErrors: [], fieldErrors: { baseUrl: [message] } };
      throw new ValidationError(message, details);
    }
  }
  await updateIntegrationRow(row, patch, updatedBy);
  return withLatestRun(key);
}

/* -------------------------------------------------------------------------- */
/*                                    Runs                                    */
/* -------------------------------------------------------------------------- */

type IntegrationRow = Awaited<ReturnType<typeof requireIntegration>>;

/**
 * The API key an integration needs, or a 422 naming the variable.
 *
 * Refused here rather than inside the run body on purpose: starting a run
 * that can only fail, and leaving a failed row behind, is worse than telling
 * the operator which environment variable is unset.
 *
 * @throws {ValidationError} the key is required and not configured.
 */
function requireApiKey(row: IntegrationRow): string {
  const apiKey = apiKeyOf(row);
  if (row.requires_api_key && !apiKey) {
    throw new ValidationError(
      `${row.api_key_env ?? "The API key"} is not configured on this deployment.`,
    );
  }
  return apiKey ?? "";
}

/**
 * The work one integration does, with its settings and the API key resolved.
 *
 * @throws {ValidationError} the integration needs a key that is not configured.
 */
export function workFor(row: IntegrationRow, request: RunRequest): RunWork {
  const settings = settingsOf(row.settings);
  const key = row.key as IntegrationKey;

  if (key === "twelvedata_catalogs") {
    return catalogsWork({ baseUrl: row.base_url, targets: catalogTargets(settings) });
  }

  if (key === "iso_mic_markets") {
    return marketsWork({
      baseUrl: row.base_url,
      includeExpired: marketsSettings(settings).includeExpired,
    });
  }

  if (key === "twelvedata_quotes") {
    const apiKey = requireApiKey(row);
    const { batchSize, creditsPerMinute } = quoteSettings(settings);
    return quotesWork({
      baseUrl: row.base_url,
      apiKey,
      batchSize,
      creditsPerMinute,
      force: request.force === true,
    });
  }

  if (key === "alpha_vantage_quotes") {
    const apiKey = requireApiKey(row);
    const { maxRequestsPerRun, requestsPerMinute } = alphaVantageSettings(settings);
    return alphaVantageQuotesWork({
      baseUrl: row.base_url,
      apiKey,
      maxRequestsPerRun,
      requestsPerMinute,
      force: request.force === true,
    });
  }

  if (key === "aws_costs") {
    // No `baseUrl` and no `apiKey`: the provider is AWS itself, the endpoint
    // is the SDK's own (us-east-1, pinned in src/lib/costs/aws.ts) and the
    // credential is the ECS task role from the SDK's default chain. The row's
    // `base_url` is shown on the Integrations page for orientation and is
    // read by nothing. `force` has no meaning either — the run always
    // re-fetches and replaces its whole window.
    return awsCostsWork(awsCostsSettings(settings));
  }

  if (key === "allocate_costs") {
    // The one run that calls nothing at all. Both inputs are already in the
    // two databases — the cost rows `aws_costs` cached, and the consumer
    // app's own usage counters — so there is no `baseUrl`, no `apiKey`, and
    // nothing for `force` to mean: every run recomputes its whole window of
    // months from scratch.
    return allocateCostsWork(allocateCostsSettings(settings));
  }

  if (key === DIRECTORY_INTEGRATION_KEY) {
    // Same shape as `aws_costs`: no `baseUrl` and no `apiKey`, because the
    // provider is AWS itself (Cognito and CloudWatch) and the credential is
    // the task role from the SDK's default chain. `force` has no meaning —
    // the run always reads the whole pool and always replaces its metrics
    // window — so it is not passed on.
    //
    // The key is the shared constant rather than a literal: the same string
    // is the `admin_integrations.key` seeded by
    // docs/sql/014_customer_statistics.sql ('cognito_directory') and what the
    // Customers page's "Take snapshot" button posts to
    // /api/v1/admin/integrations/[key]/run, so the three must agree.
    return cognitoDirectoryWork(cognitoDirectorySettings(settings));
  }

  return ratesWork({ baseUrl: row.base_url, force: request.force === true });
}

/**
 * Starts a run.
 *
 * @throws {NotFoundError} the integration is not installed.
 * @throws {ValidationError} its API key is not configured.
 * @throws {ConflictError} a run is already live for it.
 */
export async function startIntegrationRun(
  key: IntegrationKey,
  request: RunRequest,
  options: { trigger: RunTrigger; requestedBy: string | null; inline?: boolean },
): Promise<IntegrationRun> {
  const row = await requireIntegration(key);
  const work = workFor(row, request);
  return beginRun({
    integrationKey: key,
    trigger: options.trigger,
    requestedBy: options.requestedBy,
    request: { ...(request.force === undefined ? {} : { force: request.force }) },
    inline: options.inline ?? false,
    work,
  });
}

/** Recent runs for one integration, newest first. */
export function listIntegrationRuns(key: IntegrationKey, limit: number): Promise<IntegrationRun[]> {
  return listRuns(key, limit);
}

/** One run by id. A non-uuid, or another integration's run, is a 404. */
export async function getIntegrationRun(
  key: IntegrationKey,
  runId: string,
): Promise<IntegrationRun> {
  requireUuid(runId, "run");
  const run = await getRun(key, runId);
  if (!run) throw new NotFoundError("That run does not exist.");
  return run;
}

/* -------------------------------------------------------------------------- */
/*                                Watch lists                                 */
/* -------------------------------------------------------------------------- */

function paging(query: WatchListQuery): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(
    WATCH_PAGE_SIZE_MAX,
    Math.max(1, Math.trunc(query.pageSize ?? WATCH_PAGE_SIZE_DEFAULT)),
  );
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** One page of the quote watch list, each symbol with its newest quote. */
export async function listQuoteSymbols(query: WatchListQuery): Promise<QuoteSymbolListResponse> {
  const { page, pageSize, skip } = paging(query);
  const { rows, total } = await findQuoteSymbolPage(query, { skip, take: pageSize });
  const quotes = await latestQuotesFor(rows.map((row) => row.canonical));
  return {
    items: rows.map((row) => toQuoteSymbol(row, quotes.get(row.canonical) ?? null)),
    total,
    page,
    pageSize,
  };
}

/**
 * Adds a symbol to the quote watch list.
 *
 * The admin catalog is consulted for a display name and currency, but a miss
 * is **not** a refusal: the catalogs are a snapshot of what TwelveData last
 * published, and the operator gets a more useful verdict from the next run
 * (the symbol's `lastError` says exactly what the provider thinks of it).
 *
 * @throws {ConflictError} the canonical symbol is already watched.
 */
export async function addQuoteSymbol(
  input: QuoteSymbolInput,
  createdBy: string | null,
): Promise<QuoteSymbol> {
  const exchange = input.kind === "crypto" ? null : (input.exchange ?? null);
  const canonical = canonicalOf(input.symbol, exchange);
  const existing = await findQuoteSymbolByCanonical(canonical);
  if (existing) throw new ConflictError(`${canonical} is already on the watch list.`);
  const match = await lookupCatalog(input.kind, input.symbol, exchange);
  const row = await withWriteRaces(
    () =>
      createQuoteSymbol({
        kind: input.kind,
        symbol: input.symbol,
        exchange,
        canonical,
        name: match?.name ?? null,
        currency: match?.currency ?? null,
        source: "manual",
        createdBy,
      }),
    {
      conflict: `${canonical} is already on the watch list.`,
      notFound: "That symbol is not on the watch list.",
    },
  );
  return toQuoteSymbol(row, null);
}

export async function patchQuoteSymbol(id: string, patch: QuoteSymbolPatch): Promise<QuoteSymbol> {
  requireUuid(id, "symbol");
  const existing = await findQuoteSymbolById(id);
  if (!existing) throw new NotFoundError("That symbol is not on the watch list.");
  if (patch.isActive === undefined) {
    const quotes = await latestQuotesFor([existing.canonical]);
    return toQuoteSymbol(existing, quotes.get(existing.canonical) ?? null);
  }
  const row = await withWriteRaces(() => updateQuoteSymbol(id, patch.isActive === true), {
    conflict: `${existing.canonical} is already on the watch list.`,
    notFound: "That symbol is not on the watch list.",
  });
  const quotes = await latestQuotesFor([row.canonical]);
  return toQuoteSymbol(row, quotes.get(row.canonical) ?? null);
}

/** Removes the watch row. Cached quotes are kept: they cost credits. */
export async function removeQuoteSymbol(id: string): Promise<void> {
  requireUuid(id, "symbol");
  const existing = await findQuoteSymbolById(id);
  if (!existing) throw new NotFoundError("That symbol is not on the watch list.");
  await withWriteRaces(() => deleteQuoteSymbol(id), {
    conflict: `${existing.canonical} is already on the watch list.`,
    notFound: "That symbol is not on the watch list.",
  });
}

/** One page of the currency pair watch list, each pair with its newest rate. */
export async function listCurrencyPairs(query: WatchListQuery): Promise<CurrencyPairListResponse> {
  const { page, pageSize, skip } = paging(query);
  const { rows, total } = await findCurrencyPairPage(query, { skip, take: pageSize });
  const rates = await latestRatesFor(
    rows.map((row) => ({ from: row.from_currency, to: row.to_currency })),
  );
  return {
    items: rows.map((row) =>
      toCurrencyPair(row, rates.get(`${row.from_currency}/${row.to_currency}`) ?? null),
    ),
    total,
    page,
    pageSize,
  };
}

/** One `admin_currency_pairs` row, as the repository hands it over. */
type CurrencyPairRow = NonNullable<Awaited<ReturnType<typeof findCurrencyPairById>>>;

/**
 * The watch row as it stands right now, with its newest cached rate.
 *
 * Read again from the database rather than reused from before the fetch: a
 * backfill stamps `last_rated_at` and clears (or sets) `last_error`, and the
 * page draws those two columns from the answer.
 */
async function currencyPairWithRate(id: string, fallback: CurrencyPairRow): Promise<CurrencyPair> {
  const row = (await findCurrencyPairById(id)) ?? fallback;
  const rates = await latestRatesFor([{ from: row.from_currency, to: row.to_currency }]);
  return toCurrencyPair(row, rates.get(`${row.from_currency}/${row.to_currency}`) ?? null);
}

/**
 * Adds a pair to the watch list **and brings six months of history with it**.
 *
 * A pair added by hand used to sit there with no rate until that night's run,
 * which reads as "nothing happened". The add therefore ends with one ranged
 * Bank of Canada call (`backfillPairHistory`, recorded as an inline
 * `on_demand` run) for `today − 182 days` → today, and the answer says what
 * that produced so the page can report it.
 *
 * The history fetch never fails the add: a disabled integration, a run that is
 * already live or a provider error comes back as a `status` on `history`, and
 * the pair is on the watch list either way — which is what the operator asked
 * for, and what the nightly run needs.
 *
 * @throws {ConflictError} the pair is already watched.
 */
export async function addCurrencyPair(
  input: CurrencyPairInput,
  createdBy: string | null,
): Promise<CurrencyPairWithHistory> {
  const existing = await findCurrencyPair(input.fromCurrency, input.toCurrency);
  if (existing) {
    throw new ConflictError(
      `${input.fromCurrency}/${input.toCurrency} is already on the watch list.`,
    );
  }
  const row = await withWriteRaces(
    () =>
      createCurrencyPair({
        fromCurrency: input.fromCurrency,
        toCurrency: input.toCurrency,
        source: "manual",
        createdBy,
      }),
    {
      conflict: `${input.fromCurrency}/${input.toCurrency} is already on the watch list.`,
      notFound: "That currency pair is not on the watch list.",
    },
  );
  const { from, to } = backfillWindow();
  const history = await backfillPairHistory(
    { from: row.from_currency, to: row.to_currency },
    from,
    to,
    { requestedBy: createdBy, reason: "manual_add" },
  );
  return { pair: await currencyPairWithRate(row.id, row), history };
}

/**
 * Fetches the last six months for a pair that is already watched — the
 * drawer's "Fetch 6 months" button.
 *
 * The same window and the same shared function the manual add uses, so both
 * answers mean the same thing. An **inactive** pair is refused: switching a
 * pair off is an operator's decision that no fetch overturns, exactly as the
 * on-demand lookup treats it (it answers from the cache and calls nobody).
 *
 * @throws {NotFoundError} no such watch row.
 * @throws {ConflictError} the pair is inactive.
 */
export async function backfillCurrencyPairHistory(
  id: string,
  requestedBy: string | null,
): Promise<CurrencyPairWithHistory> {
  requireUuid(id, "currency pair");
  const existing = await findCurrencyPairById(id);
  if (!existing) throw new NotFoundError("That currency pair is not on the watch list.");
  const label = `${existing.from_currency}/${existing.to_currency}`;
  if (!existing.is_active) {
    throw new ConflictError(
      `${label} is inactive. Activate it before fetching its history: an inactive pair is deliberately never fetched for.`,
    );
  }
  const { from, to } = backfillWindow();
  const history = await backfillPairHistory(
    { from: existing.from_currency, to: existing.to_currency },
    from,
    to,
    { requestedBy, reason: "manual_backfill" },
  );
  return { pair: await currencyPairWithRate(id, existing), history };
}

export async function patchCurrencyPair(
  id: string,
  patch: CurrencyPairPatch,
): Promise<CurrencyPair> {
  requireUuid(id, "currency pair");
  const existing = await findCurrencyPairById(id);
  if (!existing) throw new NotFoundError("That currency pair is not on the watch list.");
  const pair = `${existing.from_currency}/${existing.to_currency}`;
  const row =
    patch.isActive === undefined
      ? existing
      : await withWriteRaces(() => updateCurrencyPair(id, patch.isActive === true), {
          conflict: `${pair} is already on the watch list.`,
          notFound: "That currency pair is not on the watch list.",
        });
  const rates = await latestRatesFor([{ from: row.from_currency, to: row.to_currency }]);
  return toCurrencyPair(row, rates.get(`${row.from_currency}/${row.to_currency}`) ?? null);
}

/** Removes the watch row. Cached rates are kept. */
export async function removeCurrencyPair(id: string): Promise<void> {
  requireUuid(id, "currency pair");
  const existing = await findCurrencyPairById(id);
  if (!existing) throw new NotFoundError("That currency pair is not on the watch list.");
  await withWriteRaces(() => deleteCurrencyPair(id), {
    conflict: `${existing.from_currency}/${existing.to_currency} is already on the watch list.`,
    notFound: "That currency pair is not on the watch list.",
  });
}

/**
 * One page of what has been downloaded for a pair, newest observation day
 * first: the rate, where it came from (read from the Bank's own series, or
 * derived from two of them) and when it was fetched.
 *
 * Addressed by the watch row's id rather than by the two codes, so the drawer
 * asks with what the list already gave it, and a pair that has been removed
 * from the watch list is a 404 even though its rates are still stored — the
 * history is a view of a watched pair, not a query over the rate table.
 */
export async function listCurrencyPairRates(
  id: string,
  query: RateHistoryQuery,
): Promise<ExchangeRateListResponse> {
  requireUuid(id, "currency pair");
  const pair = await findCurrencyPairById(id);
  if (!pair) throw new NotFoundError("That currency pair is not on the watch list.");
  const { page, pageSize, skip } = paging({
    ...query,
    pageSize: query.pageSize ?? RATE_HISTORY_PAGE_SIZE_DEFAULT,
  });
  const { rows, total } = await findExchangeRatePage(pair.from_currency, pair.to_currency, {
    skip,
    take: pageSize,
  });
  return { items: rows.map(toExchangeRate), total, page, pageSize };
}
