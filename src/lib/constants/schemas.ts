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
  COUNTRY_FILTER_MAX,
  LIST_PAGE_SIZE_DEFAULT,
  LIST_PAGE_SIZE_MAX,
  PUSH_IDS_MAX,
  PUSH_STATES,
  type ConstantInputOf,
  type ConstantKind,
  type ConstantPatchOf,
  type ListQuery,
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

/** A market-data code: trimmed, uppercased, 1..max characters. */
const upperCode = (max: number) => z.string().trim().toUpperCase().min(1).max(max);

/**
 * Free text a market-data feed may legitimately leave blank. Trimmed, never
 * null (the columns are `NOT NULL` on both databases), and absent means `""`
 * rather than a 422 — the feed ships placeholders such as
 * `request_access_via_add_ons` and blanks in the same columns, and the case of
 * those values is meaningful, so nothing here is uppercased.
 */
const feedText = (max: number) => z.string().trim().max(max).default("");

/** ISO 10383 MIC: exactly four alphanumerics, stored uppercase. */
const micCode4 = z
  .string()
  .trim()
  .toUpperCase()
  .length(4, "Use exactly 4 characters.")
  .regex(/^[A-Z0-9]+$/, "Letters and digits only.");

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

export const createAccountBaseTypeSchema = z.object({
  name: name(80),
});

export const createAccountTypeSchema = z.object({
  // The machine name the consumer app matches on; the display name is what a
  // person reads. Both are required, and the three flags say nothing useful
  // when they are guessed, so a create has to state them.
  name: name(80),
  displayName: name(120),
  isAsset: z.boolean(),
  isBanking: z.boolean(),
  isInvestment: z.boolean(),
  baseTypeId: idString.nullable().default(null),
});

export const createCryptocurrencySchema = z.object({
  symbol: upperCode(32),
  // The feed sends a comma-separated list of exchange names; it can be long
  // and it can be empty, and it is not a code, so it keeps its own spelling.
  availableExchanges: feedText(2000),
  currencyBase: upperCode(16),
  currencyQuote: upperCode(16),
});

/** ETFs and stocks share every column but `type`. */
const listedInstrumentShape = {
  symbol: upperCode(32),
  name: name(200),
  currency: upperCode(8),
  // Exchange names are read by people ("NASDAQ", "NYSE American"), so they are
  // not uppercased; the MIC next to them is the machine-readable form.
  exchange: name(64),
  micCode: upperCode(8),
  country: name(80),
  figiCode: feedText(64),
  cfiCode: feedText(64),
  isin: feedText(64),
  cusip: feedText(64),
};

export const createEtfSchema = z.object(listedInstrumentShape);

export const createStockSchema = z.object({
  ...listedInstrumentShape,
  // Free text from the feed: "Common Stock", "Depositary Receipt", "etf".
  type: name(64),
});

