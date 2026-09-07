/**
 * The Constants model, as the API and the UI see it: the reference catalogs
 * the admin database masters (countries, currencies, financial institutions,
 * default categories, account base types, account types, cryptocurrencies,
 * ETFs, stocks, markets) and their push state against the main app database.
 *
 * The admin database is the source of truth; operators edit it here. "Push"
 * upserts rows by id into the main database (`DATABASE_URL`), which the
 * consumer app reads. Push never deletes from the main database: rows there
 * are referenced by tenant data (accounts, transactions, budgets), so removal
 * stays a manual, deliberate operation on the consumer side.
 *
 * Plain data, no React, no Prisma: safe to import from anywhere.
 */

/* -------------------------------------------------------------------------- */
/*                                    Kinds                                   */
/* -------------------------------------------------------------------------- */

export const CONSTANT_KINDS = [
  "countries",
  "currencies",
  "financial_institutions",
  "categories",
  "account_base_types",
  "account_types",
  "cryptocurrencies",
  "etfs",
  "stocks",
  "markets",
] as const;

export type ConstantKind = (typeof CONSTANT_KINDS)[number];

export function isConstantKind(value: string): value is ConstantKind {
  return (CONSTANT_KINDS as readonly string[]).includes(value);
}

export const CONSTANT_KIND_LABELS: Record<ConstantKind, { singular: string; plural: string }> = {
  countries: { singular: "country", plural: "countries" },
  currencies: { singular: "currency", plural: "currencies" },
  financial_institutions: { singular: "financial institution", plural: "financial institutions" },
  categories: { singular: "category", plural: "categories" },
  account_base_types: { singular: "account base type", plural: "account base types" },
  account_types: { singular: "account type", plural: "account types" },
  cryptocurrencies: { singular: "cryptocurrency", plural: "cryptocurrencies" },
  etfs: { singular: "ETF", plural: "ETFs" },
  stocks: { singular: "stock", plural: "stocks" },
  markets: { singular: "market", plural: "markets" },
};

/**
 * Where each kind lands in the main app database. Most tables share their
 * name; the three market-data catalogs are "preload" tables over there.
 */
export const MAIN_TABLE_OF: Record<ConstantKind, string> = {
  countries: "countries",
  currencies: "currencies",
  financial_institutions: "financial_institutions",
  categories: "categories",
  account_base_types: "account_base_types",
  account_types: "account_types",
  cryptocurrencies: "preload_cryptocurrencies",
  etfs: "preload_etfs",
  stocks: "preload_stocks",
  markets: "markets",
};

/**
 * Kinds whose primary key is a Postgres integer sequence rather than a UUID
 * string. The API still carries `id` as a string for every kind (the row
 * types below never change shape); these kinds parse it back to an integer
 * at the database boundary, and a create lets the admin database assign it.
 */
export const INTEGER_ID_KINDS = ["cryptocurrencies", "etfs", "stocks"] as const satisfies readonly ConstantKind[];

export function hasIntegerId(kind: ConstantKind): boolean {
  return (INTEGER_ID_KINDS as readonly string[]).includes(kind);
}

/* -------------------------------------------------------------------------- */
/*                             Listed instruments                             */
/* -------------------------------------------------------------------------- */

/**
 * The two catalogs that carry a listing `country`: they are the only ones the
 * market filter and the preferred-market ordering apply to.
 */
export const MARKET_KINDS = ["etfs", "stocks"] as const satisfies readonly ConstantKind[];

export type MarketKind = (typeof MARKET_KINDS)[number];

export function isMarketKind(kind: ConstantKind): kind is MarketKind {
  return (MARKET_KINDS as readonly string[]).includes(kind);
}

/**
 * The markets this console is mostly used for, most wanted first. ETFs and
 * stocks are listed with these countries' rows ahead of every other country's,
 * because the same ticker is listed on dozens of world exchanges and the
 * Canadian or US listing is the one an operator is looking for. Inside each
 * tier the order is the kind's usual one (symbol, exchange, id).
 *
 * The spellings are the market-data feed's own, as stored in the admin
 * `stocks` / `etfs` tables ("Canada", "United States"), so an exact `=` in
 * SQL matches. Changing one of these strings changes nothing but the order.
 */
