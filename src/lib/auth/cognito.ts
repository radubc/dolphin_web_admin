import { createHmac } from "node:crypto";
import {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ForgotPasswordCommand,
  GetTokensFromRefreshTokenCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  RevokeTokenCommand,
  type InitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { getCognitoConfig, type CognitoConfig } from "./config";
import {
  attributeSpec,
  isRenderableAttribute,
  MAX_REQUIRED_ATTRIBUTES,
  NEVER_REQUESTED_ATTRIBUTES,
} from "./required-attributes";

export interface SignInTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  /**
   * Cognito's `ExpiresIn`: the **access** token's lifetime in seconds. The id
   * token's may differ (the pool sets the two separately), so cookie lifetimes
   * are taken from each token's own `exp` and this is only the fallback — see
   * `createSession()` in `./session`.
   */
  expiresIn: number;
}

/**
 * The invitation challenge: an operator created with `AdminCreateUser` signing
 * in with the temporary password Cognito emailed (`FORCE_CHANGE_PASSWORD`).
 *
 * `session` is Cognito's opaque continuation token. It is short-lived (about
 * three minutes) and single-use, so the set-password step has to happen right
 * away; it is not a credential for anything else and carries no claims.
 */
export interface NewPasswordChallenge {
  name: "NEW_PASSWORD_REQUIRED";
  /** Opaque `Session` string from InitiateAuth, replayed to the challenge. */
  session: string;
  /**
   * The username Cognito expects back in `ChallengeResponses.USERNAME`, and
   * the value the SECRET_HASH must be computed over: `USER_ID_FOR_SRP` from
   * the challenge parameters (the pool username), falling back to the address
   * that was typed: Cognito checks the hash against the pool username, not the
   * alias the person happened to sign in with.
   */
  username: string;
  /**
   * Standard or custom attributes the pool requires alongside the new
   * password, already stripped of the `userAttributes.` prefix (`["name"]`,
   * not `["userAttributes.name"]`). Normally empty. Every entry is guaranteed
   * renderable — {@link signInWithPassword} refuses the challenge outright
   * rather than hand back one the form cannot ask for — so the set-password
   * step can turn the list straight into inputs.
   */
  requiredAttributes: string[];
}

/**
 * The second-factor challenge: the operator has registered an authenticator
 * app and Cognito wants the six-digit code before it issues any token.
 *
 * Raised on a password sign-in by an operator with the app on; the admin pool
 * (`MfaConfiguration OPTIONAL`, software tokens on since 2026-09-12) does ask.
 * A passkey sign-in never gets it: with the per-user flag it is both factors.
 */
export interface SoftwareTokenMfaChallenge {
  name: "SOFTWARE_TOKEN_MFA";
  /** Opaque `Session` string from InitiateAuth, replayed to the challenge. */
  session: string;
  /** Pool username Cognito expects back, and the SECRET_HASH input. */
  username: string;
}

/**
 * `challenge`, `mfa` and `message` are mutually exclusive, and all three are
 * declared on each branch so `result.challenge` narrows without an `in` check.
 */
export type SignInResult =
  | ({ ok: true } & SignInTokens)
  | {
      ok: false;
      challenge: NewPasswordChallenge;
      mfa?: undefined;
      message?: undefined;
    }
  | {
      ok: false;
      mfa: SoftwareTokenMfaChallenge;
      challenge?: undefined;
      message?: undefined;
    }
  | {
      ok: false;
      message: string;
      challenge?: undefined;
      mfa?: undefined;
    };

/** Result of answering the NEW_PASSWORD_REQUIRED challenge. */
export type CompleteNewPasswordResult =
  | ({ ok: true } & SignInTokens)
  | {
      ok: false;
      error: string;
      /**
       * Where the message belongs: `"password"` for the new-password field, or
       * a Cognito attribute name (`"phone_number"`) for one of the profile
       * inputs. Absent when it belongs above the form.
       */
      field?: string;
      /**
       * The challenge session is dead (expired or already used): the only way
       * forward is a fresh sign-in with the temporary password.
       */
      restart?: boolean;
    };

/** Result of answering the SOFTWARE_TOKEN_MFA challenge. */
export type SoftwareTokenMfaResult =
  | ({ ok: true } & SignInTokens)
  | {
      ok: false;
      error: string;
      /** `"code"` puts the message under the six-digit input. */
      field?: "code";
      /** The challenge session is dead: sign in again from the top. */
      restart?: boolean;
    };

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
 * The one Cognito client this process keeps, for the admin user pool.
 *
 * Exported so the self-service calls in `src/lib/account/service.ts`
 * (ChangePassword, the MFA and WebAuthn commands) reuse this connection pool
 * instead of opening a second one. Those calls authenticate with the
 * operator's own access token, not with AWS credentials — the client itself
 * carries no authority.
 *
 * @throws {CognitoConfigError} when the environment is not configured.
 */
