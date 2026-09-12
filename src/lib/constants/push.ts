import "server-only";
/**
 * Carrying the admin catalogs across to the **main** app database.
 *
 * The admin database masters the reference catalogs; the consumer app reads
 * its own copy. This module is the one deliberate write path from the console
 * into `DATABASE_URL`:
 *
 * - `compareStates` reads the main copy of a handful of rows and labels each
 *   one `new`, `changed` or `synced`. It is what a compare job
 *   (`./compare.ts`) writes into the ledger and what a push consults before it
 *   touches a dependency. A list request never calls it: states come from the
 *   ledger.
 * - `preparePush` + `pushWork` upsert rows **by id**, in batches of
 *   `PUSH_BATCH_SIZE`, one transaction per batch. Nothing is ever deleted: a
 *   row over there may be referenced by tenant data (accounts, transactions,
 *   budgets), so removal stays a deliberate act on the consumer side.
 *
 * Batches, rather than one big transaction, are what makes a 300 000-row
 * catalog pushable: each batch commits on its own and marks its rows `synced`
 * in the ledger, so an interrupted push is simply re-run and picks up what is
 * still pending.
 *
 * Only the pushed fields are compared, and only the fields the per-kind
 * builders below list are written, so columns the consumer app owns
 * (`created_at` on an existing row, and anything added there later) keep their
 * values. The exceptions are `categories.updated_at` and `markets.updated_at`,
 * which every write stamps with `now()` so the consumer app sees the row as
 * freshly changed.
 *
 * Foreign keys are respected by pushing dependencies first, **per batch**: a
 * country's currency, an account type's base type, and a category's ancestors
 * (parents before children). Those extra writes are counted as
 * `dependencyRows` on the job. The four market-data catalogs
 * (cryptocurrencies, ETFs, stocks, markets) reference nothing, so they never
 * carry dependencies.
 *
 * The main-side table is not always the admin one's namesake: `MAIN_TABLE_OF`
 * in `./types.ts` names it, and the three market-data catalogs land in
 * `preload_*` tables over there. Those three are keyed by an integer sequence:
 * a push writes the admin id explicitly, so after each group the main
 * sequence is advanced past the highest id now present (`setval`). Without it
 * the consumer app's next insert would reuse a number this push just took.
 *
 * Two clients are used, never in the same transaction: `prismaAdmin` reads the
 * catalog, keeps the ledger and writes the audit row, `prisma` does the
 * transactional upsert.
 */
import type { Prisma as AdminPrisma } from "@/generated/prisma-admin/client";
import { Prisma as MainPrisma } from "@/generated/prisma/client";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import { prismaAdmin } from "@/lib/prisma-admin";
import { isIntegerIdString, parseIntegerId, toIntegerIds } from "./ids";
import type { JobWork } from "./jobs";
import {
  countIdsInStates,
  iterateIdsInStates,
  upsertStates,
  type ComparedState,
  type LedgerState,
} from "./ledger";
import {
  countRows,
  findByIds,
  listConstants,
  scanRows,
  type CatalogAccountBaseType,
  type CatalogAccountType,
  type CatalogCategory,
  type CatalogCountry,
  type CatalogCryptocurrency,
  type CatalogCurrency,
  type CatalogEtf,
  type CatalogFinancialInstitution,
  type CatalogMarket,
  type CatalogRow,
  type CatalogStock,
} from "./repository";
import {
  CONSTANT_KIND_LABELS,
  hasIntegerId,
  isPulledKind,
  PUSH_BATCH_SIZE,
  PUSH_IDS_MAX,
  type ConstantKind,
  type PushInput,
} from "./types";

/** How a row of one kind came out of a push. */
type PushOutcome = "created" | "updated" | "unchanged";

/** One row's outcome, used to count what a batch did. */
interface PushResultRow {
  id: string;
  outcome: PushOutcome;
}

/** Main-database client or transaction client; the queries here work on both. */
type MainClient = MainPrisma.TransactionClient;

/** How many ids one `WHERE id IN (…)` carries. */
const ID_CHUNK = 1_000;

/** Interactive transaction budget for one batch (up to `PUSH_BATCH_SIZE` rows). */
const PUSH_TIMEOUT_MS = 60_000;
const PUSH_MAX_WAIT_MS = 10_000;

/* -------------------------------------------------------------------------- */
/*                            Main-database shapes                            */
/* -------------------------------------------------------------------------- */

/** Exactly the columns a push writes, per kind. Nothing else is read or compared. */
type MainCountry = {
  id: string;
  name: string;
  alpha2_code: string;
  alpha3_code: string;
  currency_id: string | null;
};
type MainCurrency = { id: string; code: string; name: string; symbol: string | null };
type MainInstitution = { id: string; name: string; institution_number: string; type: string };
type MainCategory = {
  id: string;
  name: string;
  type: string | null;
  parent_id: string | null;
  is_discretionary: boolean | null;
  deleted_at: Date | null;
};
type MainAccountBaseType = { id: string; name: string };
type MainAccountType = {
  id: string;
  name: string;
  display_name: string;
  is_asset: boolean;
  is_banking: boolean;
  is_investment: boolean;
  base_type_id: string | null;
  deleted_at: Date | null;
};
/**
 * The `preload_*` tables and `markets` on the main side. The three preload
 * tables key on an integer, so `id` is a number here; every map in this
 * module is keyed by `String(row.id)` so the two shapes meet on the wire form.
 */
type MainCryptocurrency = {
  id: number;
  symbol: string;
  available_exchanges: string;
  currency_base: string;
  currency_quote: string;
};
type MainEtf = {
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
};
type MainStock = MainEtf & { type: string };
type MainMarket = {
  id: string;
  mic_code: string;
  operating_mic: string;
  market_name: string;
  iso_country_code: string;
  city: string;
  deleted_at: Date | null;
};

