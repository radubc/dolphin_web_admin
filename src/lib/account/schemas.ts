/**
 * Body schemas for the "Account & security" routes.
 *
 * Shape and size only: Cognito owns the password policy, decides whether a
 * one-time code is right and validates the WebAuthn attestation. These exist
 * so a malformed or oversized payload is refused with a 422 before anything
 * reaches AWS.
 *
 * Plain zod, no server imports: safe to import from anywhere.
 */
import { z } from "zod";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth/validation";

/** A password as it may travel: never trimmed — spaces can be part of it. */
const password = z
  .string()
  .min(1, "Enter your password.")
  .max(MAX_PASSWORD_LENGTH, "That password is too long.");

/** `POST /api/v1/admin/me/password`. */
export const changePasswordSchema = z.object({
  currentPassword: password,
  newPassword: password.refine(
    (value) => value.length >= MIN_PASSWORD_LENGTH,
    `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  ),
});

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * `PUT /api/v1/admin/me/mfa/totp` — the six digits from the authenticator app.
 * Spaces and a dash are stripped first because that is how apps display them.
 */
export const verifyTotpSchema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/[\s-]/g, ""))
    .pipe(z.string().regex(/^\d{6}$/, "Enter the six digits from your app.")),
  /**
   * `FriendlyDeviceName` on the Cognito side: which app or device this TOTP
   * secret lives in. Optional; Cognito accepts the enrolment without it.
   */
  deviceName: z.string().trim().max(120).optional(),
});

export type VerifyTotpInput = z.infer<typeof verifyTotpSchema>;

/**
 * `PUT /api/v1/admin/me/passkeys` — the browser's `RegistrationResponseJSON`.
 *
 * Passed to Cognito verbatim, so it is validated only as *JSON of a sane
 * size*: WebAuthn's own shape is the relying party's business, and Cognito is
 * the relying party. `z.json()` guarantees the value contains nothing but JSON
 * primitives, which is what the SDK's document type accepts.
 */
export const completePasskeySchema = z.object({
  credential: z.json(),
});

export type CompletePasskeyInput = z.infer<typeof completePasskeySchema>;
