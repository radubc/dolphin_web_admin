"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isTooManyRequestsError } from "@/lib/api/errors";
import {
  completeNewPassword,
  respondToSoftwareTokenMfa,
  respondToWebAuthnChallenge,
  signInWithPassword,
  startWebAuthnSignIn,
} from "@/lib/auth/cognito";
import { CognitoConfigError } from "@/lib/auth/config";
import { createSession } from "@/lib/auth/session";
import {
  attributeSpec,
  parseAttributeNames,
  validateAttributeValue,
} from "@/lib/auth/required-attributes";
import {
  asString,
  EMAIL_PATTERN,
  MAX_EMAIL_LENGTH,
  MAX_PASSKEY_CREDENTIAL_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  TOTP_CODE_PATTERN,
} from "@/lib/auth/validation";
import { clientIpFrom, ipRateLimitKey } from "@/lib/security/client-ip";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/security/rate-limit";

/**
 * Shown when either sign-in limit is hit. Says nothing about which limit, how
 * long the window is, or whether the address exists. Not exported: a
 * "use server" module may only export async functions (and types).
 */
const TOO_MANY_ATTEMPTS_MESSAGE =
  "Too many attempts. Please wait and try again.";

/**
 * Shown when a second step arrives without a usable challenge — a reloaded
 * tab, a tampered payload, or a session Cognito has already retired.
 */
const LOST_CHALLENGE_MESSAGE = "Your sign-in session expired. Start again.";

/**
 * Shown when the passkey payload is not something a browser could have
 * produced: empty, oversized, or not a JSON object. A person cannot cause this
 * by clicking, so it says what to do rather than what went wrong.
 */
const PASSKEY_UNREADABLE_MESSAGE =
  "That passkey response could not be read. Try again.";

export interface LoginState {
  /** Non-field error, rendered as an alert above the form. */
  error?: string;
  fieldErrors?: {
    email?: string;
    password?: string;
  };
  /**
   * Set when the credentials were right but the account still carries the
   * temporary password `AdminCreateUser` issued: no session is created, and
   * the form moves to the set-password step, which posts these values back to
   * {@link completeInvitation}.
   *
   * `session` is Cognito's opaque continuation token — no claims, single use,
   * about three minutes of life. It round-trips through a hidden form field
   * rather than the URL, so it stays out of history, logs and referrers.
   */
  challenge?: {
    session: string;
    /** Pool username Cognito expects back; not necessarily the address. */
    username: string;
    /** The address that was typed, shown read-only on the second step. */
    email: string;
    /**
     * Profile attributes the pool requires with the new password, as plain
     * Cognito names (`["given_name", "family_name"]`). The step renders one
     * input per entry; usually empty, in which case it is passwords only.
     */
    requiredAttributes: string[];
  };
  /**
   * Set when the password was right and the operator has an authenticator app
   * registered. Same kind of continuation token as `challenge`, answered by
   * {@link verifyMfaCode}.
   */
  mfa?: {
    session: string;
    username: string;
    email: string;
  };
}

/** Shaped for `useActionState` on the set-password step. */
export interface CompleteInvitationState {
  /** Non-field error, rendered as an alert above the form. */
  error?: string;
  fieldErrors?: {
    password?: string;
    confirm?: string;
    /**
     * Messages for the required-attribute inputs, keyed by Cognito attribute
     * name (`phone_number`), not by form field name.
     */
    attributes?: Record<string, string>;
  };
  /** The challenge is dead: the form must go back to email and password. */
  restart?: boolean;
}

/** Shaped for `useActionState` on the six-digit code step. */
export interface MfaState {
  /** Non-field error, rendered as an alert above the form. */
  error?: string;
  fieldErrors?: {
    code?: string;
  };
  /** The challenge is dead: the form must go back to email and password. */
  restart?: boolean;
}

/**
 * What {@link startPasskeySignIn} hands the browser.
 *
 * On success it is everything `navigator.credentials.get()` needs plus the two
 * values that have to come back with the assertion. The continuation token is
 * held in the page's memory for the few seconds the authenticator takes and is
 * posted back in the action's payload — never in the URL, exactly like the
 * invitation and MFA steps' hidden fields.
 */
export type PasskeyStartState =
  | {
      ok: true;
      /** Cognito's opaque `Session`: single-use, short-lived, no claims. */
      session: string;
      /** Pool username Cognito expects echoed back with the assertion. */
      username: string;
      /**
       * Cognito's `CREDENTIAL_REQUEST_OPTIONS`, already parsed. Opaque to this
       * app: it is forwarded to the browser and never inspected.
       */
      options: Record<string, unknown>;
    }
  | { ok: false; error: string };

