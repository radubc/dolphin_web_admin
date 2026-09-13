/**
 * The base64url plumbing between Cognito's WebAuthn JSON and the browser's
 * `PublicKeyCredential` API.
 *
 * WebAuthn's JavaScript API speaks `ArrayBuffer`; every wire format — Cognito's
 * `CredentialCreationOptions` on the way in, the `RegistrationResponseJSON` on
 * the way out — speaks base64url. Modern browsers do the conversion themselves
 * with `PublicKeyCredential.parseCreationOptionsFromJSON()` and
 * `credential.toJSON()`, so those are used when they exist and the hand-rolled
 * pass below is the fallback for a browser that has one but not the other (or
 * neither).
 *
 * Two ceremonies live here, and they are mirror images:
 *
 * - **registration** (`createPasskey`) — the Account & security drawer, which
 *   holds an authenticated session already;
 * - **authentication** (`getPasskeyAssertion`) — the "Sign in with a passkey"
 *   button on `/login`, where there is no session yet and Cognito's `USER_AUTH`
 *   challenge supplies the options.
 *
 * Client-safe: no server imports, no secrets. Nothing here validates anything —
 * Cognito is the relying party and verifies the attestation, the assertion, the
 * challenge and the origin. This module only changes the encoding.
 */
import type { PasskeyCreationOptions } from "./types";

/**
 * Cognito's `CREDENTIAL_REQUEST_OPTIONS`, parsed from the JSON string the
 * `WEB_AUTHN` challenge carries. A WebAuthn
 * `PublicKeyCredentialRequestOptionsJSON`: the challenge and the credential ids
 * are base64url strings.
 *
 * Deliberately opaque, exactly like {@link PasskeyCreationOptions}: nothing in
 * this app interprets the contents, and re-typing them here would only invite a
 * mismatch with whatever Cognito decides to send.
 */
export type PasskeyRequestOptions = Record<string, unknown>;

/** True when this browser can do WebAuthn at all. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.create === "function"
  );
}

/**
 * True when this browser can *use* a passkey. Separate from
 * {@link passkeysSupported} because the two ceremonies are separate methods:
 * signing in only needs `navigator.credentials.get`, and the sign-in page has
 * no business asking whether the browser could also create one.
 */
export function passkeySignInSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.get === "function"
  );
}

/* -------------------------------------------------------------------------- */
/*                             base64url <-> bytes                            */
/* -------------------------------------------------------------------------- */

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  // The explicit `ArrayBuffer` is what makes the result a `BufferSource`:
  // `Uint8Array` alone is generic over `ArrayBufferLike`, which includes
  // `SharedArrayBuffer`, and WebAuthn does not accept one of those.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* -------------------------------------------------------------------------- */
/*                    Cognito's JSON -> what the browser wants                */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`The passkey request from Cognito has no ${what}.`);
  }
  return value;
}

/**
 * Hand-rolled conversion, used when the browser has no
 * `parseCreationOptionsFromJSON`. Only the four fields WebAuthn defines as
 * `BufferSource` are decoded; everything else is passed through unchanged, so
 * a field Cognito adds later still reaches the authenticator.
 */
function toCreationOptions(
  json: PasskeyCreationOptions,
): PublicKeyCredentialCreationOptions {
  const user = asRecord(json.user);
  if (!user) {
    throw new Error("The passkey request from Cognito has no user.");
  }
  const excluded = Array.isArray(json.excludeCredentials)
    ? json.excludeCredentials
    : [];

  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: base64UrlToBytes(requiredString(json.challenge, "challenge")),
    user: {
      ...(user as unknown as PublicKeyCredentialUserEntity),
      id: base64UrlToBytes(requiredString(user.id, "user id")),
    },
    excludeCredentials: excluded.flatMap((entry) => {
      const credential = asRecord(entry);
      if (!credential || typeof credential.id !== "string") return [];
      return [
        {
          ...(credential as unknown as PublicKeyCredentialDescriptor),
          id: base64UrlToBytes(credential.id),
        },
      ];
    }),
  };
}

/**
 * The browser's `PublicKeyCredential` as the JSON Cognito's
 * `CompleteWebAuthnRegistration` expects (a WebAuthn `RegistrationResponseJSON`).
 */
function toRegistrationJson(credential: PublicKeyCredential): unknown {
  const withJson = credential as PublicKeyCredential & {
    toJSON?: () => unknown;
  };
  if (typeof withJson.toJSON === "function") {
    return withJson.toJSON();
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  const transports =
    typeof response.getTransports === "function" ? response.getTransports() : [];

  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      attestationObject: bytesToBase64Url(response.attestationObject),
      transports,
    },
  };
}