export const createMarketSchema = z.object({
  micCode: micCode4,
  operatingMic: micCode4,
  marketName: name(160),
  isoCountryCode: alphaCode(2),
  city: name(80),
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

export const patchAccountBaseTypeSchema = z
  .object({
    name: name(80).optional(),
  })
  .refine(atLeastOneKey, notEmpty);

export const patchAccountTypeSchema = z
  .object({
    name: name(80).optional(),
    displayName: name(120).optional(),
    isAsset: z.boolean().optional(),
    isBanking: z.boolean().optional(),
    isInvestment: z.boolean().optional(),
    baseTypeId: idString.nullable().optional(),
  })
  .refine(atLeastOneKey, notEmpty);

export const patchCryptocurrencySchema = z
  .object({
    symbol: upperCode(32).optional(),
    availableExchanges: z.string().trim().max(2000).optional(),
    currencyBase: upperCode(16).optional(),
    currencyQuote: upperCode(16).optional(),
  })
  .refine(atLeastOneKey, notEmpty);

/** The optional form of `listedInstrumentShape`; a patch never defaults a field. */
const listedInstrumentPatchShape = {
  symbol: upperCode(32).optional(),
  name: name(200).optional(),
  currency: upperCode(8).optional(),
  exchange: name(64).optional(),
  micCode: upperCode(8).optional(),
  country: name(80).optional(),
  figiCode: z.string().trim().max(64).optional(),
  cfiCode: z.string().trim().max(64).optional(),
  isin: z.string().trim().max(64).optional(),
  cusip: z.string().trim().max(64).optional(),
};

export const patchEtfSchema = z.object(listedInstrumentPatchShape).refine(atLeastOneKey, notEmpty);

export const patchStockSchema = z
  .object({ ...listedInstrumentPatchShape, type: name(64).optional() })
  .refine(atLeastOneKey, notEmpty);

export const patchMarketSchema = z
  .object({
    micCode: micCode4.optional(),
    operatingMic: micCode4.optional(),
    marketName: name(160).optional(),
    isoCountryCode: alphaCode(2).optional(),
    city: name(80).optional(),
  })
  .refine(atLeastOneKey, notEmpty);

/* -------------------------------------------------------------------------- */
/*                                    Push                                    */
/* -------------------------------------------------------------------------- */

/**
 * `POST .../push` body: **exactly one** of `ids` or `scope`.
 *
 * `{ ids: [...] }` pushes those rows, whatever state they are in; an empty
 * array is refused, because "nothing selected" must never turn into
 * "everything" — that is what `scope` is for. `{ scope: "pending" }` pushes
 * every row the ledger calls new or changed, `{ scope: "all" }` the whole
 * catalog. Both scopes are resolved and processed in batches, so neither has a
 * row limit; an explicit id list does, at `PUSH_IDS_MAX`.
 *
 * The two members are strict objects inside a union, which is what makes
 * "both" and "neither" invalid: a body carrying `ids` **and** `scope` matches
 * neither member and comes back as a 422.
 */
export const pushInputSchema = z.union([
  z.strictObject({
    ids: z
      .array(z.string().trim().min(1).max(64))
      .min(1, "Select at least one row to push.")
      .max(PUSH_IDS_MAX, `A push names at most ${PUSH_IDS_MAX} rows; use a scope instead.`),
  }),
  z.strictObject({ scope: z.enum(["pending", "all"]) }),
]) satisfies z.ZodType<PushInput, unknown>;

/* -------------------------------------------------------------------------- */
/*                                Query strings                               */
/* -------------------------------------------------------------------------- */

/**
 * `GET .../[kind]` query string.
 *
 * Numbers arrive as text and are coerced. `pageSize` is **clamped** rather
 * than refused: a client asking for more rows than the API will serve gets
 * `LIST_PAGE_SIZE_MAX` of them, which is friendlier than a 422 and just as
 * safe, since the limit exists to bound the response, not to police callers.
 */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .default(LIST_PAGE_SIZE_DEFAULT)
    .transform((value) => Math.min(value, LIST_PAGE_SIZE_MAX)),
  q: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => (value === undefined || value === "" ? undefined : value)),
  state: z.enum([...PUSH_STATES, "all", "pending", "retired"]).default("all"),
  // The market filter. Free text rather than an enum: the countries come from
  // the market-data feed and the toolbar only offers the common ones, so a
  // spelling the list does not carry must still be answerable. It is matched
  // exactly against the `country` column, and only for `etfs` and `stocks`.
  country: z
    .string()
    .trim()
    .max(COUNTRY_FILTER_MAX)
    .optional()
    .transform((value) => (value === undefined || value === "" ? undefined : value)),
}) satisfies z.ZodType<ListQuery, unknown>;

/** `GET .../[kind]/jobs?limit=` — how many recent jobs to return. */
export const jobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/* -------------------------------------------------------------------------- */
/*                              Generic lookup                                */
/* -------------------------------------------------------------------------- */

const CREATE_SCHEMAS = {
  countries: createCountrySchema,
  currencies: createCurrencySchema,
  financial_institutions: createFinancialInstitutionSchema,
  categories: createCategorySchema,
  account_base_types: createAccountBaseTypeSchema,
  account_types: createAccountTypeSchema,
  cryptocurrencies: createCryptocurrencySchema,
  etfs: createEtfSchema,
  stocks: createStockSchema,
  markets: createMarketSchema,
} satisfies { [K in ConstantKind]: z.ZodType<ConstantInputOf<K>, unknown> };

const PATCH_SCHEMAS = {
  countries: patchCountrySchema,
  currencies: patchCurrencySchema,
  financial_institutions: patchFinancialInstitutionSchema,
  categories: patchCategorySchema,
  account_base_types: patchAccountBaseTypeSchema,
  account_types: patchAccountTypeSchema,
  cryptocurrencies: patchCryptocurrencySchema,
  etfs: patchEtfSchema,
  stocks: patchStockSchema,
  markets: patchMarketSchema,
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