/** Shaped for `useActionState` on the passkey assertion. */
export interface PasskeyState {
  /** Non-field error, rendered as the sign-in form's alert. */
  error?: string;
}

/**
 * Message for an error that escaped the Cognito helpers — in practice a
 * missing environment variable.
 */
function describeUnconfigured(error: unknown): string {
  console.error("[auth] Sign-in is not configured:", error);
  if (
    process.env.NODE_ENV !== "production" &&
    error instanceof CognitoConfigError
  ) {
    // Outside production, name the missing variable: it is a developer
    // setup problem, not something a user can act on. The message only ever
    // contains variable names, never their values.
    return `Sign-in is not configured: ${error.message}`;
  }
  return "Sign-in is not configured. Please contact support.";
}

/**
 * Consumes the sign-in budget for this caller and for `email`.
 *
 * Called before Cognito, never after: the point is to not spend a call (or an
 * account lockout) on an attempt we already know we will not honour. The
 * per-address limit is what actually stops credential stuffing, since a
 * botnet defeats the per-IP one — which is also why the per-IP limit is
 * simply skipped when no client address can be trusted, rather than counting
 * every visitor into one bucket that the first ten attempts would exhaust.
 *
 * @returns the neutral refusal message when the caller is limited, otherwise
 * `undefined`.
 */
async function checkPasskeyRateLimit(email: string): Promise<string | undefined> {
  try {
    const ipKey = ipRateLimitKey("login:ip:", clientIpFrom(await headers()));
    if (ipKey) {
      await enforceRateLimit(ipKey, RATE_LIMITS.authLogin);
    }
    await enforceRateLimit(`passkey:email:${email.toLowerCase()}`, RATE_LIMITS.authPasskey);
    return undefined;
  } catch (error) {
    if (isTooManyRequestsError(error)) {
      return TOO_MANY_ATTEMPTS_MESSAGE;
    }
    throw error;
  }
}

async function checkLoginRateLimit(email: string): Promise<string | undefined> {
  try {
    const ipKey = ipRateLimitKey("login:ip:", clientIpFrom(await headers()));
    if (ipKey) {
      await enforceRateLimit(ipKey, RATE_LIMITS.authLogin);
    }
    await enforceRateLimit(
      `login:email:${email.toLowerCase()}`,
      RATE_LIMITS.authLoginAccount,
    );
    return undefined;
  } catch (error) {
    if (isTooManyRequestsError(error)) {
      return TOO_MANY_ATTEMPTS_MESSAGE;
    }
    throw error;
  }
}

/**
 * Signs the operator in against Cognito and starts a session.
 * Shaped for `useActionState`.
 *
 * Three outcomes beyond a plain failure: a session (the usual one), the
 * invitation challenge (`challenge`), and the authenticator-app challenge
 * (`mfa`). The last two create no session — the form shows a second step and
 * posts back to {@link completeInvitation} or {@link verifyMfaCode}.
 */
export async function login(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = asString(formData.get("email")).trim();
  const password = asString(formData.get("password"));

  const fieldErrors: NonNullable<LoginState["fieldErrors"]> = {};

  if (email === "") {
    fieldErrors.email = "Enter your email address.";
  } else if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    fieldErrors.email = "Enter a valid email address.";
  }

  if (password === "") {
    fieldErrors.password = "Enter your password.";
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    fieldErrors.password = "That password is too long.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  const limited = await checkLoginRateLimit(email);
  if (limited) {
    return { error: limited };
  }

  let result;
  try {
    result = await signInWithPassword(email, password);
  } catch (error) {
    // Missing/invalid Cognito environment configuration.
    return { error: describeUnconfigured(error) };
  }

  if (!result.ok) {
    if (result.challenge) {
      // Right credentials, temporary password. No session yet: the account
      // only becomes usable once the operator picks their own password.
      return {
        challenge: {
          session: result.challenge.session,
          username: result.challenge.username,
          email,
          requiredAttributes: result.challenge.requiredAttributes,
        },
      };
    }
    if (result.mfa) {
      // Password accepted, second factor outstanding. Still no session.
      return {
        mfa: {
          session: result.mfa.session,
          username: result.mfa.username,
          email,
        },
      };
    }
    return { error: result.message };
  }

  await createSession(result);

  // Throws; must stay outside the try/catch above. The authenticated layout
  // sends an operator with no allowlist row on to /no-access.
  redirect("/");
}

/**
 * Second step for an invited operator: replaces the temporary password with
 * their own and starts the session the first step deliberately did not.
 * Shaped for `useActionState`. Redirects to `/` on success.
 *
 * Everything it receives is a hidden field the browser sent back, so nothing is
 * trusted: the address is re-validated, the attribute names go through the
 * allowlist again (so nothing Cognito did not ask for can be written to the
 * profile), and the challenge session is Cognito's to accept or reject — a
 * stale one comes back as `restart`.
 */
