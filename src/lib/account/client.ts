/**
 * The browser's typed calls to `/api/v1/admin/me/*` — the signed-in operator's
 * own password, second factors and passkeys.
 *
 * Client-safe: no `server-only` imports, only `apiFetch` and the plain types
 * from `./types`. Every call acts on the caller's own Cognito account; there is
 * no user id to pass, because the access token names the subject.
 */
import { apiFetch } from "@/lib/api/client";
import type {
  MfaStatus,
  Passkey,
  PasskeyCreationOptions,
  PasskeyRegistrationStart,
  TotpEnrolment,
} from "./types";

const BASE = "/api/v1/admin/me";

export const accountApi = {
  /** Replaces the caller's password. Cognito checks the current one. */
  changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<void> {
    return apiFetch<void>(`${BASE}/password`, { method: "POST", json: input });
  },

  mfa: {
    /** Which second factors are switched on right now. */
    status(): Promise<MfaStatus> {
      return apiFetch<MfaStatus>(`${BASE}/mfa`);
    },

    /** Mints a shared secret. Shown once; nothing stores it. */
    startTotp(): Promise<TotpEnrolment> {
      return apiFetch<TotpEnrolment>(`${BASE}/mfa/totp`, { method: "POST" });
    },

    /** Verifies one code and switches the factor on. */
    verifyTotp(input: { code: string; deviceName?: string }): Promise<MfaStatus> {
      return apiFetch<MfaStatus>(`${BASE}/mfa/totp`, {
        method: "PUT",
        json: input,
      });
    },

    /** Switches the authenticator app off. */
    disableTotp(): Promise<MfaStatus> {
      return apiFetch<MfaStatus>(`${BASE}/mfa/totp`, { method: "DELETE" });
    },
  },

  passkeys: {
    list(): Promise<Passkey[]> {
      return apiFetch<Passkey[]>(`${BASE}/passkeys`);
    },

    /** Cognito's `CredentialCreationOptions` for the browser ceremony. */
    start(): Promise<PasskeyCreationOptions> {
      return apiFetch<PasskeyRegistrationStart>(`${BASE}/passkeys`, {
        method: "POST",
      }).then((response) => response.options);
    },

    /** Posts the browser's `RegistrationResponseJSON` back to Cognito. */
    complete(credential: unknown): Promise<void> {
      return apiFetch<void>(`${BASE}/passkeys`, {
        method: "PUT",
        json: { credential },
      });
    },

    remove(id: string): Promise<void> {
      // The id is Cognito's base64url credential id, so it must be escaped
      // before it becomes a path segment.
      return apiFetch<void>(`${BASE}/passkeys/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    },
  },
};

/**
 * The per-field messages a 422 carries, keyed by form field name.
 *
 * The API's validation envelope is `details: { formErrors, fieldErrors }`
 * (see `src/lib/api/validate.ts`), and the account service uses the same shape
 * to put a message under one input — "That password isn't right." belongs on
 * the current-password box, not in a banner. Anything else returns `{}` and
 * the caller falls back to the plain message.
 */
export function fieldErrorsFrom(error: unknown): Record<string, string> {
  const details = (error as { details?: unknown } | null)?.details;
  if (typeof details !== "object" || details === null) return {};
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (typeof fieldErrors !== "object" || fieldErrors === null) return {};

  const messages: Record<string, string> = {};
  for (const [field, value] of Object.entries(
    fieldErrors as Record<string, unknown>,
  )) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string" && first !== "") {
      messages[field] = first;
    }
  }
  return messages;
}