type MainRow =
  | MainCountry
  | MainCurrency
  | MainInstitution
  | MainCategory
  | MainAccountBaseType
  | MainAccountType
  | MainCryptocurrency
  | MainEtf
  | MainStock
  | MainMarket;

const COUNTRY_SELECT = {
  id: true,
  name: true,
  alpha2_code: true,
  alpha3_code: true,
  currency_id: true,
} as const;
const CURRENCY_SELECT = { id: true, code: true, name: true, symbol: true } as const;
const INSTITUTION_SELECT = { id: true, name: true, institution_number: true, type: true } as const;
const CATEGORY_SELECT = {
  id: true,
  name: true,
  type: true,
  parent_id: true,
  is_discretionary: true,
  deleted_at: true,
} as const;
const ACCOUNT_BASE_TYPE_SELECT = { id: true, name: true } as const;
const ACCOUNT_TYPE_SELECT = {
  id: true,
  name: true,
  display_name: true,
  is_asset: true,
  is_banking: true,
  is_investment: true,
  base_type_id: true,
  deleted_at: true,
} as const;

const CRYPTOCURRENCY_SELECT = {
  id: true,
  symbol: true,
  available_exchanges: true,
  currency_base: true,
  currency_quote: true,
} as const;
const ETF_SELECT = {
  id: true,
  symbol: true,
  name: true,
  currency: true,
  exchange: true,
  mic_code: true,
  country: true,
  figi_code: true,
  cfi_code: true,
  isin: true,
  cusip: true,
} as const;
const STOCK_SELECT = { ...ETF_SELECT, type: true } as const;
const MARKET_SELECT = {
  id: true,
  mic_code: true,
  operating_mic: true,
  market_name: true,
  iso_country_code: true,
  city: true,
  deleted_at: true,
} as const;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/**
 * One batch of main rows of one kind, with exactly the pushed columns
 * selected. Ids arrive in their wire (string) form; the integer-keyed kinds
 * convert them here, dropping anything that is not an integer rather than
 * letting `NaN` into the query.
 */
function findMainRows(
  client: MainClient,
  kind: ConstantKind,
  ids: readonly string[],
): Promise<MainRow[]> {
  const where = { id: { in: [...ids] } };
  const intWhere = { id: { in: toIntegerIds(ids) } };
  switch (kind) {
    case "countries":
      return client.countries.findMany({ where, select: COUNTRY_SELECT });
    case "currencies":
      return client.currencies.findMany({ where, select: CURRENCY_SELECT });
    case "financial_institutions":
      return client.financial_institutions.findMany({ where, select: INSTITUTION_SELECT });
    case "categories":
      return client.categories.findMany({ where, select: CATEGORY_SELECT });
    case "account_base_types":
      return client.account_base_types.findMany({ where, select: ACCOUNT_BASE_TYPE_SELECT });
    case "account_types":
      return client.account_types.findMany({ where, select: ACCOUNT_TYPE_SELECT });
    case "cryptocurrencies":
      return client.preload_cryptocurrencies.findMany({ where: intWhere, select: CRYPTOCURRENCY_SELECT });
    case "etfs":
      return client.preload_etfs.findMany({ where: intWhere, select: ETF_SELECT });
    case "stocks":
      return client.preload_stocks.findMany({ where: intWhere, select: STOCK_SELECT });
    case "markets":
      return client.markets.findMany({ where, select: MARKET_SELECT });
  }
}

/** The main rows for these ids, keyed by id. Ids are read in chunks of `ID_CHUNK`. */
async function fetchMainRows(
  client: MainClient,
  kind: ConstantKind,
  ids: readonly string[],
): Promise<Map<string, MainRow>> {
  const found = new Map<string, MainRow>();
  for (const batch of chunk(ids, ID_CHUNK)) {
    const rows = await findMainRows(client, kind, batch);
    // Keyed by the wire form, so an integer key and a UUID look the same here.
    for (const row of rows) found.set(String(row.id), row);
  }
  return found;
}

function findMainIdRowsAfter(
  kind: ConstantKind,
  after: string | null,
  take: number,
): Promise<{ id: string | number }[]> {
  const select = { id: true } as const;
  const orderBy = { id: "asc" } as const;
  // A cursor on the primary key: the same cost at the end of a 300 000-row
  // table as at the start, which a growing `OFFSET` is not.
  const where = after === null ? {} : { id: { gt: after } };
  const intWhere =
    after === null || !isIntegerIdString(after) ? {} : { id: { gt: Number(after) } };
  switch (kind) {
    case "countries":
      return prisma.countries.findMany({ where, select, orderBy, take });
    case "currencies":
      return prisma.currencies.findMany({ where, select, orderBy, take });
    case "financial_institutions":
      return prisma.financial_institutions.findMany({ where, select, orderBy, take });
    case "categories":
      return prisma.categories.findMany({ where, select, orderBy, take });
    case "account_base_types":
      return prisma.account_base_types.findMany({ where, select, orderBy, take });
    case "account_types":
      return prisma.account_types.findMany({ where, select, orderBy, take });
    case "cryptocurrencies":
      return prisma.preload_cryptocurrencies.findMany({ where: intWhere, select, orderBy, take });
    case "etfs":
      return prisma.preload_etfs.findMany({ where: intWhere, select, orderBy, take });
    case "stocks":
      return prisma.preload_stocks.findMany({ where: intWhere, select, orderBy, take });
    case "markets":
      return prisma.markets.findMany({ where, select, orderBy, take });
  }
}

