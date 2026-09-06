import { createHmac } from "node:crypto";
import {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  RevokeTokenCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { getCognitoConfig, type CognitoConfig } from "./config";

export interface SignInTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  /** Lifetime of the id/access tokens, in seconds. */
  expiresIn: number;
}

export type SignInResult =
  ({ ok: true } & SignInTokens) | { ok: false; message: string };

const GENERIC_CREDENTIALS_ERROR = "Incorrect email or password.";
const GENERIC_ERROR =
  "Something went wrong while signing in. Please try again.";

let cachedClient: {
  key: string;
  client: CognitoIdentityProviderClient;
} | null = null;

function getClient(config: CognitoConfig): CognitoIdentityProviderClient {
  if (cachedClient?.key !== config.region) {
    cachedClient = {
      key: config.region,
      client: new CognitoIdentityProviderClient({ region: config.region }),
    };
  }
  return cachedClient.client;
}

/**
 * Cognito requires a SECRET_HASH when the app client has a secret:
 * base64(HMAC-SHA256(username + clientId, clientSecret)).
 */
function secretHash(
  username: string,
  clientId: string,
  clientSecret: string,
): string {
  return createHmac("sha256", clientSecret)
    .update(username + clientId)
    .digest("base64");
}

function describeChallenge(challengeName: string): string {
  switch (challengeName) {
    case "NEW_PASSWORD_REQUIRED":
      return "a new password";
    case "SMS_MFA":
      return "an SMS code";
    case "SOFTWARE_TOKEN_MFA":
    case "MFA_SETUP":
    case "SELECT_MFA_TYPE":
      return "multi-factor authentication";
    default:
      return challengeName.toLowerCase().replace(/_/g, " ");
  }
}

function mapError(error: unknown): string {
  const name =
    error instanceof Error
      ? error.name
      : String((error as { name?: string })?.name ?? "");

  switch (name) {
    case "NotAuthorizedException":
    case "UserNotFoundException":
      // The user sees one generic message for both. The server log keeps the
      // distinction, because "Unable to verify secret hash" (a wrong client
      // secret) and "User does not exist" (wrong pool) need different fixes
      // and look identical from the browser. Cognito's message never carries
      // the password.
      console.error(
        `[auth] Cognito refused sign-in: ${name}: ${
          error instanceof Error ? error.message : ""
        }`,
      );
      return GENERIC_CREDENTIALS_ERROR;
    case "UserNotConfirmedException":
      return "This account hasn't been confirmed yet.";
    case "PasswordResetRequiredException":
      return "A password reset is required for this account.";
    case "TooManyRequestsException":
    case "LimitExceededException":
      return "Too many attempts. Please wait and try again.";
    case "InvalidParameterException": {
      const message = error instanceof Error ? error.message : "";
      if (/auth flow/i.test(message) || /USER_PASSWORD_AUTH/i.test(message)) {
        console.error(
          "[auth] Cognito USER_PASSWORD_AUTH flow rejected:",
          message,
        );
        return "Sign-in is not configured for this client.";
      }
      console.error("[auth] Cognito InvalidParameterException:", message);
      return GENERIC_ERROR;
    }
    default:
      console.error("[auth] Unexpected Cognito error:", error);
      return GENERIC_ERROR;
  }
}

