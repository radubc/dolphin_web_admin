import "server-only";
/**
 * The defaults the consumer app **pulls** from this console when it creates a
 * tenant: the category tree and the financial institutions.
 *
 * Owner decision (2026-09-11): these two catalogs are no longer pushed into the
 * main app database. Instead the consumer app calls
 * `GET /api/v1/service/defaults/categories` and
 * `GET /api/v1/service/defaults/financial-institutions` with an `API_KEYS`
 * credential at tenant creation and copies the rows into its own per-tenant
 * tables. The admin database is therefore the single source of these defaults,
 * and the Constants page is where they are edited — see `PULLED_KINDS` in
 * `./types.ts`. The other eight kinds keep compare and push unchanged.
 *
 * Because a tenant with no categories is unusable, **both readers fail loudly**
 * rather than answering an empty list: a missing admin schema is a 503
 * `admin_schema_missing` and an empty catalog is a 503 `defaults_unavailable`.
 * A 503 makes the consumer abandon (and retry) the tenant creation, which is
 * far cheaper to recover from than a tenant created with zero defaults.
 *
 * Read-only, no ledger, no job: nothing here writes to either database.
 */
import { ServiceUnavailableError } from "@/lib/api/errors";
import { prismaAdmin } from "@/lib/prisma-admin";
import { isMissingTableError } from "@/lib/admin-access/prisma-repository";

/* -------------------------------------------------------------------------- */
/*                                 Wire types                                 */
/* -------------------------------------------------------------------------- */

/**
 * One default category, exactly as the consumer app copies it into its own
 * `categories` table.
 *
 * `type` is passed through **as stored** — the seed spells it `Inflow` /
 * `Outflow` and the column is free text on both databases, so an unexpected
 * spelling travels unchanged rather than being normalised or dropped.
 *
 * `parentId` refers to another id in the same payload. Rows are ordered by
 * `created_at`, which is *not* a topological order: a parent created after its
 * child would come later, and a child whose parent is retired keeps pointing at
 * an id the payload does not contain. The consumer app has to insert the tree
 * in two passes (or with the parent key deferred) rather than assume the array
 * order satisfies its foreign key.
 */
export interface DefaultCategory {
  id: string;
  name: string;
  type: string | null;
  parentId: string | null;
  isDiscretionary: boolean | null;
}

/** One default financial institution, as the consumer app copies it. */
export interface DefaultFinancialInstitution {
  id: string;
  name: string;
  institutionNumber: string;
  type: string;
}

export interface DefaultCategoriesResponse {
  categories: DefaultCategory[];
}

export interface DefaultFinancialInstitutionsResponse {
  financialInstitutions: DefaultFinancialInstitution[];
}

/* -------------------------------------------------------------------------- */
/*                                  Failures                                  */
/* -------------------------------------------------------------------------- */

/**
 * The admin schema is not installed (Prisma `P2021`). Same code the operator
 * endpoints use (`adminHandler` maps it in `src/lib/admin-access/authorize.ts`);
 * `serviceHandler` does no such mapping, so it is raised explicitly here.
 */
function missingSchema(what: string): ServiceUnavailableError {
  console.warn(
    `[constants] default ${what} pull: the admin catalog tables are not installed ` +
      "(run the SQL in docs/sql).",
  );
  return new ServiceUnavailableError(
    "admin_schema_missing",
    "The admin database schema is not installed. Run the SQL in docs/sql.",
  );
}

/** Zero rows. Not a success: the consumer must not create a tenant with no defaults. */
function emptyCatalog(what: string): ServiceUnavailableError {
  console.warn(`[constants] default ${what} pull: the admin catalog is empty.`);
  return new ServiceUnavailableError(
    "defaults_unavailable",
    `The admin catalog has no ${what}; seed it on the Constants page.`,
  );
}

/** Runs a catalog read, turning a missing table into the 503 above. */
async function read<T>(what: string, query: () => Promise<T[]>): Promise<T[]> {
  try {
    return await query();
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    throw missingSchema(what);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Readers                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every live default category, oldest first.
 *
 * Retired rows (`deleted_at IS NOT NULL`) are left out: a retirement means "do
 * not give this to new tenants", and a pull only ever concerns new tenants.
 * The order is `created_at` then `id` so two pulls of an unchanged catalog
 * agree; rows with no `created_at` sort last (Postgres `ASC` = `NULLS LAST`)
 * and are then ordered by id.
 */
export async function defaultCategories(): Promise<DefaultCategoriesResponse> {
  const rows = await read("categories", () =>
    prismaAdmin.categories.findMany({
      where: { deleted_at: null },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      select: { id: true, name: true, type: true, parent_id: true, is_discretionary: true },
    }),
  );
  if (rows.length === 0) throw emptyCatalog("categories");
  return {
    categories: rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      parentId: row.parent_id,
      isDiscretionary: row.is_discretionary,
    })),
  };
}

/**
 * Every default financial institution, by name.
 *
 * The table has no `deleted_at`: institutions are removed outright in the admin
 * catalog, so everything present is current.
 */
export async function defaultFinancialInstitutions(): Promise<DefaultFinancialInstitutionsResponse> {
  const rows = await read("financial institutions", () =>
    prismaAdmin.financial_institutions.findMany({
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, institution_number: true, type: true },
    }),
  );
  if (rows.length === 0) throw emptyCatalog("financial institutions");
  return {
    financialInstitutions: rows.map((row) => ({
      id: row.id,
      name: row.name,
      institutionNumber: row.institution_number,
      type: row.type,
    })),
  };
}