export const PREFERRED_COUNTRIES = ["Canada", "United States"] as const;

/**
 * The markets the toolbar's Market filter offers, in the order it shows them:
 * the two preferred ones first, then the countries with the most listings in
 * the two catalogs. Free text is not offered — the filter is an exact match on
 * the feed's spelling, and a typed country would silently return nothing.
 */
export const MARKET_FILTER_COUNTRIES = [
  ...PREFERRED_COUNTRIES,
  "Germany",
  "United Kingdom",
  "Italy",
  "Switzerland",
  "France",
  "Netherlands",
  "Japan",
  "Australia",
  "Hong Kong",
  "Taiwan",
  "India",
  "China",
  "South Korea",
  "Brazil",
] as const;

/** The longest market name the list endpoint accepts, and what the column holds. */
export const COUNTRY_FILTER_MAX = 64;

/* -------------------------------------------------------------------------- */
/*                                    Rows                                    */
/* -------------------------------------------------------------------------- */

/**
 * How an admin row relates to the main database, as recorded in the sync
 * ledger (`admin_constant_sync`) by the last compare or push that touched it:
 * - `new`: no row with this id in the main database yet;
 * - `changed`: the main row exists but at least one pushed field differs;
 * - `synced`: identical;
 * - `unknown`: never compared (the catalog has not been compared since the
 *   row was added, or the ledger was reset).
 *
 * Catalogs run to hundreds of thousands of rows, so the state is not
 * recomputed on every read: a **compare job** walks the catalog and fills the
 * ledger, and afterwards create / edit / delete / push keep their own row's
 * entry current. The ledger also records ids that exist only in the main
 * database (`main_only`); those never appear as rows here, only as a count.
 */
export type PushState = "new" | "changed" | "synced" | "unknown";

export const PUSH_STATES = ["new", "changed", "synced", "unknown"] as const satisfies readonly PushState[];

interface ConstantRowBase {
  /** Always a string on the wire, even for the integer-keyed kinds (`INTEGER_ID_KINDS`). */
  id: string;
  pushState: PushState;
}

export interface CountryRow extends ConstantRowBase {
  name: string;
  alpha2Code: string;
  alpha3Code: string;
  /** Id of a currency in the admin catalog, or null. */
  currencyId: string | null;
  createdAt: string | null;
}

export interface CurrencyRow extends ConstantRowBase {
  code: string;
  name: string;
  symbol: string | null;
  createdAt: string | null;
}

export interface FinancialInstitutionRow extends ConstantRowBase {
  name: string;
  institutionNumber: string;
  /** Free text; the seed uses `bank` and `credit union`. */
  type: string;
}

/** Category direction as the seed spells it. */
export const CATEGORY_TYPES = ["Inflow", "Outflow"] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];

export interface CategoryRow extends ConstantRowBase {
  name: string;
  /**
   * The stored value, verbatim. The seed uses `Inflow` / `Outflow` and the
   * form only offers those, but the column is free text on both databases, so
   * an unexpected spelling is carried through unchanged rather than pushed as
   * null over the consumer app's value.
   */
  type: string | null;
  /** Id of the parent category in the admin catalog, or null for a top-level one. */
  parentId: string | null;
  isDiscretionary: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Set when the category is retired; a push carries the retirement to the main database. */
  deletedAt: string | null;
}

/** The grouping an account type belongs to (Assets, Banking, Loans, …). `name` is unique. */
export interface AccountBaseTypeRow extends ConstantRowBase {
  name: string;
}

export interface AccountTypeRow extends ConstantRowBase {
  /** Machine name, unique among live rows (case-insensitive). */
  name: string;
  displayName: string;
  isAsset: boolean;
  isBanking: boolean;
  isInvestment: boolean;
  /** Id of an account base type in the admin catalog, or null. */
  baseTypeId: string | null;
  /** Set when the account type is retired; a push carries the retirement to the main database. */
  deletedAt: string | null;
}

/** One tradable crypto pair as the market-data feed describes it. Unique on (symbol, base, quote). */
export interface CryptocurrencyRow extends ConstantRowBase {
  symbol: string;
  /** Free text from the feed, typically a comma-separated list of exchange names. */
  availableExchanges: string;
  currencyBase: string;
  currencyQuote: string;
  createdAt: string | null;
}

