import "server-only";
/**
 * The four reference catalogs as they live in the **admin** database
 * (`ADMIN_DATABASE_URL`, through `prismaAdmin`): countries, currencies,
 * financial institutions and the default category tree.
 *
 * This is the source of truth. Nothing here touches the main app database —
 * carrying a change across is `./push.ts`.
 *
 * Every business rule is enforced here rather than in a route, so it holds
 * whoever calls: code and name uniqueness, referential integrity between
 * countries and currencies, and the shape of the category tree. A violation is
 * thrown as an `ApiError` from `src/lib/api/errors.ts` (409 `conflict`, 422
 * `validation_failed`, 404 `not_found`), which `adminHandler` renders as-is.
 *
 * Rows come back **without** `pushState`: that field describes the main
 * database and is filled in by `./service.ts` after `./push.ts` has compared
 * the two. `CatalogRowOf<K>` is the row type minus that field.
 */
import { Prisma } from "@/generated/prisma-admin/client";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/api/errors";
import { prismaAdmin } from "@/lib/prisma-admin";
import {
  CONSTANT_KIND_LABELS,
  type CategoryInput,
  type CategoryRow,
  type ConstantInputOf,
  type ConstantKind,
  type ConstantPatchOf,
  type CountryInput,
  type CountryRow,
  type CurrencyInput,
  type CurrencyRow,
  type FinancialInstitutionInput,
  type FinancialInstitutionRow,
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

export type CatalogRow =
  | CatalogCountry
  | CatalogCurrency
  | CatalogFinancialInstitution
  | CatalogCategory;

export type CatalogRowOf<K extends ConstantKind> = K extends "countries"
  ? CatalogCountry
  : K extends "currencies"
    ? CatalogCurrency
    : K extends "financial_institutions"
      ? CatalogFinancialInstitution
      : CatalogCategory;

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

/* -------------------------------------------------------------------------- */
/*                                   Read                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every row of one kind, sorted the way the page lists it. Categories include
 * retired ones: the page shows and filters them, and a push carries the
 * retirement across.
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
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Create                                   */
/* -------------------------------------------------------------------------- */

/**
 * The unique indexes from `docs/sql/005_constants_unique_indexes.sql` are the
 * last word on duplicates: when two operators pass the read-then-write checks
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
      }[kind];
      throw new ConflictError(`A ${CONSTANT_KIND_LABELS[kind].singular} with that ${what} already exists.`);
    }
    throw error;
  });
}

/** Adds a row to the admin catalog. The id is generated here, never supplied. */
export async function createConstant<K extends ConstantKind>(
  kind: K,
  input: ConstantInputOf<K>,
): Promise<CatalogRowOf<K>> {
  const row = await withUniqueViolation(kind, () => createRow(kind, input as ConstantInputOf<ConstantKind>));
  return row as CatalogRowOf<K>;
}

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
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Delete                                   */
/* -------------------------------------------------------------------------- */

/**
 * Removes a row from the **admin** catalog. Categories are retired
 * (`deleted_at = now()`), the other three kinds are deleted outright.
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
  }
}
