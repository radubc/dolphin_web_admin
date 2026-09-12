/**
 * Query and body schemas for the Customers routes.
 *
 * Shape, size and normalisation only. Whether an email already has an account,
 * whether an invitation may still be resent and whether the pool will accept
 * the address are decided in `./invites.ts` and by Cognito itself, so a caller
 * that bypasses these still cannot break an invariant.
 *
 * Emails are trimmed and lowercased here, so the lowercase spelling is the
 * only one that reaches the database, the duplicate check and the pool.
 *
 * Plain zod, no server imports: safe to import from anywhere.
 */
import { z } from "zod";
import {
  CUSTOMER_PAGE_SIZE_DEFAULT,
  CUSTOMER_PAGE_SIZE_MAX,
  STATISTICS_DAYS_DEFAULT,
  STATISTICS_DAYS_MAX,
  STATISTICS_MONTHS_DEFAULT,
  STATISTICS_MONTHS_MAX,
  type CreateInviteInput,
} from "./types";

/** RFC 5321 caps a whole address at 254 characters. */
const emailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "That address is too long.")
  .pipe(z.email("Enter a valid email address."));

/** A BCP 47 language tag such as `en-CA`: 2-3 letter language, then subtags. */
const BCP47 = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** `en-ca` → `en-CA`; only the first subtag after the language is upper-cased. */
function normaliseLocale(value: string): string {
  const [language, ...subtags] = value.split("-");
  return [language.toLowerCase(), ...subtags.map((subtag) => subtag.toUpperCase())].join("-");
}

/* -------------------------------------------------------------------------- */
/*                                  Customers                                 */
/* -------------------------------------------------------------------------- */

/** `GET /api/v1/admin/customers?page=&pageSize=&q=&status=&includeDeleted=`. */
export const customerListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(CUSTOMER_PAGE_SIZE_MAX)
    .default(CUSTOMER_PAGE_SIZE_DEFAULT),
  q: z.string().trim().max(120).optional(),
  status: z
    .enum(["all", "active", "invited", "disabled", "deleted", "no_account", "unknown"])
    .default("all"),
  /** `?includeDeleted=true`; anything false-ish keeps soft-deleted rows out. */
  includeDeleted: z.stringbool().default(false),
});

/** The list query with every default filled in, which is what the service takes. */
export type ResolvedCustomerListQuery = z.infer<typeof customerListQuerySchema>;

/* -------------------------------------------------------------------------- */
/*                                   Invites                                  */
/* -------------------------------------------------------------------------- */

/** `GET /api/v1/admin/customers/invites?page=&pageSize=&q=&status=`. */
export const inviteListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(CUSTOMER_PAGE_SIZE_MAX)
    .default(CUSTOMER_PAGE_SIZE_DEFAULT),
  q: z.string().trim().max(120).optional(),
  status: z.enum(["all", "invited", "accepted", "revoked", "failed"]).default("all"),
});

export type ResolvedInviteListQuery = z.infer<typeof inviteListQuerySchema>;

/**
 * `POST /api/v1/admin/customers/invites`.
 *
 * The note is the operator's own record ("beta tester", "friend of X"); an
 * empty or blank note is stored as NULL rather than as an empty string.
 *
 * `name` and `locale` are sent on to Cognito as the `name` / `locale`
 * attributes, which the customer pool requires; either left blank is asked
 * for at first sign-in instead.
 */
export const createInviteSchema: z.ZodType<CreateInviteInput> = z.object({
  email: emailAddress,
  note: z
    .string()
    .trim()
    .max(500, "Keep the note under 500 characters.")
    .nullish()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value)),
  name: z
    .string()
    .trim()
    .max(256, "Keep the name under 256 characters.")
    .nullish()
    .transform((value) => (value === undefined || value === null || value === "" ? null : value)),
  locale: z
    .string()
    .trim()
    .nullish()
    .transform((value, ctx) => {
      if (value === undefined || value === null || value === "") return null;
      if (!BCP47.test(value)) {
        ctx.addIssue({ code: "custom", message: "Enter a BCP 47 locale tag, such as en-CA." });
        return z.NEVER;
      }
      return normaliseLocale(value);
    }),
});

/* -------------------------------------------------------------------------- */
/*                                 Statistics                                 */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/v1/admin/customers/statistics?months=6&days=35`.
 *
 * Both are capped for the same reason the cost series is: `months` decides
 * how many churn denominators are counted (one query each) and `days` how
 * wide a date range the two daily aggregates scan. A caller asking for ten
 * years would be asking for rows nothing ever wrote.
 */
export const customerStatisticsQuerySchema = z.object({
  months: z.coerce
    .number()
    .int()
    .min(1)
    .max(STATISTICS_MONTHS_MAX)
    .default(STATISTICS_MONTHS_DEFAULT),
  days: z.coerce.number().int().min(1).max(STATISTICS_DAYS_MAX).default(STATISTICS_DAYS_DEFAULT),
});

export type ResolvedCustomerStatisticsQuery = z.infer<typeof customerStatisticsQuerySchema>;