/** A listed ETF. Unique on (symbol, exchange). */
export interface EtfRow extends ConstantRowBase {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  micCode: string;
  country: string;
  figiCode: string;
  cfiCode: string;
  isin: string;
  cusip: string;
  createdAt: string | null;
}

/** A listed stock. Unique on (symbol, exchange). Same shape as an ETF plus `type`. */
export interface StockRow extends EtfRow {
  /** Free text from the feed, e.g. "Common Stock", "Depositary Receipt". */
  type: string;
}

/** An exchange / market segment by ISO 10383 MIC. Unique on `micCode`. Retirable. */
export interface MarketRow extends ConstantRowBase {
  micCode: string;
  operatingMic: string;
  marketName: string;
  isoCountryCode: string;
  city: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** Set when the market is retired; a push carries the retirement to the main database. */
  deletedAt: string | null;
}

export type ConstantRowOf<K extends ConstantKind> = K extends "countries"
  ? CountryRow
  : K extends "currencies"
    ? CurrencyRow
    : K extends "financial_institutions"
      ? FinancialInstitutionRow
      : K extends "categories"
        ? CategoryRow
        : K extends "account_base_types"
          ? AccountBaseTypeRow
          : K extends "account_types"
            ? AccountTypeRow
            : K extends "cryptocurrencies"
              ? CryptocurrencyRow
              : K extends "etfs"
                ? EtfRow
                : K extends "stocks"
                  ? StockRow
                  : MarketRow;

export type ConstantRow =
  | CountryRow
  | CurrencyRow
  | FinancialInstitutionRow
  | CategoryRow
  | AccountBaseTypeRow
  | AccountTypeRow
  | CryptocurrencyRow
  | EtfRow
  | StockRow
  | MarketRow;

/* -------------------------------------------------------------------------- */
/*                                   Inputs                                   */
/* -------------------------------------------------------------------------- */

export interface CountryInput {
  name: string;
  alpha2Code: string;
  alpha3Code: string;
  currencyId: string | null;
}

export interface CurrencyInput {
  code: string;
  name: string;
  symbol: string | null;
}

export interface FinancialInstitutionInput {
  name: string;
  institutionNumber: string;
  type: string;
}

export interface CategoryInput {
  name: string;
  type: CategoryType | null;
  parentId: string | null;
  isDiscretionary: boolean | null;
}

export interface AccountBaseTypeInput {
  name: string;
}

export interface AccountTypeInput {
  name: string;
  displayName: string;
  isAsset: boolean;
  isBanking: boolean;
  isInvestment: boolean;
  baseTypeId: string | null;
}

export interface CryptocurrencyInput {
  symbol: string;
  availableExchanges: string;
  currencyBase: string;
  currencyQuote: string;
}

export interface EtfInput {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  micCode: string;
  country: string;
  figiCode: string;
  cfiCode: string;
  isin: string;
  cusip: string;
}

export interface StockInput extends EtfInput {
  type: string;
}

export interface MarketInput {
  micCode: string;
  operatingMic: string;
  marketName: string;
  isoCountryCode: string;
  city: string;
}

export type ConstantInputOf<K extends ConstantKind> = K extends "countries"
  ? CountryInput
  : K extends "currencies"
    ? CurrencyInput
    : K extends "financial_institutions"
      ? FinancialInstitutionInput
      : K extends "categories"
        ? CategoryInput
        : K extends "account_base_types"
          ? AccountBaseTypeInput
          : K extends "account_types"
            ? AccountTypeInput
            : K extends "cryptocurrencies"
              ? CryptocurrencyInput
              : K extends "etfs"
                ? EtfInput
                : K extends "stocks"
                  ? StockInput
                  : MarketInput;

/** PATCH bodies are partial; every field is optional but at least one must be present. */
export type ConstantPatchOf<K extends ConstantKind> = Partial<ConstantInputOf<K>>;

/* -------------------------------------------------------------------------- */
/*                                 Responses                                  */
/* -------------------------------------------------------------------------- */