/**
 * One batch of ids the main table holds, in wire form, after `after`. One
 * indexed column, no joins: this is how a compare job finds the ids that exist
 * only over there without reading a single full row.
 */
export async function mainIdsAfter(
  kind: ConstantKind,
  after: string | null,
  take: number,
): Promise<string[]> {
  const rows = await findMainIdRowsAfter(kind, after, take);
  return rows.map((row) => String(row.id));
}

/* -------------------------------------------------------------------------- */
/*                                 Comparison                                 */
/* -------------------------------------------------------------------------- */

/** Timestamps are compared as epoch milliseconds, never as formatted strings. */
const msOf = (value: string | null): number | null => (value ? new Date(value).getTime() : null);

/** True when at least one pushed field differs between the two copies. */
function differs(kind: ConstantKind, admin: CatalogRow, main: MainRow): boolean {
  switch (kind) {
    case "countries": {
      const a = admin as CatalogCountry;
      const m = main as MainCountry;
      return (
        a.name !== m.name ||
        a.alpha2Code !== m.alpha2_code ||
        a.alpha3Code !== m.alpha3_code ||
        a.currencyId !== m.currency_id
      );
    }
    case "currencies": {
      const a = admin as CatalogCurrency;
      const m = main as MainCurrency;
      return a.code !== m.code || a.name !== m.name || a.symbol !== m.symbol;
    }
    case "financial_institutions": {
      const a = admin as CatalogFinancialInstitution;
      const m = main as MainInstitution;
      return a.name !== m.name || a.institutionNumber !== m.institution_number || a.type !== m.type;
    }
    case "categories": {
      const a = admin as CatalogCategory;
      const m = main as MainCategory;
      return (
        a.name !== m.name ||
        a.type !== m.type ||
        a.parentId !== m.parent_id ||
        a.isDiscretionary !== m.is_discretionary ||
        msOf(a.deletedAt) !== (m.deleted_at ? m.deleted_at.getTime() : null)
      );
    }
    case "account_base_types": {
      const a = admin as CatalogAccountBaseType;
      const m = main as MainAccountBaseType;
      return a.name !== m.name;
    }
    case "account_types": {
      const a = admin as CatalogAccountType;
      const m = main as MainAccountType;
      return (
        a.name !== m.name ||
        a.displayName !== m.display_name ||
        a.isAsset !== m.is_asset ||
        a.isBanking !== m.is_banking ||
        a.isInvestment !== m.is_investment ||
        a.baseTypeId !== m.base_type_id ||
        msOf(a.deletedAt) !== (m.deleted_at ? m.deleted_at.getTime() : null)
      );
    }
    case "cryptocurrencies": {
      const a = admin as CatalogCryptocurrency;
      const m = main as MainCryptocurrency;
      return (
        a.symbol !== m.symbol ||
        a.availableExchanges !== m.available_exchanges ||
        a.currencyBase !== m.currency_base ||
        a.currencyQuote !== m.currency_quote
      );
    }
    case "etfs": {
      return listedInstrumentDiffers(admin as CatalogEtf, main as MainEtf);
    }
    case "stocks": {
      const a = admin as CatalogStock;
      const m = main as MainStock;
      return listedInstrumentDiffers(a, m) || a.type !== m.type;
    }
    case "markets": {
      const a = admin as CatalogMarket;
      const m = main as MainMarket;
      return (
        a.micCode !== m.mic_code ||
        a.operatingMic !== m.operating_mic ||
        a.marketName !== m.market_name ||
        a.isoCountryCode !== m.iso_country_code ||
        a.city !== m.city ||
        msOf(a.deletedAt) !== (m.deleted_at ? m.deleted_at.getTime() : null)
      );
    }
  }
}

/** The ten columns an ETF and a stock share; a stock adds `type` on top. */
function listedInstrumentDiffers(a: CatalogEtf, m: MainEtf): boolean {
  return (
    a.symbol !== m.symbol ||
    a.name !== m.name ||
    a.currency !== m.currency ||
    a.exchange !== m.exchange ||
    a.micCode !== m.mic_code ||
    a.country !== m.country ||
    a.figiCode !== m.figi_code ||
    a.cfiCode !== m.cfi_code ||
    a.isin !== m.isin ||
    a.cusip !== m.cusip
  );
}

/**
 * Labels each admin row against the main database: `new` when there is no row
 * with that id over there, `changed` when a pushed field differs, `synced`
 * when the two copies match.
 *
 * This is the only comparison in the app, and it is never run on a list read:
 * a compare job walks a catalog with it and writes the verdicts to the ledger
 * (`./ledger.ts`), and a push or a single-row edit uses it for the handful of
 * rows it is about to touch.
 */
export async function compareStates(
  kind: ConstantKind,
  adminRows: readonly CatalogRow[],
): Promise<Map<string, ComparedState>> {
  const states = new Map<string, ComparedState>();
  if (adminRows.length === 0) return states;
  const mainRows = await fetchMainRows(
    prisma,
    kind,
    adminRows.map((row) => row.id),
  );
  for (const row of adminRows) {
    const main = mainRows.get(row.id);
    states.set(row.id, !main ? "new" : differs(kind, row, main) ? "changed" : "synced");
  }
  return states;
}

/** The state of a single row, for a create, an edit or a soft delete. */
export async function compareState(kind: ConstantKind, row: CatalogRow): Promise<ComparedState> {
  const states = await compareStates(kind, [row]);
  return states.get(row.id) ?? "new";
}

