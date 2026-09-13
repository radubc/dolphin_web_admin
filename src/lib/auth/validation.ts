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
 * Cognito's own floor for a user pool password policy: no pool can accept
 * anything shorter, so rejecting it here saves a round trip. Only a floor —
 * the pool's real policy (length, character classes) is Cognito's to enforce,
 * and its message is the one the person is shown.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * A one-time code from an authenticator app: always six digits. Shared by the
 * sign-in MFA step and the enrolment form so the two cannot disagree.
 */
export const TOTP_CODE_PATTERN = /^\d{6}$/;

/**
 * Ceiling on the WebAuthn `AuthenticationResponseJSON` a passkey sign-in posts
 * back. A real assertion is well under a kilobyte — signature, authenticator
 * data and client data, all base64url — so 8 KB is generous and still caps what
 * an unauthenticated caller can make this server forward to Cognito. Size only:
 * the contents are Cognito's to verify, since it is the relying party.
 */
export const MAX_PASSKEY_CREDENTIAL_LENGTH = 8192;

/**
 * Narrows a `FormData` entry to a string. A `File` (or a missing field) is
 * treated as an empty value, which the callers then reject as required.
 */
export function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}
