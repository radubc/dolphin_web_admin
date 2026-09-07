import "server-only";
/**
 * The reference catalogs as they live in the **admin** database
 * (`ADMIN_DATABASE_URL`, through `prismaAdmin`): countries, currencies,
 * financial institutions, the default category tree, the account base types
 * and account types the consumer app classifies accounts with, and the
 * market-data catalogs (cryptocurrencies, ETFs, stocks, markets).
 *
 * This is the source of truth. Nothing here touches the main app database —
 * carrying a change across is `./push.ts`.
 *
 * Every business rule is enforced here rather than in a route, so it holds
 * whoever calls: code and name uniqueness, referential integrity between
 * countries and currencies and between account types and their base type, and
 * the shape of the category tree. A violation is thrown as an `ApiError` from
 * `src/lib/api/errors.ts` (409 `conflict`, 422 `validation_failed`, 404
 * `not_found`), which `adminHandler` renders as-is.
 *
 * Three kinds — `cryptocurrencies`, `etfs`, `stocks` — are keyed by an
 * integer sequence rather than a UUID. Their ids are serialised as strings
 * like every other kind's and parsed back through `./ids.ts`, which is the
 * only place a wire id becomes a number; a create leaves the id to the
 * database's sequence.
 *
 * Rows come back **without** `pushState`: that field describes the main
 * database and is filled in by `./service.ts` after `./push.ts` has compared
 * the two. `CatalogRowOf<K>` is the row type minus that field.
 */
import { Prisma } from "@/generated/prisma-admin/client";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/api/errors";
import { prismaAdmin } from "@/lib/prisma-admin";
import { isIntegerIdString, parseIntegerId, toIntegerIds } from "./ids";
import {
  countIdsInStates,
  listIdsInStates,
  stateOfRows,
  type LedgerState,
} from "./ledger";
import {
  CONSTANT_KIND_LABELS,
  PREFERRED_COUNTRIES,
  hasIntegerId,
  isMarketKind,
  type AccountBaseTypeInput,
  type AccountBaseTypeRow,
  type AccountTypeInput,
  type AccountTypeRow,
  type CategoryInput,
  type CategoryRow,
  type ConstantInputOf,
  type ConstantKind,
  type ConstantPatchOf,
  type CountryInput,
  type CountryRow,
  type CryptocurrencyInput,
  type CryptocurrencyRow,
  type CurrencyInput,
  type CurrencyRow,
  type EtfInput,
  type EtfRow,
  type FinancialInstitutionInput,
  type FinancialInstitutionRow,
  type MarketInput,
  type MarketKind,
  type MarketRow,
  type PushState,
  type StockInput,
  type StockRow,
} from "./types";

type Tx = Prisma.TransactionClient;

/* -------------------------------------------------------------------------- */
/*                                 Row types                                  */
/* -------------------------------------------------------------------------- */

/** A catalog row as the admin database knows it: everything but `pushState`. */
export type CatalogCountry = Omit<CountryRow, "pushState">;
export type CatalogCurrency = Omit<CurrencyRow, "pushState">;
export type CatalogFinancialInstitution = Omit<FinancialInstitutionRow, "pushState">;
export type CatalogCategory = Omit<CategoryRow, "pushState">;
export type CatalogAccountBaseType = Omit<AccountBaseTypeRow, "pushState">;
export type CatalogAccountType = Omit<AccountTypeRow, "pushState">;
export type CatalogCryptocurrency = Omit<CryptocurrencyRow, "pushState">;
export type CatalogEtf = Omit<EtfRow, "pushState">;
export type CatalogStock = Omit<StockRow, "pushState">;
export type CatalogMarket = Omit<MarketRow, "pushState">;

export type CatalogRow =
  | CatalogCountry
  | CatalogCurrency
  | CatalogFinancialInstitution
  | CatalogCategory
  | CatalogAccountBaseType
  | CatalogAccountType
  | CatalogCryptocurrency
  | CatalogEtf
  | CatalogStock
  | CatalogMarket;

export type CatalogRowOf<K extends ConstantKind> = K extends "countries"
  ? CatalogCountry
  : K extends "currencies"
    ? CatalogCurrency
    : K extends "financial_institutions"
      ? CatalogFinancialInstitution
      : K extends "categories"
        ? CatalogCategory
        : K extends "account_base_types"
          ? CatalogAccountBaseType
          : K extends "account_types"
            ? CatalogAccountType
            : K extends "cryptocurrencies"
              ? CatalogCryptocurrency
              : K extends "etfs"
                ? CatalogEtf
                : K extends "stocks"
                  ? CatalogStock
                  : CatalogMarket;

/* -------------------------------------------------------------------------- */
/*                                  Mapping                                   */
/* -------------------------------------------------------------------------- */

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

type CountryRecord = { id: string; name: string; alpha2_code: string; alpha3_code: string; currency_id: string | null; created_at: Date | null };
type CurrencyRecord = { id: string; code: string; name: string; symbol: string | null; created_at: Date | null };
type InstitutionRecord = { id: string; name: string; institution_number: string; type: string };
type CategoryRecord = {
  id: string;
  name: string;
  type: string | null;
  parent_id: string | null;
  is_discretionary: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
  deleted_at: Date | null;
};

type AccountBaseTypeRecord = { id: string; name: string };
type AccountTypeRecord = {
  id: string;
  name: string;
  display_name: string;
  is_asset: boolean;
  is_banking: boolean;
  is_investment: boolean;
  base_type_id: string | null;
  deleted_at: Date | null;
};

/** The three market-data catalogs are keyed by an integer sequence. */
type CryptocurrencyRecord = {
  id: number;
  symbol: string;
  available_exchanges: string;
  currency_base: string;
  currency_quote: string;
  created_at: Date | null;
};
type EtfRecord = {
  id: number;
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  mic_code: string;
  country: string;
  figi_code: string;
  cfi_code: string;
  isin: string;
  cusip: string;
  created_at: Date | null;
};
type StockRecord = EtfRecord & { type: string };
type MarketRecord = {
  id: string;
  mic_code: string;
  operating_mic: string;
  market_name: string;
  iso_country_code: string;
  city: string;
  created_at: Date | null;
  updated_at: Date | null;
  deleted_at: Date | null;
};

const toCountry = (row: CountryRecord): CatalogCountry => ({
  id: row.id,
  name: row.name,
  alpha2Code: row.alpha2_code,
  alpha3Code: row.alpha3_code,
  currencyId: row.currency_id,
  createdAt: iso(row.created_at),
});

const toCurrency = (row: CurrencyRecord): CatalogCurrency => ({
  id: row.id,
  code: row.code,
  name: row.name,
  symbol: row.symbol,
  createdAt: iso(row.created_at),
});

const toInstitution = (row: InstitutionRecord): CatalogFinancialInstitution => ({
  id: row.id,
  name: row.name,
  institutionNumber: row.institution_number,
  type: row.type,
});

const toCategory = (row: CategoryRecord): CatalogCategory => ({
  id: row.id,
  name: row.name,
  // Verbatim: the column is free text on both databases, and the form only
  // offers Inflow / Outflow. An unexpected spelling is carried through as it
  // is rather than read as null, which a push would then write over the
  // consumer app's value.
  type: row.type,
  parentId: row.parent_id,
  isDiscretionary: row.is_discretionary,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  deletedAt: iso(row.deleted_at),
});

const toAccountBaseType = (row: AccountBaseTypeRecord): CatalogAccountBaseType => ({
  id: row.id,
  name: row.name,
});

const toAccountType = (row: AccountTypeRecord): CatalogAccountType => ({
  id: row.id,
  name: row.name,
  displayName: row.display_name,
  isAsset: row.is_asset,
  isBanking: row.is_banking,
  isInvestment: row.is_investment,
  baseTypeId: row.base_type_id,
  deletedAt: iso(row.deleted_at),
});

// `id` is a string on the wire for every kind; these three carry an integer
// key, so it is stringified here and parsed back by `./ids.ts`.
const toCryptocurrency = (row: CryptocurrencyRecord): CatalogCryptocurrency => ({
  id: String(row.id),
  symbol: row.symbol,
  availableExchanges: row.available_exchanges,
  currencyBase: row.currency_base,
  currencyQuote: row.currency_quote,
  createdAt: iso(row.created_at),
});

const toEtf = (row: EtfRecord): CatalogEtf => ({
  id: String(row.id),
  symbol: row.symbol,
  name: row.name,
  currency: row.currency,
  exchange: row.exchange,
  micCode: row.mic_code,
  country: row.country,
  figiCode: row.figi_code,
  cfiCode: row.cfi_code,
  isin: row.isin,
  cusip: row.cusip,
  createdAt: iso(row.created_at),
});

const toStock = (row: StockRecord): CatalogStock => ({ ...toEtf(row), type: row.type });

const toMarket = (row: MarketRecord): CatalogMarket => ({
  id: row.id,
  micCode: row.mic_code,
  operatingMic: row.operating_mic,
  marketName: row.market_name,
  isoCountryCode: row.iso_country_code,
  city: row.city,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  deletedAt: iso(row.deleted_at),
});