/* -------------------------------------------------------------------------- */
/*                                   Writing                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where the transaction is at, so a Prisma error can name the row it failed
 * on. `id` is null while a batch insert is in flight: one statement carries
 * many rows and the driver does not say which one it choked on.
 */
interface WriteCursor {
  kind: ConstantKind;
  id: string | null;
}

/** The columns a push writes, per kind. Nothing else is touched over there. */
const countryFields = (a: CatalogCountry) => ({
  name: a.name,
  alpha2_code: a.alpha2Code,
  alpha3_code: a.alpha3Code,
  currency_id: a.currencyId,
});

const currencyFields = (a: CatalogCurrency) => ({ code: a.code, name: a.name, symbol: a.symbol });

const institutionFields = (a: CatalogFinancialInstitution) => ({
  name: a.name,
  institution_number: a.institutionNumber,
  type: a.type,
});

const categoryFields = (a: CatalogCategory) => ({
  name: a.name,
  // The stored spelling, verbatim: the column is free text on both databases,
  // so an unexpected value is carried across rather than written as null.
  type: a.type,
  parent_id: a.parentId,
  is_discretionary: a.isDiscretionary,
  // The retirement travels with the row; the main database keeps the
  // soft-deleted copy so tenant references stay valid.
  deleted_at: a.deletedAt ? new Date(a.deletedAt) : null,
  // The one consumer-owned column a push does move: a written category is a
  // changed category over there.
  updated_at: new Date(),
});

const accountBaseTypeFields = (a: CatalogAccountBaseType) => ({ name: a.name });

const accountTypeFields = (a: CatalogAccountType) => ({
  name: a.name,
  display_name: a.displayName,
  is_asset: a.isAsset,
  is_banking: a.isBanking,
  is_investment: a.isInvestment,
  base_type_id: a.baseTypeId,
  // The retirement travels with the row; the main database keeps the
  // soft-deleted copy so accounts and loans that reference it stay valid.
  deleted_at: a.deletedAt ? new Date(a.deletedAt) : null,
});

const cryptocurrencyFields = (a: CatalogCryptocurrency) => ({
  symbol: a.symbol,
  available_exchanges: a.availableExchanges,
  currency_base: a.currencyBase,
  currency_quote: a.currencyQuote,
});

/** The ten columns an ETF and a stock share. */
const listedInstrumentFields = (a: CatalogEtf) => ({
  symbol: a.symbol,
  name: a.name,
  currency: a.currency,
  exchange: a.exchange,
  mic_code: a.micCode,
  country: a.country,
  figi_code: a.figiCode,
  cfi_code: a.cfiCode,
  isin: a.isin,
  cusip: a.cusip,
});

const etfFields = listedInstrumentFields;

const stockFields = (a: CatalogStock) => ({ ...listedInstrumentFields(a), type: a.type });

const marketFields = (a: CatalogMarket) => ({
  mic_code: a.micCode,
  operating_mic: a.operatingMic,
  market_name: a.marketName,
  iso_country_code: a.isoCountryCode,
  city: a.city,
  // The retirement travels with the row; the main database keeps the
  // soft-deleted copy so anything referencing the market stays valid.
  deleted_at: a.deletedAt ? new Date(a.deletedAt) : null,
  // Like categories, a written market is a changed market over there.
  updated_at: new Date(),
});

const countryCreateData = (a: CatalogCountry) => ({
  id: a.id,
  ...countryFields(a),
  created_at: a.createdAt ? new Date(a.createdAt) : undefined,
});

const currencyCreateData = (a: CatalogCurrency) => ({
  id: a.id,
  ...currencyFields(a),
  created_at: a.createdAt ? new Date(a.createdAt) : undefined,
});

const institutionCreateData = (a: CatalogFinancialInstitution) => ({ id: a.id, ...institutionFields(a) });

const accountBaseTypeCreateData = (a: CatalogAccountBaseType) => ({
  id: a.id,
  ...accountBaseTypeFields(a),
});

const accountTypeCreateData = (a: CatalogAccountType) => ({ id: a.id, ...accountTypeFields(a) });

// The three preload tables key on a sequence, and a push keeps the admin id:
// the two copies are compared by id, so it has to be the same number on both
// sides. `advanceMainSequence` then moves the main sequence past it.
const cryptocurrencyCreateData = (a: CatalogCryptocurrency) => ({
  id: Number(a.id),
  ...cryptocurrencyFields(a),
  created_at: a.createdAt ? new Date(a.createdAt) : undefined,
});

const etfCreateData = (a: CatalogEtf) => ({
  id: Number(a.id),
  ...etfFields(a),
  created_at: a.createdAt ? new Date(a.createdAt) : undefined,
});

const stockCreateData = (a: CatalogStock) => ({
  id: Number(a.id),
  ...stockFields(a),
  created_at: a.createdAt ? new Date(a.createdAt) : undefined,
});

const marketCreateData = (a: CatalogMarket) => {
  const fields = marketFields(a);
  return { id: a.id, ...fields, created_at: a.createdAt ? new Date(a.createdAt) : fields.updated_at };
};

const categoryCreateData = (a: CatalogCategory) => {
  const fields = categoryFields(a);
  return { id: a.id, ...fields, created_at: a.createdAt ? new Date(a.createdAt) : fields.updated_at };
};