/** Query string of the list endpoint. Everything is optional. */
export interface ListQuery {
  /** 1-based. Default 1. */
  page?: number;
  /** 1..200. Default 50. */
  pageSize?: number;
  /** Free-text search over the kind's searchable columns (see `docs/constants.md`). */
  q?: string;
  /**
   * `all` (default) for every live row; a push state; `pending` for
   * new + changed; `retired` for the retirable kinds' soft-deleted rows.
   */
  state?: PushState | "all" | "pending" | "retired";
  /**
   * Exact match on the listing country, for `etfs` and `stocks` only (see
   * `MARKET_KINDS`); the other kinds ignore it. Undefined or empty means every
   * market, which is the default — the preferred-market ordering already puts
   * the Canadian and US listings first.
   */
  country?: string;
}

export const LIST_PAGE_SIZE_DEFAULT = 50;
export const LIST_PAGE_SIZE_MAX = 200;

/** Whole-catalog figures, from the sync ledger plus a count of the catalog itself. */
export interface StateCounts {
  /** Every row in the admin catalog, live and retired. */
  total: number;
  new: number;
  changed: number;
  synced: number;
  unknown: number;
  /** Soft-deleted rows of a retirable kind; 0 otherwise. Included in `total`. */
  retired: number;
  /** Ids the main database has that the admin catalog does not. Not rows here. */
  mainOnly: number;
}

export interface ConstantListResponse<K extends ConstantKind> {
  kind: K;
  /** One page, in the kind's natural order. */
  rows: ConstantRowOf<K>[];
  page: number;
  pageSize: number;
  /** Rows matching the query, all pages. */
  total: number;
  counts: StateCounts;
  /** When the last compare job for this kind finished; null before the first. */
  lastComparedAt: string | null;
  /** The most recent job for this kind, running or finished, so the page can resume polling. */
  latestJob: ConstantJob | null;
}

/* -------------------------------------------------------------------------- */
/*                                    Jobs                                    */
/* -------------------------------------------------------------------------- */

export type ConstantJobType = "compare" | "push";

/**
 * `queued` → `running` → `succeeded` | `failed`. `interrupted` is what a
 * running job becomes when its heartbeat goes stale (the process restarted
 * under it); nothing it wrote is lost, since every batch commits on its own,
 * and it can simply be run again.
 */
export type ConstantJobStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted";

export interface ConstantJob {
  id: string;
  kind: ConstantKind;
  type: ConstantJobType;
  status: ConstantJobStatus;
  /** Rows the job set out to process; null until known. */
  total: number | null;
  processed: number;
  /** Push only. */
  created: number;
  updated: number;
  unchanged: number;
  /** Push only: rows of other kinds written first so foreign keys hold. */
  dependencyRows: number;
  /** Compare only: ids found in the main database but not in the admin catalog. */
  mainOnly: number;
  error: string | null;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
}

/**
 * A job whose heartbeat (or, while still `queued`, whose creation) is older
 * than this is reported as `interrupted`. Five minutes: a heartbeat is written
 * at least every 15 s while a job runs, and one batch may legitimately take up
 * to a minute, so a stale heartbeat really does mean the process is gone.
 */
export const JOB_STALE_AFTER_MS = 5 * 60_000;

/** How often a running job refreshes its heartbeat regardless of batch progress. */
export const JOB_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * A push request. Exactly one of `ids` or `scope`:
 * - `ids`: those rows (1..`PUSH_IDS_MAX`), any state; unknown ids are a 404;
 * - `scope: "pending"`: every row whose ledger state is new or changed;
 * - `scope: "all"`: every row of the kind, including retired ones.
 *
 * Requests of at most `PUSH_INLINE_MAX` rows finish before the response is
 * sent, so the returned job is already `succeeded` (or `failed`); larger ones
 * come back `running` and are followed through the jobs endpoint.
 */
export type PushInput = { ids: string[]; scope?: never } | { scope: "pending" | "all"; ids?: never };

export const PUSH_IDS_MAX = 5000;
export const PUSH_INLINE_MAX = 200;
/** Rows per batch; each batch is its own transaction on the main database. */
export const PUSH_BATCH_SIZE = 1000;

/** The push and compare endpoints answer with the job they created. */
export interface JobResponse {
  job: ConstantJob;
}