/**
 * Signs a user in with the USER_PASSWORD_AUTH flow.
 *
 * Wrong password and unknown user both map to the same generic message, but
 * this is *not* a full guarantee against user enumeration: an unconfirmed
 * account, a required password reset, or an unsupported challenge each produce
 * a distinct message, which confirms the address exists. That is deliberate —
 * this user base is admin-provisioned, and the specific message is what lets a
 * legitimate user (or support) understand why sign-in failed.
 *
 * What actually gates enumeration is the user pool app client's
 * `PreventUserExistenceErrors` setting: with it enabled Cognito itself returns
 * `NotAuthorizedException` ("Incorrect username or password") instead of
 * `UserNotFoundException` / `UserNotConfirmedException` /
 * `PasswordResetRequiredException`, so those branches simply stop firing. Turn
 * it on if the app ever accepts self-service sign-ups.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SignInResult> {
  // Thrown deliberately: the caller turns this into a "not configured" message.
  const config = getCognitoConfig();

  const authParameters: Record<string, string> = {
    USERNAME: email,
    PASSWORD: password,
  };
  if (config.clientSecret) {
    authParameters.SECRET_HASH = secretHash(
      email,
      config.clientId,
      config.clientSecret,
    );
  }

  let response;
  try {
    response = await getClient(config).send(
      new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: config.clientId,
        AuthParameters: authParameters,
      }),
    );
  } catch (error) {
    return { ok: false, message: mapError(error) };
  }

  if (response.ChallengeName) {
    console.error(
      `[auth] Unsupported Cognito challenge: ${response.ChallengeName}`,
    );
    return {
      ok: false,
      message: `This account requires an extra step (${describeChallenge(
        response.ChallengeName,
      )}) that isn't supported yet.`,
    };
  }

  const result = response.AuthenticationResult;
  if (!result?.IdToken || !result.AccessToken) {
    console.error("[auth] Cognito returned no authentication result.");
    return { ok: false, message: GENERIC_ERROR };
  }

  return {
    ok: true,
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn ?? 3600,
  };
}

/* -------------------------------------------------------------------------- */
/*  Token refresh (REFRESH_TOKEN_AUTH) and revocation                         */
/* -------------------------------------------------------------------------- */

export type RefreshResult =
  | ({ ok: true } & SignInTokens)
  /**
   * `invalid` — the refresh token will never work again (revoked, expired,
   * issued to another client, user gone). The session must be cleared.
   * `unavailable` — Cognito could not answer. The session must be left alone.
   */
  | { ok: false; reason: "invalid" | "unavailable" };

/**
 * Exchanges a refresh token for a fresh id and access token.
 *
 * `username` must be the value the SECRET_HASH was computed against — for this
 * flow Cognito uses the user's `sub`; see `refreshUsernameFrom()` in
 * `./session`, which is the single place that decision lives. It is ignored
 * when the app client has no secret.
 *
 * The response only carries a new refresh token when refresh-token rotation is
 * enabled on the app client; otherwise `refreshToken` is undefined and the
 * caller must keep the one it already holds.
 *
 * Requires `ALLOW_REFRESH_TOKEN_AUTH` on the app client. A pool that does not
 * allow the flow answers `NotAuthorizedException`, which is reported as
 * `invalid` — the logged message is what distinguishes a misconfiguration from
 * a genuinely dead token.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function refreshTokens(
  refreshToken: string,
  username: string,
): Promise<RefreshResult> {
  // Thrown deliberately: the caller turns this into a 503, not a sign-out.
  const config = getCognitoConfig();

  const authParameters: Record<string, string> = {
    REFRESH_TOKEN: refreshToken,
  };
  if (config.clientSecret) {
    authParameters.SECRET_HASH = secretHash(
      username,
      config.clientId,
      config.clientSecret,
    );
  }

  let response;
  try {
    response = await getClient(config).send(
      new InitiateAuthCommand({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: config.clientId,
        AuthParameters: authParameters,
      }),
    );
  } catch (error) {
    switch (errorName(error)) {
      case "NotAuthorizedException":
        // Revoked, expired, wrong client, wrong SECRET_HASH, or the flow is
        // not enabled on the app client. Logged because the last two are
        // configuration bugs that would otherwise look like a normal timeout.
        console.error(
          config.clientSecret
            ? "[auth] Cognito refused a refresh token (with a client secret configured, a SECRET_HASH computed over the wrong username is a likely cause; it must be the pool username, `cognito:username`):"
            : "[auth] Cognito refused a refresh token:",
          errorMessage(error),
        );
        return { ok: false, reason: "invalid" };
      case "UserNotFoundException":
        console.error(
          "[auth] Cognito refused a refresh token:",
          errorMessage(error),
        );
        return { ok: false, reason: "invalid" };
      case "TooManyRequestsException":
      case "LimitExceededException":
        console.error("[auth] Cognito throttled a token refresh.");
        return { ok: false, reason: "unavailable" };
      default:
        console.error("[auth] Unexpected Cognito refresh error:", error);
        return { ok: false, reason: "unavailable" };
    }
  }

  if (response.ChallengeName) {
    // A refresh never legitimately produces a challenge. Treat it as a dead
    // session rather than pretending the refresh worked.
    console.error(
      `[auth] Unexpected challenge on refresh: ${response.ChallengeName}`,
    );
    return { ok: false, reason: "invalid" };
  }

  const result = response.AuthenticationResult;
  if (!result?.IdToken || !result.AccessToken) {
    console.error("[auth] Cognito returned no authentication result on refresh.");
    return { ok: false, reason: "unavailable" };
  }

  return {
    ok: true,
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    // Present only with refresh-token rotation enabled.
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn ?? 3600,
  };
}

/**
 * Revokes a refresh token and every access token minted from it.
 *
 * Best effort by design: sign-out must succeed for the user whatever Cognito
 * says, so every failure is logged and swallowed. The local cookies are cleared
 * by the caller regardless.
 *
 * Requires token revocation to be enabled on the app client (it is on by
 * default for clients created since 2021); a client without it answers
 * `UnsupportedOperationException`.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    const config = getCognitoConfig();
    await getClient(config).send(
      new RevokeTokenCommand({
        Token: refreshToken,
        ClientId: config.clientId,
        ClientSecret: config.clientSecret,
      }),
    );
  } catch (error) {
    console.error("[auth] Could not revoke the refresh token:", error);
  }
}

/* -------------------------------------------------------------------------- */
/*  Password reset (Cognito forgot-password flow)                             */
/* -------------------------------------------------------------------------- */

