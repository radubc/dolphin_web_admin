/**
 * Input constraints shared by the auth Server Actions (/login, /forgot-password).
 *
 * These are first-pass sanity checks at the server boundary, not a substitute
 * for Cognito's own validation: they exist to reject obvious junk and to cap
 * the size of anything we forward to AWS.
 *
 * Kept in a plain module (no `"use server"`) so both actions can import the
 * constants: a `"use server"` file may only export async functions.
 */

/** Deliberately permissive: Cognito is the real authority on the address. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** RFC 5321 maximum length of a forward path. */
export const MAX_EMAIL_LENGTH = 320;

/** Cognito's own maximum password length; longer input cannot be valid. */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Narrows a `FormData` entry to a string. A `File` (or a missing field) is
 * treated as an empty value, which the callers then reject as required.
 */
export function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}
