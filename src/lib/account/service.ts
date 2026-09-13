import "server-only";
/**
 * "Account & security": the operator acting on their own Cognito account.
 *
 * Every function here calls the admin user pool **as the operator**, with the
 * access token from their session cookie (`src/lib/auth/access-token.ts`).
 * None of them uses AWS credentials and none of them can touch anybody else's
 * account: Cognito derives the subject from the token, so there is no user id
 * to get wrong. Nothing is written to either database — the pool is the record.
 *
 * ## What the pool has to allow
 *
 * The admin pool is currently tier LITE with `MfaConfiguration OFF` and no
 * WebAuthn relying party, so the MFA and passkey calls below are refused by
 * AWS today. That is deliberate: the code is complete and the UI stays
 * visible, and every refusal is turned into a 503 that **quotes Cognito's own
 * sentence** rather than a generic apology, so the person reading it can see
 * what the pool is missing. `docs/auth.md` lists the settings and the CLI
 * commands that switch them on; nothing here needs to change afterwards.
 */
import {
  AssociateSoftwareTokenCommand,
  ChangePasswordCommand,
  CompleteWebAuthnRegistrationCommand,
  DeleteWebAuthnCredentialCommand,
  GetUserCommand,
  ListWebAuthnCredentialsCommand,
  SetUserMFAPreferenceCommand,
  StartWebAuthnRegistrationCommand,
  VerifySoftwareTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  ApiError,
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from "@/lib/api/errors";
import { cognitoClient } from "@/lib/auth/cognito";
import type {
  MfaStatus,
  Passkey,
  PasskeyCreationOptions,
  TotpEnrolment,
} from "./types";

/** Shown on the authenticator app's entry, and in the otpauth URI. */
const TOTP_ISSUER = "Penny Squeeze Admin";

/** Cognito's cap on how many credentials one list call returns. */
const PASSKEY_PAGE_SIZE = 20;

/**
 * How many pages of passkeys are read before the list is cut short. Nobody
 * registers hundreds, and an unbounded loop over a paginated AWS API is a way
 * to hang a request.
 */
const PASSKEY_MAX_PAGES = 5;

function errorName(error: unknown): string {
  return error instanceof Error
    ? error.name
    : String((error as { name?: string })?.name ?? "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.trim() : "";
}

/**
 * A 503 that quotes AWS.
 *
 * Used for every refusal that is a *pool configuration* problem rather than
 * something the operator did: MFA switched off at the pool, a tier that has no
 * passkeys, a missing relying party. The owner is the person who will read it,
 * and Cognito's text ("User pool does not have software token MFA enabled") is
 * far more actionable than anything this app could invent, so it is appended
 * verbatim. It contains no secret: these messages describe pool settings.
 */
function notConfigured(code: string, lead: string, error: unknown): ApiError {
  const detail = errorMessage(error);
  console.error(`[account] ${code}: ${errorName(error)}: ${detail}`);
  return new ServiceUnavailableError(
    code,
    detail === "" ? lead : `${lead} Cognito said: ${detail}`,
  );
}

/** Cognito refused the access token itself: the session has to be renewed. */
function tokenRejected(error: unknown): ApiError {
  console.error("[account] Cognito rejected the access token:", errorMessage(error));
  return new ApiError(
    401,
    "token_expired",
    "Session expired; refresh and retry.",
  );
}

/** AWS throttling, mapped onto the API's own 429. */
function throttled(): ApiError {
  return new TooManyRequestsError(
    30,
    undefined,
    "Too many attempts. Please wait and try again.",
  );
}

/**
 * The refusals every one of these calls can produce, whatever it was asking
 * for. Returns `null` when the error is not one of them, so each caller can
 * add the branches that are specific to it.
 */
function commonFailure(error: unknown): ApiError | null {
  switch (errorName(error)) {
    case "NotAuthorizedException":
      // For a self-service call this almost always means the access token is
      // expired or was issued without the aws.cognito.signin.user.admin scope.
      return tokenRejected(error);
    case "UserNotFoundException":
      return new UnauthorizedError("That account no longer exists.");
    case "UserNotConfirmedException":
      return new BadRequestError("This account hasn't been confirmed yet.");
    case "PasswordResetRequiredException":
      return new BadRequestError(
        "A password reset is required for this account. Sign out and use “Forgot password?”.",
      );
    case "TooManyRequestsException":
    case "LimitExceededException":
      return throttled();
    case "ForbiddenException":
      return notConfigured(
        "cognito_forbidden",
        "Cognito refused the request (WAF or advanced security).",
        error,
      );
    case "InternalErrorException":
    case "ResourceNotFoundException":
      return notConfigured(
        "cognito_unavailable",
        "Cognito could not answer.",
        error,
      );
    default:
      return null;
  }
}

/** Anything unmapped: logged in full, reported as a plain 503. */
function unexpected(what: string, error: unknown): ApiError {
  console.error(`[account] Unexpected Cognito error while ${what}:`, error);
  return new ServiceUnavailableError(
    "cognito_unavailable",
    "Cognito could not answer that request. Please try again.",
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Password                                  */
/* -------------------------------------------------------------------------- */

/**
 * Cognito's password-policy messages ("Password did not conform with policy:
 * Password must have uppercase characters") are written for end users and safe
 * to show, but the prefix adds nothing. Strip it and punctuate.
 */
function describePasswordPolicy(error: unknown): string {
  const detail = errorMessage(error).replace(
    /^password did not conform with policy:\s*/i,
    "",
  );
  if (detail === "") {
    return "That password doesn't meet the password policy.";
  }
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
}

/** A 422 whose `details` puts the message under one input of the form. */
function fieldError(field: string, message: string): ApiError {
  return new ValidationError(message, {
    formErrors: [],
    fieldErrors: { [field]: [message] },
  });
}

/**
 * Replaces the operator's password. Cognito checks the current one, so this
 * doubles as the re-authentication the change needs.
 *
 * A wrong current password is reported against that input rather than as a
 * bare failure, and the pool's own policy message is passed through onto the
 * new-password input.
 *
 * Note that Cognito does **not** revoke other sessions on a password change:
 * the refresh tokens already issued keep working until they expire or are
 * revoked. Signing every device out would mean `AdminUserGlobalSignOut`, which
 * needs AWS credentials rather than the user's token, and is a deliberate
 * follow-up rather than something to do silently here.
 */
export async function changeOwnPassword(
  accessToken: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (currentPassword === newPassword) {
    throw fieldError(
      "newPassword",
      "Choose a password different from the current one.",
    );
  }

  try {
    await cognitoClient().send(
      new ChangePasswordCommand({
        AccessToken: accessToken,
        PreviousPassword: currentPassword,
        ProposedPassword: newPassword,
      }),
    );
  } catch (error) {
    switch (errorName(error)) {
      case "NotAuthorizedException":
        // Ambiguous: either the current password is wrong or the access token
        // is stale. The token was verified by `authenticate()` moments ago, so
        // the password is overwhelmingly the likelier of the two — and saying
        // so is the only useful thing to put on the form.
        throw fieldError("currentPassword", "That password isn't right.");
      case "InvalidPasswordException":
        throw fieldError("newPassword", describePasswordPolicy(error));
      case "InvalidParameterException": {
        const message = errorMessage(error);
        console.error("[account] InvalidParameterException on ChangePassword:", message);
        throw fieldError(
          "newPassword",
          "That password doesn't meet the password policy.",
        );
      }
      default: {
        const mapped = commonFailure(error);
        if (mapped) throw mapped;
        throw unexpected("changing a password", error);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                        Two-factor: authenticator app                       */
/* -------------------------------------------------------------------------- */

/** Reads the factors Cognito has switched on for this operator. */
export async function getMfaStatus(accessToken: string): Promise<MfaStatus> {
  let response;
  try {
    response = await cognitoClient().send(
      new GetUserCommand({ AccessToken: accessToken }),
    );
  } catch (error) {
    const mapped = commonFailure(error);
    if (mapped) throw mapped;
    throw unexpected("reading the MFA status", error);
  }

  const methods = response.UserMFASettingList ?? [];
  return {
    totpEnabled: methods.includes("SOFTWARE_TOKEN_MFA"),
    preferred: response.PreferredMfaSetting ?? null,
    methods,
  };
}

/** RFC 6238 label: `otpauth://totp/<issuer>:<account>?...`, all URI-escaped. */
function otpauthUri(secret: string, account: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${account}`);
  const query = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/**
 * Starts an authenticator-app enrolment: Cognito mints a shared secret and
 * ties it to this account, unverified, until a code proves the app has it.
 *
 * The secret is returned once and never stored by this app. Re-running the
 * call simply mints another one; only the secret that is verified survives.
 *
 * `account` is what the app will show under the issuer — the operator's email.
 */
export async function startTotpEnrolment(
  accessToken: string,
  account: string,
): Promise<TotpEnrolment> {
  let response;
  try {
    response = await cognitoClient().send(
      new AssociateSoftwareTokenCommand({ AccessToken: accessToken }),
    );
  } catch (error) {
    switch (errorName(error)) {
      case "SoftwareTokenMFANotFoundException":
        throw notConfigured(
          "mfa_not_enabled",
          "Authenticator apps are not switched on for this user pool yet.",
          error,
        );
      case "InvalidParameterException":
        throw notConfigured(
          "mfa_not_enabled",
          "Cognito would not start an authenticator-app enrolment.",
          error,
        );
      default: {
        const mapped = commonFailure(error);
        if (mapped) throw mapped;
        throw unexpected("starting a TOTP enrolment", error);
      }
    }
  }

  const secret = response.SecretCode;
  if (!secret) {
    throw unexpected("starting a TOTP enrolment", new Error("no SecretCode"));
  }

  return {
    secret,
    uri: otpauthUri(secret, account),
    issuer: TOTP_ISSUER,
    account,
  };
}

/**
 * Finishes the enrolment: verifies one code against the secret Cognito just
 * issued and, only if that succeeds, switches software-token MFA on and makes
 * it the preferred factor.
 *
 * The two calls are separate on the AWS side and cannot be one transaction, so
 * a verified-but-not-enabled account is possible if `SetUserMFAPreference`
 * fails — which is exactly what happens while the pool's `MfaConfiguration` is
 * `OFF`. That refusal is reported as its own 503 quoting Cognito, and the next
 * attempt starts cleanly from a fresh secret.
 */
export async function verifyTotpEnrolment(
  accessToken: string,
  code: string,
  deviceName: string | undefined,
): Promise<MfaStatus> {
  let verification;
  try {
    verification = await cognitoClient().send(
      new VerifySoftwareTokenCommand({
        AccessToken: accessToken,
        UserCode: code,
        FriendlyDeviceName: deviceName,
      }),
    );
  } catch (error) {
    switch (errorName(error)) {
      case "EnableSoftwareTokenMFAException":
      case "CodeMismatchException":
        throw fieldError(
          "code",
          "That code isn't right. Check your authenticator app and try the next one.",
        );
      case "ExpiredCodeException":
        throw fieldError(
          "code",
          "That code has expired. Enter the current one from your app.",
        );
      case "SoftwareTokenMFANotFoundException":
        throw notConfigured(
          "mfa_not_enabled",
          "Authenticator apps are not switched on for this user pool yet.",
          error,
        );
      default: {
        const mapped = commonFailure(error);
        if (mapped) throw mapped;
        throw unexpected("verifying a TOTP code", error);
      }
    }
  }

  if (verification.Status !== "SUCCESS") {
    throw fieldError(
      "code",
      "That code isn't right. Check your authenticator app and try the next one.",
    );
  }

  await setTotpPreference(accessToken, true);
  return getMfaStatus(accessToken);
}

/** Switches the authenticator app off. The registered secret stays verified. */
export async function disableTotp(accessToken: string): Promise<MfaStatus> {
  await setTotpPreference(accessToken, false);
  return getMfaStatus(accessToken);
}

/**
 * The one `SetUserMFAPreference` call, in both directions.
 *
 * This is the call the pool refuses while `MfaConfiguration` is `OFF`, and the
 * refusal is the message the owner needs to see, so it is quoted rather than
 * flattened.
 */
async function setTotpPreference(
  accessToken: string,
  enabled: boolean,
): Promise<void> {
  try {
    await cognitoClient().send(
      new SetUserMFAPreferenceCommand({
        AccessToken: accessToken,
        SoftwareTokenMfaSettings: {
          Enabled: enabled,
          // Preferred only while it is on: Cognito rejects a preference for a
          // factor that is being switched off.
          PreferredMfa: enabled,
        },
      }),
    );
  } catch (error) {
    switch (errorName(error)) {
      case "InvalidParameterException":
      case "SoftwareTokenMFANotFoundException":
        throw notConfigured(
          "mfa_not_enabled",
          enabled
            ? "Your code was accepted, but this user pool will not switch multi-factor authentication on yet."
            : "Cognito would not change the multi-factor setting.",
          error,
        );
      case "FeatureUnavailableInTierException":
        throw notConfigured(
          "mfa_not_enabled",
          "This user pool's feature tier does not include that factor.",
          error,
        );
      default: {
        const mapped = commonFailure(error);
        if (mapped) throw mapped;
        throw unexpected("setting the MFA preference", error);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Passkeys                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every WebAuthn refusal that means "the pool is not set up for passkeys".
 *
 * `WebAuthnConfigurationMissingException` is the one the admin pool answers
 * today: no relying party id is configured. `FeatureUnavailableInTierException`
 * is the LITE tier saying passkeys are an Essentials feature.
 */
const PASSKEYS_UNCONFIGURED = new Set([
  "WebAuthnConfigurationMissingException",
  "WebAuthnNotEnabledException",
  "FeatureUnavailableInTierException",
]);

const PASSKEYS_UNAVAILABLE_LEAD =
  "Passkeys are not enabled on this user pool yet.";

/** Turns a WebAuthn refusal into the 503 the sections show, or `null`. */
function passkeyConfigurationFailure(error: unknown): ApiError | null {
  return PASSKEYS_UNCONFIGURED.has(errorName(error))
    ? notConfigured("passkeys_not_enabled", PASSKEYS_UNAVAILABLE_LEAD, error)
    : null;
}

/** The passkeys registered against this account, newest first. */
export async function listPasskeys(accessToken: string): Promise<Passkey[]> {
  const client = cognitoClient();
  const passkeys: Passkey[] = [];
  let nextToken: string | undefined;

  try {
    for (let page = 0; page < PASSKEY_MAX_PAGES; page += 1) {
      const response = await client.send(
        new ListWebAuthnCredentialsCommand({
          AccessToken: accessToken,
          MaxResults: PASSKEY_PAGE_SIZE,
          NextToken: nextToken,
        }),
      );
      for (const credential of response.Credentials ?? []) {
        if (!credential.CredentialId) continue;
        passkeys.push({
          id: credential.CredentialId,
          name: credential.FriendlyCredentialName ?? "Passkey",
          relyingPartyId: credential.RelyingPartyId ?? "",
          attachment: credential.AuthenticatorAttachment ?? null,
          transports: credential.AuthenticatorTransports ?? [],
          createdAt: credential.CreatedAt?.toISOString() ?? null,
        });
      }
      nextToken = response.NextToken;
      if (!nextToken) break;
    }
  } catch (error) {
    const unconfigured = passkeyConfigurationFailure(error);
    if (unconfigured) throw unconfigured;
    const mapped = commonFailure(error);
    if (mapped) throw mapped;
    throw unexpected("listing passkeys", error);
  }

  return passkeys.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/**
 * Starts a registration: Cognito returns the `CredentialCreationOptions` the
 * browser passes to `navigator.credentials.create()`. The challenge inside is
 * Cognito's and is checked by Cognito when the credential comes back.
 */
export async function startPasskeyRegistration(
  accessToken: string,
): Promise<PasskeyCreationOptions> {
  let response;
  try {
    response = await cognitoClient().send(
      new StartWebAuthnRegistrationCommand({ AccessToken: accessToken }),
    );
  } catch (error) {
    const unconfigured = passkeyConfigurationFailure(error);
    if (unconfigured) throw unconfigured;
    const mapped = commonFailure(error);
    if (mapped) throw mapped;
    throw unexpected("starting a passkey registration", error);
  }

  const options = response.CredentialCreationOptions;
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw unexpected(
      "starting a passkey registration",
      new Error("no CredentialCreationOptions"),
    );
  }
  return options as PasskeyCreationOptions;
}

/**
 * Finishes a registration with the browser's `RegistrationResponseJSON`.
 *
 * The payload is forwarded to Cognito untouched: it is the relying party, so
 * it — not this app — verifies the attestation, the challenge and the origin.
 * Everything this app checks is that the value is JSON of a sane size
 * (`completePasskeySchema`).
 */
export async function completePasskeyRegistration(
  accessToken: string,
  credential: unknown,
): Promise<void> {
  try {
    await cognitoClient().send(
      new CompleteWebAuthnRegistrationCommand({
        AccessToken: accessToken,
        // Validated as JSON by the route's schema, which is exactly the shape
        // the SDK's document type accepts.
        Credential: credential as never,
      }),
    );
  } catch (error) {
    switch (errorName(error)) {
      case "WebAuthnChallengeNotFoundException":
        throw new BadRequestError(
          "That passkey request expired. Start again.",
        );
      case "WebAuthnClientMismatchException":
      case "WebAuthnOriginNotAllowedException":
      case "WebAuthnRelyingPartyMismatchException":
        throw notConfigured(
          "passkeys_not_enabled",
          "This site is not an allowed origin for the pool's passkey settings.",
          error,
        );
      case "WebAuthnCredentialNotSupportedException":
        throw new BadRequestError(
          "That authenticator is not supported by this user pool.",
        );
      case "InvalidParameterException":
        throw new BadRequestError(
          "Cognito could not read that passkey. Start again.",
        );
      default: {
        const unconfigured = passkeyConfigurationFailure(error);
        if (unconfigured) throw unconfigured;
        const mapped = commonFailure(error);
        if (mapped) throw mapped;
        throw unexpected("completing a passkey registration", error);
      }
    }
  }
}

/** Removes one passkey. Cognito scopes the id to the token's own account. */
export async function deletePasskey(
  accessToken: string,
  credentialId: string,
): Promise<void> {
  try {
    await cognitoClient().send(
      new DeleteWebAuthnCredentialCommand({
        AccessToken: accessToken,
        CredentialId: credentialId,
      }),
    );
  } catch (error) {
    switch (errorName(error)) {
      case "ResourceNotFoundException":
        // Overrides the shared mapping: for a delete, "not found" is about the
        // credential, not about the pool.
        throw new NotFoundError("That passkey is already gone.");
      case "InvalidParameterException":
        throw new BadRequestError("That passkey id is not valid.");
      default: {
        const unconfigured = passkeyConfigurationFailure(error);
        if (unconfigured) throw unconfigured;
        const mapped = commonFailure(error);
        if (mapped) throw mapped;
        throw unexpected("deleting a passkey", error);
      }
    }
  }
}