/** Form field a password-reset error belongs to, when it belongs to one. */
export type PasswordResetField = "email" | "code" | "password";

export type PasswordResetResult =
  | {
      ok: true;
      /**
       * Nothing else: the masked destination Cognito reports on a real send
       * would only ever appear for an address that exists, which is exactly
       * what this flow must not disclose.
       */
    }
  | {
      ok: false;
      error: string;
      field?: PasswordResetField;
      /** The code is gone for good: the caller should offer a fresh one. */
      resend?: boolean;
    };

/**
 * Neutral answer to step one: the only successful shape this flow returns,
 * whether or not the address exists. See {@link requestPasswordReset} for what
 * it does and does not hide.
 */
const NEUTRAL_RESET_RESULT: PasswordResetResult = { ok: true };

const TOO_MANY_ATTEMPTS = "Too many attempts. Please wait and try again.";
const BAD_CODE = "That code isn't right. Check the email and try again.";
const EXPIRED_CODE = "That code has expired. Request a new one.";
/** Also used by the /forgot-password action for errors that escape this module. */
export const GENERIC_RESET_ERROR =
  "Something went wrong while resetting your password. Please try again.";

function errorName(error: unknown): string {
  return error instanceof Error
    ? error.name
    : String((error as { name?: string })?.name ?? "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

/** `undefined` when the app client has no secret, so it can be spread away. */
function secretHashFor(
  config: CognitoConfig,
  username: string,
): string | undefined {
  return config.clientSecret
    ? secretHash(username, config.clientId, config.clientSecret)
    : undefined;
}

/**
 * Starts the forgot-password flow: Cognito emails (or texts) a one-time code.
 *
 * Deliberately non-committal about whether the account exists. Every outcome
 * that depends on the address existing — unknown user, an account Cognito will
 * not reset, a code it could not deliver, a user with no verified email — maps
 * to the same bare `{ ok: true }` a real send returns, so the response body is
 * identical either way and the caller shows one neutral message. Only the
 * rate-limit and truly unexpected branches say anything else, and neither is
 * specific to an existing account.
 *
 * That equalises *content*, not timing: a real send does more work (and hits
 * SES) than a `UserNotFoundException`, so response time still leaks a little.
 * Closing that gap is the app client's job — enable `PreventUserExistenceErrors`
 * on the user pool client and Cognito itself fakes the delivery for unknown
 * users, returning a synthetic `CodeDeliveryDetails` on the same code path.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function requestPasswordReset(
  email: string,
): Promise<PasswordResetResult> {
  // Thrown deliberately: the caller turns this into a "not configured" message.
  const config = getCognitoConfig();

  try {
    await getClient(config).send(
      new ForgotPasswordCommand({
        ClientId: config.clientId,
        Username: email,
        SecretHash: secretHashFor(config, email),
      }),
    );
    // The response carries a masked CodeDeliveryDetails.Destination. It is
    // deliberately dropped: returning it would mark this address as existing.
    // The server log does record that a code was requested, so "no email
    // arrived" can be told apart from "no such user" by an operator.
    console.info("[auth] Cognito accepted a password-reset request.");
    return NEUTRAL_RESET_RESULT;
  } catch (error) {
    switch (errorName(error)) {
      case "UserNotFoundException":
        // No such account. Say exactly what we say on success. Logged
        // server-side only; the response stays identical.
        console.info("[auth] Password reset requested for an unknown user.");
        return NEUTRAL_RESET_RESULT;
      case "NotAuthorizedException":
        // Typically an admin-set temporary password (FORCE_CHANGE_PASSWORD) or
        // a disabled user: Cognito will not reset it, but saying so would
        // confirm the address exists.
        console.error(
          "[auth] Cognito refused ForgotPassword:",
          errorMessage(error),
        );
        return NEUTRAL_RESET_RESULT;
      case "LimitExceededException":
      case "TooManyRequestsException":
        return { ok: false, error: TOO_MANY_ATTEMPTS };
      case "CodeDeliveryFailureException":
        // Cognito only tries to deliver for a user it found, so surfacing this
        // would confirm the address exists. Operators need to know; the visitor
        // gets the neutral answer and support picks it up from the logs.
        console.error(
          "[auth] Cognito could not deliver a reset code:",
          errorMessage(error),
        );
        return NEUTRAL_RESET_RESULT;
      case "InvalidParameterException": {
        // Usually "no registered/verified email or phone_number": the pool has
        // nowhere to send the code. Same reasoning as above — the check runs on
        // a found user's attributes, so it too is an existence tell.
        console.error(
          "[auth] Cognito InvalidParameterException on ForgotPassword:",
          errorMessage(error),
        );
        return NEUTRAL_RESET_RESULT;
      }
      default:
        console.error("[auth] Unexpected Cognito reset error:", error);
        return { ok: false, error: GENERIC_RESET_ERROR };
    }
  }
}

/**
 * Cognito's password-policy messages ("Password did not conform with policy:
 * Password must have uppercase characters") are written for end users and
 * safe to show, but the prefix adds nothing. Strip it and punctuate.
 */
function describePasswordPolicy(error: unknown): string {
  const raw = errorMessage(error).trim();
  const detail = raw.replace(/^password did not conform with policy:\s*/i, "");
  if (detail === "") {
    return "That password doesn't meet the password policy.";
  }
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
}

/**
 * Completes the forgot-password flow with the emailed code and a new password.
 *
 * A wrong code and an unknown user return the same message, for the same
 * anti-enumeration reason as {@link requestPasswordReset}.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function confirmPasswordReset(
  email: string,
  code: string,
  password: string,
): Promise<PasswordResetResult> {
  // Thrown deliberately: the caller turns this into a "not configured" message.
  const config = getCognitoConfig();

  try {
    await getClient(config).send(
      new ConfirmForgotPasswordCommand({
        ClientId: config.clientId,
        Username: email,
        ConfirmationCode: code,
        Password: password,
        SecretHash: secretHashFor(config, email),
      }),
    );
    return { ok: true };
  } catch (error) {
    switch (errorName(error)) {
      case "CodeMismatchException":
      case "UserNotFoundException":
        return { ok: false, error: BAD_CODE, field: "code" };
      case "ExpiredCodeException":
        return { ok: false, error: EXPIRED_CODE, field: "code", resend: true };
      case "NotAuthorizedException":
        // Code already used, or the account is in a state Cognito will not
        // reset. Treated as a bad code so the answer stays uninformative.
        console.error(
          "[auth] Cognito refused ConfirmForgotPassword:",
          errorMessage(error),
        );
        return { ok: false, error: BAD_CODE, field: "code", resend: true };
      case "InvalidPasswordException":
        return {
          ok: false,
          error: describePasswordPolicy(error),
          field: "password",
        };
      case "LimitExceededException":
      case "TooManyRequestsException":
        return { ok: false, error: TOO_MANY_ATTEMPTS };
      case "InvalidParameterException": {
        const message = errorMessage(error);
        console.error(
          "[auth] Cognito InvalidParameterException on ConfirmForgotPassword:",
          message,
        );
        if (/password/i.test(message)) {
          // Length constraints are reported here rather than as
          // InvalidPasswordException; the raw AWS validation text is not fit
          // to show, so summarise it.
          return {
            ok: false,
            error: "That password doesn't meet the password policy.",
            field: "password",
          };
        }
        return { ok: false, error: GENERIC_RESET_ERROR };
      }
      default:
        console.error("[auth] Unexpected Cognito reset error:", error);
        return { ok: false, error: GENERIC_RESET_ERROR };
    }
  }
}