/* -------------------------------------------------------------------------- */
/*                                    Rules                                   */
/* -------------------------------------------------------------------------- */

const notFound = (kind: ConstantKind, id: string) =>
  new NotFoundError(`No ${CONSTANT_KIND_LABELS[kind].singular} with id ${id} in the admin catalog.`);

/** Case-insensitive equality filter; Postgres only, which is what both databases are. */
const sameText = (value: string): Prisma.StringFilter => ({ equals: value, mode: "insensitive" });

async function assertCurrencyCodeFree(tx: Tx, code: string, exceptId?: string): Promise<void> {
  const clash = await tx.currencies.findFirst({
    where: { code: sameText(code), ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`A currency with code ${code} already exists.`);
}

async function assertCountryCodesFree(
  tx: Tx,
  codes: { alpha2Code?: string; alpha3Code?: string },
  exceptId?: string,
): Promise<void> {
  const except = exceptId ? { id: { not: exceptId } } : {};
  if (codes.alpha2Code) {
    const clash = await tx.countries.findFirst({
      where: { alpha2_code: sameText(codes.alpha2Code), ...except },
      select: { id: true },
    });
    if (clash) throw new ConflictError(`A country with alpha-2 code ${codes.alpha2Code} already exists.`);
  }
  if (codes.alpha3Code) {
    const clash = await tx.countries.findFirst({
      where: { alpha3_code: sameText(codes.alpha3Code), ...except },
      select: { id: true },
    });
    if (clash) throw new ConflictError(`A country with alpha-3 code ${codes.alpha3Code} already exists.`);
  }
}

async function assertCurrencyExists(tx: Tx, currencyId: string | null): Promise<void> {
  if (currencyId === null) return;
  const currency = await tx.currencies.findUnique({ where: { id: currencyId }, select: { id: true } });
  if (!currency) throw new ValidationError(`No currency with id ${currencyId} in the admin catalog.`);
}

async function assertInstitutionNameFree(tx: Tx, name: string, exceptId?: string): Promise<void> {
  const clash = await tx.financial_institutions.findFirst({
    where: { name: sameText(name), ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`A financial institution named "${name}" already exists.`);
}

/** Sibling names must be distinct among the *live* children of one parent. */
async function assertCategoryNameFree(
  tx: Tx,
  name: string,
  parentId: string | null,
  exceptId?: string,
): Promise<void> {
  const clash = await tx.categories.findFirst({
    where: {
      name: sameText(name),
      parent_id: parentId,
      deleted_at: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) {
    throw new ConflictError(
      parentId === null
        ? `A top-level category named "${name}" already exists.`
        : `That parent already has a category named "${name}".`,
    );
  }
}

/**
 * The parent must exist, still be live, not be the row itself, and not sit
 * below it — otherwise the tree would contain a loop.
 */
async function assertCategoryParent(tx: Tx, parentId: string | null, selfId?: string): Promise<void> {
  if (parentId === null) return;
  if (selfId && parentId === selfId) {
    throw new ValidationError("A category cannot be its own parent.");
  }
  const parent = await tx.categories.findUnique({
    where: { id: parentId },
    select: { id: true, deleted_at: true },
  });
  if (!parent) throw new ValidationError(`No category with id ${parentId} in the admin catalog.`);
  if (parent.deleted_at) throw new ConflictError("That parent category is retired.");
  if (!selfId) return;

  // Walk from the proposed parent up to the root; meeting ourselves is a loop.
  const edges = await tx.categories.findMany({ select: { id: true, parent_id: true } });
  const parentOf = new Map(edges.map((edge) => [edge.id, edge.parent_id]));
  const seen = new Set<string>();
  let cursor: string | null = parentId;
  while (cursor) {
    if (cursor === selfId) {
      throw new ConflictError("That parent sits below this category; the tree would contain a loop.");
    }
    if (seen.has(cursor)) break; // pre-existing loop in the data; stop rather than spin
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
}

/** Base type names are unique, case-insensitively, across the whole table. */
async function assertAccountBaseTypeNameFree(tx: Tx, name: string, exceptId?: string): Promise<void> {
  const clash = await tx.account_base_types.findFirst({
    where: { name: sameText(name), ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`An account base type named "${name}" already exists.`);
}

/**
 * Account type names are unique, case-insensitively, among the *live* rows
 * **under the same base type**: the seed has "Other" under both Loans and
 * Assets, and that is legitimate. A retired name may be taken again, the
 * same way category names work under one parent. A null base type counts as
 * one group of its own.
 */
async function assertAccountTypeNameFree(
  tx: Tx,
  name: string,
  baseTypeId: string | null,
  exceptId?: string,
): Promise<void> {
  const clash = await tx.account_types.findFirst({
    where: {
      name: sameText(name),
      base_type_id: baseTypeId,
      deleted_at: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) {
    throw new ConflictError(`An account type named "${name}" already exists under that base type.`);
  }
}

async function assertAccountBaseTypeExists(tx: Tx, baseTypeId: string | null): Promise<void> {
  if (baseTypeId === null) return;
  const baseType = await tx.account_base_types.findUnique({
    where: { id: baseTypeId },
    select: { id: true },
  });
  if (!baseType) {
    throw new ValidationError(`No account base type with id ${baseTypeId} in the admin catalog.`);
  }
}

/**
 * A crypto pair is unique on (symbol, base, quote) — the same triple the
 * table's unique constraint carries. The schema uppercases all three, and the
 * comparison is case-insensitive anyway so an older row in another spelling
 * still collides.
 */
async function assertCryptoPairFree(
  tx: Tx,
  pair: { symbol: string; currencyBase: string; currencyQuote: string },
  exceptId?: number,
): Promise<void> {
  const clash = await tx.cryptocurrencies.findFirst({
    where: {
      symbol: sameText(pair.symbol),
      currency_base: sameText(pair.currencyBase),
      currency_quote: sameText(pair.currencyQuote),
      ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  if (clash) {
    throw new ConflictError(
      `A cryptocurrency ${pair.symbol} (${pair.currencyBase}/${pair.currencyQuote}) already exists.`,
    );
  }
}

/**
 * An ETF and a stock are both unique on (symbol, exchange): the same symbol is
 * listed on several exchanges, and that is two rows, not a duplicate.
 */
async function assertSymbolExchangeFree(
  tx: Tx,
  kind: "etfs" | "stocks",
  symbol: string,
  exchange: string,
  exceptId?: number,
): Promise<void> {
  const where = {
    symbol: sameText(symbol),
    exchange: sameText(exchange),
    ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
  };
  const clash =
    kind === "etfs"
      ? await tx.etfs.findFirst({ where, select: { id: true } })
      : await tx.stocks.findFirst({ where, select: { id: true } });
  if (clash) {
    throw new ConflictError(
      `${kind === "etfs" ? "An ETF" : "A stock"} ${symbol} on ${exchange} already exists.`,
    );
  }
}

/**
 * MIC codes are unique across the **whole** markets table, retired rows
 * included: the constraint in the database is a plain unique index on
 * `mic_code` with no `deleted_at` predicate, so a retired market keeps its
 * code reserved. Re-listing one means reviving that row, not inserting a
 * second.
 */
async function assertMicCodeFree(tx: Tx, micCode: string, exceptId?: string): Promise<void> {
  const clash = await tx.markets.findFirst({
    where: { mic_code: sameText(micCode), ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, deleted_at: true },
  });
  if (clash) {
    throw new ConflictError(
      clash.deleted_at
        ? `A retired market already holds MIC code ${micCode}; retired markets keep their code.`
        : `A market with MIC code ${micCode} already exists.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Read                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every row of one kind, sorted the way the page lists it. Categories,
 * account types and markets include retired ones: the page shows and filters
 * them, and a push carries the retirement across.
 */
export async function listConstants<K extends ConstantKind>(kind: K): Promise<CatalogRowOf<K>[]> {
  const rows = await listRows(kind);
  return rows as CatalogRowOf<K>[];
}

async function listRows(kind: ConstantKind): Promise<CatalogRow[]> {
  switch (kind) {
    case "countries":
      return (await prismaAdmin.countries.findMany({ orderBy: { name: "asc" } })).map(toCountry);
    case "currencies":
      return (await prismaAdmin.currencies.findMany({ orderBy: { code: "asc" } })).map(toCurrency);
    case "financial_institutions":
      return (await prismaAdmin.financial_institutions.findMany({ orderBy: { name: "asc" } })).map(
        toInstitution,
      );
    case "categories":
      return (await prismaAdmin.categories.findMany({ orderBy: { name: "asc" } })).map(toCategory);
    case "account_base_types":
      return (await prismaAdmin.account_base_types.findMany({ orderBy: { name: "asc" } })).map(
        toAccountBaseType,
      );
    case "account_types":
      // Sorted the way the page reads them: by the human-facing name.
      return (await prismaAdmin.account_types.findMany({ orderBy: { display_name: "asc" } })).map(
        toAccountType,
      );
    case "cryptocurrencies":
      // The unique triple, in its own order: one symbol groups its pairs.
      return (
        await prismaAdmin.cryptocurrencies.findMany({
          orderBy: [{ symbol: "asc" }, { currency_base: "asc" }, { currency_quote: "asc" }],
        })
      ).map(toCryptocurrency);
    case "etfs":
      return (
        await prismaAdmin.etfs.findMany({ orderBy: [{ symbol: "asc" }, { exchange: "asc" }] })
      ).map(toEtf);
    case "stocks":
      // The same symbol on two exchanges is two rows; they sort next to each other.
      return (
        await prismaAdmin.stocks.findMany({ orderBy: [{ symbol: "asc" }, { exchange: "asc" }] })
      ).map(toStock);
    case "markets":
      // Retired markets stay in the list, the way retired categories do.
      return (await prismaAdmin.markets.findMany({ orderBy: { mic_code: "asc" } })).map(toMarket);
  }
}

/** One row by id, or `null`. */
export async function getConstant<K extends ConstantKind>(
  kind: K,
  id: string,
): Promise<CatalogRowOf<K> | null> {
  const row = await getRow(kind, id);
  return row as CatalogRowOf<K> | null;
}

async function getRow(kind: ConstantKind, id: string): Promise<CatalogRow | null> {
  switch (kind) {
    case "countries": {
      const row = await prismaAdmin.countries.findUnique({ where: { id } });
      return row ? toCountry(row) : null;
    }
    case "currencies": {
      const row = await prismaAdmin.currencies.findUnique({ where: { id } });
      return row ? toCurrency(row) : null;
    }
    case "financial_institutions": {
      const row = await prismaAdmin.financial_institutions.findUnique({ where: { id } });
      return row ? toInstitution(row) : null;
    }
    case "categories": {
      const row = await prismaAdmin.categories.findUnique({ where: { id } });
      return row ? toCategory(row) : null;
    }
    case "account_base_types": {
      const row = await prismaAdmin.account_base_types.findUnique({ where: { id } });
      return row ? toAccountBaseType(row) : null;
    }
    case "account_types": {
      const row = await prismaAdmin.account_types.findUnique({ where: { id } });
      return row ? toAccountType(row) : null;
    }
    case "cryptocurrencies": {
      const row = await prismaAdmin.cryptocurrencies.findUnique({ where: { id: parseIntegerId(kind, id) } });
      return row ? toCryptocurrency(row) : null;
    }
    case "etfs": {
      const row = await prismaAdmin.etfs.findUnique({ where: { id: parseIntegerId(kind, id) } });
      return row ? toEtf(row) : null;
    }
    case "stocks": {
      const row = await prismaAdmin.stocks.findUnique({ where: { id: parseIntegerId(kind, id) } });
      return row ? toStock(row) : null;
    }
    case "markets": {
      const row = await prismaAdmin.markets.findUnique({ where: { id } });
      return row ? toMarket(row) : null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Create                                   */
/* -------------------------------------------------------------------------- */

/**
 * The unique indexes from `docs/sql/005_constants_unique_indexes.sql` and
 * `docs/sql/006_account_types_unique_index.sql`, the `account_base_types`
 * `name` constraint that ships with the table, and the constraints the four
 * market-data catalogs were created with (`cryptocurrencies` on
 * (symbol, base, quote), `etfs` and `stocks` on (symbol, exchange), `markets`
 * on `mic_code` — no extra SQL file needed) are the last word on
 * duplicates: when two operators pass the read-then-write checks
 * above at the same moment, the second insert fails with Postgres 23505
 * (Prisma P2002). Rendered as the same 409 the check would have raised.
 */
function withUniqueViolation<T>(kind: ConstantKind, run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const what = {
        countries: "alpha-2 or alpha-3 code",
        currencies: "code",
        financial_institutions: "name",
        categories: "name under the same parent",
        account_base_types: "name",
        account_types: "name under the same base type",
        cryptocurrencies: "symbol, base and quote currency",
        etfs: "symbol on that exchange",
        stocks: "symbol on that exchange",
        markets: "MIC code",
      }[kind];
      const singular = CONSTANT_KIND_LABELS[kind].singular;
      const article = /^[aeiou]/i.test(singular) ? "An" : "A";
      throw new ConflictError(`${article} ${singular} with that ${what} already exists.`);
    }
    throw error;
  });
}

/**
 * Adds a row to the admin catalog. The id is never supplied by the caller:
 * UUID kinds get one generated here, and the three integer-keyed kinds let
 * the admin database's sequence assign it.
 */
export async function createConstant<K extends ConstantKind>(
  kind: K,
  input: ConstantInputOf<K>,
): Promise<CatalogRowOf<K>> {
  const row = await withUniqueViolation(kind, () => createRow(kind, input as ConstantInputOf<ConstantKind>));
  return row as CatalogRowOf<K>;
}

/** The columns an ETF and a stock share, ready for a create. */
const listedInstrumentData = (data: EtfInput) => ({
  symbol: data.symbol,
  name: data.name,
  currency: data.currency,
  exchange: data.exchange,
  mic_code: data.micCode,
  country: data.country,
  figi_code: data.figiCode,
  cfi_code: data.cfiCode,
  isin: data.isin,
  cusip: data.cusip,
});

async function createRow(kind: ConstantKind, input: ConstantInputOf<ConstantKind>): Promise<CatalogRow> {
  const id = crypto.randomUUID();
  switch (kind) {
    case "countries": {
      const data = input as CountryInput;
      return prismaAdmin.$transaction(async (tx) => {
        await assertCountryCodesFree(tx, data);
        await assertCurrencyExists(tx, data.currencyId);
        const row = await tx.countries.create({
          data: {
            id,
            name: data.name,
            alpha2_code: data.alpha2Code,
            alpha3_code: data.alpha3Code,
            currency_id: data.currencyId,
          },
        });
        return toCountry(row);
      });
    }
    case "currencies": {
      const data = input as CurrencyInput;
      return prismaAdmin.$transaction(async (tx) => {
        await assertCurrencyCodeFree(tx, data.code);
        const row = await tx.currencies.create({
          data: { id, code: data.code, name: data.name, symbol: data.symbol },
        });
        return toCurrency(row);
      });
    }
    case "financial_institutions": {
      const data = input as FinancialInstitutionInput;
      return prismaAdmin.$transaction(async (tx) => {
        await assertInstitutionNameFree(tx, data.name);
        const row = await tx.financial_institutions.create({
          data: { id, name: data.name, institution_number: data.institutionNumber, type: data.type },
        });
        return toInstitution(row);
      });
    }
    case "categories": {
      const data = input as CategoryInput;
      return prismaAdmin.$transaction(async (tx) => {
        await assertCategoryParent(tx, data.parentId);
        await assertCategoryNameFree(tx, data.name, data.parentId);
        const now = new Date();
        const row = await tx.categories.create({
          data: {
            id,
            name: data.name,
            type: data.type,
            parent_id: data.parentId,
            is_discretionary: data.isDiscretionary,
            created_at: now,
            updated_at: now,
          },
        });
        return toCategory(row);
      });
    }
    case "account_base_types": {
      const data = input as AccountBaseTypeInput;
      return prismaAdmin.$transaction(async (tx) => {
        await assertAccountBaseTypeNameFree(tx, data.name);
        const row = await tx.account_base_types.create({ data: { id, name: data.name } });
        return toAccountBaseType(row);
      });
    }
    case "account_types": {
      const data = input as AccountTypeInput;
      return prismaAdmin.$transaction(async (tx) => {
        await assertAccountBaseTypeExists(tx, data.baseTypeId);
        await assertAccountTypeNameFree(tx, data.name, data.baseTypeId);
        const row = await tx.account_types.create({
          data: {
            id,
            name: data.name,
            display_name: data.displayName,
            is_asset: data.isAsset,
            is_banking: data.isBanking,
            is_investment: data.isInvestment,
            base_type_id: data.baseTypeId,
          },
        });
        return toAccountType(row);
      });
    }
    case "cryptocurrencies": {
      const data = input as CryptocurrencyInput;
      return prismaAdmin.$transaction(async (tx) => {
        await assertCryptoPairFree(tx, data);
        // No `id`: the sequence assigns it, so a pushed id from the feed and a
        // hand-added row cannot be handed the same number.
        const row = await tx.cryptocurrencies.create({
          data: {
            symbol: data.symbol,
            available_exchanges: data.availableExchanges,
            currency_base: data.currencyBase,
            currency_quote: data.currencyQuote,
          },
        });
        return toCryptocurrency(row);
      });
    }
    case "etfs": {
      const data = input as EtfInput;
      return prismaAdmin.$transaction(async (tx) => {
        await assertSymbolExchangeFree(tx, "etfs", data.symbol, data.exchange);
        const row = await tx.etfs.create({ data: listedInstrumentData(data) });
        return toEtf(row);
      });
    }
    case "stocks": {
      const data = input as StockInput;
      return prismaAdmin.$transaction(async (tx) => {
        await assertSymbolExchangeFree(tx, "stocks", data.symbol, data.exchange);
        const row = await tx.stocks.create({ data: { ...listedInstrumentData(data), type: data.type } });
        return toStock(row);
      });
    }
    case "markets": {
      const data = input as MarketInput;
      return prismaAdmin.$transaction(async (tx) => {
        await assertMicCodeFree(tx, data.micCode);
        const now = new Date();
        const row = await tx.markets.create({
          data: {
            id,
            mic_code: data.micCode,
            operating_mic: data.operatingMic,
            market_name: data.marketName,
            iso_country_code: data.isoCountryCode,
            city: data.city,
            created_at: now,
            updated_at: now,
          },
        });
        return toMarket(row);
      });
    }
  }
}


/* -------------------------------------------------------------------------- */
/*                                   Update                                   */
/* -------------------------------------------------------------------------- */

/** Applies a partial change. Absent keys are left alone; `null` clears a column. */
export async function updateConstant<K extends ConstantKind>(
  kind: K,
  id: string,
  patch: ConstantPatchOf<K>,
): Promise<CatalogRowOf<K>> {
  const row = await withUniqueViolation(kind, () => updateRow(kind, id, patch as ConstantPatchOf<ConstantKind>));
  return row as CatalogRowOf<K>;
}

/** The shared ETF/stock columns of a patch, absent keys left alone. */
const listedInstrumentPatch = (data: Partial<EtfInput>) => ({
  ...(data.symbol === undefined ? {} : { symbol: data.symbol }),
  ...(data.name === undefined ? {} : { name: data.name }),
  ...(data.currency === undefined ? {} : { currency: data.currency }),
  ...(data.exchange === undefined ? {} : { exchange: data.exchange }),
  ...(data.micCode === undefined ? {} : { mic_code: data.micCode }),
  ...(data.country === undefined ? {} : { country: data.country }),
  ...(data.figiCode === undefined ? {} : { figi_code: data.figiCode }),
  ...(data.cfiCode === undefined ? {} : { cfi_code: data.cfiCode }),
  ...(data.isin === undefined ? {} : { isin: data.isin }),
  ...(data.cusip === undefined ? {} : { cusip: data.cusip }),
});

async function updateRow(
  kind: ConstantKind,
  id: string,
  patch: ConstantPatchOf<ConstantKind>,
): Promise<CatalogRow> {
  switch (kind) {
    case "countries": {
      const data = patch as Partial<CountryInput>;
      return prismaAdmin.$transaction(async (tx) => {
        const current = await tx.countries.findUnique({ where: { id }, select: { id: true } });
        if (!current) throw notFound(kind, id);
        await assertCountryCodesFree(tx, data, id);
        if (data.currencyId !== undefined) await assertCurrencyExists(tx, data.currencyId);
        const row = await tx.countries.update({
          where: { id },
          data: {
            ...(data.name === undefined ? {} : { name: data.name }),
            ...(data.alpha2Code === undefined ? {} : { alpha2_code: data.alpha2Code }),
            ...(data.alpha3Code === undefined ? {} : { alpha3_code: data.alpha3Code }),
            ...(data.currencyId === undefined ? {} : { currency_id: data.currencyId }),
          },
        });
        return toCountry(row);
      });
    }
    case "currencies": {
      const data = patch as Partial<CurrencyInput>;
      return prismaAdmin.$transaction(async (tx) => {
        const current = await tx.currencies.findUnique({ where: { id }, select: { id: true } });
        if (!current) throw notFound(kind, id);
        if (data.code !== undefined) await assertCurrencyCodeFree(tx, data.code, id);
        const row = await tx.currencies.update({
          where: { id },
          data: {
            ...(data.code === undefined ? {} : { code: data.code }),
            ...(data.name === undefined ? {} : { name: data.name }),
            ...(data.symbol === undefined ? {} : { symbol: data.symbol }),
          },
        });
        return toCurrency(row);
      });
    }
    case "financial_institutions": {
      const data = patch as Partial<FinancialInstitutionInput>;
      return prismaAdmin.$transaction(async (tx) => {
        const current = await tx.financial_institutions.findUnique({ where: { id }, select: { id: true } });
        if (!current) throw notFound(kind, id);
        if (data.name !== undefined) await assertInstitutionNameFree(tx, data.name, id);
        const row = await tx.financial_institutions.update({
          where: { id },
          data: {
            ...(data.name === undefined ? {} : { name: data.name }),
            ...(data.institutionNumber === undefined ? {} : { institution_number: data.institutionNumber }),
            ...(data.type === undefined ? {} : { type: data.type }),
          },
        });
        return toInstitution(row);
      });
    }
    case "categories": {
      const data = patch as Partial<CategoryInput>;
      return prismaAdmin.$transaction(async (tx) => {
        const current = await tx.categories.findUnique({
          where: { id },
          select: { id: true, name: true, parent_id: true },
        });
        if (!current) throw notFound(kind, id);
        const nextParentId = data.parentId === undefined ? current.parent_id : data.parentId;
        const nextName = data.name ?? current.name;
        if (data.parentId !== undefined) await assertCategoryParent(tx, nextParentId, id);
        if (data.name !== undefined || data.parentId !== undefined) {
          await assertCategoryNameFree(tx, nextName, nextParentId, id);
        }
        const row = await tx.categories.update({
          where: { id },
          data: {
            ...(data.name === undefined ? {} : { name: data.name }),
            ...(data.type === undefined ? {} : { type: data.type }),
            ...(data.parentId === undefined ? {} : { parent_id: data.parentId }),
            ...(data.isDiscretionary === undefined ? {} : { is_discretionary: data.isDiscretionary }),
            updated_at: new Date(),
          },
        });
        return toCategory(row);
      });
    }
    case "account_base_types": {
      const data = patch as Partial<AccountBaseTypeInput>;
      return prismaAdmin.$transaction(async (tx) => {
        const current = await tx.account_base_types.findUnique({ where: { id }, select: { id: true } });
        if (!current) throw notFound(kind, id);
        if (data.name !== undefined) await assertAccountBaseTypeNameFree(tx, data.name, id);
        const row = await tx.account_base_types.update({
          where: { id },
          data: { ...(data.name === undefined ? {} : { name: data.name }) },
        });
        return toAccountBaseType(row);
      });
    }
    case "account_types": {
      const data = patch as Partial<AccountTypeInput>;
      return prismaAdmin.$transaction(async (tx) => {
        const current = await tx.account_types.findUnique({
          where: { id },
          select: { id: true, name: true, base_type_id: true },
        });
        if (!current) throw notFound(kind, id);
        if (data.baseTypeId !== undefined) await assertAccountBaseTypeExists(tx, data.baseTypeId);
        // Moving to another base type can collide there just as renaming can.
        if (data.name !== undefined || data.baseTypeId !== undefined) {
          await assertAccountTypeNameFree(
            tx,
            data.name ?? current.name,
            data.baseTypeId === undefined ? current.base_type_id : data.baseTypeId,
            id,
          );
        }
        const row = await tx.account_types.update({
          where: { id },
          data: {
            ...(data.name === undefined ? {} : { name: data.name }),
            ...(data.displayName === undefined ? {} : { display_name: data.displayName }),
            ...(data.isAsset === undefined ? {} : { is_asset: data.isAsset }),
            ...(data.isBanking === undefined ? {} : { is_banking: data.isBanking }),
            ...(data.isInvestment === undefined ? {} : { is_investment: data.isInvestment }),
            ...(data.baseTypeId === undefined ? {} : { base_type_id: data.baseTypeId }),
          },
        });
        return toAccountType(row);
      });
    }
    case "cryptocurrencies": {
      const data = patch as Partial<CryptocurrencyInput>;
      const key = parseIntegerId(kind, id);
      return prismaAdmin.$transaction(async (tx) => {
        const current = await tx.cryptocurrencies.findUnique({
          where: { id: key },
          select: { symbol: true, currency_base: true, currency_quote: true },
        });
        if (!current) throw notFound(kind, id);
        // Any of the three moves the row to another slot of the unique triple.
        if (
          data.symbol !== undefined ||
          data.currencyBase !== undefined ||
          data.currencyQuote !== undefined
        ) {
          await assertCryptoPairFree(
            tx,
            {
              symbol: data.symbol ?? current.symbol,
              currencyBase: data.currencyBase ?? current.currency_base,
              currencyQuote: data.currencyQuote ?? current.currency_quote,
            },
            key,
          );
        }
        const row = await tx.cryptocurrencies.update({
          where: { id: key },
          data: {
            ...(data.symbol === undefined ? {} : { symbol: data.symbol }),
            ...(data.availableExchanges === undefined
              ? {}
              : { available_exchanges: data.availableExchanges }),
            ...(data.currencyBase === undefined ? {} : { currency_base: data.currencyBase }),
            ...(data.currencyQuote === undefined ? {} : { currency_quote: data.currencyQuote }),
          },
        });
        return toCryptocurrency(row);
      });
    }
    case "etfs": {
      const data = patch as Partial<EtfInput>;
      const key = parseIntegerId(kind, id);
      return prismaAdmin.$transaction(async (tx) => {
        const current = await tx.etfs.findUnique({
          where: { id: key },
          select: { symbol: true, exchange: true },
        });
        if (!current) throw notFound(kind, id);
        if (data.symbol !== undefined || data.exchange !== undefined) {
          await assertSymbolExchangeFree(
            tx,
            "etfs",
            data.symbol ?? current.symbol,
            data.exchange ?? current.exchange,
            key,
          );
        }
        const row = await tx.etfs.update({ where: { id: key }, data: listedInstrumentPatch(data) });
        return toEtf(row);
      });
    }
    case "stocks": {
      const data = patch as Partial<StockInput>;
      const key = parseIntegerId(kind, id);
      return prismaAdmin.$transaction(async (tx) => {
        const current = await tx.stocks.findUnique({
          where: { id: key },
          select: { symbol: true, exchange: true },
        });
        if (!current) throw notFound(kind, id);
        if (data.symbol !== undefined || data.exchange !== undefined) {
          await assertSymbolExchangeFree(
            tx,
            "stocks",
            data.symbol ?? current.symbol,
            data.exchange ?? current.exchange,
            key,
          );
        }
        const row = await tx.stocks.update({
          where: { id: key },
          data: {
            ...listedInstrumentPatch(data),
            ...(data.type === undefined ? {} : { type: data.type }),
          },
        });
        return toStock(row);
      });
    }
    case "markets": {
      const data = patch as Partial<MarketInput>;
      return prismaAdmin.$transaction(async (tx) => {
        const current = await tx.markets.findUnique({ where: { id }, select: { id: true } });
        if (!current) throw notFound(kind, id);
        if (data.micCode !== undefined) await assertMicCodeFree(tx, data.micCode, id);
        const row = await tx.markets.update({
          where: { id },
          data: {
            ...(data.micCode === undefined ? {} : { mic_code: data.micCode }),
            ...(data.operatingMic === undefined ? {} : { operating_mic: data.operatingMic }),
            ...(data.marketName === undefined ? {} : { market_name: data.marketName }),
            ...(data.isoCountryCode === undefined ? {} : { iso_country_code: data.isoCountryCode }),
            ...(data.city === undefined ? {} : { city: data.city }),
            // Markets carry `updated_at` the way categories do.
            updated_at: new Date(),
          },
        });
        return toMarket(row);
      });
    }
  }
}


/* -------------------------------------------------------------------------- */
/*                                   Delete                                   */
/* -------------------------------------------------------------------------- */

/**
 * Removes a row from the **admin** catalog. Categories, account types and
 * markets are retired (`deleted_at = now()`), the other kinds are deleted
 * outright.
 *
 * Nothing is removed from the main database: a row there may be referenced by
 * tenant data, so the copy survives and shows up as a "main only" id on the
 * page until someone removes it deliberately on the consumer side.
 *
 * Every kind checks and writes inside one transaction, so a concurrent delete
 * cannot slip between the two; if it does anyway, Prisma's P2025 is rendered
 * as the same 404 the check would have raised.
 */
export async function deleteConstant(kind: ConstantKind, id: string): Promise<void> {
  try {
    await deleteRow(kind, id);
  } catch (error) {
    // "Record to delete does not exist": the row went away between the check
    // and the delete (a second operator). That is a 404, not a 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      throw notFound(kind, id);
    }
    throw error;
  }
}

async function deleteRow(kind: ConstantKind, id: string): Promise<void> {
  switch (kind) {
    case "countries": {
      await prismaAdmin.$transaction(async (tx) => {
        const existing = await tx.countries.findUnique({ where: { id }, select: { id: true } });
        if (!existing) throw notFound(kind, id);
        await tx.countries.delete({ where: { id } });
      });
      return;
    }
    case "currencies": {
      await prismaAdmin.$transaction(async (tx) => {
        const existing = await tx.currencies.findUnique({ where: { id }, select: { id: true } });
        if (!existing) throw notFound(kind, id);
        const users = await tx.countries.count({ where: { currency_id: id } });
        if (users > 0) {
          throw new ConflictError(
            `That currency is used by ${users} ${users === 1 ? "country" : "countries"}. Point them elsewhere first.`,
          );
        }
        await tx.currencies.delete({ where: { id } });
      });
      return;
    }
    case "financial_institutions": {
      await prismaAdmin.$transaction(async (tx) => {
        const existing = await tx.financial_institutions.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!existing) throw notFound(kind, id);
        await tx.financial_institutions.delete({ where: { id } });
      });
      return;
    }
    case "categories": {
      await prismaAdmin.$transaction(async (tx) => {
        const existing = await tx.categories.findUnique({
          where: { id },
          select: { id: true, deleted_at: true },
        });
        if (!existing) throw notFound(kind, id);
        // Already retired: nothing to do, and repeating the call is not an error.
        if (existing.deleted_at) return;
        const children = await tx.categories.count({ where: { parent_id: id, deleted_at: null } });
        if (children > 0) {
          throw new ConflictError(
            `That category still has ${children} live ${children === 1 ? "child" : "children"}. Retire or move them first.`,
          );
        }
        const now = new Date();
        await tx.categories.update({ where: { id }, data: { deleted_at: now, updated_at: now } });
      });
      return;
    }
    case "account_base_types": {
      await prismaAdmin.$transaction(async (tx) => {
        const existing = await tx.account_base_types.findUnique({ where: { id }, select: { id: true } });
        if (!existing) throw notFound(kind, id);
        // Retired account types keep pointing at their base type, so they count
        // too: the row cannot go while any reference to it survives.
        const users = await tx.account_types.count({ where: { base_type_id: id } });
        if (users > 0) {
          throw new ConflictError(
            `That base type is used by ${users} account ${users === 1 ? "type" : "types"}. Point them elsewhere first.`,
          );
        }
        await tx.account_base_types.delete({ where: { id } });
      });
      return;
    }
    case "account_types": {
      await prismaAdmin.$transaction(async (tx) => {
        const existing = await tx.account_types.findUnique({
          where: { id },
          select: { id: true, deleted_at: true },
        });
        if (!existing) throw notFound(kind, id);
        // Already retired: nothing to do, and repeating the call is not an error.
        if (existing.deleted_at) return;
        await tx.account_types.update({ where: { id }, data: { deleted_at: new Date() } });
      });
      return;
    }
    case "cryptocurrencies": {
      const key = parseIntegerId(kind, id);
      await prismaAdmin.$transaction(async (tx) => {
        const existing = await tx.cryptocurrencies.findUnique({ where: { id: key }, select: { id: true } });
        if (!existing) throw notFound(kind, id);
        // Nothing in the admin database points at a crypto pair, and the main
        // copy stays put: it shows up under `mainOnlyIds` until someone
        // removes it there deliberately.
        await tx.cryptocurrencies.delete({ where: { id: key } });
      });
      return;
    }
    case "etfs": {
      const key = parseIntegerId(kind, id);
      await prismaAdmin.$transaction(async (tx) => {
        const existing = await tx.etfs.findUnique({ where: { id: key }, select: { id: true } });
        if (!existing) throw notFound(kind, id);
        await tx.etfs.delete({ where: { id: key } });
      });
      return;
    }
    case "stocks": {
      const key = parseIntegerId(kind, id);
      await prismaAdmin.$transaction(async (tx) => {
        const existing = await tx.stocks.findUnique({ where: { id: key }, select: { id: true } });
        if (!existing) throw notFound(kind, id);
        // Unlike the other market-data catalogs, `stocks` is referenced inside
        // the admin database itself (portfolios, trades, watchlists). Two of
        // those foreign keys cascade, so the delete would take live rows with
        // it: refuse instead and let a person decide.
        const [portfolios, trades, watchlists] = await Promise.all([
          tx.portfolio_stocks.count({ where: { stock_id: key } }),
          tx.stock_trades.count({ where: { stock_id: key } }),
          tx.watchlist_stocks.count({ where: { stock_id: key } }),
        ]);
        const used = portfolios + trades + watchlists;
        if (used > 0) {
          const parts = [
            portfolios > 0 ? `${portfolios} portfolio ${portfolios === 1 ? "holding" : "holdings"}` : null,
            trades > 0 ? `${trades} ${trades === 1 ? "trade" : "trades"}` : null,
            watchlists > 0 ? `${watchlists} watchlist ${watchlists === 1 ? "entry" : "entries"}` : null,
          ].filter((part): part is string => part !== null);
          throw new ConflictError(
            `That stock is referenced by ${parts.join(", ")}. Remove those first.`,
          );
        }
        await tx.stocks.delete({ where: { id: key } });
      });
      return;
    }
    case "markets": {
      await prismaAdmin.$transaction(async (tx) => {
        const existing = await tx.markets.findUnique({
          where: { id },
          select: { id: true, deleted_at: true },
        });
        if (!existing) throw notFound(kind, id);
        // Already retired: nothing to do, and repeating the call is not an error.
        if (existing.deleted_at) return;
        const now = new Date();
        await tx.markets.update({ where: { id }, data: { deleted_at: now, updated_at: now } });
      });
      return;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                             Paging and scanning                            */
/* -------------------------------------------------------------------------- */

/**
 * The kinds that are retired (`deleted_at`) rather than deleted. Only these
 * can answer the `retired` filter; the others report a retired count of 0.
 */
export const RETIRABLE_KINDS = ["categories", "account_types", "markets"] as const satisfies readonly ConstantKind[];

export function isRetirable(kind: ConstantKind): boolean {
  return (RETIRABLE_KINDS as readonly string[]).includes(kind);
}

/** Which rows of a retirable kind are wanted. Meaningless for the other kinds. */
export type RowScope = "live" | "retired" | "all";

/** What a row query filters on, before ordering and paging. */
export interface RowFilter {
  /** Free text over the kind's searchable columns; see `docs/constants.md`. */
  q?: string;
  /** Default `all`. `live` / `retired` only narrow a retirable kind. */
  scope?: RowScope;
  /** Restrict to these wire ids. */
  ids?: readonly string[];
  /** Cursor: only rows whose primary key is greater than this wire id. */
  after?: string | null;
  /**
   * Exact match on the listing country. Only `etfs` and `stocks` have that
   * column (`isMarketKind`); every other kind ignores it.
   */
  country?: string;
}

interface RowQuery extends RowFilter {
  /** `natural` is the order the page lists the kind in; `id` is primary-key order. */
  order?: "natural" | "id";
  skip?: number;
  take?: number;
}

/** Case-insensitive substring match, Postgres only — which both databases are. */
const like = (value: string): Prisma.StringFilter => ({ contains: value, mode: "insensitive" });

/**
 * The columns a free-text search looks at, per kind: everything the page's
 * search placeholder promises, which is every column it shows as text.
 *
 * Most of it is one `OR` of `ILIKE`s over the kind's own columns. Four kinds
 * also show a column that lives on another row — a country's currency, a
 * category's parent, an account type's base type — and those are matched
 * through a Prisma relation filter (`{ is: … }`), which becomes a subquery on
 * the joined table rather than a second round trip. The relation *field* names
 * come from `prisma-admin/schema.prisma`: `currencies` on `countries`,
 * `categories` (the self-relation to the parent) on `categories`, and
 * `account_base_types` on `account_types`.
 */
function searchOr(kind: ConstantKind, q: string): Record<string, unknown>[] {
  const text = like(q);
  switch (kind) {
    case "countries":
      return [
        { name: text },
        { alpha2_code: text },
        { alpha3_code: text },
        // The currency column the table shows is the currency's code and name.
        { currencies: { is: { OR: [{ code: text }, { name: text }] } } },
      ];
    case "currencies":
      return [{ code: text }, { name: text }, { symbol: text }];
    case "financial_institutions":
      return [{ name: text }, { institution_number: text }, { type: text }];
    case "categories":
      // The parent's name is a column of the list, so it is searchable too.
      return [{ name: text }, { type: text }, { categories: { is: { name: text } } }];
    case "account_base_types":
      return [{ name: text }];
    case "account_types":
      return [
        { name: text },
        { display_name: text },
        { account_base_types: { is: { name: text } } },
      ];
    case "cryptocurrencies":
      return [
        { symbol: text },
        { currency_base: text },
        { currency_quote: text },
        { available_exchanges: text },
      ];
    case "etfs":
      return [
        { symbol: text },
        { name: text },
        { exchange: text },
        { mic_code: text },
        { country: text },
      ];
    case "stocks":
      return [
        { symbol: text },
        { name: text },
        { exchange: text },
        { mic_code: text },
        { country: text },
        { type: text },
      ];
    case "markets":
      return [
        { mic_code: text },
        { operating_mic: text },
        { market_name: text },
        { iso_country_code: text },
        { city: text },
      ];
  }
}

/**
 * The `where` clause for one row query, as a plain object.
 *
 * It is assembled untyped and cast to the model's `WhereInput` at the one
 * point of use below: the shape depends on `kind`, which TypeScript cannot
 * follow through ten delegates, and writing the same four clauses out ten
 * times would be worse. Every value here comes from a validated query string
 * or from ids the caller already parsed, and all of it goes out as Prisma
 * parameters.
 */
function whereOf(kind: ConstantKind, filter: RowFilter): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const q = filter.q?.trim();
  if (q) where.OR = searchOr(kind, q);

  if (isRetirable(kind)) {
    if (filter.scope === "live") where.deleted_at = null;
    if (filter.scope === "retired") where.deleted_at = { not: null };
  }

  // The market filter is an exact match on the feed's own spelling of the
  // country, so it uses the `(country)` values the catalog actually holds.
  const country = filter.country?.trim();
  if (country && isMarketKind(kind)) where.country = country;

  const integerKeyed = hasIntegerId(kind);
  const id: Record<string, unknown> = {};
  if (filter.ids !== undefined) {
    id.in = integerKeyed ? toIntegerIds(filter.ids) : [...filter.ids];
  }
  if (filter.after !== undefined && filter.after !== null) {
    // A non-integer cursor on an integer-keyed kind cannot come from a row
    // this module returned; start from the beginning rather than send `NaN`.
    if (!integerKeyed) id.gt = filter.after;
    else if (isIntegerIdString(filter.after)) id.gt = Number(filter.after);
  }
  if (Object.keys(id).length > 0) where.id = id;
  return where;
}

/** The order the page lists a kind in, with the primary key as a tiebreaker. */
function orderOf(kind: ConstantKind, order: "natural" | "id"): Record<string, "asc">[] {
  if (order === "id") return [{ id: "asc" }];
  switch (kind) {
    case "countries":
    case "financial_institutions":
    case "categories":
    case "account_base_types":
      return [{ name: "asc" }, { id: "asc" }];
    case "currencies":
      return [{ code: "asc" }, { id: "asc" }];
    case "account_types":
      return [{ display_name: "asc" }, { id: "asc" }];
    case "cryptocurrencies":
      return [{ symbol: "asc" }, { currency_base: "asc" }, { currency_quote: "asc" }, { id: "asc" }];
    case "etfs":
    case "stocks":
      return [{ symbol: "asc" }, { exchange: "asc" }, { id: "asc" }];
    case "markets":
      return [{ mic_code: "asc" }, { id: "asc" }];
  }
}

/** The sort key the page orders a row by, mirroring `orderOf`. */
function naturalKey(kind: ConstantKind, row: CatalogRow): string[] {
  switch (kind) {
    case "countries":
      return [(row as CatalogCountry).name];
    case "currencies":
      return [(row as CatalogCurrency).code];
    case "financial_institutions":
      return [(row as CatalogFinancialInstitution).name];
    case "categories":
      return [(row as CatalogCategory).name];
    case "account_base_types":
      return [(row as CatalogAccountBaseType).name];
    case "account_types":
      return [(row as CatalogAccountType).displayName];
    case "cryptocurrencies": {
      const a = row as CatalogCryptocurrency;
      return [a.symbol, a.currencyBase, a.currencyQuote];
    }
    case "etfs":
    case "stocks": {
      const a = row as CatalogEtf;
      // Same tiers as the raw page query: the preferred markets first, in
      // their listed order, then everything else. The tier is a sortable
      // digit so `localeCompare` orders it with the rest of the key.
      const tier = PREFERRED_COUNTRIES.indexOf(a.country as (typeof PREFERRED_COUNTRIES)[number]);
      return [String(tier === -1 ? PREFERRED_COUNTRIES.length : tier), a.symbol, a.exchange];
    }
    case "markets":
      return [(row as CatalogMarket).micCode];
  }
}

/**
 * Sorts rows the way the database would, for the paths that read them in
 * primary-key order. `localeCompare` and the database's collation can disagree
 * on exotic strings; the catalogs are ASCII codes and names, where they agree.
 */
function sortNatural(kind: ConstantKind, rows: CatalogRow[]): CatalogRow[] {
  return [...rows].sort((left, right) => {
    const a = naturalKey(kind, left);
    const b = naturalKey(kind, right);
    for (let index = 0; index < a.length; index += 1) {
      const verdict = a[index].localeCompare(b[index]);
      if (verdict !== 0) return verdict;
    }
    return left.id.localeCompare(right.id);
  });
}

/** One page of rows of one kind. The single place a delegate is picked by kind. */
async function queryRows(kind: ConstantKind, query: RowQuery): Promise<CatalogRow[]> {
  // See `whereOf`: the clause is built once and typed at the delegate.
  const where = whereOf(kind, query) as never;
  const orderBy = orderOf(kind, query.order ?? "natural") as never;
  const page = { skip: query.skip, take: query.take };
  switch (kind) {
    case "countries":
      return (await prismaAdmin.countries.findMany({ where, orderBy, ...page })).map(toCountry);
    case "currencies":
      return (await prismaAdmin.currencies.findMany({ where, orderBy, ...page })).map(toCurrency);
    case "financial_institutions":
      return (await prismaAdmin.financial_institutions.findMany({ where, orderBy, ...page })).map(
        toInstitution,
      );
    case "categories":
      return (await prismaAdmin.categories.findMany({ where, orderBy, ...page })).map(toCategory);
    case "account_base_types":
      return (await prismaAdmin.account_base_types.findMany({ where, orderBy, ...page })).map(
        toAccountBaseType,
      );
    case "account_types":
      return (await prismaAdmin.account_types.findMany({ where, orderBy, ...page })).map(toAccountType);
    case "cryptocurrencies":
      return (await prismaAdmin.cryptocurrencies.findMany({ where, orderBy, ...page })).map(
        toCryptocurrency,
      );
    case "etfs":
      return (await prismaAdmin.etfs.findMany({ where, orderBy, ...page })).map(toEtf);
    case "stocks":
      return (await prismaAdmin.stocks.findMany({ where, orderBy, ...page })).map(toStock);
    case "markets":
      return (await prismaAdmin.markets.findMany({ where, orderBy, ...page })).map(toMarket);
  }
}

/* -------------------------------------------------------------------------- */
/*                     Preferred markets first (etfs, stocks)                 */
/* -------------------------------------------------------------------------- */

/**
 * The columns a free-text search looks at for the two listed-instrument
 * catalogs. The same list `searchOr` uses, spelled as database columns because
 * the preferred-market page is raw SQL (below).
 */
const MARKET_SEARCH_COLUMNS: Record<MarketKind, readonly string[]> = {
  etfs: ["symbol", "name", "exchange", "mic_code", "country"],
  stocks: ["symbol", "name", "exchange", "mic_code", "country", "type"],
};

/**
 * The `WHERE` of a preferred-market page, with the same semantics as
 * `whereOf` for these two kinds: the free-text search as a case-insensitive
 * substring over the kind's searchable columns, and the exact market filter.
 * Neither kind is retirable, so scope adds nothing.
 *
 * The search value is a bound parameter and the wildcards are concatenated in
 * SQL, which is exactly what Prisma's `contains` + `mode: "insensitive"`
 * emits — so a `%` typed into the search box keeps behaving as it does on the
 * typed path. Only the column *names* are interpolated, and they come from the
 * constant above, never from a request.
 */
function marketWhereSql(kind: MarketKind, filter: { q?: string; country?: string }): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];

  const q = filter.q?.trim();
  if (q) {
    const columns = MARKET_SEARCH_COLUMNS[kind].map(
      (column) => Prisma.sql`${Prisma.raw(`"${column}"`)} ILIKE '%' || ${q} || '%'`,
    );
    clauses.push(Prisma.sql`(${Prisma.join(columns, " OR ")})`);
  }

  const country = filter.country?.trim();
  if (country) clauses.push(Prisma.sql`"country" = ${country}`);

  return clauses.length === 0 ? Prisma.sql`TRUE` : Prisma.join(clauses, " AND ");
}

/**
 * One page of ETFs or stocks with the **preferred markets first**: Canadian
 * listings, then US ones, then the rest, and inside each tier the kind's usual
 * order (symbol, exchange, id).
 *
 * This is the one read that raw SQL earns. The app is mostly about Canadian
 * and US markets, but the feed lists the same ticker on dozens of world
 * exchanges, so a search for a symbol used to bury the listing the operator
 * wants pages down. Ordering by a `CASE`-like expression is not something
 * Prisma's `orderBy` can express, and sorting a 100 000-row catalog in the
 * application is not an option — so the order goes to Postgres as a boolean
 * expression per preferred country, `DESC` (true first).
 *
 * Everything else stays as it was: the same `where`, the same `skip`/`take`,
 * and the count still comes from `countRows`, which reads the same filter
 * through Prisma.
 */
async function queryMarketPage(
  kind: MarketKind,
  options: { q?: string; country?: string; skip: number; take: number },
): Promise<CatalogRow[]> {
  const where = marketWhereSql(kind, options);
  const preferred = Prisma.join(
    PREFERRED_COUNTRIES.map((country) => Prisma.sql`("country" = ${country}) DESC`),
    ", ",
  );
  const order = Prisma.sql`ORDER BY ${preferred}, "symbol", "exchange", "id"`;
  const page = Prisma.sql`LIMIT ${options.take} OFFSET ${options.skip}`;

  if (kind === "stocks") {
    const rows = await prismaAdmin.$queryRaw<StockRecord[]>`
      SELECT "id", "symbol", "name", "currency", "exchange", "mic_code", "country", "type",
             "figi_code", "cfi_code", "isin", "cusip", "created_at"
      FROM "stocks"
      WHERE ${where}
      ${order}
      ${page}`;
    return rows.map(toStock);
  }

  const rows = await prismaAdmin.$queryRaw<EtfRecord[]>`
    SELECT "id", "symbol", "name", "currency", "exchange", "mic_code", "country",
           "figi_code", "cfi_code", "isin", "cusip", "created_at"
    FROM "etfs"
    WHERE ${where}
    ${order}
    ${page}`;
  return rows.map(toEtf);
}

/**
 * One batch of **ids only**, in primary-key order, after the `after` cursor.
 *
 * The same query `queryRows` runs with `order: "id"`, minus every column but
 * the key: Postgres answers it from the primary-key index alone and the batch
 * costs a few bytes per row instead of a few hundred. That is what lets the
 * `unknown` filter walk a 300 000-row catalog for one page (see
 * `scanForState`).
 */
async function queryIds(kind: ConstantKind, filter: RowFilter, take: number): Promise<string[]> {
  // See `whereOf`: the clause is built once and typed at the delegate.
  const where = whereOf(kind, filter) as never;
  const orderBy = [{ id: "asc" }] as never;
  const select = { id: true } as const;
  const page = { where, orderBy, select, take };
  // `String(id)` is the wire form for every kind; the three integer-keyed ones
  // meet the others here, exactly as the row mappers do.
  const ids = async (rows: Promise<{ id: string | number }[]>) =>
    (await rows).map((row) => String(row.id));
  switch (kind) {
    case "countries":
      return ids(prismaAdmin.countries.findMany(page));
    case "currencies":
      return ids(prismaAdmin.currencies.findMany(page));
    case "financial_institutions":
      return ids(prismaAdmin.financial_institutions.findMany(page));
    case "categories":
      return ids(prismaAdmin.categories.findMany(page));
    case "account_base_types":
      return ids(prismaAdmin.account_base_types.findMany(page));
    case "account_types":
      return ids(prismaAdmin.account_types.findMany(page));
    case "cryptocurrencies":
      return ids(prismaAdmin.cryptocurrencies.findMany(page));
    case "etfs":
      return ids(prismaAdmin.etfs.findMany(page));
    case "stocks":
      return ids(prismaAdmin.stocks.findMany(page));
    case "markets":
      return ids(prismaAdmin.markets.findMany(page));
  }
}

/** How many rows of one kind match a filter. */
export async function countRows(kind: ConstantKind, filter: RowFilter = {}): Promise<number> {
  const where = whereOf(kind, filter) as never;
  switch (kind) {
    case "countries":
      return prismaAdmin.countries.count({ where });
    case "currencies":
      return prismaAdmin.currencies.count({ where });
    case "financial_institutions":
      return prismaAdmin.financial_institutions.count({ where });
    case "categories":
      return prismaAdmin.categories.count({ where });
    case "account_base_types":
      return prismaAdmin.account_base_types.count({ where });
    case "account_types":
      return prismaAdmin.account_types.count({ where });
    case "cryptocurrencies":
      return prismaAdmin.cryptocurrencies.count({ where });
    case "etfs":
      return prismaAdmin.etfs.count({ where });
    case "stocks":
      return prismaAdmin.stocks.count({ where });
    case "markets":
      return prismaAdmin.markets.count({ where });
  }
}

/**
 * One batch of rows in primary-key order, after the `after` cursor. This is
 * how a compare or a whole-catalog push walks 300 000 rows: a cursor on the
 * primary key costs the same at the end of the table as at the start, which a
 * growing `OFFSET` does not.
 */
export async function scanRows<K extends ConstantKind>(
  kind: K,
  options: { after: string | null; take: number; q?: string; scope?: RowScope },
): Promise<CatalogRowOf<K>[]> {
  const rows = await queryRows(kind, { ...options, order: "id" });
  return rows as CatalogRowOf<K>[];
}

/**
 * The rows behind a list of wire ids, in the kind's natural order. Ids that no
 * longer exist are simply absent from the result.
 */
export async function findByIds<K extends ConstantKind>(
  kind: K,
  ids: readonly string[],
  scope: RowScope = "all",
): Promise<CatalogRowOf<K>[]> {
  if (ids.length === 0) return [];
  const rows: CatalogRow[] = [];
  for (let index = 0; index < ids.length; index += FIND_BY_IDS_CHUNK) {
    const batch = ids.slice(index, index + FIND_BY_IDS_CHUNK);
    rows.push(...(await queryRows(kind, { ids: batch, scope, order: "natural" })));
  }
  return (ids.length > FIND_BY_IDS_CHUNK ? sortNatural(kind, rows) : rows) as CatalogRowOf<K>[];
}

/** Ids per `WHERE id IN (…)`. */
const FIND_BY_IDS_CHUNK = 1_000;

/** Rows read per pass when a page has to be found by scanning the catalog. */
const SCAN_CHUNK = 1_000;

/**
 * Ids read per pass when the scan can walk the key alone (no search). Larger
 * than `SCAN_CHUNK` because an id costs a fraction of a row: 5000 keeps the
 * round trips down without holding anything meaningful in memory.
 */
const ID_SCAN_CHUNK = 5_000;

/** What the list endpoint filters on. `all` means every live row. */
export type ListStateFilter = PushState | "all" | "pending" | "retired";

export interface FindPageQuery {
  /** 1-based. */
  page: number;
  pageSize: number;
  q?: string;
  state?: ListStateFilter;
  /** Market filter; `etfs` and `stocks` only, exact match on `country`. */
  country?: string;
}

export interface ConstantPage<K extends ConstantKind> {
  rows: CatalogRowOf<K>[];
  /** Rows matching the query across every page. */
  total: number;
}

/**
 * One page of a catalog, filtered by search text and by push state.
 *
 * Three routes through this, because the state lives in another table
 * (`admin_constant_sync`) that Prisma cannot join to the catalogs — they have
 * no relation, on purpose, so one ledger serves ten kinds:
 *
 * 1. **No state filter** (`all`, `retired`): a plain indexed page over the
 *    catalog, exact count. The common case. For `etfs` and `stocks` that page
 *    is read with raw SQL instead, so Canadian and then US listings come
 *    before every other market's (`queryMarketPage`); the count is unchanged.
 * 2. **A state, no search**: the ledger is paged instead (`skip`/`take` on
 *    `(kind, state)`), and the page's ids are read back as rows. Bounded and
 *    fast at any catalog size; the ids come out in ledger id order, so the
 *    page is re-sorted into the kind's natural order before it is returned.
 *    `total` is the ledger's count, which can exceed the number of rows on the
 *    page if the ledger still holds an id whose row has since been deleted
 *    straight in the database. A compare does not clear those: it only
 *    re-labels the ids the main database still has (as `main_only`) and the
 *    ids the admin catalog still has — an entry for a row that exists in
 *    neither is left where it is, and only a delete through this module
 *    (`removeState`) takes it out.
 * 3. **`unknown`, or a state together with a search**: neither table can
 *    answer alone, so the catalog is scanned. Without a search that walk is
 *    **ids only**, in batches of 5000, with one ledger lookup per batch and
 *    the page's rows fetched at the end; with a search it is whole rows in
 *    batches of 1000. Either way memory stays at one batch plus the page and
 *    the count is exact, but the cost is one pass over the catalog **per
 *    page** — see `scanForState`.
 *
 * The market filter (`?country`, `etfs` and `stocks` only) narrows all three
 * routes, but the ledger holds no countries, so a state that would otherwise
 * take route 2 takes route 3 while it is set.
 *
 * A state filter (routes 2 and 3) reads rows with scope `all`, retired ones
 * included: the ledger describes every row of the catalog, so hiding retired
 * rows here would make `total` and the rows on the page disagree. `retired` is
 * the one filter that splits on retirement.
 */
export async function findPage<K extends ConstantKind>(
  kind: K,
  query: FindPageQuery,
): Promise<ConstantPage<K>> {
  const state: ListStateFilter = query.state ?? "all";
  const q = query.q?.trim() === "" ? undefined : query.q?.trim();
  // Only the two listed-instrument catalogs have a country; anywhere else the
  // filter is ignored rather than answering an empty page.
  const country = isMarketKind(kind)
    ? (query.country?.trim() === "" ? undefined : query.country?.trim())
    : undefined;
  const skip = (query.page - 1) * query.pageSize;
  const take = query.pageSize;

  if (state === "retired") {
    // A kind that is deleted outright has no retired rows to show.
    if (!isRetirable(kind)) return { rows: [], total: 0 };
    const filter: RowFilter = { q, scope: "retired" };
    const [rows, total] = await Promise.all([
      queryRows(kind, { ...filter, skip, take }),
      countRows(kind, filter),
    ]);
    return { rows: rows as CatalogRowOf<K>[], total };
  }

  if (state === "all") {
    const filter: RowFilter = { q, country, scope: "live" };
    // ETFs and stocks list Canadian and US rows first, which takes an ordering
    // Prisma cannot express; the count is the same typed query either way.
    const [rows, total] = await Promise.all([
      isMarketKind(kind)
        ? queryMarketPage(kind, { q, country, skip, take })
        : queryRows(kind, { ...filter, skip, take }),
      countRows(kind, filter),
    ]);
    return { rows: rows as CatalogRowOf<K>[], total };
  }

  const wanted: LedgerState[] = state === "pending" ? ["new", "changed"] : [state as LedgerState];

  // The ledger knows nothing about countries, so a market filter has to be
  // answered by the catalog: it takes the scan route rather than the ledger
  // page, which would drop rows out of a `total` it had already counted.
  if (state !== "unknown" && q === undefined && country === undefined) {
    const [total, ids] = await Promise.all([
      countIdsInStates(kind, wanted),
      listIdsInStates(kind, wanted, { skip, take }),
    ]);
    // Scope `all`: the ledger counts retired rows too, so reading only the
    // live ones would answer a `total` the page cannot show.
    const rows = await findByIds(kind, ids, "all");
    return { rows, total };
  }

  return scanForState(kind, { state, wanted, q, country, skip, take });
}

/**
 * Route 3 of `findPage`: walk the catalog, check the ledger, keep the matches.
 *
 * Rows are read with scope `all` — retired rows carry a ledger state like any
 * other and the page tags them, so leaving them out would contradict `total`.
 *
 * **Cost.** This route is a full pass over the catalog *for every page*: there
 * is no index that answers "rows with no ledger entry", and `?q` has none
 * behind it either. Without a search the pass is ids only (`queryIds`, batches
 * of `ID_SCAN_CHUNK`) with one ledger lookup per batch, and only the page's
 * ids are turned into rows — roughly 60 pairs of small round trips for 300 000
 * rows, which is affordable but is not free; with a search it is whole rows in
 * batches of `SCAN_CHUNK`, so the search should be the narrow half of the
 * query. A large `unknown` count is a signal to run a compare, which moves the
 * kind back onto route 2.
 */
async function scanForState<K extends ConstantKind>(
  kind: K,
  options: {
    state: ListStateFilter;
    wanted: readonly LedgerState[];
    q: string | undefined;
    country: string | undefined;
    skip: number;
    take: number;
  },
): Promise<ConstantPage<K>> {
  const { state, wanted, q, country, skip, take } = options;
  const keep = new Set<string>(wanted);
  const matches = (rowState: PushState): boolean =>
    state === "unknown" ? rowState === "unknown" : keep.has(rowState);

  if (q === undefined) {
    // Ids only: nothing but the primary key crosses the wire until the page
    // itself is known.
    const pageIds: string[] = [];
    let total = 0;
    let after: string | null = null;
    for (;;) {
      const batch = await queryIds(kind, { scope: "all", country, after }, ID_SCAN_CHUNK);
      if (batch.length === 0) break;
      const states = await stateOfRows(kind, batch);
      for (const id of batch) {
        if (!matches(states.get(id) ?? "unknown")) continue;
        total += 1;
        if (total > skip && pageIds.length < take) pageIds.push(id);
      }
      after = batch[batch.length - 1];
      if (batch.length < ID_SCAN_CHUNK) break;
    }
    // One page of ids, read back in the kind's natural order.
    const rows = await findByIds(kind, pageIds, "all");
    return { rows, total };
  }

  const page: CatalogRow[] = [];
  let total = 0;
  let after: string | null = null;

  for (;;) {
    const batch = await queryRows(kind, {
      q,
      country,
      scope: "all",
      after,
      order: "id",
      take: SCAN_CHUNK,
    });
    if (batch.length === 0) break;
    const states = await stateOfRows(
      kind,
      batch.map((row) => row.id),
    );
    for (const row of batch) {
      if (!matches(states.get(row.id) ?? "unknown")) continue;
      total += 1;
      if (total > skip && page.length < take) page.push(row);
    }
    after = batch[batch.length - 1].id;
    if (batch.length < SCAN_CHUNK) break;
  }

  return { rows: sortNatural(kind, page) as CatalogRowOf<K>[], total };
}
