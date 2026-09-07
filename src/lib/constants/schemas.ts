/**
 * Request-body schemas for the Constants routes.
 *
 * Shape, size and normalisation only — uniqueness, referential integrity and
 * the category tree rules belong to `./repository.ts`, so a caller that
 * bypasses these still cannot break an invariant.
 *
 * Normalisation happens here on purpose: alpha codes and currency codes are
 * uppercased, text is trimmed, and an empty optional string becomes `null`, so
 * the repository and the comparison against the main database always see the
 * canonical spelling.
 *
 * Plain zod, no server imports: safe to import from anywhere.
 */
import { z } from "zod";
import {
  CATEGORY_TYPES,
  type ConstantInputOf,
  type ConstantKind,
  type ConstantPatchOf,
  type PushInput,
} from "./types";

/* -------------------------------------------------------------------------- */
/*                                   Fields                                   */
/* -------------------------------------------------------------------------- */

/** An id as the catalogs spell it: a UUID string. Kept loose (`min(1)`) for foreign keys. */
const idString = z.string().trim().min(1).max(64);

const name = (max: number) => z.string().trim().min(1).max(max);

/** ISO 3166-1 alpha-2 / alpha-3: exactly N letters, stored uppercase. */
const alphaCode = (length: number) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .length(length, `Use exactly ${length} letters.`)
    .regex(/^[A-Z]+$/, "Letters only.");

/** ISO 4217 currency code: three letters, stored uppercase. */
const currencyCode = alphaCode(3);

/** Optional short text: trimmed, and an empty string is stored as `null`. */
const optionalShortText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === null || value === "" ? null : value));

/** Institution numbers are digit strings ("001", "0815"); leading zeros matter. */
const institutionNumber = z
  .string()
  .trim()
  .min(1)
  .max(10)
  .regex(/^[0-9]+$/, "Digits only.");

const categoryType = z.enum(CATEGORY_TYPES).nullable();

/* -------------------------------------------------------------------------- */
/*                                   Create                                   */
/* -------------------------------------------------------------------------- */

export const createCountrySchema = z.object({
  name: name(120),
  alpha2Code: alphaCode(2),
  alpha3Code: alphaCode(3),
  currencyId: idString.nullable().default(null),
});

export const createCurrencySchema = z.object({
  code: currencyCode,
  name: name(120),
  symbol: optionalShortText(8).default(null),
});

export const createFinancialInstitutionSchema = z.object({
  name: name(160),
  institutionNumber,
  // Free text: the seed uses "bank" and "credit union", but the column is not
  // an enum and operators may add their own wording. Keep it as typed.
  type: z.string().trim().min(1).max(40),
});

export const createCategorySchema = z.object({
  name: name(120),
  type: categoryType.default(null),
  parentId: idString.nullable().default(null),
  isDiscretionary: z.boolean().nullable().default(null),
});

/* -------------------------------------------------------------------------- */
/*                                    Patch                                   */
/* -------------------------------------------------------------------------- */

/** Every PATCH body is partial, and an empty one is a mistake worth reporting. */
const notEmpty = { message: "Nothing to update." } as const;
const atLeastOneKey = (value: object) => Object.keys(value).length > 0;

export const patchCountrySchema = z
  .object({
    name: name(120).optional(),
    alpha2Code: alphaCode(2).optional(),
    alpha3Code: alphaCode(3).optional(),
    currencyId: idString.nullable().optional(),
  })
  .refine(atLeastOneKey, notEmpty);

export const patchCurrencySchema = z
  .object({
    code: currencyCode.optional(),
    name: name(120).optional(),
    symbol: optionalShortText(8).optional(),
  })
  .refine(atLeastOneKey, notEmpty);

export const patchFinancialInstitutionSchema = z
  .object({
    name: name(160).optional(),
    institutionNumber: institutionNumber.optional(),
    type: z.string().trim().min(1).max(40).optional(),
  })
  .refine(atLeastOneKey, notEmpty);

export const patchCategorySchema = z
  .object({
    name: name(120).optional(),
    type: categoryType.optional(),
    parentId: idString.nullable().optional(),
    isDiscretionary: z.boolean().nullable().optional(),
  })
  .refine(atLeastOneKey, notEmpty);

/* -------------------------------------------------------------------------- */
/*                                    Push                                    */
/* -------------------------------------------------------------------------- */

/**
 * The largest number of rows one push may write, dependencies included.
 *
 * The push runs as one interactive transaction on the main database with a
 * 60 s budget (`PUSH_TIMEOUT_MS` in `./push.ts`); creates go out in one
 * `createMany` per group but every update is its own round trip, so the cap is
 * set where a worst case of updates still fits comfortably.
 */
export const MAX_PUSH_ROWS = 2000;

/**
 * `POST .../push` body. Omit `ids` to push every row of the kind; an empty
 * array is refused, because "nothing selected" must never turn into
 * "everything". The cap matches the per-transaction limit in `./push.ts`.
 */
export const pushInputSchema = z.object({
  ids: z
    .array(z.string().trim().min(1).max(64))
    .min(1, "Select at least one row to push.")
    .max(MAX_PUSH_ROWS)
    .optional(),
}) satisfies z.ZodType<PushInput, unknown>;

/* -------------------------------------------------------------------------- */
/*                              Generic lookup                                */
/* -------------------------------------------------------------------------- */

const CREATE_SCHEMAS = {
  countries: createCountrySchema,
  currencies: createCurrencySchema,
  financial_institutions: createFinancialInstitutionSchema,
  categories: createCategorySchema,
} satisfies { [K in ConstantKind]: z.ZodType<ConstantInputOf<K>, unknown> };

const PATCH_SCHEMAS = {
  countries: patchCountrySchema,
  currencies: patchCurrencySchema,
  financial_institutions: patchFinancialInstitutionSchema,
  categories: patchCategorySchema,
} satisfies { [K in ConstantKind]: z.ZodType<ConstantPatchOf<K>, unknown> };

/** The POST schema for one kind, so a route can stay generic over `[kind]`. */
export function createSchemaFor<K extends ConstantKind>(kind: K): z.ZodType<ConstantInputOf<K>> {
  // The `satisfies` above proves the map is correct per key; TypeScript cannot
  // carry that through an index by a generic `K`.
  return CREATE_SCHEMAS[kind] as unknown as z.ZodType<ConstantInputOf<K>>;
}

/** The PATCH schema for one kind. */
export function patchSchemaFor<K extends ConstantKind>(kind: K): z.ZodType<ConstantPatchOf<K>> {
  return PATCH_SCHEMAS[kind] as unknown as z.ZodType<ConstantPatchOf<K>>;
}