export function cognitoClient(): CognitoIdentityProviderClient {
  return getClient(getCognitoConfig());
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

/**
 * Human wording for a challenge this app cannot answer. NEW_PASSWORD_REQUIRED
 * and SOFTWARE_TOKEN_MFA are both handled (see {@link completeNewPassword} and
 * {@link respondToSoftwareTokenMfa}) and normally never reach this function;
 * they stay listed because Cognito can raise either again as a *follow-up*
 * challenge, which would be worth naming clearly in the message.
 */
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
 * Two challenges do not mean failure and come back as data rather than a
 * message:
 *
 * - **NEW_PASSWORD_REQUIRED** — the operator was created with
 *   `AdminCreateUser` and is signing in with the temporary password. No
 *   session is issued until {@link completeNewPassword} replaces it. Only an
 *   attribute the invitation form cannot render turns this back into a
 *   "contact support" message.
 * - **SOFTWARE_TOKEN_MFA** — the operator has an authenticator app registered;
 *   {@link respondToSoftwareTokenMfa} finishes the sign-in with the code.
 *
 * Every other challenge keeps the old "not supported yet" message.
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

  if (response.ChallengeName === "NEW_PASSWORD_REQUIRED") {
    const parameters = response.ChallengeParameters ?? {};

    // The pool can demand attributes alongside the new password. Whoever ran
    // AdminCreateUser set `email` and `email_verified`, so this list is
    // normally empty; when it is not, the set-password step collects what it
    // can and Cognito receives it with the new password. Logged either way:
    // DescribeUserPool is not something this app is permitted to call, so the
    // server log is the only place the pool's requirements are named.
    const requiredAttributes = requiredAttributesFrom(
      parameters.requiredAttributes,
    );
    if (requiredAttributes.length > 0) {
      console.info(
        `[auth] Cognito requires attributes with the new password: ${requiredAttributes.join(", ")}`,
      );
    }

    // Anything outside the form's allowlist (`updated_at`, a verification
    // flag) has no sensible input, and inventing a value would write a broken
    // profile. Refuse the whole challenge and name the culprit in the log.
    const uncollectable = requiredAttributes.filter(
      (name) => !isRenderableAttribute(name),
    );
    if (uncollectable.length > 0) {
      console.error(
        `[auth] Cognito requires attributes this app cannot collect: ${uncollectable.join(", ")}`,
      );
      return {
        ok: false,
        message:
          "This account needs extra details that can't be set here. Please contact support.",
      };
    }

    if (!response.Session) {
      console.error("[auth] Cognito returned no session for the challenge.");
      return { ok: false, message: GENERIC_ERROR };
    }

    return {
      ok: false,
      challenge: {
        name: "NEW_PASSWORD_REQUIRED",
        session: response.Session,
        // Cognito checks the challenge SECRET_HASH against the pool username,
        // which it hands back here; the typed address is only a fallback for a
        // response that somehow omits it.
        username: parameters.USER_ID_FOR_SRP || email,
        requiredAttributes,
      },
    };
  }

  if (response.ChallengeName === "SOFTWARE_TOKEN_MFA") {
    if (!response.Session) {
      console.error(
        "[auth] Cognito returned no session for the MFA challenge.",
      );
      return { ok: false, message: GENERIC_ERROR };
    }
    return {
      ok: false,
      mfa: {
        name: "SOFTWARE_TOKEN_MFA",
        session: response.Session,
        username: response.ChallengeParameters?.USER_ID_FOR_SRP || email,
      },
    };
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
/*  Re-checking a password for a sensitive action                             */
/* -------------------------------------------------------------------------- */

/** Why {@link verifyPasswordForSensitiveAction} said no. */
export type PasswordCheckFailure =
  /** Cognito judged the credentials and refused them. */
  | "incorrect"
  /**
   * Cognito answered a challenge that is not proof of the password —
   * `NEW_PASSWORD_REQUIRED`, which means the password accepted was the
   * temporary one `AdminCreateUser` mailed out.
   */
  | "challenge"
  /** Cognito could not be reached or answered something unusable. */
  | "unavailable";

/**
 * Second-step challenges Cognito only ever issues *after* the password was
 * right: `USER_PASSWORD_AUTH` sends `USERNAME` and `PASSWORD` in one call, and
 * a wrong password ends that call with `NotAuthorizedException` before any
 * second factor is reached. `NEW_PASSWORD_REQUIRED` is deliberately absent —
 * the password accepted there is a temporary one, and must not authorise
 * anything. Anything not listed is refused and named in the log. Ported from
 * the consumer app (`../penny-squeeze-web/src/lib/auth/cognito.ts`).
 */
const PASSWORD_PROVEN_CHALLENGES: ReadonlySet<string> = new Set([
  "SOFTWARE_TOKEN_MFA",
  "SMS_MFA",
  "SMS_OTP",
  "EMAIL_OTP",
  "EMAIL_MFA",
  "SELECT_MFA_TYPE",
  "MFA_SETUP",
  "WEB_AUTHN",
]);

/** How Cognito proved the password. */
export type PasswordProof =
  /** Tokens came back: nothing stood between the password and a session. */
  | "tokens"
  /**
   * A second-factor challenge came back. The password was accepted — see
   * {@link PASSWORD_PROVEN_CHALLENGES} — and the challenge is left unanswered.
   */
  | "challenge";

export type PasswordCheckResult =
  | {
      ok: true;
      proof: PasswordProof;
      /**
       * The tokens Cognito minted, when `proof` is `"tokens"`. Absent for a
       * challenge, which is exactly why no caller may depend on them: an
       * account with the authenticator app on proves its password without
       * ever getting a token here.
       */
      tokens?: SignInTokens;
      /** The challenge Cognito issued, when `proof` is `"challenge"`. */
      challengeName?: string;
    }
  | { ok: false; failure: PasswordCheckFailure };

/**
 * The one call the re-check makes, so the tests can stub it
 * (`./cognito.test.ts`); production callers pass nothing and get the
 * process-wide client.
 */
export interface PasswordCheckClient {
  send: (command: InitiateAuthCommand) => Promise<InitiateAuthCommandOutput>;
}

/**
 * Re-checks a password without signing anyone in.
 *
 * Two callers (`docs/two-factor-plan.md`, phase B): "Generate new codes" in
 * Account & security (`src/lib/account/recovery.ts`), where a session cookie
 * is enough to *use* the console but not to mint recovery codes; and the
 * recovery-code step at `/login` (`redeemRecoveryCode` in
 * `src/app/login/actions.ts`), where nobody is signed in at all, which is why
 * the address is a parameter and not read from a session. The same
 * `USER_PASSWORD_AUTH` / `InitiateAuth` call as {@link signInWithPassword},
 * with the same SECRET_HASH over the address given.
 *
 * Two differences from sign-in, both deliberate:
 *
 * - **The failure is classified, not worded.** The caller turns `incorrect`
 *   into one fixed message and `unavailable` into a 503 or a generic error,
 *   because a Cognito outage must never be shown as "your password is wrong".
 * - **Nothing is written.** No session is created: this is a check.
 *
 * **This is proof of the password, not a sign-in.** With the authenticator
 * app on, Cognito answers `SOFTWARE_TOKEN_MFA` and no tokens; that challenge
 * is still proof (see {@link PASSWORD_PROVEN_CHALLENGES}) and is left
 * unanswered. Callers therefore must not depend on `tokens`.
 *
 * Rate limiting is the caller's job and must happen **before** this call: it
 * is a password guess, so `RATE_LIMITS.authLoginAccount` is charged per email
 * exactly as `/login` does.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not
 * configured — the caller answers 503 or "not configured", never "wrong".
 */
export async function verifyPasswordForSensitiveAction(
  email: string,
  password: string,
  client?: PasswordCheckClient,
): Promise<PasswordCheckResult> {
  const config = getCognitoConfig();

  const authParameters: Record<string, string> = {
    USERNAME: email,
    PASSWORD: password,
  };
  const hash = secretHashFor(config, email);
  if (hash) {
    authParameters.SECRET_HASH = hash;
  }

  let response;
  try {
    const sender: PasswordCheckClient = client ?? getClient(config);
    response = await sender.send(
      new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: config.clientId,
        AuthParameters: authParameters,
      }),
    );
  } catch (error) {
    const name = errorName(error);
    switch (name) {
      case "NotAuthorizedException":
      case "UserNotFoundException":
      case "InvalidPasswordException":
      case "UserNotConfirmedException":
      case "PasswordResetRequiredException":
        // All of these are a verdict on the credentials (the last two mean the
        // account cannot sign in at all, which is not something a re-check can
        // resolve). One answer for the lot; the log keeps the name only.
        console.warn(`[auth] password re-check refused: ${name}`);
        return { ok: false, failure: "incorrect" };
      default:
        console.error("[auth] password re-check could not be completed:", error);
        return { ok: false, failure: "unavailable" };
    }
  }

  if (response.ChallengeName) {
    if (PASSWORD_PROVEN_CHALLENGES.has(response.ChallengeName)) {
      // A second factor. Cognito only got this far because the password was
      // right, which is the whole question this function answers, so the
      // challenge is proof and is deliberately left unanswered — no `Session`
      // is kept and nothing is replayed.
      console.info(
        `[auth] password re-check accepted; Cognito went on to the ${response.ChallengeName} challenge, which is not answered here.`,
      );
      return { ok: true, proof: "challenge", challengeName: response.ChallengeName };
    }
    // `NEW_PASSWORD_REQUIRED` (a temporary password, which must not authorise
    // anything) and anything unrecognised.
    console.error(
      `[auth] password re-check hit the ${response.ChallengeName} challenge, which is not proof of the password; refusing the action.`,
    );
    return { ok: false, failure: "challenge" };
  }

  const result = response.AuthenticationResult;
  if (!result?.IdToken || !result.AccessToken) {
    console.error("[auth] password re-check returned no authentication result.");
    return { ok: false, failure: "unavailable" };
  }

  return {
    ok: true,
    proof: "tokens",
    tokens: {
      idToken: result.IdToken,
      accessToken: result.AccessToken,
      refreshToken: result.RefreshToken,
      expiresIn: result.ExpiresIn ?? 3600,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Answering a sign-in challenge (invitation, authenticator app)             */
/* -------------------------------------------------------------------------- */

/** Cognito namespaces the names it reports in `requiredAttributes`. */
const USER_ATTRIBUTES_PREFIX = "userAttributes.";

/**
 * The attributes Cognito insists on receiving with the new password.
 *
 * `ChallengeParameters.requiredAttributes` is a JSON-encoded array of
 * `userAttributes.<name>` strings; the prefix is stripped here so the rest of
 * the app only ever deals in plain Cognito attribute names. Duplicates and
 * `email` are dropped (the address is already set on the account, and asking
 * for it again could only contradict the one just typed), and the list is
 * capped so a strange response cannot turn into a wall of inputs.
 *
 * Anything unparseable but non-empty is returned as-is: it will not survive the
 * allowlist, so the caller refuses the challenge, which is the safe direction
 * for a value we cannot read.
 */
function requiredAttributesFrom(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "" || raw.trim() === "[]") {
    return [];
  }

  let entries: string[];
  try {
    const parsed: unknown = JSON.parse(raw);
    entries = Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [raw];
  } catch {
    // An unreadable value still means Cognito wants something.
    entries = [raw];
  }

  const names: string[] = [];
  for (const entry of entries) {
    const name = entry.startsWith(USER_ATTRIBUTES_PREFIX)
      ? entry.slice(USER_ATTRIBUTES_PREFIX.length)
      : entry;
    if (
      name === "" ||
      names.includes(name) ||
      NEVER_REQUESTED_ATTRIBUTES.has(name)
    ) {
      continue;
    }
    names.push(name);
    if (names.length >= MAX_REQUIRED_ATTRIBUTES) {
      break;
    }
  }
  return names;
}

/** Shown when the challenge itself fails for a reason the user cannot fix. */
const GENERIC_NEW_PASSWORD_ERROR =
  "Something went wrong while saving your password. Please try again.";

/** The challenge session is gone; only a fresh sign-in can start a new one. */
const CHALLENGE_SESSION_EXPIRED = "Your sign-in session expired. Start again.";

/**
 * Attribute names too generic to spot in prose: "Invalid attribute name" is
 * about the concept, not about `name`.
 */
const GENERIC_ATTRIBUTE_WORDS = new Set(["name"]);

/**
 * Which of the attributes we just sent an error message is about, if it can be
 * told at all.
 *
 * Cognito words these three ways: `userAttributes.birthdate` in a validation
 * report, the bare name in quotes, or plain prose ("Invalid phone number
 * format"). The prose pass only accepts names long enough to be unambiguous,
 * so a message that merely uses the *word* "name" is left where it is — above
 * the form, which is the harmless place to be wrong.
 */
function attributeMentionedIn(
  message: string,
  names: readonly string[],
): string | undefined {
  if (names.length === 0 || message === "") {
    return undefined;
  }
  const haystack = message.toLowerCase();

  for (const name of names) {
    const lower = name.toLowerCase();
    if (
      haystack.includes(`${USER_ATTRIBUTES_PREFIX.toLowerCase()}${lower}`) ||
      haystack.includes(`'${lower}'`) ||
      haystack.includes(`"${lower}"`)
    ) {
      return name;
    }
  }

  for (const name of names) {
    if (GENERIC_ATTRIBUTE_WORDS.has(name)) {
      continue;
    }
    const spaced = name.replace(/^custom:/, "").replace(/_/g, " ").toLowerCase();
    if (spaced.length >= 6 && haystack.includes(spaced)) {
      return name;
    }
  }
  return undefined;
}

/**
 * What to put on an attribute input Cognito rejected. AWS's own text is a
 * validation report, not a sentence for a person, so the label plus the format
 * rule says more with less.
 */
function describeAttributeRejection(name: string): string {
  const spec = attributeSpec(name);
  const label = (spec?.label ?? "detail").toLowerCase();
  switch (spec?.kind) {
    case "phone":
      return `That ${label} wasn't accepted. Use the international format, like +15551234567.`;
    case "date":
      return `That ${label} wasn't accepted. Use the format YYYY-MM-DD.`;
    default:
      return `That ${label} wasn't accepted. Check it and try again.`;
  }
}

/** AWS boilerplate that adds nothing once the message is shown in context. */
const ATTRIBUTE_PROBLEM_PREFIXES = [
  /^\d+ validation errors? detected:\s*/i,
  /^invalid attributes given,\s*/i,
  /^attributes did not conform with schema:\s*/i,
];

/**
 * A form-level message for an attribute complaint that names no attribute.
 * Cognito's text here is about the values that were typed, so showing a
 * trimmed version tells the user far more than a generic apology.
 */
function summariseAttributeProblem(message: string): string {
  let detail = message.trim().replace(/\s+/g, " ");
  for (const prefix of ATTRIBUTE_PROBLEM_PREFIXES) {
    detail = detail.replace(prefix, "");
  }
  if (detail === "") {
    return GENERIC_NEW_PASSWORD_ERROR;
  }
  if (detail.length > 160) {
    detail = `${detail.slice(0, 159).trimEnd()}…`;
  }
  const punctuated = /[.!?…]$/.test(detail) ? detail : `${detail}.`;
  return `Some of those details weren't accepted. ${punctuated}`;
}

/**
 * Answers the NEW_PASSWORD_REQUIRED challenge: the invited operator replaces
 * the temporary password from `AdminCreateUser` with one of their own.
 *
 * `username` and `session` must be the pair {@link signInWithPassword} handed
 * back — the session is single-use and expires in about three minutes, and the
 * SECRET_HASH is computed over `username` (the pool username Cognito reported
 * as `USER_ID_FOR_SRP`), not over the address that was typed.
 *
 * `attributes` are the profile values the pool asked for, keyed by plain
 * Cognito attribute name (`{ given_name: "Ada" }`); each is sent as
 * `ChallengeResponses["userAttributes.<name>"]`. The caller collects exactly
 * the names {@link signInWithPassword} reported, and anything outside the
 * form's allowlist is dropped here as well, so a name Cognito never asked for
 * cannot be smuggled into the profile.
 *
 * On success Cognito returns a normal `AuthenticationResult`, so the caller can
 * hand it straight to `createSession()` exactly like a plain sign-in.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function completeNewPassword(
  username: string,
  newPassword: string,
  session: string,
  attributes: Record<string, string> = {},
): Promise<CompleteNewPasswordResult> {
  // Thrown deliberately: the caller turns this into a "not configured" message.
  const config = getCognitoConfig();

  const challengeResponses: Record<string, string> = {
    USERNAME: username,
    NEW_PASSWORD: newPassword,
  };
  const sentAttributes: string[] = [];
  for (const [name, value] of Object.entries(attributes)) {
    // Second gate, after the action's own: this is the last place before the
    // values leave for AWS.
    if (!isRenderableAttribute(name)) {
      console.error(
        `[auth] Refusing to send an unexpected user attribute: ${name}`,
      );
      continue;
    }
    challengeResponses[`${USER_ATTRIBUTES_PREFIX}${name}`] = value;
    sentAttributes.push(name);
  }
  const hash = secretHashFor(config, username);
  if (hash) {
    challengeResponses.SECRET_HASH = hash;
  }

  let response;
  try {
    response = await getClient(config).send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ClientId: config.clientId,
        Session: session,
        ChallengeResponses: challengeResponses,
      }),
    );
  } catch (error) {
    switch (errorName(error)) {
      case "InvalidPasswordException":
        return {
          ok: false,
          error: describePasswordPolicy(error),
          field: "password",
        };
      case "NotAuthorizedException":
        // An expired or already-used session, or a SECRET_HASH computed over
        // the wrong username. Logged because the last one is a configuration
        // bug that would otherwise look like a slow user.
        console.error(
          config.clientSecret
            ? "[auth] Cognito refused the new-password challenge (with a client secret configured, a SECRET_HASH computed over the wrong username is a likely cause; it must be the USER_ID_FOR_SRP the challenge reported):"
            : "[auth] Cognito refused the new-password challenge:",
          errorMessage(error),
        );
        return { ok: false, error: CHALLENGE_SESSION_EXPIRED, restart: true };
      case "ResourceNotFoundException":
      case "UserNotFoundException":
        console.error(
          "[auth] Cognito could not resolve the new-password challenge:",
          errorMessage(error),
        );
        return { ok: false, error: CHALLENGE_SESSION_EXPIRED, restart: true };
      case "TooManyRequestsException":
      case "LimitExceededException":
        return { ok: false, error: TOO_MANY_ATTEMPTS };
      case "InvalidParameterException": {
        const message = errorMessage(error);
        console.error(
          "[auth] Cognito InvalidParameterException on RespondToAuthChallenge:",
          message,
        );

        // Attribute complaints name the attribute ("Invalid phone number
        // format", "1 validation error detected: Value at
        // 'userAttributes.birthdate' ..."), so the message can usually be put
        // on the input that caused it.
        const attribute = attributeMentionedIn(message, sentAttributes);
        if (attribute) {
          return {
            ok: false,
            error: describeAttributeRejection(attribute),
            field: attribute,
          };
        }

        if (/password/i.test(message)) {
          // Length constraints arrive here rather than as
          // InvalidPasswordException; the raw AWS validation text is not fit
          // to show, so summarise it.
          return {
            ok: false,
            error: "That password doesn't meet the password policy.",
            field: "password",
          };
        }

        if (sentAttributes.length > 0) {
          // Cognito rejected something about the details but did not say
          // which. Its text is written about attribute values, not about the
          // account, so a trimmed version is safe to show and far more useful
          // than "something went wrong".
          return { ok: false, error: summariseAttributeProblem(message) };
        }
        return { ok: false, error: GENERIC_NEW_PASSWORD_ERROR };
      }
      default:
        console.error("[auth] Unexpected Cognito challenge error:", error);
        return { ok: false, error: GENERIC_NEW_PASSWORD_ERROR };
    }
  }

  if (response.ChallengeName) {
    // The password was accepted but the pool wants something else as well
    // (MFA_SETUP, for instance, on a pool whose MfaConfiguration is ON rather
    // than OPTIONAL). Nothing here can answer it.
    console.error(
      `[auth] Unsupported Cognito challenge after the new password: ${response.ChallengeName}`,
    );
    return {
      ok: false,
      error: `Your password was saved, but this account requires an extra step (${describeChallenge(
        response.ChallengeName,
      )}) that isn't supported yet. Sign in again with your new password.`,
      restart: true,
    };
  }

  const result = response.AuthenticationResult;
  if (!result?.IdToken || !result.AccessToken) {
    console.error(
      "[auth] Cognito returned no authentication result for the challenge.",
    );
    return { ok: false, error: GENERIC_NEW_PASSWORD_ERROR };
  }

  return {
    ok: true,
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn ?? 3600,
  };
}

/** Shown for a six-digit code Cognito did not accept. */
const BAD_MFA_CODE = "That code isn't right. Check your authenticator app.";

/**
 * Answers the SOFTWARE_TOKEN_MFA challenge with the six-digit code from the
 * operator's authenticator app.
 *
 * `username` and `session` are the pair {@link signInWithPassword} returned on
 * the `mfa` branch. A wrong code is reported against the input and the same
 * session is worth one more try; once Cognito retires the session (too many
 * tries, or three minutes) it answers `NotAuthorizedException` and the caller
 * is told to sign in again.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function respondToSoftwareTokenMfa(
  username: string,
  code: string,
  session: string,
): Promise<SoftwareTokenMfaResult> {
  // Thrown deliberately: the caller turns this into a "not configured" message.
  const config = getCognitoConfig();

  const challengeResponses: Record<string, string> = {
    USERNAME: username,
    SOFTWARE_TOKEN_MFA_CODE: code,
  };
  const hash = secretHashFor(config, username);
  if (hash) {
    challengeResponses.SECRET_HASH = hash;
  }

  let response;
  try {
    response = await getClient(config).send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "SOFTWARE_TOKEN_MFA",
        ClientId: config.clientId,
        Session: session,
        ChallengeResponses: challengeResponses,
      }),
    );
  } catch (error) {
    switch (errorName(error)) {
      case "CodeMismatchException":
        // The session usually survives one more attempt; when it does not,
        // the retry comes back as NotAuthorizedException below.
        return { ok: false, error: BAD_MFA_CODE, field: "code" };
      case "ExpiredCodeException":
        return {
          ok: false,
          error: "That code has expired. Sign in again and use a fresh one.",
          restart: true,
        };
      case "NotAuthorizedException":
      case "ResourceNotFoundException":
      case "UserNotFoundException":
        console.error(
          "[auth] Cognito refused the MFA challenge:",
          errorMessage(error),
        );
        return { ok: false, error: CHALLENGE_SESSION_EXPIRED, restart: true };
      case "TooManyRequestsException":
      case "LimitExceededException":
        return { ok: false, error: TOO_MANY_ATTEMPTS };
      default:
        console.error("[auth] Unexpected Cognito MFA challenge error:", error);
        return {
          ok: false,
          error:
            "Something went wrong while checking that code. Please try again.",
        };
    }
  }

  if (response.ChallengeName) {
    console.error(
      `[auth] Unsupported Cognito challenge after MFA: ${response.ChallengeName}`,
    );
    return {
      ok: false,
      error: `This account requires an extra step (${describeChallenge(
        response.ChallengeName,
      )}) that isn't supported yet.`,
      restart: true,
    };
  }

  const result = response.AuthenticationResult;
  if (!result?.IdToken || !result.AccessToken) {
    console.error("[auth] Cognito returned no authentication result after MFA.");
    return {
      ok: false,
      error: "Something went wrong while signing in. Please try again.",
      restart: true,
    };
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
/*  Signing in with a passkey (USER_AUTH -> WEB_AUTHN)                        */
/* -------------------------------------------------------------------------- */

/**
 * The passkey challenge: everything the browser needs to run
 * `navigator.credentials.get()`, plus what has to come back with the assertion.
 *
 * `session` is Cognito's opaque continuation token, exactly as in the other two
 * challenges — short-lived, single-use, no claims. `username` is the pool
 * username Cognito wants echoed in `ChallengeResponses.USERNAME`, and the value
 * the SECRET_HASH is computed over.
 */
export interface WebAuthnChallenge {
  name: "WEB_AUTHN";
  session: string;
  username: string;
  /**
   * Cognito's `CREDENTIAL_REQUEST_OPTIONS`, parsed from the JSON string it
   * sends. Forwarded to the browser as-is: this app is not the relying party
   * and has no business reading the challenge inside.
   */
  options: Record<string, unknown>;
}

/** What {@link startWebAuthnSignIn} came to. */
export type WebAuthnSignInStart =
  | { ok: true; challenge: WebAuthnChallenge }
  | { ok: false; message: string };

/** What {@link respondToWebAuthnChallenge} came to. */
export type WebAuthnSignInResult =
  | ({ ok: true } & SignInTokens)
  | {
      ok: false;
      error: string;
      /** The challenge is dead: start the ceremony again from the button. */
      restart?: boolean;
    };

/**
 * One message for "there is no passkey to sign in with here", whatever the
 * reason: no such account, an account with no passkey registered, or a pool
 * that offered some other first factor.
 *
 * Deliberately one message. Telling "no such user" apart from "that user has no
 * passkey" would turn the button into an account-existence oracle for anyone
 * who can type an address, and unlike the password path there is no secret in
 * the request to make guessing expensive. It names the password as the way
 * forward because that is the only thing the person can act on.
 */
const NO_PASSKEY_MESSAGE =
  "We couldn't start a passkey sign-in for that email address. Sign in with your password instead.";

/** Every Cognito refusal that means "this pool cannot do passkeys". */
const PASSKEYS_UNCONFIGURED = new Set([
  "WebAuthnConfigurationMissingException",
  "WebAuthnNotEnabledException",
  "FeatureUnavailableInTierException",
]);

const PASSKEYS_UNAVAILABLE =
  "Passkey sign-in is not enabled for this console yet.";

/** The `USER_AUTH` flow is not on the app client, or not on the pool's tier. */
const PASSKEY_FLOW_UNAVAILABLE =
  "Passkey sign-in is not configured for this client.";

/**
 * Reads the `WEB_AUTHN` challenge out of an InitiateAuth or
 * RespondToAuthChallenge response.
 *
 * `CREDENTIAL_REQUEST_OPTIONS` arrives as a JSON *string* inside
 * `ChallengeParameters` (which the SDK types as `Record<string, string>`), so
 * it is parsed here and handed on as an object — the browser wants an object,
 * and a string that is not JSON is a bug worth catching on this side.
 */
function webAuthnChallengeFrom(
  parameters: Record<string, string> | undefined,
  session: string | undefined,
  fallbackUsername: string,
): WebAuthnChallenge | null {
  const raw = parameters?.CREDENTIAL_REQUEST_OPTIONS;
  if (!session || typeof raw !== "string" || raw === "") {
    console.error(
      "[auth] Cognito returned a WEB_AUTHN challenge without options or a session.",
    );
    return null;
  }

  let options: unknown;
  try {
    options = JSON.parse(raw);
  } catch (error) {
    console.error(
      "[auth] Cognito's CREDENTIAL_REQUEST_OPTIONS is not JSON:",
      error,
    );
    return null;
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    console.error("[auth] Cognito's CREDENTIAL_REQUEST_OPTIONS is not an object.");
    return null;
  }

  return {
    name: "WEB_AUTHN",
    session,
    // Same reasoning as the other two challenges: Cognito checks the SECRET_HASH
    // against the pool username it hands back, not against the typed address.
    username:
      parameters?.USER_ID_FOR_SRP || parameters?.USERNAME || fallbackUsername,
    // The three checks above have established it is a plain object; TypeScript
    // narrows `JSON.parse`'s `any` to `object`, which has no index signature.
    options: options as Record<string, unknown>,
  };
}

/** Maps a failure of either passkey call onto a message the person can act on. */
function mapPasskeyError(error: unknown, stage: string): string {
  const name = errorName(error);

  if (PASSKEYS_UNCONFIGURED.has(name)) {
    console.error(`[auth] Passkey ${stage} refused by the pool:`, errorMessage(error));
    return PASSKEYS_UNAVAILABLE;
  }

  switch (name) {
    case "NotAuthorizedException":
    case "UserNotFoundException":
    case "UserNotConfirmedException":
    case "PasswordResetRequiredException":
      // All four become one message on purpose; the log keeps the distinction.
      console.error(
        `[auth] Cognito refused the passkey ${stage}: ${name}: ${errorMessage(error)}`,
      );
      return NO_PASSKEY_MESSAGE;
    case "TooManyRequestsException":
    case "LimitExceededException":
      return TOO_MANY_ATTEMPTS;
    case "InvalidParameterException":
    case "UnsupportedOperationException":
    case "InvalidUserPoolConfigurationException": {
      const message = errorMessage(error);
      if (/auth flow/i.test(message) || /USER_AUTH/i.test(message)) {
        console.error(`[auth] Cognito refused the USER_AUTH flow: ${message}`);
        return PASSKEY_FLOW_UNAVAILABLE;
      }
      console.error(`[auth] Cognito rejected the passkey ${stage}: ${message}`);
      return GENERIC_ERROR;
    }
    default:
      console.error(`[auth] Unexpected Cognito passkey ${stage} error:`, error);
      return GENERIC_ERROR;
  }
}

/**
 * Step one of a passkey sign-in: asks Cognito for a WebAuthn challenge.
 *
 * `InitiateAuth` with `AuthFlow: "USER_AUTH"` and
 * `PREFERRED_CHALLENGE: "WEB_AUTHN"` — the choice-based flow. Cognito answers
 * one of three ways:
 *
 * - `WEB_AUTHN` straight away, which is the normal case;
 * - `SELECT_CHALLENGE`, when it wants the choice made explicitly. The answer is
 *   a `RespondToAuthChallenge` with `ANSWER: "WEB_AUTHN"`, which returns the
 *   `WEB_AUTHN` challenge and a fresh session;
 * - some other challenge (`PASSWORD`, `PASSWORD_SRP`, an OTP), which means this
 *   account has no passkey to offer. That is {@link NO_PASSKEY_MESSAGE}, the
 *   same message an unknown address gets.
 *
 * Nothing about the account is revealed either way, and no session is created:
 * only {@link respondToWebAuthnChallenge} can finish the sign-in.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function startWebAuthnSignIn(
  email: string,
): Promise<WebAuthnSignInStart> {
  // Thrown deliberately: the caller turns this into a "not configured" message.
  const config = getCognitoConfig();

  const authParameters: Record<string, string> = {
    USERNAME: email,
    PREFERRED_CHALLENGE: "WEB_AUTHN",
  };
  const startHash = secretHashFor(config, email);
  if (startHash) {
    authParameters.SECRET_HASH = startHash;
  }

  let response;
  try {
    response = await getClient(config).send(
      new InitiateAuthCommand({
        AuthFlow: "USER_AUTH",
        ClientId: config.clientId,
        AuthParameters: authParameters,
      }),
    );
  } catch (error) {
    return { ok: false, message: mapPasskeyError(error, "sign-in") };
  }

  // Cognito wants the choice spelled out. Answering it is one more round trip
  // and lands on the WEB_AUTHN challenge below.
  if (response.ChallengeName === "SELECT_CHALLENGE") {
    const available = response.AvailableChallenges ?? [];
    if (available.length > 0 && !available.includes("WEB_AUTHN")) {
      // The pool listed what this account can use and a passkey is not on it.
      console.info(
        `[auth] Passkey sign-in unavailable; Cognito offered: ${available.join(", ")}`,
      );
      return { ok: false, message: NO_PASSKEY_MESSAGE };
    }

    const username =
      response.ChallengeParameters?.USER_ID_FOR_SRP ||
      response.ChallengeParameters?.USERNAME ||
      email;
    const challengeResponses: Record<string, string> = {
      USERNAME: username,
      ANSWER: "WEB_AUTHN",
    };
    // The hash goes over the username actually being sent, which after a
    // SELECT_CHALLENGE may be the pool username rather than the address.
    const selectHash = secretHashFor(config, username);
    if (selectHash) {
      challengeResponses.SECRET_HASH = selectHash;
    }

    try {
      response = await getClient(config).send(
        new RespondToAuthChallengeCommand({
          ChallengeName: "SELECT_CHALLENGE",
          ClientId: config.clientId,
          Session: response.Session,
          ChallengeResponses: challengeResponses,
        }),
      );
    } catch (error) {
      return { ok: false, message: mapPasskeyError(error, "challenge choice") };
    }
  }

  if (response.ChallengeName !== "WEB_AUTHN") {
    if (response.ChallengeName) {
      // A first factor other than a passkey: the account exists but has none,
      // or the pool prefers something else. One message, no detail.
      console.info(
        `[auth] Passkey sign-in unavailable; Cognito asked for ${response.ChallengeName}.`,
      );
    } else {
      // Tokens without a WebAuthn ceremony would mean the pool authenticated
      // somebody on the strength of an email address alone. Refuse them.
      console.error(
        "[auth] USER_AUTH returned no WEB_AUTHN challenge; refusing the result.",
      );
    }
    return { ok: false, message: NO_PASSKEY_MESSAGE };
  }

  const challenge = webAuthnChallengeFrom(
    response.ChallengeParameters,
    response.Session,
    email,
  );
  if (!challenge) {
    return { ok: false, message: GENERIC_ERROR };
  }
  return { ok: true, challenge };
}

/**
 * Step two of a passkey sign-in: answers the `WEB_AUTHN` challenge with the
 * assertion the authenticator produced.
 *
 * `credential` is the browser's `AuthenticationResponseJSON`, forwarded
 * untouched — Cognito is the relying party and verifies the signature, the
 * challenge, the origin and the relying party id. This app only re-encodes it
 * (`src/lib/account/webauthn.ts`) and checks that it is JSON of a sane size
 * (the Server Action).
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function respondToWebAuthnChallenge(
  username: string,
  credential: string,
  session: string,
): Promise<WebAuthnSignInResult> {
  // Thrown deliberately: the caller turns this into a "not configured" message.
  const config = getCognitoConfig();

  const challengeResponses: Record<string, string> = {
    USERNAME: username,
    CREDENTIAL: credential,
  };
  const hash = secretHashFor(config, username);
  if (hash) {
    challengeResponses.SECRET_HASH = hash;
  }

  let response;
  try {
    response = await getClient(config).send(
      new RespondToAuthChallengeCommand({
        ChallengeName: "WEB_AUTHN",
        ClientId: config.clientId,
        Session: session,
        ChallengeResponses: challengeResponses,
      }),
    );
  } catch (error) {
    const name = errorName(error);

    if (PASSKEYS_UNCONFIGURED.has(name)) {
      console.error("[auth] Passkey assertion refused by the pool:", errorMessage(error));
      return { ok: false, error: PASSKEYS_UNAVAILABLE };
    }

    switch (name) {
      case "WebAuthnChallengeNotFoundException":
      case "NotAuthorizedException":
      case "ResourceNotFoundException":
      case "UserNotFoundException":
        console.error(
          "[auth] Cognito refused the passkey challenge:",
          errorMessage(error),
        );
        return { ok: false, error: CHALLENGE_SESSION_EXPIRED, restart: true };
      case "WebAuthnClientMismatchException":
      case "WebAuthnOriginNotAllowedException":
      case "WebAuthnRelyingPartyMismatchException":
        console.error(
          "[auth] Passkey origin/relying party mismatch:",
          errorMessage(error),
        );
        return {
          ok: false,
          error:
            "This site is not an allowed origin for the pool's passkey settings.",
        };
      case "WebAuthnCredentialNotSupportedException":
        return {
          ok: false,
          error: "That authenticator is not supported by this user pool.",
        };
      case "TooManyRequestsException":
      case "LimitExceededException":
        return { ok: false, error: TOO_MANY_ATTEMPTS };
      case "InvalidParameterException":
        console.error(
          "[auth] Cognito could not read the passkey assertion:",
          errorMessage(error),
        );
        return {
          ok: false,
          error: "Cognito could not read that passkey. Try again.",
          restart: true,
        };
      default:
        console.error("[auth] Unexpected Cognito passkey challenge error:", error);
        return {
          ok: false,
          error:
            "Something went wrong while checking that passkey. Please try again.",
          restart: true,
        };
    }
  }

  if (response.ChallengeName) {
    // A passkey is a first factor; with the pool's
    // MULTI_FACTOR_WITH_USER_VERIFICATION and the per-user flag
    // (`src/lib/account/passkey-mfa.ts`) one with user verification counts as
    // both, so no second challenge is expected. Without the flag an operator
    // with TOTP on is refused outright (an error above), not challenged. If a
    // challenge ever does come, say so rather than fail silently.
    console.error(
      `[auth] Unsupported Cognito challenge after WEB_AUTHN: ${response.ChallengeName}`,
    );
    return {
      ok: false,
      error: `This account requires an extra step (${describeChallenge(
        response.ChallengeName,
      )}) that isn't supported yet.`,
      restart: true,
    };
  }

  const result = response.AuthenticationResult;
  if (!result?.IdToken || !result.AccessToken) {
    console.error(
      "[auth] Cognito returned no authentication result after WEB_AUTHN.",
    );
    return {
      ok: false,
      error: "Something went wrong while signing in. Please try again.",
      restart: true,
    };
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
/*  Token refresh (GetTokensFromRefreshToken) and revocation                  */
/* -------------------------------------------------------------------------- */

export type RefreshResult =
  | ({ ok: true } & SignInTokens)
  /**
   * `invalid` — the refresh token will never work again (revoked, expired,
   * rotated out, issued to another client, user gone). The session must be
   * cleared. `unavailable` — Cognito could not answer. The session must be
   * left alone.
   */
  | { ok: false; reason: "invalid" | "unavailable" };

/**
 * Exchanges a refresh token for a fresh id and access token.
 *
 * Uses `GetTokensFromRefreshToken`, which takes the refresh token, the client
 * id and — when the app client has one — the client secret, and nothing else:
 * no username, no SECRET_HASH. That is the whole reason this call needs no
 * companion cookie, and why the old `psa_refresh_user` is no longer written.
 *
 * It is the API to use whether or not refresh-token rotation is enabled, which
 * matters because the pool is moving to rotation: rotation *disables* the
 * `REFRESH_TOKEN_AUTH` InitiateAuth flow this used to call. With rotation off
 * the response carries no `RefreshToken` and the caller keeps the one it holds;
 * with rotation on it carries a new one that replaces it, and presenting a
 * rotated-out token afterwards fails with `RefreshTokenReuseException`.
 *
 * @throws {import("./config").CognitoConfigError} when the environment is not configured.
 */
export async function refreshTokens(
  refreshToken: string,
): Promise<RefreshResult> {
  // Thrown deliberately: the caller turns this into a 503, not a sign-out.
  const config = getCognitoConfig();

  let response;
  try {
    response = await getClient(config).send(
      new GetTokensFromRefreshTokenCommand({
        RefreshToken: refreshToken,
        ClientId: config.clientId,
        // Undefined when the app client has no secret, which the SDK omits.
        ClientSecret: config.clientSecret,
      }),
    );
  } catch (error) {
    switch (errorName(error)) {
      case "RefreshTokenReuseException":
        // Rotation is on and this token was already spent. Either two tabs
        // raced past the retry grace period, or a stolen copy is being
        // replayed. Either way the session is over and Cognito has already
        // invalidated the whole chain.
        console.error(
          "[auth] A rotated-out refresh token was presented — possible theft or a lost race:",
          errorMessage(error),
        );
        return { ok: false, reason: "invalid" };
      case "NotAuthorizedException":
        // Revoked, expired, wrong client, or the wrong client secret. Logged
        // because the last is a configuration bug that would otherwise look
        // like a normal timeout.
        console.error(
          config.clientSecret
            ? "[auth] Cognito refused a refresh token (a wrong ADMIN_COGNITO_CLIENT_SECRET is a likely cause when this is not simply an expired token):"
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
      case "OperationNotEnabledException":
        // A pool configuration problem, not a dead token: reported as
        // "unavailable" so nobody's session is destroyed while it is fixed.
        console.error(
          "[auth] The user pool refused GetTokensFromRefreshToken; check the app client's token settings:",
          errorMessage(error),
        );
        return { ok: false, reason: "unavailable" };
      default:
        console.error("[auth] Unexpected Cognito refresh error:", error);
        return { ok: false, reason: "unavailable" };
    }
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
    // The ACCESS token's lifetime, and only a fallback: each cookie is dated
    // from its own token's `exp` (see `createSession`), because the pool gives
    // the id and access tokens different validities.
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