/** Rewrites an existing main row from the admin copy. */
async function updateMainRow(tx: MainClient, kind: ConstantKind, admin: CatalogRow): Promise<void> {
  switch (kind) {
    case "countries": {
      const a = admin as CatalogCountry;
      await tx.countries.update({ where: { id: a.id }, data: countryFields(a) });
      return;
    }
    case "currencies": {
      const a = admin as CatalogCurrency;
      await tx.currencies.update({ where: { id: a.id }, data: currencyFields(a) });
      return;
    }
    case "financial_institutions": {
      const a = admin as CatalogFinancialInstitution;
      await tx.financial_institutions.update({ where: { id: a.id }, data: institutionFields(a) });
      return;
    }
    case "categories": {
      const a = admin as CatalogCategory;
      await tx.categories.update({ where: { id: a.id }, data: categoryFields(a) });
      return;
    }
    case "account_base_types": {
      const a = admin as CatalogAccountBaseType;
      await tx.account_base_types.update({ where: { id: a.id }, data: accountBaseTypeFields(a) });
      return;
    }
    case "account_types": {
      const a = admin as CatalogAccountType;
      await tx.account_types.update({ where: { id: a.id }, data: accountTypeFields(a) });
      return;
    }
    case "cryptocurrencies": {
      const a = admin as CatalogCryptocurrency;
      await tx.preload_cryptocurrencies.update({
        where: { id: parseIntegerId(kind, a.id) },
        data: cryptocurrencyFields(a),
      });
      return;
    }
    case "etfs": {
      const a = admin as CatalogEtf;
      await tx.preload_etfs.update({ where: { id: parseIntegerId(kind, a.id) }, data: etfFields(a) });
      return;
    }
    case "stocks": {
      const a = admin as CatalogStock;
      await tx.preload_stocks.update({ where: { id: parseIntegerId(kind, a.id) }, data: stockFields(a) });
      return;
    }
    case "markets": {
      const a = admin as CatalogMarket;
      await tx.markets.update({ where: { id: a.id }, data: marketFields(a) });
      return;
    }
  }
}

/** Inserts one main row, keeping the admin id. Used for categories only. */
async function createMainRow(tx: MainClient, admin: CatalogCategory): Promise<void> {
  await tx.categories.create({ data: categoryCreateData(admin) });
}

/** The kinds whose creates may go out as one statement (no self-reference). */
type BatchKind = Exclude<ConstantKind, "categories">;

/**
 * Inserts a whole group in one `INSERT`. Categories are excluded by the type:
 * a child may sit in the same batch as its parent, and a single statement
 * would have Postgres check that foreign key against a row it has not
 * inserted yet, so they stay one create per row in depth order.
 */
async function createMainRows(
  tx: MainClient,
  kind: BatchKind,
  rows: readonly CatalogRow[],
): Promise<void> {
  switch (kind) {
    case "countries":
      await tx.countries.createMany({ data: (rows as CatalogCountry[]).map(countryCreateData) });
      return;
    case "currencies":
      await tx.currencies.createMany({ data: (rows as CatalogCurrency[]).map(currencyCreateData) });
      return;
    case "financial_institutions":
      await tx.financial_institutions.createMany({
        data: (rows as CatalogFinancialInstitution[]).map(institutionCreateData),
      });
      return;
    case "account_base_types":
      await tx.account_base_types.createMany({
        data: (rows as CatalogAccountBaseType[]).map(accountBaseTypeCreateData),
      });
      return;
    case "account_types":
      // An account type points at a base type, never at another account type,
      // so a whole batch is safe in one statement: its base types were written
      // by the dependency group before this one.
      await tx.account_types.createMany({
        data: (rows as CatalogAccountType[]).map(accountTypeCreateData),
      });
      return;
    case "cryptocurrencies":
      await tx.preload_cryptocurrencies.createMany({
        data: (rows as CatalogCryptocurrency[]).map(cryptocurrencyCreateData),
      });
      return;
    case "etfs":
      await tx.preload_etfs.createMany({ data: (rows as CatalogEtf[]).map(etfCreateData) });
      return;
    case "stocks":
      await tx.preload_stocks.createMany({ data: (rows as CatalogStock[]).map(stockCreateData) });
      return;
    case "markets":
      await tx.markets.createMany({ data: (rows as CatalogMarket[]).map(marketCreateData) });
      return;
  }
}

/**
 * Moves a `preload_*` sequence past the ids this push just wrote.
 *
 * A push keeps the admin id, so it inserts numbers the main sequence has never
 * handed out. Left alone, the consumer app's next insert would ask for
 * `nextval` and get a number this table already holds — a duplicate-key error
 * over there, caused from here. `setval` to `MAX(id)` (never below 1, which is
 * what `setval` requires) makes the next `nextval` land above everything
 * present.
 *
 * Runs inside the push transaction, but `setval` is **not** transactional: a
 * rollback leaves the sequence where this call put it. That is harmless — the
 * sequence only moved past ids that are, or briefly were, present, so the next
 * `nextval` still lands above everything in the table; the effect of a rolled
 * back batch is a gap in the numbering, which is what sequences are for. The
 * table name is a literal per branch: nothing user-supplied is interpolated.
 */
async function advanceMainSequence(tx: MainClient, kind: ConstantKind): Promise<void> {
  switch (kind) {
    case "cryptocurrencies":
      await tx.$executeRaw`SELECT setval(pg_get_serial_sequence('preload_cryptocurrencies', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM preload_cryptocurrencies), 1))`;
      return;
    case "etfs":
      await tx.$executeRaw`SELECT setval(pg_get_serial_sequence('preload_etfs', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM preload_etfs), 1))`;
      return;
    case "stocks":
      await tx.$executeRaw`SELECT setval(pg_get_serial_sequence('preload_stocks', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM preload_stocks), 1))`;
      return;
    default:
      // Every other kind is keyed by a UUID the admin database generates.
      return;
  }
}

