/**
 * The wire model of "Account & security": what the drawer reads and writes
 * about the *signed-in operator's own* Cognito account.
 *
 * Client-safe on purpose — the browser imports these types straight from here,
 * so the drawer and the Route Handlers cannot drift. Nothing in this file
 * touches AWS or the database; `./service.ts` is the server half.
 *
 * Nothing here is stored in either database. Passwords, authenticator apps and
 * passkeys all live in the admin Cognito user pool, and every read is a live
 * call made with the operator's own access token.
 */

/** What Cognito reports about this operator's second factors. */
export interface MfaStatus {
  /** True when a verified authenticator app is switched on for the account. */
  totpEnabled: boolean;
  /** Cognito's `PreferredMfaSetting`, or null when nothing is preferred. */
  preferred: string | null;
  /**
   * Every factor Cognito lists as active: `SOFTWARE_TOKEN_MFA`, `SMS_MFA`,
   * `EMAIL_OTP`. Shown as-is so a factor this console cannot manage is still
   * visible rather than silently missing.
   */
  methods: string[];
}

/**
 * A started authenticator-app enrolment. The secret is shown once, in this
 * response only, and never stored anywhere by this app.
 */
export interface TotpEnrolment {
  /** The base32 shared secret, for typing into an app by hand. */
  secret: string;
  /** `otpauth://totp/...`, the string a QR code would encode. */
  uri: string;
  /** Label parts, so the UI can name what it is about to enrol. */
  issuer: string;
  account: string;
}

/** One passkey registered against the operator's account. */
export interface Passkey {
  /** Cognito's `CredentialId`; the delete endpoint's path segment. */
  id: string;
  /** `FriendlyCredentialName` — Cognito derives it from the authenticator. */
  name: string;
  /** The relying party the credential is bound to, i.e. the host name. */
  relyingPartyId: string;
  /** `platform` or `cross-platform`, when the authenticator reported one. */
  attachment: string | null;
  /** `internal`, `usb`, `hybrid`, … */
  transports: string[];
  /** ISO 8601. */
  createdAt: string | null;
}

/**
 * Cognito's `CredentialCreationOptions`, forwarded to the browser exactly as
 * it arrived. It is a WebAuthn `PublicKeyCredentialCreationOptionsJSON`: the
 * challenge and the ids are base64url strings, which `./webauthn.ts` turns
 * into the buffers `navigator.credentials.create()` wants.
 *
 * Deliberately opaque. Nothing in this app interprets the contents, and
 * re-typing them here would only invite a mismatch with whatever Cognito
 * decides to send.
 */
export type PasskeyCreationOptions = Record<string, unknown>;

/** What `POST /api/v1/admin/me/passkeys` answers with. */
export interface PasskeyRegistrationStart {
  options: PasskeyCreationOptions;
}