export async function completeInvitation(
  _prevState: CompleteInvitationState,
  formData: FormData,
): Promise<CompleteInvitationState> {
  const email = asString(formData.get("email")).trim();
  const username = asString(formData.get("username")).trim();
  const challengeSession = asString(formData.get("challengeSession"));
  const password = asString(formData.get("password"));
  const confirm = asString(formData.get("confirm"));

  if (
    email === "" ||
    email.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(email) ||
    challengeSession === ""
  ) {
    return { error: LOST_CHALLENGE_MESSAGE, restart: true };
  }

  const fieldErrors: NonNullable<CompleteInvitationState["fieldErrors"]> = {};

  // Length only. Cognito owns the pool's complexity policy and its message is
  // what the user is shown, so restating the rules here would only risk
  // contradicting them.
  if (password === "") {
    fieldErrors.password = "New password is required";
  } else if (password.length < MIN_PASSWORD_LENGTH) {
    fieldErrors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    fieldErrors.password = "That password is too long.";
  }

  if (confirm === "") {
    fieldErrors.confirm = "Confirm password is required";
  } else if (password !== "" && confirm !== password) {
    fieldErrors.confirm = "Both passwords must match.";
  }

  // The names Cognito asked for, round-tripped through a hidden field. They
  // are filtered against the same allowlist the form renders from, so a
  // tampered post can only name attributes the step could have shown anyway —
  // and each value is normalised and checked here, not trusted as typed.
  const attributes: Record<string, string> = {};
  const attributeErrors: Record<string, string> = {};
  for (const name of parseAttributeNames(
    asString(formData.get("attribute_names")),
  )) {
    const spec = attributeSpec(name);
    if (!spec) {
      continue;
    }
    const { value, error } = validateAttributeValue(
      spec,
      asString(formData.get(spec.field)),
    );
    if (error) {
      attributeErrors[name] = error;
    } else {
      attributes[name] = value;
    }
  }

  if (Object.keys(attributeErrors).length > 0) {
    fieldErrors.attributes = attributeErrors;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  // Same budget as a sign-in, and for the same reason: this call finishes an
  // authentication, so it must not be a way around the login limits.
  const limited = await checkLoginRateLimit(email);
  if (limited) {
    return { error: limited };
  }

  let result;
  try {
    result = await completeNewPassword(
      // The pool username Cognito asked for; the address is only a fallback
      // for a challenge that somehow arrived without one.
      username === "" ? email : username,
      password,
      challengeSession,
      attributes,
    );
  } catch (error) {
    // Missing/invalid Cognito environment configuration.
    return { error: describeUnconfigured(error) };
  }

  if (!result.ok) {
    if (result.field === "password") {
      return { fieldErrors: { password: result.error } };
    }
    // Anything else Cognito pinned to a field is an attribute name.
    if (result.field !== undefined && Object.hasOwn(attributes, result.field)) {
      return {
        fieldErrors: { attributes: { [result.field]: result.error } },
      };
    }
    return { error: result.error, restart: result.restart };
  }

  await createSession(result);

  // Throws; must stay outside the try/catch above.
  redirect("/");
}

/**
 * Second step for an operator with an authenticator app: answers the
 * SOFTWARE_TOKEN_MFA challenge with the six-digit code and starts the session.
 * Shaped for `useActionState`.
 *
 * As with the invitation step, every value arrives from a hidden field and is
 * re-validated; Cognito is the authority on both the code and the session. A
 * wrong code lands on the input and the same session is worth another try; a
 * dead session comes back as `restart` and the form returns to step one.
 */
export async function verifyMfaCode(
  _prevState: MfaState,
  formData: FormData,
): Promise<MfaState> {
  const email = asString(formData.get("email")).trim();
  const username = asString(formData.get("username")).trim();
  const challengeSession = asString(formData.get("challengeSession"));
  // Authenticator apps and password managers happily hand over "123 456".
  const code = asString(formData.get("code")).replace(/[\s-]/g, "");

  if (
    email === "" ||
    email.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(email) ||
    challengeSession === ""
  ) {
    return { error: LOST_CHALLENGE_MESSAGE, restart: true };
  }

  if (code === "") {
    return { fieldErrors: { code: "Verification code is required" } };
  }
  if (!TOTP_CODE_PATTERN.test(code)) {
    return { fieldErrors: { code: "Enter the six digits from your app." } };
  }

  // A code guess finishes an authentication, so it spends the same budget as
  // a password attempt rather than being a way around it.
  const limited = await checkLoginRateLimit(email);
  if (limited) {
    return { error: limited };
  }

  let result;
  try {
    result = await respondToSoftwareTokenMfa(
      username === "" ? email : username,
      code,
      challengeSession,
    );
  } catch (error) {
    // Missing/invalid Cognito environment configuration.
    return { error: describeUnconfigured(error) };
  }

  if (!result.ok) {
    if (result.field === "code" && !result.restart) {
      return { fieldErrors: { code: result.error } };
    }
    return { error: result.error, restart: result.restart };
  }

  await createSession(result);

  // Throws; must stay outside the try/catch above.
  redirect("/");
}

/* -------------------------------------------------------------------------- */
/*  Signing in with a passkey                                                 */
/* -------------------------------------------------------------------------- */

/** Rejects an address that is obviously not one before Cognito is asked. */
function invalidEmail(email: string): boolean {
  return (
    email === "" ||
    email.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(email)
  );
}

/**
 * Step one of a passkey sign-in: turns the typed address into a WebAuthn
 * challenge from Cognito.
 *
 * Called directly from the button's click handler rather than through
 * `useActionState`, because the browser has to run the authenticator ceremony
 * between this call and {@link completePasskeySignIn} — there is no form
 * submission to hang it off, and nothing here redirects.
 *
 * No session is created and nothing is written: the challenge is only useful to
 * whoever holds the matching private key. An unknown address and an account
 * with no passkey come back as the *same* message, so the button cannot be used
 * to find out who has an account here.
 */
export async function startPasskeySignIn(
  email: unknown,
): Promise<PasskeyStartState> {
  // The argument crosses the network as JSON, so it is `unknown` until checked.
  const address = typeof email === "string" ? email.trim() : "";
  if (invalidEmail(address)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  // Before Cognito, and on the same budget as a password attempt: this call
  // starts an authentication, so it must not be a way around the login limits.
  const limited = await checkLoginRateLimit(address);
  if (limited) {
    return { ok: false, error: limited };
  }

  let result;
  try {
    result = await startWebAuthnSignIn(address);
  } catch (error) {
    // Missing/invalid Cognito environment configuration.
    return { ok: false, error: describeUnconfigured(error) };
  }

  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  return {
    ok: true,
    session: result.challenge.session,
    username: result.challenge.username,
    options: result.challenge.options,
  };
}

/**
 * Step two of a passkey sign-in: sends the assertion to Cognito and, if it
 * verifies, starts the session — the same five cookies and the same redirect as
 * the password path, because from here on the two are the same sign-in.
 * Shaped for `useActionState`.
 *
 * Everything it receives came back from the browser, so nothing is trusted: the
 * address and the payload size are re-checked, the credential must at least
 * parse as a JSON object, and the challenge session is Cognito's to accept or
 * reject. The credential itself is forwarded untouched — Cognito is the relying
 * party and the only thing that can tell a real assertion from a fabricated one.
 */
export async function completePasskeySignIn(
  _prevState: PasskeyState,
  formData: FormData,
): Promise<PasskeyState> {
  const email = asString(formData.get("email")).trim();
  const username = asString(formData.get("username")).trim();
  const challengeSession = asString(formData.get("challengeSession"));
  const credential = asString(formData.get("credential"));

  if (invalidEmail(email) || challengeSession === "") {
    return { error: LOST_CHALLENGE_MESSAGE };
  }

  if (credential === "" || credential.length > MAX_PASSKEY_CREDENTIAL_LENGTH) {
    return { error: PASSKEY_UNREADABLE_MESSAGE };
  }
  try {
    const parsed: unknown = JSON.parse(credential);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: PASSKEY_UNREADABLE_MESSAGE };
    }
  } catch {
    // Not JSON at all: a tampered payload, never something a browser produced.
    return { error: PASSKEY_UNREADABLE_MESSAGE };
  }

  // The IP budget again, plus the passkey leg's own per-account budget: this
  // call finishes an authentication, but an honest sign-in is two calls and
  // must not spend two of the five password attempts.
  const limited = await checkPasskeyRateLimit(email);
  if (limited) {
    return { error: limited };
  }

  let result;
  try {
    result = await respondToWebAuthnChallenge(
      // The pool username Cognito asked for; the address is only a fallback for
      // a challenge that somehow arrived without one.
      username === "" ? email : username,
      credential,
      challengeSession,
    );
  } catch (error) {
    // Missing/invalid Cognito environment configuration.
    return { error: describeUnconfigured(error) };
  }

  if (!result.ok) {
    // There is no second step on screen to fall back from: the passkey flow
    // begins and ends on the sign-in form, so `restart` needs no handling
    // beyond showing the reason there.
    return { error: result.error };
  }

  await createSession(result);

  // Throws; must stay outside the try/catch above. The authenticated layout
  // sends an operator with no allowlist row on to /no-access.
  redirect("/");
}