/**
 * Pushes one ordered group of same-kind rows; unchanged rows are not written.
 *
 * Updates are one round trip each. Creates of every kind but categories are
 * collected and inserted with a single `createMany` at the end of the group,
 * which is what keeps a large push inside the transaction budget; categories
 * are created in place, in the order they arrive (parents first), because a
 * create or an update in this group may point at another row of it.
 *
 * A group that inserted into a sequence-keyed table ends by advancing that
 * table's sequence past the ids it just wrote.
 */
async function writeGroup(
  tx: MainClient,
  kind: ConstantKind,
  rows: readonly CatalogRow[],
  cursor: WriteCursor,
): Promise<PushResultRow[]> {
  if (rows.length === 0) return [];
  const existing = await fetchMainRows(
    tx,
    kind,
    rows.map((row) => row.id),
  );
  const results: PushResultRow[] = [];
  const pendingCreates: CatalogRow[] = [];
  for (const row of rows) {
    const main = existing.get(row.id);
    const outcome: PushOutcome = !main ? "created" : differs(kind, row, main) ? "updated" : "unchanged";
    results.push({ id: row.id, outcome });
    if (outcome === "unchanged") continue;
    cursor.kind = kind;
    cursor.id = row.id;
    if (outcome === "updated") {
      await updateMainRow(tx, kind, row);
    } else if (kind === "categories") {
      await createMainRow(tx, row as CatalogCategory);
    } else {
      pendingCreates.push(row);
    }
  }
  if (pendingCreates.length > 0 && kind !== "categories") {
    cursor.kind = kind;
    cursor.id = null;
    await createMainRows(tx, kind, pendingCreates);
  }
  // Only an insert can raise the highest id, and only the sequence-keyed kinds
  // have a sequence to move.
  if (pendingCreates.length > 0 && hasIntegerId(kind)) {
    cursor.kind = kind;
    cursor.id = null;
    await advanceMainSequence(tx, kind);
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/*                          Main-database write errors                        */
/* -------------------------------------------------------------------------- */

/** `meta.target` / `meta.field_name` are a string or a list of them. */
function metaText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

/** "category 9f2…" while a row is being written, "the categories batch" during an insert. */
function whereItFailed(cursor: WriteCursor): string {
  const label = CONSTANT_KIND_LABELS[cursor.kind];
  return cursor.id ? `${label.singular} ${cursor.id}` : `the ${label.plural} batch`;
}

/**
 * Turns a rejected write on the main database into an `ApiError` the operator
 * can act on. Anything that is not a known Prisma error is returned unchanged
 * and becomes a generic 500.
 */
function mainWriteError(error: unknown, cursor: WriteCursor): unknown {
  if (!(error instanceof MainPrisma.PrismaClientKnownRequestError)) return error;
  const at = whereItFailed(cursor);
  const meta = (error.meta ?? {}) as Record<string, unknown>;
  switch (error.code) {
    case "P2002": {
      const target = metaText(meta.target);
      return new ConflictError(
        `The main app database already has a row with the same ${target ?? "unique value"} (${at}). Reconcile it there before pushing.`,
      );
    }
    case "P2003": {
      const field = metaText(meta.field_name) ?? metaText(meta.constraint);
      return new ValidationError(
        `The main app database rejected ${at}: ${field ?? "a reference on it"} points at a row it does not have. Push that row first.`,
      );
    }
    default:
      return new ConflictError(
        `The main app database refused the push at ${at} (Prisma ${error.code}). Nothing was written.`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

/** Depth of a category in the admin tree; used to order parents before children. */
function depthOf(id: string, parentOf: Map<string, string | null>): number {
  let depth = 0;
  const seen = new Set<string>([id]);
  let cursor = parentOf.get(id) ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = parentOf.get(cursor) ?? null;
  }
  return depth;
}

const byDepth = (parentOf: Map<string, string | null>) => (a: CatalogCategory, b: CatalogCategory) =>
  depthOf(a.id, parentOf) - depthOf(b.id, parentOf) || a.name.localeCompare(b.name);

/**
 * The ancestors of the selected categories that were not selected themselves,
 * ordered parents first. Without them a `parent_id` could point at a row the
 * main database does not have yet.
 */
function ancestorsOf(
  selected: readonly CatalogCategory[],
  byId: Map<string, CatalogCategory>,
): CatalogCategory[] {
  const parentOf = new Map([...byId.values()].map((row) => [row.id, row.parentId] as const));
  const selectedIds = new Set(selected.map((row) => row.id));
  const extra = new Map<string, CatalogCategory>();
  for (const row of selected) {
    const walked = new Set<string>([row.id]);
    let cursor = row.parentId;
    while (cursor && !walked.has(cursor)) {
      walked.add(cursor);
      const parent = byId.get(cursor);
      // A dangling parent_id cannot be pushed; the main insert would fail its
      // foreign key, so stop here and let that row's write report the problem.
      if (!parent) break;
      if (!selectedIds.has(parent.id)) extra.set(parent.id, parent);
      cursor = parent.parentId;
    }
  }
  return [...extra.values()].sort(byDepth(parentOf));
}

/* -------------------------------------------------------------------------- */
/*                                    Push                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a push will process, resolved without loading the catalog.
 *
 * `total` is known up front for all three request shapes — an id list, the
 * pending set (a ledger count) or the whole kind (a row count) — and drives
 * the inline-or-background decision. `batches` yields the rows themselves, at
 * most `PUSH_BATCH_SIZE` at a time, so a 300 000-row push never holds more
 * than one batch in memory.
 */
export interface PushTarget {
  total: number;
  batches: () => AsyncGenerator<PushBatch>;
}

/**
 * One batch of a push: the rows to write, plus how many rows the batch was
 * supposed to have and no longer does.
 *
 * `vanished` is only ever non-zero on the `pending` scope, where the batch is
 * a page of **ledger ids**: an id whose catalog row has since been deleted has
 * nothing left to push. It still counts towards `total`, which was taken from
 * the ledger, so it is counted as processed — otherwise the progress bar of a
 * push over a stale ledger stops short of its total and looks stuck.
 */
export interface PushBatch {
  rows: CatalogRow[];
  vanished: number;
}

/**
 * Works out which rows a push request names.
 *
 * @throws {ValidationError} an empty id list, or more ids than `PUSH_IDS_MAX`.
 * @throws {NotFoundError} an id the admin catalog does not have. This happens
 * before the job is created, so a mistyped id is a plain 404 and leaves no
 * job behind.
 * @throws {ConflictError} a kind the consumer app pulls rather than reads from
 * the main database (`PULLED_KINDS`). `startPush` in `./service.ts` refuses
 * those first; this is the backstop for any other caller, so no code path can
 * push a catalog the product no longer copies over there.
 */
export async function preparePush(kind: ConstantKind, input: PushInput): Promise<PushTarget> {
  if (isPulledKind(kind)) {
    throw new ConflictError(
      `${CONSTANT_KIND_LABELS[kind].plural} are pulled by the consumer app at tenant creation; ` +
        "there is nothing to push.",
    );
  }
  if (input.ids !== undefined) {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0) {
      // "Nothing selected" must never turn into "everything"; that is what
      // `scope` is for.
      throw new ValidationError("Select at least one row to push.");
    }
    if (ids.length > PUSH_IDS_MAX) {
      throw new ValidationError(
        `A push names at most ${PUSH_IDS_MAX} rows at a time; this one names ${ids.length}. Use a scope instead.`,
      );
    }
    // The sequence-keyed kinds settle the id shape before anything else, so a
    // hand-made request can never carry a non-integer id into a query.
    if (hasIntegerId(kind)) for (const id of ids) parseIntegerId(kind, id);

    const rows = await findByIds(kind, ids);
    if (rows.length < ids.length) {
      const found = new Set(rows.map((row) => row.id));
      const missing = ids.find((id) => !found.has(id));
      throw new NotFoundError(
        `No ${CONSTANT_KIND_LABELS[kind].singular} with id ${missing} in the admin catalog.`,
      );
    }
    return {
      total: rows.length,
      batches: async function* () {
        for (const batch of chunk(rows, PUSH_BATCH_SIZE)) yield { rows: batch, vanished: 0 };
      },
    };
  }

  if (input.scope === "pending") {
    // Straight from the ledger: every row a compare (or a later edit) left as
    // new or changed. Ids are walked by cursor, rows are read a batch at a time.
    const states: LedgerState[] = ["new", "changed"];
    return {
      total: await countIdsInStates(kind, states),
      batches: async function* () {
        for await (const ids of iterateIdsInStates(kind, states, PUSH_BATCH_SIZE)) {
          const rows = await findByIds(kind, ids);
          // An id the ledger still lists whose catalog row was deleted straight
          // in the database: nothing to push, but it was counted in `total`.
          const vanished = ids.length - rows.length;
          if (rows.length > 0 || vanished > 0) yield { rows: [...rows], vanished };
        }
      },
    };
  }

  // `scope: "all"`: the whole catalog, retired rows included, walked by
  // primary key so the query cost does not grow with the offset.
  return {
    total: await countRows(kind),
    batches: async function* () {
      let after: string | null = null;
      for (;;) {
        const rows: CatalogRow[] = await scanRows(kind, { after, take: PUSH_BATCH_SIZE });
        if (rows.length === 0) return;
        after = rows[rows.length - 1].id;
        yield { rows, vanished: 0 };
        if (rows.length < PUSH_BATCH_SIZE) return;
      }
    },
  };
}

/**
 * Running totals a push reports after every batch.
 *
 * `processed` counts **the kind's own rows only** — the rows the request
 * named — so it can be read against `total`. Dependency rows written to keep a
 * foreign key (a currency under a country, a parent category) are counted in
 * `created` / `updated` / `unchanged` and in `dependencyRows`, but not in
 * `processed`, which is why `created + updated + unchanged` can exceed it.
 */
interface PushCounters {
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  dependencyRows: number;
}

/** Loaded once per push, and only when the kind needs it. */
interface PushContext {
  categoriesById?: Map<string, CatalogCategory>;
}

/**
 * The work a push job performs: batch, dependencies, one transaction, ledger,
 * progress — repeated until the target is exhausted.
 *
 * Every batch commits on its own. A failure half way therefore leaves the
 * batches that already committed in place, which is what makes an interrupted
 * push safe to run again: the rows it managed are `synced` and the rest are
 * still pending.
 */
export function pushWork(
  kind: ConstantKind,
  target: PushTarget,
  options: { actorUserId: string | null; request: PushInput },
): JobWork {
  return async (progress, jobId) => {
    const counters: PushCounters = {
      processed: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      dependencyRows: 0,
    };
    const context: PushContext = {};
    await progress({ total: target.total, ...counters });

    let failure: unknown = null;
    try {
      for await (const batch of target.batches()) {
        await pushBatch(kind, batch.rows, counters, context);
        // Rows the batch expected and could not find are done as far as this
        // push is concerned, so `processed` still reaches `total`.
        counters.processed += batch.vanished;
        await progress({ ...counters });
      }
    } catch (error) {
      failure = error;
    }

    // One audit row per job, whatever the outcome: a push that failed on its
    // fifth batch still wrote four, and the trail has to say so.
    await recordPushAudit(options.actorUserId, kind, jobId, counters, options.request, failure);
    if (failure) throw failure;
  };
}

/**
 * Pushes one batch: dependencies first, then the rows, in a single
 * transaction on the main database; then the ledger and the counters.
 */
async function pushBatch(
  kind: ConstantKind,
  rows: readonly CatalogRow[],
  counters: PushCounters,
  context: PushContext,
): Promise<void> {
  if (rows.length === 0) return;
  let ordered: readonly CatalogRow[] = rows;
  const dependencyGroups: { kind: ConstantKind; rows: CatalogRow[] }[] = [];

  if (kind === "countries") {
    const needed = [
      ...new Set(
        (rows as CatalogCountry[]).map((row) => row.currencyId).filter((id): id is string => id !== null),
      ),
    ];
    if (needed.length > 0) {
      const currencies = await findByIds("currencies", needed);
      if (currencies.length > 0) dependencyGroups.push({ kind: "currencies", rows: currencies });
    }
  }

  if (kind === "account_types") {
    const needed = [
      ...new Set(
        (rows as CatalogAccountType[])
          .map((row) => row.baseTypeId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (needed.length > 0) {
      const baseTypes = await findByIds("account_base_types", needed);
      if (baseTypes.length > 0) dependencyGroups.push({ kind: "account_base_types", rows: baseTypes });
    }
  }

  if (kind === "categories") {
    // The category tree is small (hundreds of rows) and every batch needs the
    // whole thing to find ancestors, so it is read once per push.
    context.categoriesById ??= new Map(
      (await listConstants("categories")).map((row) => [row.id, row] as const),
    );
    const byId = context.categoriesById;
    const chosen = rows as CatalogCategory[];
    const ancestors = ancestorsOf(chosen, byId);
    if (ancestors.length > 0) dependencyGroups.push({ kind: "categories", rows: ancestors });
    const parentOf = new Map([...byId.values()].map((row) => [row.id, row.parentId] as const));
    ordered = [...chosen].sort(byDepth(parentOf));
  }

  // A dependency that is already synced is present in the main database, so
  // the foreign key holds without touching it.
  const pendingGroups: { kind: ConstantKind; rows: CatalogRow[] }[] = [];
  for (const group of dependencyGroups) {
    const states = await compareStates(group.kind, group.rows);
    const stale = group.rows.filter((row) => states.get(row.id) !== "synced");
    if (stale.length > 0) pendingGroups.push({ kind: group.kind, rows: stale });
  }

  // Follows the transaction so a rejected write can name the row it failed on.
  const cursor: WriteCursor = { kind, id: null };
  let written: {
    results: PushResultRow[];
    dependencies: { kind: ConstantKind; results: PushResultRow[] }[];
  };
  try {
    written = await prisma.$transaction(
      async (tx) => {
        const dependencyResults: { kind: ConstantKind; results: PushResultRow[] }[] = [];
        for (const group of pendingGroups) {
          dependencyResults.push({
            kind: group.kind,
            results: await writeGroup(tx, group.kind, group.rows, cursor),
          });
        }
        return {
          results: await writeGroup(tx, kind, ordered, cursor),
          dependencies: dependencyResults,
        };
      },
      { timeout: PUSH_TIMEOUT_MS, maxWait: PUSH_MAX_WAIT_MS },
    );
  } catch (error) {
    throw mainWriteError(error, cursor);
  }

  // Committed: both copies now hold exactly the pushed fields, so every row
  // this batch touched — the kind's own and the dependencies' — is synced.
  await upsertStates(
    kind,
    written.results.map((row) => ({ id: row.id, state: "synced" as const })),
  );
  for (const group of written.dependencies) {
    await upsertStates(
      group.kind,
      group.results.map((row) => ({ id: row.id, state: "synced" as const })),
    );
  }

  const every = [...written.dependencies.flatMap((group) => group.results), ...written.results];
  const count = (outcome: PushOutcome) => every.filter((row) => row.outcome === outcome).length;
  counters.processed += written.results.length;
  counters.created += count("created");
  counters.updated += count("updated");
  counters.unchanged += count("unchanged");
  counters.dependencyRows += written.dependencies.reduce(
    (sum, group) => sum + group.results.length,
    0,
  );
}

/**
 * One audit row per push job.
 *
 * Best effort on purpose: `target_type = 'catalog'` is only allowed once
 * `docs/sql/004_constants.sql` has run, and a database that has not been
 * updated yet must not turn a completed push into a 500.
 */
async function recordPushAudit(
  actorUserId: string | null,
  kind: ConstantKind,
  jobId: string,
  counters: PushCounters,
  request: PushInput,
  failure: unknown,
): Promise<void> {
  try {
    await prismaAdmin.admin_permission_audit_events.create({
      data: {
        actor_user_id: actorUserId,
        action: "constants_push",
        target_type: "catalog",
        target_id: null,
        metadata: {
          // `target_label` is lifted out of the metadata into
          // `AuditEvent.targetLabel` by the admin-access repository; the rest
          // is rendered as chips, so every value is a scalar or a short string.
          target_label: CONSTANT_KIND_LABELS[kind].plural,
          kind,
          job_id: jobId,
          scope: request.ids === undefined ? (request.scope ?? "all") : `${request.ids.length} selected`,
          processed: counters.processed,
          created: counters.created,
          updated: counters.updated,
          unchanged: counters.unchanged,
          dependency_rows: counters.dependencyRows,
          ...(failure === null ? {} : { failed: true }),
        } as AdminPrisma.InputJsonObject,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n").filter(Boolean).at(-1) : String(error);
    console.warn(`[constants] audit skipped: ${reason}`);
  }
}
