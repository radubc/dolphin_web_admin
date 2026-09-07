/**
 * The Constants model, as the API and the UI see it: the four reference
 * catalogs the admin database masters (countries, currencies, financial
 * institutions, default categories) and their push state against the main
 * app database.
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

export const CONSTANT_KINDS = ["countries", "currencies", "financial_institutions", "categories"] as const;

export type ConstantKind = (typeof CONSTANT_KINDS)[number];

export function isConstantKind(value: string): value is ConstantKind {
  return (CONSTANT_KINDS as readonly string[]).includes(value);
}

export const CONSTANT_KIND_LABELS: Record<ConstantKind, { singular: string; plural: string }> = {
  countries: { singular: "country", plural: "countries" },
  currencies: { singular: "currency", plural: "currencies" },
  financial_institutions: { singular: "financial institution", plural: "financial institutions" },
  categories: { singular: "category", plural: "categories" },
};

/* -------------------------------------------------------------------------- */
/*                                    Rows                                    */
/* -------------------------------------------------------------------------- */

/**
 * How an admin row relates to the main database:
 * - `new`: no row with this id in the main database yet;
 * - `changed`: the main row exists but at least one pushed field differs;
 * - `synced`: identical.
 */
export type PushState = "new" | "changed" | "synced";

interface ConstantRowBase {
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

export type ConstantRowOf<K extends ConstantKind> = K extends "countries"
  ? CountryRow
  : K extends "currencies"
    ? CurrencyRow
    : K extends "financial_institutions"
      ? FinancialInstitutionRow
      : CategoryRow;

export type ConstantRow = CountryRow | CurrencyRow | FinancialInstitutionRow | CategoryRow;

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

export type ConstantInputOf<K extends ConstantKind> = K extends "countries"
  ? CountryInput
  : K extends "currencies"
    ? CurrencyInput
    : K extends "financial_institutions"
      ? FinancialInstitutionInput
      : CategoryInput;

/** PATCH bodies are partial; every field is optional but at least one must be present. */
export type ConstantPatchOf<K extends ConstantKind> = Partial<ConstantInputOf<K>>;

/* -------------------------------------------------------------------------- */
/*                                 Responses                                  */
/* -------------------------------------------------------------------------- */

export interface ConstantListResponse<K extends ConstantKind> {
  kind: K;
  rows: ConstantRowOf<K>[];
  /** Ids present in the main database that the admin catalog no longer has. */
  mainOnlyIds: string[];
  /** When the main database was last compared; ISO string. */
  comparedAt: string;
}

export type PushOutcome = "created" | "updated" | "unchanged";

export interface PushResultRow {
  id: string;
  outcome: PushOutcome;
}

export interface PushResponse {
  kind: ConstantKind;
  /** Every row written, in the order it was written (dependencies first). */
  results: PushResultRow[];
  /**
   * Rows of *other* kinds that had to be pushed first so foreign keys hold:
   * a country's currency, a category's ancestors.
   */
  dependencies: { kind: ConstantKind; results: PushResultRow[] }[];
  created: number;
  updated: number;
  unchanged: number;
  pushedAt: string;
}

export interface PushInput {
  /**
   * Omit to push every row of the kind (categories include retired ones).
   * An empty array is refused with 422: "nothing selected" must never turn
   * into "everything".
   */
  ids?: string[];
}