/**
 * Runs the registration ceremony: turns Cognito's options into the browser's
 * shape, asks the authenticator, and hands back the JSON to post back.
 *
 * @throws `DOMException` when the person cancels or the authenticator refuses;
 * the caller turns `NotAllowedError` into "cancelled" rather than an error.
 */
export async function createPasskey(
  json: PasskeyCreationOptions,
): Promise<unknown> {
  const parse = (
    window.PublicKeyCredential as typeof PublicKeyCredential & {
      parseCreationOptionsFromJSON?: (
        options: unknown,
      ) => PublicKeyCredentialCreationOptions;
    }
  ).parseCreationOptionsFromJSON;

  const publicKey =
    typeof parse === "function" ? parse(json) : toCreationOptions(json);

  const credential = await navigator.credentials.create({ publicKey });
  if (!credential) {
    throw new Error("The browser did not create a passkey.");
  }
  return toRegistrationJson(credential as PublicKeyCredential);
}

/* -------------------------------------------------------------------------- */
/*                    Signing in: the authentication ceremony                 */
/* -------------------------------------------------------------------------- */

/**
 * Hand-rolled conversion, used when the browser has no
 * `parseRequestOptionsFromJSON`. The mirror of {@link toCreationOptions}, and
 * shorter: an assertion has no `user` and no `excludeCredentials`, only the
 * challenge and the optional `allowCredentials` list carry buffers. Everything
 * else (`rpId`, `timeout`, `userVerification`, anything Cognito adds later) is
 * passed through untouched.
 */
function toRequestOptions(
  json: PasskeyRequestOptions,
): PublicKeyCredentialRequestOptions {
  const allowed = Array.isArray(json.allowCredentials)
    ? json.allowCredentials
    : [];

  return {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: base64UrlToBytes(requiredString(json.challenge, "challenge")),
    allowCredentials: allowed.flatMap((entry) => {
      const credential = asRecord(entry);
      if (!credential || typeof credential.id !== "string") return [];
      return [
        {
          ...(credential as unknown as PublicKeyCredentialDescriptor),
          id: base64UrlToBytes(credential.id),
        },
      ];
    }),
  };
}

/**
 * The browser's `PublicKeyCredential` as the JSON Cognito's `WEB_AUTHN`
 * challenge expects (a WebAuthn `AuthenticationResponseJSON`), the mirror of
 * {@link toRegistrationJson}.
 *
 * `userHandle` is the one field that may legitimately be absent — an
 * authenticator that was not asked for a discoverable credential returns
 * `null` — so it is omitted rather than sent as `null`.
 */
function toAuthenticationJson(credential: PublicKeyCredential): unknown {
  const withJson = credential as PublicKeyCredential & {
    toJSON?: () => unknown;
  };
  if (typeof withJson.toJSON === "function") {
    return withJson.toJSON();
  }

  const response = credential.response as AuthenticatorAssertionResponse;

  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      signature: bytesToBase64Url(response.signature),
      userHandle: response.userHandle
        ? bytesToBase64Url(response.userHandle)
        : undefined,
    },
  };
}

/**
 * Runs the authentication ceremony: turns Cognito's
 * `CREDENTIAL_REQUEST_OPTIONS` into the browser's shape, asks the
 * authenticator, and hands back the JSON that goes into
 * `RespondToAuthChallenge` as `ChallengeResponses.CREDENTIAL`.
 *
 * The relying party is the pool's `RelyingPartyId`, which is the host the
 * console is served from — so on `localhost` (a different host from the
 * configured one) the browser refuses before this ever reaches Cognito. See
 * `docs/auth.md`.
 *
 * @throws `DOMException` when the person dismisses the prompt or the
 * authenticator refuses; the caller turns `NotAllowedError` / `AbortError` into
 * "cancelled" and sends nothing.
 */
export async function getPasskeyAssertion(
  json: PasskeyRequestOptions,
): Promise<unknown> {
  const parse = (
    window.PublicKeyCredential as typeof PublicKeyCredential & {
      parseRequestOptionsFromJSON?: (
        options: unknown,
      ) => PublicKeyCredentialRequestOptions;
    }
  ).parseRequestOptionsFromJSON;

  const publicKey =
    typeof parse === "function" ? parse(json) : toRequestOptions(json);

  const credential = await navigator.credentials.get({ publicKey });
  if (!credential) {
    throw new Error("The browser did not return a passkey.");
  }
  return toAuthenticationJson(credential as PublicKeyCredential);
}
