/**
 * Catalog ids at the database boundary.
 *
 * Every catalog carries `id` as a **string** on the wire (see `./types.ts`),
 * but three kinds — `cryptocurrencies`, `etfs`, `stocks` — are keyed by a
 * Postgres integer sequence rather than a UUID. This module is the single
 * place that converts between the two, so a route parameter, a push id list
 * and a `WHERE id IN (…)` all agree on what a valid id is.
 *
 * A malformed id is a 404, not a 422: from the caller's side the row simply
 * does not exist, and the message must not leak whether the id shape was the
 * problem. Nothing here ever lets `NaN` reach a query.
 *
 * Plain data, no Prisma: safe to import from anywhere on the server.
 */
import { NotFoundError } from "@/lib/api/errors";
import { CONSTANT_KIND_LABELS, type ConstantKind } from "./types";

/**
 * A serialised sequence id: digits only, no sign, no leading zero, no
 * whitespace. `Number.isSafeInteger` then rules out anything past 2^53 that
 * would round on the way in.
 */
const INTEGER_ID = /^[1-9][0-9]*$/;

/** True when `value` is the string form of a positive, safe integer. */
export function isIntegerIdString(value: string): boolean {
  return INTEGER_ID.test(value) && Number.isSafeInteger(Number(value));
}

/**
 * The integer key behind a wire id, for one of `INTEGER_ID_KINDS`.
 *
 * @throws {NotFoundError} the id is not a positive integer. Callers use this
 * for the `[id]` route segment and for push id lists, so a hand-typed URL
 * ends as a clean 404 instead of a Prisma error on `NaN`.
 */
export function parseIntegerId(kind: ConstantKind, id: string): number {
  if (!isIntegerIdString(id)) {
    throw new NotFoundError(`No ${CONSTANT_KIND_LABELS[kind].singular} with id ${id} in the admin catalog.`);
  }
  return Number(id);
}

/**
 * The integer keys behind a list of wire ids, for an `IN (…)` filter.
 *
 * Lenient on purpose: an id that is not an integer cannot exist in an
 * integer-keyed table, so dropping it asks the same question with one fewer
 * value rather than failing the whole read. The strict verdict belongs to
 * `parseIntegerId` at the request boundary.
 */
export function toIntegerIds(ids: readonly string[]): number[] {
  return ids.filter(isIntegerIdString).map(Number);
}
